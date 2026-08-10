import { fileURLToPath } from "node:url";
import { runMigrations } from "@workspace/db/migrate";
import {
  ExternalSchemaPreflightError,
  readExternalSchemaInventoryEnvironment,
  readExternalSchemaPreflightEnvironment,
  readExternalSchemaRuntimeEnvironment,
  runExternalSchemaInventory,
  runExternalSchemaPreflight,
  runExternalSchemaSteadyState,
  type ExternalSchemaPreflightSummary,
} from "@workspace/db/external-schema-preflight";

export interface ExternalSchemaGateDependencies {
  inventory?: typeof runExternalSchemaInventory;
  preflight?: typeof runExternalSchemaPreflight;
  steadyState?: typeof runExternalSchemaSteadyState;
  migrate?: typeof runMigrations;
}

export type ExternalSchemaGateResult = Readonly<{
  mode: "APPLIED" | "NOOP";
  evidence: unknown;
}>;

async function verifySteadyState(
  env: NodeJS.ProcessEnv,
  dependencies: ExternalSchemaGateDependencies,
): Promise<ExternalSchemaGateResult> {
  const summary = await (
    dependencies.steadyState ?? runExternalSchemaSteadyState
  )(readExternalSchemaRuntimeEnvironment(env));
  return Object.freeze({ mode: "NOOP", evidence: summary });
}

function transitionEvidence(
  summary: ExternalSchemaPreflightSummary,
  env: NodeJS.ProcessEnv,
) {
  const deploymentInputsSha256 =
    env.STAGING_DEPLOYMENT_INPUTS_SHA256?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(deploymentInputsSha256)) {
    throw new ExternalSchemaPreflightError(
      "DEPLOYMENT_BINDING_INVALID",
      "The canonical staging deployment input checksum is required.",
    );
  }
  const backupRestoreMaxAgeHours = Number(
    env.STAGING_BACKUP_RESTORE_MAX_AGE_HOURS,
  );
  if (
    !Number.isInteger(backupRestoreMaxAgeHours) ||
    backupRestoreMaxAgeHours < 1 ||
    backupRestoreMaxAgeHours > 168
  ) {
    throw new ExternalSchemaPreflightError(
      "BACKUP_MAX_AGE_INVALID",
      "The staging backup maximum age must be 1 through 168 hours.",
    );
  }
  const backupExecutionSha256 =
    env.STAGING_EXACT_0104_BACKUP_EXECUTION_SHA256?.trim() ?? "";
  const backupMaxPayloadBytes = Number(
    env.STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
  );
  const backupSizeBytes = Number(env.STAGING_EXACT_0104_BACKUP_SIZE_BYTES);
  if (
    !/^[0-9a-f]{64}$/.test(backupExecutionSha256) ||
    backupMaxPayloadBytes !== 256 * 1024 * 1024 ||
    !Number.isSafeInteger(backupSizeBytes) ||
    backupSizeBytes < 1 ||
    backupSizeBytes > backupMaxPayloadBytes ||
    summary.backupEvidence.sizeBytes !== backupSizeBytes
  ) {
    throw new ExternalSchemaPreflightError(
      "BACKUP_EXECUTION_BINDING_INVALID",
      "The transition must preserve the reviewed exact-0104 backup execution and 256 MiB ceiling.",
    );
  }
  return {
    schemaGate: {
      decision: "APPLIED",
      sourceSha: summary.buildSha,
      latestExpectedTag: summary.latestExpectedTag,
      expectedMigrations: summary.expectedMigrations,
      excludedMigration0100Present: false,
      externalStateRows: summary.externalStateRows,
      backupEvidenceId: summary.backupEvidenceId,
      backupRestoreAgeHours: summary.backupRestoreAgeHours,
      backupRestoreMaxAgeHours,
      sourceBackupExecutionSha256: `sha256:${backupExecutionSha256}`,
      backupMaxPayloadBytes,
      backupSizeBytes,
      inputSha256: `sha256:${deploymentInputsSha256}`,
    },
    backupEvidence: {
      id: summary.backupEvidence.id,
      status: "success",
      sizeBytes: summary.backupEvidence.sizeBytes,
      encryptedBackupSha256: summary.backupEvidence.encryptedBackupSha256,
      encryptionFormat: summary.backupEvidence.encryptionFormat,
      restoreStatus: "ok",
      createdAt: summary.backupEvidence.createdAt,
      restoreTestedAt: summary.backupEvidence.restoreTestedAt,
      checkedAt: summary.backupEvidence.checkedAt,
      restoreAgeHours: summary.backupEvidence.restoreAgeHours,
      sourceExecutionSha256: `sha256:${backupExecutionSha256}`,
      maxPayloadBytes: backupMaxPayloadBytes,
    },
  } as const;
}

async function verifyTransitionNoop(
  env: NodeJS.ProcessEnv,
  dependencies: ExternalSchemaGateDependencies,
): Promise<ExternalSchemaGateResult> {
  const post = readExternalSchemaPreflightEnvironment({
    ...env,
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "post",
  });
  const summary = await (dependencies.preflight ?? runExternalSchemaPreflight)(
    post,
  );
  return Object.freeze({
    mode: "NOOP",
    evidence: transitionEvidence(summary, env),
  });
}

export async function runExternalSchemaGate(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ExternalSchemaGateDependencies = {},
): Promise<ExternalSchemaGateResult> {
  const action = env.STAGING_SCHEMA_ACTION;
  if (action === "steady-0105") {
    return verifySteadyState(env, dependencies);
  }
  if (action !== "apply-0105") {
    throw new ExternalSchemaPreflightError(
      "SCHEMA_ACTION_INVALID",
      "The transition gate accepts only apply-0105 or steady-0105.",
    );
  }

  // Make an approved transition recoverable: an existing exact 0105 state must
  // still pass the full post-preflight so schema and backup evidence come from
  // one current repeatable-read snapshot.
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
    dependencies.inventory ?? runExternalSchemaInventory
  )(readExternalSchemaInventoryEnvironment(env));
  if (inventory.decision === "ALREADY_0105") {
    return verifyTransitionNoop(env, dependencies);
  }
  if (inventory.decision !== "READY_0104") {
    throw new ExternalSchemaPreflightError(
      "BASELINE_0104_REQUIRED",
      `Staging is ${inventory.missingToPredecessor} migration(s) behind exact 0104; transition refused.`,
    );
  }

  const pre = readExternalSchemaPreflightEnvironment({
    ...env,
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "pre",
  });
  await (dependencies.preflight ?? runExternalSchemaPreflight)(pre);
  const migration = await (dependencies.migrate ?? runMigrations)(
    pre.databaseUrl,
  );
  const post = readExternalSchemaPreflightEnvironment({
    ...env,
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "post",
  });
  const summary = await (dependencies.preflight ?? runExternalSchemaPreflight)(
    post,
  );
  if (migration.newlyApplied !== 0 && migration.newlyApplied !== 1) {
    throw new ExternalSchemaPreflightError(
      "MIGRATION_APPLY_COUNT_INVALID",
      "The isolated 0105 transition must apply exactly one migration or lose a concurrent race without applying any.",
    );
  }
  return Object.freeze({
    mode: migration.newlyApplied === 1 ? "APPLIED" : "NOOP",
    evidence: transitionEvidence(summary, env),
  });
}

async function main(): Promise<void> {
  const result = await runExternalSchemaGate();
  process.stdout.write(
    `[external-schema-gate] ${result.mode} ${JSON.stringify(result.evidence)}\n`,
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
      `[external-schema-gate] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
