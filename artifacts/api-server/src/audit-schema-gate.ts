import { fileURLToPath } from "node:url";
import {
  AUDIT_SCHEMA_MIGRATIONS,
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_OPAQUE_ROWS_SHA256,
  AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION,
  applyAuditSchema0107,
  readAuditSchemaInventoryEnvironment,
  readAuditSchemaPreflightEnvironment,
  readAuditSchemaRuntimeEnvironment,
  runAuditSchemaInventory,
  runAuditSchemaPreflight,
  runAuditSchemaSteadyState,
  type AuditSchemaInventorySummary,
  type AuditSchemaPreflightSummary,
  type AuditSchemaSteadyStateSummary,
} from "@workspace/db/audit-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";

const MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface AuditSchemaGateDependencies {
  inventory?: typeof runAuditSchemaInventory;
  preflight?: typeof runAuditSchemaPreflight;
  steadyState?: typeof runAuditSchemaSteadyState;
  migrate?: typeof applyAuditSchema0107;
}

export interface AuditSchemaGateEvidence {
  schemaVersion: "site-logbook.audit-schema-gate/v1";
  kind: "audit-schema-gate";
  mode: "APPLIED" | "NOOP";
  decision: "ALREADY_0107";
  before: Readonly<{
    decision: "READY_0106" | "ALREADY_0107";
    knownAppliedMigrations: 106 | 107;
    knownAppliedRowsSha256: string;
    opaqueLegacyRowCount: 0 | 2;
    opaqueLegacyRowsSha256: string;
  }>;
  after: AuditSchemaSteadyStateSummary;
  newlyApplied: 0 | 1;
  migration: Readonly<{
    idx: 107;
    when: 1786484628859;
    tag: "0107_canonical_audit_evidence";
    sha256: string;
  }>;
  transition: Readonly<{
    inputSha256: string;
    sourceBackupExecutionSha256: string;
    backupEvidenceId: number;
    backupRestoreAgeHours: number;
    backupRestoreMaxAgeHours: number;
    backupMaxPayloadBytes: number;
    backupSizeBytes: number;
    backupEvidence: AuditSchemaPreflightSummary["backupEvidence"];
    backupIntegrity: AuditSchemaPreflightSummary["backupIntegrity"];
  }> | null;
  authorizesApplicationStart: true;
}

export type AuditSchemaGateResult = Readonly<{
  mode: "APPLIED" | "NOOP";
  evidence: AuditSchemaGateEvidence;
}>;

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(code, message);
}

function beforeMarker(
  summary: AuditSchemaInventorySummary | AuditSchemaPreflightSummary,
): AuditSchemaGateEvidence["before"] {
  const known = summary.lineage.knownAppliedMigrations;
  if (
    (summary.decision !== "READY_0106" &&
      summary.decision !== "ALREADY_0107") ||
    summary.lineage.decision !== summary.decision ||
    (summary.decision === "READY_0106" ? known !== 106 : known !== 107)
  ) {
    fail(
      "AUDIT_SCHEMA_BEFORE_INVALID",
      "Gate before-state must be exact 0106 or exact 0107.",
    );
  }
  return Object.freeze({
    decision: summary.decision,
    knownAppliedMigrations: known,
    knownAppliedRowsSha256: summary.lineage.knownAppliedRowsSha256,
    opaqueLegacyRowCount: summary.lineage.opaqueLegacyRowCount,
    opaqueLegacyRowsSha256: summary.lineage.opaqueLegacyRowsSha256,
  }) as AuditSchemaGateEvidence["before"];
}

function transitionEvidence(
  summary: AuditSchemaPreflightSummary,
  env: NodeJS.ProcessEnv,
): AuditSchemaGateEvidence["transition"] {
  const inputSha256 = env.STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256?.trim() ?? "";
  const backupExecutionSha256 =
    env.STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256?.trim() ?? "";
  const backupMaxPayloadBytes = Number(
    env.STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES,
  );
  const backupSizeBytes = Number(env.STAGING_EXACT_0106_BACKUP_SIZE_BYTES);
  const backupRestoreMaxAgeHours = Number(
    env.STAGING_BACKUP_RESTORE_MAX_AGE_HOURS,
  );
  if (!/^[0-9a-f]{64}$/.test(inputSha256)) {
    fail(
      "AUDIT_DEPLOYMENT_BINDING_INVALID",
      "The canonical audit deployment input checksum is required.",
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
      "AUDIT_BACKUP_EXECUTION_BINDING_INVALID",
      "The 0107 transition must preserve the reviewed exact-0106 backup and 256 MiB ceiling.",
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
  if (
    summary.schema.auditEventRows !== 0 ||
    summary.schema.auditOutboxRows !== 0 ||
    summary.schema.auditHeadRows !== 1
  ) {
    fail(
      "AUDIT_TRANSITION_STATE_NOT_GENESIS",
      "The 0107 transition must end at the exact canonical audit genesis state.",
    );
  }
  return Object.freeze({
    inputSha256: `sha256:${inputSha256}`,
    sourceBackupExecutionSha256: `sha256:${backupExecutionSha256}`,
    backupEvidenceId: summary.backupEvidenceId,
    backupRestoreAgeHours: summary.backupRestoreAgeHours,
    backupRestoreMaxAgeHours,
    backupMaxPayloadBytes,
    backupSizeBytes,
    backupEvidence: summary.backupEvidence,
    backupIntegrity: summary.backupIntegrity,
  });
}

function gateEvidence(
  mode: "APPLIED" | "NOOP",
  newlyApplied: 0 | 1,
  before: AuditSchemaInventorySummary | AuditSchemaPreflightSummary,
  post: AuditSchemaPreflightSummary,
  after: AuditSchemaSteadyStateSummary,
  env: NodeJS.ProcessEnv,
): AuditSchemaGateEvidence {
  if (
    post.decision !== "ALREADY_0107" ||
    post.mode !== "post" ||
    after.decision !== "ALREADY_0107" ||
    after.authorizesApplicationStart !== true ||
    post.lineage.decision !== "ALREADY_0107" ||
    after.lineage.decision !== "ALREADY_0107" ||
    post.lineage.knownAppliedMigrations !== 107 ||
    after.lineage.knownAppliedMigrations !== 107 ||
    post.environmentId !== after.environmentId ||
    post.databaseName !== after.databaseName ||
    post.databaseUser !== after.databaseUser ||
    post.buildSha !== after.buildSha ||
    JSON.stringify(post.schema) !== JSON.stringify(after.schema) ||
    post.lineage.knownAppliedRowsSha256 !==
      after.lineage.knownAppliedRowsSha256 ||
    post.lineage.opaqueLegacyRowsSha256 !==
      after.lineage.opaqueLegacyRowsSha256 ||
    post.lineage.mode !== after.lineage.mode ||
    post.lineage.knownAppliedRowsSha256 !==
      AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target ||
    post.lineage.opaqueLegacyRowsSha256 !==
      (post.lineage.mode === "clean"
        ? AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.clean
        : AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.productionCopyRestricted)
  ) {
    fail(
      "AUDIT_GATE_POSTCHECK_INVALID",
      "Postflight and steady-state evidence must agree exactly.",
    );
  }
  return Object.freeze({
    schemaVersion: "site-logbook.audit-schema-gate/v1",
    kind: "audit-schema-gate",
    mode,
    decision: "ALREADY_0107",
    before: beforeMarker(before),
    after,
    newlyApplied,
    migration: Object.freeze({
      idx: AUDIT_SCHEMA_MIGRATIONS.target.idx,
      when: AUDIT_SCHEMA_MIGRATIONS.target.when,
      tag: AUDIT_SCHEMA_MIGRATIONS.target.tag,
      sha256: `sha256:${AUDIT_SCHEMA_MIGRATIONS.target.hash}`,
    }),
    transition: transitionEvidence(post, env),
    authorizesApplicationStart: true,
  });
}

export async function runAuditSchemaGate(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AuditSchemaGateDependencies = {},
): Promise<AuditSchemaGateResult> {
  const action = env.STAGING_AUDIT_SCHEMA_ACTION;
  if (action === "steady-0107") {
    const after = await (dependencies.steadyState ?? runAuditSchemaSteadyState)(
      readAuditSchemaRuntimeEnvironment(env),
    );
    return Object.freeze({
      mode: "NOOP",
      evidence: Object.freeze({
        schemaVersion: "site-logbook.audit-schema-gate/v1",
        kind: "audit-schema-gate",
        mode: "NOOP",
        decision: "ALREADY_0107",
        before: Object.freeze({
          decision: "ALREADY_0107",
          knownAppliedMigrations: 107,
          knownAppliedRowsSha256: after.lineage.knownAppliedRowsSha256,
          opaqueLegacyRowCount: after.lineage.opaqueLegacyRowCount,
          opaqueLegacyRowsSha256: after.lineage.opaqueLegacyRowsSha256,
        }),
        after,
        newlyApplied: 0,
        migration: Object.freeze({
          idx: AUDIT_SCHEMA_MIGRATIONS.target.idx,
          when: AUDIT_SCHEMA_MIGRATIONS.target.when,
          tag: AUDIT_SCHEMA_MIGRATIONS.target.tag,
          sha256: `sha256:${AUDIT_SCHEMA_MIGRATIONS.target.hash}`,
        }),
        transition: null,
        authorizesApplicationStart: true,
      }),
    });
  }
  if (action !== "apply-0107") {
    fail(
      "AUDIT_SCHEMA_ACTION_INVALID",
      "The audit gate accepts only apply-0107 or steady-0107.",
    );
  }
  if (
    env.AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION !==
    AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_INVALID",
      "The exact isolated 0107 confirmation phrase is required.",
    );
  }

  let existingPost: AuditSchemaPreflightSummary | null = null;
  try {
    existingPost = await (dependencies.preflight ?? runAuditSchemaPreflight)(
      readAuditSchemaPreflightEnvironment({
        ...env,
        AUDIT_SCHEMA_PREFLIGHT_MODE: "post",
      }),
    );
  } catch (error) {
    if (
      !(error instanceof ExternalSchemaPreflightError) ||
      error.code !== "APPLIED_COUNT_MISMATCH"
    ) {
      throw error;
    }
  }
  if (existingPost) {
    const after = await (dependencies.steadyState ?? runAuditSchemaSteadyState)(
      readAuditSchemaRuntimeEnvironment(env),
    );
    return Object.freeze({
      mode: "NOOP",
      evidence: gateEvidence("NOOP", 0, existingPost, existingPost, after, env),
    });
  }

  const inventory = await (dependencies.inventory ?? runAuditSchemaInventory)(
    readAuditSchemaInventoryEnvironment(env),
  );
  if (inventory.decision !== "READY_0106") {
    fail(
      "BASELINE_0106_REQUIRED",
      `Staging is ${inventory.lineage.missingKnownToPredecessor} known migration(s) behind exact 0106.`,
    );
  }
  const preEnvironment = readAuditSchemaPreflightEnvironment({
    ...env,
    AUDIT_SCHEMA_PREFLIGHT_MODE: "pre",
  });
  const pre = await (dependencies.preflight ?? runAuditSchemaPreflight)(
    preEnvironment,
  );
  const migration = await (dependencies.migrate ?? applyAuditSchema0107)(
    preEnvironment,
  );
  if (
    migration.expectedCount !== 107 ||
    migration.latestExpectedTag !== AUDIT_SCHEMA_MIGRATIONS.target.tag ||
    (migration.newlyApplied !== 0 && migration.newlyApplied !== 1) ||
    migration.knownAppliedAfter !== 107 ||
    migration.schemaFingerprintSha256 !==
      preEnvironment.expectedSchemaFingerprintSha256 ||
    (migration.newlyApplied === 1
      ? migration.knownAppliedBefore !== 106
      : migration.knownAppliedBefore !== 107)
  ) {
    fail(
      "AUDIT_MIGRATION_APPLY_COUNT_INVALID",
      "The 0107 transition may apply exactly one migration or lose one exact race.",
    );
  }
  const post = await (dependencies.preflight ?? runAuditSchemaPreflight)(
    readAuditSchemaPreflightEnvironment({
      ...env,
      AUDIT_SCHEMA_PREFLIGHT_MODE: "post",
    }),
  );
  const after = await (dependencies.steadyState ?? runAuditSchemaSteadyState)(
    readAuditSchemaRuntimeEnvironment(env),
  );
  const mode = migration.newlyApplied === 1 ? "APPLIED" : "NOOP";
  return Object.freeze({
    mode,
    evidence: gateEvidence(
      mode,
      migration.newlyApplied as 0 | 1,
      inventory,
      post,
      after,
      env,
    ),
  });
}

async function main(): Promise<void> {
  const result = await runAuditSchemaGate();
  process.stdout.write(
    `[audit-schema-gate] ${result.mode} ${JSON.stringify(result.evidence)}\n`,
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
      `[audit-schema-gate] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
