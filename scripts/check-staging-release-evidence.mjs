import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_HOSTS = new Set(["modvoltapp.cz", "www.modvoltapp.cz"]);
const STAGING_NAME_PATTERN =
  /(^|[._-])(stage|staging|test|qa|sandbox|preview)([._-]|$)/i;
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|credential|private.?key|database.?url|connection.?string)/i;

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
    if (SENSITIVE_KEY_PATTERN.test(key)) {
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

function validateWorkflowUrl(raw) {
  let url;
  try {
    url = new URL(stringAt(raw, "ci.workflowUrl"));
  } catch {
    fail(
      "EVIDENCE_WORKFLOW_URL_INVALID",
      "ci.workflowUrl must be an absolute URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    !/\/actions\/runs\/\d+\/?$/.test(url.pathname)
  ) {
    fail(
      "EVIDENCE_WORKFLOW_URL_INVALID",
      "ci.workflowUrl must link to a GitHub Actions run.",
    );
  }
  return url.toString();
}

export function validateStagingReleaseEvidence(evidence, options = {}) {
  scanForSecrets(evidence);
  const root = objectAt(evidence, "evidence");
  requireValue(root.schemaVersion, 1, "schemaVersion");

  const run = objectAt(root.run, "run");
  const isolation = objectAt(root.isolation, "isolation");
  const ci = objectAt(root.ci, "ci");
  const deployment = objectAt(root.deployment, "deployment");
  const storage = objectAt(root.storage, "storage");
  const recovery = objectAt(root.recovery, "recovery");
  const browser = objectAt(root.browser, "browser");
  const mail = objectAt(root.mail, "mail");
  const alerts = objectAt(root.alerts, "alerts");
  const approvals = objectAt(root.approvals, "approvals");

  const runId = stringAt(run.id, "run.id");
  const environmentId = stringAt(run.environmentId, "run.environmentId");
  if (!STAGING_NAME_PATTERN.test(environmentId)) {
    fail(
      "EVIDENCE_ENVIRONMENT_UNSAFE",
      "run.environmentId does not identify staging/test/qa/sandbox/preview.",
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
      isolation.rawProductionDataExposed,
      "isolation.rawProductionDataExposed",
    ),
    false,
    "isolation.rawProductionDataExposed",
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
  validateWorkflowUrl(ci.workflowUrl);
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
  const expectedMigrations = numberAt(
    deployment.expectedMigrations,
    "deployment.expectedMigrations",
  );
  const appliedMigrations = numberAt(
    deployment.appliedMigrations,
    "deployment.appliedMigrations",
  );
  if (expectedMigrations === 0 || appliedMigrations !== expectedMigrations) {
    fail(
      "EVIDENCE_MIGRATION_MISMATCH",
      "Applied and expected migration counts must be equal and non-zero.",
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
  stringAt(storage.targetFingerprint, "storage.targetFingerprint");

  requireValue(
    booleanAt(recovery.performed, "recovery.performed"),
    true,
    "recovery.performed",
  );
  requireValue(
    stringAt(recovery.dataClassification, "recovery.dataClassification"),
    "anonymized",
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

  const operator = stringAt(approvals.operator, "approvals.operator");
  const reviewer = stringAt(approvals.reviewer, "approvals.reviewer");
  if (operator.toLowerCase() === reviewer.toLowerCase()) {
    fail(
      "EVIDENCE_DUAL_CONTROL_MISSING",
      "Operator and reviewer must be different people.",
    );
  }
  stringAt(approvals.serviceOwner, "approvals.serviceOwner");
  const approvedAt = dateAt(approvals.approvedAt, "approvals.approvedAt");
  if (approvedAt < runCompletedAt || approvedAt > now + 5 * 60_000) {
    fail(
      "EVIDENCE_APPROVAL_TIME_INVALID",
      "Approval must follow completion and cannot be in the future.",
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    runId,
    environmentId,
    baseUrl,
    commitSha,
    completedAt: new Date(runCompletedAt).toISOString(),
    evidenceAgeMinutes: Math.round((now - runCompletedAt) / 60_000),
    expectedMigrations,
    objectCount: expectedObjects,
    rpoMinutes,
    approvedRpoMinutes,
    rtoMinutes,
    approvedRtoMinutes,
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
  const absolutePath = path.resolve(evidencePath);
  const evidence = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const summary = validateStagingReleaseEvidence(evidence);
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
