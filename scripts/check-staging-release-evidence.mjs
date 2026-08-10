import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateStagingImageManifest } from "./verify-staging-image-manifest.mjs";
import {
  canonicalJson,
  validateStagingProvisioning,
} from "./check-staging-provisioning.mjs";
import { validateStagingDeploymentInputs } from "./check-staging-deployment-binding.mjs";

const PRODUCTION_HOSTS = new Set(["modvoltapp.cz", "www.modvoltapp.cz"]);
const LOGICAL_STAGING_ENVIRONMENT_ID = "site-logbook-staging";
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|credential|private.?key|database.?url|connection.?string)/i;
const SAFE_SECRET_METADATA_FIELDS = new Set([
  "adminUsernameConfigured",
  "adminPasswordConfigured",
]);

export class StagingEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingEvidenceError(code, message);
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EVIDENCE_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function stringAt(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail("EVIDENCE_SCHEMA_INVALID", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function booleanAt(value, field) {
  if (typeof value !== "boolean") {
    fail("EVIDENCE_SCHEMA_INVALID", `${field} must be a boolean.`);
  }
  return value;
}

function numberAt(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(
      "EVIDENCE_SCHEMA_INVALID",
      `${field} must be a non-negative finite number.`,
    );
  }
  return value;
}

function integerAt(value, field, { positive = false } = {}) {
  const result = numberAt(value, field);
  if (!Number.isInteger(result) || (positive && result === 0)) {
    fail(
      "EVIDENCE_SCHEMA_INVALID",
      `${field} must be ${positive ? "a positive" : "a non-negative"} integer.`,
    );
  }
  return result;
}

function digestAt(value, field) {
  const digest = stringAt(value, field);
  if (!SHA256_PATTERN.test(digest) || /^sha256:0{64}$/.test(digest)) {
    fail(
      "EVIDENCE_DIGEST_INVALID",
      `${field} must be sha256:<64 lowercase hex>.`,
    );
  }
  return digest;
}

function dateAt(value, field) {
  const raw = stringAt(value, field);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || !/Z$/i.test(raw)) {
    fail(
      "EVIDENCE_TIME_INVALID",
      `${field} must be an ISO 8601 UTC timestamp.`,
    );
  }
  return timestamp;
}

function requireValue(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "EVIDENCE_GATE_NOT_PASSED",
      `${field} must equal ${JSON.stringify(expected)}.`,
    );
  }
}

function exactKeys(value, expected, field) {
  const object = objectAt(value, field);
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(
      "EVIDENCE_ARTIFACT_SCHEMA_INVALID",
      `${field} must contain only the exact approved fields.`,
    );
  }
  return object;
}

function scanForSecrets(value, currentPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSecrets(entry, `${currentPath}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          fail(
            "EVIDENCE_CONTAINS_SECRET",
            `${currentPath} contains URL credentials.`,
          );
        }
      } catch (error) {
        if (error instanceof StagingEvidenceError) throw error;
      }
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const safeBooleanMetadata =
      SAFE_SECRET_METADATA_FIELDS.has(key) && typeof entry === "boolean";
    if (SENSITIVE_KEY_PATTERN.test(key) && !safeBooleanMetadata) {
      fail(
        "EVIDENCE_CONTAINS_SECRET",
        `${currentPath}.${key} is a forbidden sensitive field.`,
      );
    }
    scanForSecrets(entry, `${currentPath}.${key}`);
  }
}

function validateExternalStagingUrl(raw) {
  let url;
  try {
    url = new URL(stringAt(raw, "run.baseUrl"));
  } catch {
    fail("EVIDENCE_URL_INVALID", "run.baseUrl must be an absolute URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail("EVIDENCE_URL_INVALID", "run.baseUrl must be a bare HTTPS origin.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    PRODUCTION_HOSTS.has(hostname) ||
    hostname.endsWith(".modvoltapp.cz") ||
    ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(hostname)
  ) {
    fail(
      "EVIDENCE_TARGET_UNSAFE",
      `run.baseUrl points at forbidden host ${hostname}.`,
    );
  }
  return url.origin;
}

function validateWorkflowUrl(raw, repository, runId, field = "ci.workflowUrl") {
  let url;
  try {
    url = new URL(stringAt(raw, field));
  } catch {
    fail(
      "EVIDENCE_WORKFLOW_URL_INVALID",
      "ci.workflowUrl must be an absolute URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.pathname !== `/${repository}/actions/runs/${runId}`
  ) {
    fail(
      "EVIDENCE_WORKFLOW_URL_INVALID",
      "ci.workflowUrl must link to a GitHub Actions run.",
    );
  }
  return url.toString();
}

function artifactHashAt(artifactBytes, expectedDigest, field) {
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length === 0) {
    fail(
      "EVIDENCE_ARTIFACT_MISSING",
      `${field} bytes are required for offline verification.`,
    );
  }
  const actual = `sha256:${crypto
    .createHash("sha256")
    .update(artifactBytes)
    .digest("hex")}`;
  if (actual !== expectedDigest) {
    fail(
      "EVIDENCE_ARTIFACT_MISMATCH",
      `${field} bytes do not match the declared digest.`,
    );
  }
}

function jsonArtifact(bytes, field) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return objectAt(value, field);
  } catch (error) {
    if (error instanceof StagingEvidenceError) throw error;
    fail("EVIDENCE_ARTIFACT_INVALID", `${field} must be valid JSON.`);
  }
}

function canonicalJsonArtifact(bytes, field, format = "compact") {
  const value = jsonArtifact(bytes, field);
  scanForSecrets(value, field);
  const canonical =
    format === "pretty"
      ? `${JSON.stringify(value, null, 2)}\n`
      : canonicalJson(value);
  if (!bytes.equals(Buffer.from(canonical, "utf8"))) {
    fail(
      "EVIDENCE_ARTIFACT_NOT_CANONICAL",
      `${field} bytes do not match the approved canonical JSON encoding.`,
    );
  }
  return value;
}

function validateBoundArtifacts({
  schemaTransition,
  backupEvidence,
  artifacts,
  commitSha,
  environmentId,
  baseUrl,
  steadyInputSha256,
  ciRunId,
  ciRunAttempt,
  runStartedAt,
  runCompletedAt,
  artifactBytes,
}) {
  requireValue(
    stringAt(schemaTransition.decision, "schemaTransition.decision"),
    "APPLIED",
    "schemaTransition.decision",
  );
  requireValue(
    stringAt(
      schemaTransition.sourceSha,
      "schemaTransition.sourceSha",
    ).toLowerCase(),
    commitSha,
    "schemaTransition.sourceSha",
  );
  requireValue(
    stringAt(
      schemaTransition.latestExpectedTag,
      "schemaTransition.latestExpectedTag",
    ),
    "0105_smooth_nitro",
    "schemaTransition.latestExpectedTag",
  );
  requireValue(
    integerAt(
      schemaTransition.expectedMigrations,
      "schemaTransition.expectedMigrations",
    ),
    105,
    "schemaTransition.expectedMigrations",
  );
  requireValue(
    integerAt(
      schemaTransition.externalStateRows,
      "schemaTransition.externalStateRows",
    ),
    0,
    "schemaTransition.externalStateRows",
  );
  const transitionBackupId = integerAt(
    schemaTransition.backupEvidenceId,
    "schemaTransition.backupEvidenceId",
    { positive: true },
  );
  const backupRestoreAgeHours = numberAt(
    schemaTransition.backupRestoreAgeHours,
    "schemaTransition.backupRestoreAgeHours",
  );
  const backupRestoreMaxAgeHours = integerAt(
    schemaTransition.backupRestoreMaxAgeHours,
    "schemaTransition.backupRestoreMaxAgeHours",
    { positive: true },
  );
  const sourceBackupExecutionSha256 = digestAt(
    schemaTransition.sourceBackupExecutionSha256,
    "schemaTransition.sourceBackupExecutionSha256",
  );
  const backupMaxPayloadBytes = integerAt(
    schemaTransition.backupMaxPayloadBytes,
    "schemaTransition.backupMaxPayloadBytes",
    { positive: true },
  );
  requireValue(
    backupMaxPayloadBytes,
    256 * 1024 * 1024,
    "schemaTransition.backupMaxPayloadBytes",
  );
  const transitionBackupSizeBytes = integerAt(
    schemaTransition.backupSizeBytes,
    "schemaTransition.backupSizeBytes",
    { positive: true },
  );
  if (transitionBackupSizeBytes > backupMaxPayloadBytes) {
    fail(
      "EVIDENCE_BACKUP_SIZE_INVALID",
      "Transition backup exceeds the reviewed 256 MiB ceiling.",
    );
  }
  if (
    backupRestoreMaxAgeHours > 168 ||
    backupRestoreAgeHours > backupRestoreMaxAgeHours
  ) {
    fail(
      "EVIDENCE_BACKUP_STALE",
      "Transition backup exceeds its bounded maximum age.",
    );
  }
  const transitionInputSha256 = digestAt(
    schemaTransition.inputSha256,
    "schemaTransition.inputSha256",
  );
  const schemaGateSha256 = digestAt(
    schemaTransition.evidenceArtifactSha256,
    "schemaTransition.evidenceArtifactSha256",
  );

  const backupId = integerAt(backupEvidence.id, "backupEvidence.id", {
    positive: true,
  });
  requireValue(backupId, transitionBackupId, "backupEvidence.id");
  requireValue(
    stringAt(backupEvidence.status, "backupEvidence.status"),
    "success",
    "backupEvidence.status",
  );
  const backupSizeBytes = integerAt(
    backupEvidence.sizeBytes,
    "backupEvidence.sizeBytes",
    {
      positive: true,
    },
  );
  requireValue(
    backupSizeBytes,
    transitionBackupSizeBytes,
    "backupEvidence.sizeBytes",
  );
  requireValue(
    digestAt(
      backupEvidence.sourceExecutionSha256,
      "backupEvidence.sourceExecutionSha256",
    ),
    sourceBackupExecutionSha256,
    "backupEvidence.sourceExecutionSha256",
  );
  requireValue(
    integerAt(
      backupEvidence.maxPayloadBytes,
      "backupEvidence.maxPayloadBytes",
      { positive: true },
    ),
    backupMaxPayloadBytes,
    "backupEvidence.maxPayloadBytes",
  );
  digestAt(
    backupEvidence.encryptedBackupSha256,
    "backupEvidence.encryptedBackupSha256",
  );
  requireValue(
    stringAt(
      backupEvidence.encryptionFormat,
      "backupEvidence.encryptionFormat",
    ),
    "mve1",
    "backupEvidence.encryptionFormat",
  );
  requireValue(
    stringAt(backupEvidence.restoreStatus, "backupEvidence.restoreStatus"),
    "ok",
    "backupEvidence.restoreStatus",
  );
  const backupCreatedAt = dateAt(
    backupEvidence.createdAt,
    "backupEvidence.createdAt",
  );
  const backupRestoreTestedAt = dateAt(
    backupEvidence.restoreTestedAt,
    "backupEvidence.restoreTestedAt",
  );
  const backupCheckedAt = dateAt(
    backupEvidence.checkedAt,
    "backupEvidence.checkedAt",
  );
  if (
    backupCreatedAt > backupRestoreTestedAt ||
    backupRestoreTestedAt > backupCheckedAt ||
    backupCheckedAt > runCompletedAt
  ) {
    fail(
      "EVIDENCE_TIME_INVALID",
      "Backup evidence timestamps are not chronological.",
    );
  }
  const derivedBackupRestoreAgeHours =
    Math.round(
      ((backupCheckedAt - backupRestoreTestedAt) / (60 * 60 * 1000)) * 1000,
    ) / 1000;
  requireValue(
    numberAt(backupEvidence.restoreAgeHours, "backupEvidence.restoreAgeHours"),
    derivedBackupRestoreAgeHours,
    "backupEvidence.restoreAgeHours",
  );
  requireValue(
    backupRestoreAgeHours,
    derivedBackupRestoreAgeHours,
    "schemaTransition.backupRestoreAgeHours",
  );
  const backupEvidenceSha256 = digestAt(
    backupEvidence.evidenceArtifactSha256,
    "backupEvidence.evidenceArtifactSha256",
  );

  const imageManifest = objectAt(
    artifacts.imageManifest,
    "artifacts.imageManifest",
  );
  requireValue(
    imageManifest.schemaVersion,
    3,
    "artifacts.imageManifest.schemaVersion",
  );
  requireValue(
    stringAt(
      imageManifest.sourceSha,
      "artifacts.imageManifest.sourceSha",
    ).toLowerCase(),
    commitSha,
    "artifacts.imageManifest.sourceSha",
  );
  const imageManifestSha256 = digestAt(
    imageManifest.sha256,
    "artifacts.imageManifest.sha256",
  );
  const callerWorkflowSha = stringAt(
    imageManifest.callerWorkflowSha,
    "artifacts.imageManifest.callerWorkflowSha",
  ).toLowerCase();
  if (
    !FULL_GIT_SHA_PATTERN.test(callerWorkflowSha) ||
    /^0{40}$/.test(callerWorkflowSha)
  ) {
    fail(
      "EVIDENCE_SHA_INVALID",
      "artifacts.imageManifest.callerWorkflowSha must be a non-placeholder full Git SHA.",
    );
  }
  const publisherRunId = stringAt(
    imageManifest.publisherRunId,
    "artifacts.imageManifest.publisherRunId",
  );
  if (!/^[1-9][0-9]*$/.test(publisherRunId)) {
    fail(
      "EVIDENCE_SCHEMA_INVALID",
      "publisherRunId must be a positive decimal string.",
    );
  }
  const publisherRunAttempt = integerAt(
    imageManifest.publisherRunAttempt,
    "artifacts.imageManifest.publisherRunAttempt",
    { positive: true },
  );
  validateWorkflowUrl(
    imageManifest.publisherWorkflowUrl,
    "modvolt/site-logbook-registry",
    publisherRunId,
    "artifacts.imageManifest.publisherWorkflowUrl",
  );

  const deploymentInputs = objectAt(
    artifacts.deploymentInputs,
    "artifacts.deploymentInputs",
  );
  const inspectInputSha256 = digestAt(
    deploymentInputs.inspectSha256,
    "artifacts.deploymentInputs.inspectSha256",
  );
  requireValue(
    digestAt(
      deploymentInputs.transitionSha256,
      "artifacts.deploymentInputs.transitionSha256",
    ),
    transitionInputSha256,
    "artifacts.deploymentInputs.transitionSha256",
  );
  requireValue(
    digestAt(
      deploymentInputs.steadySha256,
      "artifacts.deploymentInputs.steadySha256",
    ),
    steadyInputSha256,
    "artifacts.deploymentInputs.steadySha256",
  );
  const provisioningArtifact = objectAt(
    artifacts.provisioning,
    "artifacts.provisioning",
  );
  requireValue(
    provisioningArtifact.schemaVersion,
    1,
    "artifacts.provisioning.schemaVersion",
  );
  const provisioningSha256 = digestAt(
    provisioningArtifact.sha256,
    "artifacts.provisioning.sha256",
  );
  const bootstrapArtifact = objectAt(
    artifacts.bootstrap,
    "artifacts.bootstrap",
  );
  requireValue(
    bootstrapArtifact.schemaVersion,
    1,
    "artifacts.bootstrap.schemaVersion",
  );
  const bootstrapSha256 = digestAt(
    bootstrapArtifact.sha256,
    "artifacts.bootstrap.sha256",
  );
  requireValue(
    stringAt(
      bootstrapArtifact.sourceSha,
      "artifacts.bootstrap.sourceSha",
    ).toLowerCase(),
    commitSha,
    "artifacts.bootstrap.sourceSha",
  );
  requireValue(
    integerAt(bootstrapArtifact.runId, "artifacts.bootstrap.runId", {
      positive: true,
    }),
    ciRunId,
    "artifacts.bootstrap.runId",
  );
  requireValue(
    integerAt(bootstrapArtifact.runAttempt, "artifacts.bootstrap.runAttempt", {
      positive: true,
    }),
    ciRunAttempt,
    "artifacts.bootstrap.runAttempt",
  );
  validateWorkflowUrl(
    bootstrapArtifact.workflowUrl,
    "modvolt/Site-Logbook",
    ciRunId,
    "artifacts.bootstrap.workflowUrl",
  );
  const bootstrapCapturedAt = dateAt(
    bootstrapArtifact.capturedAt,
    "artifacts.bootstrap.capturedAt",
  );
  if (
    bootstrapCapturedAt < runStartedAt ||
    bootstrapCapturedAt > runCompletedAt
  ) {
    fail(
      "EVIDENCE_TIME_INVALID",
      "Bootstrap capture must occur inside the release run.",
    );
  }

  const bytes = objectAt(artifactBytes, "options.artifactBytes");
  for (const [key, digest] of Object.entries({
    imageManifest: imageManifestSha256,
    inspectInputs: inspectInputSha256,
    transitionInputs: transitionInputSha256,
    steadyInputs: steadyInputSha256,
    schemaGate: schemaGateSha256,
    backupEvidence: backupEvidenceSha256,
    provisioning: provisioningSha256,
    bootstrap: bootstrapSha256,
  })) {
    artifactHashAt(bytes[key], digest, `artifactBytes.${key}`);
  }

  const rawImageManifest = canonicalJsonArtifact(
    bytes.imageManifest,
    "artifactBytes.imageManifest",
    "pretty",
  );
  try {
    const imageManifestHex = imageManifestSha256.slice("sha256:".length);
    validateStagingImageManifest(
      bytes.imageManifest,
      `${imageManifestHex}  staging-images.json\n`,
      {
        expectedManifestSha256: imageManifestHex,
        expectedSourceSha: commitSha,
        expectedCallerWorkflowRef:
          "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
        expectedCallerWorkflowSha: callerWorkflowSha,
        expectedRunId: publisherRunId,
        expectedRunAttempt: String(publisherRunAttempt),
      },
    );
  } catch (error) {
    fail(
      "EVIDENCE_IMAGE_MANIFEST_INVALID",
      `raw image manifest failed strict verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  requireValue(
    rawImageManifest.schemaVersion,
    3,
    "rawImageManifest.schemaVersion",
  );
  requireValue(
    rawImageManifest.sourceSha,
    commitSha,
    "rawImageManifest.sourceSha",
  );
  requireValue(
    rawImageManifest.publisherRun?.id,
    publisherRunId,
    "rawImageManifest.publisherRun.id",
  );
  requireValue(
    Number(rawImageManifest.publisherRun?.attempt),
    publisherRunAttempt,
    "rawImageManifest.publisherRun.attempt",
  );

  const rawProvisioning = canonicalJsonArtifact(
    bytes.provisioning,
    "artifactBytes.provisioning",
  );
  let validatedProvisioning;
  try {
    validatedProvisioning = validateStagingProvisioning(rawProvisioning, {
      expectedSourceSha: commitSha,
    });
  } catch (error) {
    fail(
      "EVIDENCE_PROVISIONING_INVALID",
      `raw provisioning failed strict verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireValue(
    validatedProvisioning.decision,
    "PASS",
    "rawProvisioning.decision",
  );
  requireValue(
    validatedProvisioning.manifestSha256,
    provisioningSha256.slice("sha256:".length),
    "rawProvisioning.manifestSha256",
  );
  requireValue(
    validatedProvisioning.publicAppUrl,
    baseUrl,
    "rawProvisioning.publicAppUrl",
  );

  const rawInputs = {
    inspect: canonicalJsonArtifact(
      bytes.inspectInputs,
      "artifactBytes.inspectInputs",
    ),
    transition: canonicalJsonArtifact(
      bytes.transitionInputs,
      "artifactBytes.transitionInputs",
    ),
    steady: canonicalJsonArtifact(
      bytes.steadyInputs,
      "artifactBytes.steadyInputs",
    ),
  };
  for (const [mode, input] of Object.entries(rawInputs)) {
    const expectedAction =
      mode === "transition"
        ? "apply-0105"
        : mode === "inspect"
          ? "inspect"
          : "steady-0105";
    try {
      validateStagingDeploymentInputs(input, {
        expectedSchemaAction: expectedAction,
        expectedSourceSha: commitSha,
        expectedImageManifestSha256: imageManifestSha256.slice(
          "sha256:".length,
        ),
        expectedProvisioningManifestSha256: provisioningSha256.slice(
          "sha256:".length,
        ),
        expectedProvisioning: validatedProvisioning,
      });
    } catch (error) {
      fail(
        "EVIDENCE_DEPLOYMENT_INPUT_INVALID",
        `raw ${mode} deployment input failed strict verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [field, expected] of Object.entries({
      imageManifestSha256: imageManifestSha256.slice("sha256:".length),
      provisioningManifestSha256: provisioningSha256.slice("sha256:".length),
      environmentId: "site-logbook-staging",
      coolifyEnvironmentId: validatedProvisioning.environmentId,
      composeProjectName: validatedProvisioning.composeProjectName,
      publicAppUrl: validatedProvisioning.publicAppUrl,
      nginxServerName: new URL(validatedProvisioning.publicAppUrl).hostname,
      operationalAlertReceiverUrl: validatedProvisioning.alertReceiverUrl,
      operationalAlertReceiverHost: validatedProvisioning.alertReceiverHost,
      s3Endpoint: validatedProvisioning.s3.endpoint,
      s3Region: validatedProvisioning.s3.region,
      s3Bucket: validatedProvisioning.s3.bucket,
      s3ForcePathStyle: validatedProvisioning.s3.forcePathStyle,
      externalAccountsEnabled: false,
    })) {
      requireValue(input[field], expected, `rawInputs.${mode}.${field}`);
    }
    requireValue(
      canonicalJson(input.images),
      canonicalJson(rawImageManifest.images),
      `rawInputs.${mode}.images`,
    );
  }
  requireValue(
    rawInputs.inspect.backupEvidenceId,
    transitionBackupId,
    "rawInputs.inspect.backupEvidenceId",
  );
  requireValue(
    rawInputs.inspect.backupRestoreMaxAgeHours,
    backupRestoreMaxAgeHours,
    "rawInputs.inspect.backupRestoreMaxAgeHours",
  );
  requireValue(
    rawInputs.transition.backupEvidenceId,
    transitionBackupId,
    "rawInputs.transition.backupEvidenceId",
  );
  requireValue(
    rawInputs.transition.backupRestoreMaxAgeHours,
    backupRestoreMaxAgeHours,
    "rawInputs.transition.backupRestoreMaxAgeHours",
  );
  if (
    Object.hasOwn(rawInputs.steady, "backupEvidenceId") ||
    Object.hasOwn(rawInputs.steady, "backupRestoreMaxAgeHours")
  ) {
    fail(
      "EVIDENCE_GATE_NOT_PASSED",
      "Steady deployment input must omit transition-only backup fields.",
    );
  }
  requireValue(
    canonicalJson(rawInputs.inspect.images),
    canonicalJson(rawInputs.transition.images),
    "rawInputs.inspect.images",
  );
  requireValue(
    canonicalJson(rawInputs.steady.images),
    canonicalJson(rawInputs.transition.images),
    "rawInputs.steady.images",
  );

  const rawSchemaGate = exactKeys(
    canonicalJsonArtifact(bytes.schemaGate, "artifactBytes.schemaGate"),
    [
      "decision",
      "sourceSha",
      "latestExpectedTag",
      "expectedMigrations",
      "excludedMigration0100Present",
      "externalStateRows",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "backupRestoreMaxAgeHours",
      "sourceBackupExecutionSha256",
      "backupMaxPayloadBytes",
      "backupSizeBytes",
      "inputSha256",
    ],
    "rawSchemaGate",
  );
  for (const [field, expected] of Object.entries({
    decision: "APPLIED",
    sourceSha: commitSha,
    latestExpectedTag: "0105_smooth_nitro",
    expectedMigrations: 105,
    excludedMigration0100Present: false,
    externalStateRows: 0,
    backupEvidenceId: transitionBackupId,
    backupRestoreAgeHours,
    backupRestoreMaxAgeHours,
    sourceBackupExecutionSha256,
    backupMaxPayloadBytes,
    backupSizeBytes,
    inputSha256: transitionInputSha256,
  })) {
    requireValue(rawSchemaGate[field], expected, `rawSchemaGate.${field}`);
  }

  const rawBackup = exactKeys(
    canonicalJsonArtifact(bytes.backupEvidence, "artifactBytes.backupEvidence"),
    [
      "id",
      "status",
      "sizeBytes",
      "encryptedBackupSha256",
      "encryptionFormat",
      "restoreStatus",
      "createdAt",
      "restoreTestedAt",
      "checkedAt",
      "restoreAgeHours",
      "sourceExecutionSha256",
      "maxPayloadBytes",
    ],
    "rawBackup",
  );
  for (const [field, expected] of Object.entries({
    id: backupId,
    status: "success",
    sizeBytes: backupEvidence.sizeBytes,
    encryptedBackupSha256: backupEvidence.encryptedBackupSha256,
    encryptionFormat: "mve1",
    restoreStatus: "ok",
    createdAt: backupEvidence.createdAt,
    restoreTestedAt: backupEvidence.restoreTestedAt,
    checkedAt: backupEvidence.checkedAt,
    restoreAgeHours: backupRestoreAgeHours,
    sourceExecutionSha256: sourceBackupExecutionSha256,
    maxPayloadBytes: backupMaxPayloadBytes,
  })) {
    requireValue(rawBackup[field], expected, `rawBackup.${field}`);
  }

  const rawBootstrap = exactKeys(
    canonicalJsonArtifact(bytes.bootstrap, "artifactBytes.bootstrap", "pretty"),
    [
      "schemaVersion",
      "sourceSha",
      "workflowRun",
      "bindings",
      "environmentId",
      "baseOrigin",
      "expectedBuildSha",
      "isolationConfirmed",
      "deepStorageProbeConfirmed",
      "mailSandboxConfirmed",
      "externalAccountsEnabled",
      "adminUsernameConfigured",
      "adminPasswordConfigured",
      "capturedAt",
      "readiness",
      "darkRollout",
      "authenticated",
    ],
    "rawBootstrap",
  );
  exactKeys(
    rawBootstrap.workflowRun,
    ["id", "attempt"],
    "rawBootstrap.workflowRun",
  );
  exactKeys(
    rawBootstrap.bindings,
    [
      "imageManifestSha256",
      "provisioningManifestSha256",
      "deploymentInputsSha256",
    ],
    "rawBootstrap.bindings",
  );
  exactKeys(
    rawBootstrap.readiness,
    [
      "status",
      "dbStatus",
      "migrationParity",
      "version",
      "latestExpectedTag",
      "expectedMigrations",
      "appliedMigrations",
      "missingMigrationTags",
      "excludedMigration0100Present",
      "schemaAction",
    ],
    "rawBootstrap.readiness",
  );
  exactKeys(
    rawBootstrap.darkRollout,
    ["externalAccountsEnabled", "externalAccountCount"],
    "rawBootstrap.darkRollout",
  );
  requireValue(rawBootstrap.schemaVersion, 1, "rawBootstrap.schemaVersion");
  requireValue(rawBootstrap.sourceSha, commitSha, "rawBootstrap.sourceSha");
  requireValue(
    rawBootstrap.environmentId,
    environmentId,
    "rawBootstrap.environmentId",
  );
  requireValue(rawBootstrap.baseOrigin, baseUrl, "rawBootstrap.baseOrigin");
  requireValue(
    rawBootstrap.expectedBuildSha,
    commitSha,
    "rawBootstrap.expectedBuildSha",
  );
  for (const field of [
    "isolationConfirmed",
    "deepStorageProbeConfirmed",
    "mailSandboxConfirmed",
    "adminUsernameConfigured",
    "adminPasswordConfigured",
    "authenticated",
  ]) {
    requireValue(rawBootstrap[field], true, `rawBootstrap.${field}`);
  }
  requireValue(
    rawBootstrap.externalAccountsEnabled,
    false,
    "rawBootstrap.externalAccountsEnabled",
  );
  requireValue(
    rawBootstrap.capturedAt,
    bootstrapArtifact.capturedAt,
    "rawBootstrap.capturedAt",
  );
  requireValue(
    rawBootstrap.workflowRun?.id,
    ciRunId,
    "rawBootstrap.workflowRun.id",
  );
  requireValue(
    rawBootstrap.workflowRun?.attempt,
    ciRunAttempt,
    "rawBootstrap.workflowRun.attempt",
  );
  requireValue(
    rawBootstrap.bindings?.imageManifestSha256,
    imageManifestSha256.slice("sha256:".length),
    "rawBootstrap.bindings.imageManifestSha256",
  );
  requireValue(
    rawBootstrap.bindings?.provisioningManifestSha256,
    provisioningSha256.slice("sha256:".length),
    "rawBootstrap.bindings.provisioningManifestSha256",
  );
  requireValue(
    rawBootstrap.bindings?.deploymentInputsSha256,
    steadyInputSha256.slice("sha256:".length),
    "rawBootstrap.bindings.deploymentInputsSha256",
  );
  for (const [field, expected] of Object.entries({
    status: "ok",
    dbStatus: "ok",
    version: commitSha,
    latestExpectedTag: "0105_smooth_nitro",
    expectedMigrations: 105,
    appliedMigrations: 105,
    migrationParity: true,
    excludedMigration0100Present: false,
    schemaAction: "steady-0105",
  })) {
    requireValue(
      rawBootstrap.readiness?.[field],
      expected,
      `rawBootstrap.readiness.${field}`,
    );
  }
  if (
    !Array.isArray(rawBootstrap.readiness?.missingMigrationTags) ||
    rawBootstrap.readiness.missingMigrationTags.length !== 0
  ) {
    fail(
      "EVIDENCE_GATE_NOT_PASSED",
      "rawBootstrap.readiness.missingMigrationTags must be an empty array.",
    );
  }
  requireValue(
    rawBootstrap.darkRollout?.externalAccountsEnabled,
    false,
    "rawBootstrap.darkRollout.externalAccountsEnabled",
  );
  requireValue(
    rawBootstrap.darkRollout?.externalAccountCount,
    0,
    "rawBootstrap.darkRollout.externalAccountCount",
  );

  return Object.freeze({
    imageManifestSha256,
    provisioningSha256,
    transitionInputSha256,
    steadyInputSha256,
    publisherRunId,
    publisherRunAttempt,
  });
}

export function validateStagingReleaseEvidence(evidence, options = {}) {
  scanForSecrets(evidence);
  const root = objectAt(evidence, "evidence");
  requireValue(root.schemaVersion, 4, "schemaVersion");

  const run = objectAt(root.run, "run");
  const isolation = objectAt(root.isolation, "isolation");
  const ci = objectAt(root.ci, "ci");
  const deployment = objectAt(root.deployment, "deployment");
  const schemaTransition = objectAt(root.schemaTransition, "schemaTransition");
  const backupEvidence = objectAt(root.backupEvidence, "backupEvidence");
  const artifacts = objectAt(root.artifacts, "artifacts");
  const storage = objectAt(root.storage, "storage");
  const recovery = objectAt(root.recovery, "recovery");
  const browser = objectAt(root.browser, "browser");
  const mail = objectAt(root.mail, "mail");
  const alerts = objectAt(root.alerts, "alerts");
  const approvals = objectAt(root.approvals, "approvals");

  exactKeys(
    isolation,
    [
      "confirmed",
      "productionTargetsTouched",
      "productionCopyPresentInsideApprovedBoundary",
      "rawProductionDataOutsideApprovedBoundary",
      "mailSandbox",
    ],
    "isolation",
  );

  const runId = stringAt(run.id, "run.id");
  const environmentId = stringAt(run.environmentId, "run.environmentId");
  if (environmentId !== LOGICAL_STAGING_ENVIRONMENT_ID) {
    fail(
      "EVIDENCE_ENVIRONMENT_UNSAFE",
      `run.environmentId must equal ${LOGICAL_STAGING_ENVIRONMENT_ID}.`,
    );
  }
  const baseUrl = validateExternalStagingUrl(run.baseUrl);
  const commitSha = stringAt(run.commitSha, "run.commitSha").toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(commitSha)) {
    fail(
      "EVIDENCE_SHA_INVALID",
      "run.commitSha must be a full 40-character Git SHA.",
    );
  }
  if (/^0{40}$/.test(commitSha)) {
    fail("EVIDENCE_SHA_INVALID", "run.commitSha cannot be a placeholder.");
  }

  const runStartedAt = dateAt(run.startedAt, "run.startedAt");
  const runCompletedAt = dateAt(run.completedAt, "run.completedAt");
  if (runCompletedAt < runStartedAt) {
    fail(
      "EVIDENCE_TIME_INVALID",
      "run.completedAt must not precede run.startedAt.",
    );
  }

  const now =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  const maxAgeHours = options.maxAgeHours ?? 48;
  if (runCompletedAt > now + 5 * 60_000) {
    fail("EVIDENCE_TIME_INVALID", "run.completedAt is in the future.");
  }
  if (now - runCompletedAt > maxAgeHours * 60 * 60_000) {
    fail("EVIDENCE_STALE", `Evidence is older than ${maxAgeHours} hours.`);
  }

  requireValue(
    booleanAt(isolation.confirmed, "isolation.confirmed"),
    true,
    "isolation.confirmed",
  );
  requireValue(
    booleanAt(
      isolation.productionTargetsTouched,
      "isolation.productionTargetsTouched",
    ),
    false,
    "isolation.productionTargetsTouched",
  );
  requireValue(
    booleanAt(
      isolation.productionCopyPresentInsideApprovedBoundary,
      "isolation.productionCopyPresentInsideApprovedBoundary",
    ),
    true,
    "isolation.productionCopyPresentInsideApprovedBoundary",
  );
  requireValue(
    booleanAt(
      isolation.rawProductionDataOutsideApprovedBoundary,
      "isolation.rawProductionDataOutsideApprovedBoundary",
    ),
    false,
    "isolation.rawProductionDataOutsideApprovedBoundary",
  );
  requireValue(
    booleanAt(isolation.mailSandbox, "isolation.mailSandbox"),
    true,
    "isolation.mailSandbox",
  );

  requireValue(
    stringAt(ci.conclusion, "ci.conclusion"),
    "success",
    "ci.conclusion",
  );
  const ciRunId = integerAt(ci.runId, "ci.runId", { positive: true });
  const ciRunAttempt = integerAt(ci.runAttempt, "ci.runAttempt", {
    positive: true,
  });
  validateWorkflowUrl(ci.workflowUrl, "modvolt/Site-Logbook", ciRunId);
  requireValue(
    stringAt(ci.commitSha, "ci.commitSha").toLowerCase(),
    commitSha,
    "ci.commitSha",
  );

  requireValue(
    stringAt(deployment.healthStatus, "deployment.healthStatus"),
    "ok",
    "deployment.healthStatus",
  );
  requireValue(
    stringAt(
      deployment.healthVersion,
      "deployment.healthVersion",
    ).toLowerCase(),
    commitSha,
    "deployment.healthVersion",
  );
  requireValue(
    booleanAt(deployment.migrationParity, "deployment.migrationParity"),
    true,
    "deployment.migrationParity",
  );
  requireValue(
    stringAt(deployment.latestExpectedTag, "deployment.latestExpectedTag"),
    "0105_smooth_nitro",
    "deployment.latestExpectedTag",
  );
  const expectedMigrations = integerAt(
    deployment.expectedMigrations,
    "deployment.expectedMigrations",
  );
  const appliedMigrations = integerAt(
    deployment.appliedMigrations,
    "deployment.appliedMigrations",
  );
  if (expectedMigrations !== 105 || appliedMigrations !== 105) {
    fail(
      "EVIDENCE_MIGRATION_MISMATCH",
      "Applied and expected migration counts must both equal 105.",
    );
  }
  if (
    !Array.isArray(deployment.missingMigrationTags) ||
    deployment.missingMigrationTags.length !== 0
  ) {
    fail(
      "EVIDENCE_MIGRATION_MISMATCH",
      "deployment.missingMigrationTags must be an empty array.",
    );
  }
  requireValue(
    booleanAt(
      deployment.excludedMigration0100Present,
      "deployment.excludedMigration0100Present",
    ),
    false,
    "deployment.excludedMigration0100Present",
  );
  requireValue(
    stringAt(deployment.schemaAction, "deployment.schemaAction"),
    "steady-0105",
    "deployment.schemaAction",
  );
  requireValue(
    booleanAt(
      deployment.externalAccountsEnabled,
      "deployment.externalAccountsEnabled",
    ),
    false,
    "deployment.externalAccountsEnabled",
  );
  const externalState = objectAt(
    deployment.externalState,
    "deployment.externalState",
  );
  for (const key of [
    "externalUsers",
    "externalAccounts",
    "externalScopes",
    "externalEvents",
    "totalRows",
  ]) {
    requireValue(
      integerAt(externalState[key], `deployment.externalState.${key}`),
      0,
      `deployment.externalState.${key}`,
    );
  }
  const steadyInputSha256 = digestAt(
    deployment.steadyInputSha256,
    "deployment.steadyInputSha256",
  );

  requireValue(
    stringAt(storage.policyPreflight, "storage.policyPreflight"),
    "pass",
    "storage.policyPreflight",
  );
  requireValue(
    booleanAt(storage.distinctTarget, "storage.distinctTarget"),
    true,
    "storage.distinctTarget",
  );
  requireValue(
    stringAt(storage.versioning, "storage.versioning"),
    "enabled",
    "storage.versioning",
  );
  requireValue(
    stringAt(storage.immutableRetention, "storage.immutableRetention"),
    "enabled",
    "storage.immutableRetention",
  );
  digestAt(storage.targetFingerprint, "storage.targetFingerprint");

  requireValue(
    booleanAt(recovery.performed, "recovery.performed"),
    true,
    "recovery.performed",
  );
  requireValue(
    stringAt(recovery.dataClassification, "recovery.dataClassification"),
    "production-copy-restricted",
    "recovery.dataClassification",
  );
  for (const key of [
    "databaseRestore",
    "objectRestore",
    "objectHashesVerified",
    "businessSmoke",
  ]) {
    requireValue(
      booleanAt(recovery[key], `recovery.${key}`),
      true,
      `recovery.${key}`,
    );
  }
  const expectedObjects = numberAt(
    recovery.objectCountExpected,
    "recovery.objectCountExpected",
  );
  const restoredObjects = numberAt(
    recovery.objectCountRestored,
    "recovery.objectCountRestored",
  );
  if (expectedObjects === 0 || restoredObjects !== expectedObjects) {
    fail(
      "EVIDENCE_OBJECT_MISMATCH",
      "Restored and expected object counts must be equal and non-zero.",
    );
  }

  const sourceCreatedAt = dateAt(
    recovery.sourceCreatedAt,
    "recovery.sourceCreatedAt",
  );
  const recoveryStartedAt = dateAt(recovery.startedAt, "recovery.startedAt");
  const recoveryCompletedAt = dateAt(
    recovery.completedAt,
    "recovery.completedAt",
  );
  if (
    sourceCreatedAt > recoveryCompletedAt ||
    recoveryCompletedAt < recoveryStartedAt
  ) {
    fail("EVIDENCE_TIME_INVALID", "Recovery timestamps are not chronological.");
  }
  const rpoMinutes = numberAt(recovery.rpoMinutes, "recovery.rpoMinutes");
  const approvedRpoMinutes = numberAt(
    recovery.approvedRpoMinutes,
    "recovery.approvedRpoMinutes",
  );
  const rtoMinutes = numberAt(recovery.rtoMinutes, "recovery.rtoMinutes");
  const approvedRtoMinutes = numberAt(
    recovery.approvedRtoMinutes,
    "recovery.approvedRtoMinutes",
  );
  const measuredRpoMinutes = (recoveryCompletedAt - sourceCreatedAt) / 60_000;
  const measuredRtoMinutes = (recoveryCompletedAt - recoveryStartedAt) / 60_000;
  if (rpoMinutes + 1 < measuredRpoMinutes || rpoMinutes > approvedRpoMinutes) {
    fail(
      "EVIDENCE_RPO_BREACH",
      "Measured or declared RPO exceeds the approved RPO.",
    );
  }
  if (rtoMinutes + 1 < measuredRtoMinutes || rtoMinutes > approvedRtoMinutes) {
    fail(
      "EVIDENCE_RTO_BREACH",
      "Measured or declared RTO exceeds the approved RTO.",
    );
  }

  const artifactSummary = validateBoundArtifacts({
    schemaTransition,
    backupEvidence,
    artifacts,
    commitSha,
    environmentId,
    baseUrl,
    steadyInputSha256,
    ciRunId,
    ciRunAttempt,
    runStartedAt,
    runCompletedAt,
    artifactBytes: options.artifactBytes,
  });

  for (const key of [
    "authSmoke",
    "adminHealth",
    "pwaAssets",
    "desktopSmoke",
    "mobileSmoke",
  ]) {
    requireValue(
      stringAt(browser[key], `browser.${key}`),
      "pass",
      `browser.${key}`,
    );
  }
  requireValue(
    stringAt(mail.sandboxDelivery, "mail.sandboxDelivery"),
    "pass",
    "mail.sandboxDelivery",
  );
  requireValue(
    stringAt(alerts.freshnessAlertDelivery, "alerts.freshnessAlertDelivery"),
    "pass",
    "alerts.freshnessAlertDelivery",
  );
  requireValue(
    stringAt(alerts.receiverHealth, "alerts.receiverHealth"),
    "pass",
    "alerts.receiverHealth",
  );
  const receiverBuildSha = stringAt(
    alerts.receiverBuildSha,
    "alerts.receiverBuildSha",
  ).toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(receiverBuildSha)) {
    fail(
      "EVIDENCE_SHA_INVALID",
      "alerts.receiverBuildSha must be a full 40-character Git SHA.",
    );
  }
  requireValue(receiverBuildSha, commitSha, "alerts.receiverBuildSha");
  for (const key of [
    "receiverSyntheticDelivery",
    "durableOutboxDelivery",
    "persistentIdempotency",
    "deadManTrigger",
    "deadManRecovery",
  ]) {
    requireValue(
      stringAt(alerts[key], `alerts.${key}`),
      "pass",
      `alerts.${key}`,
    );
  }

  const approvalMode = stringAt(approvals.mode, "approvals.mode");
  const operator = stringAt(approvals.operator, "approvals.operator");
  stringAt(approvals.serviceOwner, "approvals.serviceOwner");
  if (approvalMode === "dual_control") {
    const reviewer = stringAt(approvals.reviewer, "approvals.reviewer");
    if (operator.toLowerCase() === reviewer.toLowerCase()) {
      fail(
        "EVIDENCE_DUAL_CONTROL_MISSING",
        "Operator and reviewer must be different people.",
      );
    }
  } else if (approvalMode === "solo_maintainer") {
    if (approvals.reviewer !== null) {
      fail(
        "EVIDENCE_SOLO_MAINTAINER_INVALID",
        "approvals.reviewer must be null in solo_maintainer mode.",
      );
    }
    requireValue(
      booleanAt(
        approvals.soloMaintainerRiskAccepted,
        "approvals.soloMaintainerRiskAccepted",
      ),
      true,
      "approvals.soloMaintainerRiskAccepted",
    );
    const controls = objectAt(
      approvals.compensatingControls,
      "approvals.compensatingControls",
    );
    for (const key of [
      "mainBranchProtected",
      "exactShaQualityGateRequired",
      "environmentBranchRestricted",
    ]) {
      requireValue(
        booleanAt(controls[key], `approvals.compensatingControls.${key}`),
        true,
        `approvals.compensatingControls.${key}`,
      );
    }
  } else {
    fail(
      "EVIDENCE_APPROVAL_MODE_INVALID",
      "approvals.mode must be dual_control or solo_maintainer.",
    );
  }
  const approvedAt = dateAt(approvals.approvedAt, "approvals.approvedAt");
  if (approvedAt < runCompletedAt || approvedAt > now + 5 * 60_000) {
    fail(
      "EVIDENCE_APPROVAL_TIME_INVALID",
      "Approval must follow completion and cannot be in the future.",
    );
  }

  return Object.freeze({
    schemaVersion: 4,
    runId,
    environmentId,
    baseUrl,
    commitSha,
    completedAt: new Date(runCompletedAt).toISOString(),
    evidenceAgeMinutes: Math.round((now - runCompletedAt) / 60_000),
    expectedMigrations,
    latestExpectedTag: "0105_smooth_nitro",
    ...artifactSummary,
    objectCount: expectedObjects,
    rpoMinutes,
    approvedRpoMinutes,
    rtoMinutes,
    approvedRtoMinutes,
    approvalMode,
    decision: "PASS",
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const evidencePath = argument("--file") ?? process.env.STAGING_EVIDENCE_FILE;
  if (!evidencePath) {
    fail(
      "EVIDENCE_FILE_MISSING",
      "Pass --file <path> or set STAGING_EVIDENCE_FILE.",
    );
  }
  const artifactArguments = {
    imageManifest: "--image-manifest",
    inspectInputs: "--inspect-inputs",
    transitionInputs: "--transition-inputs",
    steadyInputs: "--steady-inputs",
    schemaGate: "--schema-gate-evidence",
    backupEvidence: "--backup-evidence",
    provisioning: "--provisioning",
    bootstrap: "--bootstrap",
  };
  const artifactBytes = {};
  for (const [key, flag] of Object.entries(artifactArguments)) {
    const file = argument(flag);
    if (!file) {
      fail(
        "EVIDENCE_ARTIFACT_MISSING",
        `${flag} <path> is required for offline verification.`,
      );
    }
    artifactBytes[key] = fs.readFileSync(path.resolve(file));
  }
  const absolutePath = path.resolve(evidencePath);
  const evidence = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const summary = validateStagingReleaseEvidence(evidence, { artifactBytes });
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
