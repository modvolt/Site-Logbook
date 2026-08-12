import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AUDIT_0107 } from "./staging-audit-0107-contract.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 256 * 1024;

function binaryCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
const RELEASE_KIND = "site-logbook-staging-audit-0107-release-evidence";
const EXECUTION_KIND = "site-logbook-staging-audit-0107-execution";
const STEADY_SCHEMA = "site-logbook.audit-schema-steady-state/v1";
const STEADY_KIND = "audit-schema-steady-state";
const INTENT_KIND = "site-logbook-staging-audit-0107-intent";
const TARGET_TAG = "0107_canonical_audit_evidence";
const TARGET_SQL_SHA256 = `sha256:${AUDIT_0107.migrationSha256}`;
const TARGET_SNAPSHOT_SHA256 = `sha256:${AUDIT_0107.targetSnapshotSha256}`;
const PREDECESSOR_KNOWN_ROWS_SHA256 = AUDIT_0107.predecessorKnownRowsSha256;
const TARGET_KNOWN_ROWS_SHA256 = AUDIT_0107.targetKnownRowsSha256;
const CLEAN_OPAQUE_SHA256 =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const RESTRICTED_OPAQUE_SHA256 =
  "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201";
const MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024;
const STAGING_POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const SENSITIVE_KEY =
  /(password|secret|token|credential|private.?key|database.?url|connection.?string)/i;

export class Audit0107ReleaseEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "Audit0107ReleaseEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new Audit0107ReleaseEvidenceError(code, message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AUDIT_0107_RELEASE_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, field) {
  const object = objectAt(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "AUDIT_0107_RELEASE_SCHEMA_INVALID",
      `${field} must contain only the exact approved fields.`,
    );
  }
  return object;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail(
      "AUDIT_0107_RELEASE_SCHEMA_INVALID",
      `${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function exactSha(value, field) {
  const result = nonEmptyString(value, field).toLowerCase();
  if (!FULL_SHA.test(result) || /^0{40}$/.test(result)) {
    fail(
      "AUDIT_0107_RELEASE_SHA_INVALID",
      `${field} must be a non-placeholder full Git SHA.`,
    );
  }
  return result;
}

function exactSha256(value, field) {
  const result = nonEmptyString(value, field).toLowerCase();
  if (!SHA256.test(result) || /^sha256:0{64}$/.test(result)) {
    fail(
      "AUDIT_0107_RELEASE_DIGEST_INVALID",
      `${field} must be a non-placeholder lowercase SHA-256 digest.`,
    );
  }
  return result;
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "AUDIT_0107_RELEASE_SCHEMA_INVALID",
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function positiveInteger(value, field) {
  const result = safeInteger(value, field);
  if (result === 0) {
    fail("AUDIT_0107_RELEASE_SCHEMA_INVALID", `${field} must be positive.`);
  }
  return result;
}

function nonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(
      "AUDIT_0107_RELEASE_SCHEMA_INVALID",
      `${field} must be a finite non-negative number.`,
    );
  }
  return value;
}

function utcTime(value, field) {
  const raw = nonEmptyString(value, field);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || !raw.endsWith("Z")) {
    fail(
      "AUDIT_0107_RELEASE_TIME_INVALID",
      `${field} must be an ISO 8601 UTC timestamp.`,
    );
  }
  return timestamp;
}

function requireValue(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "AUDIT_0107_RELEASE_BINDING_INVALID",
      `${field} must equal ${JSON.stringify(expected)}.`,
    );
  }
}

function scanForSecrets(value, field = "artifact") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSecrets(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      fail(
        "AUDIT_0107_RELEASE_SECRET_MATERIAL",
        `${field}.${key} is forbidden in release evidence.`,
      );
    }
    scanForSecrets(entry, `${field}.${key}`);
  }
}

function decodeCanonicalArtifact(encoded, expectedSha256, field) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    fail("AUDIT_0107_RELEASE_ENV_MISSING", `${field} base64 is required.`);
  }
  exactSha256(expectedSha256, `${field}Sha256`);

  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    fail("AUDIT_0107_RELEASE_BASE64_INVALID", `${field} base64 is invalid.`);
  }
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ARTIFACT_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    fail(
      "AUDIT_0107_RELEASE_BASE64_INVALID",
      `${field} must be canonical base64 within the bounded size.`,
    );
  }
  if (sha256(bytes) !== expectedSha256) {
    fail(
      "AUDIT_0107_RELEASE_DIGEST_MISMATCH",
      `${field} bytes do not match the separately supplied checksum.`,
    );
  }

  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("AUDIT_0107_RELEASE_JSON_INVALID", `${field} must be JSON.`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "AUDIT_0107_RELEASE_NOT_CANONICAL",
      `${field} must use canonical sorted JSON with one trailing LF.`,
    );
  }
  scanForSecrets(value, field);
  return { value: objectAt(value, field), sha256: expectedSha256 };
}

function decodeRawJsonArtifact(encoded, suppliedSha256, expectedSha256, field) {
  const suppliedDigest = exactSha256(suppliedSha256, `${field}Sha256`);
  const expectedDigest = exactSha256(expectedSha256, `expected.${field}Sha256`);
  requireValue(suppliedDigest, expectedDigest, `${field}Sha256`);
  if (typeof encoded !== "string" || encoded.length === 0) {
    fail("AUDIT_0107_RELEASE_ENV_MISSING", `${field} base64 is required.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ARTIFACT_BYTES ||
    bytes.toString("base64") !== encoded ||
    sha256(bytes) !== expectedDigest
  ) {
    fail(
      "AUDIT_0107_RELEASE_DIGEST_MISMATCH",
      `${field} raw bytes must match both independently supplied digests.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("AUDIT_0107_RELEASE_JSON_INVALID", `${field} must be JSON.`);
  }
  scanForSecrets(value, field);
  return { value: objectAt(value, field), sha256: expectedDigest };
}

function canonicalOpaqueRows(rows) {
  if (!Array.isArray(rows)) {
    fail("AUDIT_0107_RELEASE_LINEAGE_INVALID", "opaque must be an array.");
  }
  const normalized = [...rows]
    .map((row, index) => {
      const identity = exactKeys(
        row,
        ["createdAt", "hash"],
        `opaque[${index}]`,
      );
      const createdAt = safeInteger(
        identity.createdAt,
        `opaque[${index}].createdAt`,
      );
      const hash = nonEmptyString(identity.hash, `opaque[${index}].hash`);
      if (!HEX64.test(hash)) {
        fail(
          "AUDIT_0107_RELEASE_LINEAGE_INVALID",
          `opaque[${index}].hash must be 64 lowercase hex.`,
        );
      }
      return { createdAt, hash };
    })
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        binaryCompare(left.hash, right.hash),
    );
  if (JSON.stringify(rows) !== JSON.stringify(normalized)) {
    fail(
      "AUDIT_0107_RELEASE_LINEAGE_INVALID",
      "opaque rows must be exact, unique-order canonical identities.",
    );
  }
  return JSON.stringify(normalized);
}

function validateLineage(lineageValue, field, opaqueRows = undefined) {
  const lineage = exactKeys(
    lineageValue,
    [
      "decision",
      "knownAppliedRowsSha256",
      "mode",
      "knownExpectedMigrations",
      "knownAppliedMigrations",
      "latestKnownAppliedTag",
      "missingKnownToPredecessor",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
      "opaqueLegacyMeaningInferred",
      "excludedMigration0100Present",
    ],
    field,
  );
  requireValue(lineage.decision, "ALREADY_0107", `${field}.decision`);
  requireValue(
    lineage.knownAppliedRowsSha256,
    TARGET_KNOWN_ROWS_SHA256,
    `${field}.knownAppliedRowsSha256`,
  );
  if (!["clean", "production-copy-restricted"].includes(lineage.mode)) {
    fail("AUDIT_0107_RELEASE_LINEAGE_INVALID", `${field}.mode is invalid.`);
  }
  requireValue(
    lineage.knownExpectedMigrations,
    107,
    `${field}.knownExpectedMigrations`,
  );
  requireValue(
    lineage.knownAppliedMigrations,
    107,
    `${field}.knownAppliedMigrations`,
  );
  requireValue(
    lineage.latestKnownAppliedTag,
    TARGET_TAG,
    `${field}.latestKnownAppliedTag`,
  );
  requireValue(
    lineage.missingKnownToPredecessor,
    0,
    `${field}.missingKnownToPredecessor`,
  );
  requireValue(
    lineage.opaqueLegacyMeaningInferred,
    false,
    `${field}.opaqueLegacyMeaningInferred`,
  );
  requireValue(
    lineage.excludedMigration0100Present,
    false,
    `${field}.excludedMigration0100Present`,
  );
  const opaqueCount = safeInteger(
    lineage.opaqueLegacyRowCount,
    `${field}.opaqueLegacyRowCount`,
  );
  const opaqueDigest = exactSha256(
    lineage.opaqueLegacyRowsSha256,
    `${field}.opaqueLegacyRowsSha256`,
  );
  if (
    (lineage.mode === "clean" &&
      (opaqueCount !== 0 || opaqueDigest !== CLEAN_OPAQUE_SHA256)) ||
    (lineage.mode === "production-copy-restricted" &&
      (opaqueCount !== 2 || opaqueDigest !== RESTRICTED_OPAQUE_SHA256))
  ) {
    fail(
      "AUDIT_0107_RELEASE_LINEAGE_INVALID",
      `${field} does not match the frozen clean/restricted lineage.`,
    );
  }
  if (opaqueRows !== undefined) {
    if (!Array.isArray(opaqueRows) || opaqueRows.length !== opaqueCount) {
      fail(
        "AUDIT_0107_RELEASE_LINEAGE_INVALID",
        `${field} opaque row count does not match execution evidence.`,
      );
    }
    const digest = sha256(canonicalOpaqueRows(opaqueRows));
    if (digest !== opaqueDigest) {
      fail(
        "AUDIT_0107_RELEASE_LINEAGE_INVALID",
        `${field} opaque row digest does not match execution evidence.`,
      );
    }
  }
  return lineage;
}

function validateBackupEvidence(value, field) {
  const backup = exactKeys(
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
    field,
  );
  positiveInteger(backup.id, `${field}.id`);
  positiveInteger(backup.sizeBytes, `${field}.sizeBytes`);
  exactSha256(backup.encryptedBackupSha256, `${field}.encryptedBackupSha256`);
  requireValue(backup.encryptionFormat, "mve1", `${field}.encryptionFormat`);
  exactSha256(
    backup.encryptionKeyIdFingerprint,
    `${field}.encryptionKeyIdFingerprint`,
  );
  exactSha256(backup.objectPathFingerprint, `${field}.objectPathFingerprint`);
  const createdAt = utcTime(backup.createdAt, `${field}.createdAt`);
  const restoreTestedAt = utcTime(
    backup.restoreTestedAt,
    `${field}.restoreTestedAt`,
  );
  const checkedAt = utcTime(backup.checkedAt, `${field}.checkedAt`);
  if (createdAt > restoreTestedAt || restoreTestedAt > checkedAt) {
    fail(
      "AUDIT_0107_RELEASE_TIME_INVALID",
      `${field} timestamps must be monotonic.`,
    );
  }
  nonNegativeNumber(backup.restoreAgeHours, `${field}.restoreAgeHours`);
  positiveInteger(backup.restoreDurationMs, `${field}.restoreDurationMs`);
  positiveInteger(backup.verifiedTableCount, `${field}.verifiedTableCount`);
  exactSha256(backup.verifiedTablesSha256, `${field}.verifiedTablesSha256`);
  requireValue(
    backup.destructiveRestorePerformed,
    false,
    `${field}.destructiveRestorePerformed`,
  );
  return backup;
}

function validateBackupIntegrity(value, field) {
  const integrity = exactKeys(
    value,
    [
      "schemaVersion",
      "verifiedTableNames",
      "verifiedTableCounts",
      "verifiedTableCountsSha256",
      "backupRowBindingSha256",
    ],
    field,
  );
  requireValue(
    integrity.schemaVersion,
    "site-logbook.audit-schema-backup-integrity/v1",
    `${field}.schemaVersion`,
  );
  if (
    !Array.isArray(integrity.verifiedTableNames) ||
    integrity.verifiedTableNames.length === 0 ||
    integrity.verifiedTableNames.some(
      (name) => typeof name !== "string" || !name.trim(),
    ) ||
    new Set(integrity.verifiedTableNames).size !==
      integrity.verifiedTableNames.length
  ) {
    fail(
      "AUDIT_0107_RELEASE_BACKUP_INTEGRITY_INVALID",
      `${field}.verifiedTableNames must be a non-empty unique string array.`,
    );
  }
  const counts = exactKeys(
    integrity.verifiedTableCounts,
    integrity.verifiedTableNames,
    `${field}.verifiedTableCounts`,
  );
  for (const [name, count] of Object.entries(counts)) {
    safeInteger(count, `${field}.verifiedTableCounts.${name}`);
  }
  requireValue(
    exactSha256(
      integrity.verifiedTableCountsSha256,
      `${field}.verifiedTableCountsSha256`,
    ),
    sha256(Buffer.from(JSON.stringify(counts), "utf8")),
    `${field}.verifiedTableCountsSha256`,
  );
  exactSha256(
    integrity.backupRowBindingSha256,
    `${field}.backupRowBindingSha256`,
  );
  return integrity;
}

function validateHostLineage(value) {
  const lineage = exactKeys(
    value,
    [
      "mode",
      "knownMigrationCount",
      "totalJournalRows",
      "opaqueLegacyRows",
      "opaqueLegacyRowsSha256",
      "opaqueLegacyMeaningInferred",
    ],
    "execution.lineage",
  );
  if (!["clean", "production-copy-restricted"].includes(lineage.mode)) {
    fail(
      "AUDIT_0107_RELEASE_LINEAGE_INVALID",
      "execution.lineage.mode is invalid.",
    );
  }
  requireValue(
    lineage.knownMigrationCount,
    107,
    "execution.lineage.knownMigrationCount",
  );
  const expectedOpaqueCount = lineage.mode === "clean" ? 0 : 2;
  requireValue(
    lineage.totalJournalRows,
    107 + expectedOpaqueCount,
    "execution.lineage.totalJournalRows",
  );
  if (
    !Array.isArray(lineage.opaqueLegacyRows) ||
    lineage.opaqueLegacyRows.length !== expectedOpaqueCount
  ) {
    fail(
      "AUDIT_0107_RELEASE_LINEAGE_INVALID",
      "execution.lineage.opaqueLegacyRows has an invalid count.",
    );
  }
  const opaqueDigest = sha256(canonicalOpaqueRows(lineage.opaqueLegacyRows));
  const expectedOpaqueDigest =
    lineage.mode === "clean" ? CLEAN_OPAQUE_SHA256 : RESTRICTED_OPAQUE_SHA256;
  requireValue(
    exactSha256(
      lineage.opaqueLegacyRowsSha256,
      "execution.lineage.opaqueLegacyRowsSha256",
    ),
    expectedOpaqueDigest,
    "execution.lineage.opaqueLegacyRowsSha256",
  );
  requireValue(
    opaqueDigest,
    expectedOpaqueDigest,
    "execution.lineage.opaqueLegacyRows",
  );
  requireValue(
    lineage.opaqueLegacyMeaningInferred,
    false,
    "execution.lineage.opaqueLegacyMeaningInferred",
  );
  return lineage;
}

function validateRuntimeBinding(value, field) {
  const binding = exactKeys(
    value,
    ["resolvedComposeSha256", "deploymentConfigSha256", "livePostgresTarget"],
    field,
  );
  exactSha256(binding.resolvedComposeSha256, `${field}.resolvedComposeSha256`);
  exactSha256(
    binding.deploymentConfigSha256,
    `${field}.deploymentConfigSha256`,
  );
  const live = exactKeys(
    binding.livePostgresTarget,
    [
      "containerId",
      "image",
      "imageId",
      "volumeName",
      "networkName",
      "networkId",
      "projectionSha256",
    ],
    `${field}.livePostgresTarget`,
  );
  for (const key of ["containerId", "imageId", "networkId"]) {
    const value = nonEmptyString(
      live[key],
      `${field}.livePostgresTarget.${key}`,
    );
    if (!HEX64.test(value)) {
      fail(
        "AUDIT_0107_RELEASE_RUNTIME_BINDING_INVALID",
        `${field}.livePostgresTarget.${key} must be 64 lowercase hex.`,
      );
    }
  }
  requireValue(
    live.image,
    STAGING_POSTGRES_IMAGE,
    `${field}.livePostgresTarget.image`,
  );
  requireValue(
    live.volumeName,
    "site-logbook-staging_pgdata",
    `${field}.livePostgresTarget.volumeName`,
  );
  requireValue(
    live.networkName,
    "site-logbook-staging_default",
    `${field}.livePostgresTarget.networkName`,
  );
  const projection = {
    containerId: live.containerId,
    image: live.image,
    imageId: live.imageId,
    volumeName: live.volumeName,
    networkName: live.networkName,
    networkId: live.networkId,
  };
  requireValue(
    exactSha256(
      live.projectionSha256,
      `${field}.livePostgresTarget.projectionSha256`,
    ),
    sha256(Buffer.from(canonicalJson(projection), "utf8")),
    `${field}.livePostgresTarget.projectionSha256`,
  );
  return binding;
}

function validateExecution(value, buildSha) {
  const execution = exactKeys(
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
    "execution",
  );
  requireValue(execution.schemaVersion, 1, "execution.schemaVersion");
  requireValue(execution.kind, EXECUTION_KIND, "execution.kind");
  requireValue(execution.decision, "PASS", "execution.decision");
  if (!["applied", "verified-noop"].includes(execution.operation)) {
    fail(
      "AUDIT_0107_RELEASE_BINDING_INVALID",
      "execution.operation is invalid.",
    );
  }
  requireValue(
    execution.productionTargetsTouched,
    false,
    "execution.productionTargetsTouched",
  );
  const startedAt = utcTime(execution.startedAt, "execution.startedAt");
  const completedAt = utcTime(execution.completedAt, "execution.completedAt");
  if (completedAt < startedAt) {
    fail(
      "AUDIT_0107_RELEASE_TIME_INVALID",
      "execution completed before it started.",
    );
  }
  requireValue(
    exactSha(execution.sourceSha, "execution.sourceSha"),
    buildSha,
    "execution.sourceSha",
  );
  const expectedSchemaFingerprintSha256 = exactSha256(
    execution.expectedSchemaFingerprintSha256,
    "execution.expectedSchemaFingerprintSha256",
  );
  for (const field of [
    "transitionInputsSha256",
    "derivedInspectInputsSha256",
    "backupExecutionSha256",
    "intentSha256",
  ]) {
    exactSha256(execution[field], `execution.${field}`);
  }
  const runtimeBinding = validateRuntimeBinding(
    execution.runtimeBinding,
    "execution.runtimeBinding",
  );
  const hostLineage = validateHostLineage(execution.lineage);
  const rootBackup = validateBackupEvidence(
    execution.backupEvidence,
    "execution.backupEvidence",
  );
  const rootBackupIntegrity = validateBackupIntegrity(
    execution.backupIntegrity,
    "execution.backupIntegrity",
  );
  requireValue(
    rootBackup.verifiedTableCount,
    rootBackupIntegrity.verifiedTableNames.length,
    "execution.backupEvidence.verifiedTableCount",
  );
  requireValue(
    rootBackup.verifiedTablesSha256,
    rootBackupIntegrity.verifiedTableCountsSha256,
    "execution.backupEvidence.verifiedTablesSha256",
  );
  const runtimeIsolation = exactKeys(
    execution.runtimeIsolation,
    [
      "exactApprovedContainersAtObservedBoundaries",
      "samePostgresContainerAtObservedBoundaries",
      "continuousIsolationInferred",
      "apiStarted",
      "webStarted",
      "auditSchema0107GateStartedOnlyAsOneShot",
    ],
    "execution.runtimeIsolation",
  );
  requireValue(
    runtimeIsolation.exactApprovedContainersAtObservedBoundaries,
    true,
    "execution.runtimeIsolation.exactApprovedContainersAtObservedBoundaries",
  );
  requireValue(
    runtimeIsolation.samePostgresContainerAtObservedBoundaries,
    true,
    "execution.runtimeIsolation.samePostgresContainerAtObservedBoundaries",
  );
  requireValue(
    runtimeIsolation.continuousIsolationInferred,
    false,
    "execution.runtimeIsolation.continuousIsolationInferred",
  );
  requireValue(
    runtimeIsolation.apiStarted,
    false,
    "execution.runtimeIsolation.apiStarted",
  );
  requireValue(
    runtimeIsolation.webStarted,
    false,
    "execution.runtimeIsolation.webStarted",
  );
  requireValue(
    runtimeIsolation.auditSchema0107GateStartedOnlyAsOneShot,
    true,
    "execution.runtimeIsolation.auditSchema0107GateStartedOnlyAsOneShot",
  );

  const gate = exactKeys(
    execution.schemaGate,
    [
      "schemaVersion",
      "kind",
      "mode",
      "decision",
      "before",
      "after",
      "newlyApplied",
      "migration",
      "transition",
      "authorizesApplicationStart",
    ],
    "execution.schemaGate",
  );
  requireValue(
    gate.schemaVersion,
    "site-logbook.audit-schema-gate/v1",
    "execution.schemaGate.schemaVersion",
  );
  requireValue(gate.kind, "audit-schema-gate", "execution.schemaGate.kind");
  const applied = execution.operation === "applied";
  requireValue(
    gate.mode,
    applied ? "APPLIED" : "NOOP",
    "execution.schemaGate.mode",
  );
  requireValue(gate.decision, "ALREADY_0107", "execution.schemaGate.decision");
  requireValue(
    gate.authorizesApplicationStart,
    true,
    "execution.schemaGate.authorizesApplicationStart",
  );
  const before = exactKeys(
    gate.before,
    [
      "decision",
      "knownAppliedMigrations",
      "knownAppliedRowsSha256",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
    ],
    "execution.schemaGate.before",
  );
  requireValue(
    before.decision,
    applied ? "READY_0106" : "ALREADY_0107",
    "execution.schemaGate.before.decision",
  );
  requireValue(
    before.knownAppliedMigrations,
    applied ? 106 : 107,
    "execution.schemaGate.before.knownAppliedMigrations",
  );
  requireValue(
    before.knownAppliedRowsSha256,
    applied ? PREDECESSOR_KNOWN_ROWS_SHA256 : TARGET_KNOWN_ROWS_SHA256,
    "execution.schemaGate.before.knownAppliedRowsSha256",
  );
  requireValue(
    before.opaqueLegacyRowCount,
    hostLineage.opaqueLegacyRows.length,
    "execution.schemaGate.before.opaqueLegacyRowCount",
  );
  requireValue(
    before.opaqueLegacyRowsSha256,
    hostLineage.opaqueLegacyRowsSha256,
    "execution.schemaGate.before.opaqueLegacyRowsSha256",
  );
  requireValue(
    gate.newlyApplied,
    applied ? 1 : 0,
    "execution.schemaGate.newlyApplied",
  );
  const migration = exactKeys(
    gate.migration,
    ["idx", "when", "tag", "sha256"],
    "execution.schemaGate.migration",
  );
  requireValue(migration.idx, 107, "execution.schemaGate.migration.idx");
  requireValue(
    migration.when,
    1786484628859,
    "execution.schemaGate.migration.when",
  );
  requireValue(migration.tag, TARGET_TAG, "execution.schemaGate.migration.tag");
  requireValue(
    migration.sha256,
    TARGET_SQL_SHA256,
    "execution.schemaGate.migration.sha256",
  );

  const transition = exactKeys(
    gate.transition,
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
    "execution.schemaGate.transition",
  );
  requireValue(
    transition.inputSha256,
    execution.transitionInputsSha256,
    "execution.schemaGate.transition.inputSha256",
  );
  requireValue(
    transition.sourceBackupExecutionSha256,
    execution.backupExecutionSha256,
    "execution.schemaGate.transition.sourceBackupExecutionSha256",
  );
  requireValue(
    transition.backupEvidenceId,
    rootBackup.id,
    "execution.schemaGate.transition.backupEvidenceId",
  );
  const restoreAgeHours = nonNegativeNumber(
    transition.backupRestoreAgeHours,
    "execution.schemaGate.transition.backupRestoreAgeHours",
  );
  const restoreMaxAgeHours = nonNegativeNumber(
    transition.backupRestoreMaxAgeHours,
    "execution.schemaGate.transition.backupRestoreMaxAgeHours",
  );
  if (restoreAgeHours > restoreMaxAgeHours) {
    fail(
      "AUDIT_0107_RELEASE_BINDING_INVALID",
      "execution.schemaGate.transition backup is older than its reviewed maximum.",
    );
  }
  requireValue(
    transition.backupMaxPayloadBytes,
    MAX_BACKUP_PAYLOAD_BYTES,
    "execution.schemaGate.transition.backupMaxPayloadBytes",
  );
  requireValue(
    transition.backupSizeBytes,
    rootBackup.sizeBytes,
    "execution.schemaGate.transition.backupSizeBytes",
  );
  requireValue(
    rootBackup.restoreAgeHours,
    restoreAgeHours,
    "execution.backupEvidence.restoreAgeHours",
  );
  const transitionBackup = validateBackupEvidence(
    transition.backupEvidence,
    "execution.schemaGate.transition.backupEvidence",
  );
  requireValue(
    canonicalJson(transitionBackup),
    canonicalJson(rootBackup),
    "execution.backupEvidence",
  );
  const transitionBackupIntegrity = validateBackupIntegrity(
    transition.backupIntegrity,
    "execution.schemaGate.transition.backupIntegrity",
  );
  requireValue(
    canonicalJson(transitionBackupIntegrity),
    canonicalJson(rootBackupIntegrity),
    "execution.schemaGate.transition.backupIntegrity",
  );
  const { steady: after, lineage: afterLineage } = validateSteady(
    gate.after,
    buildSha,
    "execution.schemaGate.after",
  );
  requireValue(
    afterLineage.mode,
    hostLineage.mode,
    "execution.schemaGate.after.lineage.mode",
  );
  requireValue(
    afterLineage.opaqueLegacyRowsSha256,
    hostLineage.opaqueLegacyRowsSha256,
    "execution.schemaGate.after.lineage.opaqueLegacyRowsSha256",
  );
  requireValue(
    after.schema.expectedSchemaFingerprintSha256,
    expectedSchemaFingerprintSha256,
    "execution.schemaGate.after.schema.expectedSchemaFingerprintSha256",
  );
  requireValue(
    after.schema.schemaFingerprintSha256,
    expectedSchemaFingerprintSha256,
    "execution.schemaGate.after.schema.schemaFingerprintSha256",
  );
  requireValue(
    execution.migration0107AppliedOrVerified,
    true,
    "execution.migration0107AppliedOrVerified",
  );
  requireValue(
    execution.authorizesApplicationStart,
    false,
    "execution.authorizesApplicationStart",
  );
  requireValue(
    execution.nextGate,
    "audit-0107-release-evidence-required",
    "execution.nextGate",
  );
  return {
    execution,
    completedAt,
    hostLineage,
    after,
    runtimeBinding,
    rootBackup,
    rootBackupIntegrity,
  };
}

function validateSteady(value, buildSha, field = "steady") {
  const steady = exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "lineage",
      "schema",
      "authorizesApplicationStart",
    ],
    field,
  );
  requireValue(steady.schemaVersion, STEADY_SCHEMA, `${field}.schemaVersion`);
  requireValue(steady.kind, STEADY_KIND, `${field}.kind`);
  requireValue(steady.decision, "ALREADY_0107", `${field}.decision`);
  requireValue(
    steady.environmentId,
    "site-logbook-staging",
    `${field}.environmentId`,
  );
  requireValue(
    steady.databaseName,
    "site_logbook_staging",
    `${field}.databaseName`,
  );
  requireValue(
    steady.databaseUser,
    "site_logbook_staging",
    `${field}.databaseUser`,
  );
  requireValue(
    exactSha(steady.buildSha, `${field}.buildSha`),
    buildSha,
    `${field}.buildSha`,
  );
  const lineage = validateLineage(steady.lineage, `${field}.lineage`);
  const schema = exactKeys(
    steady.schema,
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
    `${field}.schema`,
  );
  requireValue(schema.targetTag, TARGET_TAG, `${field}.schema.targetTag`);
  requireValue(
    schema.targetSqlSha256,
    TARGET_SQL_SHA256,
    `${field}.schema.targetSqlSha256`,
  );
  requireValue(
    schema.targetSnapshotSha256,
    TARGET_SNAPSHOT_SHA256,
    `${field}.schema.targetSnapshotSha256`,
  );
  safeInteger(schema.auditEventRows, `${field}.schema.auditEventRows`);
  safeInteger(schema.auditOutboxRows, `${field}.schema.auditOutboxRows`);
  requireValue(schema.auditHeadRows, 1, `${field}.schema.auditHeadRows`);
  const expectedSchemaFingerprintSha256 = exactSha256(
    schema.expectedSchemaFingerprintSha256,
    `${field}.schema.expectedSchemaFingerprintSha256`,
  );
  requireValue(
    exactSha256(
      schema.schemaFingerprintSha256,
      `${field}.schema.schemaFingerprintSha256`,
    ),
    expectedSchemaFingerprintSha256,
    `${field}.schema.schemaFingerprintSha256`,
  );
  requireValue(
    steady.authorizesApplicationStart,
    true,
    `${field}.authorizesApplicationStart`,
  );
  return { steady, lineage };
}

function validateIntent(
  value,
  execution,
  runtimeBinding,
  hostLineage,
  rootBackup,
  rootBackupIntegrity,
) {
  const intent = exactKeys(
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
    "intent",
  );
  requireValue(intent.schemaVersion, 1, "intent.schemaVersion");
  requireValue(intent.kind, INTENT_KIND, "intent.kind");
  requireValue(
    intent.productionTargetsTouched,
    false,
    "intent.productionTargetsTouched",
  );
  requireValue(intent.sourceSha, execution.sourceSha, "intent.sourceSha");
  requireValue(
    intent.expectedSchemaFingerprintSha256,
    execution.expectedSchemaFingerprintSha256,
    "intent.expectedSchemaFingerprintSha256",
  );
  for (const field of [
    "transitionInputsSha256",
    "derivedInspectInputsSha256",
    "backupExecutionSha256",
  ]) {
    requireValue(intent[field], execution[field], `intent.${field}`);
  }
  const intentRuntimeBinding = validateRuntimeBinding(
    intent.runtimeBinding,
    "intent.runtimeBinding",
  );
  requireValue(
    canonicalJson(intentRuntimeBinding),
    canonicalJson(runtimeBinding),
    "intent.runtimeBinding",
  );
  const lineage = exactKeys(
    intent.lineage,
    ["mode", "opaqueLegacyRows", "opaqueLegacyRowsSha256"],
    "intent.lineage",
  );
  requireValue(lineage.mode, hostLineage.mode, "intent.lineage.mode");
  requireValue(
    canonicalOpaqueRows(lineage.opaqueLegacyRows),
    canonicalOpaqueRows(hostLineage.opaqueLegacyRows),
    "intent.lineage.opaqueLegacyRows",
  );
  requireValue(
    lineage.opaqueLegacyRowsSha256,
    hostLineage.opaqueLegacyRowsSha256,
    "intent.lineage.opaqueLegacyRowsSha256",
  );
  const backup = validateBackupEvidence(
    intent.backupEvidence,
    "intent.backupEvidence",
  );
  requireValue(
    canonicalJson(backup),
    canonicalJson(rootBackup),
    "intent.backupEvidence",
  );
  const intentBackupIntegrity = validateBackupIntegrity(
    intent.backupIntegrity,
    "intent.backupIntegrity",
  );
  requireValue(
    canonicalJson(intentBackupIntegrity),
    canonicalJson(rootBackupIntegrity),
    "intent.backupIntegrity",
  );
  requireValue(
    intent.confirmation,
    "APPLY_0107_AUDIT_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING",
    "intent.confirmation",
  );
  requireValue(
    intent.authorizesOnly,
    "isolated-exact-0106-to-0107-audit-transition",
    "intent.authorizesOnly",
  );
  requireValue(
    intent.authorizesApplicationStart,
    false,
    "intent.authorizesApplicationStart",
  );
  return intent;
}

function validateApproval(value, executionCompletedAt, now) {
  const approval = exactKeys(
    value,
    [
      "mode",
      "operator",
      "reviewer",
      "serviceOwner",
      "approvedAt",
      "executionReviewed",
      "steadyStateReviewed",
      "exactBuildShaReviewed",
      "predecessorReleaseEvidenceReviewed",
      "resolvedComposeReviewed",
      "deploymentConfigReviewed",
      "livePostgresTargetReviewed",
      "authorizesApplicationStart",
      "soloMaintainerRiskAccepted",
      "compensatingControls",
    ],
    "release.approval",
  );
  if (!["dual_control", "solo_maintainer"].includes(approval.mode)) {
    fail("AUDIT_0107_RELEASE_APPROVAL_INVALID", "approval mode is invalid.");
  }
  const operator = nonEmptyString(
    approval.operator,
    "release.approval.operator",
  );
  const serviceOwner = nonEmptyString(
    approval.serviceOwner,
    "release.approval.serviceOwner",
  );
  requireValue(
    approval.executionReviewed,
    true,
    "release.approval.executionReviewed",
  );
  requireValue(
    approval.steadyStateReviewed,
    true,
    "release.approval.steadyStateReviewed",
  );
  requireValue(
    approval.exactBuildShaReviewed,
    true,
    "release.approval.exactBuildShaReviewed",
  );
  requireValue(
    approval.predecessorReleaseEvidenceReviewed,
    true,
    "release.approval.predecessorReleaseEvidenceReviewed",
  );
  requireValue(
    approval.resolvedComposeReviewed,
    true,
    "release.approval.resolvedComposeReviewed",
  );
  requireValue(
    approval.deploymentConfigReviewed,
    true,
    "release.approval.deploymentConfigReviewed",
  );
  requireValue(
    approval.livePostgresTargetReviewed,
    true,
    "release.approval.livePostgresTargetReviewed",
  );
  requireValue(
    approval.authorizesApplicationStart,
    true,
    "release.approval.authorizesApplicationStart",
  );
  const approvedAt = utcTime(
    approval.approvedAt,
    "release.approval.approvedAt",
  );
  if (approvedAt < executionCompletedAt || approvedAt > now + 5 * 60_000) {
    fail(
      "AUDIT_0107_RELEASE_APPROVAL_INVALID",
      "approval must follow execution and cannot be in the future.",
    );
  }
  const controls = exactKeys(
    approval.compensatingControls,
    [
      "mainBranchProtected",
      "exactShaQualityGateRequired",
      "environmentBranchRestricted",
    ],
    "release.approval.compensatingControls",
  );
  for (const field of Object.keys(controls)) {
    requireValue(
      controls[field],
      true,
      `release.approval.compensatingControls.${field}`,
    );
  }
  if (approval.mode === "dual_control") {
    const reviewer = nonEmptyString(
      approval.reviewer,
      "release.approval.reviewer",
    );
    if (reviewer === operator) {
      fail(
        "AUDIT_0107_RELEASE_APPROVAL_INVALID",
        "dual-control reviewer must differ from the operator.",
      );
    }
    requireValue(
      approval.soloMaintainerRiskAccepted,
      false,
      "release.approval.soloMaintainerRiskAccepted",
    );
  } else {
    requireValue(approval.reviewer, null, "release.approval.reviewer");
    requireValue(serviceOwner, operator, "release.approval.serviceOwner");
    requireValue(
      approval.soloMaintainerRiskAccepted,
      true,
      "release.approval.soloMaintainerRiskAccepted",
    );
  }
  return approval;
}

export function validateAudit0107ReleaseEvidence(input, options = {}) {
  const buildSha = exactSha(input.buildSha, "BUILD_SHA");
  const resolvedComposeSha256 = exactSha256(
    input.resolvedComposeSha256,
    "AUDIT_0107_RESOLVED_COMPOSE_SHA256",
  );
  const deploymentConfigSha256 = exactSha256(
    input.deploymentConfigSha256,
    "AUDIT_0107_DEPLOYMENT_CONFIG_SHA256",
  );
  const livePostgresTargetSha256 = exactSha256(
    input.livePostgresTargetSha256,
    "AUDIT_0107_LIVE_POSTGRES_TARGET_SHA256",
  );
  const predecessorArtifact = decodeRawJsonArtifact(
    input.predecessorReleaseEvidenceB64,
    input.predecessorReleaseEvidenceSha256,
    input.expectedPredecessorReleaseEvidenceSha256,
    "predecessorReleaseEvidence",
  );
  requireValue(
    predecessorArtifact.value.schemaVersion,
    4,
    "predecessorReleaseEvidence.schemaVersion",
  );
  const releaseArtifact = decodeCanonicalArtifact(
    input.releaseEvidenceB64,
    input.releaseEvidenceSha256,
    "releaseEvidence",
  );
  const executionArtifact = decodeCanonicalArtifact(
    input.executionEvidenceB64,
    input.executionEvidenceSha256,
    "executionEvidence",
  );
  const intentArtifact = decodeCanonicalArtifact(
    input.intentEvidenceB64,
    input.intentEvidenceSha256,
    "intentEvidence",
  );
  const steadyArtifact = decodeCanonicalArtifact(
    input.steadyStateEvidenceB64,
    input.steadyStateEvidenceSha256,
    "steadyStateEvidence",
  );
  const {
    execution,
    completedAt,
    hostLineage,
    after,
    runtimeBinding,
    rootBackup,
    rootBackupIntegrity,
  } = validateExecution(executionArtifact.value, buildSha);
  validateIntent(
    intentArtifact.value,
    execution,
    runtimeBinding,
    hostLineage,
    rootBackup,
    rootBackupIntegrity,
  );
  requireValue(
    execution.intentSha256,
    intentArtifact.sha256,
    "execution.intentSha256",
  );
  const { steady, lineage } = validateSteady(steadyArtifact.value, buildSha);
  requireValue(
    canonicalJson(steady),
    canonicalJson(after),
    "steadyStateEvidence",
  );

  const release = exactKeys(
    releaseArtifact.value,
    [
      "schemaVersion",
      "kind",
      "buildSha",
      "deploymentBinding",
      "predecessorReleaseEvidence",
      "artifacts",
      "lineage",
      "approval",
    ],
    "release",
  );
  requireValue(release.schemaVersion, 5, "release.schemaVersion");
  requireValue(release.kind, RELEASE_KIND, "release.kind");
  requireValue(
    exactSha(release.buildSha, "release.buildSha"),
    buildSha,
    "release.buildSha",
  );
  const deploymentBinding = exactKeys(
    release.deploymentBinding,
    [
      "resolvedComposeSha256",
      "deploymentConfigSha256",
      "livePostgresTargetSha256",
    ],
    "release.deploymentBinding",
  );
  requireValue(
    exactSha256(
      deploymentBinding.resolvedComposeSha256,
      "release.deploymentBinding.resolvedComposeSha256",
    ),
    resolvedComposeSha256,
    "release.deploymentBinding.resolvedComposeSha256",
  );
  requireValue(
    exactSha256(
      deploymentBinding.deploymentConfigSha256,
      "release.deploymentBinding.deploymentConfigSha256",
    ),
    deploymentConfigSha256,
    "release.deploymentBinding.deploymentConfigSha256",
  );
  requireValue(
    exactSha256(
      deploymentBinding.livePostgresTargetSha256,
      "release.deploymentBinding.livePostgresTargetSha256",
    ),
    livePostgresTargetSha256,
    "release.deploymentBinding.livePostgresTargetSha256",
  );
  requireValue(
    runtimeBinding.resolvedComposeSha256,
    resolvedComposeSha256,
    "execution.runtimeBinding.resolvedComposeSha256",
  );
  requireValue(
    runtimeBinding.deploymentConfigSha256,
    deploymentConfigSha256,
    "execution.runtimeBinding.deploymentConfigSha256",
  );
  requireValue(
    runtimeBinding.livePostgresTarget.projectionSha256,
    livePostgresTargetSha256,
    "execution.runtimeBinding.livePostgresTarget.projectionSha256",
  );
  const predecessor = exactKeys(
    release.predecessorReleaseEvidence,
    ["schemaVersion", "decision", "fileSha256"],
    "release.predecessorReleaseEvidence",
  );
  requireValue(
    predecessor.schemaVersion,
    4,
    "release.predecessorReleaseEvidence.schemaVersion",
  );
  requireValue(
    predecessor.decision,
    "PASS",
    "release.predecessorReleaseEvidence.decision",
  );
  const predecessorFileSha256 = exactSha256(
    predecessor.fileSha256,
    "release.predecessorReleaseEvidence.fileSha256",
  );
  requireValue(
    predecessorFileSha256,
    predecessorArtifact.sha256,
    "release.predecessorReleaseEvidence.fileSha256",
  );
  const artifacts = exactKeys(
    release.artifacts,
    [
      "audit0107ExecutionSha256",
      "audit0107IntentSha256",
      "audit0107SteadyStateSha256",
    ],
    "release.artifacts",
  );
  requireValue(
    artifacts.audit0107IntentSha256,
    intentArtifact.sha256,
    "release.artifacts.audit0107IntentSha256",
  );
  requireValue(
    artifacts.audit0107ExecutionSha256,
    executionArtifact.sha256,
    "release.artifacts.audit0107ExecutionSha256",
  );
  requireValue(
    artifacts.audit0107SteadyStateSha256,
    steadyArtifact.sha256,
    "release.artifacts.audit0107SteadyStateSha256",
  );
  const releaseLineage = validateLineage(
    release.lineage,
    "release.lineage",
    hostLineage.opaqueLegacyRows,
  );
  requireValue(releaseLineage.mode, hostLineage.mode, "release.lineage.mode");
  requireValue(
    canonicalJson(releaseLineage),
    canonicalJson(lineage),
    "release.lineage",
  );
  validateApproval(release.approval, completedAt, options.now ?? Date.now());

  return Object.freeze({
    schemaVersion: 5,
    kind: RELEASE_KIND,
    buildSha,
    environmentId: steady.environmentId,
    databaseName: steady.databaseName,
    databaseUser: steady.databaseUser,
    operation: execution.operation,
    resolvedComposeSha256,
    deploymentConfigSha256,
    livePostgresTargetSha256,
    releaseEvidenceSha256: releaseArtifact.sha256,
    executionEvidenceSha256: executionArtifact.sha256,
    intentEvidenceSha256: intentArtifact.sha256,
    steadyStateEvidenceSha256: steadyArtifact.sha256,
    lineage: releaseLineage,
    decision: "PASS",
  });
}

export function createRuntimeMigrationReleaseBinding(summary) {
  return {
    schemaVersion: "site-logbook.runtime-migration-release-binding/v1",
    buildSha: summary.buildSha,
    releaseEvidenceSha256: summary.releaseEvidenceSha256,
    lineage: summary.lineage,
  };
}

function requiredEnv(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("AUDIT_0107_RELEASE_ENV_MISSING", `${key} is required.`);
  }
  return value;
}

function main() {
  const summary = validateAudit0107ReleaseEvidence({
    buildSha: requiredEnv(process.env, "BUILD_SHA"),
    resolvedComposeSha256: requiredEnv(
      process.env,
      "AUDIT_0107_RESOLVED_COMPOSE_SHA256",
    ),
    deploymentConfigSha256: requiredEnv(
      process.env,
      "AUDIT_0107_DEPLOYMENT_CONFIG_SHA256",
    ),
    livePostgresTargetSha256: requiredEnv(
      process.env,
      "AUDIT_0107_LIVE_POSTGRES_TARGET_SHA256",
    ),
    predecessorReleaseEvidenceB64: requiredEnv(
      process.env,
      "AUDIT_0107_PREDECESSOR_V4_EVIDENCE_B64",
    ),
    predecessorReleaseEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_PREDECESSOR_V4_EVIDENCE_SHA256",
    ),
    expectedPredecessorReleaseEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_EXPECTED_PREDECESSOR_V4_EVIDENCE_SHA256",
    ),
    releaseEvidenceB64: requiredEnv(
      process.env,
      "AUDIT_0107_RELEASE_EVIDENCE_B64",
    ),
    releaseEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_RELEASE_EVIDENCE_SHA256",
    ),
    executionEvidenceB64: requiredEnv(
      process.env,
      "AUDIT_0107_EXECUTION_EVIDENCE_B64",
    ),
    executionEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_EXECUTION_EVIDENCE_SHA256",
    ),
    intentEvidenceB64: requiredEnv(
      process.env,
      "AUDIT_0107_INTENT_EVIDENCE_B64",
    ),
    intentEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_INTENT_EVIDENCE_SHA256",
    ),
    steadyStateEvidenceB64: requiredEnv(
      process.env,
      "AUDIT_0107_STEADY_STATE_EVIDENCE_B64",
    ),
    steadyStateEvidenceSha256: requiredEnv(
      process.env,
      "AUDIT_0107_STEADY_STATE_EVIDENCE_SHA256",
    ),
  });
  if (process.argv.includes("--emit-runtime-lineage-b64")) {
    process.stdout.write(
      Buffer.from(
        JSON.stringify(createRuntimeMigrationReleaseBinding(summary)),
        "utf8",
      ).toString("base64"),
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
