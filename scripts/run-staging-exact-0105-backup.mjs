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
const CONFIRMATION =
  "CREATE_FRESH_EXACT_0105_STAGING_BACKUP_AND_RESTORE_TEST_NO_0106";
const ACTION = "create-exact-0105-accounting-backup";
const LATEST_0105 = "0105_smooth_nitro";
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const EVIDENCE_NAME = "staging-exact-0105-backup-execution.json";
const CHECKSUM_NAME = "staging-exact-0105-backup-execution.sha256";

export class StagingExact0105BackupRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingExact0105BackupRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingExact0105BackupRunnerError(code, message);
}

function defaultExecute(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function checked(execute, args, label) {
  const result = execute("docker", args);
  if (result.error || result.status !== 0) {
    fail(
      "EXACT_0105_BACKUP_COMMAND_FAILED",
      `${label} failed without producing approved evidence.`,
    );
  }
  return result.stdout ?? "";
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EXACT_0105_BACKUP_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "EXACT_0105_BACKUP_SCHEMA_INVALID",
      `${field} must contain only approved fields.`,
    );
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("EXACT_0105_BACKUP_SCHEMA_INVALID", `${field} must be positive.`);
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail("EXACT_0105_BACKUP_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail("EXACT_0105_BACKUP_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  return date;
}

function parseTrustedInspectDeployment(
  bytes,
  checksumText,
  expectedSha256,
  expectedSourceSha,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    !SHA256.test(expectedSha256 ?? "")
  ) {
    fail(
      "EXACT_0105_BACKUP_INSPECT_INVALID",
      "The approved inspect deployment bytes and SHA-256 are required.",
    );
  }
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    actualSha256 !== expectedSha256 ||
    checksumText !== `${expectedSha256}  staging-deployment-inspect.json\n`
  ) {
    fail(
      "EXACT_0105_BACKUP_INSPECT_HASH_MISMATCH",
      "Inspect deployment bytes do not match the separately approved checksum.",
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "EXACT_0105_BACKUP_INSPECT_INVALID",
      "Inspect deployment inputs must be strict JSON.",
    );
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "EXACT_0105_BACKUP_INSPECT_INVALID",
      "Inspect deployment inputs must use canonical JSON bytes.",
    );
  }
  try {
    return Object.freeze({
      inputs: validateStagingDeploymentInputs(value, {
        expectedSchemaAction: "inspect",
        expectedSourceSha,
      }),
      sha256: actualSha256,
    });
  } catch {
    fail(
      "EXACT_0105_BACKUP_INSPECT_INVALID",
      "Inspect deployment inputs do not match the strict staging contract.",
    );
  }
}

function validateResolvedComposeTarget(
  execute,
  composeArgs,
  inspectDeployment,
) {
  const stdout = checked(
    execute,
    [...composeArgs, "config", "--format", "json"],
    "resolved exact-0105 backup target inspection",
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail(
      "EXACT_0105_BACKUP_COMPOSE_INVALID",
      "Resolved Compose target must be strict JSON.",
    );
  }
  try {
    return validateResolvedStagingComposeTarget(
      value,
      inspectDeployment.inputs,
      {
        targetService: "exact-0105-accounting-backup",
        deploymentInputsSha256: inspectDeployment.sha256,
      },
    );
  } catch {
    fail(
      "EXACT_0105_BACKUP_COMPOSE_MISMATCH",
      "Resolved Compose target does not match the approved inspect inputs.",
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
      "EXACT_0105_BACKUP_RUNTIME_NOT_QUIESCENT",
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
      "EXACT_0105_BACKUP_POSTGRES_CONTAINER_INVALID",
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
      "EXACT_0105_BACKUP_POSTGRES_CONTAINER_INVALID",
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
      "EXACT_0105_BACKUP_POSTGRES_CONTAINER_MISMATCH",
      "The live postgres container does not match the isolated resolved target.",
    );
  }
}

function parseMarker(stdout) {
  const marker = "[staging-exact-0105-backup] PASS ";
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) {
    fail(
      "EXACT_0105_BACKUP_MARKER_INVALID",
      "The one-shot must emit exactly one secret-free PASS marker.",
    );
  }
  try {
    return JSON.parse(lines[0].slice(marker.length));
  } catch {
    fail(
      "EXACT_0105_BACKUP_MARKER_INVALID",
      "The PASS marker must contain strict JSON.",
    );
  }
}

function validateMarker(value, inspectDeployment, expectedSourceSha) {
  exactKeys(
    value,
    [
      "decision",
      "environmentId",
      "databaseName",
      "databaseUser",
      "buildSha",
      "expectedMigrations",
      "latestExpectedTag",
      "excludedMigration0100Present",
      "excludedMigration0106Present",
      "accountingEvidenceRows",
      "externalStateRows",
      "previousBackupId",
      "backupId",
      "createdAt",
      "restoreTestedAt",
      "restoreDurationMs",
      "verifiedTableCount",
      "sizeBytes",
      "maxPayloadBytes",
      "encryptionFormat",
      "retentionPruned",
      "destructiveRestorePerformed",
      "nextGate",
      "authorizes0106",
    ],
    "backup marker",
  );
  const createdAt = canonicalTimestamp(value.createdAt, "backup createdAt");
  const restoreTestedAt = canonicalTimestamp(
    value.restoreTestedAt,
    "backup restoreTestedAt",
  );
  if (
    value.decision !== "CREATED_AND_RESTORE_VERIFIED" ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    value.buildSha !== expectedSourceSha ||
    value.expectedMigrations !== 105 ||
    value.latestExpectedTag !== LATEST_0105 ||
    value.excludedMigration0100Present !== false ||
    value.excludedMigration0106Present !== false ||
    value.accountingEvidenceRows !== 0 ||
    value.externalStateRows !== 0 ||
    value.previousBackupId !== inspectDeployment.inputs.backupEvidenceId ||
    positiveInteger(value.backupId, "new backup id") <=
      value.previousBackupId ||
    restoreTestedAt < createdAt ||
    positiveInteger(value.restoreDurationMs, "restore duration") < 1 ||
    positiveInteger(value.verifiedTableCount, "verified table count") < 1 ||
    positiveInteger(value.sizeBytes, "backup size") > MAX_PAYLOAD_BYTES ||
    value.maxPayloadBytes !== MAX_PAYLOAD_BYTES ||
    value.encryptionFormat !== "mve1" ||
    value.retentionPruned !== false ||
    value.destructiveRestorePerformed !== false ||
    value.nextGate !== "accounting-0106-transition-binding-required" ||
    value.authorizes0106 !== false
  ) {
    fail(
      "EXACT_0105_BACKUP_EVIDENCE_INVALID",
      "The one-shot evidence is not bound to the approved exact-0105 state.",
    );
  }
  return Object.freeze(value);
}

export function runStagingExact0105Backup({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  expectedSourceSha,
  confirmation,
  inspectDeploymentBytes,
  inspectDeploymentChecksumText,
  expectedInspectDeploymentSha256,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  if (!SHA40.test(expectedSourceSha ?? "")) {
    fail(
      "EXACT_0105_BACKUP_SOURCE_INVALID",
      "The separately approved exact candidate source SHA is required.",
    );
  }
  if (confirmation !== CONFIRMATION) {
    fail(
      "EXACT_0105_BACKUP_CONFIRMATION_INVALID",
      "The exact isolated backup confirmation phrase is required.",
    );
  }
  const inspectDeployment = parseTrustedInspectDeployment(
    inspectDeploymentBytes,
    inspectDeploymentChecksumText,
    expectedInspectDeploymentSha256,
    expectedSourceSha,
  );
  const composeArgs = [
    "compose",
    "--env-file",
    path.resolve(envFile),
    "-f",
    path.resolve(composeFile),
    "--profile",
    "exact-0105-accounting-backup",
  ];
  const resolvedBinding = validateResolvedComposeTarget(
    execute,
    composeArgs,
    inspectDeployment,
  );
  const startedAt = now().toISOString();
  const initialPostgres = assertOnlyPostgresRunning(
    execute,
    composeArgs,
    resolvedBinding,
    "initial quiescence check",
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
        `STAGING_EXACT_0105_BACKUP_ACTION=${ACTION}`,
        "-e",
        `STAGING_EXACT_0105_BACKUP_CONFIRMATION=${CONFIRMATION}`,
        "exact-0105-accounting-backup",
        "node",
        "dist/accounting-schema-exact-0105-backup.mjs",
      ],
      "exact-0105 accounting backup one-shot",
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
  const gate = validateMarker(
    parseMarker(stdout),
    inspectDeployment,
    expectedSourceSha,
  );
  const completedAt = now().toISOString();
  if (canonicalTimestamp(completedAt, "completedAt") < new Date(startedAt)) {
    fail(
      "EXACT_0105_BACKUP_TIME_INVALID",
      "completedAt must not precede startedAt.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0105-backup-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt,
    completedAt,
    sourceSha: expectedSourceSha,
    inspectDeploymentInputsSha256: `sha256:${inspectDeployment.sha256}`,
    gate,
    runtimeIsolation: Object.freeze({
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
      accountingSchema0106GateStarted: false,
    }),
    nextGate: "accounting-0106-transition-binding-required",
    authorizes0106: false,
  });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "EXACT_0105_BACKUP_OUTPUT_EXISTS",
      `${name} already exists; use a new evidence directory.`,
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

export function prepareStagingExact0105BackupOutput(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "EXACT_0105_BACKUP_OUTPUT_INVALID",
      "Output must be a nonsymlink directory.",
    );
  }
  for (const name of [EVIDENCE_NAME, CHECKSUM_NAME]) {
    if (fs.existsSync(path.join(absolute, name))) {
      fail(
        "EXACT_0105_BACKUP_OUTPUT_EXISTS",
        `${name} already exists; use a new evidence directory.`,
      );
    }
  }
  return absolute;
}

export function writeStagingExact0105BackupEvidence(directory, evidence) {
  const absolute = prepareStagingExact0105BackupOutput(directory);
  const bytes = canonicalJson(evidence);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = atomicWriteExclusive(absolute, EVIDENCE_NAME, bytes);
  const checksum = atomicWriteExclusive(
    absolute,
    CHECKSUM_NAME,
    `${sha256}  ${EVIDENCE_NAME}\n`,
  );
  return Object.freeze({ target, checksum, sha256 });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) fail("EXACT_0105_BACKUP_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("EXACT_0105_BACKUP_INPUT_INVALID", `${label} must be a regular file.`);
  }
  return absolute;
}

function main() {
  const output = prepareStagingExact0105BackupOutput(
    requiredArgument("--output-dir"),
  );
  const inspect = regularFile(
    requiredArgument("--inspect-inputs"),
    "inspect deployment inputs",
  );
  const inspectChecksum = regularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "inspect deployment inputs checksum",
  );
  const evidence = runStagingExact0105Backup({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    confirmation: requiredArgument("--confirm"),
    inspectDeploymentBytes: fs.readFileSync(inspect),
    inspectDeploymentChecksumText: fs.readFileSync(inspectChecksum, "utf8"),
    expectedInspectDeploymentSha256: requiredArgument(
      "--expected-inspect-inputs-sha256",
    ),
  });
  const files = writeStagingExact0105BackupEvidence(output, evidence);
  process.stdout.write(
    `${JSON.stringify({ decision: evidence.decision, backupId: evidence.gate.backupId, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const failure =
      error instanceof StagingExact0105BackupRunnerError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-exact-0105-backup-runner] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
