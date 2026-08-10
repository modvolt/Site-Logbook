import type { BackupLog } from "@workspace/db";
import { fileURLToPath } from "node:url";
import {
  ExternalSchemaPreflightError,
  readExternalSchemaInventoryEnvironment,
  runExternalSchemaInventory,
  type ExternalSchemaInventorySummary,
} from "@workspace/db/external-schema-preflight";
import { createBackup, testBackupRestore } from "./lib/backup";

export const STAGING_EXACT_0104_BACKUP_ACTION = "create-exact-0104-backup";
export const STAGING_EXACT_0104_BACKUP_CONFIRMATION =
  "CREATE_FRESH_EXACT_0104_STAGING_BACKUP_AND_RESTORE_TEST";
export const STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const SHA40 = /^[0-9a-f]{40}$/;
const LATEST_0104 = "0104_thin_sheva_callister";

export class StagingExact0104BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StagingExact0104BackupError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StagingExact0104BackupError(code, message);
}

function canonicalTimestamp(value: Date | null, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "EXACT_0104_BACKUP_RESULT_INVALID",
      `${field} must be a valid timestamp.`,
    );
  }
  return value.toISOString();
}

function positiveInteger(value: number | null, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("EXACT_0104_BACKUP_RESULT_INVALID", `${field} must be positive.`);
  }
  return Number(value);
}

function validateBoundary(env: NodeJS.ProcessEnv): void {
  if (
    env.STAGING_EXACT_0104_BACKUP_ACTION !== STAGING_EXACT_0104_BACKUP_ACTION ||
    env.STAGING_EXACT_0104_BACKUP_CONFIRMATION !==
      STAGING_EXACT_0104_BACKUP_CONFIRMATION
  ) {
    fail(
      "EXACT_0104_BACKUP_CONFIRMATION_INVALID",
      "The exact isolated staging backup action and confirmation are required.",
    );
  }
  if (
    env.STAGING_SCHEMA_ACTION !== "inspect" ||
    (env.STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    env.STAGING_EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.BACKUP_ENABLED !== "true"
  ) {
    fail(
      "EXACT_0104_BACKUP_BOUNDARY_UNSAFE",
      "The creator requires inspect mode, an empty 0105 confirmation, dark external accounts and enabled staging backups.",
    );
  }
}

function validateInventory(inventory: ExternalSchemaInventorySummary): number {
  if (
    inventory.decision !== "READY_0104" ||
    inventory.environmentId !== "site-logbook-staging" ||
    inventory.databaseName !== "site_logbook_staging" ||
    inventory.databaseUser !== "site_logbook_staging" ||
    !SHA40.test(inventory.buildSha) ||
    inventory.appliedMigrations !== 104 ||
    inventory.predecessorMigrations !== 104 ||
    inventory.latestAppliedTag !== LATEST_0104 ||
    inventory.missingToPredecessor !== 0 ||
    !Number.isSafeInteger(inventory.backupEvidenceId) ||
    Number(inventory.backupEvidenceId) < 1
  ) {
    fail(
      "EXACT_0104_BACKUP_INVENTORY_INVALID",
      "The live database must be the exact isolated 0104 staging state.",
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
    positiveInteger(row.sizeBytes, "created backup sizeBytes") < 1 ||
    !/^[0-9a-f]{64}$/.test(row.sha256 ?? "") ||
    row.encryptionFormat !== "mve1" ||
    !row.encryptionKeyId?.trim()
  ) {
    fail(
      "EXACT_0104_BACKUP_CREATE_INVALID",
      "The new backup must be newer, successful, nonempty, hashed and mve1-encrypted.",
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
    positiveInteger(row.restoreDurationMs, "restoreDurationMs") < 1 ||
    !verifiedTables ||
    typeof verifiedTables !== "object" ||
    Array.isArray(verifiedTables) ||
    Object.keys(verifiedTables).length === 0 ||
    Object.entries(verifiedTables).some(
      ([name, count]) =>
        !/^[a-z][a-z0-9_]*$/.test(name) ||
        !Number.isSafeInteger(count) ||
        count < 0,
    ) ||
    restoreTestedAt < createdAt
  ) {
    fail(
      "EXACT_0104_BACKUP_RESTORE_INVALID",
      "The same new backup id must pass a non-destructive restore test with verified tables.",
    );
  }
  return { createdAt, restoreTestedAt };
}

export interface StagingExact0104BackupDependencies {
  readEnvironment?: typeof readExternalSchemaInventoryEnvironment;
  inventory?: typeof runExternalSchemaInventory;
  create?: typeof createBackup;
  restoreTest?: typeof testBackupRestore;
}

export async function runStagingExact0104Backup(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StagingExact0104BackupDependencies = {},
) {
  validateBoundary(env);
  const config = (
    dependencies.readEnvironment ?? readExternalSchemaInventoryEnvironment
  )(env);
  const inventory = await (
    dependencies.inventory ?? runExternalSchemaInventory
  )(config);
  const previousBackupId = validateInventory(inventory);
  const created = await (dependencies.create ?? createBackup)({
    trigger: "manual",
    actor: "staging-exact-0104-backup",
    skipRetentionPrune: true,
    maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
  });
  validateCreatedBackup(created, previousBackupId);
  const restored = await (dependencies.restoreTest ?? testBackupRestore)(
    created.id,
    { maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES },
  );
  const timestamps = validateRestoreResult(restored, created.id);
  const postInventory = await (
    dependencies.inventory ?? runExternalSchemaInventory
  )({
    ...config,
    backupEvidenceId: restored.id,
  });
  const observedNewBackupId = validateInventory(postInventory);
  if (observedNewBackupId !== restored.id) {
    fail(
      "EXACT_0104_BACKUP_POSTCHECK_INVALID",
      "The exact-0104 postcheck did not observe the new restore-tested backup as newest.",
    );
  }

  return Object.freeze({
    decision: "CREATED_AND_RESTORE_VERIFIED" as const,
    environmentId: postInventory.environmentId,
    databaseName: postInventory.databaseName,
    databaseUser: postInventory.databaseUser,
    buildSha: postInventory.buildSha,
    expectedMigrations: 104,
    latestExpectedTag: LATEST_0104,
    excludedMigration0100Present: false,
    excludedMigration0105Present: false,
    externalStateRows: 0,
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
    sizeBytes: positiveInteger(restored.sizeBytes, "sizeBytes"),
    maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
    encryptionFormat: "mve1" as const,
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "exact-0104-recovery-binding-required" as const,
    authorizes0105: false,
  });
}

async function main(): Promise<void> {
  const summary = await runStagingExact0104Backup();
  process.stdout.write(
    `[staging-exact-0104-backup] PASS ${JSON.stringify(summary)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const failure =
      error instanceof StagingExact0104BackupError ||
      error instanceof ExternalSchemaPreflightError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-exact-0104-backup] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
