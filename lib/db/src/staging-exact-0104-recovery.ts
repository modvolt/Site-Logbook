import crypto from "node:crypto";
import {
  readExternalSchemaInventoryEnvironment,
  type ExternalSchemaExact0104RecoveryEnvironment,
} from "./external-schema-preflight";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMMUTABLE_API =
  /^ghcr\.io\/modvolt\/site-logbook-staging-api@sha256:[0-9a-f]{64}$/;
const FIXED_PREDECESSOR_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const LATEST_0104 = "0104_thin_sheva_callister";
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_EXECUTION_BYTES = 128 * 1024;
const MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024;
const SENSITIVE_KEY =
  /(password|secret|token|credential|keyring|databaseurl|connectionstring|authorization|privatekey|accesskey|sessionkey)/i;

export class StagingExact0104RecoveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StagingExact0104RecoveryError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StagingExact0104RecoveryError(code, message);
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RECOVERY_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "RECOVERY_SCHEMA_INVALID",
      `${field} must contain only the approved fields.`,
    );
  }
}

function scanForSensitiveFields(value: unknown, currentPath: string): void {
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
        "RECOVERY_SECRET_MATERIAL",
        `${currentPath}.${key} is a forbidden sensitive field.`,
      );
    }
    if (typeof entry === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      try {
        const url = new URL(entry);
        if (url.username || url.password) {
          fail(
            "RECOVERY_SECRET_MATERIAL",
            `${currentPath}.${key} contains URL credentials.`,
          );
        }
      } catch (error) {
        if (error instanceof StagingExact0104RecoveryError) throw error;
      }
    }
    scanForSensitiveFields(entry, `${currentPath}.${key}`);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredRaw(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("RECOVERY_ENV_MISSING", `${key} must be set.`);
  }
  return value;
}

function decodeCanonicalJson(
  encoded: string,
  expectedSha256: string,
  maxBytes: number,
  field: string,
): { value: Record<string, unknown>; bytes: Buffer } {
  if (!SHA256.test(expectedSha256)) {
    fail(
      "RECOVERY_HASH_INVALID",
      `${field} checksum must be lowercase SHA-256.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    fail("RECOVERY_BASE64_INVALID", `${field} must be canonical Base64.`);
  }
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString("base64") !== encoded
  ) {
    fail(
      "RECOVERY_BASE64_INVALID",
      `${field} must be nonempty bounded canonical Base64.`,
    );
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("RECOVERY_HASH_MISMATCH", `${field} bytes do not match the checksum.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RECOVERY_JSON_INVALID", `${field} must contain strict JSON.`);
  }
  const value = objectAt(parsed, field);
  scanForSensitiveFields(value, field);
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    fail(
      "RECOVERY_CANONICAL_INVALID",
      `${field} must use canonical JSON bytes.`,
    );
  }
  return { value, bytes };
}

function positiveInteger(value: unknown, field: string, maximum = 2 ** 31 - 1) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  ) {
    fail(
      "RECOVERY_NUMBER_INVALID",
      `${field} must be a positive bounded integer.`,
    );
  }
  return Number(value);
}

function timestamp(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    fail("RECOVERY_TIME_INVALID", `${field} must be an ISO UTC timestamp.`);
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) {
    fail(
      "RECOVERY_TIME_INVALID",
      `${field} must be a canonical ISO timestamp.`,
    );
  }
  return result;
}

function validateBaselineExecution(
  execution: Record<string, unknown>,
  executionSha256: string,
  input: Record<string, unknown>,
) {
  exactKeys(
    execution,
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
  const baseline = objectAt(input.baseline, "inputs.baseline");
  const candidate = objectAt(input.candidate, "inputs.candidate");
  const backup = objectAt(input.backup, "inputs.backup");
  const precheck = objectAt(execution.precheck, "baseline execution precheck");
  const migration = objectAt(
    execution.migration,
    "baseline execution migration",
  );
  const postcheck = objectAt(
    execution.postcheck,
    "baseline execution postcheck",
  );
  const isolation = objectAt(
    execution.runtimeIsolation,
    "baseline execution runtimeIsolation",
  );
  const startedAt = timestamp(
    execution.startedAt,
    "baseline execution startedAt",
  );
  const completedAt = timestamp(
    execution.completedAt,
    "baseline execution completedAt",
  );
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
    "baseline execution runtimeIsolation",
  );
  if (
    execution.schemaVersion !== 1 ||
    execution.kind !== "site-logbook-staging-baseline-0104-execution" ||
    execution.decision !== "PASS" ||
    execution.productionTargetsTouched !== false ||
    execution.inputSha256 !== `sha256:${String(baseline.inputsSha256)}` ||
    execution.operation !== baseline.operation ||
    execution.requiresFreshExact0104BackupAndRestore !== true ||
    execution.authorizes0105 !== false ||
    baseline.executionSha256 !== executionSha256 ||
    baseline.completedAt !== completedAt.toISOString() ||
    startedAt > completedAt
  ) {
    fail(
      "RECOVERY_BASELINE_INVALID",
      "Baseline execution is not the approved exact-0104 predecessor operation.",
    );
  }
  const preApplied = Number(precheck.appliedMigrations);
  const preCommonInvalid =
    precheck.phase !== "pre" ||
    precheck.operation !== execution.operation ||
    precheck.candidateSourceSha !== candidate.sourceSha ||
    precheck.predecessorSourceSha !== FIXED_PREDECESSOR_SHA ||
    precheck.predecessorMigrations !== 104 ||
    precheck.inputSha256 !== execution.inputSha256 ||
    precheck.authorizes0105 !== false ||
    !Number.isSafeInteger(preApplied) ||
    typeof precheck.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(precheck.backupRestoreAgeHours) ||
    precheck.backupRestoreAgeHours < 0;
  const migratePrecheckInvalid =
    execution.operation === "migrate" &&
    (precheck.decision !== "BASELINE_0104_REQUIRED" ||
      preApplied < 0 ||
      preApplied >= 104 ||
      precheck.missingToPredecessor !== 104 - preApplied);
  const noopPrecheckInvalid =
    execution.operation === "verified-noop" &&
    (precheck.decision !== "READY_0104" ||
      preApplied !== 104 ||
      precheck.latestAppliedTag !== LATEST_0104 ||
      precheck.missingToPredecessor !== 0);
  if (preCommonInvalid || migratePrecheckInvalid || noopPrecheckInvalid) {
    fail(
      "RECOVERY_BASELINE_PRECHECK_INVALID",
      "Baseline precheck must match the approved operation and exact predecessor state.",
    );
  }
  if (execution.operation === "migrate") {
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
        "RECOVERY_BASELINE_MIGRATION_INVALID",
        "Baseline migration summary must close the exact precheck gap to 0104.",
      );
    }
  } else if (migration.executed !== false || migration.summary !== null) {
    fail(
      "RECOVERY_BASELINE_MIGRATION_INVALID",
      "A verified-noop baseline must not contain an executed migrator summary.",
    );
  }
  if (
    postcheck.phase !== "post" ||
    postcheck.operation !== "ready" ||
    postcheck.decision !== "READY_0104" ||
    postcheck.candidateSourceSha !== candidate.sourceSha ||
    postcheck.predecessorSourceSha !== FIXED_PREDECESSOR_SHA ||
    postcheck.appliedMigrations !== 104 ||
    postcheck.predecessorMigrations !== 104 ||
    postcheck.latestAppliedTag !== LATEST_0104 ||
    postcheck.missingToPredecessor !== 0 ||
    postcheck.inputSha256 !== execution.inputSha256 ||
    postcheck.authorizes0105 !== false ||
    postcheck.backupEvidenceId !== precheck.backupEvidenceId ||
    typeof postcheck.backupRestoreAgeHours !== "number" ||
    !Number.isFinite(postcheck.backupRestoreAgeHours) ||
    postcheck.backupRestoreAgeHours < 0
  ) {
    fail(
      "RECOVERY_BASELINE_POSTCHECK_INVALID",
      "Baseline postcheck must prove exact 104/0104 without 0105 authorization.",
    );
  }
  if (
    isolation.onlyPostgresRunningAtEveryBoundary !== true ||
    isolation.apiStarted !== false ||
    isolation.webStarted !== false ||
    isolation.externalSchema0105GateStarted !== false
  ) {
    fail(
      "RECOVERY_BASELINE_ISOLATION_INVALID",
      "Baseline execution did not preserve the isolated PostgreSQL boundary.",
    );
  }
  const oldBackupId = positiveInteger(
    postcheck.backupEvidenceId,
    "baseline postcheck backupEvidenceId",
  );
  const newBackupId = positiveInteger(backup.evidenceId, "backup.evidenceId");
  if (newBackupId <= oldBackupId) {
    fail(
      "RECOVERY_BACKUP_NOT_NEW",
      "The exact-0104 recovery backup id must be newer than the baseline input backup.",
    );
  }
  if (backup.mustBeCreatedAfter !== completedAt.toISOString()) {
    fail(
      "RECOVERY_BACKUP_FENCE_INVALID",
      "The new backup creation fence must equal baseline completion.",
    );
  }
  return completedAt;
}

export interface StagingExact0104RecoveryEnvironment {
  inputsSha256: string;
  baselineExecutionSha256: string;
  baselineCompletedAt: Date;
  runtime: ExternalSchemaExact0104RecoveryEnvironment;
}

export function readStagingExact0104RecoveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StagingExact0104RecoveryEnvironment {
  if (
    env.STAGING_SCHEMA_ACTION !== "inspect" ||
    (env.STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== "" ||
    env.STAGING_EXTERNAL_ACCOUNTS_ENABLED !== "false" ||
    env.EXTERNAL_ACCOUNTS_ENABLED !== "false"
  ) {
    fail(
      "RECOVERY_PRIMARY_GATE_UNSAFE",
      "Recovery evidence requires inspect mode, an empty 0105 confirmation and a dark flag.",
    );
  }
  const inputsSha256 = requiredRaw(
    env,
    "STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256",
  );
  const decoded = decodeCanonicalJson(
    requiredRaw(env, "STAGING_EXACT_0104_RECOVERY_INPUTS_B64"),
    inputsSha256,
    MAX_INPUT_BYTES,
    "recovery inputs",
  );
  const input = decoded.value;
  exactKeys(
    input,
    [
      "schemaVersion",
      "kind",
      "productionTargetsTouched",
      "candidate",
      "database",
      "baseline",
      "backup",
      "target",
      "nextGate",
      "authorizes0105",
    ],
    "recovery inputs",
  );
  const candidate = objectAt(input.candidate, "inputs.candidate");
  const database = objectAt(input.database, "inputs.database");
  const baseline = objectAt(input.baseline, "inputs.baseline");
  const backup = objectAt(input.backup, "inputs.backup");
  const target = objectAt(input.target, "inputs.target");
  exactKeys(
    candidate,
    [
      "sourceSha",
      "apiImage",
      "imageManifestSha256",
      "provisioningManifestSha256",
      "inspectInputsSha256",
    ],
    "inputs.candidate",
  );
  exactKeys(
    database,
    ["environmentId", "host", "name", "user", "composeProjectName"],
    "inputs.database",
  );
  exactKeys(
    baseline,
    ["inputsSha256", "executionSha256", "completedAt", "operation"],
    "inputs.baseline",
  );
  exactKeys(
    backup,
    [
      "evidenceId",
      "restoreMaxAgeHours",
      "mustBeCreatedAfter",
      "sizeBytes",
      "maxPayloadBytes",
      "executionSha256",
    ],
    "inputs.backup",
  );
  exactKeys(
    target,
    [
      "migrationCount",
      "latestTag",
      "excluded0100",
      "excluded0105",
      "externalStateRows",
    ],
    "inputs.target",
  );
  if (
    input.schemaVersion !== 1 ||
    input.kind !== "site-logbook-staging-exact-0104-recovery" ||
    input.productionTargetsTouched !== false ||
    input.nextGate !== "separate-0105-transition-binding-required" ||
    input.authorizes0105 !== false ||
    !SHA40.test(String(candidate.sourceSha)) ||
    !IMMUTABLE_API.test(String(candidate.apiImage)) ||
    !SHA256.test(String(candidate.imageManifestSha256)) ||
    !SHA256.test(String(candidate.provisioningManifestSha256)) ||
    !SHA256.test(String(candidate.inspectInputsSha256)) ||
    !SHA256.test(String(baseline.inputsSha256)) ||
    !SHA256.test(String(baseline.executionSha256)) ||
    !["migrate", "verified-noop"].includes(String(baseline.operation)) ||
    target.migrationCount !== 104 ||
    target.latestTag !== LATEST_0104 ||
    target.excluded0100 !== true ||
    target.excluded0105 !== true ||
    target.externalStateRows !== 0
  ) {
    fail(
      "RECOVERY_INPUTS_INVALID",
      "Recovery inputs do not preserve the exact-0104 no-production boundary.",
    );
  }
  const restoreMaxAgeHours = positiveInteger(
    backup.restoreMaxAgeHours,
    "backup.restoreMaxAgeHours",
    168,
  );
  const backupSizeBytes = positiveInteger(
    backup.sizeBytes,
    "backup.sizeBytes",
    MAX_BACKUP_PAYLOAD_BYTES,
  );
  if (
    backup.maxPayloadBytes !== MAX_BACKUP_PAYLOAD_BYTES ||
    typeof backup.executionSha256 !== "string" ||
    !SHA256.test(backup.executionSha256)
  ) {
    fail(
      "RECOVERY_BACKUP_BOUNDARY_INVALID",
      "Recovery inputs must bind the exact backup execution and 256 MiB ceiling.",
    );
  }
  const baselineExecutionSha256 = requiredRaw(
    env,
    "STAGING_BASELINE_0104_EXECUTION_SHA256",
  );
  const baselineExecution = decodeCanonicalJson(
    requiredRaw(env, "STAGING_BASELINE_0104_EXECUTION_B64"),
    baselineExecutionSha256,
    MAX_EXECUTION_BYTES,
    "baseline execution",
  );
  const baselineCompletedAt = validateBaselineExecution(
    baselineExecution.value,
    baselineExecutionSha256,
    input,
  );
  const runtime = readExternalSchemaInventoryEnvironment(env);
  for (const [actual, expected, field] of [
    [runtime.environmentId, database.environmentId, "environment id"],
    [runtime.expectedDatabaseHost, database.host, "database host"],
    [runtime.expectedDatabaseName, database.name, "database name"],
    [runtime.expectedDatabaseUser, database.user, "database user"],
    [runtime.buildSha, candidate.sourceSha, "candidate source SHA"],
    [env.STAGING_API_IMAGE, candidate.apiImage, "candidate API image"],
    [
      env.STAGING_IMAGE_MANIFEST_SHA256,
      candidate.imageManifestSha256,
      "candidate manifest checksum",
    ],
    [
      env.STAGING_PROVISIONING_MANIFEST_SHA256,
      candidate.provisioningManifestSha256,
      "provisioning checksum",
    ],
    [
      env.STAGING_DEPLOYMENT_INPUTS_SHA256,
      candidate.inspectInputsSha256,
      "inspect input checksum",
    ],
  ] as const) {
    if (actual !== expected) {
      fail(
        "RECOVERY_RUNTIME_BINDING_MISMATCH",
        `Runtime ${field} does not match the approved recovery inputs.`,
      );
    }
  }
  if (
    runtime.backupEvidenceId !== Number(backup.evidenceId) ||
    runtime.backupRestoreMaxAgeHours !== restoreMaxAgeHours
  ) {
    fail(
      "RECOVERY_BACKUP_BINDING_MISMATCH",
      "Runtime backup id and freshness window must match recovery inputs.",
    );
  }
  return {
    inputsSha256,
    baselineExecutionSha256,
    baselineCompletedAt,
    runtime: {
      ...runtime,
      baselineCompletedAt,
      expectedBackupSizeBytes: backupSizeBytes,
      backupMaxPayloadBytes: MAX_BACKUP_PAYLOAD_BYTES,
      backupExecutionSha256: backup.executionSha256,
    },
  };
}
