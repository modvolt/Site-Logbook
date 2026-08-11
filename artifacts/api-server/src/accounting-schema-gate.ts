import { fileURLToPath } from "node:url";
import {
  ACCOUNTING_SCHEMA_MIGRATIONS,
  ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION,
  readAccountingSchemaInventoryEnvironment,
  readAccountingSchemaPreflightEnvironment,
  runAccountingSchemaInventory,
  runAccountingSchemaPreflight,
  runAccountingSchemaSteadyState,
  type AccountingSchemaInventorySummary,
  type AccountingSchemaPreflightEnvironment,
  type AccountingSchemaPreflightSummary,
} from "@workspace/db/accounting-schema-preflight";
import {
  ExternalSchemaPreflightError,
  readExternalSchemaRuntimeEnvironment,
} from "@workspace/db/external-schema-preflight";
import { runMigrations } from "@workspace/db/migrate";

const MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface AccountingSchemaGateDependencies {
  inventory?: typeof runAccountingSchemaInventory;
  preflight?: typeof runAccountingSchemaPreflight;
  steadyState?: typeof runAccountingSchemaSteadyState;
  migrate?: typeof runMigrations;
}

export type AccountingSchemaGateResult = Readonly<{
  mode: "APPLIED" | "NOOP";
  evidence: unknown;
}>;

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(code, message);
}

function transitionEvidence(
  summary: AccountingSchemaPreflightSummary,
  env: NodeJS.ProcessEnv,
) {
  const deploymentInputsSha256 =
    env.STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256?.trim() ?? "";
  const backupExecutionSha256 =
    env.STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256?.trim() ?? "";
  const backupMaxPayloadBytes = Number(
    env.STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
  );
  const backupSizeBytes = Number(env.STAGING_EXACT_0105_BACKUP_SIZE_BYTES);
  const backupRestoreMaxAgeHours = Number(
    env.STAGING_BACKUP_RESTORE_MAX_AGE_HOURS,
  );
  if (!/^[0-9a-f]{64}$/.test(deploymentInputsSha256)) {
    fail(
      "ACCOUNTING_DEPLOYMENT_BINDING_INVALID",
      "The canonical accounting deployment input checksum is required.",
    );
  }
  if (
    !/^[0-9a-f]{64}$/.test(backupExecutionSha256) ||
    backupMaxPayloadBytes !== MAX_BACKUP_PAYLOAD_BYTES ||
    !Number.isSafeInteger(backupSizeBytes) ||
    backupSizeBytes < 1 ||
    backupSizeBytes > backupMaxPayloadBytes ||
    summary.backupEvidence.sizeBytes !== backupSizeBytes
  ) {
    fail(
      "ACCOUNTING_BACKUP_EXECUTION_BINDING_INVALID",
      "The accounting transition must preserve the reviewed exact-0105 backup and 256 MiB ceiling.",
    );
  }
  if (
    !Number.isInteger(backupRestoreMaxAgeHours) ||
    backupRestoreMaxAgeHours < 1 ||
    backupRestoreMaxAgeHours > 168
  ) {
    fail(
      "BACKUP_MAX_AGE_INVALID",
      "Backup maximum age must be 1 through 168 hours.",
    );
  }
  if (summary.accountingEvidenceRows !== 0 || summary.externalStateRows !== 0) {
    fail(
      "ACCOUNTING_TRANSITION_STATE_NOT_EMPTY",
      "The 0106 transition evidence requires empty accounting tables and dark external-account state.",
    );
  }
  return {
    schemaGate: {
      decision: "APPLIED",
      sourceSha: summary.buildSha,
      predecessorTag: ACCOUNTING_SCHEMA_MIGRATIONS.predecessor.tag,
      latestExpectedTag: summary.latestExpectedTag,
      expectedMigrations: summary.expectedMigrations,
      excludedMigration0100Present: false,
      accountingEvidenceRows: 0,
      externalStateRows: 0,
      backupEvidenceId: summary.backupEvidenceId,
      backupRestoreAgeHours: summary.backupRestoreAgeHours,
      backupRestoreMaxAgeHours,
      sourceBackupExecutionSha256: `sha256:${backupExecutionSha256}`,
      backupMaxPayloadBytes,
      backupSizeBytes,
      inputSha256: `sha256:${deploymentInputsSha256}`,
      migration: {
        idx: ACCOUNTING_SCHEMA_MIGRATIONS.target.idx,
        when: ACCOUNTING_SCHEMA_MIGRATIONS.target.when,
        tag: ACCOUNTING_SCHEMA_MIGRATIONS.target.tag,
        sha256: `sha256:${ACCOUNTING_SCHEMA_MIGRATIONS.target.hash}`,
      },
    },
    backupEvidence: {
      ...summary.backupEvidence,
      sourceExecutionSha256: `sha256:${backupExecutionSha256}`,
      maxPayloadBytes: backupMaxPayloadBytes,
    },
  } as const;
}

async function verifySteadyState(
  env: NodeJS.ProcessEnv,
  dependencies: AccountingSchemaGateDependencies,
): Promise<AccountingSchemaGateResult> {
  const summary = await (
    dependencies.steadyState ?? runAccountingSchemaSteadyState
  )(readExternalSchemaRuntimeEnvironment(env));
  return Object.freeze({ mode: "NOOP", evidence: summary });
}

async function verifyTransitionNoop(
  env: NodeJS.ProcessEnv,
  dependencies: AccountingSchemaGateDependencies,
): Promise<AccountingSchemaGateResult> {
  const summary = await (
    dependencies.preflight ?? runAccountingSchemaPreflight
  )(
    readAccountingSchemaPreflightEnvironment({
      ...env,
      ACCOUNTING_SCHEMA_PREFLIGHT_MODE: "post",
    }),
  );
  return Object.freeze({
    mode: "NOOP",
    evidence: transitionEvidence(summary, env),
  });
}

function requireReady0105(inventory: AccountingSchemaInventorySummary): void {
  if (inventory.decision === "ALREADY_0106") return;
  if (inventory.decision !== "READY_0105") {
    fail(
      "BASELINE_0105_REQUIRED",
      `Staging is ${inventory.missingToPredecessor} migration(s) behind exact 0105.`,
    );
  }
}

export async function runAccountingSchemaGate(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AccountingSchemaGateDependencies = {},
): Promise<AccountingSchemaGateResult> {
  const action = env.STAGING_ACCOUNTING_SCHEMA_ACTION;
  if (action === "steady-0106") return verifySteadyState(env, dependencies);
  if (action !== "apply-0106") {
    fail(
      "ACCOUNTING_SCHEMA_ACTION_INVALID",
      "The accounting gate accepts only apply-0106 or steady-0106.",
    );
  }
  if (
    env.ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION !==
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_INVALID",
      "The exact isolated 0106 confirmation phrase is required.",
    );
  }

  try {
    return await verifyTransitionNoop(env, dependencies);
  } catch (error) {
    if (
      !(error instanceof ExternalSchemaPreflightError) ||
      error.code !== "APPLIED_COUNT_MISMATCH"
    ) {
      throw error;
    }
  }

  const inventory = await (
    dependencies.inventory ?? runAccountingSchemaInventory
  )(readAccountingSchemaInventoryEnvironment(env));
  requireReady0105(inventory);
  if (inventory.decision === "ALREADY_0106") {
    return verifyTransitionNoop(env, dependencies);
  }

  const pre: AccountingSchemaPreflightEnvironment =
    readAccountingSchemaPreflightEnvironment({
      ...env,
      ACCOUNTING_SCHEMA_PREFLIGHT_MODE: "pre",
    });
  await (dependencies.preflight ?? runAccountingSchemaPreflight)(pre);
  const migration = await (dependencies.migrate ?? runMigrations)(
    pre.databaseUrl,
  );
  const post = await (dependencies.preflight ?? runAccountingSchemaPreflight)(
    readAccountingSchemaPreflightEnvironment({
      ...env,
      ACCOUNTING_SCHEMA_PREFLIGHT_MODE: "post",
    }),
  );
  if (migration.newlyApplied !== 0 && migration.newlyApplied !== 1) {
    fail(
      "ACCOUNTING_MIGRATION_APPLY_COUNT_INVALID",
      "The isolated 0106 transition must apply exactly one migration or lose a race with zero.",
    );
  }
  return Object.freeze({
    mode: migration.newlyApplied === 1 ? "APPLIED" : "NOOP",
    evidence: transitionEvidence(post, env),
  });
}

async function main(): Promise<void> {
  const result = await runAccountingSchemaGate();
  process.stdout.write(
    `[accounting-schema-gate] ${result.mode} ${JSON.stringify(result.evidence)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const failure =
      error instanceof ExternalSchemaPreflightError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[accounting-schema-gate] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
