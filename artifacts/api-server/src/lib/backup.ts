import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, lt, lte, and, inArray, isNotNull } from "drizzle-orm";
import pg from "pg";
import {
  db,
  pool as applicationDatabasePool,
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
import {
  tryAcquireSchedulerLock,
  withSchedulerLock,
  SCHEDULER_LOCK_KEYS,
  type SchedulerLockLease,
} from "./scheduler-lock";
import {
  decryptBackupPayload,
  encryptBackupPayload,
  encryptionStatus,
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
} from "./secret-envelope";

const objectStorage = new ObjectStorageService();

// pg_dump / pg_restore binaries; override with PG_DUMP_PATH / PG_RESTORE_PATH.
const PG_DUMP = process.env.PG_DUMP_PATH || "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE_PATH || "pg_restore";
const PRODUCTION_PG_RESTORE = "/usr/bin/pg_restore";
const PRODUCTION_PSQL = "/usr/bin/psql";
const PRODUCTION_RESTORE_DEADLINE_MS = 15 * 60 * 1000;
const PRODUCTION_RESTORE_KILL_GRACE_MS = 5_000;
const PRODUCTION_RESTORE_MAX_SQL_BYTES = 8 * 1024 * 1024 * 1024;

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
      const child = spawn(PG_DUMP, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
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

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function backupAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Backup restore operation aborted.");
}

export async function raceBackupRestoreOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort?.();
    throw backupAbortReason(signal);
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(backupAbortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function boundedBackupCleanup<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Stream pg_dump custom bytes into a bounded buffer and kill on overflow. */
export async function runPgDump(
  databaseUrl: string,
  maxPayloadBytes?: number,
  exportedSnapshotId?: string,
  dependencies: { spawnProcess?: typeof spawn; signal?: AbortSignal } = {},
): Promise<Buffer> {
  if (
    maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1)
  ) {
    throw new Error("Database dump ceiling must be a positive safe integer.");
  }
  if (dependencies.signal?.aborted) {
    throw backupAbortReason(dependencies.signal);
  }
  const child = (dependencies.spawnProcess ?? spawn)(
    PG_DUMP,
    [
      "--no-owner",
      "--no-acl",
      ...(exportedSnapshotId ? [`--snapshot=${exportedSnapshotId}`] : []),
      "-Fc",
      databaseUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return await new Promise<Buffer>((resolve, reject) => {
    const stderrCeilingBytes = 64 * 1024;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = "";
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
    let terminationError: Error | undefined;
    const abort = () => terminate(backupAbortReason(dependencies.signal!));
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      dependencies.signal?.removeEventListener("abort", abort);
      if (forceKill) clearTimeout(forceKill);
      if (terminationDeadline) clearTimeout(terminationDeadline);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, totalBytes));
    };
    const terminate = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
      terminationDeadline = setTimeout(() => finish(terminationError), 2_000);
      terminationDeadline.unref();
    };
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (value: Buffer | Uint8Array) => {
      if (settled || terminationError) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (
        maxPayloadBytes !== undefined &&
        totalBytes + chunk.length > maxPayloadBytes
      ) {
        terminate(
          new Error(
            `Database dump exceeds the approved ${maxPayloadBytes}-byte payload ceiling.`,
          ),
        );
        return;
      }
      totalBytes += chunk.length;
      chunks.push(chunk);
    });
    child.stderr.on("data", (value: Buffer | Uint8Array) => {
      if (settled || Buffer.byteLength(stderr) >= stderrCeilingBytes) return;
      const remaining = stderrCeilingBytes - Buffer.byteLength(stderr);
      stderr += Buffer.from(value).subarray(0, remaining).toString();
    });
    child.once("error", (error) => {
      if (!terminationError) finish(error);
    });
    child.once("close", (code) => {
      if (settled) {
        if (forceKill) clearTimeout(forceKill);
        return;
      }
      if (terminationError) finish(terminationError);
      else if (code === 0) finish();
      else
        finish(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export interface BackupSourceSnapshotEvidence {
  schemaVersion: "site-logbook.backup-source-table-counts/v1";
  tableNames: readonly string[];
  tableCounts: Readonly<Record<string, number>>;
  tableCountsSha256: string;
}

type BackupSnapshotQueryable = {
  query<Row extends Record<string, unknown>>(
    text: string,
  ): Promise<{ rows: Row[] }>;
};

type BackupSnapshotClient = BackupSnapshotQueryable & {
  connect(): Promise<unknown>;
  end(): Promise<void>;
};

function canonicalTableIdentity(schema: string, table: string): string {
  if (
    !/^[a-z_][a-z0-9_$]*$/.test(schema) ||
    !/^[a-z_][a-z0-9_$]*$/.test(table)
  ) {
    throw new Error(
      "Backup snapshot verification permits only canonical lowercase table identities.",
    );
  }
  return `${schema}.${table}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function canonicalBackupSourceSnapshotEvidence(
  counts: Readonly<Record<string, number>>,
): BackupSourceSnapshotEvidence {
  const entries = Object.entries(counts).sort(([left], [right]) =>
    binaryCompare(left, right),
  );
  if (
    entries.length === 0 ||
    entries.some(
      ([name, count]) =>
        !/^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/.test(name) ||
        !Number.isSafeInteger(count) ||
        count < 0,
    )
  ) {
    throw new Error(
      "Backup source snapshot table counts must be a nonempty canonical safe-integer map.",
    );
  }
  const tableCounts = Object.freeze(Object.fromEntries(entries));
  const canonicalBytes = JSON.stringify(tableCounts);
  return Object.freeze({
    schemaVersion: "site-logbook.backup-source-table-counts/v1" as const,
    tableNames: Object.freeze(entries.map(([name]) => name)),
    tableCounts,
    tableCountsSha256: `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`,
  });
}

function validateBackupSourceSnapshotEvidence(
  evidence: BackupSourceSnapshotEvidence,
): BackupSourceSnapshotEvidence {
  const canonical = canonicalBackupSourceSnapshotEvidence(evidence.tableCounts);
  if (
    evidence.schemaVersion !== canonical.schemaVersion ||
    evidence.tableCountsSha256 !== canonical.tableCountsSha256 ||
    JSON.stringify(evidence.tableNames) !== JSON.stringify(canonical.tableNames)
  ) {
    throw new Error("Backup source snapshot evidence is not canonical.");
  }
  return canonical;
}

export async function readBackupSnapshotTableCounts(
  client: BackupSnapshotQueryable,
  options: { signal?: AbortSignal } = {},
): Promise<BackupSourceSnapshotEvidence> {
  const unsupported = await raceBackupRestoreOperation(
    client.query<{
      schema_name: string;
      relation_name: string;
      relation_kind: string;
      persistence: string;
      is_partition: boolean;
    }>(`SELECT n.nspname AS schema_name, c.relname AS relation_name,
             c.relkind::text AS relation_kind,
             c.relpersistence::text AS persistence,
             c.relispartition AS is_partition
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp%'
         AND (c.relkind IN ('p', 'm', 'f')
           OR (c.relkind = 'r'
             AND (c.relpersistence <> 'p' OR c.relispartition)))
       ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`),
    options.signal,
  );
  if (unsupported.rows.length > 0) {
    const identities = unsupported.rows.map(
      (row) =>
        `${canonicalTableIdentity(row.schema_name, row.relation_name)}:${row.relation_kind}:${row.persistence}:${row.is_partition ? "partition" : "standalone"}`,
    );
    throw new Error(
      `Exact backup snapshot verification does not support dump-backed unlogged, partitioned, materialized-view or foreign relations: ${identities.join(",")}.`,
    );
  }
  const relations = await raceBackupRestoreOperation(
    client.query<{
      schema_name: string;
      table_name: string;
    }>(`SELECT n.nspname AS schema_name, c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND c.relkind = 'r'
        AND c.relpersistence = 'p'
        AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`),
    options.signal,
  );
  const counts: Record<string, number> = {};
  for (const row of relations.rows) {
    const name = canonicalTableIdentity(row.schema_name, row.table_name);
    const result = await raceBackupRestoreOperation(
      client.query<{ count: string | number }>(
        `SELECT count(*)::bigint AS count FROM ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`,
      ),
      options.signal,
    );
    const count = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Backup snapshot count is invalid for ${name}.`);
    }
    counts[name] = count;
  }
  return canonicalBackupSourceSnapshotEvidence(counts);
}

/**
 * Holds a PostgreSQL repeatable-read transaction open while pg_dump imports
 * its exported snapshot. Counts and dump therefore observe exactly the same
 * database snapshot. Snapshot ids are ephemeral and never enter evidence.
 */
export async function withExportedBackupSnapshot<T>(
  databaseUrl: string,
  operation: (
    exportedSnapshotId: string,
    evidence: BackupSourceSnapshotEvidence,
  ) => Promise<T>,
  dependencies: {
    clientFactory?: (connectionString: string) => BackupSnapshotClient;
    signal?: AbortSignal;
    queryTimeoutMs?: number;
  } = {},
): Promise<{ value: T; evidence: BackupSourceSnapshotEvidence }> {
  const queryTimeoutMs = dependencies.queryTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1) {
    throw new Error(
      "Backup snapshot query timeout must be a positive safe integer.",
    );
  }
  if (dependencies.signal?.aborted) {
    throw backupAbortReason(dependencies.signal);
  }
  const client = (
    dependencies.clientFactory ??
    ((connectionString) =>
      new pg.Client({
        connectionString,
        connectionTimeoutMillis: queryTimeoutMs,
        query_timeout: queryTimeoutMs,
        statement_timeout: queryTimeoutMs,
      }) as unknown as BackupSnapshotClient)
  )(databaseUrl);
  let transactionOpen = false;
  let connectionUsable = true;
  const abortClient = (): void => {
    connectionUsable = false;
    void boundedBackupCleanup(client.end(), 5_000);
  };
  const bounded = <Value>(operation: Promise<Value>): Promise<Value> =>
    raceBackupRestoreOperation(operation, dependencies.signal, abortClient);
  try {
    await bounded(client.connect());
    await bounded(
      client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
    );
    transactionOpen = true;
    await bounded(
      client.query(`SET LOCAL statement_timeout = '${queryTimeoutMs}ms'`),
    );
    await bounded(
      client.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${queryTimeoutMs}ms'`,
      ),
    );
    const snapshot = await bounded(
      client.query<{ snapshot_id: string }>(
        "SELECT pg_export_snapshot() AS snapshot_id",
      ),
    );
    const exportedSnapshotId = snapshot.rows[0]?.snapshot_id;
    if (!exportedSnapshotId || !/^[0-9A-Za-z:-]+$/.test(exportedSnapshotId)) {
      throw new Error(
        "PostgreSQL did not return a valid exported snapshot id.",
      );
    }
    const evidence = await readBackupSnapshotTableCounts(client, {
      signal: dependencies.signal,
    });
    const value = await operation(exportedSnapshotId, evidence);
    await bounded(client.query("COMMIT"));
    transactionOpen = false;
    return { value, evidence };
  } catch (error) {
    if (transactionOpen && connectionUsable) {
      await boundedBackupCleanup(
        client.query("ROLLBACK").then(() => undefined),
        5_000,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await boundedBackupCleanup(client.end(), 5_000).catch(() => undefined);
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
  await db.delete(backupLogTable).where(lt(backupLogTable.createdAt, cutoff));
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
    logger.warn(
      { err },
      "Failure notification email skipped — email not configured",
    );
    return;
  }

  const recipients = opts.notifyEmail
    ? [opts.notifyEmail]
    : await collectAdminEmails();

  if (recipients.length === 0) {
    logger.warn(
      { backupId: opts.backupId },
      "Failure notification: no recipient configured",
    );
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
    logger.error(
      { err, backupId: opts.backupId },
      "Failed to send backup failure email",
    );
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
type CreateBackupOptions = {
  trigger: "manual" | "auto";
  actor?: string | null;
  /**
   * The isolated exact-0104 recovery point must never delete older evidence as
   * a side effect. Routine API and scheduler callers retain the current prune
   * behaviour by leaving this unset.
   */
  skipRetentionPrune?: boolean;
  /** Optional hard ceiling for isolated one-shot recovery work. */
  maxPayloadBytes?: number;
  /**
   * Exact one-shot recovery only. Counts every persistent application table
   * in the same exported repeatable-read snapshot imported by pg_dump.
   */
  captureSourceSnapshotTableCounts?: boolean;
  /** End-to-end deadline covering source snapshot, dump, encryption and upload. */
  timeoutMs?: number;
};

interface ReservedBackupAttempt {
  row: BackupLog;
  databaseUrl: string;
  filename: string;
  objectPath: string;
  trigger: "manual" | "auto";
  skipRetentionPrune: boolean;
  maxPayloadBytes?: number;
  captureSourceSnapshotTableCounts: boolean;
  timeoutMs: number;
}

interface BackupCreationOutcomePool {
  query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

export async function persistBackupCreationSuccess(
  input: {
    databaseUrl: string;
    backupId: number;
    objectPath: string;
    sizeBytes: number;
    sha256: string;
    encryptionFormat: string;
    encryptionKeyId: string;
    deadlineAt: number;
    timeoutMs: number;
  },
  dependencies: {
    poolFactory?: (
      connectionString: string,
      timeoutMs: number,
    ) => BackupCreationOutcomePool;
  } = {},
): Promise<boolean> {
  const pool = (
    dependencies.poolFactory ??
    ((connectionString, timeoutMs) =>
      new pg.Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
      }) as unknown as BackupCreationOutcomePool)
  )(input.databaseUrl, input.timeoutMs);
  try {
    const result = await pool.query<{ id: number }>(
      `UPDATE backup_log
          SET status = 'success', object_path = $2, size_bytes = $3,
              sha256 = $4, encryption_format = $5, encryption_key_id = $6
        WHERE id = $1 AND status = 'running'
          AND clock_timestamp() <= $7::timestamptz
        RETURNING id`,
      [
        input.backupId,
        input.objectPath,
        input.sizeBytes,
        input.sha256,
        input.encryptionFormat,
        input.encryptionKeyId,
        new Date(input.deadlineAt),
      ],
    );
    return (result.rowCount ?? result.rows.length) === 1;
  } finally {
    await boundedBackupCleanup(pool.end(), 5_000).catch(() => undefined);
  }
}

type BackupCreationSuccessMetadata = {
  objectPath: string;
  sizeBytes: number;
  sha256: string;
  encryptionFormat: string;
  encryptionKeyId: string;
};

export type BackupCreationFailureResolution =
  | "failed"
  | "success"
  | "unresolved";

/**
 * Resolve an exception from backup creation without racing an already-committed
 * success. The failure CAS is authoritative only when it still owns the
 * `running` row. If it loses, an exact success row for the uploaded object is
 * authoritative instead.
 */
export async function resolveBackupCreationFailure(
  input: {
    databaseUrl: string;
    backupId: number;
    error: string;
    successMetadata?: BackupCreationSuccessMetadata;
    timeoutMs: number;
  },
  dependencies: {
    poolFactory?: (
      connectionString: string,
      timeoutMs: number,
    ) => BackupCreationOutcomePool;
  } = {},
): Promise<BackupCreationFailureResolution> {
  const pool = (
    dependencies.poolFactory ??
    ((connectionString, timeoutMs) =>
      new pg.Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
      }) as unknown as BackupCreationOutcomePool)
  )(input.databaseUrl, input.timeoutMs);
  try {
    const failed = await pool.query<{ id: number }>(
      `UPDATE backup_log
          SET status = 'failed', error = $2
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [input.backupId, input.error],
    );
    if ((failed.rowCount ?? failed.rows.length) === 1) return "failed";

    if (!input.successMetadata) return "unresolved";
    const metadata = input.successMetadata;
    const succeeded = await pool.query<{ id: number }>(
      `SELECT id
         FROM backup_log
        WHERE id = $1 AND status = 'success'
          AND object_path = $2 AND size_bytes = $3 AND sha256 = $4
          AND encryption_format = $5 AND encryption_key_id = $6`,
      [
        input.backupId,
        metadata.objectPath,
        metadata.sizeBytes,
        metadata.sha256,
        metadata.encryptionFormat,
        metadata.encryptionKeyId,
      ],
    );
    return (succeeded.rowCount ?? succeeded.rows.length) === 1
      ? "success"
      : "unresolved";
  } finally {
    await boundedBackupCleanup(pool.end(), 5_000).catch(() => undefined);
  }
}

export type CreatedBackupLog = BackupLog & {
  sourceSnapshotEvidence?: BackupSourceSnapshotEvidence;
};

export class BackupAlreadyRunningError extends Error {
  constructor() {
    super("A database backup is already running.");
    this.name = "BackupAlreadyRunningError";
  }
}

class BackupExecutionLeaseLostError extends Error {
  constructor() {
    super("Database backup execution lease was lost.");
    this.name = "BackupExecutionLeaseLostError";
  }
}

async function currentRunningBackup(): Promise<BackupLog | undefined> {
  const [running] = await db
    .select()
    .from(backupLogTable)
    .where(eq(backupLogTable.status, "running"))
    .orderBy(desc(backupLogTable.createdAt))
    .limit(1);
  return running;
}

const DEFAULT_STALE_RUNNING_BACKUP_HOURS = 24;
const MIN_STALE_RUNNING_BACKUP_HOURS = 1;
const MAX_STALE_RUNNING_BACKUP_HOURS = 7 * 24;
const DEFAULT_BACKUP_CREATE_TIMEOUT_MS = 10 * 60 * 1_000;

function backupCreateTimeoutMs(value?: number): number {
  const configured = value ?? Number(process.env.BACKUP_CREATE_TIMEOUT_MS);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Backup create timeout must be a positive safe integer.");
  }
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_BACKUP_CREATE_TIMEOUT_MS;
}

function staleRunningBackupHours(): number {
  const configured = Number(process.env.BACKUP_STALE_RUNNING_HOURS);
  if (!Number.isFinite(configured)) return DEFAULT_STALE_RUNNING_BACKUP_HOURS;
  return Math.min(
    MAX_STALE_RUNNING_BACKUP_HOURS,
    Math.max(MIN_STALE_RUNNING_BACKUP_HOURS, configured),
  );
}

/**
 * Close attempts left behind by a crashed process, but only while this caller
 * owns the cross-replica execution lease and after a conservative age fence.
 * The age fence also protects rolling deployments where an older application
 * version reserved under the lock but released it before pg_dump completed.
 */
async function reconcileAbandonedRunningBackups(): Promise<
  BackupLog | undefined
> {
  const running = await currentRunningBackup();
  if (!running) return undefined;

  const staleAfterMs = staleRunningBackupHours() * 60 * 60 * 1_000;
  const ageMs = Date.now() - running.createdAt.getTime();
  if (ageMs < staleAfterMs) return running;

  const cutoff = new Date(Date.now() - staleAfterMs);
  const reconciled = await db
    .update(backupLogTable)
    .set({
      status: "failed",
      error:
        "Backup process ended before completion; stale attempt reconciled.",
    })
    .where(
      and(
        eq(backupLogTable.status, "running"),
        lte(backupLogTable.createdAt, cutoff),
      ),
    )
    .returning({ id: backupLogTable.id });

  logger.warn(
    {
      reconciledBackupIds: reconciled.map((row) => row.id),
      staleAfterHours: staleRunningBackupHours(),
    },
    "Reconciled abandoned database backup attempts",
  );
  return currentRunningBackup();
}

async function reserveBackupAttempt(
  opts: CreateBackupOptions,
): Promise<ReservedBackupAttempt> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (!backupsEnabled()) {
    throw new Error(
      "Object storage is not configured; cannot store backups. Configure the S3_* variables.",
    );
  }
  if (!encryptionStatus(BACKUP_KEYRING_ENV, BACKUP_ACTIVE_KEY_ENV).configured) {
    throw new Error("Backup encryption keyring is not configured.");
  }
  if (
    opts.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxPayloadBytes) || opts.maxPayloadBytes < 1)
  ) {
    throw new Error("Backup payload ceiling must be a positive safe integer.");
  }

  // A UUID prevents two same-millisecond attempts from ever sharing an object
  // key, even if a future caller accidentally bypasses reservation locking.
  const filename = `stavba-${timestampName()}-${randomUUID()}.pgcustom`;
  const objectPath = `/objects/backups/${filename}.enc`;

  const [row] = await db
    .insert(backupLogTable)
    .values({
      filename,
      status: "running",
      trigger: opts.trigger,
      createdBy: opts.actor ?? null,
    })
    .returning();

  return {
    row,
    databaseUrl,
    filename,
    objectPath,
    trigger: opts.trigger,
    skipRetentionPrune: opts.skipRetentionPrune === true,
    maxPayloadBytes: opts.maxPayloadBytes,
    captureSourceSnapshotTableCounts:
      opts.captureSourceSnapshotTableCounts === true,
    timeoutMs: backupCreateTimeoutMs(opts.timeoutMs),
  };
}

async function executeReservedBackup(
  attempt: ReservedBackupAttempt,
  lease: SchedulerLockLease,
): Promise<CreatedBackupLog> {
  const {
    row,
    databaseUrl,
    filename,
    objectPath,
    trigger,
    skipRetentionPrune,
    maxPayloadBytes,
    captureSourceSnapshotTableCounts,
    timeoutMs,
  } = attempt;
  const deadlineAt = Date.now() + timeoutMs;
  const abortController = new AbortController();
  const timeoutError = new Error(
    `Database backup exceeded its ${timeoutMs}ms end-to-end deadline.`,
  );
  const timeoutHandle = setTimeout(() => {
    abortController.abort(timeoutError);
  }, timeoutMs);
  timeoutHandle.unref();
  const throwIfDeadlineExceeded = (): void => {
    if (Date.now() >= deadlineAt && !abortController.signal.aborted) {
      abortController.abort(timeoutError);
    }
    if (abortController.signal.aborted) {
      throw backupAbortReason(abortController.signal);
    }
  };
  let uploadStarted = false;
  let sourceSnapshotEvidence: BackupSourceSnapshotEvidence | undefined;
  let successMetadata: BackupCreationSuccessMetadata | undefined;

  try {
    throwIfDeadlineExceeded();
    if (!lease.isValid()) throw new BackupExecutionLeaseLostError();
    let dump: Buffer;
    if (captureSourceSnapshotTableCounts) {
      const captured = await withExportedBackupSnapshot(
        databaseUrl,
        (snapshotId) =>
          runPgDump(databaseUrl, maxPayloadBytes, snapshotId, {
            signal: abortController.signal,
          }),
        {
          signal: abortController.signal,
          queryTimeoutMs: Math.max(1, deadlineAt - Date.now()),
        },
      );
      dump = captured.value;
      sourceSnapshotEvidence = captured.evidence;
    } else {
      dump = await runPgDump(databaseUrl, maxPayloadBytes, undefined, {
        signal: abortController.signal,
      });
    }
    throwIfDeadlineExceeded();
    if (!lease.isValid()) throw new BackupExecutionLeaseLostError();
    let encrypted: ReturnType<typeof encryptBackupPayload>;
    try {
      encrypted = encryptBackupPayload(dump, filename);
    } finally {
      dump.fill(0);
    }
    const storedPayload = encrypted.payload;
    const storedSize = storedPayload.length;
    try {
      throwIfDeadlineExceeded();
      if (maxPayloadBytes !== undefined && storedSize > maxPayloadBytes) {
        throw new Error(
          `Encrypted backup exceeds the approved ${maxPayloadBytes}-byte payload ceiling.`,
        );
      }
      uploadStarted = true;
      await raceBackupRestoreOperation(
        objectStorage.putPrivateObject(
          objectPath,
          storedPayload,
          "application/octet-stream",
          { signal: abortController.signal },
        ),
        abortController.signal,
      );
      throwIfDeadlineExceeded();
      if (!lease.isValid()) throw new BackupExecutionLeaseLostError();

      const sha256 = createHash("sha256").update(storedPayload).digest("hex");
      successMetadata = {
        objectPath,
        sizeBytes: storedSize,
        sha256,
        encryptionFormat: encrypted.format,
        encryptionKeyId: encrypted.keyId,
      };
      const successPersisted = await raceBackupRestoreOperation(
        persistBackupCreationSuccess({
          databaseUrl,
          backupId: row.id,
          objectPath,
          sizeBytes: storedSize,
          sha256,
          encryptionFormat: encrypted.format,
          encryptionKeyId: encrypted.keyId,
          deadlineAt,
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
        }),
        abortController.signal,
      );
      if (!successPersisted) throw new BackupExecutionLeaseLostError();
      throwIfDeadlineExceeded();
      const updated: BackupLog = {
        ...row,
        status: "success",
        objectPath,
        sizeBytes: storedSize,
        sha256,
        encryptionFormat: encrypted.format,
        encryptionKeyId: encrypted.keyId,
      };

      logger.info(
        {
          backupId: row.id,
          sizeBytes: storedSize,
          sha256,
          encryptionFormat: encrypted.format,
          encryptionKeyId: encrypted.keyId,
          trigger,
        },
        "Database backup completed",
      );

      if (!skipRetentionPrune) {
        pruneOldBackups().catch((err) =>
          logger.warn({ err }, "Backup pruning failed"),
        );
      }

      return sourceSnapshotEvidence
        ? { ...updated, sourceSnapshotEvidence }
        : updated;
    } finally {
      storedPayload.fill(0);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let resolution: BackupCreationFailureResolution | undefined;
    try {
      resolution = await boundedBackupCleanup(
        resolveBackupCreationFailure({
          databaseUrl,
          backupId: row.id,
          error: message,
          successMetadata,
          timeoutMs: 5_000,
        }),
        5_000,
      );
    } catch (resolutionError) {
      logger.error(
        { err: resolutionError, backupId: row.id },
        "Failed to resolve database backup outcome",
      );
      throw err;
    }
    if (resolution === "failed" && uploadStarted) {
      await boundedBackupCleanup(
        objectStorage.deletePrivateObject(objectPath),
        5_000,
      ).catch(() => undefined);
    }
    if (resolution === "success" && successMetadata) {
      const updated: BackupLog = {
        ...row,
        status: "success",
        objectPath: successMetadata.objectPath,
        sizeBytes: successMetadata.sizeBytes,
        sha256: successMetadata.sha256,
        encryptionFormat: successMetadata.encryptionFormat,
        encryptionKeyId: successMetadata.encryptionKeyId,
      };
      logger.info(
        { backupId: row.id },
        "Database backup success became authoritative after a late exception",
      );
      return sourceSnapshotEvidence
        ? { ...updated, sourceSnapshotEvidence }
        : updated;
    }
    logger.error({ err, backupId: row.id }, "Database backup failed");
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function createBackup(
  opts: CreateBackupOptions,
): Promise<CreatedBackupLog> {
  const lease = await tryAcquireSchedulerLock(SCHEDULER_LOCK_KEYS.backupAuto);
  if (!lease) throw new BackupAlreadyRunningError();
  try {
    if (await reconcileAbandonedRunningBackups()) {
      throw new BackupAlreadyRunningError();
    }
    const attempt = await reserveBackupAttempt(opts);
    return await executeReservedBackup(attempt, lease);
  } finally {
    const released = await boundedBackupCleanup(
      lease.release().then(() => true),
      5_000,
    );
    if (released !== true) {
      logger.warn("Database backup scheduler lease release timed out");
    }
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

/**
 * Load and authenticate a backup. Legacy rows without encryption metadata stay
 * readable during the rollout; an encrypted row never falls back to raw bytes.
 */
export async function readBackupDump(
  row: BackupLog,
  options: {
    maxPayloadBytes?: number;
    signal?: AbortSignal;
    storage?: Pick<ObjectStorageService, "getPrivateObjectBuffer">;
  } = {},
): Promise<Buffer> {
  if (!row.objectPath) throw new Error("Backup object path is missing.");
  const stored = await raceBackupRestoreOperation(
    (options.storage ?? objectStorage).getPrivateObjectBuffer(row.objectPath, {
      maxBytes: options.maxPayloadBytes,
      signal: options.signal,
    }),
    options.signal,
  );
  if (row.sha256) {
    const actual = createHash("sha256").update(stored).digest("hex");
    if (actual !== row.sha256)
      throw new Error("Backup integrity verification failed.");
  }
  if (!row.encryptionFormat) return stored;
  if (row.encryptionFormat !== "mve1" || !row.encryptionKeyId) {
    throw new Error("Backup encryption metadata is invalid.");
  }
  try {
    return decryptBackupPayload(stored, row.filename);
  } finally {
    stored.fill(0);
  }
}

const PRODUCTION_RESTORE_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function productionRestoreProcessBoundary(
  databaseUrl: string,
  restoreRole: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Readonly<{
  databaseArgument: string;
  environment: NodeJS.ProcessEnv;
}> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(restoreRole)) {
    throw new Error("Restore role is not a canonical PostgreSQL identifier.");
  }
  let connection: URL;
  try {
    connection = new URL(databaseUrl);
  } catch {
    throw new Error("Restore database connection is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(connection.protocol) ||
    connection.hostname.length === 0 ||
    connection.pathname.length < 2 ||
    connection.hash.length !== 0
  ) {
    throw new Error("Restore database connection is invalid.");
  }
  for (const key of connection.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("password") ||
      ["options", "passfile", "service", "servicefile"].includes(normalized)
    ) {
      throw new Error("Restore database connection parameters are unsafe.");
    }
  }
  let password: string;
  try {
    password = decodeURIComponent(connection.password);
  } catch {
    throw new Error("Restore database connection is invalid.");
  }
  connection.password = "";
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PRODUCTION_RESTORE_ENV_ALLOWLIST) {
    const value = inheritedEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PGOPTIONS = `-c role=${restoreRole}`;
  if (password.length > 0) environment.PGPASSWORD = password;
  return Object.freeze({
    databaseArgument: connection.toString(),
    environment,
  });
}

let applicationDatabasePoolSealed = false;

export async function sealApplicationDatabasePoolForProductionRestore(): Promise<void> {
  if (applicationDatabasePoolSealed) return;
  await applicationDatabasePool.end();
  applicationDatabasePoolSealed = true;
}

async function runProductionRestoreChild(input: {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  stdout: "ignore" | number;
  label: "pg_restore" | "psql";
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      stdio: ["ignore", input.stdout, "pipe"],
      env: input.environment,
    });
    let settled = false;
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(
        () => child.kill("SIGKILL"),
        PRODUCTION_RESTORE_KILL_GRACE_MS,
      );
      forceKill.unref();
    }, PRODUCTION_RESTORE_DEADLINE_MS);
    deadline.unref();
    let stderrBytes = 0;
    child.stderr?.on("data", (value: Buffer) => {
      // Drain a bounded prefix so the child cannot block. Never surface raw
      // stderr: connection or restored row material must not reach output.
      if (stderrBytes < 64 * 1024) {
        stderrBytes += Math.min(value.byteLength, 64 * 1024 - stderrBytes);
      }
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", () =>
      finish(new Error(`${input.label} failed to start.`)),
    );
    child.once("close", (code) => {
      if (timedOut) {
        finish(new Error(`${input.label} exceeded its pinned deadline.`));
      } else if (code !== 0) {
        finish(new Error(`${input.label} exited with code ${code}.`));
      } else {
        finish();
      }
    });
  });
}

export async function restoreBackup(
  id: number,
  options: {
    restoreRole?: string;
    preRestoreCleanup?: "invoice-0108";
    verifiedBackup?: BackupLog;
    updateBackupLogAfterRestore?: boolean;
    runtimeRole?: string;
  } = {},
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  const restoreRole = options.restoreRole;
  const attendedInvoice0108Restore =
    options.preRestoreCleanup === "invoice-0108";
  if (
    attendedInvoice0108Restore &&
    (restoreRole === undefined ||
      options.runtimeRole === undefined ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(options.runtimeRole) ||
      options.runtimeRole === restoreRole ||
      options.verifiedBackup === undefined ||
      options.updateBackupLogAfterRestore !== false)
  ) {
    throw new Error(
      "Invoice 0108 restore requires an exact role, verified backup row, and external receipt custody.",
    );
  }
  if (options.verifiedBackup !== undefined && !attendedInvoice0108Restore) {
    throw new Error("A verified backup row is restricted to attended restore.");
  }
  const productionBoundary =
    restoreRole === undefined
      ? undefined
      : productionRestoreProcessBoundary(databaseUrl, restoreRole, process.env);

  if (restoreInProgress) {
    throw new Error("Obnovení už právě probíhá. Počkejte na jeho dokončení.");
  }

  const row = options.verifiedBackup ?? (await getBackup(id));
  if (!row || row.id !== id || row.status !== "success" || !row.objectPath) {
    throw new Error("Záloha nenalezena nebo není dokončená.");
  }

  restoreInProgress = true;
  const dir = await mkdtemp(join(tmpdir(), "stavba-restore-"));
  const filePath = join(dir, "dump.pgcustom");
  const restoreSqlPath = join(dir, "restore.sql");
  try {
    const buffer = await readBackupDump(row);
    try {
      await writeFile(filePath, buffer, { mode: 0o600 });
    } finally {
      buffer.fill(0);
    }

    if (attendedInvoice0108Restore && productionBoundary !== undefined) {
      const sqlHandle = await open(restoreSqlPath, "wx", 0o600);
      try {
        await runProductionRestoreChild({
          command: PRODUCTION_PG_RESTORE,
          args: [
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-acl",
            "--exit-on-error",
            "--file=-",
            filePath,
          ],
          environment: productionBoundary.environment,
          stdout: sqlHandle.fd,
          label: "pg_restore",
        });
        await sqlHandle.sync();
      } finally {
        await sqlHandle.close();
      }
      const generatedSql = await stat(restoreSqlPath);
      if (
        !generatedSql.isFile() ||
        generatedSql.size < 1 ||
        generatedSql.size > PRODUCTION_RESTORE_MAX_SQL_BYTES
      ) {
        throw new Error("Generated restore SQL is outside the pinned bound.");
      }
      const freezePool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 15_000,
      });
      const freezeClient = await freezePool.connect();
      let runtimeThawed = false;
      try {
        await freezeClient.query(`ALTER ROLE "${options.runtimeRole}" NOLOGIN`);
        const freeze = await freezeClient.query(
          "SELECT rolcanlogin, (SELECT count(*)::integer FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()) AS runtime_sessions FROM pg_roles WHERE rolname = $1",
          [options.runtimeRole],
        );
        if (
          freeze.rows.length !== 1 ||
          freeze.rows[0]?.rolcanlogin !== false ||
          freeze.rows[0]?.runtime_sessions !== 0
        ) {
          throw new Error("Runtime writer freeze is not exclusive.");
        }
        await runProductionRestoreChild({
          command: PRODUCTION_PSQL,
          args: [
            "--no-psqlrc",
            "--single-transaction",
            "--set=ON_ERROR_STOP=1",
            "--dbname",
            productionBoundary.databaseArgument,
            "--command",
            'DROP TABLE IF EXISTS "public"."invoice_source_allocations"',
            "--file",
            restoreSqlPath,
          ],
          environment: productionBoundary.environment,
          stdout: "ignore",
          label: "psql",
        });
        await freezeClient.query(`ALTER ROLE "${options.runtimeRole}" LOGIN`);
        const thaw = await freezeClient.query(
          "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
          [options.runtimeRole],
        );
        if (thaw.rows.length !== 1 || thaw.rows[0]?.rolcanlogin !== true) {
          throw new Error("Runtime role could not be restored after recovery.");
        }
        runtimeThawed = true;
      } finally {
        freezeClient.release();
        await freezePool.end();
        if (!runtimeThawed) {
          logger.error(
            { backupId: id },
            "Attended restore failed with runtime role left NOLOGIN",
          );
        }
      }
    } else {
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
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `pg_restore exited with code ${code}: ${stderr.trim()}`,
              ),
            );
        });
      });
    }

    if (options.updateBackupLogAfterRestore !== false) {
      await db
        .update(backupLogTable)
        .set({ restoredAt: new Date() })
        .where(eq(backupLogTable.id, id));
    }

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
const RESTORE_TEST_TIMEOUT_MS =
  Number(process.env.BACKUP_RESTORE_TEST_TIMEOUT_MS) || 10 * 60 * 1000;

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

interface BackupRestoreOutcomePool {
  query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

export async function persistBackupRestoreTestOutcome(
  input: {
    databaseUrl: string;
    backupId: number;
    outcome: "ok" | "failed";
    testedAt: Date;
    durationMs: number;
    verifiedTables: Record<string, number> | null;
    error: string | null;
    deadlineAt: number;
    overrideTimedOutSuccess?: boolean;
    timeoutMs: number;
  },
  dependencies: {
    poolFactory?: (
      connectionString: string,
      timeoutMs: number,
    ) => BackupRestoreOutcomePool;
  } = {},
): Promise<boolean> {
  const pool = (
    dependencies.poolFactory ??
    ((connectionString, timeoutMs) =>
      new pg.Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
      }) as unknown as BackupRestoreOutcomePool)
  )(input.databaseUrl, input.timeoutMs);
  const allowedPriorStatuses = input.overrideTimedOutSuccess
    ? ["pending", "ok"]
    : ["pending"];
  try {
    const result = await pool.query<{ id: number }>(
      `UPDATE backup_log
          SET restore_status = $2,
              restore_tested_at = $3,
              restore_duration_ms = $4,
              restore_verified_tables = $5::jsonb,
              restore_error = $6
        WHERE id = $1
          AND restore_status = ANY($7::text[])
          AND ($2 <> 'ok' OR clock_timestamp() <= $8::timestamptz)
        RETURNING id`,
      [
        input.backupId,
        input.outcome,
        input.testedAt,
        input.durationMs,
        input.verifiedTables === null
          ? null
          : JSON.stringify(input.verifiedTables),
        input.error,
        allowedPriorStatuses,
        new Date(input.deadlineAt),
      ],
    );
    return (result.rowCount ?? result.rows.length) === 1;
  } finally {
    await boundedBackupCleanup(pool.end(), 5_000).catch(() => undefined);
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
export async function testBackupRestore(
  id: number,
  options: {
    maxPayloadBytes?: number;
    expectedSourceSnapshotEvidence?: BackupSourceSnapshotEvidence;
  } = {},
): Promise<BackupLog> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  if (restoreTestInProgress) {
    throw new Error("Restore test již probíhá. Počkejte na jeho dokončení.");
  }

  const row = await getBackup(id);
  if (!row || row.status !== "success" || !row.objectPath) {
    throw new Error("Záloha nenalezena nebo není dokončená.");
  }
  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxPayloadBytes) ||
      options.maxPayloadBytes < 1)
  ) {
    throw new Error("Backup payload ceiling must be a positive safe integer.");
  }
  if (
    options.maxPayloadBytes !== undefined &&
    (row.sizeBytes === null || row.sizeBytes > options.maxPayloadBytes)
  ) {
    throw new Error(
      `Stored backup exceeds the approved ${options.maxPayloadBytes}-byte payload ceiling.`,
    );
  }
  const expectedSourceSnapshotEvidence =
    options.expectedSourceSnapshotEvidence === undefined
      ? undefined
      : validateBackupSourceSnapshotEvidence(
          options.expectedSourceSnapshotEvidence,
        );

  // Mark as pending so the UI can show a spinner immediately.
  const [pending] = await db
    .update(backupLogTable)
    .set({
      restoreStatus: "pending",
      restoreTestedAt: null,
      restoreError: null,
    })
    .where(eq(backupLogTable.id, id))
    .returning();

  restoreTestInProgress = true;
  const startedAt = Date.now();
  const deadlineAt = startedAt + RESTORE_TEST_TIMEOUT_MS;
  const restoreAbortController = new AbortController();
  const restoreTimeoutError = new Error(
    `Restore test překročil časový limit ${RESTORE_TEST_TIMEOUT_MS / 1000}s`,
  );
  const remainingMs = (): number =>
    Math.max(1, Math.min(RESTORE_TEST_TIMEOUT_MS, deadlineAt - Date.now()));
  const boundedPool = (connectionString: string, cleanup = false) => {
    const timeoutMs = cleanup ? 15_000 : remainingMs();
    return new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
    });
  };
  const tempDbName = `stavba_restore_test_${Date.now()}`;
  const adminUrl = postgresAdminUrl(databaseUrl);
  const tmpDir = await mkdtemp(join(tmpdir(), "stavba-restoretest-"));
  const filePath = join(tmpDir, "dump.pgcustom");

  let tempDbCreated = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let restoreTimedOut = false;
  let activeRestoreChild: ReturnType<typeof spawn> | null = null;
  let activeRestoreClosed: Promise<void> | null = null;
  let activeRestoreStop: Promise<void> | null = null;

  const stopActiveRestoreProcess = (): Promise<void> => {
    if (activeRestoreStop) return activeRestoreStop;
    if (!activeRestoreChild || !activeRestoreClosed) return Promise.resolve();
    const child = activeRestoreChild;
    const closed = activeRestoreClosed;
    activeRestoreStop = (async () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (activeRestoreChild === child) child.kill("SIGKILL");
      }, 5_000);
      forceKill.unref();
      try {
        await boundedBackupCleanup(closed, 6_000);
      } finally {
        clearTimeout(forceKill);
      }
    })();
    return activeRestoreStop;
  };

  const throwIfRestoreTimedOut = (): void => {
    if (restoreTimedOut || restoreAbortController.signal.aborted)
      throw restoreTimeoutError;
  };

  // Wrap the entire operation in a timeout.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      restoreTimedOut = true;
      restoreAbortController.abort(restoreTimeoutError);
      void stopActiveRestoreProcess();
      reject(restoreTimeoutError);
    }, RESTORE_TEST_TIMEOUT_MS);
  });

  const doTest = async (): Promise<BackupLog> => {
    // 1. Download the dump from object storage.
    const buffer = await raceBackupRestoreOperation(
      readBackupDump(row, {
        ...options,
        signal: restoreAbortController.signal,
      }),
      restoreAbortController.signal,
    );
    throwIfRestoreTimedOut();
    await raceBackupRestoreOperation(
      writeFile(filePath, buffer, { signal: restoreAbortController.signal }),
      restoreAbortController.signal,
    );
    throwIfRestoreTimedOut();

    // 2. Create the ephemeral database.
    const adminPool = boundedPool(adminUrl);
    try {
      await raceBackupRestoreOperation(
        adminPool.query(`CREATE DATABASE "${tempDbName}"`),
        restoreAbortController.signal,
      );
      tempDbCreated = true;
      throwIfRestoreTimedOut();
    } finally {
      await boundedBackupCleanup(adminPool.end(), 5_000).catch((cleanupError) =>
        logger.warn(
          { cleanupError, tempDbName },
          "Restore create-database pool close failed",
        ),
      );
    }

    // 3. Restore into the temp database.
    const targetUrl = tempDbUrl(databaseUrl, tempDbName);
    await raceBackupRestoreOperation(
      new Promise<void>((resolve, reject) => {
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
        activeRestoreChild = child;
        activeRestoreClosed = new Promise<void>((closeResolve) => {
          child.once("close", () => closeResolve());
        });
        const stderrCeilingBytes = 64 * 1024;
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          if (Buffer.byteLength(stderr) >= stderrCeilingBytes) return;
          const remaining = stderrCeilingBytes - Buffer.byteLength(stderr);
          stderr += Buffer.from(d).subarray(0, remaining).toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `pg_restore exited with code ${code}: ${stderr.trim()}`,
              ),
            );
        });
      }),
      restoreAbortController.signal,
      () => void stopActiveRestoreProcess(),
    );
    activeRestoreChild = null;
    activeRestoreClosed = null;
    activeRestoreStop = null;
    throwIfRestoreTimedOut();

    // 4. Verify key tables have rows.
    const testPool = boundedPool(targetUrl);
    let verifiedTables: Record<string, number> = {};
    try {
      if (expectedSourceSnapshotEvidence) {
        const restoredEvidence = await readBackupSnapshotTableCounts(testPool, {
          signal: restoreAbortController.signal,
        });
        if (
          restoredEvidence.tableCountsSha256 !==
            expectedSourceSnapshotEvidence.tableCountsSha256 ||
          JSON.stringify(restoredEvidence.tableNames) !==
            JSON.stringify(expectedSourceSnapshotEvidence.tableNames) ||
          JSON.stringify(restoredEvidence.tableCounts) !==
            JSON.stringify(expectedSourceSnapshotEvidence.tableCounts)
        ) {
          throw new Error(
            "Restored database table set or row counts do not match the exact pg_dump source snapshot.",
          );
        }
        verifiedTables = { ...restoredEvidence.tableCounts };
      } else {
        for (const table of VERIFY_TABLES) {
          const result = await raceBackupRestoreOperation(
            testPool.query(`SELECT COUNT(*)::integer AS c FROM "${table}"`),
            restoreAbortController.signal,
          );
          const count = result.rows[0]?.c;
          if (!Number.isInteger(count) || count < 0) {
            throw new Error(
              `Restore verification returned an invalid row count for ${table}.`,
            );
          }
          verifiedTables[table] = count;
          throwIfRestoreTimedOut();
        }
      }
      throwIfRestoreTimedOut();

      const invalidConstraints = await raceBackupRestoreOperation(
        testPool.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM pg_constraint WHERE NOT convalidated",
        ),
        restoreAbortController.signal,
      );
      const invalidIndexes = await raceBackupRestoreOperation(
        testPool.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM pg_index WHERE NOT indisvalid OR NOT indisready",
        ),
        restoreAbortController.signal,
      );
      if ((invalidConstraints.rows[0]?.count ?? 0) !== 0) {
        throw new Error(
          "Restore verification found unvalidated database constraints.",
        );
      }
      if ((invalidIndexes.rows[0]?.count ?? 0) !== 0) {
        throw new Error("Restore verification found invalid database indexes.");
      }
      throwIfRestoreTimedOut();
    } finally {
      await boundedBackupCleanup(testPool.end(), 5_000).catch((cleanupError) =>
        logger.warn(
          { cleanupError, tempDbName },
          "Restore verification pool close failed",
        ),
      );
    }

    const durationMs = Date.now() - startedAt;

    throwIfRestoreTimedOut();
    const restoreTestedAt = new Date();
    const persisted = await persistBackupRestoreTestOutcome({
      databaseUrl,
      backupId: id,
      outcome: "ok",
      testedAt: restoreTestedAt,
      durationMs,
      verifiedTables,
      error: null,
      deadlineAt,
      timeoutMs: remainingMs(),
    });
    if (!persisted) {
      throw new Error(
        "Restore test success evidence was refused after its pending state or deadline changed.",
      );
    }
    const updated: BackupLog = {
      ...pending,
      restoreStatus: "ok",
      restoreTestedAt,
      restoreDurationMs: durationMs,
      restoreVerifiedTables: verifiedTables,
      restoreError: null,
    };

    logger.info(
      { backupId: id, durationMs, verifiedTables },
      "Backup restore test passed",
    );

    return updated;
  };

  const restoreOperation = doTest();
  try {
    const result = await Promise.race([restoreOperation, timeoutPromise]);
    return result;
  } catch (err) {
    if (restoreTimedOut) {
      await stopActiveRestoreProcess();
      await boundedBackupCleanup(
        restoreOperation.catch(() => undefined),
        6_000,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;

    const restoreTestedAt = new Date();
    const failedPersisted = await boundedBackupCleanup(
      persistBackupRestoreTestOutcome({
        databaseUrl,
        backupId: id,
        outcome: "failed",
        testedAt: restoreTestedAt,
        durationMs,
        verifiedTables: null,
        error: message,
        deadlineAt,
        overrideTimedOutSuccess: restoreTimedOut,
        timeoutMs: 5_000,
      }),
      6_000,
    );
    const updated: BackupLog | undefined = failedPersisted
      ? {
          ...pending,
          restoreStatus: "failed",
          restoreTestedAt,
          restoreDurationMs: durationMs,
          restoreError: message,
          restoreVerifiedTables: null,
        }
      : undefined;

    logger.error(
      { err, backupId: id, durationMs },
      "Backup restore test failed",
    );

    return updated ?? pending;
  } finally {
    restoreTestInProgress = false;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    await boundedBackupCleanup(
      rm(tmpDir, { recursive: true, force: true }),
      5_000,
    ).catch((cleanupError) =>
      logger.warn({ cleanupError, tmpDir }, "Restore temp cleanup failed"),
    );

    // Always drop the temp database (in the finally block so it runs even on error).
    if (tempDbCreated) {
      const adminPool = boundedPool(adminUrl, true);
      try {
        const dropped = await boundedBackupCleanup(
          adminPool.query(
            `DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`,
          ),
          15_000,
        );
        if (!dropped) {
          logger.warn(
            { tempDbName },
            "Restore cleanup database drop timed out",
          );
        }
      } catch (dropErr) {
        logger.warn(
          { dropErr, tempDbName },
          "Failed to drop temp restore-test database",
        );
      } finally {
        await boundedBackupCleanup(adminPool.end(), 5_000).catch(
          (cleanupError) =>
            logger.warn(
              { cleanupError, tempDbName },
              "Restore cleanup pool close failed",
            ),
        );
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
  const [row] = await db
    .select()
    .from(backupLogTable)
    .where(eq(backupLogTable.id, id));
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
    .where(
      and(
        eq(backupLogTable.restoreStatus, "ok"),
        isNotNull(backupLogTable.restoreTestedAt),
      ),
    )
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
async function reserveAutoBackupIfDue(
  lease: SchedulerLockLease,
  signal?: AbortSignal,
): Promise<{ triggered: boolean; reason: string }> {
  if (signal?.aborted) {
    return { triggered: false, reason: "Backup scheduler stopped" };
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
  if (signal?.aborted) {
    return { triggered: false, reason: "Backup scheduler stopped" };
  }

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

  // The execution lease is held through the complete dump/upload. A recent
  // running row still blocks for rolling-upgrade compatibility; an old row is
  // reconciled only after the conservative age fence above.
  if (await reconcileAbandonedRunningBackups()) {
    return { triggered: false, reason: "A backup is already running" };
  }
  if (signal?.aborted) {
    return { triggered: false, reason: "Backup scheduler stopped" };
  }

  // The running row is reserved synchronously while the caller still holds the
  // advisory lock. A second replica can therefore observe the reservation
  // before the expensive dump is scheduled.
  const settings = await getBackupSettings();
  if (signal?.aborted) {
    return { triggered: false, reason: "Backup scheduler stopped" };
  }
  const notifyEmail =
    settings?.restoreNotifyEmail ??
    process.env.BACKUP_RESTORE_NOTIFY_EMAIL ??
    null;
  const attempt = await reserveBackupAttempt({ trigger: "auto" });

  setImmediate(() => {
    void (async () => {
      try {
        if (signal?.aborted) {
          await resolveBackupCreationFailure({
            databaseUrl: attempt.databaseUrl,
            backupId: attempt.row.id,
            error:
              "Automatic backup cancelled before execution because the scheduler stopped.",
            timeoutMs: 5_000,
          });
          return;
        }
        await executeReservedBackup(attempt, lease);
        lastAutoBackupCompletedAt = new Date();
      } catch (err) {
        lastAutoBackupCompletedAt = new Date();
        logger.error({ err }, "Triggered auto-backup failed");
        const msg = err instanceof Error ? err.message : String(err);
        await notifyAutoBackupFailed({ errorMessage: msg, notifyEmail }).catch(
          () => {},
        );
      } finally {
        await lease
          .release()
          .catch((err) =>
            logger.error({ err }, "Backup execution lock release failed"),
          );
      }
    })();
  });

  return { triggered: true, reason: "Backup started" };
}

export async function triggerAutoBackupIfDue(signal?: AbortSignal): Promise<{
  triggered: boolean;
  reason: string;
}> {
  if (signal?.aborted) {
    return { triggered: false, reason: "Backup scheduler stopped" };
  }
  if (!backupsEnabled()) {
    return { triggered: false, reason: "Object storage not configured" };
  }

  const lease = await tryAcquireSchedulerLock(SCHEDULER_LOCK_KEYS.backupAuto);
  if (!lease) {
    return {
      triggered: false,
      reason: "Another backup trigger is already active",
    };
  }
  try {
    const result = await reserveAutoBackupIfDue(lease, signal);
    if (!result.triggered) await lease.release();
    return result;
  } catch (error) {
    await lease.release();
    throw error;
  }
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

export type SchedulerStopHandle = Readonly<{
  stop(): void;
}>;

const inactiveSchedulerHandle: SchedulerStopHandle = Object.freeze({
  stop(): void {},
});

let backupSchedulerHandle: SchedulerStopHandle | undefined;

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
export function startBackupScheduler(): SchedulerStopHandle {
  if (backupSchedulerHandle) return backupSchedulerHandle;
  if (!backupsEnabled()) {
    logger.info("Automatic backups disabled (no object storage configured)");
    return inactiveSchedulerHandle;
  }

  const abortController = new AbortController();
  const intervalMs = backupIntervalHours() * 60 * 60 * 1000;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    triggerAutoBackupIfDue(abortController.signal).catch((err) =>
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

  const handle: SchedulerStopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      clearTimeout(warmup);
      clearInterval(timer);
      if (backupSchedulerHandle === handle) backupSchedulerHandle = undefined;
    },
  };
  backupSchedulerHandle = handle;

  logger.info(
    { intervalHours: intervalMs / (60 * 60 * 1000) },
    "Backup scheduler started (setInterval fallback)",
  );
  return handle;
}

let restoreTestSchedulerHandle: SchedulerStopHandle | undefined;

/**
 * Start the weekly restore-test scheduler. Idempotent. Checks once per hour
 * whether the configured day of the week has arrived and the latest successful
 * backup hasn't been tested yet (or was last tested >6 days ago). Does nothing
 * when backups are disabled or no backup has been created.
 */
export function startRestoreTestScheduler(): SchedulerStopHandle {
  if (restoreTestSchedulerHandle) return restoreTestSchedulerHandle;
  if (!backupsEnabled()) return inactiveSchedulerHandle;

  const CHECK_INTERVAL_MS = 60 * 60 * 1000;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const settings = await getBackupSettings();
      if (stopped) return;

      let targetDay: number | null = settings?.restoreTestDayOfWeek ?? null;
      if (targetDay === null) {
        const envDay = Number(process.env.BACKUP_RESTORE_TEST_DAY_OF_WEEK);
        targetDay =
          Number.isInteger(envDay) && envDay >= 0 && envDay <= 6
            ? envDay
            : null;
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

      if (stopped) return;
      logger.info({ backupId: latest.id }, "Weekly restore test starting");
      const result = await testBackupRestore(latest.id);

      if (!stopped && result.restoreStatus === "failed") {
        const notifyEmail =
          settings?.restoreNotifyEmail ??
          process.env.BACKUP_RESTORE_NOTIFY_EMAIL ??
          null;
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

  const wrappedTick = (): void => {
    if (stopped) return;
    void withSchedulerLock(SCHEDULER_LOCK_KEYS.backupRestoreTest, tick).catch(
      (err) => logger.error({ err }, "Restore-test scheduler tick failed"),
    );
  };

  const timer = setInterval(wrappedTick, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  const handle: SchedulerStopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (restoreTestSchedulerHandle === handle) {
        restoreTestSchedulerHandle = undefined;
      }
    },
  };
  restoreTestSchedulerHandle = handle;

  logger.info("Restore-test scheduler started (checks hourly)");
  return handle;
}
