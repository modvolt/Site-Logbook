import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, lt, and, inArray, isNotNull } from "drizzle-orm";
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
import { withSchedulerLock, SCHEDULER_LOCK_KEYS } from "./scheduler-lock";

const objectStorage = new ObjectStorageService();

// pg_dump / pg_restore binaries; override with PG_DUMP_PATH / PG_RESTORE_PATH.
const PG_DUMP = process.env.PG_DUMP_PATH || "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE_PATH || "pg_restore";

// ─── pg_dump availability check ──────────────────────────────────────────────

let pgDumpAvailable = false;
let pgDumpVersion: string | null = null;

/**
 * Run `pg_dump --version` at startup to verify the binary exists and is
 * PostgreSQL 16-compatible. Sets module-level flags used by getBackupStatus().
 * Logs a warning (never throws) so startup is never blocked by a missing binary.
 */
export async function checkPgDumpAvailability(): Promise<void> {
  try {
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(PG_DUMP, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`pg_dump --version exited with code ${code}`));
      });
    });

    pgDumpVersion = version;

    // Output: "pg_dump (PostgreSQL) 16.10" — major version is the first number AFTER "PostgreSQL"
    // The closing paren comes right after "PostgreSQL" so we match \)\s+(\d+) as well.
    const match = version.match(/PostgreSQL[^0-9]*(\d+)/i);
    const major = match ? Number(match[1]) : 0;
    if (major < 16) {
      logger.warn(
        { version, major },
        `pg_dump version ${major} detected — PostgreSQL 16+ required for full compatibility`,
      );
      pgDumpAvailable = false;
    } else {
      pgDumpAvailable = true;
      logger.info({ version }, "pg_dump availability check passed");
    }
  } catch (err) {
    pgDumpAvailable = false;
    pgDumpVersion = null;
    logger.warn(
      { err, pgDumpPath: PG_DUMP },
      "pg_dump binary not found or failed — automatic backups will not run",
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function backupIntervalHours(): number {
  const h = Number(process.env.BACKUP_INTERVAL_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 24;
}

// How many successful backups to keep in object storage; older ones are pruned.
function retentionCount(): number {
  const n = Number(process.env.BACKUP_RETENTION);
  return Number.isInteger(n) && n > 0 ? n : 14;
}

function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/** Run pg_dump (custom format) into a temp file and return its bytes. */
async function runPgDump(databaseUrl: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "stavba-backup-"));
  const filePath = join(dir, "dump.pgcustom");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        PG_DUMP,
        ["--no-owner", "--no-acl", "-Fc", "-f", filePath, databaseUrl],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
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

// ─── Failure notification hysteresis ─────────────────────────────────────────

/**
 * We track the last time we sent a "backup failed" notification so we don't
 * spam admins if the scheduled backup fails on every run. We only re-notify
 * once per 24 hours regardless of how many consecutive failures there are.
 */
let lastBackupFailNotifiedAt: Date | null = null;

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

async function sendFailureEmail(opts: {
  subject: string;
  body: string;
  notifyEmail: string | null;
  backupId?: number;
}): Promise<void> {
  let cfg;
  try {
    cfg = await resolveEmailConfig();
  } catch (err) {
    logger.warn({ err }, "Failure notification email skipped — email not configured");
    return;
  }

  const recipients = opts.notifyEmail
    ? [opts.notifyEmail]
    : await collectAdminEmails();

  if (recipients.length === 0) {
    logger.warn({ backupId: opts.backupId }, "Failure notification: no recipient configured");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });

  try {
    await transporter.sendMail({
      from: cfg.from,
      to: recipients,
      subject: opts.subject,
      text: opts.body,
    });
    logger.info(
      { backupId: opts.backupId, recipients: recipients.length },
      "Backup failure notification email sent",
    );
  } catch (err) {
    logger.error({ err, backupId: opts.backupId }, "Failed to send backup failure email");
  }
}

/**
 * Send a notification about a failed automatic backup (with hysteresis).
 * Skips if a notification was already sent within the last 24 hours.
 */
async function notifyAutoBackupFailed(opts: {
  errorMessage: string;
  notifyEmail: string | null;
}): Promise<void> {
  const now = new Date();
  const hysteresisMs = 24 * 60 * 60 * 1000;
  if (
    lastBackupFailNotifiedAt &&
    now.getTime() - lastBackupFailNotifiedAt.getTime() < hysteresisMs
  ) {
    logger.info("Auto-backup failure notification suppressed by hysteresis");
    return;
  }

  const dateStr = now.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const subject = `[Stavba] Automatická záloha databáze selhala – ${dateStr}`;
  const body = [
    "Dobrý den,",
    "",
    "automatická záloha databáze Stavba selhala.",
    "",
    `Čas pokusu: ${dateStr}`,
    `Chyba:      ${opts.errorMessage}`,
    "",
    "Prosíme o kontrolu nastavení v administraci aplikace Stavba (Nastavení → Zálohy).",
    "Zvažte ruční zálohu, dokud nebude problém vyřešen.",
    "",
    "Tato zpráva byla vygenerována automaticky.",
  ].join("\n");

  await sendFailureEmail({ subject, body, notifyEmail: opts.notifyEmail });
  lastBackupFailNotifiedAt = now;
}

// ─── Create backup ────────────────────────────────────────────────────────────

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

// ─── Restore (destructive) ────────────────────────────────────────────────────

/**
 * Restore the database from a previously created backup.
 *
 * Destructive: drops and recreates every object captured in the dump,
 * overwriting all current data (including the session table — users are
 * logged out afterwards). Uses --single-transaction for atomicity.
 */
let restoreInProgress = false;

export async function restoreBackup(id: number): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

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
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_restore exited with code ${code}: ${stderr.trim()}`));
      });
    });

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

/** Default timeout for the whole restore-test operation (10 minutes). */
const RESTORE_TEST_TIMEOUT_MS = Number(process.env.BACKUP_RESTORE_TEST_TIMEOUT_MS) || 10 * 60 * 1000;

/** In-process guard: only one restore-test at a time. */
let restoreTestInProgress = false;

function postgresAdminUrl(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    u.pathname = "/postgres";
    return u.toString();
  } catch {
    return databaseUrl.replace(/\/[^/?#]*(\?|#|$)/, "/postgres$1");
  }
}

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
 * Always drops the temp DB in a finally block (even on failure).
 * Has a configurable timeout (default 10 minutes).
 * Updates the backup_log row atomically with the test result.
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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Wrap the entire operation in a timeout.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Restore test překročil časový limit ${RESTORE_TEST_TIMEOUT_MS / 1000}s`)),
      RESTORE_TEST_TIMEOUT_MS,
    );
  });

  const doTest = async (): Promise<BackupLog> => {
    // 1. Download the dump from object storage.
    const buffer = await objectStorage.getPrivateObjectBuffer(row.objectPath!);
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
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        // pg_restore exits 1 for warnings (e.g. role does not exist); 0 = clean.
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
  };

  try {
    const result = await Promise.race([doTest(), timeoutPromise]);
    return result;
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
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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

// ─── Backup log queries ───────────────────────────────────────────────────────

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

// ─── Backup status ────────────────────────────────────────────────────────────

/** Track when the last auto backup completed (success or fail) for nextScheduledAt. */
let lastAutoBackupCompletedAt: Date | null = null;

export interface BackupStatusInfo {
  enabled: boolean;
  pgDumpAvailable: boolean;
  pgDumpVersion: string | null;
  intervalHours: number;
  lastAttemptAt: string | null;
  lastAttemptStatus: string | null;
  lastVerifiedRestoreAt: string | null;
  nextScheduledAt: string | null;
}

/**
 * Compute current backup system status from DB + in-process state.
 * Called by the /backups/status endpoint.
 */
export async function getBackupStatus(): Promise<BackupStatusInfo> {
  const intervalHours = backupIntervalHours();
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Most recent backup attempt (any status).
  const [lastAttempt] = await db
    .select()
    .from(backupLogTable)
    .orderBy(desc(backupLogTable.createdAt))
    .limit(1);

  // Most recent successful restore test.
  const [lastVerified] = await db
    .select()
    .from(backupLogTable)
    .where(and(eq(backupLogTable.restoreStatus, "ok"), isNotNull(backupLogTable.restoreTestedAt)))
    .orderBy(desc(backupLogTable.restoreTestedAt))
    .limit(1);

  // nextScheduledAt: if we know when the last auto backup completed, add the interval.
  // Otherwise fall back to lastAttempt.createdAt + interval.
  let nextScheduledAt: string | null = null;
  const baseTime = lastAutoBackupCompletedAt ?? lastAttempt?.createdAt ?? null;
  if (baseTime) {
    nextScheduledAt = new Date(baseTime.getTime() + intervalMs).toISOString();
  }

  return {
    enabled: backupsEnabled(),
    pgDumpAvailable,
    pgDumpVersion,
    intervalHours,
    lastAttemptAt: lastAttempt?.createdAt.toISOString() ?? null,
    lastAttemptStatus: lastAttempt?.status ?? null,
    lastVerifiedRestoreAt: lastVerified?.restoreTestedAt?.toISOString() ?? null,
    nextScheduledAt,
  };
}

// ─── Persistent trigger (idempotent) ─────────────────────────────────────────

/**
 * Trigger an auto backup if one has not already run within the configured
 * interval. Used by the /api/internal/backup-trigger endpoint so that an
 * external scheduler (cron, Replit Scheduled Deployment) can fire it without
 * risking duplicate backups.
 *
 * Returns { triggered: true } when a backup is started, or
 *         { triggered: false, reason } when skipped.
 */
export async function triggerAutoBackupIfDue(): Promise<{ triggered: boolean; reason: string }> {
  if (!backupsEnabled()) {
    return { triggered: false, reason: "Object storage not configured" };
  }

  const intervalHours = backupIntervalHours();
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Look at the latest backup (any trigger) to decide if we're due.
  const [lastBackup] = await db
    .select()
    .from(backupLogTable)
    .where(eq(backupLogTable.status, "success"))
    .orderBy(desc(backupLogTable.createdAt))
    .limit(1);

  if (lastBackup) {
    const msSinceLast = Date.now() - lastBackup.createdAt.getTime();
    if (msSinceLast < intervalMs) {
      const remainingMin = Math.round((intervalMs - msSinceLast) / 60_000);
      return {
        triggered: false,
        reason: `Last backup was ${Math.round(msSinceLast / 60_000)} min ago; next due in ${remainingMin} min`,
      };
    }
  }

  // Also skip if a backup is currently running (status=running and recent).
  const [running] = await db
    .select()
    .from(backupLogTable)
    .where(eq(backupLogTable.status, "running"))
    .orderBy(desc(backupLogTable.createdAt))
    .limit(1);
  if (running) {
    const ageMs = Date.now() - running.createdAt.getTime();
    if (ageMs < 30 * 60 * 1000) {
      return { triggered: false, reason: "A backup is already running" };
    }
  }

  // Fire the backup asynchronously so the HTTP response is immediate.
  const settings = await getBackupSettings();
  const notifyEmail = settings?.restoreNotifyEmail ?? process.env.BACKUP_RESTORE_NOTIFY_EMAIL ?? null;

  setImmediate(() => {
    createBackup({ trigger: "auto" })
      .then(() => {
        lastAutoBackupCompletedAt = new Date();
      })
      .catch(async (err) => {
        lastAutoBackupCompletedAt = new Date();
        logger.error({ err }, "Triggered auto-backup failed");
        const msg = err instanceof Error ? err.message : String(err);
        await notifyAutoBackupFailed({ errorMessage: msg, notifyEmail }).catch(() => {});
      });
  });

  return { triggered: true, reason: "Backup started" };
}

// ─── Restore-test failure notification ───────────────────────────────────────

/** Send a failure e-mail to the configured recipient(s) for restore-test failures. */
export async function sendRestoreTestFailureEmail(opts: {
  backupId: number;
  backupCreatedAt: Date;
  errorMessage: string;
  notifyEmail: string | null;
}): Promise<void> {
  const dateStr = opts.backupCreatedAt.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const subject = `[Stavba] Restore test zálohy selhal – záloha ze ${dateStr}`;
  const body = [
    "Dobrý den,",
    "",
    "automatický restore test zálohy databáze selhal.",
    "",
    `Záloha:  #${opts.backupId}, vytvořena ${dateStr}`,
    `Chyba:   ${opts.errorMessage}`,
    "",
    "Prosíme o manuální kontrolu zálohy v administraci aplikace Stavba (Nastavení → Zálohy).",
    "",
    "Tato zpráva byla vygenerována automaticky.",
  ].join("\n");

  await sendFailureEmail({
    subject,
    body,
    notifyEmail: opts.notifyEmail,
    backupId: opts.backupId,
  });
}

// ─── Schedulers ──────────────────────────────────────────────────────────────

let schedulerStarted = false;

/**
 * Start the periodic automatic backup. Idempotent. Interval is
 * BACKUP_INTERVAL_HOURS (default 24h). Does nothing when backups are disabled
 * or storage is not configured.
 *
 * This setInterval is kept as a fallback for environments without an external
 * cron scheduler. In production, use /api/internal/backup-trigger via a
 * Replit Scheduled Deployment or system cron (both approaches coexist safely
 * because triggerAutoBackupIfDue() is idempotent).
 */
export function startBackupScheduler(): void {
  if (schedulerStarted) return;
  if (!backupsEnabled()) {
    logger.info("Automatic backups disabled (no object storage configured)");
    return;
  }
  schedulerStarted = true;

  const intervalMs = backupIntervalHours() * 60 * 60 * 1000;

  const tick = () => {
    withSchedulerLock(SCHEDULER_LOCK_KEYS.backupAuto, async () => {
      await triggerAutoBackupIfDue();
    }).catch((err) =>
      logger.error({ err }, "Scheduled backup tick failed"),
    );
  };

  // Run once shortly after startup (staggered 5 min to let the server warm up)
  // then on the normal interval.
  const warmupDelay = 5 * 60 * 1000;
  const warmup = setTimeout(tick, warmupDelay);
  if (warmup.unref) warmup.unref();

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();

  logger.info(
    { intervalHours: intervalMs / (60 * 60 * 1000) },
    "Backup scheduler started (setInterval fallback)",
  );
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

  const CHECK_INTERVAL_MS = 60 * 60 * 1000;

  const tick = async () => {
    try {
      const settings = await getBackupSettings();

      let targetDay: number | null = settings?.restoreTestDayOfWeek ?? null;
      if (targetDay === null) {
        const envDay = Number(process.env.BACKUP_RESTORE_TEST_DAY_OF_WEEK);
        targetDay = Number.isInteger(envDay) && envDay >= 0 && envDay <= 6 ? envDay : null;
      }

      if (targetDay === null) return;

      const now = new Date();
      if (now.getDay() !== targetDay) return;

      const [latest] = await db
        .select()
        .from(backupLogTable)
        .where(eq(backupLogTable.status, "success"))
        .orderBy(desc(backupLogTable.createdAt))
        .limit(1);

      if (!latest) return;

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

  const wrappedTick = () =>
    withSchedulerLock(SCHEDULER_LOCK_KEYS.backupRestoreTest, tick).catch((err) =>
      logger.error({ err }, "Restore-test scheduler tick failed"),
    );

  const timer = setInterval(wrappedTick, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  logger.info("Restore-test scheduler started (checks hourly)");
}
