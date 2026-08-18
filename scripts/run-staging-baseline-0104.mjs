import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const CONFIRMATION =
  "APPLY_FIXED_PREDECESSOR_0104_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const FIXED_PREDECESSOR_SHA =
  "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const FIXED_TAIL = "0104_thin_sheva_callister";
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export class StagingBaseline0104RunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingBaseline0104RunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingBaseline0104RunnerError(code, message);
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
      "BASELINE_COMMAND_FAILED",
      `${label} failed; inspect the isolated service logs without copying secrets.`,
    );
  }
  if (typeof result.stdout !== "string") {
    fail("BASELINE_COMMAND_OUTPUT_INVALID", `${label} returned no text output.`);
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
      "BASELINE_RUNTIME_NOT_QUIESCENT",
      "The isolated Compose project must have postgres as its only running service.",
    );
  }
}

function parseUniqueMarker(stdout, marker, label) {
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker));
  if (lines.length !== 1) {
    fail(
      "BASELINE_EVIDENCE_MARKER_INVALID",
      `${label} must emit exactly one secret-free evidence marker.`,
    );
  }
  try {
    return JSON.parse(lines[0].slice(marker.length));
  } catch {
    fail(
      "BASELINE_EVIDENCE_JSON_INVALID",
      `${label} evidence marker must contain strict JSON.`,
    );
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("BASELINE_EVIDENCE_INVALID", `${field} must be a positive integer.`);
  }
  return value;
}

function finiteNonnegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("BASELINE_EVIDENCE_INVALID", `${field} must be nonnegative.`);
  }
  return value;
}

function validateGateEvidence(value, phase, expectedInputsSha256) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("BASELINE_EVIDENCE_INVALID", `${phase} evidence must be an object.`);
  }
  const allowedOperation =
    phase === "pre" ? ["migrate", "verified-noop"] : ["ready"];
  if (
    value.phase !== phase ||
    !allowedOperation.includes(value.operation) ||
    value.authorizes0105 !== false ||
    value.inputSha256 !== `sha256:${expectedInputsSha256}` ||
    typeof value.candidateSourceSha !== "string" ||
    !FULL_SHA.test(value.candidateSourceSha) ||
    value.predecessorSourceSha !== FIXED_PREDECESSOR_SHA ||
    value.predecessorMigrations !== 104
  ) {
    fail(
      "BASELINE_EVIDENCE_INVALID",
      `${phase} evidence is not bound to the approved exact-0104 inputs.`,
    );
  }
  if (
    (value.operation === "migrate" &&
      (value.decision !== "BASELINE_0104_REQUIRED" ||
        !Number.isSafeInteger(value.appliedMigrations) ||
        value.appliedMigrations < 0 ||
        value.appliedMigrations >= 104 ||
        value.missingToPredecessor !== 104 - value.appliedMigrations)) ||
    (value.operation !== "migrate" &&
      (value.decision !== "READY_0104" ||
        value.appliedMigrations !== 104 ||
        value.latestAppliedTag !== FIXED_TAIL ||
        value.missingToPredecessor !== 0))
  ) {
    fail(
      "BASELINE_EVIDENCE_STATE_INVALID",
      `${phase} evidence contains an inconsistent journal decision.`,
    );
  }
  positiveInteger(value.backupEvidenceId, `${phase}.backupEvidenceId`);
  finiteNonnegative(
    value.backupRestoreAgeHours,
    `${phase}.backupRestoreAgeHours`,
  );
  return Object.freeze({
    phase,
    operation: value.operation,
    decision: value.decision,
    candidateSourceSha: value.candidateSourceSha,
    predecessorSourceSha: value.predecessorSourceSha,
    appliedMigrations: value.appliedMigrations,
    predecessorMigrations: value.predecessorMigrations,
    latestAppliedTag: value.latestAppliedTag ?? null,
    missingToPredecessor: value.missingToPredecessor,
    backupEvidenceId: value.backupEvidenceId,
    backupRestoreAgeHours: value.backupRestoreAgeHours,
    inputSha256: value.inputSha256,
    authorizes0105: false,
  });
}

function validateMigrationEvidence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.expected !== 104 ||
    value.applied !== 104 ||
    value.latestExpected !== FIXED_TAIL ||
    !Number.isSafeInteger(value.newlyApplied) ||
    value.newlyApplied < 0 ||
    value.newlyApplied > 104
  ) {
    fail(
      "BASELINE_MIGRATION_EVIDENCE_INVALID",
      "Predecessor migrator did not prove exact 104/0104 parity.",
    );
  }
  return Object.freeze({
    expected: 104,
    applied: 104,
    newlyApplied: value.newlyApplied,
    latestExpected: FIXED_TAIL,
  });
}

export function runStagingBaseline0104({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  expectedInputsSha256,
  confirmation,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  if (!SHA256.test(expectedInputsSha256 ?? "")) {
    fail(
      "BASELINE_EXPECTED_INPUTS_INVALID",
      "A separately approved baseline input checksum is required.",
    );
  }
  if (confirmation !== CONFIRMATION) {
    fail(
      "BASELINE_RUNNER_CONFIRMATION_INVALID",
      "The exact baseline runner confirmation is required.",
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
    "baseline-0104",
  ];

  assertOnlyPostgresRunning(execute, composeArgs, "initial quiescence check");
  const preStdout = executeChecked(
    execute,
    [
      ...composeArgs,
      "run",
      "--rm",
      "--no-deps",
      "baseline-0104-preflight",
    ],
    "baseline precheck",
  );
  const precheck = validateGateEvidence(
    parseUniqueMarker(
      preStdout,
      "[staging-baseline-0104] PRECHECK ",
      "baseline precheck",
    ),
    "pre",
    expectedInputsSha256,
  );

  assertOnlyPostgresRunning(execute, composeArgs, "pre-migration quiescence check");
  let migration = null;
  if (precheck.operation === "migrate") {
    const migrationStdout = executeChecked(
      execute,
      [
        ...composeArgs,
        "run",
        "--rm",
        "--no-deps",
        "baseline-0104-migrator",
      ],
      "fixed predecessor migrator",
    );
    migration = validateMigrationEvidence(
      parseUniqueMarker(
        migrationStdout,
        "[migration] success ",
        "fixed predecessor migrator",
      ),
    );
  }

  assertOnlyPostgresRunning(execute, composeArgs, "post-migration quiescence check");
  const postStdout = executeChecked(
    execute,
    [
      ...composeArgs,
      "run",
      "--rm",
      "--no-deps",
      "baseline-0104-postflight",
    ],
    "baseline postcheck",
  );
  const postcheck = validateGateEvidence(
    parseUniqueMarker(
      postStdout,
      "[staging-baseline-0104] POSTCHECK ",
      "baseline postcheck",
    ),
    "post",
    expectedInputsSha256,
  );
  assertOnlyPostgresRunning(execute, composeArgs, "final quiescence check");

  if (
    precheck.candidateSourceSha !== postcheck.candidateSourceSha ||
    precheck.predecessorSourceSha !== postcheck.predecessorSourceSha ||
    precheck.backupEvidenceId !== postcheck.backupEvidenceId
  ) {
    fail(
      "BASELINE_EVIDENCE_CHAIN_MISMATCH",
      "Precheck and postcheck do not describe one bound baseline operation.",
    );
  }
  if (
    (precheck.operation === "migrate" && migration === null) ||
    (precheck.operation === "verified-noop" && migration !== null)
  ) {
    fail(
      "BASELINE_MIGRATION_STATE_MISMATCH",
      "Migrator execution does not match the precheck decision.",
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt,
    completedAt: now().toISOString(),
    inputSha256: `sha256:${expectedInputsSha256}`,
    operation: precheck.operation,
    precheck,
    migration: Object.freeze({
      executed: migration !== null,
      summary: migration,
    }),
    postcheck,
    runtimeIsolation: Object.freeze({
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
    }),
    requiresFreshExact0104BackupAndRestore: true,
    authorizes0105: false,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "BASELINE_EVIDENCE_OUTPUT_EXISTS",
      "Baseline evidence already exists; use a new evidence directory.",
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

function writeExecutionEvidence(directory, evidence) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "BASELINE_EVIDENCE_OUTPUT_INVALID",
      "Evidence output must be a nonsymlink directory.",
    );
  }
  const name = "staging-baseline-0104-execution.json";
  const bytes = canonicalJson(evidence);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = atomicWriteExclusive(absolute, name, bytes);
  const checksum = atomicWriteExclusive(
    absolute,
    "staging-baseline-0104-execution.sha256",
    `${hash}  ${name}\n`,
  );
  return Object.freeze({ target, checksum, sha256: hash });
}

function main() {
  const evidence = runStagingBaseline0104({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    expectedInputsSha256: argument("--expected-inputs-sha256"),
    confirmation: argument("--confirm"),
  });
  const outputDirectory = argument("--output-dir");
  if (!outputDirectory) {
    fail("BASELINE_EVIDENCE_OUTPUT_MISSING", "--output-dir is required.");
  }
  const files = writeExecutionEvidence(outputDirectory, evidence);
  process.stdout.write(
    `${JSON.stringify({ decision: evidence.decision, operation: evidence.operation, files }, null, 2)}\n`,
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
