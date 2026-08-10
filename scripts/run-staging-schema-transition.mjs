import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGING_POSTGRES_INSPECT_FORMAT,
  validateResolvedStagingComposeTarget,
  validateRunningStagingPostgresContainer,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONFIRMATION = "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const LATEST_0105 = "0105_smooth_nitro";
const MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024;

export class StagingSchemaTransitionRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingSchemaTransitionRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingSchemaTransitionRunnerError(code, message);
}

function defaultExecute(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function checked(execute, args, label) {
  const result = execute("docker", args);
  if (result.error || result.status !== 0) {
    fail(
      "SCHEMA_TRANSITION_COMMAND_FAILED",
      `${label} failed; inspect redacted runtime logs before any retry.`,
    );
  }
  return result.stdout ?? "";
}

function assertOnlyPostgresRunning(
  execute,
  composeArgs,
  resolvedBinding,
  phase,
  expectedContainerId,
) {
  const stdout = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--services"],
    phase,
  );
  const services = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (services.length !== 1 || services[0] !== "postgres") {
    fail(
      "SCHEMA_TRANSITION_RUNTIME_NOT_QUIESCENT",
      "The isolated Compose project must have postgres as its only running service.",
    );
  }
  const containerIds = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--quiet", "postgres"],
    `${phase} postgres container lookup`,
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    containerIds.length !== 1 ||
    !/^[0-9a-f]{12,64}$/.test(containerIds[0]) ||
    (expectedContainerId &&
      !expectedContainerId.startsWith(containerIds[0]) &&
      !containerIds[0].startsWith(expectedContainerId))
  ) {
    fail(
      "SCHEMA_TRANSITION_POSTGRES_CONTAINER_INVALID",
      "Exactly one unchanged staging postgres container is required.",
    );
  }
  const expectedId = expectedContainerId ?? containerIds[0];
  const projectionBytes = checked(
    execute,
    ["inspect", "--format", STAGING_POSTGRES_INSPECT_FORMAT, containerIds[0]],
    `${phase} postgres container inspection`,
  );
  let projection;
  try {
    projection = JSON.parse(projectionBytes);
  } catch {
    fail(
      "SCHEMA_TRANSITION_POSTGRES_CONTAINER_INVALID",
      "The secret-free postgres inspection must be strict JSON.",
    );
  }
  try {
    return validateRunningStagingPostgresContainer(
      projection,
      resolvedBinding,
      { expectedContainerId: expectedId },
    );
  } catch {
    fail(
      "SCHEMA_TRANSITION_POSTGRES_CONTAINER_MISMATCH",
      "The live postgres container does not match the isolated resolved target.",
    );
  }
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SCHEMA_TRANSITION_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "SCHEMA_TRANSITION_SCHEMA_INVALID",
      `${field} must contain only approved fields.`,
    );
  }
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail("SCHEMA_TRANSITION_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("SCHEMA_TRANSITION_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  return parsed;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("SCHEMA_TRANSITION_SCHEMA_INVALID", `${field} must be positive.`);
  }
  return value;
}

function trustedJsonArtifact(
  bytes,
  checksumText,
  expectedSha256,
  filename,
  field,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    !SHA256.test(expectedSha256)
  ) {
    fail(
      "SCHEMA_TRANSITION_ARTIFACT_INVALID",
      `${field} bytes and approved checksum are required.`,
    );
  }
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    actualSha256 !== expectedSha256 ||
    checksumText !== `${expectedSha256}  ${filename}\n`
  ) {
    fail(
      "SCHEMA_TRANSITION_ARTIFACT_HASH_MISMATCH",
      `${field} does not match its approved checksum.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("SCHEMA_TRANSITION_ARTIFACT_INVALID", `${field} must be strict JSON.`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "SCHEMA_TRANSITION_ARTIFACT_INVALID",
      `${field} must use canonical JSON bytes.`,
    );
  }
  return Object.freeze({ value, sha256: actualSha256 });
}

function validateTransitionInputs(artifact, expectedSourceSha) {
  let value;
  try {
    value = validateStagingDeploymentInputs(artifact.value, {
      expectedSchemaAction: "apply-0105",
      expectedSourceSha,
    });
  } catch {
    fail(
      "SCHEMA_TRANSITION_INPUTS_INVALID",
      "Transition inputs do not preserve the isolated apply-0105 boundary.",
    );
  }
  return Object.freeze({
    deploymentInputs: value,
    sourceSha: value.sourceSha,
    sha256: artifact.sha256,
    backupId: value.backupEvidenceId,
    backupRestoreMaxAgeHours: value.backupRestoreMaxAgeHours,
  });
}

function validateResolvedComposeTarget(execute, composeArgs, inputs) {
  const stdout = checked(
    execute,
    [...composeArgs, "config", "--format", "json"],
    "resolved Compose target inspection",
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail(
      "SCHEMA_TRANSITION_COMPOSE_INVALID",
      "Resolved Compose target must be strict JSON.",
    );
  }
  try {
    return validateResolvedStagingComposeTarget(
      value,
      inputs.deploymentInputs,
      {
        targetService: "external-schema-gate",
        deploymentInputsSha256: inputs.sha256,
      },
    );
  } catch {
    fail(
      "SCHEMA_TRANSITION_COMPOSE_MISMATCH",
      "Resolved Compose target does not match the approved transition inputs.",
    );
  }
}

function minimalBackupEvidence(backup) {
  exactKeys(
    backup,
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
      "sourceExecutionSha256",
      "maxPayloadBytes",
      "restoreDurationMs",
      "verifiedTableCount",
      "verifiedTablesSha256",
      "destructiveRestorePerformed",
    ],
    "recovery backup evidence",
  );
  positiveInteger(backup.id, "backup id");
  positiveInteger(backup.sizeBytes, "backup size");
  const createdAt = canonicalTimestamp(backup.createdAt, "backup createdAt");
  const restoreTestedAt = canonicalTimestamp(
    backup.restoreTestedAt,
    "backup restoreTestedAt",
  );
  const checkedAt = canonicalTimestamp(backup.checkedAt, "backup checkedAt");
  if (
    !DIGEST.test(String(backup.encryptedBackupSha256)) ||
    !DIGEST.test(String(backup.encryptionKeyIdFingerprint)) ||
    !DIGEST.test(String(backup.objectPathFingerprint)) ||
    !DIGEST.test(String(backup.verifiedTablesSha256)) ||
    backup.encryptionFormat !== "mve1" ||
    typeof backup.restoreAgeHours !== "number" ||
    !Number.isFinite(backup.restoreAgeHours) ||
    backup.restoreAgeHours < 0 ||
    positiveInteger(backup.restoreDurationMs, "restore duration") < 1 ||
    positiveInteger(backup.verifiedTableCount, "verified table count") < 1 ||
    restoreTestedAt < createdAt ||
    checkedAt < restoreTestedAt ||
    backup.destructiveRestorePerformed !== false ||
    !DIGEST.test(String(backup.sourceExecutionSha256)) ||
    backup.maxPayloadBytes !== MAX_BACKUP_PAYLOAD_BYTES ||
    backup.sizeBytes > backup.maxPayloadBytes
  ) {
    fail(
      "SCHEMA_TRANSITION_BACKUP_INVALID",
      "Recovery execution does not contain a valid rich backup snapshot.",
    );
  }
  return Object.freeze({
    id: backup.id,
    status: "success",
    sizeBytes: backup.sizeBytes,
    encryptedBackupSha256: backup.encryptedBackupSha256,
    encryptionFormat: "mve1",
    restoreStatus: "ok",
    createdAt: backup.createdAt,
    restoreTestedAt: backup.restoreTestedAt,
    checkedAt: backup.checkedAt,
    restoreAgeHours: backup.restoreAgeHours,
    sourceExecutionSha256: backup.sourceExecutionSha256,
    maxPayloadBytes: MAX_BACKUP_PAYLOAD_BYTES,
  });
}

function validateRecoveryExecution(artifact, inputs) {
  const value = artifact.value;
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "productionTargetsTouched",
      "startedAt",
      "completedAt",
      "recoveryInputsSha256",
      "gate",
      "runtimeIsolation",
      "nextGate",
      "authorizes0105",
    ],
    "recovery execution",
  );
  const gate = value.gate;
  exactKeys(
    gate,
    [
      "decision",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "expectedMigrations",
      "latestExpectedTag",
      "excludedMigration0100Present",
      "excludedMigration0105Present",
      "externalStateRows",
      "baselineCompletedAt",
      "backup",
      "recoveryInputsSha256",
      "baselineExecutionSha256",
      "authorizes0105",
    ],
    "recovery gate",
  );
  exactKeys(
    value.runtimeIsolation,
    [
      "onlyPostgresRunningAtEveryBoundary",
      "apiStarted",
      "webStarted",
      "externalSchema0105GateStarted",
    ],
    "recovery runtime isolation",
  );
  const startedAt = canonicalTimestamp(value.startedAt, "recovery startedAt");
  const completedAt = canonicalTimestamp(
    value.completedAt,
    "recovery completedAt",
  );
  const baselineCompletedAt = canonicalTimestamp(
    gate.baselineCompletedAt,
    "baseline completedAt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-exact-0104-recovery-execution" ||
    value.decision !== "PASS" ||
    value.productionTargetsTouched !== false ||
    startedAt > completedAt ||
    !DIGEST.test(String(value.recoveryInputsSha256)) ||
    gate.recoveryInputsSha256 !== value.recoveryInputsSha256 ||
    !DIGEST.test(String(gate.baselineExecutionSha256)) ||
    value.nextGate !== "separate-0105-transition-binding-required" ||
    value.authorizes0105 !== false ||
    gate.decision !== "READY_0104_RECOVERY" ||
    gate.environmentId !== "site-logbook-staging" ||
    gate.databaseName !== "site_logbook_staging" ||
    gate.databaseUser !== "site_logbook_staging" ||
    gate.buildSha !== inputs.sourceSha ||
    gate.expectedMigrations !== 104 ||
    gate.latestExpectedTag !== "0104_thin_sheva_callister" ||
    gate.excludedMigration0100Present !== false ||
    gate.excludedMigration0105Present !== false ||
    gate.externalStateRows !== 0 ||
    value.runtimeIsolation.onlyPostgresRunningAtEveryBoundary !== true ||
    value.runtimeIsolation.apiStarted !== false ||
    value.runtimeIsolation.webStarted !== false ||
    value.runtimeIsolation.externalSchema0105GateStarted !== false ||
    gate.authorizes0105 !== false
  ) {
    fail(
      "SCHEMA_TRANSITION_RECOVERY_INVALID",
      "Recovery execution does not prove the isolated exact-0104 state.",
    );
  }
  const backupEvidence = minimalBackupEvidence(gate.backup);
  if (
    backupEvidence.id !== inputs.backupId ||
    canonicalTimestamp(backupEvidence.createdAt, "backup createdAt") <=
      baselineCompletedAt ||
    canonicalTimestamp(backupEvidence.checkedAt, "backup checkedAt") >
      completedAt ||
    backupEvidence.sizeBytes > MAX_BACKUP_PAYLOAD_BYTES
  ) {
    fail(
      "SCHEMA_TRANSITION_BACKUP_MISMATCH",
      "Transition inputs and recovery execution must bind the same backup id.",
    );
  }
  return Object.freeze({
    sha256: artifact.sha256,
    backupEvidence,
  });
}

function parseGateMarker(stdout) {
  const applied = "[external-schema-gate] APPLIED ";
  const noop = "[external-schema-gate] NOOP ";
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(applied) || line.startsWith(noop));
  if (lines.length !== 1) {
    fail(
      "SCHEMA_TRANSITION_MARKER_INVALID",
      "The transition gate must emit exactly one APPLIED or NOOP marker.",
    );
  }
  const mode = lines[0].startsWith(applied) ? "APPLIED" : "NOOP";
  try {
    return Object.freeze({
      mode,
      value: JSON.parse(
        lines[0].slice(mode === "APPLIED" ? applied.length : noop.length),
      ),
    });
  } catch {
    fail(
      "SCHEMA_TRANSITION_MARKER_INVALID",
      "The transition marker must contain strict JSON.",
    );
  }
}

function validatePreTransitionInventory(stdout, inputs) {
  const marker = "[external-schema-inventory] PASS ";
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) {
    fail(
      "SCHEMA_TRANSITION_INVENTORY_INVALID",
      "A new transition intent requires exactly one READY_0104 inventory marker.",
    );
  }
  let value;
  try {
    value = JSON.parse(lines[0].slice(marker.length));
  } catch {
    fail(
      "SCHEMA_TRANSITION_INVENTORY_INVALID",
      "The pre-transition inventory marker must contain strict JSON.",
    );
  }
  exactKeys(
    value,
    [
      "decision",
      "appliedMigrations",
      "predecessorMigrations",
      "latestAppliedTag",
      "missingToPredecessor",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "backupEvidenceId",
      "backupRestoreAgeHours",
    ],
    "pre-transition inventory",
  );
  if (
    value.decision !== "READY_0104" ||
    value.appliedMigrations !== 104 ||
    value.predecessorMigrations !== 104 ||
    value.latestAppliedTag !== "0104_thin_sheva_callister" ||
    value.missingToPredecessor !== 0 ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== inputs.sourceSha ||
    value.backupEvidenceId !== inputs.backupId ||
    typeof value.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(value.backupRestoreAgeHours) ||
    value.backupRestoreAgeHours < 0 ||
    value.backupRestoreAgeHours > inputs.backupRestoreMaxAgeHours
  ) {
    fail(
      "SCHEMA_TRANSITION_INVENTORY_INVALID",
      "The live database must be exact READY_0104 before a new intent is recorded.",
    );
  }
}

function validateRawBackup(value, inputs, previous) {
  exactKeys(
    value,
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
    "transition backup evidence",
  );
  const checkedAt = canonicalTimestamp(value.checkedAt, "backup checkedAt");
  const previousCheckedAt = canonicalTimestamp(
    previous.checkedAt,
    "previous backup checkedAt",
  );
  if (
    value.id !== inputs.backupId ||
    value.status !== "success" ||
    value.sizeBytes !== previous.sizeBytes ||
    value.encryptedBackupSha256 !== previous.encryptedBackupSha256 ||
    value.encryptionFormat !== "mve1" ||
    value.restoreStatus !== "ok" ||
    value.createdAt !== previous.createdAt ||
    value.restoreTestedAt !== previous.restoreTestedAt ||
    value.sourceExecutionSha256 !== previous.sourceExecutionSha256 ||
    value.maxPayloadBytes !== MAX_BACKUP_PAYLOAD_BYTES ||
    value.sizeBytes > value.maxPayloadBytes ||
    checkedAt < previousCheckedAt ||
    typeof value.restoreAgeHours !== "number" ||
    !Number.isFinite(value.restoreAgeHours) ||
    value.restoreAgeHours < previous.restoreAgeHours ||
    value.restoreAgeHours > inputs.backupRestoreMaxAgeHours
  ) {
    fail(
      "SCHEMA_TRANSITION_BACKUP_INVALID",
      "Transition backup snapshot is not the same fresh recovery backup.",
    );
  }
  return Object.freeze(value);
}

function validateApplied(value, inputs, recovery) {
  exactKeys(value, ["schemaGate", "backupEvidence"], "APPLIED marker");
  const schemaGate = value.schemaGate;
  exactKeys(
    schemaGate,
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
    "schema gate evidence",
  );
  const backupEvidence = validateRawBackup(
    value.backupEvidence,
    inputs,
    recovery.backupEvidence,
  );
  if (
    schemaGate.decision !== "APPLIED" ||
    schemaGate.sourceSha !== inputs.sourceSha ||
    schemaGate.latestExpectedTag !== LATEST_0105 ||
    schemaGate.expectedMigrations !== 105 ||
    schemaGate.excludedMigration0100Present !== false ||
    schemaGate.externalStateRows !== 0 ||
    schemaGate.backupEvidenceId !== inputs.backupId ||
    schemaGate.backupRestoreAgeHours !== backupEvidence.restoreAgeHours ||
    schemaGate.backupRestoreMaxAgeHours !== inputs.backupRestoreMaxAgeHours ||
    schemaGate.sourceBackupExecutionSha256 !==
      backupEvidence.sourceExecutionSha256 ||
    schemaGate.backupMaxPayloadBytes !== MAX_BACKUP_PAYLOAD_BYTES ||
    schemaGate.backupSizeBytes !== backupEvidence.sizeBytes ||
    schemaGate.inputSha256 !== `sha256:${inputs.sha256}`
  ) {
    fail(
      "SCHEMA_TRANSITION_APPLIED_INVALID",
      "APPLIED evidence is not bound to the approved transition inputs.",
    );
  }
  return Object.freeze({ schemaGate, backupEvidence });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return target;
}

function ensureOutputDirectory(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "SCHEMA_TRANSITION_OUTPUT_INVALID",
      "Output must be a nonsymlink directory.",
    );
  }
  return absolute;
}

function ensureIntent(directory, expected) {
  const name = "staging-schema-transition-intent.json";
  const checksumName = "staging-schema-transition-intent.sha256";
  const target = path.join(directory, name);
  const checksumTarget = path.join(directory, checksumName);
  const expectedBytes = canonicalJson(expected);
  const expectedSha256 = crypto
    .createHash("sha256")
    .update(expectedBytes)
    .digest("hex");
  if (fs.existsSync(target) || fs.existsSync(checksumTarget)) {
    if (!fs.existsSync(target) || !fs.existsSync(checksumTarget)) {
      fail(
        "SCHEMA_TRANSITION_INTENT_PARTIAL",
        "A partial transition intent exists; preserve it for review.",
      );
    }
    const bytes = fs.readFileSync(target);
    const checksum = fs.readFileSync(checksumTarget, "utf8");
    if (
      !bytes.equals(Buffer.from(expectedBytes, "utf8")) ||
      checksum !== `${expectedSha256}  ${name}\n`
    ) {
      fail(
        "SCHEMA_TRANSITION_INTENT_MISMATCH",
        "Existing transition intent does not match this reviewed operation.",
      );
    }
    return Object.freeze({ reused: true, sha256: expectedSha256 });
  }
  atomicWriteExclusive(directory, name, expectedBytes);
  atomicWriteExclusive(directory, checksumName, `${expectedSha256}  ${name}\n`);
  return Object.freeze({ reused: false, sha256: expectedSha256 });
}

function writeFinalBundle(directory, schemaGate, backupEvidence) {
  const final = path.join(directory, "final");
  if (fs.existsSync(final)) {
    fail(
      "SCHEMA_TRANSITION_OUTPUT_EXISTS",
      "Final transition evidence already exists and is never overwritten.",
    );
  }
  const temporary = path.join(
    directory,
    `.final.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    const artifacts = [
      ["staging-schema-gate.json", canonicalJson(schemaGate)],
      ["staging-backup-evidence.json", canonicalJson(backupEvidence)],
    ];
    for (const [name, bytes] of artifacts) {
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      atomicWriteExclusive(temporary, name, bytes);
      atomicWriteExclusive(temporary, `${name}.sha256`, `${sha256}  ${name}\n`);
    }
    fs.renameSync(temporary, final);
  } finally {
    if (fs.existsSync(temporary))
      fs.rmSync(temporary, { recursive: true, force: true });
  }
  return Object.freeze({
    directory: final,
    schemaGate: path.join(final, "staging-schema-gate.json"),
    backupEvidence: path.join(final, "staging-backup-evidence.json"),
  });
}

export function runStagingSchemaTransition({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  outputDirectory,
  expectedSourceSha,
  confirmation,
  transitionInputsBytes,
  transitionInputsChecksumText,
  expectedTransitionInputsSha256,
  recoveryExecutionBytes,
  recoveryExecutionChecksumText,
  expectedRecoveryExecutionSha256,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  if (!SHA40.test(expectedSourceSha ?? "") || confirmation !== CONFIRMATION) {
    fail(
      "SCHEMA_TRANSITION_CONFIRMATION_INVALID",
      "The exact candidate SHA and isolated apply-0105 confirmation are required.",
    );
  }
  const transitionArtifact = trustedJsonArtifact(
    transitionInputsBytes,
    transitionInputsChecksumText,
    expectedTransitionInputsSha256,
    "staging-deployment-transition.json",
    "transition inputs",
  );
  const inputs = validateTransitionInputs(
    transitionArtifact,
    expectedSourceSha,
  );
  const recoveryArtifact = trustedJsonArtifact(
    recoveryExecutionBytes,
    recoveryExecutionChecksumText,
    expectedRecoveryExecutionSha256,
    "staging-exact-0104-recovery-execution.json",
    "recovery execution",
  );
  const recovery = validateRecoveryExecution(recoveryArtifact, inputs);
  const output = ensureOutputDirectory(outputDirectory);
  if (fs.existsSync(path.join(output, "final"))) {
    fail(
      "SCHEMA_TRANSITION_OUTPUT_EXISTS",
      "Final transition evidence already exists and is never overwritten.",
    );
  }
  const intentValue = Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-schema-transition-intent",
    productionTargetsTouched: false,
    sourceSha: inputs.sourceSha,
    transitionInputsSha256: `sha256:${inputs.sha256}`,
    recoveryExecutionSha256: `sha256:${recovery.sha256}`,
    backupEvidence: recovery.backupEvidence,
    confirmation: CONFIRMATION,
    authorizesOnly: "isolated-0105-transition",
  });
  const composeArgs = [
    "compose",
    "--env-file",
    path.resolve(envFile),
    "-f",
    path.resolve(composeFile),
  ];
  const resolvedBinding = validateResolvedComposeTarget(
    execute,
    composeArgs,
    inputs,
  );
  const initialPostgres = assertOnlyPostgresRunning(
    execute,
    composeArgs,
    resolvedBinding,
    "initial quiescence check",
  );
  const intentPath = path.join(output, "staging-schema-transition-intent.json");
  const intentChecksumPath = path.join(
    output,
    "staging-schema-transition-intent.sha256",
  );
  const hasCompleteIntent =
    fs.existsSync(intentPath) && fs.existsSync(intentChecksumPath);
  if (!hasCompleteIntent) {
    if (fs.existsSync(intentPath) || fs.existsSync(intentChecksumPath)) {
      fail(
        "SCHEMA_TRANSITION_INTENT_PARTIAL",
        "A partial transition intent exists; preserve it for review.",
      );
    }
    let inventoryStdout;
    try {
      inventoryStdout = checked(
        execute,
        [
          ...composeArgs,
          "run",
          "--rm",
          "--no-deps",
          "-e",
          "STAGING_SCHEMA_ACTION=inspect",
          "-e",
          "EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION=",
          "-e",
          `STAGING_DEPLOYMENT_INPUTS_SHA256=${inputs.sha256}`,
          "-e",
          `STAGING_BACKUP_EVIDENCE_ID=${inputs.backupId}`,
          "-e",
          `STAGING_BACKUP_RESTORE_MAX_AGE_HOURS=${inputs.backupRestoreMaxAgeHours}`,
          "external-schema-gate",
          "node",
          "dist/external-schema-inventory.mjs",
        ],
        "pre-transition READY_0104 inventory",
      );
    } finally {
      assertOnlyPostgresRunning(
        execute,
        composeArgs,
        resolvedBinding,
        "post-inventory quiescence check",
        initialPostgres.containerId,
      );
    }
    validatePreTransitionInventory(inventoryStdout, inputs);
  }
  const intent = ensureIntent(output, intentValue);
  assertOnlyPostgresRunning(
    execute,
    composeArgs,
    resolvedBinding,
    "pre-transition quiescence check",
    initialPostgres.containerId,
  );
  let stdout;
  try {
    stdout = checked(
      execute,
      [
        ...composeArgs,
        "run",
        "--rm",
        "--no-deps",
        "-e",
        "STAGING_SCHEMA_ACTION=apply-0105",
        "-e",
        `EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`,
        "-e",
        `STAGING_DEPLOYMENT_INPUTS_SHA256=${inputs.sha256}`,
        "-e",
        `STAGING_BACKUP_EVIDENCE_ID=${inputs.backupId}`,
        "-e",
        `STAGING_BACKUP_RESTORE_MAX_AGE_HOURS=${inputs.backupRestoreMaxAgeHours}`,
        "-e",
        `STAGING_EXACT_0104_BACKUP_EXECUTION_SHA256=${recovery.backupEvidence.sourceExecutionSha256.slice("sha256:".length)}`,
        "-e",
        `STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES=${recovery.backupEvidence.maxPayloadBytes}`,
        "-e",
        `STAGING_EXACT_0104_BACKUP_SIZE_BYTES=${recovery.backupEvidence.sizeBytes}`,
        "external-schema-gate",
        "node",
        "dist/external-schema-gate.mjs",
      ],
      "external schema transition gate",
    );
  } finally {
    assertOnlyPostgresRunning(
      execute,
      composeArgs,
      resolvedBinding,
      "final quiescence check",
      initialPostgres.containerId,
    );
  }
  const marker = parseGateMarker(stdout);
  let evidence;
  if (marker.mode === "APPLIED") {
    evidence = validateApplied(marker.value, inputs, recovery);
  } else {
    if (!intent.reused) {
      fail(
        "SCHEMA_TRANSITION_UNEXPECTED_NOOP",
        "A first-attempt NOOP cannot prove that this runner performed the transition.",
      );
    }
    evidence = validateApplied(marker.value, inputs, recovery);
  }
  const files = writeFinalBundle(
    output,
    evidence.schemaGate,
    evidence.backupEvidence,
  );
  return Object.freeze({
    decision: "PASS",
    recoveredFromReviewedIntent: marker.mode === "NOOP",
    intentSha256: `sha256:${intent.sha256}`,
    completedAt: now().toISOString(),
    files,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) fail("SCHEMA_TRANSITION_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, field) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("SCHEMA_TRANSITION_INPUT_INVALID", `${field} must be a regular file.`);
  }
  return absolute;
}

function main() {
  const transition = regularFile(
    requiredArgument("--transition-inputs"),
    "transition inputs",
  );
  const transitionChecksum = regularFile(
    requiredArgument("--transition-inputs-checksum"),
    "transition inputs checksum",
  );
  const recovery = regularFile(
    requiredArgument("--recovery-execution"),
    "recovery execution",
  );
  const recoveryChecksum = regularFile(
    requiredArgument("--recovery-execution-checksum"),
    "recovery execution checksum",
  );
  const result = runStagingSchemaTransition({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    outputDirectory: requiredArgument("--output-dir"),
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    confirmation: requiredArgument("--confirm"),
    transitionInputsBytes: fs.readFileSync(transition),
    transitionInputsChecksumText: fs.readFileSync(transitionChecksum, "utf8"),
    expectedTransitionInputsSha256: requiredArgument(
      "--expected-transition-inputs-sha256",
    ),
    recoveryExecutionBytes: fs.readFileSync(recovery),
    recoveryExecutionChecksumText: fs.readFileSync(recoveryChecksum, "utf8"),
    expectedRecoveryExecutionSha256: requiredArgument(
      "--expected-recovery-execution-sha256",
    ),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const failure =
      error instanceof StagingSchemaTransitionRunnerError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-schema-transition-runner] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
