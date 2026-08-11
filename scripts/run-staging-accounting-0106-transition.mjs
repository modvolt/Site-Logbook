import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateAccounting0106TransitionInputs,
  validateExact0105BackupExecution,
} from "./check-staging-accounting-0106-binding.mjs";
import {
  STAGING_POSTGRES_INSPECT_FORMAT,
  validateResolvedStagingComposeTarget,
  validateRunningStagingPostgresContainer,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONFIRMATION =
  "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const INTENT_NAME = "staging-accounting-0106-intent.json";
const INTENT_CHECKSUM_NAME = "staging-accounting-0106-intent.sha256";
const EXECUTION_NAME = "staging-accounting-0106-execution.json";
const EXECUTION_CHECKSUM_NAME = "staging-accounting-0106-execution.sha256";

export class StagingAccounting0106TransitionRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAccounting0106TransitionRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingAccounting0106TransitionRunnerError(code, message);
}

function defaultExecute(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function checked(execute, args, label) {
  const result = execute("docker", args);
  if (result.error || result.status !== 0) {
    fail(
      "ACCOUNTING_0106_COMMAND_FAILED",
      `${label} failed without producing approved evidence.`,
    );
  }
  return result.stdout ?? "";
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ACCOUNTING_0106_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "ACCOUNTING_0106_SCHEMA_INVALID",
      `${field} must contain only approved fields.`,
    );
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("ACCOUNTING_0106_SCHEMA_INVALID", `${field} must be positive.`);
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail("ACCOUNTING_0106_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail("ACCOUNTING_0106_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  return date;
}

function trustedJsonArtifact(
  bytes,
  checksumText,
  expectedSha256,
  expectedName,
  label,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    !SHA256.test(expectedSha256 ?? "")
  ) {
    fail(
      "ACCOUNTING_0106_INPUT_INVALID",
      `${label} bytes and expected checksum are required.`,
    );
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    sha256 !== expectedSha256 ||
    checksumText !== `${expectedSha256}  ${expectedName}\n`
  ) {
    fail(
      "ACCOUNTING_0106_INPUT_HASH_MISMATCH",
      `${label} does not match its separately approved checksum.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("ACCOUNTING_0106_INPUT_INVALID", `${label} must be strict JSON.`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "ACCOUNTING_0106_INPUT_CANONICAL_INVALID",
      `${label} must use canonical JSON bytes.`,
    );
  }
  return Object.freeze({ value, sha256 });
}

export function validateStagingAccounting0106TransitionArtifacts({
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
  if (!SHA40.test(expectedSourceSha ?? "")) {
    fail(
      "ACCOUNTING_0106_SOURCE_INVALID",
      "The separately approved candidate source SHA is required.",
    );
  }
  const transitionArtifact = trustedJsonArtifact(
    transitionBytes,
    transitionChecksumText,
    expectedTransitionSha256,
    "staging-accounting-0106-transition.json",
    "accounting transition inputs",
  );
  const transition = validateAccounting0106TransitionInputs(
    transitionArtifact.value,
  );
  if (transition.sourceSha !== expectedSourceSha) {
    fail(
      "ACCOUNTING_0106_SOURCE_MISMATCH",
      "Transition inputs and candidate source SHA differ.",
    );
  }
  const inspectArtifact = trustedJsonArtifact(
    inspectBytes,
    inspectChecksumText,
    expectedInspectSha256,
    "staging-accounting-0106-inspect.json",
    "derived accounting inspect inputs",
  );
  let inspect;
  try {
    inspect = validateStagingDeploymentInputs(inspectArtifact.value, {
      expectedSchemaAction: "inspect",
      expectedSourceSha,
    });
  } catch {
    fail(
      "ACCOUNTING_0106_INSPECT_INVALID",
      "Derived inspect inputs do not match the exact candidate.",
    );
  }
  const backupArtifact = trustedJsonArtifact(
    backupExecutionBytes,
    backupExecutionChecksumText,
    expectedBackupExecutionSha256,
    "staging-exact-0105-backup-execution.json",
    "exact-0105 backup execution",
  );
  const backup = validateExact0105BackupExecution(
    backupArtifact.value,
    expectedSourceSha,
  );
  if (
    transition.derivedInspectInputsSha256 !==
      `sha256:${inspectArtifact.sha256}` ||
    transition.backupExecutionSha256 !== `sha256:${backupArtifact.sha256}` ||
    transition.originalInspectInputsSha256 !==
      `sha256:${backup.inspectInputsSha256}` ||
    transition.backupEvidence.previousId !== backup.previousBackupId ||
    transition.backupEvidence.id !== backup.backupId ||
    transition.backupEvidence.sizeBytes !== backup.sizeBytes ||
    transition.backupEvidence.maxPayloadBytes !== backup.maxPayloadBytes ||
    transition.backupEvidence.createdAt !== backup.createdAt ||
    transition.backupEvidence.restoreTestedAt !== backup.restoreTestedAt ||
    inspect.backupEvidenceId !== backup.backupId
  ) {
    fail(
      "ACCOUNTING_0106_INPUT_CHAIN_MISMATCH",
      "Transition, derived inspect and exact-0105 backup artifacts are not one chain.",
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
  });
}

export function validateStagingAccounting0106Execution(value, inputs) {
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
      "transitionInputsSha256",
      "derivedInspectInputsSha256",
      "backupExecutionSha256",
      "intentSha256",
      "schemaGate",
      "backupEvidence",
      "runtimeIsolation",
      "migration0106AppliedOrVerified",
      "authorizesApplicationStart",
      "nextGate",
    ],
    "accounting 0106 execution",
  );
  exactKeys(
    value.runtimeIsolation,
    [
      "onlyPostgresRunningAtEveryBoundary",
      "samePostgresContainerAtEveryBoundary",
      "apiStarted",
      "webStarted",
      "externalSchema0105GateStarted",
      "accountingSchema0106GateStartedOnlyAsOneShot",
    ],
    "accounting 0106 runtime isolation",
  );
  const startedAt = canonicalTimestamp(value.startedAt, "execution startedAt");
  const completedAt = canonicalTimestamp(
    value.completedAt,
    "execution completedAt",
  );
  const gateEvidence = validateGateEvidence(
    {
      schemaGate: value.schemaGate,
      backupEvidence: value.backupEvidence,
    },
    inputs,
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-accounting-0106-execution" ||
    value.decision !== "PASS" ||
    !["applied", "verified-noop"].includes(value.operation) ||
    value.productionTargetsTouched !== false ||
    value.sourceSha !== inputs.sourceSha ||
    value.transitionInputsSha256 !== `sha256:${inputs.transitionSha256}` ||
    value.derivedInspectInputsSha256 !== `sha256:${inputs.inspectSha256}` ||
    value.backupExecutionSha256 !== `sha256:${inputs.backupExecutionSha256}` ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.intentSha256)) ||
    completedAt < startedAt ||
    value.runtimeIsolation.onlyPostgresRunningAtEveryBoundary !== true ||
    value.runtimeIsolation.samePostgresContainerAtEveryBoundary !== true ||
    value.runtimeIsolation.apiStarted !== false ||
    value.runtimeIsolation.webStarted !== false ||
    value.runtimeIsolation.externalSchema0105GateStarted !== false ||
    value.runtimeIsolation.accountingSchema0106GateStartedOnlyAsOneShot !==
      true ||
    value.migration0106AppliedOrVerified !== true ||
    value.authorizesApplicationStart !== false ||
    value.nextGate !== "accounting-0106-release-evidence-required"
  ) {
    fail(
      "ACCOUNTING_0106_EXECUTION_INVALID",
      "Execution evidence does not preserve the exact transition and isolation contract.",
    );
  }
  return Object.freeze({ ...value, ...gateEvidence });
}

function validateResolvedComposeTarget(execute, composeArgs, inputs) {
  const stdout = checked(
    execute,
    [...composeArgs, "config", "--format", "json"],
    "resolved accounting 0106 target inspection",
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail(
      "ACCOUNTING_0106_COMPOSE_INVALID",
      "Resolved Compose target must be strict JSON.",
    );
  }
  try {
    return validateResolvedStagingComposeTarget(value, inputs.inspect, {
      targetService: "accounting-schema-gate",
      deploymentInputsSha256: inputs.inspectSha256,
      accountingInputsSha256: inputs.transitionSha256,
      exact0105BackupExecutionSha256: inputs.backupExecutionSha256,
      exact0105BackupMaxPayloadBytes: inputs.backup.maxPayloadBytes,
      exact0105BackupSizeBytes: inputs.backup.sizeBytes,
    });
  } catch {
    fail(
      "ACCOUNTING_0106_COMPOSE_MISMATCH",
      "Resolved Compose target does not match the approved accounting transition chain.",
    );
  }
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
      "ACCOUNTING_0106_RUNTIME_NOT_QUIESCENT",
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
      "ACCOUNTING_0106_POSTGRES_CONTAINER_INVALID",
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
      "ACCOUNTING_0106_POSTGRES_CONTAINER_INVALID",
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
      "ACCOUNTING_0106_POSTGRES_CONTAINER_MISMATCH",
      "The live postgres container does not match the isolated resolved target.",
    );
  }
}

function parseSingleMarker(stdout, prefix, label) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) {
    fail(
      "ACCOUNTING_0106_MARKER_INVALID",
      `${label} must emit exactly one secret-free marker.`,
    );
  }
  try {
    return JSON.parse(lines[0].slice(prefix.length));
  } catch {
    fail(
      "ACCOUNTING_0106_MARKER_INVALID",
      `${label} marker must contain strict JSON.`,
    );
  }
}

function validateInventory(value, inputs, allowAlready0106) {
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
      "externalStateRows",
    ],
    "accounting inventory",
  );
  const ready =
    value.decision === "READY_0105" &&
    value.appliedMigrations === 105 &&
    value.predecessorMigrations === 105 &&
    value.latestAppliedTag === "0105_smooth_nitro" &&
    value.missingToPredecessor === 0 &&
    value.backupEvidenceId === inputs.backup.backupId &&
    typeof value.backupRestoreAgeHours === "number" &&
    value.backupRestoreAgeHours >= 0 &&
    value.backupRestoreAgeHours <= inputs.inspect.backupRestoreMaxAgeHours;
  const already =
    allowAlready0106 &&
    value.decision === "ALREADY_0106" &&
    value.appliedMigrations === 106 &&
    value.predecessorMigrations === 105 &&
    value.latestAppliedTag === "0106_graceful_frog_thor" &&
    value.missingToPredecessor === 0 &&
    value.backupEvidenceId === null &&
    value.backupRestoreAgeHours === null;
  if (
    (!ready && !already) ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== inputs.sourceSha ||
    value.externalStateRows !== 0
  ) {
    fail(
      "ACCOUNTING_0106_INVENTORY_INVALID",
      "Inventory must prove exact 0105, or exact 0106 only during intent recovery.",
    );
  }
  return Object.freeze(value);
}

function validateBackupEvidence(value, inputs) {
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
      "sourceExecutionSha256",
      "maxPayloadBytes",
    ],
    "accounting backup evidence",
  );
  const createdAt = canonicalTimestamp(value.createdAt, "backup createdAt");
  const restoredAt = canonicalTimestamp(
    value.restoreTestedAt,
    "backup restoreTestedAt",
  );
  const checkedAt = canonicalTimestamp(value.checkedAt, "backup checkedAt");
  if (
    value.id !== inputs.backup.backupId ||
    value.sizeBytes !== inputs.backup.sizeBytes ||
    value.maxPayloadBytes !== MAX_PAYLOAD_BYTES ||
    value.sourceExecutionSha256 !== `sha256:${inputs.backupExecutionSha256}` ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.encryptedBackupSha256)) ||
    value.encryptionFormat !== "mve1" ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.encryptionKeyIdFingerprint)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.objectPathFingerprint)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.verifiedTablesSha256)) ||
    positiveInteger(value.restoreDurationMs, "restore duration") < 1 ||
    positiveInteger(value.verifiedTableCount, "verified table count") < 1 ||
    typeof value.restoreAgeHours !== "number" ||
    value.restoreAgeHours < 0 ||
    value.restoreAgeHours > inputs.inspect.backupRestoreMaxAgeHours ||
    value.destructiveRestorePerformed !== false ||
    createdAt > restoredAt ||
    restoredAt > checkedAt
  ) {
    fail(
      "ACCOUNTING_0106_BACKUP_EVIDENCE_INVALID",
      "Gate backup evidence does not match the reviewed exact-0105 execution.",
    );
  }
  return Object.freeze(value);
}

function validateGateEvidence(value, inputs) {
  exactKeys(
    value,
    ["schemaGate", "backupEvidence"],
    "accounting gate evidence",
  );
  const gate = value.schemaGate;
  exactKeys(
    gate,
    [
      "decision",
      "sourceSha",
      "predecessorTag",
      "latestExpectedTag",
      "expectedMigrations",
      "excludedMigration0100Present",
      "accountingEvidenceRows",
      "externalStateRows",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "backupRestoreMaxAgeHours",
      "sourceBackupExecutionSha256",
      "backupMaxPayloadBytes",
      "backupSizeBytes",
      "inputSha256",
      "migration",
    ],
    "accounting schema gate",
  );
  exactKeys(
    gate.migration,
    ["idx", "when", "tag", "sha256"],
    "accounting migration evidence",
  );
  if (
    gate.decision !== "APPLIED" ||
    gate.sourceSha !== inputs.sourceSha ||
    gate.predecessorTag !== "0105_smooth_nitro" ||
    gate.latestExpectedTag !== "0106_graceful_frog_thor" ||
    gate.expectedMigrations !== 106 ||
    gate.excludedMigration0100Present !== false ||
    gate.accountingEvidenceRows !== 0 ||
    gate.externalStateRows !== 0 ||
    gate.backupEvidenceId !== inputs.backup.backupId ||
    typeof gate.backupRestoreAgeHours !== "number" ||
    gate.backupRestoreAgeHours < 0 ||
    gate.backupRestoreAgeHours > inputs.inspect.backupRestoreMaxAgeHours ||
    gate.backupRestoreMaxAgeHours !== inputs.inspect.backupRestoreMaxAgeHours ||
    gate.sourceBackupExecutionSha256 !==
      `sha256:${inputs.backupExecutionSha256}` ||
    gate.backupMaxPayloadBytes !== MAX_PAYLOAD_BYTES ||
    gate.backupSizeBytes !== inputs.backup.sizeBytes ||
    gate.inputSha256 !== `sha256:${inputs.transitionSha256}` ||
    gate.migration.idx !== 106 ||
    gate.migration.when !== 1786459128910 ||
    gate.migration.tag !== "0106_graceful_frog_thor" ||
    gate.migration.sha256 !==
      "sha256:697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd"
  ) {
    fail(
      "ACCOUNTING_0106_GATE_EVIDENCE_INVALID",
      "The gate evidence does not prove the exact isolated 0106 transition.",
    );
  }
  const backupEvidence = validateBackupEvidence(value.backupEvidence, inputs);
  if (
    backupEvidence.restoreAgeHours !== gate.backupRestoreAgeHours ||
    backupEvidence.id !== gate.backupEvidenceId ||
    backupEvidence.sizeBytes !== gate.backupSizeBytes
  ) {
    fail(
      "ACCOUNTING_0106_GATE_EVIDENCE_MISMATCH",
      "Schema and backup evidence must come from one post-transition snapshot.",
    );
  }
  return Object.freeze({ schemaGate: gate, backupEvidence });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "ACCOUNTING_0106_OUTPUT_EXISTS",
      `${name} already exists; preserve it and use a new directory.`,
    );
  }
  const temporary = path.join(
    directory,
    `.${name}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return target;
}

function prepareOutput(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "ACCOUNTING_0106_OUTPUT_INVALID",
      "Output must be a nonsymlink directory.",
    );
  }
  if (
    fs.existsSync(path.join(absolute, EXECUTION_NAME)) ||
    fs.existsSync(path.join(absolute, EXECUTION_CHECKSUM_NAME))
  ) {
    fail(
      "ACCOUNTING_0106_OUTPUT_EXISTS",
      "Final execution evidence already exists and is never overwritten.",
    );
  }
  return absolute;
}

function ensureIntent(directory, expected) {
  const bytes = canonicalJson(expected);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(directory, INTENT_NAME);
  const checksum = path.join(directory, INTENT_CHECKSUM_NAME);
  const targetExists = fs.existsSync(target);
  const checksumExists = fs.existsSync(checksum);
  if (targetExists !== checksumExists) {
    fail(
      "ACCOUNTING_0106_INTENT_PARTIAL",
      "A partial transition intent exists; preserve it for review.",
    );
  }
  if (targetExists) {
    if (
      fs.readFileSync(target, "utf8") !== bytes ||
      fs.readFileSync(checksum, "utf8") !== `${sha256}  ${INTENT_NAME}\n`
    ) {
      fail(
        "ACCOUNTING_0106_INTENT_MISMATCH",
        "Existing transition intent differs from the reviewed chain.",
      );
    }
    return Object.freeze({ sha256, reused: true });
  }
  atomicWriteExclusive(directory, INTENT_NAME, bytes);
  atomicWriteExclusive(
    directory,
    INTENT_CHECKSUM_NAME,
    `${sha256}  ${INTENT_NAME}\n`,
  );
  return Object.freeze({ sha256, reused: false });
}

function writeExecution(directory, evidence) {
  const bytes = canonicalJson(evidence);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = atomicWriteExclusive(directory, EXECUTION_NAME, bytes);
  const checksum = atomicWriteExclusive(
    directory,
    EXECUTION_CHECKSUM_NAME,
    `${sha256}  ${EXECUTION_NAME}\n`,
  );
  return Object.freeze({ target, checksum, sha256 });
}

export function runStagingAccounting0106Transition({
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
  if (confirmation !== CONFIRMATION) {
    fail(
      "ACCOUNTING_0106_CONFIRMATION_INVALID",
      "The exact isolated 0106 confirmation phrase is required.",
    );
  }
  const inputs = validateStagingAccounting0106TransitionArtifacts({
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
  const output = prepareOutput(outputDirectory);
  const intentValue = Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-accounting-0106-intent",
    productionTargetsTouched: false,
    sourceSha: inputs.sourceSha,
    transitionInputsSha256: `sha256:${inputs.transitionSha256}`,
    derivedInspectInputsSha256: `sha256:${inputs.inspectSha256}`,
    backupExecutionSha256: `sha256:${inputs.backupExecutionSha256}`,
    backupEvidence: inputs.transition.backupEvidence,
    confirmation: CONFIRMATION,
    authorizesOnly: "isolated-exact-0105-to-0106-transition",
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
  const hasIntent =
    fs.existsSync(path.join(output, INTENT_NAME)) &&
    fs.existsSync(path.join(output, INTENT_CHECKSUM_NAME));
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
        "ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION=",
        "accounting-schema-gate",
        "node",
        "dist/accounting-schema-inventory.mjs",
      ],
      "pre-transition accounting inventory",
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
  validateInventory(
    parseSingleMarker(
      inventoryStdout,
      "[accounting-schema-inventory] PASS ",
      "accounting inventory",
    ),
    inputs,
    hasIntent,
  );
  const intent = ensureIntent(output, intentValue);
  assertOnlyPostgresRunning(
    execute,
    composeArgs,
    resolvedBinding,
    "pre-transition quiescence check",
    initialPostgres.containerId,
  );
  const startedAt = now().toISOString();
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
        "STAGING_ACCOUNTING_SCHEMA_ACTION=apply-0106",
        "-e",
        `ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`,
        "-e",
        `STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256=${inputs.transitionSha256}`,
        "-e",
        `STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256=${inputs.backupExecutionSha256}`,
        "-e",
        `STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES=${inputs.backup.maxPayloadBytes}`,
        "-e",
        `STAGING_EXACT_0105_BACKUP_SIZE_BYTES=${inputs.backup.sizeBytes}`,
        "accounting-schema-gate",
        "node",
        "dist/accounting-schema-gate.mjs",
      ],
      "accounting 0106 transition gate",
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
  const appliedPrefix = "[accounting-schema-gate] APPLIED ";
  const noopPrefix = "[accounting-schema-gate] NOOP ";
  const appliedLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(appliedPrefix));
  const noopLines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(noopPrefix));
  if (appliedLines.length + noopLines.length !== 1) {
    fail(
      "ACCOUNTING_0106_MARKER_INVALID",
      "The transition gate must emit exactly one APPLIED or NOOP marker.",
    );
  }
  const operation = appliedLines.length === 1 ? "applied" : "verified-noop";
  if (operation === "verified-noop" && !intent.reused) {
    fail(
      "ACCOUNTING_0106_UNEXPECTED_NOOP",
      "A first-attempt NOOP cannot prove that this runner performed the transition.",
    );
  }
  const evidenceValue = parseSingleMarker(
    stdout,
    appliedLines.length === 1 ? appliedPrefix : noopPrefix,
    "accounting transition gate",
  );
  const gateEvidence = validateGateEvidence(evidenceValue, inputs);
  const completedAt = now().toISOString();
  if (
    canonicalTimestamp(completedAt, "completedAt") <
    canonicalTimestamp(startedAt, "startedAt")
  ) {
    fail(
      "ACCOUNTING_0106_TIME_INVALID",
      "completedAt must not precede startedAt.",
    );
  }
  const execution = Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-accounting-0106-execution",
    decision: "PASS",
    operation,
    productionTargetsTouched: false,
    startedAt,
    completedAt,
    sourceSha: inputs.sourceSha,
    transitionInputsSha256: `sha256:${inputs.transitionSha256}`,
    derivedInspectInputsSha256: `sha256:${inputs.inspectSha256}`,
    backupExecutionSha256: `sha256:${inputs.backupExecutionSha256}`,
    intentSha256: `sha256:${intent.sha256}`,
    schemaGate: gateEvidence.schemaGate,
    backupEvidence: gateEvidence.backupEvidence,
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      samePostgresContainerAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
      accountingSchema0106GateStartedOnlyAsOneShot: true,
    },
    migration0106AppliedOrVerified: true,
    authorizesApplicationStart: false,
    nextGate: "accounting-0106-release-evidence-required",
  });
  validateStagingAccounting0106Execution(execution, inputs);
  const files = writeExecution(output, execution);
  return Object.freeze({ execution, files });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) fail("ACCOUNTING_0106_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("ACCOUNTING_0106_INPUT_INVALID", `${label} must be a regular file.`);
  }
  return absolute;
}

function main() {
  const transition = regularFile(
    requiredArgument("--transition-inputs"),
    "accounting transition inputs",
  );
  const transitionChecksum = regularFile(
    requiredArgument("--transition-inputs-checksum"),
    "accounting transition checksum",
  );
  const inspect = regularFile(
    requiredArgument("--inspect-inputs"),
    "derived accounting inspect inputs",
  );
  const inspectChecksum = regularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "derived accounting inspect checksum",
  );
  const backup = regularFile(
    requiredArgument("--backup-execution"),
    "exact-0105 backup execution",
  );
  const backupChecksum = regularFile(
    requiredArgument("--backup-execution-checksum"),
    "exact-0105 backup execution checksum",
  );
  const result = runStagingAccounting0106Transition({
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
      error instanceof StagingAccounting0106TransitionRunnerError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-accounting-0106-transition] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
