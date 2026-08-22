import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  createBackup,
  getBackup,
  testBackupRestore,
  type BackupSourceSnapshotEvidence,
  type CreatedBackupLog,
} from "./lib/backup";
import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";
import type { BackupLog } from "@workspace/db";

// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as migrationAdapter from "../../../scripts/production-evidence/production-migration-adapter.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as migrationContract from "../../../scripts/production-evidence/production-migration-contract.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as backupAuthority from "../../../scripts/production-evidence/production-exact-0107-backup-authority.mjs";

const {
  loadProductionMigrationCatalog,
  parseProductionMigrationInventoryRows,
} = migrationAdapter;
const {
  PRODUCTION_MIGRATION_TARGET,
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  createProductionMigrationArtifact,
} = migrationContract;
const {
  PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA,
  createProductionExact0107BackupRestoreReference,
} = backupAuthority;

const { Pool } = pg;

export const PRODUCTION_EXACT_0107_BACKUP_ACTION =
  "CREATE_EXACT_0107_ENCRYPTED_BACKUP_AND_DISPOSABLE_RESTORE" as const;
export const PRODUCTION_EXACT_0107_BACKUP_CONFIRMATION =
  "RUN_EXACT_0107_PRODUCTION_BACKUP_AND_DISPOSABLE_RESTORE_NO_MIGRATION" as const;
export const PRODUCTION_EXACT_0107_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const RECEIPT_BASENAME = "exact-0107-backup-restore-receipt.json";
const REFERENCE_BASENAME = "exact-0107-backup-restore-reference.json";
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BACKUP_OBJECT = /^\/objects\/backups\/[A-Za-z0-9][A-Za-z0-9._/-]{1,480}$/;

type Exact0107Inventory = Readonly<{
  knownAppliedMigrations: number;
  knownAppliedRowsSha256: string;
  latestKnownAppliedTag: string | null;
  missingKnownMigrationTags: readonly string[];
  unexpectedKnownMigrationTags: readonly string[];
  opaqueLegacyRows: readonly Readonly<{
    createdAt: number;
    hash: string;
  }>[];
  excludedMigration0100Present: boolean;
  totalJournalRows: number;
}>;

type StoppedWritersObservation = Readonly<{
  observedAt: string;
  runtimeRole: string;
  activeRuntimeSessions: 0;
  uninspectableClientSessions: 0;
}>;

type Exact0107BackupConfig = Readonly<{
  sourceSha: string;
  migrationsDirectory: string;
  evidenceDirectory: string;
  databaseName: string;
  sessionUser: string;
  migratorRole: string;
  runtimeRole: string;
}>;

export interface ProductionExact0107BackupDependencies {
  readInventory(): Promise<Exact0107Inventory>;
  assertWritersStopped(): Promise<StoppedWritersObservation>;
  create(
    options: Parameters<typeof createBackup>[0],
  ): Promise<CreatedBackupLog>;
  restoreTest(
    id: number,
    options: Parameters<typeof testBackupRestore>[1],
  ): Promise<BackupLog>;
  readBackup(id: number): Promise<BackupLog | undefined>;
  persistExclusive(basename: string, canonical: string): Promise<void>;
  now(): Date;
}

export class ProductionExact0107BackupProducerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionExact0107BackupProducerError";
  }
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new ProductionExact0107BackupProducerError(code, message, options);
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_CONFIGURATION_INVALID",
      `${field} is invalid.`,
    );
  }
  return value;
}

function exactTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_INVALID",
      `${field} is invalid.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_INVALID",
      `${field} is invalid.`,
    );
  }
  return value;
}

function canonicalTimestamp(
  value: Date | null | undefined,
  field: string,
): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_INVALID",
      `${field} is invalid.`,
    );
  }
  return value.toISOString();
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactInventory(value: Exact0107Inventory): Exact0107Inventory {
  if (
    value.knownAppliedMigrations !==
      PRODUCTION_MIGRATION_TARGET.knownAppliedMigrations ||
    value.knownAppliedRowsSha256 !==
      PRODUCTION_MIGRATION_TARGET.knownAppliedRowsSha256 ||
    value.latestKnownAppliedTag !==
      PRODUCTION_MIGRATION_TARGET.latestKnownAppliedTag ||
    value.totalJournalRows !== PRODUCTION_MIGRATION_TARGET.totalJournalRows ||
    value.excludedMigration0100Present !== false ||
    value.missingKnownMigrationTags.length !== 0 ||
    value.unexpectedKnownMigrationTags.length !== 0 ||
    !same(value.opaqueLegacyRows, PRODUCTION_OPAQUE_LEGACY_ROWS)
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_INVENTORY_INVALID",
      "Production is not the frozen exact-0107 source state.",
    );
  }
  return value;
}

function exactSnapshot(
  value: BackupSourceSnapshotEvidence | undefined,
): BackupSourceSnapshotEvidence {
  const migrationRows = value?.tableCounts?.["drizzle.__drizzle_migrations"];
  if (
    value?.schemaVersion !== "site-logbook.backup-source-table-counts/v1" ||
    !Array.isArray(value.tableNames) ||
    value.tableNames.length === 0 ||
    !value.tableNames.includes("drizzle.__drizzle_migrations") ||
    migrationRows !== PRODUCTION_MIGRATION_TARGET.totalJournalRows ||
    !DIGEST.test(value.tableCountsSha256) ||
    Object.keys(value.tableCounts).length !== value.tableNames.length ||
    value.tableNames.some(
      (name) =>
        typeof name !== "string" ||
        !Number.isSafeInteger(value.tableCounts[name]) ||
        value.tableCounts[name] < 0,
    )
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_SNAPSHOT_INVALID",
      "Backup did not capture one bounded exact-0107 all-table snapshot.",
    );
  }
  return value;
}

function exactCreatedBackup(value: CreatedBackupLog): {
  row: CreatedBackupLog;
  snapshot: BackupSourceSnapshotEvidence;
} {
  if (
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    value.status !== "success" ||
    value.trigger !== "manual" ||
    value.createdBy !== "production-exact-0107-invoice-backup" ||
    !BACKUP_OBJECT.test(value.objectPath ?? "") ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    Number(value.sizeBytes) > PRODUCTION_EXACT_0107_BACKUP_MAX_PAYLOAD_BYTES ||
    !HEX64.test(value.sha256 ?? "") ||
    value.encryptionFormat !== "mve1" ||
    typeof value.encryptionKeyId !== "string" ||
    value.encryptionKeyId.length === 0 ||
    value.restoredAt !== null
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_CREATION_INVALID",
      "Encrypted backup result is incomplete or outside the reviewed boundary.",
    );
  }
  canonicalTimestamp(value.createdAt, "created.createdAt");
  return { row: value, snapshot: exactSnapshot(value.sourceSnapshotEvidence) };
}

function exactRestoredBackup(
  value: BackupLog,
  created: CreatedBackupLog,
  snapshot: BackupSourceSnapshotEvidence,
): BackupLog {
  if (
    value.id !== created.id ||
    value.filename !== created.filename ||
    value.objectPath !== created.objectPath ||
    value.status !== "success" ||
    value.sha256 !== created.sha256 ||
    value.sizeBytes !== created.sizeBytes ||
    value.encryptionFormat !== "mve1" ||
    value.encryptionKeyId !== created.encryptionKeyId ||
    value.restoreStatus !== "ok" ||
    value.restoreError !== null ||
    value.restoredAt !== null ||
    !Number.isSafeInteger(value.restoreDurationMs) ||
    Number(value.restoreDurationMs) <= 0 ||
    !same(value.restoreVerifiedTables, snapshot.tableCounts)
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_RESTORE_INVALID",
      "Disposable restore does not reproduce the exact source snapshot.",
    );
  }
  canonicalTimestamp(value.restoreTestedAt, "restored.restoreTestedAt");
  return value;
}

function exactStoppedWriters(
  value: StoppedWritersObservation,
  runtimeRole: string,
): StoppedWritersObservation {
  if (
    value.runtimeRole !== runtimeRole ||
    value.activeRuntimeSessions !== 0 ||
    value.uninspectableClientSessions !== 0
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_WRITERS_RUNNING",
      "Runtime writers are not observably stopped.",
    );
  }
  exactTimestamp(value.observedAt, "writers.observedAt");
  return value;
}

export async function runProductionExact0107Backup(
  config: Exact0107BackupConfig,
  dependencies: ProductionExact0107BackupDependencies,
) {
  const beforeWriters = exactStoppedWriters(
    await dependencies.assertWritersStopped(),
    config.runtimeRole,
  );
  exactInventory(await dependencies.readInventory());
  const createdResult = exactCreatedBackup(
    await dependencies.create({
      trigger: "manual",
      actor: "production-exact-0107-invoice-backup",
      skipRetentionPrune: true,
      maxPayloadBytes: PRODUCTION_EXACT_0107_BACKUP_MAX_PAYLOAD_BYTES,
      captureSourceSnapshotTableCounts: true,
      timeoutMs: 15 * 60 * 1000,
    }),
  );
  const backupCompletedAt = dependencies.now().toISOString();
  const restored = exactRestoredBackup(
    await dependencies.restoreTest(createdResult.row.id, {
      maxPayloadBytes: PRODUCTION_EXACT_0107_BACKUP_MAX_PAYLOAD_BYTES,
      expectedSourceSnapshotEvidence: createdResult.snapshot,
    }),
    createdResult.row,
    createdResult.snapshot,
  );
  const immutable = await dependencies.readBackup(restored.id);
  if (!immutable) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_ROW_MISSING",
      "Restore-tested backup row disappeared before evidence freeze.",
    );
  }
  exactRestoredBackup(immutable, createdResult.row, createdResult.snapshot);
  exactInventory(await dependencies.readInventory());
  const afterWriters = exactStoppedWriters(
    await dependencies.assertWritersStopped(),
    config.runtimeRole,
  );
  const restoreVerifiedAt = canonicalTimestamp(
    immutable.restoreTestedAt,
    "immutable.restoreTestedAt",
  );
  if (
    beforeWriters.observedAt > backupCompletedAt ||
    backupCompletedAt > restoreVerifiedAt ||
    restoreVerifiedAt > afterWriters.observedAt
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_CHRONOLOGY_INVALID",
      "Backup, disposable restore and stopped-writer observations are not monotonic.",
    );
  }
  const receiptStorageId = RECEIPT_BASENAME;
  const receipt = createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA,
    kind: "site-logbook-production-exact-0107-backup-restore-receipt",
    decision: "PASS",
    receiptStorageId,
    sourceSha: config.sourceSha,
    sourceInventorySha256: PRODUCTION_MIGRATION_TARGET.knownAppliedRowsSha256,
    backupArtifactStorageId: String(immutable.objectPath).slice(1),
    backupArtifactSha256: `sha256:${immutable.sha256}`,
    backupArtifactBytes: Number(immutable.sizeBytes),
    backupEncryptionFormat: "mve1",
    backupCompletedAt,
    restoreVerifiedAt,
    restoreInventorySha256: PRODUCTION_MIGRATION_TARGET.knownAppliedRowsSha256,
    sourceTableCountsSha256: createdResult.snapshot.tableCountsSha256,
    restoreTableCountsSha256: createdResult.snapshot.tableCountsSha256,
    restoreDatabaseIsDisposable: true,
    runtimeRole: config.runtimeRole,
    writersStoppedBeforeAt: beforeWriters.observedAt,
    writersStoppedAfterAt: afterWriters.observedAt,
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
  const reference = createProductionExact0107BackupRestoreReference({
    receiptStorageId,
    receiptCanonical: receipt.canonical,
  });
  await dependencies.persistExclusive(RECEIPT_BASENAME, receipt.canonical);
  await dependencies.persistExclusive(REFERENCE_BASENAME, reference.canonical);
  return Object.freeze({
    decision: "EXACT_0107_BACKUP_AND_DISPOSABLE_RESTORE_VERIFIED" as const,
    backupId: immutable.id,
    receiptStorageId,
    receiptSha256: receipt.sha256,
    referenceStorageId: REFERENCE_BASENAME,
    referenceSha256: reference.sha256,
    sourceInventorySha256: PRODUCTION_MIGRATION_TARGET.knownAppliedRowsSha256,
    sourceTableCountsSha256: createdResult.snapshot.tableCountsSha256,
    restoreVerifiedAt,
    productionRestorePerformed: false as const,
    authorizesProductionMigration: false as const,
    authorizesApplicationStart: false as const,
  });
}

function environmentConfig(env: NodeJS.ProcessEnv): Exact0107BackupConfig {
  if (
    env.PRODUCTION_EXACT_0107_BACKUP_ACTION !==
      PRODUCTION_EXACT_0107_BACKUP_ACTION ||
    env.PRODUCTION_EXACT_0107_BACKUP_CONFIRMATION !==
      PRODUCTION_EXACT_0107_BACKUP_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_CONFIRMATION_REQUIRED",
      "Exact attended backup confirmation is required.",
    );
  }
  const sourceSha = requireEmbeddedProductionBuildSha();
  if (env.BUILD_SHA !== sourceSha) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_SOURCE_MISMATCH",
      "Runtime BUILD_SHA differs from the immutable producer source.",
    );
  }
  const migrationsDirectory = path.resolve(env.MIGRATIONS_DIR ?? "");
  const evidenceDirectory = path.resolve(
    env.PRODUCTION_EXACT_0107_EVIDENCE_DIRECTORY ?? "",
  );
  if (
    !path.isAbsolute(env.MIGRATIONS_DIR ?? "") ||
    !path.isAbsolute(env.PRODUCTION_EXACT_0107_EVIDENCE_DIRECTORY ?? "")
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_CONFIGURATION_INVALID",
      "Migration and evidence directories must be absolute.",
    );
  }
  return Object.freeze({
    sourceSha,
    migrationsDirectory,
    evidenceDirectory,
    databaseName: exactIdentifier(
      env.PRODUCTION_INVOICE_0108_DATABASE_NAME,
      "databaseName",
    ),
    sessionUser: exactIdentifier(
      env.PRODUCTION_INVOICE_0108_SESSION_USER,
      "sessionUser",
    ),
    migratorRole: exactIdentifier(
      env.PRODUCTION_INVOICE_0108_MIGRATOR_ROLE,
      "migratorRole",
    ),
    runtimeRole: exactIdentifier(
      env.PRODUCTION_INVOICE_0108_RUNTIME_ROLE,
      "runtimeRole",
    ),
  });
}

async function createExclusiveEvidenceStore(directory: string) {
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_DIRECTORY_INVALID",
      "Evidence directory must be one existing real directory.",
    );
  }
  const exactDirectory = await realpath(directory);
  return async (basename: string, canonical: string) => {
    if (![RECEIPT_BASENAME, REFERENCE_BASENAME].includes(basename)) {
      fail(
        "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_PATH_INVALID",
        "Evidence basename is outside the reviewed allowlist.",
      );
    }
    const target = path.join(exactDirectory, basename);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(
      target,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        noFollow,
      0o600,
    );
    try {
      await handle.writeFile(canonical, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(target, "utf8")) !== canonical) {
      fail(
        "PRODUCTION_EXACT_0107_BACKUP_EVIDENCE_READBACK_INVALID",
        "Durable evidence read-back differs from canonical bytes.",
      );
    }
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const config = environmentConfig(env);
  const connectionString = env.DATABASE_URL;
  if (
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    /[\r\n]/.test(connectionString)
  ) {
    fail(
      "PRODUCTION_EXACT_0107_BACKUP_DATABASE_UNAVAILABLE",
      "Database connection material is unavailable.",
    );
  }
  const catalog = await loadProductionMigrationCatalog({
    migrationsDirectory: config.migrationsDirectory,
  });
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 15_000,
  });
  const readInventory = async (): Promise<Exact0107Inventory> => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      await client.query(`SET LOCAL ROLE "${config.migratorRole}"`);
      const identity = await client.query(
        "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user",
      );
      const identityRow = identity.rows[0];
      if (
        identity.rows.length !== 1 ||
        identityRow?.database_name !== config.databaseName ||
        identityRow?.session_user !== config.sessionUser ||
        identityRow?.current_user !== config.migratorRole
      ) {
        fail(
          "PRODUCTION_EXACT_0107_BACKUP_DATABASE_IDENTITY_INVALID",
          "Database identity differs from the reviewed migration binding.",
        );
      }
      const rows = await client.query(
        'SELECT created_at::text AS created_at, hash::text AS hash FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, hash COLLATE "C" ASC',
      );
      const inventory = parseProductionMigrationInventoryRows(
        rows.rows,
        catalog,
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return inventory as Exact0107Inventory;
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const assertWritersStopped = async (): Promise<StoppedWritersObservation> => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT clock_timestamp()::text AS observed_at,
                pg_is_in_recovery() AS is_in_recovery,
                count(*) FILTER (WHERE usename = $1 AND pid <> pg_backend_pid())::integer AS runtime_sessions,
                count(*) FILTER (WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND usename IS NULL)::integer AS uninspectable_sessions
           FROM pg_stat_activity`,
        [config.runtimeRole],
      );
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        row?.is_in_recovery !== false ||
        row?.runtime_sessions !== 0 ||
        row?.uninspectable_sessions !== 0
      ) {
        fail(
          "PRODUCTION_EXACT_0107_BACKUP_WRITERS_RUNNING",
          "Runtime writers are active, uninspectable, or the database is a recovery replica.",
        );
      }
      return Object.freeze({
        observedAt: new Date(row.observed_at).toISOString(),
        runtimeRole: config.runtimeRole,
        activeRuntimeSessions: 0 as const,
        uninspectableClientSessions: 0 as const,
      });
    } finally {
      client.release();
    }
  };
  try {
    const result = await runProductionExact0107Backup(config, {
      readInventory,
      assertWritersStopped,
      create: createBackup,
      restoreTest: testBackupRestore,
      readBackup: getBackup,
      persistExclusive: await createExclusiveEvidenceStore(
        config.evidenceDirectory,
      ),
      now: () => new Date(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const code =
      error instanceof ProductionExact0107BackupProducerError
        ? error.code
        : "PRODUCTION_EXACT_0107_BACKUP_UNEXPECTED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
