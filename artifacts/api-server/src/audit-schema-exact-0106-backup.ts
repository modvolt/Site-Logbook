import type { BackupLog } from "@workspace/db";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  AUDIT_SCHEMA_OPAQUE_ROWS_SHA256,
  readAuditSchemaInventoryEnvironment,
  runAuditSchemaInventory,
  type AuditSchemaEnvironment,
  type AuditSchemaInventorySummary,
} from "@workspace/db/audit-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";
import { fileURLToPath } from "node:url";
import { createBackup, testBackupRestore } from "./lib/backup";

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

function validateCreatedBackup(row: BackupLog, previousBackupId: number): void {
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
}

function validateRestoreResult(row: BackupLog, backupId: number) {
  const createdAt = canonicalTimestamp(
    row.createdAt,
    "restore result createdAt",
  );
  const restoreTestedAt = canonicalTimestamp(
    row.restoreTestedAt,
    "restore result restoreTestedAt",
  );
  const verifiedTables = row.restoreVerifiedTables;
  if (
    row.id !== backupId ||
    row.status !== "success" ||
    row.restoreStatus !== "ok" ||
    row.restoredAt !== null ||
    boundedPayload(row.sizeBytes, "restore result sizeBytes") < 1 ||
    positiveInteger(row.restoreDurationMs, "restoreDurationMs") < 1 ||
    !verifiedTables ||
    typeof verifiedTables !== "object" ||
    Array.isArray(verifiedTables) ||
    Object.keys(verifiedTables).length === 0 ||
    Object.entries(verifiedTables).some(
      ([name, count]) =>
        !/^[a-z][a-z0-9_]*$/.test(name) ||
        !Number.isSafeInteger(count) ||
        Number(count) < 0,
    ) ||
    restoreTestedAt < createdAt
  ) {
    fail(
      "EXACT_0106_BACKUP_RESTORE_INVALID",
      "The same backup id must pass a bounded non-destructive restore test with verified tables.",
    );
  }
  return { createdAt, restoreTestedAt };
}

export interface StagingExact0106BackupDependencies {
  readEnvironment?: typeof readAuditSchemaInventoryEnvironment;
  inventory?: typeof runAuditSchemaInventory;
  create?: typeof createBackup;
  restoreTest?: typeof testBackupRestore;
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
  });
  validateCreatedBackup(created, previousBackupId);
  const restored = await (dependencies.restoreTest ?? testBackupRestore)(
    created.id,
    {
      maxPayloadBytes: STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
    },
  );
  const timestamps = validateRestoreResult(restored, created.id);
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
    verifiedTableCount: Object.keys(restored.restoreVerifiedTables ?? {})
      .length,
    sizeBytes: boundedPayload(restored.sizeBytes, "sizeBytes"),
    maxPayloadBytes: STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
    encryptedBackupSha256: `sha256:${restored.sha256}`,
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
