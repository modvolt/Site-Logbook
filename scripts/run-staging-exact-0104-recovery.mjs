import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LATEST_0104 = "0104_thin_sheva_callister";

export class StagingExact0104RecoveryRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingExact0104RecoveryRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingExact0104RecoveryRunnerError(code, message);
}

function defaultExecute(args) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function executeChecked(execute, args, label) {
  const result = execute(args);
  if (result?.error || result?.status !== 0) {
    fail(
      "RECOVERY_COMMAND_FAILED",
      `${label} failed; inspect isolated logs without copying secrets.`,
    );
  }
  if (typeof result.stdout !== "string") {
    fail(
      "RECOVERY_COMMAND_OUTPUT_INVALID",
      `${label} returned no text output.`,
    );
  }
  return result.stdout;
}

function assertOnlyPostgresRunning(execute, composeArgs, label) {
  const stdout = executeChecked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--services"],
    label,
  );
  const services = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (services.length !== 1 || services[0] !== "postgres") {
    fail(
      "RECOVERY_RUNTIME_NOT_QUIESCENT",
      "The isolated Compose project must have postgres as its only running service.",
    );
  }
}

function parseMarker(stdout) {
  const marker = "[staging-exact-0104-recovery] PASS ";
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) {
    fail(
      "RECOVERY_EVIDENCE_MARKER_INVALID",
      "Recovery gate must emit exactly one secret-free PASS marker.",
    );
  }
  try {
    return JSON.parse(lines[0].slice(marker.length));
  } catch {
    fail(
      "RECOVERY_EVIDENCE_JSON_INVALID",
      "Recovery evidence marker must contain strict JSON.",
    );
  }
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail("RECOVERY_EVIDENCE_TIME_INVALID", `${field} must be ISO UTC.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(
      "RECOVERY_EVIDENCE_TIME_INVALID",
      `${field} must be canonical ISO UTC.`,
    );
  }
  return date;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("RECOVERY_EVIDENCE_INVALID", `${field} must be a positive integer.`);
  }
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "RECOVERY_EVIDENCE_SCHEMA_INVALID",
      `${field} must contain only the approved fields.`,
    );
  }
}

function validateEvidence(value, expectedInputsSha256) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RECOVERY_EVIDENCE_INVALID", "Recovery evidence must be an object.");
  }
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
      "excludedMigration0105Present",
      "externalStateRows",
      "baselineCompletedAt",
      "backup",
      "authorizes0105",
      "recoveryInputsSha256",
      "baselineExecutionSha256",
    ],
    "recovery evidence",
  );
  const backup = value.backup;
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    fail("RECOVERY_EVIDENCE_INVALID", "Recovery backup evidence is missing.");
  }
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
      "restoreDurationMs",
      "verifiedTableCount",
      "verifiedTablesSha256",
      "destructiveRestorePerformed",
    ],
    "recovery backup evidence",
  );
  if (
    value.decision !== "READY_0104_RECOVERY" ||
    value.environmentId !== "site-logbook-staging" ||
    value.databaseName !== "site_logbook_staging" ||
    value.databaseUser !== "site_logbook_staging" ||
    typeof value.buildSha !== "string" ||
    !SHA40.test(value.buildSha) ||
    value.expectedMigrations !== 104 ||
    value.latestExpectedTag !== LATEST_0104 ||
    value.excludedMigration0100Present !== false ||
    value.excludedMigration0105Present !== false ||
    value.externalStateRows !== 0 ||
    value.recoveryInputsSha256 !== `sha256:${expectedInputsSha256}` ||
    !DIGEST.test(value.baselineExecutionSha256) ||
    value.authorizes0105 !== false
  ) {
    fail(
      "RECOVERY_EVIDENCE_INVALID",
      "Recovery evidence is not bound to the approved exact-0104 inputs.",
    );
  }
  const baselineCompletedAt = canonicalTimestamp(
    value.baselineCompletedAt,
    "baselineCompletedAt",
  );
  const createdAt = canonicalTimestamp(backup.createdAt, "backup.createdAt");
  const restoreTestedAt = canonicalTimestamp(
    backup.restoreTestedAt,
    "backup.restoreTestedAt",
  );
  const checkedAt = canonicalTimestamp(backup.checkedAt, "backup.checkedAt");
  if (
    createdAt <= baselineCompletedAt ||
    restoreTestedAt < createdAt ||
    checkedAt < restoreTestedAt
  ) {
    fail(
      "RECOVERY_EVIDENCE_TIME_INVALID",
      "Baseline, backup and restore-test timestamps are not chronological.",
    );
  }
  positiveInteger(backup.id, "backup.id");
  positiveInteger(backup.sizeBytes, "backup.sizeBytes");
  positiveInteger(backup.restoreDurationMs, "backup.restoreDurationMs");
  positiveInteger(backup.verifiedTableCount, "backup.verifiedTableCount");
  if (
    !DIGEST.test(backup.encryptedBackupSha256) ||
    backup.encryptionFormat !== "mve1" ||
    !DIGEST.test(backup.encryptionKeyIdFingerprint) ||
    !DIGEST.test(backup.objectPathFingerprint) ||
    !DIGEST.test(backup.verifiedTablesSha256) ||
    typeof backup.restoreAgeHours !== "number" ||
    !Number.isFinite(backup.restoreAgeHours) ||
    backup.restoreAgeHours < 0 ||
    backup.destructiveRestorePerformed !== false
  ) {
    fail(
      "RECOVERY_BACKUP_EVIDENCE_INVALID",
      "Backup evidence must be encrypted, hashed, restore-tested and non-destructive.",
    );
  }
  return Object.freeze({
    decision: "READY_0104_RECOVERY",
    environmentId: value.environmentId,
    databaseName: value.databaseName,
    databaseUser: value.databaseUser,
    buildSha: value.buildSha,
    expectedMigrations: 104,
    latestExpectedTag: LATEST_0104,
    excludedMigration0100Present: false,
    excludedMigration0105Present: false,
    externalStateRows: 0,
    baselineCompletedAt: baselineCompletedAt.toISOString(),
    backup: Object.freeze({
      id: backup.id,
      sizeBytes: backup.sizeBytes,
      encryptedBackupSha256: backup.encryptedBackupSha256,
      encryptionFormat: "mve1",
      encryptionKeyIdFingerprint: backup.encryptionKeyIdFingerprint,
      objectPathFingerprint: backup.objectPathFingerprint,
      createdAt: createdAt.toISOString(),
      restoreTestedAt: restoreTestedAt.toISOString(),
      checkedAt: checkedAt.toISOString(),
      restoreAgeHours: backup.restoreAgeHours,
      restoreDurationMs: backup.restoreDurationMs,
      verifiedTableCount: backup.verifiedTableCount,
      verifiedTablesSha256: backup.verifiedTablesSha256,
      destructiveRestorePerformed: false,
    }),
    recoveryInputsSha256: value.recoveryInputsSha256,
    baselineExecutionSha256: value.baselineExecutionSha256,
    authorizes0105: false,
  });
}

export function runStagingExact0104Recovery({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  expectedInputsSha256,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  if (
    typeof expectedInputsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedInputsSha256)
  ) {
    fail(
      "RECOVERY_EXPECTED_INPUTS_INVALID",
      "A separately approved recovery input checksum is required.",
    );
  }
  const startedAt = now().toISOString();
  const composeArgs = [
    "compose",
    "--env-file",
    path.resolve(envFile),
    "-f",
    path.resolve(composeFile),
    "--profile",
    "exact-0104-recovery",
  ];
  assertOnlyPostgresRunning(execute, composeArgs, "initial quiescence check");
  const stdout = executeChecked(
    execute,
    [...composeArgs, "run", "--rm", "--no-deps", "exact-0104-recovery-gate"],
    "exact-0104 recovery gate",
  );
  const gate = validateEvidence(parseMarker(stdout), expectedInputsSha256);
  assertOnlyPostgresRunning(execute, composeArgs, "final quiescence check");
  return Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0104-recovery-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt,
    completedAt: now().toISOString(),
    recoveryInputsSha256: `sha256:${expectedInputsSha256}`,
    gate,
    runtimeIsolation: Object.freeze({
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
    }),
    nextGate: "separate-0105-transition-binding-required",
    authorizes0105: false,
  });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "RECOVERY_OUTPUT_EXISTS",
      "Recovery evidence already exists; use a new evidence directory.",
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

function writeEvidence(directory, evidence) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("RECOVERY_OUTPUT_INVALID", "Output must be a nonsymlink directory.");
  }
  const name = "staging-exact-0104-recovery-execution.json";
  const bytes = canonicalJson(evidence);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = atomicWriteExclusive(absolute, name, bytes);
  const checksum = atomicWriteExclusive(
    absolute,
    "staging-exact-0104-recovery-execution.sha256",
    `${sha256}  ${name}\n`,
  );
  return Object.freeze({ target, checksum, sha256 });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const evidence = runStagingExact0104Recovery({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    expectedInputsSha256: argument("--expected-inputs-sha256"),
  });
  const outputDirectory = argument("--output-dir");
  if (!outputDirectory)
    fail("RECOVERY_OUTPUT_MISSING", "--output-dir is required.");
  const files = writeEvidence(outputDirectory, evidence);
  process.stdout.write(
    `${JSON.stringify({ decision: evidence.decision, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
