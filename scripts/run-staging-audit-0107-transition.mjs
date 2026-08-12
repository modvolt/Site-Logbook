import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGING_POSTGRES_INSPECT_FORMAT,
  STAGING_POSTGRES_IMAGE,
  STAGING_POSTGRES_VOLUME,
  validateResolvedStagingComposeTarget,
  validateRunningStagingPostgresContainer,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import {
  validateAudit0107TransitionInputs,
  validateExact0106AuditBackupExecution,
} from "./check-staging-audit-0107-binding.mjs";
import {
  canonicalJson,
  sha256Canonical,
} from "./check-staging-provisioning.mjs";
import {
  assertApprovedDockerBoundary,
  cleanupFrozenCompose,
  freezeRenderedCompose,
  runFrozenComposeOneShot,
} from "./staging-frozen-compose-runtime.mjs";
import {
  argument,
  AUDIT_0107,
  AUDIT_0107_FILES,
  audit0107Fail,
  atomicWriteExclusive,
  canonicalOpaqueLegacyRows,
  canonicalTimestamp,
  exactKeys,
  prepareExclusiveOutput,
  readRegularFile,
  requiredArgument,
  sha256,
  trustedCanonicalArtifact,
  validateLineageSummary,
  writeCanonicalPair,
} from "./staging-audit-0107-contract.mjs";

export class StagingAudit0107TransitionRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAudit0107TransitionRunnerError";
    this.code = code;
  }
}

function wrap(error) {
  if (error instanceof StagingAudit0107TransitionRunnerError) throw error;
  const code =
    typeof error?.code === "string"
      ? error.code
      : "AUDIT_0107_TRANSITION_INVALID";
  const wrapped = new StagingAudit0107TransitionRunnerError(
    code,
    error instanceof Error ? error.message : String(error),
  );
  if (error?.cleanupError) {
    Object.defineProperty(wrapped, "cleanupError", {
      value: error.cleanupError,
      enumerable: false,
    });
  }
  throw wrapped;
}

function defaultExecute(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function checked(execute, args, label, { allowFailure = false } = {}) {
  const result = execute("docker", args);
  if (result.error || result.status !== 0) {
    if (allowFailure) return undefined;
    audit0107Fail(
      "AUDIT_0107_COMMAND_FAILED",
      `${label} failed without approved evidence.`,
    );
  }
  return result.stdout ?? "";
}

export function validateStagingAudit0107TransitionArtifacts({
  expectedSourceSha,
  transitionBytes,
  transitionChecksumText,
  expectedTransitionSha256,
  inspectBytes,
  inspectChecksumText,
  expectedInspectSha256,
  backupExecutionBytes,
  backupExecutionChecksumText,
  expectedBackupExecutionSha256,
}) {
  try {
    if (!/^[0-9a-f]{40}$/.test(expectedSourceSha ?? "")) {
      audit0107Fail(
        "AUDIT_0107_SOURCE_INVALID",
        "The exact candidate source SHA is required.",
      );
    }
    const transitionArtifact = trustedCanonicalArtifact({
      bytes: transitionBytes,
      checksumText: transitionChecksumText,
      expectedSha256: expectedTransitionSha256,
      name: AUDIT_0107_FILES.transition,
      label: "audit 0107 transition inputs",
    });
    const transition = validateAudit0107TransitionInputs(
      transitionArtifact.value,
    );
    if (transition.sourceSha !== expectedSourceSha) {
      audit0107Fail(
        "AUDIT_0107_SOURCE_MISMATCH",
        "Transition source SHA does not match the reviewed candidate.",
      );
    }
    const lineage = canonicalOpaqueLegacyRows(
      transition.lineage.opaqueLegacyRows,
      transition.lineage.mode,
    );
    const inspectArtifact = trustedCanonicalArtifact({
      bytes: inspectBytes,
      checksumText: inspectChecksumText,
      expectedSha256: expectedInspectSha256,
      name: AUDIT_0107_FILES.inspect,
      label: "derived audit inspect inputs",
    });
    const inspect = validateStagingDeploymentInputs(inspectArtifact.value, {
      expectedSchemaAction: "inspect",
      expectedSourceSha,
    });
    const backupArtifact = trustedCanonicalArtifact({
      bytes: backupExecutionBytes,
      checksumText: backupExecutionChecksumText,
      expectedSha256: expectedBackupExecutionSha256,
      name: AUDIT_0107_FILES.backup,
      label: "exact-0106 audit backup execution",
    });
    const backup = validateExact0106AuditBackupExecution(
      backupArtifact.value,
      expectedSourceSha,
      lineage,
    );
    if (
      transition.originalInspectInputsSha256 !==
        `sha256:${backup.inspectInputsSha256}` ||
      transition.derivedInspectInputsSha256 !==
        `sha256:${inspectArtifact.sha256}` ||
      transition.backupExecutionSha256 !== `sha256:${backupArtifact.sha256}` ||
      transition.backupEvidence.id !== inspect.backupEvidenceId ||
      transition.backupEvidence.id !== backup.backupId ||
      transition.backupEvidence.previousId !== backup.previousBackupId ||
      transition.backupEvidence.sizeBytes !== backup.sizeBytes ||
      transition.backupEvidence.maxPayloadBytes !== backup.maxPayloadBytes ||
      transition.backupEvidence.createdAt !== backup.createdAt ||
      transition.backupEvidence.restoreTestedAt !== backup.restoreTestedAt ||
      transition.backupEvidence.verifiedTableCount !==
        backup.verifiedTableCount ||
      canonicalJson(transition.backupEvidence.verifiedTableNames) !==
        canonicalJson(backup.verifiedTableNames) ||
      canonicalJson(transition.backupEvidence.sourceTableCounts) !==
        canonicalJson(backup.sourceTableCounts) ||
      canonicalJson(transition.backupEvidence.restoredTableCounts) !==
        canonicalJson(backup.restoredTableCounts) ||
      transition.backupEvidence.verifiedTableCountsSha256 !==
        backup.verifiedTableCountsSha256 ||
      transition.backupEvidence.backupRowBindingSha256 !==
        backup.backupRowBindingSha256 ||
      transition.expectedSchemaFingerprintSha256 !==
        backup.expectedSchemaFingerprintSha256
    ) {
      audit0107Fail(
        "AUDIT_0107_ARTIFACT_CHAIN_MISMATCH",
        "Transition, inspect and fresh backup bytes do not form one exact chain.",
      );
    }
    return Object.freeze({
      sourceSha: expectedSourceSha,
      transition,
      transitionSha256: transitionArtifact.sha256,
      inspect,
      inspectSha256: inspectArtifact.sha256,
      backup,
      backupExecutionSha256: backupArtifact.sha256,
      lineage,
    });
  } catch (error) {
    wrap(error);
  }
}

function resolveCompose(execute, composeArgs, inputs) {
  const stdout = checked(
    execute,
    [...composeArgs, "config", "--format", "json"],
    "resolved audit 0107 target inspection",
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    audit0107Fail(
      "AUDIT_0107_COMPOSE_INVALID",
      "Resolved Compose target must be strict JSON.",
    );
  }
  try {
    const binding = validateResolvedStagingComposeTarget(
      value,
      inputs.inspect,
      {
        targetService: "audit-schema-gate",
        deploymentInputsSha256: inputs.inspectSha256,
        auditInputsSha256: inputs.transitionSha256,
        exact0106BackupExecutionSha256: inputs.backupExecutionSha256,
        exact0106BackupMaxPayloadBytes: inputs.backup.maxPayloadBytes,
        exact0106BackupSizeBytes: inputs.backup.sizeBytes,
        auditLineageMode: inputs.lineage.mode,
        auditOpaqueLegacyRowsJson: inputs.lineage.opaqueLegacyRowsJson,
      },
    );
    return Object.freeze({
      binding,
      value,
      resolvedComposeSha256: sha256Canonical(value),
    });
  } catch {
    audit0107Fail(
      "AUDIT_0107_COMPOSE_MISMATCH",
      "Resolved audit transition target does not match the reviewed artifact chain.",
    );
  }
}

function assertOnlyPostgresRunning(
  execute,
  composeArgs,
  binding,
  phase,
  expectedContainerId,
) {
  const services = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--services"],
    phase,
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (services.length !== 1 || services[0] !== "postgres") {
    audit0107Fail(
      "AUDIT_0107_RUNTIME_NOT_QUIESCENT",
      "Postgres must be the isolated Compose project's only running service.",
    );
  }
  const ids = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--quiet", "postgres"],
    `${phase} postgres container lookup`,
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    ids.length !== 1 ||
    !/^[0-9a-f]{12,64}$/.test(ids[0]) ||
    (expectedContainerId &&
      !expectedContainerId.startsWith(ids[0]) &&
      !ids[0].startsWith(expectedContainerId))
  ) {
    audit0107Fail(
      "AUDIT_0107_POSTGRES_INVALID",
      "Exactly one unchanged staging postgres container is required.",
    );
  }
  const expectedId = expectedContainerId ?? ids[0];
  let projection;
  try {
    projection = JSON.parse(
      checked(
        execute,
        ["inspect", "--format", STAGING_POSTGRES_INSPECT_FORMAT, ids[0]],
        `${phase} live postgres inspection`,
      ),
    );
  } catch {
    audit0107Fail(
      "AUDIT_0107_POSTGRES_INVALID",
      "Live postgres projection must be strict JSON.",
    );
  }
  try {
    const target = validateRunningStagingPostgresContainer(
      projection,
      binding,
      {
        expectedContainerId: expectedId,
      },
    );
    return Object.freeze({
      ...target,
      projectionSha256: sha256Canonical(target),
    });
  } catch {
    audit0107Fail(
      "AUDIT_0107_POSTGRES_MISMATCH",
      "Live postgres does not match the resolved isolated target.",
    );
  }
}

function expectedDeploymentConfig(inputs) {
  return Object.freeze({
    composeProjectName: inputs.inspect.composeProjectName,
    targetService: "audit-schema-gate",
    sourceSha: inputs.sourceSha,
    apiImage: inputs.inspect.images.api,
    postgresImage: STAGING_POSTGRES_IMAGE,
    postgresVolumeName: `${inputs.inspect.composeProjectName}_${STAGING_POSTGRES_VOLUME}`,
    defaultNetworkName: `${inputs.inspect.composeProjectName}_default`,
  });
}

function runtimeBinding(resolved, postgres) {
  return Object.freeze({
    resolvedComposeSha256: `sha256:${resolved.resolvedComposeSha256}`,
    deploymentConfigSha256: `sha256:${sha256Canonical(resolved.binding)}`,
    livePostgresTarget: Object.freeze({
      containerId: postgres.containerId,
      image: postgres.image,
      imageId: postgres.imageId,
      volumeName: postgres.volumeName,
      networkName: postgres.networkName,
      networkId: postgres.networkId,
      projectionSha256: `sha256:${postgres.projectionSha256}`,
    }),
  });
}

function sameRuntimeBinding(left, right, phase) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    audit0107Fail(
      "AUDIT_0107_RUNTIME_BINDING_CHANGED",
      `Resolved Compose or live Postgres target changed during ${phase}.`,
    );
  }
}

function validateRuntimeBinding(value, inputs) {
  exactKeys(
    value,
    ["resolvedComposeSha256", "deploymentConfigSha256", "livePostgresTarget"],
    "audit runtime binding",
  );
  exactKeys(
    value.livePostgresTarget,
    [
      "containerId",
      "image",
      "imageId",
      "volumeName",
      "networkName",
      "networkId",
      "projectionSha256",
    ],
    "live postgres target binding",
  );
  const expectedConfig = expectedDeploymentConfig(inputs);
  const live = value.livePostgresTarget;
  const projection = {
    containerId: live.containerId,
    image: live.image,
    imageId: live.imageId,
    volumeName: live.volumeName,
    networkName: live.networkName,
    networkId: live.networkId,
  };
  if (
    !/^sha256:[0-9a-f]{64}$/.test(String(value.resolvedComposeSha256)) ||
    value.deploymentConfigSha256 !==
      `sha256:${sha256Canonical(expectedConfig)}` ||
    !/^[0-9a-f]{64}$/.test(String(live.containerId)) ||
    live.image !== expectedConfig.postgresImage ||
    !/^sha256:[0-9a-f]{64}$/.test(String(live.imageId)) ||
    live.volumeName !== expectedConfig.postgresVolumeName ||
    live.networkName !== expectedConfig.defaultNetworkName ||
    !/^[0-9a-f]{64}$/.test(String(live.networkId)) ||
    live.projectionSha256 !== `sha256:${sha256Canonical(projection)}`
  ) {
    audit0107Fail(
      "AUDIT_0107_RUNTIME_BINDING_INVALID",
      "Execution runtime binding is not the canonical resolved Compose and live Postgres target.",
    );
  }
  return Object.freeze({
    ...value,
    livePostgresTarget: Object.freeze({ ...live }),
  });
}

export function validateStagingAudit0107Intent(value, inputs) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "productionTargetsTouched",
      "sourceSha",
      "expectedSchemaFingerprintSha256",
      "transitionInputsSha256",
      "derivedInspectInputsSha256",
      "backupExecutionSha256",
      "runtimeBinding",
      "lineage",
      "backupEvidence",
      "backupIntegrity",
      "confirmation",
      "authorizesOnly",
      "authorizesApplicationStart",
    ],
    "audit 0107 intent",
  );
  exactKeys(
    value.lineage,
    ["mode", "opaqueLegacyRows", "opaqueLegacyRowsSha256"],
    "audit intent lineage",
  );
  const lineage = canonicalOpaqueLegacyRows(
    value.lineage.opaqueLegacyRows,
    value.lineage.mode,
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-audit-0107-intent" ||
    value.productionTargetsTouched !== false ||
    value.sourceSha !== inputs.sourceSha ||
    value.expectedSchemaFingerprintSha256 !==
      inputs.backup.expectedSchemaFingerprintSha256 ||
    value.transitionInputsSha256 !== `sha256:${inputs.transitionSha256}` ||
    value.derivedInspectInputsSha256 !== `sha256:${inputs.inspectSha256}` ||
    value.backupExecutionSha256 !== `sha256:${inputs.backupExecutionSha256}` ||
    value.lineage.mode !== inputs.lineage.mode ||
    lineage.opaqueLegacyRowsJson !== inputs.lineage.opaqueLegacyRowsJson ||
    value.lineage.opaqueLegacyRowsSha256 !==
      inputs.lineage.opaqueLegacyRowsSha256 ||
    canonicalJson(value.backupEvidence) !==
      canonicalJson(inputs.transition.backupEvidence) ||
    canonicalJson(value.backupIntegrity) !==
      canonicalJson({
        schemaVersion: "site-logbook.audit-schema-backup-integrity/v1",
        verifiedTableNames: inputs.backup.verifiedTableNames,
        verifiedTableCounts: inputs.backup.sourceTableCounts,
        verifiedTableCountsSha256: inputs.backup.verifiedTableCountsSha256,
        backupRowBindingSha256: inputs.backup.backupRowBindingSha256,
      }) ||
    value.confirmation !== AUDIT_0107.confirmation ||
    value.authorizesOnly !== "isolated-exact-0106-to-0107-audit-transition" ||
    value.authorizesApplicationStart !== false
  ) {
    audit0107Fail(
      "AUDIT_0107_INTENT_INVALID",
      "Canonical intent does not bind the exact reviewed transition chain.",
    );
  }
  return Object.freeze({
    ...value,
    runtimeBinding: validateRuntimeBinding(value.runtimeBinding, inputs),
  });
}

function parseSingleMarker(stdout, prefix, label) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) {
    audit0107Fail(
      "AUDIT_0107_MARKER_INVALID",
      `${label} must emit exactly one approved marker.`,
    );
  }
  try {
    return JSON.parse(lines[0].slice(prefix.length));
  } catch {
    audit0107Fail(
      "AUDIT_0107_MARKER_INVALID",
      `${label} marker must contain strict JSON.`,
    );
  }
}

function validateSchemaSummary(value, targetPresent, inputs) {
  exactKeys(
    value,
    [
      "targetTag",
      "targetSqlSha256",
      "targetSnapshotSha256",
      "auditEventRows",
      "auditOutboxRows",
      "auditHeadRows",
      "expectedSchemaFingerprintSha256",
      "schemaFingerprintSha256",
    ],
    "audit schema summary",
  );
  if (
    value.targetTag !== AUDIT_0107.targetTag ||
    value.targetSqlSha256 !== `sha256:${AUDIT_0107.migrationSha256}` ||
    value.targetSnapshotSha256 !==
      `sha256:${AUDIT_0107.targetSnapshotSha256}` ||
    value.expectedSchemaFingerprintSha256 !==
      inputs.backup.expectedSchemaFingerprintSha256 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.schemaFingerprintSha256)) ||
    (targetPresent &&
      value.schemaFingerprintSha256 !==
        value.expectedSchemaFingerprintSha256) ||
    (!targetPresent &&
      value.schemaFingerprintSha256 ===
        value.expectedSchemaFingerprintSha256) ||
    !Number.isSafeInteger(value.auditEventRows) ||
    value.auditEventRows < 0 ||
    !Number.isSafeInteger(value.auditOutboxRows) ||
    value.auditOutboxRows < 0 ||
    value.auditHeadRows !== (targetPresent ? 1 : 0) ||
    (!targetPresent &&
      (value.auditEventRows !== 0 || value.auditOutboxRows !== 0))
  ) {
    audit0107Fail(
      "AUDIT_0107_SCHEMA_SUMMARY_INVALID",
      "Audit schema summary does not match the exact transition boundary.",
    );
  }
  return Object.freeze(value);
}

function validateBackupIntegrity(value, inputs, label) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "verifiedTableNames",
      "verifiedTableCounts",
      "verifiedTableCountsSha256",
      "backupRowBindingSha256",
    ],
    label,
  );
  if (
    value.schemaVersion !== "site-logbook.audit-schema-backup-integrity/v1" ||
    canonicalJson(value.verifiedTableNames) !==
      canonicalJson(inputs.backup.verifiedTableNames) ||
    canonicalJson(value.verifiedTableCounts) !==
      canonicalJson(inputs.backup.sourceTableCounts) ||
    canonicalJson(value.verifiedTableCounts) !==
      canonicalJson(inputs.backup.restoredTableCounts) ||
    value.verifiedTableCountsSha256 !==
      inputs.backup.verifiedTableCountsSha256 ||
    value.backupRowBindingSha256 !== inputs.backup.backupRowBindingSha256
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_INTEGRITY_INVALID",
      "Database backup integrity evidence is not the exact frozen backup execution snapshot.",
    );
  }
  return Object.freeze({
    ...value,
    verifiedTableNames: Object.freeze([...value.verifiedTableNames]),
    verifiedTableCounts: Object.freeze({ ...value.verifiedTableCounts }),
  });
}

function validateInventory(value, inputs, allowAlready0107) {
  exactKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "decision",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "lineage",
      "schema",
      "backupIntegrity",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "authorizesApplicationStart",
    ],
    "audit inventory",
  );
  const already = value.decision === "ALREADY_0107";
  if (
    value.kind !== "audit-schema-inventory" ||
    value.schemaVersion !== "site-logbook.audit-schema-inventory/v1" ||
    !["READY_0106", "ALREADY_0107"].includes(value.decision) ||
    (already && !allowAlready0107) ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== inputs.sourceSha ||
    value.backupEvidenceId !== inputs.backup.backupId ||
    typeof value.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(value.backupRestoreAgeHours) ||
    value.backupRestoreAgeHours < 0 ||
    value.backupRestoreAgeHours > inputs.inspect.backupRestoreMaxAgeHours ||
    value.authorizesApplicationStart !== false
  ) {
    audit0107Fail(
      "AUDIT_0107_INVENTORY_INVALID",
      "Pre-transition inventory is not the reviewed exact-0106 or recoverable exact-0107 state.",
    );
  }
  validateLineageSummary(
    value.lineage,
    inputs.lineage,
    already ? AUDIT_0107.targetCount : AUDIT_0107.predecessorCount,
  );
  const backupIntegrity = validateBackupIntegrity(
    value.backupIntegrity,
    inputs,
    "audit inventory backup integrity",
  );
  validateSchemaSummary(value.schema, already, inputs);
  return Object.freeze({ ...value, backupIntegrity });
}

function validateGate(value, inputs, operation) {
  exactKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "mode",
      "decision",
      "before",
      "after",
      "newlyApplied",
      "migration",
      "transition",
      "authorizesApplicationStart",
    ],
    "audit schema gate",
  );
  exactKeys(
    value.before,
    [
      "decision",
      "knownAppliedMigrations",
      "knownAppliedRowsSha256",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
    ],
    "audit gate before",
  );
  exactKeys(
    value.migration,
    ["idx", "when", "tag", "sha256"],
    "audit gate migration",
  );
  const expectedMode = operation === "applied" ? "APPLIED" : "NOOP";
  if (
    value.kind !== "audit-schema-gate" ||
    value.schemaVersion !== "site-logbook.audit-schema-gate/v1" ||
    value.mode !== expectedMode ||
    value.decision !== "ALREADY_0107" ||
    !["READY_0106", "ALREADY_0107"].includes(value.before.decision) ||
    value.before.knownAppliedMigrations !==
      (operation === "applied"
        ? AUDIT_0107.predecessorCount
        : AUDIT_0107.targetCount) ||
    value.before.knownAppliedRowsSha256 !==
      (operation === "applied"
        ? AUDIT_0107.predecessorKnownRowsSha256
        : AUDIT_0107.targetKnownRowsSha256) ||
    value.before.opaqueLegacyRowCount !==
      inputs.lineage.opaqueLegacyRows.length ||
    value.before.opaqueLegacyRowsSha256 !==
      inputs.lineage.opaqueLegacyRowsSha256 ||
    value.newlyApplied !== (operation === "applied" ? 1 : 0) ||
    value.migration.idx !== AUDIT_0107.targetIdx ||
    value.migration.when !== AUDIT_0107.targetWhen ||
    value.migration.tag !== AUDIT_0107.targetTag ||
    value.migration.sha256 !== `sha256:${AUDIT_0107.migrationSha256}` ||
    value.authorizesApplicationStart !== true
  ) {
    audit0107Fail(
      "AUDIT_0107_GATE_INVALID",
      "Schema gate evidence does not prove the exact reviewed transition.",
    );
  }
  const after = validateSteadySummary(value.after, inputs);
  if (
    (operation === "applied" &&
      value.before.knownAppliedRowsSha256 ===
        after.lineage.knownAppliedRowsSha256) ||
    (operation === "verified-noop" &&
      value.before.knownAppliedRowsSha256 !==
        after.lineage.knownAppliedRowsSha256)
  ) {
    audit0107Fail(
      "AUDIT_0107_GATE_INVALID",
      "Known migration digests do not match the APPLIED/NOOP operation.",
    );
  }
  const transition = validateTransitionEvidence(value.transition, inputs);
  const backupEvidence = transition.backupEvidence;
  const backupIntegrity = transition.backupIntegrity;
  return Object.freeze({
    schemaGate: Object.freeze({ ...value, after, transition }),
    backupEvidence,
    backupIntegrity,
  });
}

function validateTransitionEvidence(value, inputs) {
  exactKeys(
    value,
    [
      "inputSha256",
      "sourceBackupExecutionSha256",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "backupRestoreMaxAgeHours",
      "backupMaxPayloadBytes",
      "backupSizeBytes",
      "backupEvidence",
      "backupIntegrity",
    ],
    "audit gate transition",
  );
  if (
    value.inputSha256 !== `sha256:${inputs.transitionSha256}` ||
    value.sourceBackupExecutionSha256 !==
      `sha256:${inputs.backupExecutionSha256}` ||
    value.backupEvidenceId !== inputs.backup.backupId ||
    typeof value.backupRestoreAgeHours !== "number" ||
    value.backupRestoreAgeHours < 0 ||
    value.backupRestoreAgeHours > inputs.inspect.backupRestoreMaxAgeHours ||
    value.backupRestoreMaxAgeHours !==
      inputs.inspect.backupRestoreMaxAgeHours ||
    value.backupMaxPayloadBytes !== AUDIT_0107.maxPayloadBytes ||
    value.backupSizeBytes !== inputs.backup.sizeBytes
  ) {
    audit0107Fail(
      "AUDIT_0107_GATE_TRANSITION_INVALID",
      "Gate transition evidence is not bound to the reviewed input and backup execution.",
    );
  }
  return Object.freeze({
    ...value,
    backupEvidence: validateRichBackup(value.backupEvidence, inputs),
    backupIntegrity: validateBackupIntegrity(
      value.backupIntegrity,
      inputs,
      "audit gate transition backup integrity",
    ),
  });
}

function validateSteadySummary(value, inputs) {
  exactKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "decision",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "lineage",
      "schema",
      "authorizesApplicationStart",
    ],
    "audit steady summary",
  );
  if (
    value.kind !== "audit-schema-steady-state" ||
    value.schemaVersion !== "site-logbook.audit-schema-steady-state/v1" ||
    value.decision !== "ALREADY_0107" ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== inputs.sourceSha ||
    value.authorizesApplicationStart !== true
  ) {
    audit0107Fail(
      "AUDIT_0107_STEADY_INVALID",
      "Post-transition steady summary is not exact 0107.",
    );
  }
  validateLineageSummary(value.lineage, inputs.lineage, AUDIT_0107.targetCount);
  validateSchemaSummary(value.schema, true, inputs);
  return Object.freeze(value);
}

function validateRichBackup(value, inputs) {
  exactKeys(
    value,
    [
      "id",
      "sizeBytes",
      "encryptedBackupSha256",
      "encryptionFormat",
      "encryptionKeyIdFingerprint",
      "objectPathFingerprint",
      "createdAt",
      "restoreTestedAt",
      "checkedAt",
      "restoreAgeHours",
      "restoreDurationMs",
      "verifiedTableCount",
      "verifiedTablesSha256",
      "destructiveRestorePerformed",
    ],
    "audit transition backup evidence",
  );
  const createdAt = canonicalTimestamp(value.createdAt, "backup createdAt");
  const restoreTestedAt = canonicalTimestamp(
    value.restoreTestedAt,
    "backup restoreTestedAt",
  );
  const checkedAt = canonicalTimestamp(value.checkedAt, "backup checkedAt");
  if (
    value.id !== inputs.backup.backupId ||
    value.sizeBytes !== inputs.backup.sizeBytes ||
    value.encryptedBackupSha256 !== inputs.backup.encryptedBackupSha256 ||
    value.encryptionFormat !== inputs.backup.encryptionFormat ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.encryptionKeyIdFingerprint)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.objectPathFingerprint)) ||
    typeof value.restoreAgeHours !== "number" ||
    value.restoreAgeHours < 0 ||
    value.restoreAgeHours > inputs.inspect.backupRestoreMaxAgeHours ||
    value.createdAt !== inputs.backup.createdAt ||
    value.restoreTestedAt !== inputs.backup.restoreTestedAt ||
    value.restoreDurationMs !== inputs.backup.restoreDurationMs ||
    value.verifiedTableCount !== inputs.backup.verifiedTableCount ||
    value.verifiedTablesSha256 !== inputs.backup.verifiedTableCountsSha256 ||
    value.destructiveRestorePerformed !== false ||
    createdAt > restoreTestedAt ||
    restoreTestedAt > checkedAt
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_EVIDENCE_INVALID",
      "Gate backup evidence is not bound to the fresh exact-0106 execution.",
    );
  }
  return Object.freeze(value);
}

function ensureIntent(directory, value) {
  const bytes = canonicalJson(value);
  const digest = sha256(Buffer.from(bytes, "utf8"));
  const target = path.join(directory, AUDIT_0107_FILES.intent);
  const checksum = path.join(directory, AUDIT_0107_FILES.intentChecksum);
  const targetExists = fs.existsSync(target);
  const checksumExists = fs.existsSync(checksum);
  if (targetExists !== checksumExists) {
    audit0107Fail(
      "AUDIT_0107_INTENT_PARTIAL",
      "A partial transition intent exists; preserve it for review.",
    );
  }
  if (targetExists) {
    if (
      fs.readFileSync(target, "utf8") !== bytes ||
      fs.readFileSync(checksum, "utf8") !==
        `${digest}  ${AUDIT_0107_FILES.intent}\n`
    ) {
      audit0107Fail(
        "AUDIT_0107_INTENT_MISMATCH",
        "Existing transition intent differs from the reviewed artifact chain.",
      );
    }
    return Object.freeze({ sha256: digest, reused: true });
  }
  atomicWriteExclusive(directory, AUDIT_0107_FILES.intent, bytes);
  atomicWriteExclusive(
    directory,
    AUDIT_0107_FILES.intentChecksum,
    `${digest}  ${AUDIT_0107_FILES.intent}\n`,
  );
  return Object.freeze({ sha256: digest, reused: false });
}

export function validateStagingAudit0107Execution(value, inputs) {
  try {
    exactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "decision",
        "operation",
        "productionTargetsTouched",
        "startedAt",
        "completedAt",
        "sourceSha",
        "expectedSchemaFingerprintSha256",
        "transitionInputsSha256",
        "derivedInspectInputsSha256",
        "backupExecutionSha256",
        "intentSha256",
        "runtimeBinding",
        "schemaGate",
        "backupEvidence",
        "backupIntegrity",
        "lineage",
        "runtimeIsolation",
        "migration0107AppliedOrVerified",
        "authorizesApplicationStart",
        "nextGate",
      ],
      "audit 0107 execution",
    );
    exactKeys(
      value.lineage,
      [
        "mode",
        "knownMigrationCount",
        "totalJournalRows",
        "opaqueLegacyRows",
        "opaqueLegacyRowsSha256",
        "opaqueLegacyMeaningInferred",
      ],
      "execution lineage",
    );
    exactKeys(
      value.runtimeIsolation,
      [
        "exactApprovedContainersAtObservedBoundaries",
        "samePostgresContainerAtObservedBoundaries",
        "continuousIsolationInferred",
        "apiStarted",
        "webStarted",
        "auditSchema0107GateStartedOnlyAsOneShot",
      ],
      "execution runtime isolation",
    );
    const lineage = canonicalOpaqueLegacyRows(
      value.lineage.opaqueLegacyRows,
      value.lineage.mode,
    );
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "site-logbook-staging-audit-0107-execution" ||
      value.decision !== "PASS" ||
      !["applied", "verified-noop"].includes(value.operation) ||
      value.productionTargetsTouched !== false ||
      canonicalTimestamp(value.startedAt, "execution startedAt") >
        canonicalTimestamp(value.completedAt, "execution completedAt") ||
      value.sourceSha !== inputs.sourceSha ||
      value.expectedSchemaFingerprintSha256 !==
        inputs.backup.expectedSchemaFingerprintSha256 ||
      value.transitionInputsSha256 !== `sha256:${inputs.transitionSha256}` ||
      value.derivedInspectInputsSha256 !== `sha256:${inputs.inspectSha256}` ||
      value.backupExecutionSha256 !==
        `sha256:${inputs.backupExecutionSha256}` ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.intentSha256)) ||
      value.lineage.knownMigrationCount !== AUDIT_0107.targetCount ||
      value.lineage.totalJournalRows !== lineage.totalJournalRows ||
      value.lineage.opaqueLegacyRowsSha256 !== lineage.opaqueLegacyRowsSha256 ||
      value.lineage.opaqueLegacyMeaningInferred !== false ||
      value.runtimeIsolation.exactApprovedContainersAtObservedBoundaries !==
        true ||
      value.runtimeIsolation.samePostgresContainerAtObservedBoundaries !==
        true ||
      value.runtimeIsolation.continuousIsolationInferred !== false ||
      value.runtimeIsolation.apiStarted !== false ||
      value.runtimeIsolation.webStarted !== false ||
      value.runtimeIsolation.auditSchema0107GateStartedOnlyAsOneShot !== true ||
      value.migration0107AppliedOrVerified !== true ||
      value.authorizesApplicationStart !== false ||
      value.nextGate !== "audit-0107-release-evidence-required"
    ) {
      audit0107Fail(
        "AUDIT_0107_EXECUTION_INVALID",
        "Execution evidence does not preserve the exact audit transition contract.",
      );
    }
    const gate = validateGate(value.schemaGate, inputs, value.operation);
    const backup = validateRichBackup(value.backupEvidence, inputs);
    const backupIntegrity = validateBackupIntegrity(
      value.backupIntegrity,
      inputs,
      "audit execution backup integrity",
    );
    const validatedRuntimeBinding = validateRuntimeBinding(
      value.runtimeBinding,
      inputs,
    );
    if (canonicalJson(gate.backupEvidence) !== canonicalJson(backup)) {
      audit0107Fail(
        "AUDIT_0107_EXECUTION_BACKUP_MISMATCH",
        "Root and schema-gate backup evidence must be byte-identical.",
      );
    }
    if (
      canonicalJson(gate.backupIntegrity) !== canonicalJson(backupIntegrity)
    ) {
      audit0107Fail(
        "AUDIT_0107_EXECUTION_BACKUP_INTEGRITY_MISMATCH",
        "Root and schema-gate backup integrity must be byte-identical.",
      );
    }
    return Object.freeze({
      ...value,
      runtimeBinding: validatedRuntimeBinding,
    });
  } catch (error) {
    wrap(error);
  }
}

export function runStagingAudit0107Transition({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  outputDirectory,
  expectedSourceSha,
  confirmation,
  transitionBytes,
  transitionChecksumText,
  expectedTransitionSha256,
  inspectBytes,
  inspectChecksumText,
  expectedInspectSha256,
  backupExecutionBytes,
  backupExecutionChecksumText,
  expectedBackupExecutionSha256,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  try {
    if (confirmation !== AUDIT_0107.confirmation) {
      audit0107Fail(
        "AUDIT_0107_CONFIRMATION_INVALID",
        "The distinct exact-0107 audit transition confirmation is required.",
      );
    }
    const inputs = validateStagingAudit0107TransitionArtifacts({
      expectedSourceSha,
      transitionBytes,
      transitionChecksumText,
      expectedTransitionSha256,
      inspectBytes,
      inspectChecksumText,
      expectedInspectSha256,
      backupExecutionBytes,
      backupExecutionChecksumText,
      expectedBackupExecutionSha256,
    });
    const output = prepareExclusiveOutput(outputDirectory, [
      AUDIT_0107_FILES.execution,
      AUDIT_0107_FILES.executionChecksum,
    ]);
    const composeArgs = [
      "compose",
      "--env-file",
      path.resolve(envFile),
      "-f",
      path.resolve(composeFile),
      "--profile",
      "audit-0107-transition",
    ];
    const sourceResolved = resolveCompose(execute, composeArgs, inputs);
    let inventoryFrozen;
    let transitionFrozen;
    let transitionResult;
    let primaryError;
    let cleanupError;
    try {
      inventoryFrozen = freezeRenderedCompose({
        resolvedValue: sourceResolved.value,
        projectName: inputs.inspect.composeProjectName,
        profile: "audit-0107-transition",
        targetService: "audit-schema-gate",
        environmentOverrides: {
          AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: "",
          AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256:
            inputs.backup.expectedSchemaFingerprintSha256,
          AUDIT_SCHEMA_LINEAGE_MODE: inputs.lineage.mode,
          AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON:
            inputs.lineage.opaqueLegacyRowsJson,
        },
        commandOverride: ["node", "dist/audit-schema-inventory.mjs"],
        label: "pre-transition audit inventory",
      });
      transitionFrozen = freezeRenderedCompose({
        resolvedValue: sourceResolved.value,
        projectName: inputs.inspect.composeProjectName,
        profile: "audit-0107-transition",
        targetService: "audit-schema-gate",
        environmentOverrides: {
          STAGING_AUDIT_SCHEMA_ACTION: AUDIT_0107.action,
          AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256:
            inputs.backup.expectedSchemaFingerprintSha256,
          AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: AUDIT_0107.confirmation,
          AUDIT_SCHEMA_LINEAGE_MODE: inputs.lineage.mode,
          AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON:
            inputs.lineage.opaqueLegacyRowsJson,
          STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256: inputs.transitionSha256,
          STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256:
            inputs.backupExecutionSha256,
          STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES: String(
            inputs.backup.maxPayloadBytes,
          ),
          STAGING_EXACT_0106_BACKUP_SIZE_BYTES: String(inputs.backup.sizeBytes),
        },
        label: "audit 0107 transition gate",
      });
    } catch (error) {
      if (inventoryFrozen) {
        try {
          cleanupFrozenCompose(inventoryFrozen);
        } catch (cleanupError) {
          Object.defineProperty(error, "cleanupError", {
            value: cleanupError,
            enumerable: false,
          });
        }
      }
      throw error;
    }
    try {
      const transitionResolved = Object.freeze({
        binding: sourceResolved.binding,
        resolvedComposeSha256: transitionFrozen.resolvedSha256,
      });
      const initialPostgres = assertOnlyPostgresRunning(
        execute,
        transitionFrozen.composeArgs,
        sourceResolved.binding,
        "initial observed-boundary check",
      );
      const boundary = (oneShotContainerId, phase) =>
        assertApprovedDockerBoundary({
          runDocker: (args, label, options) =>
            checked(execute, args, label, options),
          postgres: initialPostgres,
          projectName: inputs.inspect.composeProjectName,
          oneShotContainerId,
          phase,
        });
      boundary(undefined, "initial observed boundary");
      const initialRuntimeBinding = runtimeBinding(
        transitionResolved,
        initialPostgres,
      );
      const hasIntent =
        fs.existsSync(path.join(output, AUDIT_0107_FILES.intent)) &&
        fs.existsSync(path.join(output, AUDIT_0107_FILES.intentChecksum));
      const inventoryStdout = runFrozenComposeOneShot({
        runDocker: (args, label, options) =>
          checked(execute, args, label, options),
        frozen: inventoryFrozen,
        assertBoundary: boundary,
      });
      validateInventory(
        parseSingleMarker(
          inventoryStdout,
          "[audit-schema-inventory] PASS ",
          "audit inventory",
        ),
        inputs,
        hasIntent,
      );
      const preStatefulPostgres = assertOnlyPostgresRunning(
        execute,
        transitionFrozen.composeArgs,
        sourceResolved.binding,
        "pre-transition observed-boundary check",
        initialPostgres.containerId,
      );
      const preStatefulRuntimeBinding = runtimeBinding(
        transitionResolved,
        preStatefulPostgres,
      );
      sameRuntimeBinding(
        initialRuntimeBinding,
        preStatefulRuntimeBinding,
        "pre-transition revalidation",
      );
      const intentValue = Object.freeze({
        schemaVersion: 1,
        kind: "site-logbook-staging-audit-0107-intent",
        productionTargetsTouched: false,
        sourceSha: inputs.sourceSha,
        expectedSchemaFingerprintSha256:
          inputs.backup.expectedSchemaFingerprintSha256,
        transitionInputsSha256: `sha256:${inputs.transitionSha256}`,
        derivedInspectInputsSha256: `sha256:${inputs.inspectSha256}`,
        backupExecutionSha256: `sha256:${inputs.backupExecutionSha256}`,
        runtimeBinding: preStatefulRuntimeBinding,
        lineage: Object.freeze({
          mode: inputs.lineage.mode,
          opaqueLegacyRows: inputs.lineage.opaqueLegacyRows,
          opaqueLegacyRowsSha256: inputs.lineage.opaqueLegacyRowsSha256,
        }),
        backupEvidence: inputs.transition.backupEvidence,
        backupIntegrity: Object.freeze({
          schemaVersion: "site-logbook.audit-schema-backup-integrity/v1",
          verifiedTableNames: inputs.backup.verifiedTableNames,
          verifiedTableCounts: inputs.backup.sourceTableCounts,
          verifiedTableCountsSha256: inputs.backup.verifiedTableCountsSha256,
          backupRowBindingSha256: inputs.backup.backupRowBindingSha256,
        }),
        confirmation: AUDIT_0107.confirmation,
        authorizesOnly: "isolated-exact-0106-to-0107-audit-transition",
        authorizesApplicationStart: false,
      });
      const intent = ensureIntent(
        output,
        validateStagingAudit0107Intent(intentValue, inputs),
      );
      const startedAt = now().toISOString();
      const stdout = runFrozenComposeOneShot({
        runDocker: (args, label, options) =>
          checked(execute, args, label, options),
        frozen: transitionFrozen,
        assertBoundary: boundary,
      });
      const finalPostgres = assertOnlyPostgresRunning(
        execute,
        transitionFrozen.composeArgs,
        sourceResolved.binding,
        "final observed-boundary check",
        preStatefulPostgres.containerId,
      );
      const finalRuntimeBinding = runtimeBinding(
        transitionResolved,
        finalPostgres,
      );
      sameRuntimeBinding(
        preStatefulRuntimeBinding,
        finalRuntimeBinding,
        "post-transition revalidation",
      );
      const appliedPrefix = "[audit-schema-gate] APPLIED ";
      const noopPrefix = "[audit-schema-gate] NOOP ";
      const applied = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(appliedPrefix));
      const noop = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(noopPrefix));
      if (applied.length + noop.length !== 1) {
        audit0107Fail(
          "AUDIT_0107_MARKER_INVALID",
          "Transition gate must emit exactly one APPLIED or NOOP marker.",
        );
      }
      const operation = applied.length === 1 ? "applied" : "verified-noop";
      if (operation === "verified-noop" && !intent.reused) {
        audit0107Fail(
          "AUDIT_0107_UNEXPECTED_NOOP",
          "A first-attempt NOOP cannot prove this runner performed the transition.",
        );
      }
      const gate = validateGate(
        parseSingleMarker(
          stdout,
          applied.length === 1 ? appliedPrefix : noopPrefix,
          "audit transition gate",
        ),
        inputs,
        operation,
      );
      const completedAt = now().toISOString();
      if (
        canonicalTimestamp(completedAt, "completedAt") <
        canonicalTimestamp(startedAt, "startedAt")
      ) {
        audit0107Fail(
          "AUDIT_0107_TIME_INVALID",
          "completedAt must not precede startedAt.",
        );
      }
      const execution = Object.freeze({
        schemaVersion: 1,
        kind: "site-logbook-staging-audit-0107-execution",
        decision: "PASS",
        operation,
        productionTargetsTouched: false,
        startedAt,
        completedAt,
        sourceSha: inputs.sourceSha,
        expectedSchemaFingerprintSha256:
          inputs.backup.expectedSchemaFingerprintSha256,
        transitionInputsSha256: `sha256:${inputs.transitionSha256}`,
        derivedInspectInputsSha256: `sha256:${inputs.inspectSha256}`,
        backupExecutionSha256: `sha256:${inputs.backupExecutionSha256}`,
        intentSha256: `sha256:${intent.sha256}`,
        runtimeBinding: finalRuntimeBinding,
        schemaGate: gate.schemaGate,
        backupEvidence: gate.backupEvidence,
        backupIntegrity: gate.backupIntegrity,
        lineage: Object.freeze({
          mode: inputs.lineage.mode,
          knownMigrationCount: AUDIT_0107.targetCount,
          totalJournalRows: inputs.lineage.totalJournalRows,
          opaqueLegacyRows: inputs.lineage.opaqueLegacyRows,
          opaqueLegacyRowsSha256: inputs.lineage.opaqueLegacyRowsSha256,
          opaqueLegacyMeaningInferred: false,
        }),
        runtimeIsolation: Object.freeze({
          exactApprovedContainersAtObservedBoundaries: true,
          samePostgresContainerAtObservedBoundaries: true,
          continuousIsolationInferred: false,
          apiStarted: false,
          webStarted: false,
          auditSchema0107GateStartedOnlyAsOneShot: true,
        }),
        migration0107AppliedOrVerified: true,
        authorizesApplicationStart: false,
        nextGate: "audit-0107-release-evidence-required",
      });
      validateStagingAudit0107Execution(execution, inputs);
      const files = writeCanonicalPair(
        output,
        AUDIT_0107_FILES.execution,
        AUDIT_0107_FILES.executionChecksum,
        execution,
      );
      transitionResult = Object.freeze({ execution, files });
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        cleanupFrozenCompose(transitionFrozen);
      } catch (error) {
        cleanupError = error;
      }
      try {
        cleanupFrozenCompose(inventoryFrozen);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (primaryError && cleanupError) {
      Object.defineProperty(primaryError, "cleanupError", {
        value: cleanupError,
        enumerable: false,
      });
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
    return transitionResult;
  } catch (error) {
    wrap(error);
  }
}

function main() {
  const transition = readRegularFile(
    requiredArgument("--transition-inputs"),
    "transition inputs",
  );
  const transitionChecksum = readRegularFile(
    requiredArgument("--transition-inputs-checksum"),
    "transition checksum",
  );
  const inspect = readRegularFile(
    requiredArgument("--inspect-inputs"),
    "derived inspect inputs",
  );
  const inspectChecksum = readRegularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "derived inspect checksum",
  );
  const backup = readRegularFile(
    requiredArgument("--backup-execution"),
    "backup execution",
  );
  const backupChecksum = readRegularFile(
    requiredArgument("--backup-execution-checksum"),
    "backup execution checksum",
  );
  const result = runStagingAudit0107Transition({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    outputDirectory: requiredArgument("--output-dir"),
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    confirmation: requiredArgument("--confirm"),
    transitionBytes: fs.readFileSync(transition),
    transitionChecksumText: fs.readFileSync(transitionChecksum, "utf8"),
    expectedTransitionSha256: requiredArgument(
      "--expected-transition-inputs-sha256",
    ),
    inspectBytes: fs.readFileSync(inspect),
    inspectChecksumText: fs.readFileSync(inspectChecksum, "utf8"),
    expectedInspectSha256: requiredArgument("--expected-inspect-inputs-sha256"),
    backupExecutionBytes: fs.readFileSync(backup),
    backupExecutionChecksumText: fs.readFileSync(backupChecksum, "utf8"),
    expectedBackupExecutionSha256: requiredArgument(
      "--expected-backup-execution-sha256",
    ),
  });
  process.stdout.write(
    `${JSON.stringify({ decision: result.execution.decision, operation: result.execution.operation, files: result.files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const failure =
      error instanceof StagingAudit0107TransitionRunnerError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-audit-0107-transition] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
