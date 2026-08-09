import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const API_IMAGE =
  /^ghcr\.io\/modvolt\/site-logbook-staging-api@sha256:[0-9a-f]{64}$/;
const LATEST_0104 = "0104_thin_sheva_callister";
const FIXED_PREDECESSOR_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const FIXED_PREDECESSOR_TREE = "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
const SENSITIVE_KEY =
  /(password|secret|token|credential|keyring|databaseurl|connectionstring|authorization|privatekey|accesskey|sessionkey)/i;

export class StagingExact0104RecoveryBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingExact0104RecoveryBindingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingExact0104RecoveryBindingError(code, message);
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RECOVERY_BINDING_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "RECOVERY_BINDING_SCHEMA_INVALID",
      `${field} must contain only the approved fields.`,
    );
  }
}

function scanForSensitiveFields(value, currentPath) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSensitiveFields(entry, `${currentPath}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SENSITIVE_KEY.test(normalizedKey)) {
      fail(
        "RECOVERY_BINDING_SECRET_MATERIAL",
        `${currentPath}.${key} is a forbidden sensitive field.`,
      );
    }
    if (typeof entry === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      try {
        const url = new URL(entry);
        if (url.username || url.password) {
          fail(
            "RECOVERY_BINDING_SECRET_MATERIAL",
            `${currentPath}.${key} contains URL credentials.`,
          );
        }
      } catch (error) {
        if (error instanceof StagingExact0104RecoveryBindingError) throw error;
      }
    }
    scanForSensitiveFields(entry, `${currentPath}.${key}`);
  }
}

function requireHash(value, field) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("RECOVERY_BINDING_HASH_INVALID", `${field} must be 64 lowercase hex.`);
  }
  return value;
}

function positiveInteger(value, field, maximum = 2 ** 31 - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      "RECOVERY_BINDING_NUMBER_INVALID",
      `${field} must be a positive bounded integer.`,
    );
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail(
      "RECOVERY_BINDING_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(
      "RECOVERY_BINDING_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  return value;
}

function parseTrustedArtifact(
  bytes,
  checksumText,
  expectedSha256,
  filename,
  label,
) {
  const expected = requireHash(expectedSha256, `${label} expected checksum`);
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected || checksumText !== `${expected}  ${filename}\n`) {
    fail(
      "RECOVERY_BINDING_ARTIFACT_UNTRUSTED",
      `${label} bytes, checksum file and separately approved checksum must match.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "RECOVERY_BINDING_ARTIFACT_INVALID",
      `${label} must contain strict JSON.`,
    );
  }
  objectAt(value, label);
  scanForSensitiveFields(value, label);
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    fail(
      "RECOVERY_BINDING_ARTIFACT_INVALID",
      `${label} must contain canonical JSON bytes.`,
    );
  }
  return Object.freeze({
    value,
    sha256: actual,
    base64: bytes.toString("base64"),
  });
}

function validateBaselineInputs(value, expectedSha256) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "action",
      "productionTargetsTouched",
      "environmentId",
      "composeProjectName",
      "database",
      "externalAccountsEnabled",
      "candidate",
      "predecessor",
      "backup",
      "target",
      "nextGate",
      "authorizes0105",
    ],
    "baseline inputs",
  );
  const candidate = objectAt(value.candidate, "baseline inputs candidate");
  const database = objectAt(value.database, "baseline inputs database");
  const predecessor = objectAt(
    value.predecessor,
    "baseline inputs predecessor",
  );
  const publisherRun = objectAt(
    predecessor.publisherRun,
    "baseline inputs predecessor publisherRun",
  );
  const backup = objectAt(value.backup, "baseline inputs backup");
  const target = objectAt(value.target, "baseline inputs target");
  exactKeys(
    candidate,
    [
      "sourceSha",
      "imageManifestSha256",
      "provisioningManifestSha256",
      "inspectInputsSha256",
      "apiImage",
    ],
    "baseline inputs candidate",
  );
  exactKeys(database, ["host", "name", "user"], "baseline inputs database");
  exactKeys(
    predecessor,
    [
      "sourceSha",
      "sourceTree",
      "imageManifestSha256",
      "apiImage",
      "publisherRun",
    ],
    "baseline inputs predecessor",
  );
  exactKeys(publisherRun, ["id", "attempt"], "baseline inputs publisherRun");
  exactKeys(
    backup,
    ["evidenceId", "restoreMaxAgeHours"],
    "baseline inputs backup",
  );
  exactKeys(
    target,
    ["migrationCount", "latestTag", "excluded0100", "excluded0105"],
    "baseline inputs target",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-baseline-0104" ||
    value.action !== "apply-0104-baseline" ||
    value.productionTargetsTouched !== false ||
    value.environmentId !== "site-logbook-staging" ||
    typeof value.composeProjectName !== "string" ||
    !/^site-logbook-staging(?:-[a-z0-9-]+)?$/.test(value.composeProjectName) ||
    value.externalAccountsEnabled !== false ||
    value.nextGate !== "fresh-exact-0104-backup-and-restore-required" ||
    value.authorizes0105 !== false ||
    database.host !== "postgres" ||
    database.name !== "site_logbook_staging" ||
    database.user !== "site_logbook_staging" ||
    !SHA40.test(String(candidate.sourceSha)) ||
    !API_IMAGE.test(String(candidate.apiImage)) ||
    !SHA256.test(String(candidate.imageManifestSha256)) ||
    !SHA256.test(String(candidate.provisioningManifestSha256)) ||
    !SHA256.test(String(candidate.inspectInputsSha256)) ||
    predecessor.sourceSha !== FIXED_PREDECESSOR_SHA ||
    predecessor.sourceTree !== FIXED_PREDECESSOR_TREE ||
    !SHA256.test(String(predecessor.imageManifestSha256)) ||
    !API_IMAGE.test(String(predecessor.apiImage)) ||
    predecessor.apiImage === candidate.apiImage ||
    typeof publisherRun.id !== "string" ||
    !/^[1-9][0-9]*$/.test(publisherRun.id) ||
    typeof publisherRun.attempt !== "string" ||
    !/^[1-9][0-9]*$/.test(publisherRun.attempt) ||
    target.migrationCount !== 104 ||
    target.latestTag !== LATEST_0104 ||
    target.excluded0100 !== true ||
    target.excluded0105 !== true
  ) {
    fail(
      "RECOVERY_BINDING_BASELINE_INPUTS_INVALID",
      "Baseline inputs do not preserve the exact-0104 isolated boundary.",
    );
  }
  return {
    inputsSha256: expectedSha256,
    candidate,
    database,
    environmentId: value.environmentId,
    composeProjectName: value.composeProjectName,
    oldBackupId: positiveInteger(
      backup.evidenceId,
      "baseline backup evidence id",
    ),
  };
}

function validateBaselineExecution(value, executionSha256, baseline) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "productionTargetsTouched",
      "startedAt",
      "completedAt",
      "inputSha256",
      "operation",
      "precheck",
      "migration",
      "postcheck",
      "runtimeIsolation",
      "requiresFreshExact0104BackupAndRestore",
      "authorizes0105",
    ],
    "baseline execution",
  );
  const precheck = objectAt(value.precheck, "baseline execution precheck");
  const migration = objectAt(value.migration, "baseline execution migration");
  const postcheck = objectAt(value.postcheck, "baseline execution postcheck");
  const isolation = objectAt(
    value.runtimeIsolation,
    "baseline execution runtime isolation",
  );
  const operation = value.operation;
  exactKeys(
    precheck,
    [
      "phase",
      "operation",
      "decision",
      "candidateSourceSha",
      "predecessorSourceSha",
      "appliedMigrations",
      "predecessorMigrations",
      "latestAppliedTag",
      "missingToPredecessor",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "inputSha256",
      "authorizes0105",
    ],
    "baseline execution precheck",
  );
  exactKeys(migration, ["executed", "summary"], "baseline execution migration");
  exactKeys(
    postcheck,
    [
      "phase",
      "operation",
      "decision",
      "candidateSourceSha",
      "predecessorSourceSha",
      "appliedMigrations",
      "predecessorMigrations",
      "latestAppliedTag",
      "missingToPredecessor",
      "backupEvidenceId",
      "backupRestoreAgeHours",
      "inputSha256",
      "authorizes0105",
    ],
    "baseline execution postcheck",
  );
  exactKeys(
    isolation,
    [
      "onlyPostgresRunningAtEveryBoundary",
      "apiStarted",
      "webStarted",
      "externalSchema0105GateStarted",
    ],
    "baseline execution runtime isolation",
  );
  const startedAt = canonicalTimestamp(value.startedAt, "baseline startedAt");
  const completedAt = canonicalTimestamp(
    value.completedAt,
    "baseline completedAt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-baseline-0104-execution" ||
    value.decision !== "PASS" ||
    value.productionTargetsTouched !== false ||
    value.inputSha256 !== `sha256:${baseline.inputsSha256}` ||
    !["migrate", "verified-noop"].includes(operation) ||
    value.requiresFreshExact0104BackupAndRestore !== true ||
    value.authorizes0105 !== false ||
    postcheck.phase !== "post" ||
    postcheck.operation !== "ready" ||
    postcheck.decision !== "READY_0104" ||
    postcheck.candidateSourceSha !== baseline.candidate.sourceSha ||
    postcheck.predecessorSourceSha !== FIXED_PREDECESSOR_SHA ||
    postcheck.appliedMigrations !== 104 ||
    postcheck.predecessorMigrations !== 104 ||
    postcheck.latestAppliedTag !== LATEST_0104 ||
    postcheck.missingToPredecessor !== 0 ||
    postcheck.inputSha256 !== value.inputSha256 ||
    postcheck.authorizes0105 !== false ||
    typeof postcheck.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(postcheck.backupRestoreAgeHours) ||
    postcheck.backupRestoreAgeHours < 0 ||
    isolation.onlyPostgresRunningAtEveryBoundary !== true ||
    isolation.apiStarted !== false ||
    isolation.webStarted !== false ||
    isolation.externalSchema0105GateStarted !== false ||
    new Date(startedAt) > new Date(completedAt)
  ) {
    fail(
      "RECOVERY_BINDING_BASELINE_EXECUTION_INVALID",
      "Baseline execution does not prove an isolated exact-0104 result.",
    );
  }
  const preApplied = Number(precheck.appliedMigrations);
  const preCommonInvalid =
    precheck.phase !== "pre" ||
    precheck.operation !== operation ||
    precheck.candidateSourceSha !== baseline.candidate.sourceSha ||
    precheck.predecessorSourceSha !== FIXED_PREDECESSOR_SHA ||
    precheck.predecessorMigrations !== 104 ||
    precheck.inputSha256 !== value.inputSha256 ||
    precheck.authorizes0105 !== false ||
    !Number.isSafeInteger(preApplied) ||
    typeof precheck.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(precheck.backupRestoreAgeHours) ||
    precheck.backupRestoreAgeHours < 0;
  const migratePrecheckInvalid =
    operation === "migrate" &&
    (precheck.decision !== "BASELINE_0104_REQUIRED" ||
      preApplied < 0 ||
      preApplied >= 104 ||
      precheck.missingToPredecessor !== 104 - preApplied);
  const noopPrecheckInvalid =
    operation === "verified-noop" &&
    (precheck.decision !== "READY_0104" ||
      preApplied !== 104 ||
      precheck.latestAppliedTag !== LATEST_0104 ||
      precheck.missingToPredecessor !== 0);
  if (preCommonInvalid || migratePrecheckInvalid || noopPrecheckInvalid) {
    fail(
      "RECOVERY_BINDING_BASELINE_PRECHECK_INVALID",
      "Baseline precheck does not match the exact predecessor operation.",
    );
  }
  if (operation === "migrate") {
    const summary = objectAt(
      migration.summary,
      "baseline execution migration summary",
    );
    exactKeys(
      summary,
      ["expected", "applied", "newlyApplied", "latestExpected"],
      "baseline execution migration summary",
    );
    if (
      migration.executed !== true ||
      summary.expected !== 104 ||
      summary.applied !== 104 ||
      summary.newlyApplied !== 104 - preApplied ||
      summary.latestExpected !== LATEST_0104
    ) {
      fail(
        "RECOVERY_BINDING_BASELINE_MIGRATION_INVALID",
        "Baseline migration summary does not close the precheck gap to exact 0104.",
      );
    }
  } else if (migration.executed !== false || migration.summary !== null) {
    fail(
      "RECOVERY_BINDING_BASELINE_MIGRATION_INVALID",
      "A verified-noop baseline must not execute the migrator.",
    );
  }
  const postBackupId = positiveInteger(
    postcheck.backupEvidenceId,
    "baseline postcheck backup evidence id",
  );
  if (postBackupId !== baseline.oldBackupId) {
    fail(
      "RECOVERY_BINDING_BASELINE_BACKUP_MISMATCH",
      "Baseline execution backup id does not match baseline inputs.",
    );
  }
  if (precheck.backupEvidenceId !== postBackupId) {
    fail(
      "RECOVERY_BINDING_BASELINE_BACKUP_MISMATCH",
      "Baseline precheck and postcheck backup ids must match.",
    );
  }
  return {
    executionSha256,
    completedAt,
    operation,
  };
}

export function createStagingExact0104RecoveryBinding({
  baselineInputsBytes,
  baselineInputsChecksumText,
  expectedBaselineInputsSha256,
  baselineExecutionBytes,
  baselineExecutionChecksumText,
  expectedBaselineExecutionSha256,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  const inputsArtifact = parseTrustedArtifact(
    baselineInputsBytes,
    baselineInputsChecksumText,
    expectedBaselineInputsSha256,
    "staging-baseline-0104-inputs.json",
    "baseline inputs",
  );
  const baseline = validateBaselineInputs(
    inputsArtifact.value,
    inputsArtifact.sha256,
  );
  const executionArtifact = parseTrustedArtifact(
    baselineExecutionBytes,
    baselineExecutionChecksumText,
    expectedBaselineExecutionSha256,
    "staging-baseline-0104-execution.json",
    "baseline execution",
  );
  const execution = validateBaselineExecution(
    executionArtifact.value,
    executionArtifact.sha256,
    baseline,
  );
  const newBackupId = positiveInteger(backupEvidenceId, "backupEvidenceId");
  if (newBackupId <= baseline.oldBackupId) {
    fail(
      "RECOVERY_BINDING_BACKUP_NOT_NEW",
      "Recovery backup id must be newer than the backup used for baseline.",
    );
  }
  const restoreMaxAgeHours = positiveInteger(
    backupRestoreMaxAgeHours,
    "backupRestoreMaxAgeHours",
    168,
  );
  const recoveryInputs = Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0104-recovery",
    productionTargetsTouched: false,
    candidate: Object.freeze({
      sourceSha: baseline.candidate.sourceSha,
      apiImage: baseline.candidate.apiImage,
      imageManifestSha256: baseline.candidate.imageManifestSha256,
      provisioningManifestSha256: baseline.candidate.provisioningManifestSha256,
      inspectInputsSha256: baseline.candidate.inspectInputsSha256,
    }),
    database: Object.freeze({
      environmentId: baseline.environmentId,
      host: baseline.database.host,
      name: baseline.database.name,
      user: baseline.database.user,
      composeProjectName: baseline.composeProjectName,
    }),
    baseline: Object.freeze({
      inputsSha256: baseline.inputsSha256,
      executionSha256: execution.executionSha256,
      completedAt: execution.completedAt,
      operation: execution.operation,
    }),
    backup: Object.freeze({
      evidenceId: newBackupId,
      restoreMaxAgeHours,
      mustBeCreatedAfter: execution.completedAt,
    }),
    target: Object.freeze({
      migrationCount: 104,
      latestTag: LATEST_0104,
      excluded0100: true,
      excluded0105: true,
      externalStateRows: 0,
    }),
    nextGate: "separate-0105-transition-binding-required",
    authorizes0105: false,
  });
  const recoveryBytes = Buffer.from(canonicalJson(recoveryInputs), "utf8");
  const recoverySha256 = crypto
    .createHash("sha256")
    .update(recoveryBytes)
    .digest("hex");
  const environment = Object.freeze({
    STAGING_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_ENVIRONMENT_ID: baseline.environmentId,
    STAGING_COMPOSE_PROJECT_NAME: baseline.composeProjectName,
    STAGING_BUILD_SHA: baseline.candidate.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: baseline.candidate.sourceSha,
    STAGING_IMAGE_MANIFEST_SHA256: baseline.candidate.imageManifestSha256,
    STAGING_PROVISIONING_MANIFEST_SHA256:
      baseline.candidate.provisioningManifestSha256,
    STAGING_DEPLOYMENT_INPUTS_SHA256: baseline.candidate.inspectInputsSha256,
    STAGING_API_IMAGE: baseline.candidate.apiImage,
    STAGING_DATABASE_HOST: baseline.database.host,
    STAGING_DATABASE_NAME: baseline.database.name,
    STAGING_DATABASE_USER: baseline.database.user,
    STAGING_BACKUP_EVIDENCE_ID: String(newBackupId),
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(restoreMaxAgeHours),
    STAGING_EXACT_0104_RECOVERY_INPUTS_B64: recoveryBytes.toString("base64"),
    STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256: recoverySha256,
    STAGING_BASELINE_0104_EXECUTION_B64: executionArtifact.base64,
    STAGING_BASELINE_0104_EXECUTION_SHA256: executionArtifact.sha256,
  });
  return Object.freeze({
    decision: "PASS",
    inputs: recoveryInputs,
    inputsSha256: recoverySha256,
    environment,
  });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "RECOVERY_BINDING_OUTPUT_EXISTS",
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

export function writeStagingExact0104RecoveryBinding(directory, result) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "RECOVERY_BINDING_OUTPUT_INVALID",
      "Output directory must be a nonsymlink directory.",
    );
  }
  const inputName = "staging-exact-0104-recovery-inputs.json";
  return Object.freeze({
    inputs: atomicWriteExclusive(
      absolute,
      inputName,
      canonicalJson(result.inputs),
    ),
    checksum: atomicWriteExclusive(
      absolute,
      "staging-exact-0104-recovery-inputs.sha256",
      `${result.inputsSha256}  ${inputName}\n`,
    ),
    environment: atomicWriteExclusive(
      absolute,
      "staging-exact-0104-recovery-environment.json",
      `${JSON.stringify(result.environment, null, 2)}\n`,
    ),
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) fail("RECOVERY_BINDING_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("RECOVERY_BINDING_INPUT_INVALID", `${label} must be a regular file.`);
  }
  return absolute;
}

function main() {
  const baselineInputs = regularFile(
    requiredArgument("--baseline-inputs"),
    "baseline inputs",
  );
  const baselineInputsChecksum = regularFile(
    requiredArgument("--baseline-inputs-checksum"),
    "baseline inputs checksum",
  );
  const baselineExecution = regularFile(
    requiredArgument("--baseline-execution"),
    "baseline execution",
  );
  const baselineExecutionChecksum = regularFile(
    requiredArgument("--baseline-execution-checksum"),
    "baseline execution checksum",
  );
  const result = createStagingExact0104RecoveryBinding({
    baselineInputsBytes: fs.readFileSync(baselineInputs),
    baselineInputsChecksumText: fs.readFileSync(baselineInputsChecksum, "utf8"),
    expectedBaselineInputsSha256: requiredArgument(
      "--expected-baseline-inputs-sha256",
    ),
    baselineExecutionBytes: fs.readFileSync(baselineExecution),
    baselineExecutionChecksumText: fs.readFileSync(
      baselineExecutionChecksum,
      "utf8",
    ),
    expectedBaselineExecutionSha256: requiredArgument(
      "--expected-baseline-execution-sha256",
    ),
    backupEvidenceId: Number(requiredArgument("--backup-evidence-id")),
    backupRestoreMaxAgeHours: Number(
      requiredArgument("--backup-restore-max-age-hours"),
    ),
  });
  const files = writeStagingExact0104RecoveryBinding(
    requiredArgument("--output-dir"),
    result,
  );
  process.stdout.write(
    `${JSON.stringify({ decision: result.decision, inputsSha256: result.inputsSha256, files }, null, 2)}\n`,
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
