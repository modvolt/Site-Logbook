import type { BackupLog } from "@workspace/db";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  AUDIT_SCHEMA_OPAQUE_ROWS_SHA256,
  auditSchemaBackupRowBindingSha256,
  readAuditSchemaInventoryEnvironment,
  runAuditSchemaInventory,
  type AuditSchemaEnvironment,
  type AuditSchemaInventorySummary,
} from "@workspace/db/audit-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";
import { fileURLToPath } from "node:url";
import {
  canonicalBackupSourceSnapshotEvidence,
  createBackup,
  getBackup,
  testBackupRestore,
  type BackupSourceSnapshotEvidence,
  type CreatedBackupLog,
} from "./lib/backup";

export const STAGING_EXACT_0106_BACKUP_ACTION =
  "create-exact-0106-audit-backup";
export const STAGING_EXACT_0106_BACKUP_CONFIRMATION =
  "CREATE_FRESH_EXACT_0106_STAGING_BACKUP_AND_RESTORE_TEST_NO_0107";
export const STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export class StagingExact0106BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StagingExact0106BackupError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StagingExact0106BackupError(code, message);
}

function canonicalTimestamp(value: Date | null, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "EXACT_0106_BACKUP_RESULT_INVALID",
      `${field} must be a valid timestamp.`,
    );
  }
  return value.toISOString();
}

function positiveInteger(value: number | null, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("EXACT_0106_BACKUP_RESULT_INVALID", `${field} must be positive.`);
  }
  return Number(value);
}

function boundedPayload(value: number | null, field: string): number {
  const size = positiveInteger(value, field);
  if (size > STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES) {
    fail(
      "EXACT_0106_BACKUP_PAYLOAD_TOO_LARGE",
      `${field} exceeds the approved 256 MiB ceiling.`,
    );
  }
  return size;
}

function validateBoundary(env: NodeJS.ProcessEnv): void {
  if (
    env.STAGING_EXACT_0106_BACKUP_ACTION !== STAGING_EXACT_0106_BACKUP_ACTION ||
    env.STAGING_EXACT_0106_BACKUP_CONFIRMATION !==
      STAGING_EXACT_0106_BACKUP_CONFIRMATION
  ) {
    fail(
      "EXACT_0106_BACKUP_CONFIRMATION_INVALID",
      "The exact isolated 0106 backup action and confirmation are required.",
    );
  }
  if (
    env.STAGING_AUDIT_SCHEMA_ACTION !== "inspect" ||
    (env.AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    (env.ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    (env.STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    env.STAGING_EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.BACKUP_ENABLED !== "true"
  ) {
    fail(
      "EXACT_0106_BACKUP_BOUNDARY_UNSAFE",
      "Backup requires inspect mode, empty migration confirmations, dark external accounts and enabled staging backups.",
    );
  }
}

function validateInventory(inventory: AuditSchemaInventorySummary): number {
  if (
    inventory.decision !== "READY_0106" ||
    inventory.environmentId !== "site-logbook-staging" ||
    inventory.databaseName !== "site_logbook_staging" ||
    inventory.databaseUser !== "site_logbook_staging" ||
    !/^[0-9a-f]{40}$/.test(inventory.buildSha) ||
    inventory.lineage.knownAppliedMigrations !== 106 ||
    inventory.lineage.decision !== "READY_0106" ||
    inventory.lineage.latestKnownAppliedTag !==
      AUDIT_SCHEMA_MIGRATIONS.predecessor.tag ||
    inventory.lineage.missingKnownToPredecessor !== 0 ||
    inventory.lineage.excludedMigration0100Present !== false ||
    inventory.lineage.opaqueLegacyMeaningInferred !== false ||
    (inventory.lineage.mode === "clean"
      ? inventory.lineage.opaqueLegacyRowCount !== 0
      : inventory.lineage.opaqueLegacyRowCount !== 2) ||
    inventory.lineage.knownAppliedRowsSha256 !==
      AUDIT_SCHEMA_KNOWN_ROWS_SHA256.predecessor ||
    inventory.lineage.opaqueLegacyRowsSha256 !==
      (inventory.lineage.mode === "clean"
        ? AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.clean
        : AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.productionCopyRestricted) ||
    inventory.schema.auditEventRows !== 0 ||
    inventory.schema.auditOutboxRows !== 0 ||
    inventory.schema.auditHeadRows !== 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(
      inventory.schema.expectedSchemaFingerprintSha256,
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(inventory.schema.schemaFingerprintSha256) ||
    !Number.isSafeInteger(inventory.backupEvidenceId) ||
    Number(inventory.backupEvidenceId) < 1 ||
    inventory.authorizesApplicationStart !== false
  ) {
    fail(
      "EXACT_0106_BACKUP_INVENTORY_INVALID",
      "The database must be exact isolated 0106 with the reviewed clean or two-row opaque lineage and no 0107 objects.",
    );
  }
  return Number(inventory.backupEvidenceId);
}

function validateCreatedBackup(
  row: CreatedBackupLog,
  previousBackupId: number,
): BackupSourceSnapshotEvidence {
  if (
    !Number.isSafeInteger(row.id) ||
    row.id <= previousBackupId ||
    row.status !== "success" ||
    !row.objectPath?.trim() ||
    boundedPayload(row.sizeBytes, "created backup sizeBytes") < 1 ||
    !/^[0-9a-f]{64}$/.test(row.sha256 ?? "") ||
    row.encryptionFormat !== "mve1" ||
    !row.encryptionKeyId?.trim()
  ) {
    fail(
      "EXACT_0106_BACKUP_CREATE_INVALID",
      "The new backup must be newer, successful, bounded, hashed and mve1-encrypted.",
    );
  }
  canonicalTimestamp(row.createdAt, "created backup createdAt");
  const source = row.sourceSnapshotEvidence;
  if (!source) {
    fail(
      "EXACT_0106_BACKUP_SOURCE_SNAPSHOT_MISSING",
      "The exact backup must expose counts from the same exported snapshot imported by pg_dump.",
    );
  }
  let canonical: BackupSourceSnapshotEvidence;
  try {
    canonical = canonicalBackupSourceSnapshotEvidence(source.tableCounts);
  } catch {
    fail(
      "EXACT_0106_BACKUP_SOURCE_SNAPSHOT_INVALID",
      "The exact backup source table-count evidence is invalid.",
    );
  }
  if (
    source.schemaVersion !== canonical.schemaVersion ||
    source.tableCountsSha256 !== canonical.tableCountsSha256 ||
    JSON.stringify(source.tableNames) !== JSON.stringify(canonical.tableNames)
  ) {
    fail(
      "EXACT_0106_BACKUP_SOURCE_SNAPSHOT_INVALID",
      "The exact backup source table-count evidence is not canonical.",
    );
  }
  return canonical;
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime()
  );
}

function validateRestoreResult(
  row: BackupLog,
  created: CreatedBackupLog,
  source: BackupSourceSnapshotEvidence,
) {
  const createdAt = canonicalTimestamp(
    row.createdAt,
    "restore result createdAt",
  );
  const restoreTestedAt = canonicalTimestamp(
    row.restoreTestedAt,
    "restore result restoreTestedAt",
  );
  const restoredSizeBytes = boundedPayload(
    row.sizeBytes,
    "restore result sizeBytes",
  );
  const restoreDurationMs = positiveInteger(
    row.restoreDurationMs,
    "restoreDurationMs",
  );
  const verifiedTables = row.restoreVerifiedTables;
  let restored: BackupSourceSnapshotEvidence | null = null;
  try {
    restored = canonicalBackupSourceSnapshotEvidence(verifiedTables ?? {});
  } catch {
    restored = null;
  }
  if (
    row.id !== created.id ||
    row.filename !== created.filename ||
    row.objectPath !== created.objectPath ||
    row.sizeBytes !== created.sizeBytes ||
    row.sha256 !== created.sha256 ||
    row.encryptionFormat !== created.encryptionFormat ||
    row.encryptionKeyId !== created.encryptionKeyId ||
    row.trigger !== created.trigger ||
    row.createdBy !== created.createdBy ||
    row.error !== created.error ||
    !sameTimestamp(row.createdAt, created.createdAt) ||
    row.status !== "success" ||
    row.restoreStatus !== "ok" ||
    row.restoreError !== null ||
    row.restoredAt !== null ||
    restoredSizeBytes < 1 ||
    restoreDurationMs < 1 ||
    !restored ||
    restored.tableCountsSha256 !== source.tableCountsSha256 ||
    JSON.stringify(restored.tableNames) !== JSON.stringify(source.tableNames) ||
    JSON.stringify(restored.tableCounts) !==
      JSON.stringify(source.tableCounts) ||
    restoreTestedAt < createdAt
  ) {
    fail(
      "EXACT_0106_BACKUP_RESTORE_INVALID",
      "The same backup id must pass a bounded non-destructive restore test with verified tables.",
    );
  }
  return { createdAt, restoreTestedAt, restored };
}

function backupRowBindingSha256(
  row: BackupLog,
  tableCountsSha256: string,
): string {
  return auditSchemaBackupRowBindingSha256({
    backupId: row.id,
    filename: row.filename,
    objectPath: row.objectPath ?? "",
    sizeBytes: Number(row.sizeBytes),
    encryptedBackupSha256: `sha256:${row.sha256}`,
    encryptionFormat: row.encryptionFormat as "mve1",
    encryptionKeyId: row.encryptionKeyId ?? "",
    status: row.status as "success",
    trigger: row.trigger as "manual",
    createdBy: row.createdBy as "staging-exact-0106-audit-backup",
    createdAt: canonicalTimestamp(row.createdAt, "bound backup createdAt"),
    restoreTestedAt: canonicalTimestamp(
      row.restoreTestedAt,
      "bound backup restoreTestedAt",
    ),
    restoreDurationMs: Number(row.restoreDurationMs),
    restoreStatus: row.restoreStatus as "ok",
    verifiedTableCountsSha256: tableCountsSha256,
  });
}

export interface StagingExact0106BackupDependencies {
  readEnvironment?: typeof readAuditSchemaInventoryEnvironment;
  inventory?: typeof runAuditSchemaInventory;
  create?: typeof createBackup;
  restoreTest?: typeof testBackupRestore;
  readBackup?: typeof getBackup;
}

export async function runStagingExact0106Backup(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StagingExact0106BackupDependencies = {},
) {
  validateBoundary(env);
  const config: AuditSchemaEnvironment = (
    dependencies.readEnvironment ?? readAuditSchemaInventoryEnvironment
  )(env);
  const before = await (dependencies.inventory ?? runAuditSchemaInventory)(
    config,
  );
  const previousBackupId = validateInventory(before);
  const created = await (dependencies.create ?? createBackup)({
    trigger: "manual",
    actor: "staging-exact-0106-audit-backup",
    skipRetentionPrune: true,
    maxPayloadBytes: STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
    captureSourceSnapshotTableCounts: true,
  });
  const sourceSnapshot = validateCreatedBackup(created, previousBackupId);
  const restored = await (dependencies.restoreTest ?? testBackupRestore)(
    created.id,
    {
      maxPayloadBytes: STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
      expectedSourceSnapshotEvidence: sourceSnapshot,
    },
  );
  const timestamps = validateRestoreResult(restored, created, sourceSnapshot);
  const after = await (dependencies.inventory ?? runAuditSchemaInventory)({
    ...config,
    backupEvidenceId: restored.id,
  });
  if (validateInventory(after) !== restored.id) {
    fail(
      "EXACT_0106_BACKUP_POSTCHECK_INVALID",
      "The exact-0106 postcheck did not observe the new restore-tested backup.",
    );
  }
  const immutableRow = await (dependencies.readBackup ?? getBackup)(
    restored.id,
  );
  if (!immutableRow) {
    fail(
      "EXACT_0106_BACKUP_ROW_MISSING",
      "The restore-tested backup row disappeared before evidence freeze.",
    );
  }
  const frozen = validateRestoreResult(immutableRow, created, sourceSnapshot);
  const tableCountsSha256 = sourceSnapshot.tableCountsSha256;
  const rowBindingSha256 = backupRowBindingSha256(
    immutableRow,
    tableCountsSha256,
  );
  if (
    !after.backupIntegrity ||
    after.backupIntegrity.verifiedTableCountsSha256 !== tableCountsSha256 ||
    after.backupIntegrity.backupRowBindingSha256 !== rowBindingSha256 ||
    JSON.stringify(after.backupIntegrity.verifiedTableNames) !==
      JSON.stringify(sourceSnapshot.tableNames) ||
    JSON.stringify(after.backupIntegrity.verifiedTableCounts) !==
      JSON.stringify(sourceSnapshot.tableCounts)
  ) {
    fail(
      "EXACT_0106_BACKUP_POSTCHECK_INVALID",
      "The audit inventory did not reproduce the frozen table-count and backup-row binding.",
    );
  }
  return Object.freeze({
    schemaVersion: "site-logbook.audit-schema-exact-0106-backup/v1" as const,
    kind: "audit-schema-exact-0106-backup" as const,
    decision: "CREATED_AND_RESTORE_VERIFIED" as const,
    environmentId: after.environmentId,
    databaseName: after.databaseName,
    databaseUser: after.databaseUser,
    buildSha: after.buildSha,
    lineage: after.lineage,
    expectedMigrations: 106 as const,
    latestExpectedTag: AUDIT_SCHEMA_MIGRATIONS.predecessor.tag,
    previousBackupId,
    backupId: restored.id,
    createdAt: timestamps.createdAt,
    restoreTestedAt: timestamps.restoreTestedAt,
    restoreDurationMs: positiveInteger(
      restored.restoreDurationMs,
      "restoreDurationMs",
    ),
    verifiedTableCount: sourceSnapshot.tableNames.length,
    verifiedTableNames: sourceSnapshot.tableNames,
    sourceTableCounts: sourceSnapshot.tableCounts,
    restoredTableCounts: frozen.restored.tableCounts,
    verifiedTableCountsSha256: tableCountsSha256,
    sizeBytes: boundedPayload(restored.sizeBytes, "sizeBytes"),
    maxPayloadBytes: STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
    encryptedBackupSha256: `sha256:${restored.sha256}`,
    backupRowBindingSha256: rowBindingSha256,
    encryptionFormat: "mve1" as const,
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "audit-0107-transition-binding-required" as const,
    authorizes0107: false,
    authorizesApplicationStart: false,
  });
}

async function main(): Promise<void> {
  const summary = await runStagingExact0106Backup();
  process.stdout.write(
    `[audit-schema-exact-0106-backup] PASS ${JSON.stringify(summary)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const failure =
      error instanceof StagingExact0106BackupError ||
      error instanceof ExternalSchemaPreflightError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[audit-schema-exact-0106-backup] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
