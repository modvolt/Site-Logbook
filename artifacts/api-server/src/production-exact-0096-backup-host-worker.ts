import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  auditSchemaFingerprintSha256,
  readAuditSchemaCatalogProjection,
} from "@workspace/db/audit-schema-preflight";

import { ObjectStorageService } from "./lib/objectStorage";
import {
  ProductionExact0096SnapshotSession,
  streamDecryptProductionExact0096Mve1,
} from "./lib/production-exact-0096-backup-producer";
import { PRODUCTION_EXACT_0096_RUNTIME_RELATION_MANIFEST } from "./lib/production-exact-0096-relation-manifest";

const MAX_REQUEST_BYTES = 512 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{3,511}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,126}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,255}$/;
const OBJECT_KEY =
  /^private\/production\/exact-0096\/[A-Za-z0-9][A-Za-z0-9._/-]{7,511}$/;
const FORBIDDEN_KEY =
  /^(?:password|passwd|privateKey|secretKey|clientSecret|credential|databaseUrl|connectionString|snapshotToken|accessToken|authToken|apiKey)$/i;

type JsonObject = Record<string, unknown>;

class HostWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductionExact0096HostWorkerError";
  }
}

function fail(code: string): never {
  throw new HostWorkerError(code);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function rejectSecrets(value: unknown, key = "request"): void {
  if (FORBIDDEN_KEY.test(key))
    fail("PRODUCTION_BACKUP_HOST_WORKER_SECRET_REJECTED");
  if (Array.isArray(value)) {
    value.forEach((entry) => rejectSecrets(entry));
  } else if (value && typeof value === "object") {
    for (const [itemKey, item] of Object.entries(value as JsonObject)) {
      rejectSecrets(item, itemKey);
    }
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Readonly<JsonObject> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  return Object.freeze(value as JsonObject);
}

async function readRequest(requestPath: string): Promise<Readonly<JsonObject>> {
  if (
    !isAbsolute(requestPath) ||
    !SAFE_PATH.test(requestPath) ||
    requestPath.split("/").some((part) => part === "..")
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  const before = await lstat(requestPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 3 ||
    before.size > MAX_REQUEST_BYTES
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  const handle = await open(requestPath, "r");
  let raw: string;
  try {
    const bytes = Buffer.alloc(before.size);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== bytes.length)
      fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_CHANGED");
    raw = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(requestPath);
  if (
    after.size !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_CHANGED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  if (canonicalJson(parsed) !== raw)
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  rejectSecrets(parsed);
  return exactObject(parsed, Object.keys(parsed as JsonObject));
}

function sourceDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) fail("PRODUCTION_BACKUP_HOST_WORKER_DATABASE_UNAVAILABLE");
  return value;
}

function exactRestoreTarget(value: unknown): Readonly<{
  host: string;
  database: string;
  user: string;
}> {
  const target = exactObject(value, ["database", "host", "user"]);
  if (
    typeof target.host !== "string" ||
    !HOST.test(target.host) ||
    typeof target.database !== "string" ||
    !IDENTIFIER.test(target.database) ||
    typeof target.user !== "string" ||
    !IDENTIFIER.test(target.user)
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  return Object.freeze({
    host: target.host,
    database: target.database,
    user: target.user,
  });
}

function restoreDatabaseUrl(
  target: ReturnType<typeof exactRestoreTarget>,
): string {
  const url = new URL("postgresql://restore.invalid/");
  url.hostname = target.host;
  url.username = target.user;
  url.pathname = `/${target.database}`;
  return url.toString();
}

export function productionExact0096PgRestoreEnvironment(
  target: Readonly<{ host: string; database: string; user: string }>,
  inherited: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: inherited.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    PGHOST: target.host,
    PGDATABASE: target.database,
    PGUSER: target.user,
  });
}

export async function measureProductionExact0096AuditSchemaFingerprint(
  client: Pick<pg.Client, "query">,
): Promise<string> {
  return auditSchemaFingerprintSha256(
    await readAuditSchemaCatalogProjection(client),
  );
}

async function observeDatabase(
  databaseUrl: string,
): Promise<Readonly<JsonObject>> {
  const client = new pg.Client({
    application_name: "site-logbook-production-exact-0096-host-worker",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    query_timeout: 5 * 60_000,
    statement_timeout: 5 * 60_000,
  });
  await client.connect();
  let began = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    began = true;
    const identity = await client.query<{
      database_name: string;
      database_user: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_user AS database_user, current_setting('server_version_num') AS server_version_num",
    );
    const journal = await client.query<{ created_at: string; hash: string }>(
      "SELECT created_at::text AS created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
    );
    const schemaFingerprintSha256 =
      await measureProductionExact0096AuditSchemaFingerprint(client);
    await client.query("COMMIT");
    began = false;
    const row = identity.rows[0];
    if (
      !row ||
      !IDENTIFIER.test(row.database_name) ||
      !IDENTIFIER.test(row.database_user)
    ) {
      fail("PRODUCTION_BACKUP_HOST_WORKER_DATABASE_INVALID");
    }
    const journalRows = journal.rows.map((entry) => {
      const createdAt = Number(entry.created_at);
      if (
        !Number.isSafeInteger(createdAt) ||
        !/^[0-9a-f]{64}$/.test(entry.hash)
      ) {
        fail("PRODUCTION_BACKUP_HOST_WORKER_DATABASE_INVALID");
      }
      return Object.freeze({ created_at: createdAt, hash: entry.hash });
    });
    return Object.freeze({
      observedAt: new Date().toISOString(),
      database: Object.freeze({
        name: row.database_name,
        user: row.database_user,
        serverVersionMajor: Math.floor(Number(row.server_version_num) / 10_000),
      }),
      journalRows: Object.freeze(journalRows),
      schemaFingerprintSha256,
    });
  } finally {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

type ProductionExact0096WriterSample = Readonly<{
  activeApplicationSessions: number;
  activeWriteTransactions: number;
  databaseWriteTuples: number;
  completedTransactions: number;
}>;

async function writerSample(
  client: pg.Client,
): Promise<ProductionExact0096WriterSample> {
  const result = await client.query<{
    active_application_sessions: string;
    active_write_transactions: string;
    database_write_tuples: string;
    completed_transactions: string;
  }>(`SELECT
      (SELECT count(*)::text FROM pg_stat_activity
        WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND pid <> pg_backend_pid()
          AND application_name <> 'site-logbook-production-exact-0096-producer') AS active_application_sessions,
      (SELECT count(DISTINCT l.pid)::text FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.datname = current_database() AND l.granted
          AND a.application_name <> 'site-logbook-production-exact-0096-producer'
          AND l.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
          AND l.pid <> pg_backend_pid()) AS active_write_transactions,
      (SELECT (tup_inserted + tup_updated + tup_deleted)::text
         FROM pg_stat_database WHERE datname = current_database()) AS database_write_tuples,
      (SELECT (xact_commit + xact_rollback)::text
         FROM pg_stat_database WHERE datname = current_database()) AS completed_transactions`);
  const row = result.rows[0];
  const values = [
    Number(row?.active_application_sessions),
    Number(row?.active_write_transactions),
    Number(row?.database_write_tuples),
    Number(row?.completed_transactions),
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_DATABASE_INVALID");
  }
  return Object.freeze({
    activeApplicationSessions: values[0],
    activeWriteTransactions: values[1],
    databaseWriteTuples: values[2],
    completedTransactions: values[3],
  });
}

export function summarizeProductionExact0096WriterWindow(
  first: ProductionExact0096WriterSample,
  second: ProductionExact0096WriterSample,
): Readonly<{
  activeApplicationSessions: number;
  activeWriteTransactions: number;
  databaseWritesObserved: number;
}> {
  const tupleDelta = second.databaseWriteTuples - first.databaseWriteTuples;
  const transactionDelta =
    second.completedTransactions - first.completedTransactions;
  if (
    !Number.isSafeInteger(tupleDelta) ||
    tupleDelta < 0 ||
    !Number.isSafeInteger(transactionDelta) ||
    transactionDelta < 0
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_DATABASE_INVALID");
  }
  return Object.freeze({
    activeApplicationSessions: Math.max(
      first.activeApplicationSessions,
      second.activeApplicationSessions,
    ),
    activeWriteTransactions: Math.max(
      first.activeWriteTransactions,
      second.activeWriteTransactions,
    ),
    // PostgreSQL counts read-only health checks in xact_commit. Only tuple
    // mutations are write evidence; completed transactions are retained above
    // solely to fail closed if the statistics counters reset during the window.
    databaseWritesObserved: tupleDelta,
  });
}

async function observeWriterWindow(
  request: Readonly<JsonObject>,
  signal: AbortSignal,
): Promise<Readonly<JsonObject>> {
  const exact = exactObject(request, ["gracePeriodMs", "operation"]);
  if (
    exact.operation !== "writer-window" ||
    !Number.isSafeInteger(exact.gracePeriodMs) ||
    Number(exact.gracePeriodMs) < 60_000 ||
    Number(exact.gracePeriodMs) > 300_000
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  const client = new pg.Client({
    application_name: "site-logbook-production-exact-0096-host-worker",
    connectionString: sourceDatabaseUrl(),
    connectionTimeoutMillis: 30_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  let began = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    began = true;
    await client.query("SELECT pg_stat_clear_snapshot()");
    const first = await writerSample(client);
    const quiescentSince = new Date().toISOString();
    await delay(Number(exact.gracePeriodMs), undefined, { signal });
    await client.query("SELECT pg_stat_clear_snapshot()");
    const second = await writerSample(client);
    const summary = summarizeProductionExact0096WriterWindow(first, second);
    return Object.freeze({
      quiescentSince,
      observedAt: new Date().toISOString(),
      gracePeriodMs: exact.gracePeriodMs,
      ...summary,
    });
  } finally {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

function exactBackupObject(value: unknown): JsonObject {
  const object = exactObject(value, [
    "bucket",
    "headContentLength",
    "headEtag",
    "headObjectSha256Metadata",
    "headObservedAt",
    "key",
    "storageProvider",
    "versionId",
  ]);
  if (
    typeof object.bucket !== "string" ||
    typeof object.key !== "string" ||
    !OBJECT_KEY.test(object.key) ||
    typeof object.versionId !== "string" ||
    !VERSION.test(object.versionId) ||
    !Number.isSafeInteger(object.headContentLength) ||
    Number(object.headContentLength) < 1 ||
    typeof object.headObjectSha256Metadata !== "string" ||
    !DIGEST.test(object.headObjectSha256Metadata)
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  return object as JsonObject;
}

async function waitForRestore(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      child.kill("SIGTERM");
      reject(new HostWorkerError("PRODUCTION_BACKUP_HOST_WORKER_ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else
        reject(
          new HostWorkerError(
            "PRODUCTION_BACKUP_HOST_WORKER_PG_RESTORE_FAILED",
          ),
        );
    });
  });
}

async function restoreObject(
  request: Readonly<JsonObject>,
  signal: AbortSignal,
): Promise<Readonly<JsonObject>> {
  const exact = exactObject(request, [
    "backupObject",
    "dumpId",
    "encryptedPayloadSha256",
    "operation",
    "plaintextCeilingBytes",
    "restore",
    "sourceDumpSha256",
  ]);
  const object = exactBackupObject(exact.backupObject);
  const target = exactRestoreTarget(exact.restore);
  if (
    exact.operation !== "restore-object" ||
    typeof exact.dumpId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(exact.dumpId) ||
    typeof exact.encryptedPayloadSha256 !== "string" ||
    !DIGEST.test(exact.encryptedPayloadSha256) ||
    typeof exact.sourceDumpSha256 !== "string" ||
    !DIGEST.test(exact.sourceDumpSha256) ||
    !Number.isSafeInteger(exact.plaintextCeilingBytes) ||
    Number(exact.plaintextCeilingBytes) < 1
  ) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  const storage = new ObjectStorageService();
  const encrypted = await storage.openProductionExactVersionedBackup(
    object as never,
    signal,
  );
  const child = spawn(
    "pg_restore",
    ["--exit-on-error", "--no-owner", "--no-acl"],
    {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      env: productionExact0096PgRestoreEnvironment(target),
    },
  );
  if (!child.stdin) fail("PRODUCTION_BACKUP_HOST_WORKER_PG_RESTORE_FAILED");
  const completion = waitForRestore(child, signal);
  let plaintext;
  try {
    [plaintext] = await Promise.all([
      streamDecryptProductionExact0096Mve1({
        encrypted,
        destination: child.stdin,
        dumpId: exact.dumpId,
        encryptedPayloadBytes: Number(object.headContentLength),
        encryptedPayloadSha256: exact.encryptedPayloadSha256,
        plaintextCeilingBytes: Number(exact.plaintextCeilingBytes),
        signal,
      }),
      completion,
    ]);
  } catch (error) {
    encrypted.destroy();
    child.stdin.destroy();
    child.kill("SIGTERM");
    await completion.catch(() => undefined);
    throw error;
  }
  if (plaintext.plaintextSha256 !== exact.sourceDumpSha256) {
    fail("PRODUCTION_BACKUP_HOST_WORKER_RESTORE_DIGEST_INVALID");
  }
  return Object.freeze({
    acceptedObjectVersionId: object.versionId,
    completedAt: new Date().toISOString(),
    pgRestoreExitCode: 0,
    plaintextBytes: plaintext.plaintextBytes,
    plaintextSha256: plaintext.plaintextSha256,
  });
}

async function observeRestored(
  request: Readonly<JsonObject>,
  signal: AbortSignal,
): Promise<Readonly<JsonObject>> {
  const exact = exactObject(request, ["operation", "restore"]);
  if (exact.operation !== "observe-restore") {
    fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
  }
  const target = exactRestoreTarget(exact.restore);
  const databaseUrl = restoreDatabaseUrl(target);
  const database = await observeDatabase(databaseUrl);
  const snapshot = await ProductionExact0096SnapshotSession.open(databaseUrl, {
    signal,
    queryTimeoutMs: 5 * 60_000,
  });
  try {
    const tableSnapshot = await snapshot.measure(
      PRODUCTION_EXACT_0096_RUNTIME_RELATION_MANIFEST,
    );
    return Object.freeze({ ...database, tableSnapshot });
  } finally {
    await snapshot.close();
  }
}

export async function runProductionExact0096HostWorker(
  request: Readonly<JsonObject>,
  signal: AbortSignal,
): Promise<Readonly<JsonObject>> {
  if (signal.aborted) fail("PRODUCTION_BACKUP_HOST_WORKER_ABORTED");
  if (request.operation === "observe-source") {
    exactObject(request, ["operation"]);
    return observeDatabase(sourceDatabaseUrl());
  }
  if (request.operation === "observe-source-snapshot") {
    exactObject(request, ["operation"]);
    const databaseUrl = sourceDatabaseUrl();
    const database = await observeDatabase(databaseUrl);
    const snapshot = await ProductionExact0096SnapshotSession.open(
      databaseUrl,
      {
        signal,
        queryTimeoutMs: 5 * 60_000,
      },
    );
    try {
      return Object.freeze({
        ...database,
        tableSnapshot: await snapshot.measure(
          PRODUCTION_EXACT_0096_RUNTIME_RELATION_MANIFEST,
        ),
      });
    } finally {
      await snapshot.close();
    }
  }
  if (request.operation === "writer-window") {
    return observeWriterWindow(request, signal);
  }
  if (request.operation === "restore-object") {
    return restoreObject(request, signal);
  }
  if (request.operation === "observe-restore") {
    return observeRestored(request, signal);
  }
  fail("PRODUCTION_BACKUP_HOST_WORKER_REQUEST_INVALID");
}

async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("host worker aborted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (argv.length !== 2 || argv[0] !== "--request-file") {
      fail("PRODUCTION_BACKUP_HOST_WORKER_ARGUMENT_INVALID");
    }
    const result = await runProductionExact0096HostWorker(
      await readRequest(argv[1]),
      controller.signal,
    );
    process.stdout.write(canonicalJson(result));
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof HostWorkerError ? error.code : "PRODUCTION_BACKUP_HOST_WORKER_FAILED"}\n`,
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
