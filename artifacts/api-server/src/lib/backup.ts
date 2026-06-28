import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, lt, and, inArray } from "drizzle-orm";
import pg from "pg";
import {
  db,
  backupLogTable,
  backupSettingsTable,
  usersTable,
  type BackupLog,
  type BackupSettings,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { resolveEmailConfig } from "./email";
import nodemailer from "nodemailer";

const objectStorage = new ObjectStorageService();

// pg_dump binary; override with PG_DUMP_PATH if it lives elsewhere.
const PG_DUMP = process.env.PG_DUMP_PATH || "pg_dump";

// How many successful backups to keep in object storage; older ones are pruned.
function retentionCount(): number {
  const n = Number(process.env.BACKUP_RETENTION);
  return Number.isInteger(n) && n > 0 ? n : 14;
}

/** Whether scheduled automatic backups should run (storage must be available). */
export function backupsEnabled(): boolean {
  if (process.env.BACKUP_ENABLED === "false") return false;
  const hasS3 = Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
  const hasReplit = Boolean(process.env.PRIVATE_OBJECT_DIR);
  return hasS3 || hasReplit;
}

function timestampName(): string {
  // 2026-05-31T00-53-34 → filesystem/URL friendly.
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/** Run pg_dump (custom format) into a temp file and return its bytes. */
async function runPgDump(databaseUrl: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "stavba-backup-"));
  const filePath = join(dir, "dump.pgcustom");
  try {
    await new Promise<void>((resolve, reject) => {
      // -Fc = custom format (compressed, restorable with pg_restore).
      const child = spawn(
        PG_DUMP,
        ["--no-owner", "--no-acl", "-Fc", "-f", filePath, databaseUrl],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
      });
    });
    return await readFile(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pruneOldBackups(): Promise<void> {
  const keep = retentionCount();
  const successes = await db
    .select()
    .from(backupLogTable)
    .where(eq(backupLogTable.status, "success"))
    .orderBy(desc(backupLogTable.createdAt));

  const stale = successes.slice(keep);
  for (const row of stale) {
    try {
      if (row.objectPath) {
        await objectStorage.deletePrivateObject(row.objectPath);
      }
      await db.delete(backupLogTable).where(eq(backupLogTable.id, row.id));
    } catch (err) {
      logger.warn({ err, backupId: row.id }, "Failed to prune old backup");
    }
  }

  // Also drop very old failed/running rows so the log doesn't grow unbounded.
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  await db
    .delete(backupLogTable)
    .where(lt(backupLogTable.createdAt, cutoff));
}

/**
 * Create a database backup: dump → object storage → recorded in backup_log.
 * A "running" row is inserted first so a crash mid-dump is still visible.
 */
export async function createBackup(opts: {
  trigger: "manual" | "auto";
  actor?: string | null;
}): Promise<BackupLog> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (!backupsEnabled()) {
    throw new Error(
      "Object storage is not configured; cannot store backups. Configure the S3_* variables.",
    );
  }

  const filename = `stavba-${timestampName()}.pgcustom`;
  const objectPath = `/objects/backups/${filename}`;

  const [row] = await db
    .insert(backupLogTable)
    .values({
      filename,
      status: "running",
      trigger: opts.trigger,
      createdBy: opts.actor ?? null,
    })
    .returning();

  try {
    const buffer = await runPgDump(databaseUrl);
    await objectStorage.putPrivateObject(objectPath, buffer, "application/octet-stream");

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const [updated] = await db
      .update(backupLogTable)
      .set({
        status: "success",
        objectPath,
        sizeBytes: buffer.length,
        sha256,
      })
      .where(eq(backupLogTable.id, row.id))
      .returning();

    logger.info(
      { backupId: row.id, sizeBytes: buffer.length, sha256, trigger: opts.trigger },
      "Database backup completed",
    );

    pruneOldBackups().catch((err) =>
      logger.warn({ err }, "Backup pruning failed"),
    );

    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(backupLogTable)
      .set({ status: "failed", error: message })
      .where(eq(backupLogTable.id, row.id));
    logger.error({ err, backupId: row.id }, "Database backup failed");
    throw err;
  }
}

/** pg_restore binary; override with PG_RESTORE_PATH if it lives elsewhere. */
const PG_RESTORE = process.env.PG_RESTORE_PATH || "pg_restore";

/**
 * Restore the database from a previously created backup.
 *
 * The dump bytes are streamed from object storage to a temp file, then applied
 * with `pg_restore --clean --if-exists --single-transaction`. `--single-transaction`
 * makes the whole restore atomic: if anything fails the database is rolled back
 * to its previous state, so a failed restore never leaves a half-restored DB.
 *
 * This is destructive: it drops and recreates every object captured in the dump,
 * overwriting all current data (including the session table — the user is logged
 * out afterwards).
 */
let restoreInProgress = false;

export async function restoreBackup(id: number): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  // A restore overwrites the whole database; never let two run concurrently
  // (e.g. two admins, or a double-click that slips past the UI guard).
  if (restoreInProgress) {
    throw new Error("Obnovení už právě probíhá. Počkejte na jeho dokončení.");
  }

  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    throw new Error("Záloha nenalezena nebo není dokončená.");
  }

  restoreInProgress = true;
  const dir = await mkdtemp(join(tmpdir(), "stavba-restore-"));
  const filePath = join(dir, "dump.pgcustom");
  try {
    const buffer = await objectStorage.getPrivateObjectBuffer(row.objectPath);
    await writeFile(filePath, buffer);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        PG_RESTORE,
        [
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-acl",
          "--single-transaction",
          "-d",
          databaseUrl,
          filePath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_restore exited with code ${code}: ${stderr.trim()}`));
      });
    });

    // Record when this backup was last successfully restored so the health page
    // can display the last restore-test timestamp.
    await db
      .update(backupLogTable)
      .set({ restoredAt: new Date() })
      .where(eq(backupLogTable.id, id));

    logger.warn({ backupId: id }, "Database restored from backup");
  } finally {
    restoreInProgress = false;
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── Restore-test (non-destructive) ──────────────────────────────────────────

/** Tables we verify row counts for during a restore test. */
const VERIFY_TABLES = [
  "jobs",
  "customers",
  "users",
  "people",
  "materials",
  "activities",
] as const;

/** In-process guard: only one restore-test at a time. */
let restoreTestInProgress = false;

/**
 * Parse a Postgres connection URL and return a URL pointing to the "postgres"
 * maintenance database on the same server (used for CREATE/DROP DATABASE).
 */
function postgresAdminUrl(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    u.pathname = "/postgres";
    return u.toString();
  } catch {
    // Fallback: strip the path and append /postgres.
    return databaseUrl.replace(/\/[^/?#]*(\?|#|$)/, "/postgres$1");
  }
}

/**
 * Derive a DB URL for connecting to a named temp database on the same server.
 */
function tempDbUrl(databaseUrl: string, dbName: string): string {
  try {
    const u = new URL(databaseUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  } catch {
    return databaseUrl.replace(/\/[^/?#]*(\?|#|$)/, `/${dbName}$1`);
  }
}

/**
 * Run a non-destructive restore test for a given backup into a temporary
 * isolated PostgreSQL database, verify key table row counts, then clean up.
 *
 * Updates the backup_log row with the test result (restoreStatus, restoreDurationMs,
 * restoreVerifiedTables, restoreTestedAt, restoreError) and returns the updated row.
 */
export async function testBackupRestore(id: number): Promise<BackupLog> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  if (restoreTestInProgress) {
    throw new Error("Restore test již probíhá. Počkejte na jeho dokončení.");
  }

  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    throw new Error("Záloha nenalezena nebo není dokončená.");
  }

  // Mark as pending so the UI can show a spinner immediately.
  const [pending] = await db
    .update(backupLogTable)
    .set({ restoreStatus: "pending", restoreTestedAt: null, restoreError: null })
    .where(eq(backupLogTable.id, id))
    .returning();

  restoreTestInProgress = true;
  const startedAt = Date.now();
  const tempDbName = `stavba_restore_test_${Date.now()}`;
  const adminUrl = postgresAdminUrl(databaseUrl);
  const tmpDir = await mkdtemp(join(tmpdir(), "stavba-restoretest-"));
  const filePath = join(tmpDir, "dump.pgcustom");

  let tempDbCreated = false;

  try {
    // 1. Download the dump from object storage.
    const buffer = await objectStorage.getPrivateObjectBuffer(row.objectPath);
    await writeFile(filePath, buffer);

    // 2. Create the ephemeral database.
    const adminPool = new pg.Pool({ connectionString: adminUrl, max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${tempDbName}"`);
      tempDbCreated = true;
    } finally {
      await adminPool.end();
    }

    // 3. Restore into the temp database.
    const targetUrl = tempDbUrl(databaseUrl, tempDbName);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        PG_RESTORE,
        [
          "--no-owner",
          "--no-acl",
          "--no-privileges",
          "-d",
          targetUrl,
          filePath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // pg_restore exits 1 for warnings (e.g. role does not exist); 0 = clean.
        // We treat exit code 1 as OK if stderr only contains harmless warnings.
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`pg_restore exited with code ${code}: ${stderr.trim()}`));
      });
    });

    // 4. Verify key tables have rows.
    const testPool = new pg.Pool({ connectionString: targetUrl, max: 1 });
    const verifiedTables: Record<string, number> = {};
    try {
      for (const table of VERIFY_TABLES) {
        try {
          const result = await testPool.query(`SELECT COUNT(*)::integer AS c FROM "${table}"`);
          verifiedTables[table] = result.rows[0]?.c ?? 0;
        } catch {
          // Table might not exist in an empty/partial dump — treat as 0.
          verifiedTables[table] = 0;
        }
      }
    } finally {
      await testPool.end();
    }

    const durationMs = Date.now() - startedAt;

    const [updated] = await db
      .update(backupLogTable)
      .set({
        restoreStatus: "ok",
        restoreTestedAt: new Date(),
        restoreDurationMs: durationMs,
        restoreVerifiedTables: verifiedTables,
        restoreError: null,
      })
      .where(eq(backupLogTable.id, id))
      .returning();

    logger.info(
      { backupId: id, durationMs, verifiedTables },
      "Backup restore test passed",
    );

    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;

    const [updated] = await db
      .update(backupLogTable)
      .set({
        restoreStatus: "failed",
        restoreTestedAt: new Date(),
        restoreDurationMs: durationMs,
        restoreError: message,
        restoreVerifiedTables: null,
      })
      .where(eq(backupLogTable.id, id))
      .returning();

    logger.error({ err, backupId: id, durationMs }, "Backup restore test failed");

    return updated ?? pending;
  } finally {
    restoreTestInProgress = false;
    await rm(tmpDir, { recursive: true, force: true });

    // Always drop the temp database (in the finally block so it runs even on error).
    if (tempDbCreated) {
      const adminPool = new pg.Pool({ connectionString: adminUrl, max: 1 });
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
      } catch (dropErr) {
        logger.warn({ dropErr, tempDbName }, "Failed to drop temp restore-test database");
      } finally {
        await adminPool.end();
      }
    }
  }
}

// ─── Backup settings (singleton) ─────────────────────────────────────────────

const SETTINGS_ID = 1;

export async function getBackupSettings(): Promise<BackupSettings | null> {
  const [row] = await db
    .select()
    .from(backupSettingsTable)
    .where(eq(backupSettingsTable.id, SETTINGS_ID));
  return row ?? null;
}

export async function upsertBackupSettings(data: {
  restoreTestDayOfWeek: number | null;
  restoreNotifyEmail: string | null;
}): Promise<BackupSettings> {
  const [row] = await db
    .insert(backupSettingsTable)
    .values({ id: SETTINGS_ID, ...data })
    .onConflictDoUpdate({
      target: backupSettingsTable.id,
      set: {
        restoreTestDayOfWeek: data.restoreTestDayOfWeek,
        restoreNotifyEmail: data.restoreNotifyEmail,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// ─── Schedulers ──────────────────────────────────────────────────────────────

export async function listBackups(limit = 50): Promise<Array<BackupLog>> {
  return db
    .select()
    .from(backupLogTable)
    .orderBy(desc(backupLogTable.createdAt))
    .limit(limit);
}

export async function getBackup(id: number): Promise<BackupLog | undefined> {
  const [row] = await db.select().from(backupLogTable).where(eq(backupLogTable.id, id));
  return row;
}

let schedulerStarted = false;

/**
 * Start the periodic automatic backup. Idempotent. Interval is
 * BACKUP_INTERVAL_HOURS (default 24h). Does nothing when backups are disabled
 * or storage is not configured.
 */
export function startBackupScheduler(): void {
  if (schedulerStarted) return;
  if (!backupsEnabled()) {
    logger.info("Automatic backups disabled (no object storage configured)");
    return;
  }
  schedulerStarted = true;

  const hours = Number(process.env.BACKUP_INTERVAL_HOURS);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;

  const timer = setInterval(() => {
    createBackup({ trigger: "auto" }).catch((err) =>
      logger.error({ err }, "Scheduled backup failed"),
    );
  }, intervalMs);
  // Don't keep the process alive solely for the backup timer.
  timer.unref();

  logger.info({ intervalHours: intervalMs / (60 * 60 * 1000) }, "Backup scheduler started");
}

/** Collect admin/master e-mail addresses for failure notifications. */
async function collectAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["admin", "master"]),
      ),
    );
  return rows
    .map((r) => (r.email ?? "").trim())
    .filter((e) => e.length > 0 && e.includes("@"));
}

/** Send a failure e-mail to the configured recipient(s). */
async function sendRestoreTestFailureEmail(opts: {
  backupId: number;
  backupCreatedAt: Date;
  errorMessage: string;
  notifyEmail: string | null;
}): Promise<void> {
  let cfg;
  try {
    cfg = await resolveEmailConfig();
  } catch (err) {
    logger.warn({ err }, "Restore-test failure email skipped — email not configured");
    return;
  }

  const recipients = opts.notifyEmail
    ? [opts.notifyEmail]
    : await collectAdminEmails();

  if (recipients.length === 0) {
    logger.warn({ backupId: opts.backupId }, "Restore-test failure: no recipient configured");
    return;
  }

  const dateStr = opts.backupCreatedAt.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });

  const subject = `[Stavba] Restore test zálohy selhal – záloha ze ${dateStr}`;
  const text = [
    `Dobrý den,`,
    ``,
    `automatický restore test zálohy databáze selhal.`,
    ``,
    `Záloha:  #${opts.backupId}, vytvořena ${dateStr}`,
    `Chyba:   ${opts.errorMessage}`,
    ``,
    `Prosíme o manuální kontrolu zálohy v administraci aplikace Stavba (Nastavení → Zálohy).`,
    ``,
    `Tato zpráva byla vygenerována automaticky.`,
  ].join("\n");

  try {
    await transporter.sendMail({ from: cfg.from, to: recipients, subject, text });
    logger.info({ backupId: opts.backupId, recipients: recipients.length }, "Restore-test failure email sent");
  } catch (err) {
    logger.error({ err, backupId: opts.backupId }, "Failed to send restore-test failure email");
  }
}

let restoreTestSchedulerStarted = false;

/**
 * Start the weekly restore-test scheduler. Idempotent. Checks once per hour
 * whether the configured day of the week has arrived and the latest successful
 * backup hasn't been tested yet (or was last tested >6 days ago). Does nothing
 * when backups are disabled or no backup has been created.
 */
export function startRestoreTestScheduler(): void {
  if (restoreTestSchedulerStarted) return;
  if (!backupsEnabled()) return;
  restoreTestSchedulerStarted = true;

  // Check every hour whether it's time to run the weekly restore test.
  const CHECK_INTERVAL_MS = 60 * 60 * 1000;

  const tick = async () => {
    try {
      const settings = await getBackupSettings();

      // Which day of the week to run the test?
      // DB setting → env var → default Sunday (0).
      let targetDay: number | null = settings?.restoreTestDayOfWeek ?? null;
      if (targetDay === null) {
        const envDay = Number(process.env.BACKUP_RESTORE_TEST_DAY_OF_WEEK);
        targetDay = Number.isInteger(envDay) && envDay >= 0 && envDay <= 6 ? envDay : null;
      }

      // null means the scheduled test is disabled.
      if (targetDay === null) return;

      const now = new Date();
      if (now.getDay() !== targetDay) return;

      // Find the latest successful backup.
      const [latest] = await db
        .select()
        .from(backupLogTable)
        .where(eq(backupLogTable.status, "success"))
        .orderBy(desc(backupLogTable.createdAt))
        .limit(1);

      if (!latest) return;

      // Skip if already tested within the last 6 days (prevents double-runs on
      // the same day if the process restarts multiple times).
      if (latest.restoreTestedAt) {
        const msSinceLast = now.getTime() - latest.restoreTestedAt.getTime();
        if (msSinceLast < 6 * 24 * 60 * 60 * 1000) return;
      }

      logger.info({ backupId: latest.id }, "Weekly restore test starting");
      const result = await testBackupRestore(latest.id);

      if (result.restoreStatus === "failed") {
        const notifyEmail = settings?.restoreNotifyEmail ?? process.env.BACKUP_RESTORE_NOTIFY_EMAIL ?? null;
        await sendRestoreTestFailureEmail({
          backupId: latest.id,
          backupCreatedAt: latest.createdAt,
          errorMessage: result.restoreError ?? "Neznámá chyba",
          notifyEmail,
        });
      }
    } catch (err) {
      logger.error({ err }, "Restore-test scheduler tick failed");
    }
  };

  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref();

  logger.info("Restore-test scheduler started (checks hourly)");
}
