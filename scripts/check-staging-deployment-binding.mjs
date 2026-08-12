import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateStagingProvisioning,
  canonicalJson,
} from "./check-staging-provisioning.mjs";
import { validateStagingImageManifest } from "./verify-staging-image-manifest.mjs";

export class StagingDeploymentBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingDeploymentBindingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingDeploymentBindingError(code, message);
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPOSE_PROJECT = /^site-logbook-staging(?:-[a-z0-9-]+)?$/;
const COOLIFY_ID = /^[a-z0-9][a-z0-9_-]{2,127}$/i;
const S3_BUCKET = /^site-logbook-staging(?:-[a-z0-9.-]+)?$/;
const PLACEHOLDER = /(pending|replace(?:-me)?)/i;
const IMMUTABLE_IMAGES = Object.freeze({
  preflight: "site-logbook-staging-preflight",
  mailpit: "site-logbook-staging-mailpit",
  api: "site-logbook-staging-api",
  web: "site-logbook-staging-web",
  alertReceiver: "site-logbook-staging-alert-receiver",
});
export const STAGING_POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const STAGING_POSTGRES_DATA_TARGET = "/var/lib/postgresql/data";
export const STAGING_POSTGRES_VOLUME = "staging_pgdata";
const STAGING_AUDIT_RESTRICTED_OPAQUE_ROWS_JSON =
  '[{"createdAt":1783190993468,"hash":"fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927"},{"createdAt":1783261969512,"hash":"3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa"}]';

// The projection deliberately excludes Config.Env and every secret-bearing
// field. Host runners parse this single JSON object without logging it.
export const STAGING_POSTGRES_INSPECT_FORMAT =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"configImage":{{json .Config.Image}},"imageId":{{json .Image}},"projectLabel":{{json (index .Config.Labels "com.docker.compose.project")}},"serviceLabel":{{json (index .Config.Labels "com.docker.compose.service")}},"path":{{json .Path}},"args":{{json .Args}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"portBindings":{{json .HostConfig.PortBindings}},"networkPorts":{{json .NetworkSettings.Ports}}}';

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("DEPLOYMENT_INPUTS_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const approved = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(approved)) {
    fail(
      "DEPLOYMENT_INPUTS_SCHEMA_INVALID",
      `${field} must contain only approved fields.`,
    );
  }
}

function validateAuditLineageBinding(mode, opaqueRowsJson) {
  if (
    (mode === "clean" && opaqueRowsJson === "[]") ||
    (mode === "production-copy-restricted" &&
      opaqueRowsJson === STAGING_AUDIT_RESTRICTED_OPAQUE_ROWS_JSON)
  ) {
    return;
  }
  fail(
    "DEPLOYMENT_COMPOSE_TARGET_INVALID",
    "Audit lineage must use clean [] or the two frozen opaque production-copy identities.",
  );
}

function httpsUrl(value, field, expectedPath) {
  if (typeof value !== "string" || value !== value.trim()) {
    fail(
      "DEPLOYMENT_INPUTS_TARGET_INVALID",
      `${field} must be canonical HTTPS.`,
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "DEPLOYMENT_INPUTS_TARGET_INVALID",
      `${field} must be canonical HTTPS.`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.port ||
    parsed.pathname !== expectedPath ||
    parsed.hostname !== parsed.hostname.toLowerCase()
  ) {
    fail(
      "DEPLOYMENT_INPUTS_TARGET_INVALID",
      `${field} must be canonical HTTPS.`,
    );
  }
  return parsed;
}

function forbiddenPublicHost(hostname) {
  const host = hostname.toLowerCase();
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return (
    host === "modvoltapp.cz" ||
    host.endsWith(".modvoltapp.cz") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".invalid") ||
    isIP(unwrapped) !== 0
  );
}

/**
 * Strictly validates canonical secret-free inspect/transition/steady inputs.
 * The logical application identity is deliberately distinct from Coolify's
 * environment identifier so neither can be substituted for the other.
 */
export function validateStagingDeploymentInputs(
  value,
  {
    expectedSchemaAction,
    expectedSourceSha,
    expectedImageManifestSha256,
    expectedProvisioningManifestSha256,
    expectedProvisioning,
  } = {},
) {
  const schemaAction = value?.schemaAction;
  const hasBackup = schemaAction !== "steady-0105";
  const keys = [
    "schemaVersion",
    "sourceSha",
    "imageManifestSha256",
    "provisioningManifestSha256",
    "environmentId",
    "coolifyEnvironmentId",
    "composeProjectName",
    "publicAppUrl",
    "nginxServerName",
    "operationalAlertReceiverUrl",
    "operationalAlertReceiverHost",
    "s3Endpoint",
    "s3Region",
    "s3Bucket",
    "s3ForcePathStyle",
    "externalAccountsEnabled",
    "schemaAction",
    "images",
    ...(hasBackup ? ["backupEvidenceId", "backupRestoreMaxAgeHours"] : []),
  ];
  exactKeys(value, keys, "deployment inputs");
  if (
    !["inspect", "apply-0105", "steady-0105"].includes(schemaAction) ||
    (expectedSchemaAction !== undefined &&
      schemaAction !== expectedSchemaAction)
  ) {
    fail(
      "DEPLOYMENT_INPUTS_SCHEMA_ACTION_INVALID",
      "The deployment input schema action is not the separately approved action.",
    );
  }
  if (
    value.schemaVersion !== 1 ||
    !SHA40.test(String(value.sourceSha)) ||
    /^0{40}$/.test(value.sourceSha) ||
    (expectedSourceSha !== undefined &&
      value.sourceSha !== expectedSourceSha) ||
    !SHA256.test(String(value.imageManifestSha256)) ||
    !SHA256.test(String(value.provisioningManifestSha256)) ||
    (expectedImageManifestSha256 !== undefined &&
      value.imageManifestSha256 !== expectedImageManifestSha256) ||
    (expectedProvisioningManifestSha256 !== undefined &&
      value.provisioningManifestSha256 !==
        expectedProvisioningManifestSha256) ||
    value.environmentId !== "site-logbook-staging" ||
    typeof value.coolifyEnvironmentId !== "string" ||
    !COOLIFY_ID.test(value.coolifyEnvironmentId) ||
    value.coolifyEnvironmentId === value.environmentId ||
    !COMPOSE_PROJECT.test(String(value.composeProjectName)) ||
    value.externalAccountsEnabled !== false
  ) {
    fail(
      "DEPLOYMENT_INPUTS_IDENTITY_INVALID",
      "Deployment inputs do not preserve the exact logical, Coolify and source identities.",
    );
  }
  const app = httpsUrl(value.publicAppUrl, "publicAppUrl", "/");
  const alert = httpsUrl(
    value.operationalAlertReceiverUrl,
    "operationalAlertReceiverUrl",
    "/v1/operational-alerts",
  );
  const s3 = httpsUrl(value.s3Endpoint, "s3Endpoint", "/");
  if (
    value.nginxServerName !== app.hostname ||
    value.operationalAlertReceiverHost !== alert.hostname ||
    app.hostname === alert.hostname ||
    forbiddenPublicHost(app.hostname) ||
    forbiddenPublicHost(alert.hostname) ||
    !/^[a-z0-9-]{1,63}$/.test(String(value.s3Region)) ||
    !S3_BUCKET.test(String(value.s3Bucket)) ||
    value.s3Bucket.length > 63 ||
    PLACEHOLDER.test(value.s3Bucket) ||
    forbiddenPublicHost(s3.hostname) ||
    typeof value.s3ForcePathStyle !== "boolean"
  ) {
    fail(
      "DEPLOYMENT_INPUTS_TARGET_INVALID",
      "Deployment inputs contain an invalid application, receiver or S3 target.",
    );
  }
  if (expectedProvisioning !== undefined) {
    const expected = expectedProvisioning;
    if (
      !expected ||
      typeof expected !== "object" ||
      value.sourceSha !== expected.sourceSha ||
      value.composeProjectName !== expected.composeProjectName ||
      value.coolifyEnvironmentId !== expected.environmentId ||
      value.publicAppUrl !== expected.publicAppUrl ||
      value.nginxServerName !== new URL(expected.publicAppUrl).hostname ||
      value.operationalAlertReceiverUrl !== expected.alertReceiverUrl ||
      value.operationalAlertReceiverHost !== expected.alertReceiverHost ||
      value.s3Endpoint !== expected.s3?.endpoint ||
      value.s3Region !== expected.s3?.region ||
      value.s3Bucket !== expected.s3?.bucket ||
      value.s3ForcePathStyle !== expected.s3?.forcePathStyle ||
      value.provisioningManifestSha256 !== expected.manifestSha256
    ) {
      fail(
        "DEPLOYMENT_INPUTS_PROVISIONING_MISMATCH",
        "Deployment inputs do not exactly match validated Coolify provisioning.",
      );
    }
  }
  exactKeys(value.images, Object.keys(IMMUTABLE_IMAGES), "deployment images");
  for (const [key, packageName] of Object.entries(IMMUTABLE_IMAGES)) {
    const pattern = new RegExp(
      `^ghcr\\.io/modvolt/${packageName}@sha256:[0-9a-f]{64}$`,
    );
    if (!pattern.test(String(value.images[key]))) {
      fail(
        "DEPLOYMENT_INPUTS_IMAGE_INVALID",
        `Deployment image ${key} is not the approved immutable package.`,
      );
    }
  }
  if (
    hasBackup &&
    (!Number.isSafeInteger(value.backupEvidenceId) ||
      value.backupEvidenceId < 1 ||
      !Number.isSafeInteger(value.backupRestoreMaxAgeHours) ||
      value.backupRestoreMaxAgeHours < 1 ||
      value.backupRestoreMaxAgeHours > 168)
  ) {
    fail(
      "DEPLOYMENT_INPUTS_BACKUP_INVALID",
      "Inspect and transition inputs require a bounded backup evidence window.",
    );
  }
  return Object.freeze({
    ...value,
    images: Object.freeze({ ...value.images }),
  });
}

function composeObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("DEPLOYMENT_COMPOSE_TARGET_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactComposeKeys(value, expected, field) {
  const object = composeObject(value, field);
  const actual = Object.keys(object).sort();
  const approved = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(approved)) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${field} does not have the exact approved shape.`,
    );
  }
  return object;
}

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function requireAbsentComposeKeys(value, keys, field) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        `${field}.${key} must be absent from the resolved target.`,
      );
    }
  }
}

function validateDefaultNetwork(value, field) {
  const networks = exactComposeKeys(value, ["default"], field);
  if (networks.default !== null && networks.default !== undefined) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${field}.default must use the project-scoped default network.`,
    );
  }
}

function validateLocalJsonLogging(value, field) {
  const logging = exactComposeKeys(value, ["driver", "options"], field);
  const options = exactComposeKeys(
    logging.options,
    ["max-file", "max-size"],
    `${field} options`,
  );
  if (
    logging.driver !== "json-file" ||
    options["max-file"] !== "3" ||
    options["max-size"] !== "10m"
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${field} must remain bounded local json-file logging.`,
    );
  }
}

function validateDisabledHealthcheck(value, field) {
  const healthcheck = exactComposeKeys(value, ["disable"], field);
  if (healthcheck.disable !== true) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${field} must remain disabled for the one-shot container.`,
    );
  }
}

function validateDependsOn(value, expected, field) {
  const dependencies = exactComposeKeys(value, Object.keys(expected), field);
  for (const [service, condition] of Object.entries(expected)) {
    const dependency = exactComposeKeys(
      dependencies[service],
      ["condition", "required"],
      `${field}.${service}`,
    );
    if (dependency.condition !== condition || dependency.required !== true) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        `${field}.${service} drifted from the approved dependency.`,
      );
    }
  }
}

function validateOneShotService(service, targetService) {
  const expected = {
    "exact-0104-backup": {
      command: ["node", "dist/external-schema-exact-0104-backup.mjs"],
      cpus: 0.5,
      memLimit: "1610612736",
      memReservation: "402653184",
      tmpfs: ["/tmp:size=536870912,mode=1777"],
      profiles: ["exact-0104-backup"],
      dependsOn: false,
    },
    "exact-0105-accounting-backup": {
      command: ["node", "dist/accounting-schema-exact-0105-backup.mjs"],
      cpus: 0.5,
      memLimit: "1610612736",
      memReservation: "402653184",
      tmpfs: ["/tmp:size=536870912,mode=1777"],
      profiles: ["exact-0105-accounting-backup"],
      dependsOn: false,
    },
    "exact-0106-audit-backup": {
      command: ["node", "dist/audit-schema-exact-0106-backup.mjs"],
      cpus: 0.5,
      memLimit: "1610612736",
      memReservation: "402653184",
      tmpfs: ["/tmp:size=536870912,mode=1777"],
      profiles: ["exact-0106-audit-backup"],
      dependsOn: false,
    },
    "exact-0104-recovery-gate": {
      command: ["node", "dist/external-schema-exact-0104-recovery.mjs"],
      cpus: 0.25,
      memLimit: "402653184",
      memReservation: "201326592",
      tmpfs: undefined,
      profiles: ["exact-0104-recovery"],
      dependsOn: false,
    },
    "external-schema-gate": {
      command: ["node", "dist/external-schema-gate.mjs"],
      cpus: 0.25,
      memLimit: "402653184",
      memReservation: "201326592",
      tmpfs: undefined,
      profiles: undefined,
      dependsOn: true,
    },
    "accounting-schema-gate": {
      command: ["node", "dist/accounting-schema-gate.mjs"],
      cpus: 0.25,
      memLimit: "402653184",
      memReservation: "201326592",
      tmpfs: undefined,
      profiles: undefined,
      dependsOn: true,
    },
    "audit-schema-gate": {
      command: ["node", "dist/audit-schema-gate.mjs"],
      cpus: 0.25,
      memLimit: "402653184",
      memReservation: "201326592",
      tmpfs: undefined,
      profiles: ["audit-0107-transition"],
      dependsOn: false,
    },
  }[targetService];
  if (!expected) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_INVALID",
      "Resolved one-shot target service is not approved.",
    );
  }
  const serviceKeys = [
    "cap_drop",
    "command",
    "cpus",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "logging",
    "mem_limit",
    "mem_reservation",
    "networks",
    "pull_policy",
    "read_only",
    "restart",
    "security_opt",
  ];
  if (expected.dependsOn) serviceKeys.push("depends_on");
  if (expected.profiles) serviceKeys.push("profiles");
  if (expected.tmpfs) serviceKeys.push("tmpfs");
  exactComposeKeys(service, serviceKeys, `${targetService} service`);
  if (
    !sameJson(service.command, expected.command) ||
    service.entrypoint !== null ||
    service.restart !== "no" ||
    service.read_only !== true ||
    !sameJson(service.cap_drop, ["ALL"]) ||
    !sameJson(service.security_opt, ["no-new-privileges:true"]) ||
    service.pull_policy !== "always" ||
    service.cpus !== expected.cpus ||
    service.mem_limit !== expected.memLimit ||
    service.mem_reservation !== expected.memReservation ||
    !sameJson(service.tmpfs, expected.tmpfs) ||
    !sameJson(service.profiles, expected.profiles)
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${targetService} executable, isolation or resource limits drifted.`,
    );
  }
  validateDisabledHealthcheck(
    service.healthcheck,
    `${targetService} healthcheck`,
  );
  validateLocalJsonLogging(service.logging, `${targetService} logging`);
  if (expected.dependsOn) {
    validateDependsOn(
      service.depends_on,
      {
        postgres: "service_healthy",
        "staging-preflight": "service_completed_successfully",
      },
      `${targetService} depends_on`,
    );
  }
  requireAbsentComposeKeys(
    service,
    ["privileged", "ports", "expose", "volumes", "build", "network_mode"],
    targetService,
  );
  validateDefaultNetwork(service.networks, `${targetService} networks`);
}

function validatePostgresService(value) {
  const postgres = composeObject(value, "postgres service");
  exactComposeKeys(
    postgres,
    [
      "command",
      "cpus",
      "depends_on",
      "entrypoint",
      "environment",
      "expose",
      "healthcheck",
      "image",
      "logging",
      "mem_limit",
      "mem_reservation",
      "networks",
      "pull_policy",
      "restart",
      "volumes",
    ],
    "postgres service",
  );
  if (
    postgres.image !== STAGING_POSTGRES_IMAGE ||
    postgres.command !== null ||
    postgres.entrypoint !== null ||
    postgres.restart !== "unless-stopped" ||
    postgres.pull_policy !== "always" ||
    !sameJson(postgres.expose, ["5432"]) ||
    postgres.cpus !== 0.5 ||
    postgres.mem_limit !== "805306368" ||
    postgres.mem_reservation !== "536870912"
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Resolved postgres image, process or resource limits drifted.",
    );
  }
  const healthcheck = exactComposeKeys(
    postgres.healthcheck,
    ["interval", "retries", "test", "timeout"],
    "postgres healthcheck",
  );
  if (
    !sameJson(healthcheck.test, [
      "CMD-SHELL",
      "pg_isready -U site_logbook_staging -d site_logbook_staging",
    ]) ||
    healthcheck.timeout !== "5s" ||
    healthcheck.interval !== "10s" ||
    healthcheck.retries !== 10
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Resolved postgres healthcheck drifted.",
    );
  }
  validateLocalJsonLogging(postgres.logging, "postgres logging");
  validateDependsOn(
    postgres.depends_on,
    { "staging-preflight": "service_completed_successfully" },
    "postgres depends_on",
  );
  requireAbsentComposeKeys(
    postgres,
    [
      "privileged",
      "ports",
      "read_only",
      "cap_drop",
      "security_opt",
      "tmpfs",
      "profiles",
      "build",
      "network_mode",
    ],
    "postgres",
  );
  validateDefaultNetwork(postgres.networks, "postgres networks");
  if (!Array.isArray(postgres.volumes) || postgres.volumes.length !== 1) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Postgres must have exactly one staging data volume.",
    );
  }
  const mount = exactComposeKeys(
    postgres.volumes[0],
    ["type", "source", "target", "volume"],
    "postgres data mount",
  );
  if (
    mount.type !== "volume" ||
    mount.source !== STAGING_POSTGRES_VOLUME ||
    mount.target !== STAGING_POSTGRES_DATA_TARGET ||
    !sameJson(mount.volume, {})
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Postgres data mount is not the isolated staging volume.",
    );
  }
  return postgres;
}

function validateTopLevelIsolation(value, composeProjectName) {
  const volumeNames = [
    "staging_alert_receipts",
    "staging_mailca",
    "staging_mailtls",
    STAGING_POSTGRES_VOLUME,
  ];
  const volumes = exactComposeKeys(
    value.volumes,
    volumeNames,
    "compose volumes",
  );
  for (const volumeName of volumeNames) {
    const volume = exactComposeKeys(
      volumes[volumeName],
      ["name"],
      `compose volume ${volumeName}`,
    );
    if (volume.name !== `${composeProjectName}_${volumeName}`) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        `Compose volume ${volumeName} is not project scoped.`,
      );
    }
  }
  const networks = exactComposeKeys(
    value.networks,
    ["default"],
    "compose networks",
  );
  const network = exactComposeKeys(
    networks.default,
    ["name", "ipam"],
    "compose default network",
  );
  if (
    network.name !== `${composeProjectName}_default` ||
    !sameJson(network.ipam, {})
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Compose default network is not the isolated project network.",
    );
  }
  return Object.freeze({
    postgresVolumeName: `${composeProjectName}_${STAGING_POSTGRES_VOLUME}`,
    defaultNetworkName: `${composeProjectName}_default`,
  });
}

function exactEnvironmentValue(environment, key, expected, field) {
  if (environment[key] !== expected) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      `${field}.${key} does not match the approved deployment input.`,
    );
  }
}

function validateDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "The resolved target DATABASE_URL is invalid.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    decodeURIComponent(parsed.username) !== "site_logbook_staging" ||
    parsed.password.length === 0 ||
    parsed.hostname !== "postgres" ||
    parsed.port !== "5432" ||
    parsed.pathname !== "/site_logbook_staging" ||
    parsed.search ||
    parsed.hash
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "The resolved target DATABASE_URL does not identify isolated staging Postgres.",
    );
  }
}

/** Bind a resolved `docker compose config --format json` target to reviewed inputs. */
export function validateResolvedStagingComposeTarget(
  value,
  inputsValue,
  {
    targetService,
    deploymentInputsSha256: expectedInputsSha256,
    recoveryInputsSha256,
    accountingInputsSha256,
    exact0105BackupExecutionSha256,
    exact0105BackupMaxPayloadBytes,
    exact0105BackupSizeBytes,
    auditInputsSha256,
    exact0106BackupExecutionSha256,
    exact0106BackupMaxPayloadBytes,
    exact0106BackupSizeBytes,
    auditLineageMode,
    auditOpaqueLegacyRowsJson,
  },
) {
  const inputs = validateStagingDeploymentInputs(inputsValue);
  if (
    ![
      "exact-0104-backup",
      "exact-0105-accounting-backup",
      "exact-0106-audit-backup",
      "exact-0104-recovery-gate",
      "external-schema-gate",
      "accounting-schema-gate",
      "audit-schema-gate",
    ].includes(targetService) ||
    !SHA256.test(String(expectedInputsSha256)) ||
    value?.name !== inputs.composeProjectName
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_INVALID",
      "Resolved Compose project or target service is not approved.",
    );
  }
  if (
    targetService === "exact-0106-audit-backup" ||
    targetService === "audit-schema-gate"
  ) {
    validateAuditLineageBinding(auditLineageMode, auditOpaqueLegacyRowsJson);
  }
  const isolation = validateTopLevelIsolation(value, inputs.composeProjectName);
  const services = composeObject(value.services, "compose services");
  const preflight = composeObject(
    services["staging-preflight"],
    "staging-preflight service",
  );
  const postgres = validatePostgresService(services.postgres);
  const target = composeObject(
    services[targetService],
    `${targetService} service`,
  );
  validateOneShotService(target, targetService);
  const preflightEnvironment = composeObject(
    preflight.environment,
    "staging-preflight environment",
  );
  const postgresEnvironment = exactComposeKeys(
    postgres.environment,
    ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"],
    "postgres environment",
  );
  const targetEnvironment = composeObject(
    target.environment,
    `${targetService} environment`,
  );
  exactComposeKeys(
    targetEnvironment,
    targetService === "exact-0104-backup"
      ? [
          "BACKUP_ENABLED",
          "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
          "BACKUP_ENCRYPTION_KEYRING",
          "DATABASE_URL",
          "EXTERNAL_ACCOUNTS_ENABLED",
          "S3_ACCESS_KEY_ID",
          "S3_BUCKET",
          "S3_ENDPOINT",
          "S3_FORCE_PATH_STYLE",
          "S3_PRIVATE_PREFIX",
          "S3_REGION",
          "S3_SECRET_ACCESS_KEY",
          "STAGING_BACKUP_EVIDENCE_ID",
          "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
          "STAGING_BUILD_SHA",
          "STAGING_COMPOSE_PROJECT_NAME",
          "STAGING_DATABASE_HOST",
          "STAGING_DATABASE_NAME",
          "STAGING_DATABASE_USER",
          "STAGING_DEPLOYMENT_INPUTS_SHA256",
          "STAGING_ENVIRONMENT_ID",
          "STAGING_EXACT_0104_BACKUP_ACTION",
          "STAGING_EXACT_0104_BACKUP_CONFIRMATION",
          "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
          "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
          "STAGING_IMAGE_MANIFEST_SHA256",
          "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
          "STAGING_PROVISIONING_MANIFEST_SHA256",
          "STAGING_SCHEMA_ACTION",
        ]
      : targetService === "exact-0105-accounting-backup"
        ? [
            "ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION",
            "BACKUP_ENABLED",
            "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
            "BACKUP_ENCRYPTION_KEYRING",
            "DATABASE_URL",
            "EXTERNAL_ACCOUNTS_ENABLED",
            "S3_ACCESS_KEY_ID",
            "S3_BUCKET",
            "S3_ENDPOINT",
            "S3_FORCE_PATH_STYLE",
            "S3_PRIVATE_PREFIX",
            "S3_REGION",
            "S3_SECRET_ACCESS_KEY",
            "STAGING_BACKUP_EVIDENCE_ID",
            "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
            "STAGING_BUILD_SHA",
            "STAGING_COMPOSE_PROJECT_NAME",
            "STAGING_DATABASE_HOST",
            "STAGING_DATABASE_NAME",
            "STAGING_DATABASE_USER",
            "STAGING_DEPLOYMENT_INPUTS_SHA256",
            "STAGING_ENVIRONMENT_ID",
            "STAGING_EXACT_0105_BACKUP_ACTION",
            "STAGING_EXACT_0105_BACKUP_CONFIRMATION",
            "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
            "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
            "STAGING_IMAGE_MANIFEST_SHA256",
            "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
            "STAGING_PROVISIONING_MANIFEST_SHA256",
            "STAGING_SCHEMA_ACTION",
          ]
        : targetService === "exact-0106-audit-backup"
          ? [
              "ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION",
              "AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256",
              "AUDIT_SCHEMA_LINEAGE_MODE",
              "AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON",
              "AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION",
              "BACKUP_ENABLED",
              "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
              "BACKUP_ENCRYPTION_KEYRING",
              "DATABASE_URL",
              "EXTERNAL_ACCOUNTS_ENABLED",
              "S3_ACCESS_KEY_ID",
              "S3_BUCKET",
              "S3_ENDPOINT",
              "S3_FORCE_PATH_STYLE",
              "S3_PRIVATE_PREFIX",
              "S3_REGION",
              "S3_SECRET_ACCESS_KEY",
              "STAGING_BACKUP_EVIDENCE_ID",
              "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
              "STAGING_AUDIT_SCHEMA_ACTION",
              "STAGING_BUILD_SHA",
              "STAGING_COMPOSE_PROJECT_NAME",
              "STAGING_DATABASE_HOST",
              "STAGING_DATABASE_NAME",
              "STAGING_DATABASE_USER",
              "STAGING_DEPLOYMENT_INPUTS_SHA256",
              "STAGING_ENVIRONMENT_ID",
              "STAGING_EXACT_0106_BACKUP_ACTION",
              "STAGING_EXACT_0106_BACKUP_CONFIRMATION",
              "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
              "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
              "STAGING_IMAGE_MANIFEST_SHA256",
              "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
              "STAGING_PROVISIONING_MANIFEST_SHA256",
              "STAGING_SCHEMA_ACTION",
            ]
          : targetService === "exact-0104-recovery-gate"
            ? [
                "DATABASE_URL",
                "EXTERNAL_ACCOUNTS_ENABLED",
                "STAGING_API_IMAGE",
                "STAGING_BACKUP_EVIDENCE_ID",
                "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
                "STAGING_BASELINE_0104_EXECUTION_B64",
                "STAGING_BASELINE_0104_EXECUTION_SHA256",
                "STAGING_BUILD_SHA",
                "STAGING_COMPOSE_PROJECT_NAME",
                "STAGING_DATABASE_HOST",
                "STAGING_DATABASE_NAME",
                "STAGING_DATABASE_USER",
                "STAGING_DEPLOYMENT_INPUTS_SHA256",
                "STAGING_ENVIRONMENT_ID",
                "STAGING_EXACT_0104_RECOVERY_INPUTS_B64",
                "STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256",
                "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
                "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
                "STAGING_IMAGE_MANIFEST_SHA256",
                "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
                "STAGING_PROVISIONING_MANIFEST_SHA256",
                "STAGING_SCHEMA_ACTION",
              ]
            : targetService === "accounting-schema-gate"
              ? [
                  "ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION",
                  "DATABASE_URL",
                  "EXTERNAL_ACCOUNTS_ENABLED",
                  "STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256",
                  "STAGING_ACCOUNTING_SCHEMA_ACTION",
                  "STAGING_API_IMAGE",
                  "STAGING_BACKUP_EVIDENCE_ID",
                  "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
                  "STAGING_BUILD_SHA",
                  "STAGING_COMPOSE_PROJECT_NAME",
                  "STAGING_DATABASE_HOST",
                  "STAGING_DATABASE_NAME",
                  "STAGING_DATABASE_USER",
                  "STAGING_DEPLOYMENT_INPUTS_SHA256",
                  "STAGING_ENVIRONMENT_ID",
                  "STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256",
                  "STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES",
                  "STAGING_EXACT_0105_BACKUP_SIZE_BYTES",
                  "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
                  "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
                  "STAGING_IMAGE_MANIFEST_SHA256",
                  "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
                  "STAGING_PROVISIONING_MANIFEST_SHA256",
                  "STAGING_SCHEMA_ACTION",
                ]
              : targetService === "audit-schema-gate"
                ? [
                    "AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256",
                    "AUDIT_SCHEMA_LINEAGE_MODE",
                    "AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON",
                    "AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION",
                    "DATABASE_URL",
                    "EXTERNAL_ACCOUNTS_ENABLED",
                    "STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256",
                    "STAGING_AUDIT_SCHEMA_ACTION",
                    "STAGING_API_IMAGE",
                    "STAGING_BACKUP_EVIDENCE_ID",
                    "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
                    "STAGING_BUILD_SHA",
                    "STAGING_COMPOSE_PROJECT_NAME",
                    "STAGING_DATABASE_HOST",
                    "STAGING_DATABASE_NAME",
                    "STAGING_DATABASE_USER",
                    "STAGING_DEPLOYMENT_INPUTS_SHA256",
                    "STAGING_ENVIRONMENT_ID",
                    "STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256",
                    "STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES",
                    "STAGING_EXACT_0106_BACKUP_SIZE_BYTES",
                    "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
                    "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
                    "STAGING_IMAGE_MANIFEST_SHA256",
                    "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
                    "STAGING_PROVISIONING_MANIFEST_SHA256",
                    "STAGING_SCHEMA_ACTION",
                  ]
                : [
                    "DATABASE_URL",
                    "EXTERNAL_ACCOUNTS_ENABLED",
                    "EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION",
                    "STAGING_BACKUP_EVIDENCE_ID",
                    "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
                    "STAGING_BUILD_SHA",
                    "STAGING_DATABASE_HOST",
                    "STAGING_DATABASE_NAME",
                    "STAGING_DATABASE_USER",
                    "STAGING_DEPLOYMENT_INPUTS_SHA256",
                    "STAGING_ENVIRONMENT_ID",
                    "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
                    "STAGING_SCHEMA_ACTION",
                  ],
    `${targetService} environment`,
  );
  const common = [
    ["STAGING_ENVIRONMENT_ID", inputs.environmentId],
    ["STAGING_BUILD_SHA", inputs.sourceSha],
    ["STAGING_IMAGE_MANIFEST_SOURCE_SHA", inputs.sourceSha],
    ["STAGING_DEPLOYMENT_INPUTS_SHA256", expectedInputsSha256],
  ];
  for (const [key, expected] of common) {
    exactEnvironmentValue(
      preflightEnvironment,
      key,
      expected,
      "staging-preflight",
    );
    exactEnvironmentValue(targetEnvironment, key, expected, targetService);
  }
  for (const [key, expected] of [
    ["STAGING_COMPOSE_PROJECT_NAME", inputs.composeProjectName],
    ["STAGING_SCHEMA_ACTION", inputs.schemaAction],
    ["STAGING_IMAGE_MANIFEST_SHA256", inputs.imageManifestSha256],
    ["STAGING_PROVISIONING_MANIFEST_SHA256", inputs.provisioningManifestSha256],
    ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "false"],
    ["STAGING_API_IMAGE", inputs.images.api],
    ["STAGING_S3_ENDPOINT", inputs.s3Endpoint],
    ["STAGING_S3_REGION", inputs.s3Region],
    ["STAGING_S3_BUCKET", inputs.s3Bucket],
    ["STAGING_S3_FORCE_PATH_STYLE", String(inputs.s3ForcePathStyle)],
  ]) {
    exactEnvironmentValue(
      preflightEnvironment,
      key,
      expected,
      "staging-preflight",
    );
  }
  exactEnvironmentValue(
    targetEnvironment,
    "STAGING_SCHEMA_ACTION",
    inputs.schemaAction,
    targetService,
  );
  exactEnvironmentValue(
    targetEnvironment,
    "EXTERNAL_ACCOUNTS_ENABLED",
    "false",
    targetService,
  );
  for (const [key, expected] of [
    ["STAGING_DATABASE_HOST", "postgres"],
    ["STAGING_DATABASE_NAME", "site_logbook_staging"],
    ["STAGING_DATABASE_USER", "site_logbook_staging"],
    ["STAGING_BACKUP_EVIDENCE_ID", String(inputs.backupEvidenceId)],
    [
      "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS",
      String(inputs.backupRestoreMaxAgeHours),
    ],
  ]) {
    exactEnvironmentValue(targetEnvironment, key, expected, targetService);
  }
  exactEnvironmentValue(
    postgresEnvironment,
    "POSTGRES_USER",
    "site_logbook_staging",
    "postgres",
  );
  if (
    typeof postgresEnvironment.POSTGRES_PASSWORD !== "string" ||
    postgresEnvironment.POSTGRES_PASSWORD.length === 0
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "Resolved postgres requires a nonempty staging-only password.",
    );
  }
  exactEnvironmentValue(
    postgresEnvironment,
    "POSTGRES_DB",
    "site_logbook_staging",
    "postgres",
  );
  if (target.image !== inputs.images.api) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "The resolved one-shot API image does not match the approved input.",
    );
  }
  validateDatabaseUrl(targetEnvironment.DATABASE_URL);
  if (
    targetService === "exact-0104-backup" ||
    targetService === "exact-0105-accounting-backup" ||
    targetService === "exact-0106-audit-backup"
  ) {
    for (const [key, expected] of [
      ["STAGING_COMPOSE_PROJECT_NAME", inputs.composeProjectName],
      ["STAGING_IMAGE_MANIFEST_SHA256", inputs.imageManifestSha256],
      [
        "STAGING_PROVISIONING_MANIFEST_SHA256",
        inputs.provisioningManifestSha256,
      ],
      ["S3_ENDPOINT", inputs.s3Endpoint],
      ["S3_REGION", inputs.s3Region],
      ["S3_BUCKET", inputs.s3Bucket],
      ["S3_FORCE_PATH_STYLE", String(inputs.s3ForcePathStyle)],
    ]) {
      exactEnvironmentValue(targetEnvironment, key, expected, targetService);
    }
    for (const key of [
      "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
      "BACKUP_ENCRYPTION_KEYRING",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      if (
        typeof targetEnvironment[key] !== "string" ||
        !targetEnvironment[key]
      ) {
        fail(
          "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
          `${targetService}.${key} must be a nonempty staging-only secret.`,
        );
      }
    }
    for (const [key, expected] of [
      ["BACKUP_ENABLED", "true"],
      ["S3_PRIVATE_PREFIX", "private"],
      ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "false"],
      ["STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ...(targetService === "exact-0105-accounting-backup"
        ? [
            ["ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
            ["STAGING_EXACT_0105_BACKUP_ACTION", ""],
            ["STAGING_EXACT_0105_BACKUP_CONFIRMATION", ""],
          ]
        : []),
      ...(targetService === "exact-0106-audit-backup"
        ? [
            ["ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
            ["AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256", ""],
            ["AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
            ["STAGING_AUDIT_SCHEMA_ACTION", "inspect"],
            ["AUDIT_SCHEMA_LINEAGE_MODE", auditLineageMode],
            ["AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON", auditOpaqueLegacyRowsJson],
            ["STAGING_EXACT_0106_BACKUP_ACTION", ""],
            ["STAGING_EXACT_0106_BACKUP_CONFIRMATION", ""],
          ]
        : []),
    ]) {
      exactEnvironmentValue(targetEnvironment, key, expected, targetService);
    }
  } else if (targetService === "exact-0104-recovery-gate") {
    if (!SHA256.test(String(recoveryInputsSha256))) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_INVALID",
        "The exact recovery input checksum is required for this target.",
      );
    }
    for (const [key, expected] of [
      ["STAGING_COMPOSE_PROJECT_NAME", inputs.composeProjectName],
      ["STAGING_IMAGE_MANIFEST_SHA256", inputs.imageManifestSha256],
      [
        "STAGING_PROVISIONING_MANIFEST_SHA256",
        inputs.provisioningManifestSha256,
      ],
      ["STAGING_API_IMAGE", inputs.images.api],
      ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "false"],
      ["STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ["STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256", recoveryInputsSha256],
    ]) {
      exactEnvironmentValue(targetEnvironment, key, expected, targetService);
    }
    for (const key of [
      "STAGING_EXACT_0104_RECOVERY_INPUTS_B64",
      "STAGING_BASELINE_0104_EXECUTION_B64",
    ]) {
      if (
        typeof targetEnvironment[key] !== "string" ||
        targetEnvironment[key].length === 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(targetEnvironment[key])
      ) {
        fail(
          "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
          `${targetService}.${key} must be nonempty canonical-looking Base64 evidence.`,
        );
      }
    }
    if (
      !SHA256.test(
        String(targetEnvironment.STAGING_BASELINE_0104_EXECUTION_SHA256),
      )
    ) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        "The exact recovery target baseline execution checksum is invalid.",
      );
    }
  } else if (targetService === "accounting-schema-gate") {
    if (
      !SHA256.test(String(accountingInputsSha256)) ||
      !SHA256.test(String(exact0105BackupExecutionSha256)) ||
      exact0105BackupMaxPayloadBytes !== 256 * 1024 * 1024 ||
      !Number.isSafeInteger(exact0105BackupSizeBytes) ||
      exact0105BackupSizeBytes < 1 ||
      exact0105BackupSizeBytes > exact0105BackupMaxPayloadBytes
    ) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_INVALID",
        "The exact accounting transition and backup execution bindings are required.",
      );
    }
    for (const [key, expected] of [
      ["STAGING_COMPOSE_PROJECT_NAME", inputs.composeProjectName],
      ["STAGING_IMAGE_MANIFEST_SHA256", inputs.imageManifestSha256],
      [
        "STAGING_PROVISIONING_MANIFEST_SHA256",
        inputs.provisioningManifestSha256,
      ],
      ["STAGING_API_IMAGE", inputs.images.api],
      ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "false"],
      ["STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ["STAGING_ACCOUNTING_SCHEMA_ACTION", "steady-0106"],
      ["ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ["STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256", accountingInputsSha256],
      [
        "STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256",
        exact0105BackupExecutionSha256,
      ],
      [
        "STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES",
        String(exact0105BackupMaxPayloadBytes),
      ],
      [
        "STAGING_EXACT_0105_BACKUP_SIZE_BYTES",
        String(exact0105BackupSizeBytes),
      ],
    ]) {
      exactEnvironmentValue(targetEnvironment, key, expected, targetService);
    }
    if (
      Object.keys(targetEnvironment).some(
        (key) => key.startsWith("S3_") || key.startsWith("STAGING_S3_"),
      )
    ) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        "The accounting transition target must not receive an S3 write surface.",
      );
    }
  } else if (targetService === "audit-schema-gate") {
    if (
      !SHA256.test(String(auditInputsSha256)) ||
      !SHA256.test(String(exact0106BackupExecutionSha256)) ||
      exact0106BackupMaxPayloadBytes !== 256 * 1024 * 1024 ||
      !Number.isSafeInteger(exact0106BackupSizeBytes) ||
      exact0106BackupSizeBytes < 1 ||
      exact0106BackupSizeBytes > exact0106BackupMaxPayloadBytes ||
      !["clean", "production-copy-restricted"].includes(auditLineageMode) ||
      typeof auditOpaqueLegacyRowsJson !== "string" ||
      auditOpaqueLegacyRowsJson.length < 2
    ) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_INVALID",
        "The exact audit transition, lineage and backup execution bindings are required.",
      );
    }
    for (const [key, expected] of [
      ["STAGING_COMPOSE_PROJECT_NAME", inputs.composeProjectName],
      ["STAGING_IMAGE_MANIFEST_SHA256", inputs.imageManifestSha256],
      [
        "STAGING_PROVISIONING_MANIFEST_SHA256",
        inputs.provisioningManifestSha256,
      ],
      ["STAGING_API_IMAGE", inputs.images.api],
      ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "false"],
      ["STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ["STAGING_AUDIT_SCHEMA_ACTION", "steady-0107"],
      ["AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256", ""],
      ["AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION", ""],
      ["AUDIT_SCHEMA_LINEAGE_MODE", auditLineageMode],
      ["AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON", auditOpaqueLegacyRowsJson],
      ["STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256", auditInputsSha256],
      [
        "STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256",
        exact0106BackupExecutionSha256,
      ],
      [
        "STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES",
        String(exact0106BackupMaxPayloadBytes),
      ],
      [
        "STAGING_EXACT_0106_BACKUP_SIZE_BYTES",
        String(exact0106BackupSizeBytes),
      ],
    ]) {
      exactEnvironmentValue(targetEnvironment, key, expected, targetService);
    }
    if (
      Object.keys(targetEnvironment).some(
        (key) => key.startsWith("S3_") || key.startsWith("STAGING_S3_"),
      )
    ) {
      fail(
        "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
        "The audit transition target must not receive an S3 write surface.",
      );
    }
  } else if (
    Object.keys(targetEnvironment).some(
      (key) => key.startsWith("S3_") || key.startsWith("STAGING_S3_"),
    )
  ) {
    fail(
      "DEPLOYMENT_COMPOSE_TARGET_MISMATCH",
      "The schema transition target must not receive an S3 write surface.",
    );
  }
  return Object.freeze({
    composeProjectName: inputs.composeProjectName,
    targetService,
    sourceSha: inputs.sourceSha,
    apiImage: inputs.images.api,
    postgresImage: STAGING_POSTGRES_IMAGE,
    postgresVolumeName: isolation.postgresVolumeName,
    defaultNetworkName: isolation.defaultNetworkName,
  });
}

function hasNoPublishedPorts(value) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (bindings) =>
      bindings === null || (Array.isArray(bindings) && bindings.length === 0),
  );
}

/** Validate the secret-free projection of the live staging postgres container. */
export function validateRunningStagingPostgresContainer(
  value,
  bindingValue,
  { expectedContainerId } = {},
) {
  const binding = composeObject(bindingValue, "resolved Compose binding");
  if (
    !COMPOSE_PROJECT.test(String(binding.composeProjectName)) ||
    binding.postgresImage !== STAGING_POSTGRES_IMAGE ||
    binding.postgresVolumeName !==
      `${binding.composeProjectName}_${STAGING_POSTGRES_VOLUME}` ||
    binding.defaultNetworkName !== `${binding.composeProjectName}_default` ||
    !/^[0-9a-f]{12,64}$/.test(String(expectedContainerId))
  ) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_INVALID",
      "The expected live postgres identity is incomplete.",
    );
  }
  const projection = exactComposeKeys(
    value,
    [
      "id",
      "running",
      "configImage",
      "imageId",
      "projectLabel",
      "serviceLabel",
      "path",
      "args",
      "mounts",
      "networks",
      "portBindings",
      "networkPorts",
    ],
    "live postgres projection",
  );
  if (
    !/^[0-9a-f]{64}$/.test(String(projection.id)) ||
    !projection.id.startsWith(expectedContainerId) ||
    projection.running !== true ||
    projection.configImage !== binding.postgresImage ||
    !/^sha256:[0-9a-f]{64}$/.test(String(projection.imageId)) ||
    projection.projectLabel !== binding.composeProjectName ||
    projection.serviceLabel !== "postgres" ||
    projection.path !== "docker-entrypoint.sh" ||
    !sameJson(projection.args, ["postgres"]) ||
    !hasNoPublishedPorts(projection.portBindings)
  ) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_MISMATCH",
      "The running postgres container does not match the approved process and project.",
    );
  }
  const networkPorts = exactComposeKeys(
    projection.networkPorts,
    ["5432/tcp"],
    "live postgres network ports",
  );
  if (!hasNoPublishedPorts(networkPorts)) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_MISMATCH",
      "The running postgres container must not publish its database port.",
    );
  }
  if (!Array.isArray(projection.mounts) || projection.mounts.length !== 1) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_MISMATCH",
      "The running postgres container must have one isolated data mount.",
    );
  }
  const mount = composeObject(projection.mounts[0], "live postgres mount");
  if (
    mount.Type !== "volume" ||
    mount.Name !== binding.postgresVolumeName ||
    mount.Destination !== STAGING_POSTGRES_DATA_TARGET ||
    mount.Driver !== "local" ||
    mount.Mode !== "rw" ||
    mount.RW !== true ||
    mount.Propagation !== ""
  ) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_MISMATCH",
      "The running postgres mount is not the exact staging data volume.",
    );
  }
  const networks = exactComposeKeys(
    projection.networks,
    [binding.defaultNetworkName],
    "live postgres networks",
  );
  const network = composeObject(
    networks[binding.defaultNetworkName],
    "live postgres default network",
  );
  if (!/^[0-9a-f]{64}$/.test(String(network.NetworkID))) {
    fail(
      "DEPLOYMENT_POSTGRES_RUNTIME_MISMATCH",
      "The running postgres network is not an exact Docker network.",
    );
  }
  return Object.freeze({
    containerId: projection.id,
    image: projection.configImage,
    imageId: projection.imageId,
    volumeName: mount.Name,
    networkName: binding.defaultNetworkName,
    networkId: network.NetworkID,
  });
}

export function buildStagingDeploymentInputs({
  images,
  imageManifestSha256,
  provisioning,
  schemaAction,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  if (!["inspect", "apply-0105", "steady-0105"].includes(schemaAction)) {
    fail(
      "DEPLOYMENT_BINDING_SCHEMA_ACTION",
      "schemaAction must be inspect, apply-0105 or steady-0105.",
    );
  }
  const input = {
    schemaVersion: 1,
    sourceSha: provisioning.sourceSha,
    imageManifestSha256,
    provisioningManifestSha256: provisioning.manifestSha256,
    environmentId: "site-logbook-staging",
    coolifyEnvironmentId: provisioning.environmentId,
    composeProjectName: provisioning.composeProjectName,
    publicAppUrl: provisioning.publicAppUrl,
    nginxServerName: new URL(provisioning.publicAppUrl).hostname,
    operationalAlertReceiverUrl: provisioning.alertReceiverUrl,
    operationalAlertReceiverHost: provisioning.alertReceiverHost,
    s3Endpoint: provisioning.s3.endpoint,
    s3Region: provisioning.s3.region,
    s3Bucket: provisioning.s3.bucket,
    s3ForcePathStyle: provisioning.s3.forcePathStyle,
    externalAccountsEnabled: false,
    schemaAction,
    images: {
      preflight: images.preflight,
      mailpit: images.mailpit,
      api: images.api,
      web: images.web,
      alertReceiver: images.alertReceiver,
    },
  };
  if (schemaAction !== "steady-0105") {
    if (!Number.isInteger(backupEvidenceId) || backupEvidenceId <= 0) {
      fail(
        "DEPLOYMENT_BINDING_BACKUP_INVALID",
        "Transition requires a positive backup evidence id.",
      );
    }
    if (
      !Number.isInteger(backupRestoreMaxAgeHours) ||
      backupRestoreMaxAgeHours < 1 ||
      backupRestoreMaxAgeHours > 168
    ) {
      fail(
        "DEPLOYMENT_BINDING_BACKUP_INVALID",
        "Transition backup maximum age must be 1 through 168 hours.",
      );
    }
    input.backupEvidenceId = backupEvidenceId;
    input.backupRestoreMaxAgeHours = backupRestoreMaxAgeHours;
  }
  return validateStagingDeploymentInputs(input, {
    expectedSchemaAction: schemaAction,
    expectedSourceSha: provisioning.sourceSha,
    expectedImageManifestSha256: imageManifestSha256,
    expectedProvisioningManifestSha256: provisioning.manifestSha256,
    expectedProvisioning: provisioning,
  });
}

export function deploymentInputsSha256(inputs) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(inputs))
    .digest("hex");
}

export function createStagingDeploymentBinding({
  manifestBytes,
  checksumText,
  provisioningManifest,
  expectedManifestSha256,
  expectedSourceSha,
  expectedCallerWorkflowRef,
  expectedCallerWorkflowSha,
  expectedRunId,
  expectedRunAttempt,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  const images = validateStagingImageManifest(manifestBytes, checksumText, {
    expectedManifestSha256,
    expectedSourceSha,
    expectedCallerWorkflowRef,
    expectedCallerWorkflowSha,
    expectedRunId,
    expectedRunAttempt,
  });
  if (!images.trusted) {
    fail(
      "DEPLOYMENT_BINDING_MANIFEST_UNTRUSTED",
      "A separately approved image manifest checksum is required.",
    );
  }
  const provisioning = validateStagingProvisioning(provisioningManifest, {
    expectedSourceSha: images.sourceSha,
  });
  if (!provisioning.authorizesDeployment) {
    fail(
      "DEPLOYMENT_BINDING_PROVISIONING_UNOBSERVED",
      "Observed Coolify provisioning is required.",
    );
  }
  const transition = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "apply-0105",
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const inspect = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "inspect",
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const steady = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "steady-0105",
  });
  const commonEnvironment = {
    STAGING_IMAGE_MANIFEST_B64: images.manifestBase64,
    STAGING_IMAGE_MANIFEST_SHA256: images.manifestSha256,
    STAGING_PROVISIONING_MANIFEST_SHA256: provisioning.manifestSha256,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: images.sourceSha,
    STAGING_PREFLIGHT_IMAGE: images.images.preflight,
    STAGING_MAILPIT_IMAGE: images.images.mailpit,
    STAGING_API_IMAGE: images.images.api,
    STAGING_WEB_IMAGE: images.images.web,
    STAGING_ALERT_RECEIVER_IMAGE: images.images.alertReceiver,
  };
  return Object.freeze({
    decision: "PASS",
    sourceSha: images.sourceSha,
    imageManifestSha256: images.manifestSha256,
    provisioningManifestSha256: provisioning.manifestSha256,
    provisioningArtifact: Object.freeze(structuredClone(provisioningManifest)),
    inspect: Object.freeze({
      inputs: inspect,
      sha256: deploymentInputsSha256(inspect),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "inspect",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(inspect),
        STAGING_BACKUP_EVIDENCE_ID: String(backupEvidenceId),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(backupRestoreMaxAgeHours),
      }),
    }),
    transition: Object.freeze({
      inputs: transition,
      sha256: deploymentInputsSha256(transition),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "apply-0105",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(transition),
        STAGING_BACKUP_EVIDENCE_ID: String(backupEvidenceId),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(backupRestoreMaxAgeHours),
      }),
    }),
    steady: Object.freeze({
      inputs: steady,
      sha256: deploymentInputsSha256(steady),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "steady-0105",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(steady),
        STAGING_BACKUP_EVIDENCE_ID: "",
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "",
      }),
    }),
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicWriteExclusive(directory, name, content) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "DEPLOYMENT_BINDING_OUTPUT_EXISTS",
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
    fs.writeFileSync(descriptor, content, "utf8");
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

export function writeBindingArtifacts(directory, result) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "DEPLOYMENT_BINDING_OUTPUT_INVALID",
      "Output directory must be a nonsymlink directory.",
    );
  }
  return Object.freeze({
    provisioning: atomicWriteExclusive(
      absolute,
      "staging-provisioning-observed.json",
      canonicalJson(result.provisioningArtifact),
    ),
    inspectInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-inspect.json",
      canonicalJson(result.inspect.inputs),
    ),
    inspectInputsChecksum: atomicWriteExclusive(
      absolute,
      "staging-deployment-inspect.sha256",
      `${result.inspect.sha256}  staging-deployment-inspect.json\n`,
    ),
    transitionInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-transition.json",
      canonicalJson(result.transition.inputs),
    ),
    transitionInputsChecksum: atomicWriteExclusive(
      absolute,
      "staging-deployment-transition.sha256",
      `${result.transition.sha256}  staging-deployment-transition.json\n`,
    ),
    steadyInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-steady.json",
      canonicalJson(result.steady.inputs),
    ),
    steadyInputsChecksum: atomicWriteExclusive(
      absolute,
      "staging-deployment-steady.sha256",
      `${result.steady.sha256}  staging-deployment-steady.json\n`,
    ),
    environment: atomicWriteExclusive(
      absolute,
      "staging-deployment-environment.json",
      `${JSON.stringify(
        {
          inspect: result.inspect.environment,
          transition: result.transition.environment,
          steady: result.steady.environment,
        },
        null,
        2,
      )}\n`,
    ),
  });
}

function main() {
  const manifestPath = argument("--manifest");
  const checksumPath = argument("--checksum");
  const provisioningPath = argument("--provisioning");
  const expectedManifestSha256 = argument("--expected-manifest-sha256");
  const expectedSourceSha = argument("--expected-source-sha");
  const expectedCallerWorkflowRef = argument("--expected-caller-workflow-ref");
  const expectedCallerWorkflowSha = argument("--expected-caller-workflow-sha");
  if (
    !manifestPath ||
    !checksumPath ||
    !provisioningPath ||
    !expectedManifestSha256 ||
    !expectedSourceSha ||
    !expectedCallerWorkflowRef ||
    !expectedCallerWorkflowSha
  ) {
    fail(
      "DEPLOYMENT_BINDING_INPUT_MISSING",
      "Pass manifest, checksum, provisioning, approved manifest checksum, source SHA, caller workflow ref and caller workflow SHA.",
    );
  }
  const result = createStagingDeploymentBinding({
    manifestBytes: fs.readFileSync(path.resolve(manifestPath)),
    checksumText: fs.readFileSync(path.resolve(checksumPath), "utf8"),
    provisioningManifest: JSON.parse(
      fs.readFileSync(path.resolve(provisioningPath), "utf8"),
    ),
    expectedManifestSha256,
    expectedSourceSha,
    expectedCallerWorkflowRef,
    expectedCallerWorkflowSha,
    expectedRunId: argument("--expected-run-id"),
    expectedRunAttempt: argument("--expected-run-attempt"),
    backupEvidenceId: Number(argument("--backup-evidence-id")),
    backupRestoreMaxAgeHours: Number(
      argument("--backup-restore-max-age-hours"),
    ),
  });
  const outputDirectory = argument("--output-dir");
  const output = outputDirectory
    ? {
        decision: result.decision,
        sourceSha: result.sourceSha,
        imageManifestSha256: result.imageManifestSha256,
        provisioningManifestSha256: result.provisioningManifestSha256,
        inspectSha256: result.inspect.sha256,
        transitionSha256: result.transition.sha256,
        steadySha256: result.steady.sha256,
        files: writeBindingArtifacts(outputDirectory, result),
      }
    : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
