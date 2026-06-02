import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, lt } from "drizzle-orm";
import { db, backupLogTable, type BackupLog } from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

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

    const [updated] = await db
      .update(backupLogTable)
      .set({
        status: "success",
        objectPath,
        sizeBytes: buffer.length,
      })
      .where(eq(backupLogTable.id, row.id))
      .returning();

    logger.info(
      { backupId: row.id, sizeBytes: buffer.length, trigger: opts.trigger },
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

    logger.warn({ backupId: id }, "Database restored from backup");
  } finally {
    restoreInProgress = false;
    await rm(dir, { recursive: true, force: true });
  }
}

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
