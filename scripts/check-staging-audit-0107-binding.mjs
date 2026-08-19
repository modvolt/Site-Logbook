import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploymentInputsSha256,
  STAGING_POSTGRES_IMAGE,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import {
  canonicalJson,
  sha256Canonical,
} from "./check-staging-provisioning.mjs";
import {
  argument,
  AUDIT_0107,
  AUDIT_0107_FILES,
  audit0107Fail,
  atomicWriteExclusive,
  canonicalOpaqueLegacyRows,
  canonicalTimestamp,
  exactKeys,
  parseOpaqueLegacyRowsJson,
  positiveInteger,
  prepareExclusiveOutput,
  readRegularFile,
  requiredArgument,
  trustedCanonicalArtifact,
  validateLineageSummary,
} from "./staging-audit-0107-contract.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function validateBackupTableCountEvidence(value) {
  const names = value.verifiedTableNames;
  const source = value.sourceTableCounts;
  const restored = value.restoredTableCounts;
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length !== value.verifiedTableCount ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/.test(name),
    ) ||
    JSON.stringify(names) !== JSON.stringify([...names].sort()) ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !restored ||
    typeof restored !== "object" ||
    Array.isArray(restored)
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_TABLE_COUNTS_INVALID",
      "Backup table-count evidence must be one canonical exact table set.",
    );
  }
  const sourceKeys = Object.keys(source);
  const restoredKeys = Object.keys(restored);
  if (
    JSON.stringify(sourceKeys) !== JSON.stringify(names) ||
    JSON.stringify(restoredKeys) !== JSON.stringify(names) ||
    names.some(
      (name) =>
        !Number.isSafeInteger(source[name]) ||
        source[name] < 0 ||
        source[name] !== restored[name],
    ) ||
    canonicalJson(source) !== canonicalJson(restored)
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_TABLE_COUNTS_MISMATCH",
      "Source and restored counts must be byte-equivalent for every exact table.",
    );
  }
  const digest = `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex")}`;
  if (
    value.verifiedTableCountsSha256 !== digest ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.backupRowBindingSha256))
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_TABLE_COUNTS_HASH_MISMATCH",
      "Backup table counts and immutable row binding require exact SHA-256 identities.",
    );
  }
  return Object.freeze({
    verifiedTableCount: names.length,
    verifiedTableNames: Object.freeze([...names]),
    sourceTableCounts: Object.freeze({ ...source }),
    restoredTableCounts: Object.freeze({ ...restored }),
    verifiedTableCountsSha256: digest,
    backupRowBindingSha256: value.backupRowBindingSha256,
  });
}

export class StagingAudit0107BindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAudit0107BindingError";
    this.code = code;
  }
}

function validateBackupRuntimeBinding(value) {
  exactKeys(
    value,
    ["resolvedComposeSha256", "deploymentConfigSha256", "livePostgresTarget"],
    "backup runtime binding",
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
    "backup live postgres target",
  );
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
    !/^sha256:[0-9a-f]{64}$/.test(String(value.deploymentConfigSha256)) ||
    !/^[0-9a-f]{64}$/.test(String(live.containerId)) ||
    live.image !== STAGING_POSTGRES_IMAGE ||
    !/^sha256:[0-9a-f]{64}$/.test(String(live.imageId)) ||
    !/^site-logbook-staging(?:-[a-z0-9-]+)?_staging_pgdata$/.test(
      String(live.volumeName),
    ) ||
    !/^site-logbook-staging(?:-[a-z0-9-]+)?_default$/.test(
      String(live.networkName),
    ) ||
    !/^[0-9a-f]{64}$/.test(String(live.networkId)) ||
    live.projectionSha256 !== `sha256:${sha256Canonical(projection)}`
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_RUNTIME_BINDING_INVALID",
      "Backup execution is not bound to one canonical Compose and live Postgres target.",
    );
  }
  return Object.freeze({
    ...value,
    livePostgresTarget: Object.freeze({ ...live }),
  });
}

function wrap(error) {
  if (error instanceof StagingAudit0107BindingError) throw error;
  const code =
    typeof error?.code === "string" ? error.code : "AUDIT_0107_BINDING_INVALID";
  throw new StagingAudit0107BindingError(
    code,
    error instanceof Error ? error.message : String(error),
  );
}

export function validateExact0106AuditBackupExecution(
  value,
  expectedSourceSha,
  expectedLineage,
) {
  try {
    exactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "decision",
        "productionTargetsTouched",
        "startedAt",
        "completedAt",
        "sourceSha",
        "expectedSchemaFingerprintSha256",
        "inspectDeploymentInputsSha256",
        "runtimeBinding",
        "lineage",
        "gate",
        "runtimeIsolation",
        "nextGate",
        "authorizes0107",
        "authorizesApplicationStart",
      ],
      "exact-0106 audit backup execution",
    );
    exactKeys(
      value.lineage,
      ["mode", "opaqueLegacyRows", "opaqueLegacyRowsSha256"],
      "backup lineage binding",
    );
    exactKeys(
      value.runtimeIsolation,
      [
        "exactApprovedContainersAtObservedBoundaries",
        "samePostgresContainerAtObservedBoundaries",
        "continuousIsolationInferred",
        "apiStarted",
        "webStarted",
        "auditSchema0107GateStarted",
      ],
      "backup runtime isolation",
    );
    const lineage = canonicalOpaqueLegacyRows(
      value.lineage.opaqueLegacyRows,
      value.lineage.mode,
    );
    const startedAt = canonicalTimestamp(value.startedAt, "backup startedAt");
    const completedAt = canonicalTimestamp(
      value.completedAt,
      "backup completedAt",
    );
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "site-logbook-staging-exact-0106-audit-backup-execution" ||
      value.decision !== "PASS" ||
      value.productionTargetsTouched !== false ||
      value.sourceSha !== expectedSourceSha ||
      !SHA40.test(String(value.sourceSha)) ||
      !SHA256.test(String(value.expectedSchemaFingerprintSha256)) ||
      !/^sha256:[0-9a-f]{64}$/.test(
        String(value.inspectDeploymentInputsSha256),
      ) ||
      lineage.mode !== expectedLineage.mode ||
      lineage.opaqueLegacyRowsJson !== expectedLineage.opaqueLegacyRowsJson ||
      value.lineage.opaqueLegacyRowsSha256 !== lineage.opaqueLegacyRowsSha256 ||
      value.runtimeIsolation.exactApprovedContainersAtObservedBoundaries !==
        true ||
      value.runtimeIsolation.samePostgresContainerAtObservedBoundaries !==
        true ||
      value.runtimeIsolation.continuousIsolationInferred !== false ||
      value.runtimeIsolation.apiStarted !== false ||
      value.runtimeIsolation.webStarted !== false ||
      value.runtimeIsolation.auditSchema0107GateStarted !== false ||
      value.nextGate !== "audit-0107-transition-binding-required" ||
      value.authorizes0107 !== false ||
      value.authorizesApplicationStart !== false ||
      startedAt > completedAt
    ) {
      audit0107Fail(
        "AUDIT_0107_BACKUP_EXECUTION_INVALID",
        "Backup execution does not prove the isolated exact-0106 boundary.",
      );
    }
    const gate = validateExact0106BackupGate(
      value.gate,
      expectedSourceSha,
      lineage,
    );
    if (
      canonicalTimestamp(gate.restoreTestedAt, "backup restoreTestedAt") >
      completedAt
    ) {
      audit0107Fail(
        "AUDIT_0107_BACKUP_EXECUTION_INVALID",
        "Backup restore evidence cannot postdate the host execution.",
      );
    }
    const runtimeBinding = validateBackupRuntimeBinding(value.runtimeBinding);
    return Object.freeze({
      sourceSha: value.sourceSha,
      expectedSchemaFingerprintSha256: value.expectedSchemaFingerprintSha256,
      inspectInputsSha256: value.inspectDeploymentInputsSha256.slice(
        "sha256:".length,
      ),
      lineage,
      previousBackupId: gate.previousBackupId,
      backupId: gate.backupId,
      sizeBytes: gate.sizeBytes,
      maxPayloadBytes: gate.maxPayloadBytes,
      encryptedBackupSha256: gate.encryptedBackupSha256,
      encryptionFormat: gate.encryptionFormat,
      createdAt: gate.createdAt,
      restoreTestedAt: gate.restoreTestedAt,
      restoreDurationMs: gate.restoreDurationMs,
      verifiedTableCount: gate.verifiedTableCount,
      verifiedTableNames: gate.verifiedTableNames,
      sourceTableCounts: gate.sourceTableCounts,
      restoredTableCounts: gate.restoredTableCounts,
      verifiedTableCountsSha256: gate.verifiedTableCountsSha256,
      backupRowBindingSha256: gate.backupRowBindingSha256,
      runtimeBinding,
    });
  } catch (error) {
    wrap(error);
  }
}

export function validateExact0106BackupGate(
  value,
  expectedSourceSha,
  expectedLineage,
) {
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
      "expectedMigrations",
      "latestExpectedTag",
      "previousBackupId",
      "backupId",
      "createdAt",
      "restoreTestedAt",
      "restoreDurationMs",
      "verifiedTableCount",
      "verifiedTableNames",
      "sourceTableCounts",
      "restoredTableCounts",
      "verifiedTableCountsSha256",
      "backupRowBindingSha256",
      "sizeBytes",
      "maxPayloadBytes",
      "encryptedBackupSha256",
      "encryptionFormat",
      "retentionPruned",
      "destructiveRestorePerformed",
      "nextGate",
      "authorizes0107",
      "authorizesApplicationStart",
    ],
    "exact-0106 backup gate",
  );
  const createdAt = canonicalTimestamp(value.createdAt, "backup createdAt");
  const restoreTestedAt = canonicalTimestamp(
    value.restoreTestedAt,
    "backup restoreTestedAt",
  );
  const tableCounts = validateBackupTableCountEvidence(value);
  if (
    value.kind !== "audit-schema-exact-0106-backup" ||
    value.schemaVersion !== "site-logbook.audit-schema-exact-0106-backup/v1" ||
    value.decision !== "CREATED_AND_RESTORE_VERIFIED" ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== expectedSourceSha ||
    value.expectedMigrations !== AUDIT_0107.predecessorCount ||
    value.latestExpectedTag !== AUDIT_0107.predecessorTag ||
    positiveInteger(value.previousBackupId, "previous backup id") >=
      positiveInteger(value.backupId, "backup id") ||
    createdAt > restoreTestedAt ||
    positiveInteger(value.restoreDurationMs, "restore duration") < 1 ||
    positiveInteger(value.verifiedTableCount, "verified table count") < 1 ||
    positiveInteger(value.sizeBytes, "backup size") >
      AUDIT_0107.maxPayloadBytes ||
    value.maxPayloadBytes !== AUDIT_0107.maxPayloadBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.encryptedBackupSha256)) ||
    value.encryptionFormat !== "mve1" ||
    value.retentionPruned !== false ||
    value.destructiveRestorePerformed !== false ||
    value.nextGate !== "audit-0107-transition-binding-required" ||
    value.authorizes0107 !== false ||
    value.authorizesApplicationStart !== false
  ) {
    audit0107Fail(
      "AUDIT_0107_BACKUP_GATE_INVALID",
      "Backup marker is not bound to exact 0106 with audit schema absent.",
    );
  }
  validateLineageSummary(
    value.lineage,
    expectedLineage,
    AUDIT_0107.predecessorCount,
  );
  return Object.freeze({ ...value, ...tableCounts });
}

export function validateAudit0107TransitionInputs(value) {
  try {
    exactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "productionTargetsTouched",
        "sourceSha",
        "expectedSchemaFingerprintSha256",
        "action",
        "confirmation",
        "lineage",
        "originalInspectInputsSha256",
        "derivedInspectInputsSha256",
        "backupExecutionSha256",
        "backupEvidence",
        "predecessor",
        "target",
        "authorizesOnly",
      ],
      "audit 0107 transition inputs",
    );
    exactKeys(
      value.lineage,
      ["mode", "opaqueLegacyRows", "opaqueLegacyRowsSha256"],
      "audit transition lineage",
    );
    exactKeys(
      value.backupEvidence,
      [
        "previousId",
        "id",
        "sizeBytes",
        "maxPayloadBytes",
        "createdAt",
        "restoreTestedAt",
        "verifiedTableCount",
        "verifiedTableNames",
        "sourceTableCounts",
        "restoredTableCounts",
        "verifiedTableCountsSha256",
        "backupRowBindingSha256",
      ],
      "audit transition backup evidence",
    );
    exactKeys(
      value.predecessor,
      ["count", "tag", "snapshotId", "snapshotSha256"],
      "audit predecessor",
    );
    exactKeys(
      value.target,
      [
        "count",
        "idx",
        "when",
        "tag",
        "migrationSha256",
        "snapshotId",
        "snapshotSha256",
      ],
      "audit target",
    );
    const lineage = canonicalOpaqueLegacyRows(
      value.lineage.opaqueLegacyRows,
      value.lineage.mode,
    );
    canonicalTimestamp(value.backupEvidence.createdAt, "backup createdAt");
    canonicalTimestamp(
      value.backupEvidence.restoreTestedAt,
      "backup restoreTestedAt",
    );
    const tableCounts = validateBackupTableCountEvidence(value.backupEvidence);
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "site-logbook-staging-audit-0107-transition" ||
      value.productionTargetsTouched !== false ||
      !SHA40.test(String(value.sourceSha)) ||
      !SHA256.test(String(value.expectedSchemaFingerprintSha256)) ||
      value.action !== AUDIT_0107.action ||
      value.confirmation !== AUDIT_0107.confirmation ||
      value.lineage.opaqueLegacyRowsSha256 !== lineage.opaqueLegacyRowsSha256 ||
      !/^sha256:[0-9a-f]{64}$/.test(
        String(value.originalInspectInputsSha256),
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.derivedInspectInputsSha256)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(value.backupExecutionSha256)) ||
      positiveInteger(value.backupEvidence.previousId, "previous backup id") >=
        positiveInteger(value.backupEvidence.id, "backup id") ||
      positiveInteger(value.backupEvidence.sizeBytes, "backup size") >
        AUDIT_0107.maxPayloadBytes ||
      value.backupEvidence.maxPayloadBytes !== AUDIT_0107.maxPayloadBytes ||
      value.predecessor.count !== AUDIT_0107.predecessorCount ||
      value.predecessor.tag !== AUDIT_0107.predecessorTag ||
      value.predecessor.snapshotId !== AUDIT_0107.predecessorSnapshotId ||
      value.predecessor.snapshotSha256 !==
        `sha256:${AUDIT_0107.predecessorSnapshotSha256}` ||
      value.target.count !== AUDIT_0107.targetCount ||
      value.target.idx !== AUDIT_0107.targetIdx ||
      value.target.when !== AUDIT_0107.targetWhen ||
      value.target.tag !== AUDIT_0107.targetTag ||
      value.target.migrationSha256 !== `sha256:${AUDIT_0107.migrationSha256}` ||
      value.target.snapshotId !== AUDIT_0107.targetSnapshotId ||
      value.target.snapshotSha256 !==
        `sha256:${AUDIT_0107.targetSnapshotSha256}` ||
      value.authorizesOnly !== "isolated-exact-0106-to-0107-audit-transition"
    ) {
      audit0107Fail(
        "AUDIT_0107_TRANSITION_INPUTS_INVALID",
        "Transition inputs do not preserve the exact 0106 to 0107 audit boundary.",
      );
    }
    return Object.freeze({
      ...value,
      backupEvidence: Object.freeze({
        ...value.backupEvidence,
        ...tableCounts,
      }),
    });
  } catch (error) {
    wrap(error);
  }
}

export function createStagingAudit0107Binding({
  expectedSourceSha,
  lineageMode,
  opaqueLegacyRowsJson,
  originalInspectBytes,
  originalInspectChecksumText,
  expectedOriginalInspectSha256,
  backupExecutionBytes,
  backupExecutionChecksumText,
  expectedBackupExecutionSha256,
}) {
  try {
    if (!SHA40.test(expectedSourceSha ?? "")) {
      audit0107Fail(
        "AUDIT_0107_SOURCE_INVALID",
        "The exact candidate source SHA is required.",
      );
    }
    const lineage = parseOpaqueLegacyRowsJson(
      opaqueLegacyRowsJson,
      lineageMode,
    );
    const originalArtifact = trustedCanonicalArtifact({
      bytes: originalInspectBytes,
      checksumText: originalInspectChecksumText,
      expectedSha256: expectedOriginalInspectSha256,
      name: "staging-deployment-inspect.json",
      label: "original inspect inputs",
    });
    const originalInspect = validateStagingDeploymentInputs(
      originalArtifact.value,
      {
        expectedSchemaAction: "inspect",
        expectedSourceSha,
      },
    );
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
      backup.inspectInputsSha256 !== originalArtifact.sha256 ||
      backup.previousBackupId !== originalInspect.backupEvidenceId
    ) {
      audit0107Fail(
        "AUDIT_0107_BACKUP_INSPECT_MISMATCH",
        "Fresh backup execution must derive from the exact reviewed inspect inputs and prior backup id.",
      );
    }
    const derivedInspect = validateStagingDeploymentInputs(
      {
        ...structuredClone(originalInspect),
        backupEvidenceId: backup.backupId,
      },
      { expectedSchemaAction: "inspect", expectedSourceSha },
    );
    const derivedInspectSha256 = deploymentInputsSha256(derivedInspect);
    const transition = validateAudit0107TransitionInputs({
      schemaVersion: 1,
      kind: "site-logbook-staging-audit-0107-transition",
      productionTargetsTouched: false,
      sourceSha: expectedSourceSha,
      expectedSchemaFingerprintSha256: backup.expectedSchemaFingerprintSha256,
      action: AUDIT_0107.action,
      confirmation: AUDIT_0107.confirmation,
      lineage: {
        mode: lineage.mode,
        opaqueLegacyRows: lineage.opaqueLegacyRows,
        opaqueLegacyRowsSha256: lineage.opaqueLegacyRowsSha256,
      },
      originalInspectInputsSha256: `sha256:${originalArtifact.sha256}`,
      derivedInspectInputsSha256: `sha256:${derivedInspectSha256}`,
      backupExecutionSha256: `sha256:${backupArtifact.sha256}`,
      backupEvidence: {
        previousId: backup.previousBackupId,
        id: backup.backupId,
        sizeBytes: backup.sizeBytes,
        maxPayloadBytes: backup.maxPayloadBytes,
        createdAt: backup.createdAt,
        restoreTestedAt: backup.restoreTestedAt,
        verifiedTableCount: backup.verifiedTableCount,
        verifiedTableNames: backup.verifiedTableNames,
        sourceTableCounts: backup.sourceTableCounts,
        restoredTableCounts: backup.restoredTableCounts,
        verifiedTableCountsSha256: backup.verifiedTableCountsSha256,
        backupRowBindingSha256: backup.backupRowBindingSha256,
      },
      predecessor: {
        count: AUDIT_0107.predecessorCount,
        tag: AUDIT_0107.predecessorTag,
        snapshotId: AUDIT_0107.predecessorSnapshotId,
        snapshotSha256: `sha256:${AUDIT_0107.predecessorSnapshotSha256}`,
      },
      target: {
        count: AUDIT_0107.targetCount,
        idx: AUDIT_0107.targetIdx,
        when: AUDIT_0107.targetWhen,
        tag: AUDIT_0107.targetTag,
        migrationSha256: `sha256:${AUDIT_0107.migrationSha256}`,
        snapshotId: AUDIT_0107.targetSnapshotId,
        snapshotSha256: `sha256:${AUDIT_0107.targetSnapshotSha256}`,
      },
      authorizesOnly: "isolated-exact-0106-to-0107-audit-transition",
    });
    const transitionSha256 = crypto
      .createHash("sha256")
      .update(canonicalJson(transition))
      .digest("hex");
    return Object.freeze({
      decision: "PASS",
      productionTargetsTouched: false,
      sourceSha: expectedSourceSha,
      originalInspectSha256: originalArtifact.sha256,
      derivedInspect,
      derivedInspectSha256,
      backupExecutionSha256: backupArtifact.sha256,
      transition,
      transitionSha256,
      environment: Object.freeze({
        STAGING_DEPLOYMENT_INPUTS_SHA256: derivedInspectSha256,
        STAGING_BACKUP_EVIDENCE_ID: String(backup.backupId),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(
          derivedInspect.backupRestoreMaxAgeHours,
        ),
        STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256: transitionSha256,
        STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256: backupArtifact.sha256,
        STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES: String(
          backup.maxPayloadBytes,
        ),
        STAGING_EXACT_0106_BACKUP_SIZE_BYTES: String(backup.sizeBytes),
        STAGING_AUDIT_SCHEMA_ACTION: "steady-0107",
        AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256:
          backup.expectedSchemaFingerprintSha256,
        AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: "",
        AUDIT_SCHEMA_LINEAGE_MODE: lineage.mode,
        AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON: lineage.opaqueLegacyRowsJson,
      }),
    });
  } catch (error) {
    wrap(error);
  }
}

export function writeStagingAudit0107Binding(directory, binding) {
  try {
    const absolute = prepareExclusiveOutput(directory, [
      AUDIT_0107_FILES.transition,
      AUDIT_0107_FILES.transitionChecksum,
      AUDIT_0107_FILES.inspect,
      AUDIT_0107_FILES.inspectChecksum,
      AUDIT_0107_FILES.environment,
    ]);
    const artifacts = [
      [
        AUDIT_0107_FILES.transition,
        AUDIT_0107_FILES.transitionChecksum,
        binding.transition,
        binding.transitionSha256,
      ],
      [
        AUDIT_0107_FILES.inspect,
        AUDIT_0107_FILES.inspectChecksum,
        binding.derivedInspect,
        binding.derivedInspectSha256,
      ],
    ];
    const files = {};
    for (const [name, checksumName, value, digest] of artifacts) {
      files[name] = atomicWriteExclusive(absolute, name, canonicalJson(value));
      files[checksumName] = atomicWriteExclusive(
        absolute,
        checksumName,
        `${digest}  ${name}\n`,
      );
    }
    const environmentBytes = `${Object.entries(binding.environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`;
    files[AUDIT_0107_FILES.environment] = atomicWriteExclusive(
      absolute,
      AUDIT_0107_FILES.environment,
      environmentBytes,
    );
    return Object.freeze(files);
  } catch (error) {
    wrap(error);
  }
}

function main() {
  const inspect = readRegularFile(
    requiredArgument("--inspect-inputs"),
    "original inspect inputs",
  );
  const inspectChecksum = readRegularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "original inspect checksum",
  );
  const backup = readRegularFile(
    requiredArgument("--backup-execution"),
    "exact-0106 audit backup execution",
  );
  const backupChecksum = readRegularFile(
    requiredArgument("--backup-execution-checksum"),
    "exact-0106 audit backup checksum",
  );
  const binding = createStagingAudit0107Binding({
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    lineageMode: requiredArgument("--lineage-mode"),
    opaqueLegacyRowsJson: requiredArgument("--opaque-legacy-rows-json"),
    originalInspectBytes: fs.readFileSync(inspect),
    originalInspectChecksumText: fs.readFileSync(inspectChecksum, "utf8"),
    expectedOriginalInspectSha256: requiredArgument(
      "--expected-inspect-inputs-sha256",
    ),
    backupExecutionBytes: fs.readFileSync(backup),
    backupExecutionChecksumText: fs.readFileSync(backupChecksum, "utf8"),
    expectedBackupExecutionSha256: requiredArgument(
      "--expected-backup-execution-sha256",
    ),
  });
  const files = writeStagingAudit0107Binding(
    requiredArgument("--output-dir"),
    binding,
  );
  process.stdout.write(
    `${JSON.stringify({ decision: binding.decision, backupId: binding.transition.backupEvidence.id, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const failure =
      error instanceof StagingAudit0107BindingError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-audit-0107-binding] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
