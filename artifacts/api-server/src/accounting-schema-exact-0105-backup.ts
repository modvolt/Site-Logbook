import type { BackupLog } from "@workspace/db";
import {
  readAccountingSchemaInventoryEnvironment,
  runAccountingSchemaInventory,
  type AccountingSchemaEnvironment,
  type AccountingSchemaInventorySummary,
} from "@workspace/db/accounting-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";
import { fileURLToPath } from "node:url";
import { createBackup, testBackupRestore } from "./lib/backup";

export const STAGING_EXACT_0105_BACKUP_ACTION =
  "create-exact-0105-accounting-backup";
export const STAGING_EXACT_0105_BACKUP_CONFIRMATION =
  "CREATE_FRESH_EXACT_0105_STAGING_BACKUP_AND_RESTORE_TEST_NO_0106";
export const STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const SHA40 = /^[0-9a-f]{40}$/;
const LATEST_0105 = "0105_smooth_nitro";

export class StagingExact0105BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StagingExact0105BackupError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StagingExact0105BackupError(code, message);
}

function canonicalTimestamp(value: Date | null, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "EXACT_0105_BACKUP_RESULT_INVALID",
      `${field} must be a valid timestamp.`,
    );
  }
  return value.toISOString();
}

function positiveInteger(value: number | null, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("EXACT_0105_BACKUP_RESULT_INVALID", `${field} must be positive.`);
  }
  return Number(value);
}

function boundedPayload(value: number | null, field: string): number {
  const size = positiveInteger(value, field);
  if (size > STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES) {
    fail(
      "EXACT_0105_BACKUP_PAYLOAD_TOO_LARGE",
      `${field} exceeds the approved 256 MiB ceiling.`,
    );
  }
  return size;
}

function validateBoundary(env: NodeJS.ProcessEnv): void {
  if (
    env.STAGING_EXACT_0105_BACKUP_ACTION !== STAGING_EXACT_0105_BACKUP_ACTION ||
    env.STAGING_EXACT_0105_BACKUP_CONFIRMATION !==
      STAGING_EXACT_0105_BACKUP_CONFIRMATION
  ) {
    fail(
      "EXACT_0105_BACKUP_CONFIRMATION_INVALID",
      "The exact isolated 0105 backup action and confirmation are required.",
    );
  }
  if (
    env.STAGING_SCHEMA_ACTION !== "inspect" ||
    (env.STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    (env.ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    env.STAGING_EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.BACKUP_ENABLED !== "true"
  ) {
    fail(
      "EXACT_0105_BACKUP_BOUNDARY_UNSAFE",
      "The creator requires inspect mode, empty migration confirmations, dark external accounts and enabled staging backups.",
    );
  }
}

function validateInventory(
  inventory: AccountingSchemaInventorySummary,
): number {
  if (
    inventory.decision !== "READY_0105" ||
    inventory.environmentId !== "site-logbook-staging" ||
    inventory.databaseName !== "site_logbook_staging" ||
    inventory.databaseUser !== "site_logbook_staging" ||
    !SHA40.test(inventory.buildSha) ||
    inventory.appliedMigrations !== 105 ||
    inventory.predecessorMigrations !== 105 ||
    inventory.latestAppliedTag !== LATEST_0105 ||
    inventory.missingToPredecessor !== 0 ||
    inventory.externalStateRows !== 0 ||
    !Number.isSafeInteger(inventory.backupEvidenceId) ||
    Number(inventory.backupEvidenceId) < 1
  ) {
    fail(
      "EXACT_0105_BACKUP_INVENTORY_INVALID",
      "The live database must be the exact isolated 0105 state with no 0106 accounting objects or external state.",
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
      "EXACT_0105_BACKUP_CREATE_INVALID",
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
      "EXACT_0105_BACKUP_RESTORE_INVALID",
      "The same new backup id must pass a bounded non-destructive restore test with verified tables.",
    );
  }
  return { createdAt, restoreTestedAt };
}

export interface StagingExact0105BackupDependencies {
  readEnvironment?: typeof readAccountingSchemaInventoryEnvironment;
  inventory?: typeof runAccountingSchemaInventory;
  create?: typeof createBackup;
  restoreTest?: typeof testBackupRestore;
}

export async function runStagingExact0105Backup(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StagingExact0105BackupDependencies = {},
) {
  validateBoundary(env);
  const config: AccountingSchemaEnvironment = (
    dependencies.readEnvironment ?? readAccountingSchemaInventoryEnvironment
  )(env);
  const inventory = await (
    dependencies.inventory ?? runAccountingSchemaInventory
  )(config);
  const previousBackupId = validateInventory(inventory);
  const created = await (dependencies.create ?? createBackup)({
    trigger: "manual",
    actor: "staging-exact-0105-accounting-backup",
    skipRetentionPrune: true,
    maxPayloadBytes: STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
  });
  validateCreatedBackup(created, previousBackupId);
  const restored = await (dependencies.restoreTest ?? testBackupRestore)(
    created.id,
    { maxPayloadBytes: STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES },
  );
  const timestamps = validateRestoreResult(restored, created.id);
  const postInventory = await (
    dependencies.inventory ?? runAccountingSchemaInventory
  )({
    ...config,
    backupEvidenceId: restored.id,
  });
  const observedNewBackupId = validateInventory(postInventory);
  if (observedNewBackupId !== restored.id) {
    fail(
      "EXACT_0105_BACKUP_POSTCHECK_INVALID",
      "The exact-0105 postcheck did not observe the new restore-tested backup as newest.",
    );
  }

  return Object.freeze({
    decision: "CREATED_AND_RESTORE_VERIFIED" as const,
    environmentId: postInventory.environmentId,
    databaseName: postInventory.databaseName,
    databaseUser: postInventory.databaseUser,
    buildSha: postInventory.buildSha,
    expectedMigrations: 105 as const,
    latestExpectedTag: LATEST_0105,
    excludedMigration0100Present: false,
    excludedMigration0106Present: false,
    accountingEvidenceRows: 0,
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
    sizeBytes: boundedPayload(restored.sizeBytes, "sizeBytes"),
    maxPayloadBytes: STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
    encryptionFormat: "mve1" as const,
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "accounting-0106-transition-binding-required" as const,
    authorizes0106: false,
  });
}

async function main(): Promise<void> {
  const summary = await runStagingExact0105Backup();
  process.stdout.write(
    `[staging-exact-0105-backup] PASS ${JSON.stringify(summary)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const failure =
      error instanceof StagingExact0105BackupError ||
      error instanceof ExternalSchemaPreflightError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-exact-0105-backup] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
