import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  canonicalBackupSourceSnapshotEvidence,
  getBackup,
  readBackupSnapshotTableCounts,
  restoreBackup,
  sealApplicationDatabasePoolForProductionRestore,
} from "./lib/backup";
import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";
import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_DATABASE_USER,
} from "./lib/production-runtime-database";
import type { BackupLog } from "@workspace/db";
import {
  normalizeProductionMigrationRoleProjection,
  parseProductionMigrationRolePrecondition,
} from "../../../lib/db/src/production-migration-role-authority";
import {
  PRODUCTION_ROLE_PROJECTION_SQL,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  validateProductionRoleProjection,
} from "../../../lib/db/src/production-role-separation-contract";

// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as migrationContract from "../../../scripts/production-evidence/production-migration-contract.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as invoice0108Contract from "../../../scripts/production-evidence/production-invoice-0108-contract.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as invoice0108Pg from "../../../scripts/production-evidence/production-invoice-0108-pg-adapter.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as backupAuthorityModule from "../../../scripts/production-evidence/production-exact-0107-backup-authority.mjs";
// @ts-ignore -- bundled from the source-reviewed repository evidence tree.
import * as stoppedWritersContract from "../../../scripts/production-evidence/production-exact-0096-backup-contract.mjs";

const {
  loadProductionInvoice0108Catalog,
  parseProductionInvoice0108InventoryRows,
} = invoice0108Pg;
const {
  validateProductionInvoice0108Inventory,
  PRODUCTION_INVOICE_0108_PRE_STATE,
} = invoice0108Contract;
const { createProductionMigrationArtifact } = migrationContract;
const { PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY } = invoice0108Contract;
const { canonicalProductionExact0096BackupJson, validateStoppedWritersProof } =
  stoppedWritersContract;
const { createProductionInvoice0108BackupAuthority } = backupAuthorityModule;

export const PRODUCTION_EXACT_0107_RESTORE_INSPECT_ACTION =
  "VERIFY_EXACT_0107_MVE1_RESTORE_INPUTS_NO_MUTATION" as const;
export const PRODUCTION_EXACT_0107_RESTORE_INSPECT_CONFIRMATION =
  "VERIFY_EXACT_0107_MVE1_RESTORE_INPUTS_NO_MUTATION" as const;
export const PRODUCTION_EXACT_0107_RESTORE_ACTION =
  "RESTORE_EXACT_0107_MVE1_BACKUP_AFTER_AMBIGUOUS_0108_OUTCOME" as const;
export const PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION =
  "ATTENDED_RESTORE_EXACT_0107_MVE1_BACKUP_NO_APPLICATION_START" as const;
export const PRODUCTION_EXACT_0107_RESTORE_INTENT_SCHEMA =
  "site-logbook.production-exact-0107-attended-restore-intent/v1" as const;
export const PRODUCTION_EXACT_0107_RESTORE_RECEIPT_SCHEMA =
  "site-logbook.production-exact-0107-attended-restore-receipt/v1" as const;
export const PRODUCTION_EXACT_0107_RESTORE_MIGRATOR_ROLE =
  PRODUCTION_MIGRATOR_DATABASE_USER;
export const PRODUCTION_EXACT_0107_RESTORE_RUNTIME_ROLE =
  PRODUCTION_RUNTIME_DATABASE_USER;

const INTENT_BASENAME = "exact-0107-attended-production-restore-intent.json";
const RECEIPT_BASENAME = "exact-0107-attended-production-restore-receipt.json";
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_APPROVAL_AGE_MS = 15 * 60 * 1000;
const RESTORE_REASONS = new Set([
  "RESTORE_REQUIRED_0108_MIGRATION_COMMIT_OUTCOME_UNKNOWN",
  "RESTORE_REQUIRED_0108_MIGRATION_RECEIPT_CUSTODY",
  "RESTORE_REQUIRED_0108_ROLE_COMMIT_OUTCOME_UNKNOWN",
  "RESTORE_REQUIRED_0108_ROLE_RECEIPT_CUSTODY",
]);

type Inventory = Readonly<Record<string, unknown>>;
type WritersObservation = Readonly<{
  observedAt: string;
  runtimeRole: string;
  otherClientSessions: 0;
}>;

export type ProductionExact0107RestoreConfig = Readonly<{
  mode: "inspect" | "restore";
  sourceSha: string;
  migrationsDirectory: string;
  evidenceDirectory: string;
  backupReceiptCanonical: string;
  backupReferenceCanonical: string;
  rolePreconditionCanonical: string;
  stoppedWritersProofCanonical: string;
  backupId: number;
  databaseName: string;
  sessionUser: string;
  migratorRole: string;
  runtimeRole: string;
  reason: string;
  approvedAt?: string;
}>;

export interface ProductionExact0107RestoreDependencies {
  withMigrationLock<T>(
    operation: (lockBackendPid: number) => Promise<T>,
  ): Promise<T>;
  readInventory(): Promise<Inventory>;
  assertWritersStopped(lockBackendPid: number): Promise<WritersObservation>;
  readBackup(id: number): Promise<BackupLog | undefined>;
  sealApplicationDatabasePool(): Promise<void>;
  restore(
    id: number,
    options: {
      restoreRole: string;
      preRestoreCleanup: "invoice-0108";
      verifiedBackup: BackupLog;
      updateBackupLogAfterRestore: false;
      runtimeRole: string;
    },
  ): Promise<void>;
  readPostRestoreTableCountsSha256(): Promise<string>;
  readPostRestoreRoleProjectionCanonical(): Promise<string>;
  persistExclusive(basename: string, canonical: string): Promise<void>;
  now(): Date;
}

export class ProductionExact0107RestoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionExact0107RestoreError";
  }
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new ProductionExact0107RestoreError(code, message, options);
}

function exactTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string")
    fail("PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID", `${field} is invalid.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID", `${field} is invalid.`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function exactWriters(
  value: WritersObservation,
  runtimeRole: string,
): WritersObservation {
  if (value.runtimeRole !== runtimeRole || value.otherClientSessions !== 0) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_WRITERS_RUNNING",
      "Another client session is active or cannot be excluded by backend identity.",
    );
  }
  exactTimestamp(value.observedAt, "writers.observedAt");
  return value;
}

function exactBackupRow(
  row: BackupLog | undefined,
  receipt: Record<string, unknown>,
  id: number,
): BackupLog {
  const restoredCounts = row?.restoreVerifiedTables;
  let restoredCountsSha256 = "";
  try {
    restoredCountsSha256 = canonicalBackupSourceSnapshotEvidence(
      restoredCounts as Record<string, number>,
    ).tableCountsSha256;
  } catch {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_BACKUP_INVALID",
      "Backup row has no canonical disposable-restore table counts.",
    );
  }
  if (
    !row ||
    row.id !== id ||
    row.status !== "success" ||
    row.trigger !== "manual" ||
    row.createdBy !== "production-exact-0107-invoice-backup" ||
    row.objectPath !== `/${String(receipt.backupArtifactStorageId)}` ||
    `sha256:${row.sha256}` !== receipt.backupArtifactSha256 ||
    row.sizeBytes !== receipt.backupArtifactBytes ||
    row.encryptionFormat !== "mve1" ||
    row.encryptionKeyId === null ||
    row.restoreStatus !== "ok" ||
    row.restoreError !== null ||
    row.restoreTestedAt?.toISOString() !== receipt.restoreVerifiedAt ||
    restoredCountsSha256 !== receipt.sourceTableCountsSha256 ||
    row.restoredAt !== null
  ) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_BACKUP_INVALID",
      "Backup row differs from the source-bound mve1 receipt or was already restored.",
    );
  }
  return row;
}

export async function runProductionExact0107Restore(
  config: ProductionExact0107RestoreConfig,
  dependencies: ProductionExact0107RestoreDependencies,
) {
  return dependencies.withMigrationLock(async (lockBackendPid) => {
    if (
      !["inspect", "restore"].includes(config.mode) ||
      !SOURCE_SHA.test(config.sourceSha) ||
      !RESTORE_REASONS.has(config.reason) ||
      !Number.isSafeInteger(config.backupId) ||
      config.backupId < 1
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID",
        "Source or recovery reason is not reviewed.",
      );
    }
    exactIdentifier(config.databaseName, "databaseName");
    exactIdentifier(config.sessionUser, "sessionUser");
    exactIdentifier(config.migratorRole, "migratorRole");
    exactIdentifier(config.runtimeRole, "runtimeRole");
    let rolePrecondition;
    let stoppedWritersProof: Record<string, unknown>;
    try {
      rolePrecondition = parseProductionMigrationRolePrecondition(
        config.rolePreconditionCanonical,
        {
          sourceSha: config.sourceSha,
          database: {
            name: config.databaseName,
            currentUser: config.migratorRole,
            sessionUser: config.sessionUser,
          },
        },
      );
      const parsedProof = JSON.parse(config.stoppedWritersProofCanonical);
      stoppedWritersProof = validateStoppedWritersProof(
        parsedProof,
        "restore.stoppedWritersProof",
      );
      if (
        canonicalProductionExact0096BackupJson(stoppedWritersProof) !==
        config.stoppedWritersProofCanonical
      ) {
        throw new Error("non-canonical stopped-writers proof");
      }
    } catch (error) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_AUTHORITY_INVALID",
        "Role precondition or stopped-writers authority is invalid.",
        { cause: error },
      );
    }
    if (
      rolePrecondition.value.migrationRole !==
        PRODUCTION_EXACT_0107_RESTORE_MIGRATOR_ROLE ||
      rolePrecondition.value.runtimeRole !==
        PRODUCTION_EXACT_0107_RESTORE_RUNTIME_ROLE ||
      stoppedWritersProof.sourceSha !== config.sourceSha
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_IDENTITY_BINDING_INVALID",
        "Database, role, or maintenance authority differs from the source-pinned binding.",
      );
    }
    const backupAuthority = createProductionInvoice0108BackupAuthority({
      expectedRuntimeRole: config.runtimeRole,
      loadReceiptCanonical: async () => config.backupReceiptCanonical,
    });
    const receipt =
      await backupAuthority.assertFreshExact0107BackupRestoreReceipt({
        referenceCanonical: config.backupReferenceCanonical,
        at: undefined,
        expectedInventorySha256:
          PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
      });
    if (receipt.value.sourceSha !== config.sourceSha) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_SOURCE_MISMATCH",
        "Backup receipt source differs from the immutable restore runner.",
      );
    }
    const backup = exactBackupRow(
      await dependencies.readBackup(config.backupId),
      receipt.value,
      config.backupId,
    );
    await dependencies.sealApplicationDatabasePool();
    const beforeWriters = exactWriters(
      await dependencies.assertWritersStopped(lockBackendPid),
      config.runtimeRole,
    );
    const before = validateProductionInvoice0108Inventory(
      await dependencies.readInventory(),
      "either",
    );
    const authorityNow = dependencies.now();
    const writersObservedAt = new Date(
      exactTimestamp(
        stoppedWritersProof.observedAt,
        "stoppedWritersProof.observedAt",
      ),
    ).getTime();
    if (
      writersObservedAt > authorityNow.getTime() + 60_000 ||
      authorityNow.getTime() - writersObservedAt > MAX_APPROVAL_AGE_MS
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_APPROVAL_STALE",
        "Stopped-writers authority is not current.",
      );
    }
    if (config.mode === "inspect") {
      return Object.freeze({
        decision:
          before.phase === "post"
            ? "RESTORE_REQUIRED_EXACT_0108_OBSERVED"
            : "RESTORE_NOT_REQUIRED_EXACT_0107_OBSERVED",
        sourceSha: config.sourceSha,
        backupId: backup.id,
        backupReceiptSha256: receipt.artifact.sha256,
        backupReferenceSha256: sha256(config.backupReferenceCanonical),
        observedPhase: before.phase,
        restoreRequired: before.phase === "post",
        authorizesProductionRestore: false,
        productionRestorePerformed: false,
        authorizesApplicationStart: false,
      });
    }
    if (before.phase !== "post") {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_NOT_REQUIRED",
        "Live inventory is already exact-0107; destructive restore is forbidden.",
      );
    }
    const approvedAt = exactTimestamp(config.approvedAt, "approvedAt");
    const approvalTime = new Date(approvedAt).getTime();
    const intentNow = authorityNow;
    if (
      approvalTime > intentNow.getTime() + 60_000 ||
      intentNow.getTime() - approvalTime > MAX_APPROVAL_AGE_MS
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_APPROVAL_STALE",
        "Attended approval is not current.",
      );
    }
    const intent = createProductionMigrationArtifact({
      schemaVersion: PRODUCTION_EXACT_0107_RESTORE_INTENT_SCHEMA,
      kind: "site-logbook-production-exact-0107-attended-restore-intent",
      decision: "RESTORE",
      action: PRODUCTION_EXACT_0107_RESTORE_ACTION,
      confirmation: PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION,
      reason: config.reason,
      sourceSha: config.sourceSha,
      databaseName: config.databaseName,
      sessionUser: config.sessionUser,
      migratorRole: config.migratorRole,
      runtimeRole: config.runtimeRole,
      backupId: backup.id,
      backupReceiptSha256: receipt.artifact.sha256,
      backupReferenceSha256: sha256(config.backupReferenceCanonical),
      rolePreconditionSha256: rolePrecondition.sha256,
      stoppedWritersProofSha256: sha256(config.stoppedWritersProofCanonical),
      preRestoreInventory: before.value,
      approvedAt,
      writersStoppedBeforeAt: beforeWriters.observedAt,
      executionDefault: "disabled",
      authorizesProductionRestore: true,
      authorizesApplicationStart: false,
    });
    await dependencies.persistExclusive(INTENT_BASENAME, intent.canonical);

    const restoreStartedAt = dependencies.now().toISOString();
    try {
      await dependencies.restore(backup.id, {
        restoreRole: config.migratorRole,
        preRestoreCleanup: "invoice-0108",
        verifiedBackup: backup,
        updateBackupLogAfterRestore: false,
        runtimeRole: config.runtimeRole,
      });
    } catch (error) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_OUTCOME_REVIEW_REQUIRED",
        "Restore process failed after durable intent; do not retry without manual state review.",
        { cause: error },
      );
    }
    const restoreCompletedAt = dependencies.now().toISOString();
    let after;
    let tableCountsSha256;
    let roleProjectionCanonical;
    try {
      after = validateProductionInvoice0108Inventory(
        await dependencies.readInventory(),
        "pre",
      );
      tableCountsSha256 = await dependencies.readPostRestoreTableCountsSha256();
      if (
        !DIGEST.test(tableCountsSha256) ||
        tableCountsSha256 !== receipt.value.sourceTableCountsSha256
      ) {
        fail(
          "PRODUCTION_EXACT_0107_RESTORE_TABLE_COUNTS_INVALID",
          "Restored all-table count digest differs from the backup source snapshot.",
        );
      }
      roleProjectionCanonical =
        await dependencies.readPostRestoreRoleProjectionCanonical();
    } catch (error) {
      if (error instanceof ProductionExact0107RestoreError) throw error;
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_POST_STATE_INVALID",
        "Production was restored but exact post-restore evidence is unavailable; do not retry.",
        { cause: error },
      );
    }
    const afterWriters = exactWriters(
      await dependencies.assertWritersStopped(lockBackendPid),
      config.runtimeRole,
    );
    const output = createProductionMigrationArtifact({
      schemaVersion: PRODUCTION_EXACT_0107_RESTORE_RECEIPT_SCHEMA,
      kind: "site-logbook-production-exact-0107-attended-restore-receipt",
      decision: "PASS",
      intentSha256: intent.sha256,
      reason: config.reason,
      sourceSha: config.sourceSha,
      databaseName: config.databaseName,
      sessionUser: config.sessionUser,
      migratorRole: config.migratorRole,
      runtimeRole: config.runtimeRole,
      backupId: backup.id,
      backupArtifactStorageId: receipt.value.backupArtifactStorageId,
      backupArtifactSha256: receipt.value.backupArtifactSha256,
      backupReceiptSha256: receipt.artifact.sha256,
      backupReferenceSha256: sha256(config.backupReferenceCanonical),
      rolePreconditionSha256: rolePrecondition.sha256,
      stoppedWritersProofSha256: sha256(config.stoppedWritersProofCanonical),
      preRestoreInventory: before.value,
      postRestoreInventory: after.value,
      expectedTableCountsSha256: receipt.value.sourceTableCountsSha256,
      postRestoreTableCountsSha256: tableCountsSha256,
      postRestoreRoleProjectionSha256: sha256(roleProjectionCanonical),
      restoreStartedAt,
      restoreCompletedAt,
      writersStoppedBeforeAt: beforeWriters.observedAt,
      writersStoppedAfterAt: afterWriters.observedAt,
      productionRestorePerformed: true,
      authorizesMigrationRetry: false,
      authorizesApplicationStart: false,
    });
    try {
      await dependencies.persistExclusive(RECEIPT_BASENAME, output.canonical);
    } catch (error) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_RECEIPT_CUSTODY_FAILED",
        "Production was restored but the no-clobber receipt is not durable; do not retry.",
        { cause: error },
      );
    }
    return Object.freeze({
      decision: "EXACT_0107_PRODUCTION_RESTORE_RECEIPT_DURABLE",
      receiptStorageId: RECEIPT_BASENAME,
      receiptSha256: output.sha256,
      productionRestorePerformed: true,
      authorizesMigrationRetry: false,
      authorizesApplicationStart: false,
    });
  });
}

async function readStableFile(file: string): Promise<string> {
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(MAX_EVIDENCE_BYTES)
  ) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_INPUT_UNSAFE",
      "Evidence input must be one bounded regular single-link file.",
    );
  }
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await lstat(file, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_INPUT_CHANGED",
        "Evidence input changed during read.",
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function exclusiveStore(directory: string) {
  const metadata = await lstat(directory, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_OUTPUT_INVALID",
      "Evidence output must be one real directory.",
    );
  }
  const root = await realpath(directory);
  return async (basename: string, canonical: string) => {
    if (![INTENT_BASENAME, RECEIPT_BASENAME].includes(basename)) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_OUTPUT_INVALID",
        "Evidence output basename is forbidden.",
      );
    }
    const beforeRoot = await lstat(root, { bigint: true });
    if (
      beforeRoot.dev !== metadata.dev ||
      beforeRoot.ino !== metadata.ino ||
      (beforeRoot.mode & 0o777n) !== 0o700n
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_OUTPUT_INVALID",
        "Evidence directory identity or mode changed.",
      );
    }
    const target = path.join(root, basename);
    const handle = await open(
      target,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let opened;
    try {
      await handle.writeFile(canonical, "utf8");
      await handle.sync();
      opened = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const directoryHandle = await open(
      root,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
    );
    try {
      const openedRoot = await directoryHandle.stat({ bigint: true });
      if (openedRoot.dev !== metadata.dev || openedRoot.ino !== metadata.ino) {
        fail(
          "PRODUCTION_EXACT_0107_RESTORE_OUTPUT_INVALID",
          "Evidence directory handle changed.",
        );
      }
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const afterRoot = await lstat(root, { bigint: true });
    const afterTarget = await lstat(target, { bigint: true });
    if (
      !opened ||
      afterRoot.dev !== metadata.dev ||
      afterRoot.ino !== metadata.ino ||
      afterTarget.dev !== opened.dev ||
      afterTarget.ino !== opened.ino ||
      afterTarget.nlink !== 1n ||
      (afterTarget.mode & 0o777n) !== 0o600n ||
      (await readFile(target, "utf8")) !== canonical
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_OUTPUT_INVALID",
        "Evidence read-back differs.",
      );
    }
  };
}

function environmentConfig(env: NodeJS.ProcessEnv): Omit<
  ProductionExact0107RestoreConfig,
  | "backupReceiptCanonical"
  | "backupReferenceCanonical"
  | "rolePreconditionCanonical"
  | "stoppedWritersProofCanonical"
> & {
  receiptFile: string;
  referenceFile: string;
  rolePreconditionFile: string;
  stoppedWritersProofFile: string;
} {
  const action = env.PRODUCTION_EXACT_0107_RESTORE_ACTION;
  const confirmation = env.PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION;
  const mode =
    action === PRODUCTION_EXACT_0107_RESTORE_INSPECT_ACTION &&
    confirmation === PRODUCTION_EXACT_0107_RESTORE_INSPECT_CONFIRMATION
      ? "inspect"
      : action === PRODUCTION_EXACT_0107_RESTORE_ACTION &&
          confirmation === PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION
        ? "restore"
        : null;
  if (mode === null) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION_REQUIRED",
      "Exact inspect or attended restore action and confirmation are required.",
    );
  }
  const sourceSha = requireEmbeddedProductionBuildSha();
  if (env.BUILD_SHA !== sourceSha)
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_SOURCE_MISMATCH",
      "Runtime BUILD_SHA differs from the immutable restore runner.",
    );
  const absolute = (value: string | undefined, field: string) => {
    if (!value || !path.isAbsolute(value))
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID",
        `${field} must be absolute.`,
      );
    return path.resolve(value);
  };
  const backupId = Number(env.PRODUCTION_EXACT_0107_RESTORE_BACKUP_ID);
  if (!Number.isSafeInteger(backupId) || backupId < 1)
    fail("PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID", "backupId is invalid.");
  const reason = env.PRODUCTION_EXACT_0107_RESTORE_REASON ?? "";
  if (!RESTORE_REASONS.has(reason))
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_INPUT_INVALID",
      "Recovery reason is not reviewed.",
    );
  const databaseName = exactIdentifier(
    env.PRODUCTION_INVOICE_0108_DATABASE_NAME,
    "databaseName",
  );
  const sessionUser = exactIdentifier(
    env.PRODUCTION_INVOICE_0108_SESSION_USER,
    "sessionUser",
  );
  const migratorRole = exactIdentifier(
    env.PRODUCTION_INVOICE_0108_MIGRATOR_ROLE,
    "migratorRole",
  );
  const runtimeRole = exactIdentifier(
    env.PRODUCTION_INVOICE_0108_RUNTIME_ROLE,
    "runtimeRole",
  );
  if (
    migratorRole !== PRODUCTION_EXACT_0107_RESTORE_MIGRATOR_ROLE ||
    runtimeRole !== PRODUCTION_EXACT_0107_RESTORE_RUNTIME_ROLE
  ) {
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_IDENTITY_BINDING_INVALID",
      "Environment identity differs from the source-pinned recovery binding.",
    );
  }
  return {
    mode,
    sourceSha,
    migrationsDirectory: absolute(env.MIGRATIONS_DIR, "MIGRATIONS_DIR"),
    evidenceDirectory: absolute(
      env.PRODUCTION_EXACT_0107_RESTORE_EVIDENCE_DIRECTORY,
      "restore evidence directory",
    ),
    receiptFile: absolute(
      env.PRODUCTION_EXACT_0107_BACKUP_RECEIPT_FILE,
      "backup receipt file",
    ),
    referenceFile: absolute(
      env.PRODUCTION_EXACT_0107_BACKUP_REFERENCE_FILE,
      "backup reference file",
    ),
    rolePreconditionFile: absolute(
      env.PRODUCTION_EXACT_0107_RESTORE_ROLE_PRECONDITION_FILE,
      "role precondition file",
    ),
    stoppedWritersProofFile: absolute(
      env.PRODUCTION_EXACT_0107_RESTORE_STOPPED_WRITERS_PROOF_FILE,
      "stopped-writers proof file",
    ),
    backupId,
    databaseName,
    sessionUser,
    migratorRole,
    runtimeRole,
    reason,
    approvedAt:
      mode === "restore"
        ? exactTimestamp(
            env.PRODUCTION_EXACT_0107_RESTORE_APPROVED_AT,
            "approvedAt",
          )
        : undefined,
  };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv = process.argv.slice(2),
) {
  if (argv.length !== 0)
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_ARGUMENT_FORBIDDEN",
      "Restore accepts no command-line arguments.",
    );
  const raw = environmentConfig(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || /[\r\n]/.test(databaseUrl))
    fail(
      "PRODUCTION_EXACT_0107_RESTORE_DATABASE_UNAVAILABLE",
      "Database connection material is unavailable.",
    );
  const catalog = await loadProductionInvoice0108Catalog({
    migrationsDirectory: raw.migrationsDirectory,
  });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 15_000,
  });
  const assertIdentity = async (client: pg.PoolClient) => {
    await client.query(`SET LOCAL ROLE "${raw.migratorRole}"`);
    const result = await client.query(
      "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user, pg_is_in_recovery() AS is_in_recovery",
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row?.database_name !== raw.databaseName ||
      row?.session_user !== raw.sessionUser ||
      row?.current_user !== raw.migratorRole ||
      row?.is_in_recovery !== false
    ) {
      fail(
        "PRODUCTION_EXACT_0107_RESTORE_DATABASE_IDENTITY_INVALID",
        "Database identity differs from the reviewed recovery binding.",
      );
    }
  };
  const readOnly = async <T>(
    operation: (client: pg.PoolClient) => Promise<T>,
  ) => {
    const client = await pool.connect();
    let openTransaction = false;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      openTransaction = true;
      await assertIdentity(client);
      const value = await operation(client);
      await client.query("COMMIT");
      openTransaction = false;
      return value;
    } catch (error) {
      if (openTransaction)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const readInventory = () =>
    readOnly(async (client) => {
      const rows = await client.query(
        'SELECT created_at::text AS created_at, hash::text AS hash FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, hash COLLATE "C" ASC',
      );
      return parseProductionInvoice0108InventoryRows(rows.rows, catalog);
    });
  const assertWritersStopped = (
    lockBackendPid: number,
  ): Promise<WritersObservation> =>
    readOnly(async (client) => {
      const result = await client.query(
        `SELECT clock_timestamp()::text AS observed_at, pg_is_in_recovery() AS is_in_recovery, count(*) FILTER (WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND pid <> $1)::integer AS other_client_sessions FROM pg_stat_activity`,
        [lockBackendPid],
      );
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        row?.is_in_recovery !== false ||
        row?.other_client_sessions !== 0
      ) {
        fail(
          "PRODUCTION_EXACT_0107_RESTORE_WRITERS_RUNNING",
          "Another client session is active or database is a replica.",
        );
      }
      return {
        observedAt: new Date(row.observed_at).toISOString(),
        runtimeRole: raw.runtimeRole,
        otherClientSessions: 0,
      };
    });
  const withMigrationLock = async <T>(
    operation: (lockBackendPid: number) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    let acquired = false;
    let destroy = false;
    try {
      const identity = await client.query(
        "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user, pg_backend_pid()::integer AS backend_pid, pg_is_in_recovery() AS is_in_recovery",
      );
      const row = identity.rows[0];
      if (
        identity.rows.length !== 1 ||
        row?.database_name !== raw.databaseName ||
        row?.session_user !== raw.sessionUser ||
        row?.current_user !== raw.sessionUser ||
        row?.is_in_recovery !== false ||
        !Number.isInteger(row?.backend_pid)
      ) {
        fail(
          "PRODUCTION_EXACT_0107_RESTORE_DATABASE_IDENTITY_INVALID",
          "Migration-lock session identity is invalid.",
        );
      }
      const lock = await client.query(
        "SELECT pg_try_advisory_lock($1::integer) AS acquired",
        [PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY],
      );
      if (lock.rows[0]?.acquired !== true) {
        fail(
          "PRODUCTION_EXACT_0107_RESTORE_LOCK_UNAVAILABLE",
          "The exact invoice-0108 advisory lock is already held.",
        );
      }
      acquired = true;
      return await operation(row.backend_pid);
    } finally {
      if (acquired) {
        try {
          const unlocked = await client.query(
            "SELECT pg_advisory_unlock($1::integer) AS released",
            [PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY],
          );
          destroy = unlocked.rows[0]?.released !== true;
        } catch {
          destroy = true;
        }
      }
      client.release(
        destroy ? new Error("restore lock release failed") : undefined,
      );
    }
  };
  try {
    const result = await runProductionExact0107Restore(
      {
        ...raw,
        backupReceiptCanonical: await readStableFile(raw.receiptFile),
        backupReferenceCanonical: await readStableFile(raw.referenceFile),
        rolePreconditionCanonical: await readStableFile(
          raw.rolePreconditionFile,
        ),
        stoppedWritersProofCanonical: await readStableFile(
          raw.stoppedWritersProofFile,
        ),
      },
      {
        withMigrationLock,
        readInventory,
        assertWritersStopped,
        readBackup: getBackup,
        sealApplicationDatabasePool:
          sealApplicationDatabasePoolForProductionRestore,
        restore: (id, options) => restoreBackup(id, options),
        readPostRestoreTableCountsSha256: () =>
          readOnly(
            async (client) =>
              (await readBackupSnapshotTableCounts(client)).tableCountsSha256,
          ),
        readPostRestoreRoleProjectionCanonical: () =>
          readOnly(async (client) => {
            const result = await client.query(PRODUCTION_ROLE_PROJECTION_SQL, [
              raw.databaseName,
              raw.runtimeRole,
              raw.migratorRole,
            ]);
            const plan = buildProductionRolePlan({
              databaseName: raw.databaseName,
              runtimeRole: raw.runtimeRole,
              migratorRole: raw.migratorRole,
            });
            const projection = normalizeProductionMigrationRoleProjection(
              result.rows[0]?.projection,
              plan,
            );
            const validation = validateProductionRoleProjection(projection);
            if (result.rows.length !== 1 || !validation.ok)
              fail(
                "PRODUCTION_EXACT_0107_RESTORE_ROLE_PROJECTION_INVALID",
                "Restored exact-0107 least-privilege role projection differs.",
              );
            return canonicalProductionRoleJson(projection);
          }),
        persistExclusive: await exclusiveStore(raw.evidenceDirectory),
        now: () => new Date(),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const code =
      error instanceof ProductionExact0107RestoreError
        ? error.code
        : "PRODUCTION_EXACT_0107_RESTORE_UNEXPECTED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
