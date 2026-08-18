import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploymentInputsSha256,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import { canonicalJson } from "./check-staging-provisioning.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const CONFIRMATION =
  "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const MIGRATION_SHA256 =
  "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd";

export class StagingAccounting0106BindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAccounting0106BindingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingAccounting0106BindingError(code, message);
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "ACCOUNTING_0106_BINDING_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "ACCOUNTING_0106_BINDING_SCHEMA_INVALID",
      `${field} must contain only approved fields.`,
    );
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "ACCOUNTING_0106_BINDING_SCHEMA_INVALID",
      `${field} must be positive.`,
    );
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail(
      "ACCOUNTING_0106_BINDING_TIME_INVALID",
      `${field} must be canonical UTC.`,
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(
      "ACCOUNTING_0106_BINDING_TIME_INVALID",
      `${field} must be canonical UTC.`,
    );
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
      "ACCOUNTING_0106_BINDING_INPUT_INVALID",
      `${label} bytes and expected checksum are required.`,
    );
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    sha256 !== expectedSha256 ||
    checksumText !== `${expectedSha256}  ${expectedName}\n`
  ) {
    fail(
      "ACCOUNTING_0106_BINDING_HASH_MISMATCH",
      `${label} does not match its separately approved checksum.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "ACCOUNTING_0106_BINDING_INPUT_INVALID",
      `${label} must be strict JSON.`,
    );
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "ACCOUNTING_0106_BINDING_CANONICAL_INVALID",
      `${label} must use canonical JSON bytes.`,
    );
  }
  return Object.freeze({ value, sha256 });
}

export function validateExact0105BackupExecution(value, expectedSourceSha) {
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
      "inspectDeploymentInputsSha256",
      "gate",
      "runtimeIsolation",
      "nextGate",
      "authorizes0106",
    ],
    "exact-0105 backup execution",
  );
  exactKeys(
    value.gate,
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
    "exact-0105 backup gate",
  );
  exactKeys(
    value.runtimeIsolation,
    [
      "onlyPostgresRunningAtEveryBoundary",
      "apiStarted",
      "webStarted",
      "externalSchema0105GateStarted",
      "accountingSchema0106GateStarted",
    ],
    "exact-0105 runtime isolation",
  );
  const startedAt = canonicalTimestamp(value.startedAt, "startedAt");
  const completedAt = canonicalTimestamp(value.completedAt, "completedAt");
  const createdAt = canonicalTimestamp(
    value.gate.createdAt,
    "backup createdAt",
  );
  const restoreTestedAt = canonicalTimestamp(
    value.gate.restoreTestedAt,
    "backup restoreTestedAt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-exact-0105-backup-execution" ||
    value.decision !== "PASS" ||
    value.productionTargetsTouched !== false ||
    value.sourceSha !== expectedSourceSha ||
    !SHA40.test(String(value.sourceSha)) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(value.inspectDeploymentInputsSha256),
    ) ||
    value.gate.decision !== "CREATED_AND_RESTORE_VERIFIED" ||
    value.gate.environmentId !== "site-logbook-staging" ||
    value.gate.databaseName !== "site_logbook_staging" ||
    value.gate.databaseUser !== "site_logbook_staging" ||
    value.gate.buildSha !== expectedSourceSha ||
    value.gate.expectedMigrations !== 105 ||
    value.gate.latestExpectedTag !== "0105_smooth_nitro" ||
    value.gate.excludedMigration0100Present !== false ||
    value.gate.excludedMigration0106Present !== false ||
    value.gate.accountingEvidenceRows !== 0 ||
    value.gate.externalStateRows !== 0 ||
    positiveInteger(value.gate.previousBackupId, "previous backup id") >=
      positiveInteger(value.gate.backupId, "new backup id") ||
    positiveInteger(value.gate.sizeBytes, "backup size") > MAX_PAYLOAD_BYTES ||
    value.gate.maxPayloadBytes !== MAX_PAYLOAD_BYTES ||
    value.gate.encryptionFormat !== "mve1" ||
    value.gate.retentionPruned !== false ||
    value.gate.destructiveRestorePerformed !== false ||
    positiveInteger(value.gate.restoreDurationMs, "restore duration") < 1 ||
    positiveInteger(value.gate.verifiedTableCount, "verified table count") <
      1 ||
    value.gate.nextGate !== "accounting-0106-transition-binding-required" ||
    value.gate.authorizes0106 !== false ||
    value.runtimeIsolation.onlyPostgresRunningAtEveryBoundary !== true ||
    value.runtimeIsolation.apiStarted !== false ||
    value.runtimeIsolation.webStarted !== false ||
    value.runtimeIsolation.externalSchema0105GateStarted !== false ||
    value.runtimeIsolation.accountingSchema0106GateStarted !== false ||
    value.nextGate !== "accounting-0106-transition-binding-required" ||
    value.authorizes0106 !== false ||
    startedAt > completedAt ||
    createdAt > restoreTestedAt ||
    restoreTestedAt > completedAt
  ) {
    fail(
      "ACCOUNTING_0106_BACKUP_EXECUTION_INVALID",
      "The backup execution does not prove the isolated exact-0105 backup boundary.",
    );
  }
  return Object.freeze({
    sourceSha: value.sourceSha,
    inspectInputsSha256: value.inspectDeploymentInputsSha256.slice(
      "sha256:".length,
    ),
    previousBackupId: value.gate.previousBackupId,
    backupId: value.gate.backupId,
    sizeBytes: value.gate.sizeBytes,
    maxPayloadBytes: value.gate.maxPayloadBytes,
    createdAt: value.gate.createdAt,
    restoreTestedAt: value.gate.restoreTestedAt,
  });
}

export function validateAccounting0106TransitionInputs(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "productionTargetsTouched",
      "sourceSha",
      "action",
      "confirmation",
      "originalInspectInputsSha256",
      "derivedInspectInputsSha256",
      "backupExecutionSha256",
      "backupEvidence",
      "predecessor",
      "target",
      "authorizesOnly",
    ],
    "accounting 0106 transition inputs",
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
    ],
    "accounting 0106 backup evidence",
  );
  exactKeys(value.predecessor, ["count", "tag"], "accounting predecessor");
  exactKeys(
    value.target,
    ["count", "idx", "when", "tag", "migrationSha256"],
    "accounting target",
  );
  canonicalTimestamp(value.backupEvidence.createdAt, "backup createdAt");
  canonicalTimestamp(
    value.backupEvidence.restoreTestedAt,
    "backup restoreTestedAt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "site-logbook-staging-accounting-0106-transition" ||
    value.productionTargetsTouched !== false ||
    !SHA40.test(String(value.sourceSha)) ||
    value.action !== "apply-0106" ||
    value.confirmation !== CONFIRMATION ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.originalInspectInputsSha256)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.derivedInspectInputsSha256)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.backupExecutionSha256)) ||
    positiveInteger(value.backupEvidence.previousId, "previous backup id") >=
      positiveInteger(value.backupEvidence.id, "new backup id") ||
    positiveInteger(value.backupEvidence.sizeBytes, "backup size") >
      MAX_PAYLOAD_BYTES ||
    value.backupEvidence.maxPayloadBytes !== MAX_PAYLOAD_BYTES ||
    value.predecessor.count !== 105 ||
    value.predecessor.tag !== "0105_smooth_nitro" ||
    value.target.count !== 106 ||
    value.target.idx !== 106 ||
    value.target.when !== 1786459128910 ||
    value.target.tag !== "0106_graceful_frog_thor" ||
    value.target.migrationSha256 !== `sha256:${MIGRATION_SHA256}` ||
    value.authorizesOnly !== "isolated-exact-0105-to-0106-transition"
  ) {
    fail(
      "ACCOUNTING_0106_TRANSITION_INPUTS_INVALID",
      "Accounting transition inputs do not preserve the exact 0105 to 0106 boundary.",
    );
  }
  return Object.freeze(value);
}

export function createStagingAccounting0106Binding({
  expectedSourceSha,
  originalInspectBytes,
  originalInspectChecksumText,
  expectedOriginalInspectSha256,
  backupExecutionBytes,
  backupExecutionChecksumText,
  expectedBackupExecutionSha256,
}) {
  if (!SHA40.test(expectedSourceSha ?? "")) {
    fail(
      "ACCOUNTING_0106_BINDING_SOURCE_INVALID",
      "The exact candidate source SHA is required.",
    );
  }
  const originalArtifact = trustedJsonArtifact(
    originalInspectBytes,
    originalInspectChecksumText,
    expectedOriginalInspectSha256,
    "staging-deployment-inspect.json",
    "original inspect inputs",
  );
  let originalInspect;
  try {
    originalInspect = validateStagingDeploymentInputs(originalArtifact.value, {
      expectedSchemaAction: "inspect",
      expectedSourceSha,
    });
  } catch {
    fail(
      "ACCOUNTING_0106_ORIGINAL_INSPECT_INVALID",
      "The original inspect inputs do not match the exact staging candidate.",
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
    backup.inspectInputsSha256 !== originalArtifact.sha256 ||
    backup.previousBackupId !== originalInspect.backupEvidenceId
  ) {
    fail(
      "ACCOUNTING_0106_BACKUP_INSPECT_MISMATCH",
      "The backup execution must derive from the exact original inspect inputs and backup id.",
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
  const transition = validateAccounting0106TransitionInputs({
    schemaVersion: 1,
    kind: "site-logbook-staging-accounting-0106-transition",
    productionTargetsTouched: false,
    sourceSha: expectedSourceSha,
    action: "apply-0106",
    confirmation: CONFIRMATION,
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
    },
    predecessor: { count: 105, tag: "0105_smooth_nitro" },
    target: {
      count: 106,
      idx: 106,
      when: 1786459128910,
      tag: "0106_graceful_frog_thor",
      migrationSha256: `sha256:${MIGRATION_SHA256}`,
    },
    authorizesOnly: "isolated-exact-0105-to-0106-transition",
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
      STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256: transitionSha256,
      STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256: backupArtifact.sha256,
      STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES: String(
        backup.maxPayloadBytes,
      ),
      STAGING_EXACT_0105_BACKUP_SIZE_BYTES: String(backup.sizeBytes),
      STAGING_ACCOUNTING_SCHEMA_ACTION: "steady-0106",
      ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    }),
  });
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "ACCOUNTING_0106_BINDING_OUTPUT_EXISTS",
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

function outputDirectory(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "ACCOUNTING_0106_BINDING_OUTPUT_INVALID",
      "Output must be a nonsymlink directory.",
    );
  }
  return absolute;
}

export function writeStagingAccounting0106Binding(directory, binding) {
  const absolute = outputDirectory(directory);
  const artifacts = [
    [
      "staging-accounting-0106-transition.json",
      canonicalJson(binding.transition),
      binding.transitionSha256,
    ],
    [
      "staging-accounting-0106-inspect.json",
      canonicalJson(binding.derivedInspect),
      binding.derivedInspectSha256,
    ],
  ];
  for (const [name] of artifacts) {
    if (
      fs.existsSync(path.join(absolute, name)) ||
      fs.existsSync(path.join(absolute, name.replace(/\.json$/, ".sha256")))
    ) {
      fail(
        "ACCOUNTING_0106_BINDING_OUTPUT_EXISTS",
        `${name} already exists; use a new evidence directory.`,
      );
    }
  }
  const files = {};
  for (const [name, bytes, sha256] of artifacts) {
    files[name] = atomicWriteExclusive(absolute, name, bytes);
    const checksumName = name.replace(/\.json$/, ".sha256");
    files[checksumName] = atomicWriteExclusive(
      absolute,
      checksumName,
      `${sha256}  ${name}\n`,
    );
  }
  const environmentName = "staging-accounting-0106.env";
  if (fs.existsSync(path.join(absolute, environmentName))) {
    fail(
      "ACCOUNTING_0106_BINDING_OUTPUT_EXISTS",
      `${environmentName} already exists; use a new evidence directory.`,
    );
  }
  const environmentBytes = `${Object.entries(binding.environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  files[environmentName] = atomicWriteExclusive(
    absolute,
    environmentName,
    environmentBytes,
  );
  return Object.freeze(files);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value)
    fail("ACCOUNTING_0106_BINDING_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(
      "ACCOUNTING_0106_BINDING_INPUT_INVALID",
      `${label} must be a regular file.`,
    );
  }
  return absolute;
}

function main() {
  const inspect = regularFile(
    requiredArgument("--inspect-inputs"),
    "original inspect inputs",
  );
  const inspectChecksum = regularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "original inspect checksum",
  );
  const backup = regularFile(
    requiredArgument("--backup-execution"),
    "exact-0105 backup execution",
  );
  const backupChecksum = regularFile(
    requiredArgument("--backup-execution-checksum"),
    "exact-0105 backup execution checksum",
  );
  const binding = createStagingAccounting0106Binding({
    expectedSourceSha: requiredArgument("--expected-source-sha"),
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
  const files = writeStagingAccounting0106Binding(
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
      error instanceof StagingAccounting0106BindingError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-accounting-0106-binding] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
