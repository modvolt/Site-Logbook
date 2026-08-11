import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROJECT = /^site-logbook-staging(?:-[a-z0-9-]+)?$/;
const PLACEHOLDER = /(pending|replace(?:-me)?)/i;
const SENSITIVE_KEY =
  /(^|_)(password|secret|token|keyring|database.?url|authorization|private.?key)($|_)/i;
const SENSITIVE_VALUE =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,})/;
const SAFE_PRIVATE_SERVICES = Object.freeze([
  "api",
  "accounting-schema-gate",
  "external-schema-gate",
  "mailpit",
  "postgres",
  "staging-preflight",
]);
const EXPECTED_LIMITS = Object.freeze({
  "staging-preflight": { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
  postgres: { cpus: 0.5, memoryMiB: 768, reservationMiB: 512 },
  "external-schema-gate": { cpus: 0.25, memoryMiB: 384, reservationMiB: 192 },
  "accounting-schema-gate": {
    cpus: 0.25,
    memoryMiB: 384,
    reservationMiB: 192,
  },
  mailpit: { cpus: 0.25, memoryMiB: 256, reservationMiB: 128 },
  api: { cpus: 1, memoryMiB: 1024, reservationMiB: 768 },
  "alert-receiver": { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
  web: { cpus: 0.25, memoryMiB: 128, reservationMiB: 64 },
});
const EXPECTED_VOLUMES = Object.freeze({
  staging_pgdata: [
    {
      service: "postgres",
      target: "/var/lib/postgresql/data",
      readOnly: false,
    },
  ],
  staging_mailtls: [
    { service: "mailpit", target: "/certs/private", readOnly: false },
  ],
  staging_mailca: [
    { service: "mailpit", target: "/certs/trust", readOnly: false },
    { service: "api", target: "/run/staging-mail-ca", readOnly: true },
  ],
  staging_alert_receipts: [
    {
      service: "alert-receiver",
      target: "/var/lib/operational-alert-receiver",
      readOnly: false,
    },
  ],
});

export class StagingProvisioningError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingProvisioningError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingProvisioningError(code, message);
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PROVISIONING_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactKeys(value, required, field, optional = []) {
  const object = objectAt(value, field);
  const actual = Object.keys(object);
  const approved = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    actual.some((key) => !approved.has(key))
  ) {
    fail(
      "PROVISIONING_SCHEMA_INVALID",
      `${field} must contain only the exact approved fields.`,
    );
  }
  return object;
}

function stringAt(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail("PROVISIONING_SCHEMA_INVALID", `${field} must be a nonempty string.`);
  }
  return value.trim();
}

function booleanAt(value, field) {
  if (typeof value !== "boolean") {
    fail("PROVISIONING_SCHEMA_INVALID", `${field} must be a boolean.`);
  }
  return value;
}

function exactArray(value, expected, field) {
  if (
    !Array.isArray(value) ||
    JSON.stringify([...value].sort()) !== JSON.stringify([...expected].sort())
  ) {
    fail("PROVISIONING_SET_DRIFT", `${field} does not match the required set.`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "_templateStatus")
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function scanForSecrets(value, currentPath = "provisioning") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSecrets(entry, `${currentPath}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      fail(
        "PROVISIONING_SECRET_MATERIAL",
        `${currentPath}.${key} is a forbidden secret field.`,
      );
    }
    if (typeof entry === "string" && SENSITIVE_VALUE.test(entry)) {
      fail(
        "PROVISIONING_SECRET_MATERIAL",
        `${currentPath}.${key} contains recognizable secret material.`,
      );
    }
    if (typeof entry === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      try {
        const url = new URL(entry);
        if (url.username || url.password) {
          fail(
            "PROVISIONING_SECRET_MATERIAL",
            `${currentPath}.${key} contains URL credentials.`,
          );
        }
      } catch (error) {
        if (error instanceof StagingProvisioningError) throw error;
      }
    }
    scanForSecrets(entry, `${currentPath}.${key}`);
  }
}

function publicOrigin(raw, field) {
  let url;
  try {
    url = new URL(stringAt(raw, field));
  } catch {
    fail("PUBLIC_HOST_UNSAFE", `${field} must be an absolute URL.`);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port ||
    !host.includes(".") ||
    host === "modvoltapp.cz" ||
    host.endsWith(".modvoltapp.cz") ||
    /(^|\.)(localhost|local|internal|invalid|test)$/.test(host) ||
    /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(
      host,
    )
  ) {
    fail(
      "PUBLIC_HOST_UNSAFE",
      `${field} is not an isolated public HTTPS origin.`,
    );
  }
  return url.origin;
}

function intersects(left, right) {
  const set = new Set(right.map((entry) => String(entry).toLowerCase()));
  return left.some((entry) => set.has(String(entry).toLowerCase()));
}

export function validateStagingProvisioning(manifest, options = {}) {
  scanForSecrets(manifest);
  const root = exactKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "validationMode",
      "productionTargetsTouched",
      "coolify",
      "forbiddenProductionTargets",
      "publicRoutes",
      "privateServices",
      "hostPortBindings",
      "network",
      "volumes",
      "s3",
      "mail",
      "limits",
    ],
    "manifest",
    ["_templateStatus"],
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "site-logbook-coolify-staging"
  ) {
    fail("PROVISIONING_SCHEMA_INVALID", "schemaVersion/kind is unsupported.");
  }
  const mode = stringAt(root.validationMode, "validationMode");
  if (!["plan", "observed"].includes(mode)) {
    fail(
      "PROVISIONING_SCHEMA_INVALID",
      "validationMode must be plan or observed.",
    );
  }
  if (booleanAt(root.productionTargetsTouched, "productionTargetsTouched")) {
    fail("PRODUCTION_TOUCH_TRUE", "Production targets must remain untouched.");
  }

  const coolify = exactKeys(
    root.coolify,
    [
      "serverId",
      "projectId",
      "environmentId",
      "resourceId",
      "environmentName",
      "resourceName",
      "composeProjectName",
      "source",
      "settings",
    ],
    "coolify",
  );
  const source = exactKeys(
    coolify.source,
    ["repository", "exactCommitSha", "composeFile"],
    "coolify.source",
  );
  const settings = exactKeys(
    coolify.settings,
    [
      "createdFromProductionClone",
      "autoDeploy",
      "previewDeployments",
      "rawComposeDeployment",
      "connectToPredefinedNetwork",
      "forceHttps",
    ],
    "coolify.settings",
  );
  const composeProjectName = stringAt(
    coolify.composeProjectName,
    "coolify.composeProjectName",
  );
  if (!PROJECT.test(composeProjectName)) {
    fail(
      "COOLIFY_TARGET_ID_MISSING",
      "Compose project is outside the staging namespace.",
    );
  }
  if (
    coolify.environmentName !== "staging" ||
    coolify.resourceName !== "Modvolt staging" ||
    source.repository !== "modvolt/Site-Logbook" ||
    source.composeFile !== "/docker-compose.staging.yml" ||
    !SHA40.test(source.exactCommitSha) ||
    /^0{40}$/.test(source.exactCommitSha)
  ) {
    fail(
      "COOLIFY_TARGET_ID_MISSING",
      "Coolify source identity is incomplete or unsafe.",
    );
  }
  if (
    options.expectedSourceSha &&
    source.exactCommitSha !== options.expectedSourceSha
  ) {
    fail(
      "COOLIFY_SOURCE_MISMATCH",
      "Coolify exact commit does not match the approved SHA.",
    );
  }
  for (const key of [
    "createdFromProductionClone",
    "autoDeploy",
    "previewDeployments",
    "rawComposeDeployment",
    "connectToPredefinedNetwork",
  ]) {
    if (settings[key] !== false)
      fail("COOLIFY_SETTING_UNSAFE", `${key} must be false.`);
  }
  if (settings.forceHttps !== true)
    fail("COOLIFY_SETTING_UNSAFE", "forceHttps must be true.");

  const forbidden = exactKeys(
    root.forbiddenProductionTargets,
    [
      "resourceIds",
      "environmentIds",
      "networkIds",
      "volumeNames",
      "s3Buckets",
      "names",
      "hosts",
    ],
    "forbiddenProductionTargets",
  );
  for (const key of [
    "resourceIds",
    "environmentIds",
    "networkIds",
    "volumeNames",
    "s3Buckets",
  ]) {
    if (!Array.isArray(forbidden[key]) || forbidden[key].length === 0) {
      fail(
        "PRODUCTION_TARGET_REUSE",
        `forbiddenProductionTargets.${key} must record observed production targets.`,
      );
    }
    if (forbidden[key].some((value) => PLACEHOLDER.test(String(value)))) {
      fail(
        "PRODUCTION_TARGET_REUSE",
        `forbiddenProductionTargets.${key} still contains a placeholder.`,
      );
    }
  }
  exactArray(
    forbidden.names,
    ["Modvolt", "production"],
    "forbiddenProductionTargets.names",
  );
  exactArray(
    forbidden.hosts,
    ["modvoltapp.cz", "www.modvoltapp.cz"],
    "forbiddenProductionTargets.hosts",
  );

  const identityFields = [
    "serverId",
    "projectId",
    "environmentId",
    "resourceId",
  ];
  for (const key of identityFields) {
    const value =
      mode === "observed"
        ? stringAt(coolify[key], `coolify.${key}`)
        : coolify[key];
    if (mode === "observed" && PLACEHOLDER.test(value)) {
      fail(
        "COOLIFY_TARGET_ID_MISSING",
        `coolify.${key} still contains a placeholder.`,
      );
    }
    if (
      value &&
      intersects([value], forbidden[`${key.replace(/Id$/, "")}Ids`] ?? [])
    ) {
      fail(
        "PRODUCTION_TARGET_REUSE",
        `coolify.${key} reuses a production identifier.`,
      );
    }
  }
  if (
    intersects([coolify.resourceId], forbidden.resourceIds) ||
    intersects([coolify.environmentId], forbidden.environmentIds)
  ) {
    fail(
      "PRODUCTION_TARGET_REUSE",
      "Coolify resource/environment reuses production.",
    );
  }

  if (!Array.isArray(root.publicRoutes) || root.publicRoutes.length !== 2) {
    fail("PUBLIC_ROUTE_SET_DRIFT", "Exactly two public routes are required.");
  }
  const routes = Object.fromEntries(
    root.publicRoutes.map((route) => [route.service, route]),
  );
  if (
    Object.keys(routes).length !== 2 ||
    !routes.web ||
    !routes["alert-receiver"]
  ) {
    fail(
      "PUBLIC_ROUTE_SET_DRIFT",
      "Public routes must be web and alert-receiver only.",
    );
  }
  exactKeys(
    routes.web,
    ["service", "containerPort", "origin"],
    "publicRoutes.web",
  );
  exactKeys(
    routes["alert-receiver"],
    ["service", "containerPort", "origin", "webhookPath"],
    "publicRoutes.alert-receiver",
  );
  const webOrigin = publicOrigin(routes.web.origin, "publicRoutes.web.origin");
  const alertOrigin = publicOrigin(
    routes["alert-receiver"].origin,
    "publicRoutes.alert-receiver.origin",
  );
  if (
    routes.web.containerPort !== 80 ||
    routes["alert-receiver"].containerPort !== 8080 ||
    routes["alert-receiver"].webhookPath !== "/v1/operational-alerts"
  ) {
    fail(
      "PUBLIC_ROUTE_SET_DRIFT",
      "Public route ports/path drifted from Compose.",
    );
  }
  if (webOrigin === alertOrigin)
    fail("PUBLIC_HOST_COLLISION", "Public hosts must be distinct.");
  exactArray(root.privateServices, SAFE_PRIVATE_SERVICES, "privateServices");
  if (
    !Array.isArray(root.hostPortBindings) ||
    root.hostPortBindings.length !== 0
  ) {
    fail("HOST_PORT_FORBIDDEN", "Host port bindings are forbidden.");
  }

  const network = exactKeys(
    root.network,
    [
      "mode",
      "observedNetworkId",
      "connectToPredefinedNetwork",
      "sharedResourceIds",
    ],
    "network",
  );
  if (
    network.mode !== "coolify-per-resource" ||
    network.connectToPredefinedNetwork !== false
  ) {
    fail(
      "NETWORK_NOT_ISOLATED",
      "The resource must use a private per-resource network.",
    );
  }
  if (mode === "observed") {
    const observedNetworkId = stringAt(
      network.observedNetworkId,
      "network.observedNetworkId",
    );
    if (
      PLACEHOLDER.test(observedNetworkId) ||
      intersects([observedNetworkId], forbidden.networkIds) ||
      JSON.stringify(network.sharedResourceIds) !==
        JSON.stringify([coolify.resourceId])
    ) {
      fail(
        "NETWORK_NOT_ISOLATED",
        "Observed network is shared with production or another resource.",
      );
    }
  }

  if (
    !Array.isArray(root.volumes) ||
    root.volumes.length !== Object.keys(EXPECTED_VOLUMES).length
  ) {
    fail("VOLUME_SET_DRIFT", "Persistent volume set does not match Compose.");
  }
  const volumeMap = Object.fromEntries(
    root.volumes.map((volume) => [volume.name, volume]),
  );
  for (const [name, mounts] of Object.entries(EXPECTED_VOLUMES)) {
    const volume = exactKeys(
      volumeMap[name],
      ["name", "platformName", "fingerprint", "reused", "mounts"],
      `volumes.${name}`,
    );
    if (!Array.isArray(volume.mounts)) {
      fail(
        "PROVISIONING_SCHEMA_INVALID",
        `volumes.${name}.mounts must be an array.`,
      );
    }
    for (const [index, mount] of volume.mounts.entries()) {
      exactKeys(
        mount,
        ["service", "target", "readOnly"],
        `volumes.${name}.mounts[${index}]`,
      );
    }
    if (
      volume.reused !== false ||
      JSON.stringify(canonicalValue(volume.mounts)) !==
        JSON.stringify(canonicalValue(mounts)) ||
      intersects([volume.platformName], forbidden.volumeNames)
    ) {
      fail("VOLUME_REUSE", `${name} is reused or has unexpected mounts.`);
    }
    if (mode === "observed") {
      const platformName = stringAt(
        volume.platformName,
        `volumes.${name}.platformName`,
      );
      if (!platformName.toLowerCase().includes(composeProjectName)) {
        fail("VOLUME_REUSE", `${name} is outside the compose namespace.`);
      }
      if (
        PLACEHOLDER.test(platformName) ||
        !DIGEST.test(volume.fingerprint) ||
        /^sha256:0{64}$/.test(volume.fingerprint)
      ) {
        fail("VOLUME_REUSE", `${name} lacks an observed fingerprint.`);
      }
    }
  }

  const s3 = exactKeys(
    root.s3,
    [
      "endpoint",
      "region",
      "bucket",
      "targetFingerprint",
      "accessBoundary",
      "productionBucketAccess",
      "prefixes",
      "forcePathStyle",
    ],
    "s3",
  );
  const s3Origin = publicOrigin(s3.endpoint, "s3.endpoint");
  if (!s3Origin || !/^[a-z0-9-]{1,63}$/.test(s3.region)) {
    fail("S3_NAMESPACE_UNSAFE", "S3 endpoint/region is invalid.");
  }
  if (
    !/^site-logbook-staging(?:-[a-z0-9.-]+)?$/.test(s3.bucket) ||
    PLACEHOLDER.test(s3.bucket) ||
    s3.bucket.length > 63 ||
    s3.accessBoundary !== "staging-bucket-only" ||
    s3.productionBucketAccess !== false ||
    intersects([s3.bucket], forbidden.s3Buckets)
  ) {
    fail("S3_PRODUCTION_ACCESS", "S3 is not bounded to a new staging bucket.");
  }
  exactArray(s3.prefixes, ["private", "public"], "s3.prefixes");
  if (
    mode === "observed" &&
    (!DIGEST.test(s3.targetFingerprint) ||
      /^sha256:0{64}$/.test(s3.targetFingerprint))
  ) {
    fail("S3_NAMESPACE_UNSAFE", "Observed S3 target fingerprint is missing.");
  }

  const mail = exactKeys(
    root.mail,
    [
      "service",
      "publicRoute",
      "relayConfigured",
      "forwardingConfigured",
      "externalSmtpConfigured",
      "deliveryBoundary",
    ],
    "mail",
  );
  if (
    mail.service !== "mailpit" ||
    mail.publicRoute !== false ||
    mail.relayConfigured !== false ||
    mail.forwardingConfigured !== false ||
    mail.externalSmtpConfigured !== false ||
    mail.deliveryBoundary !== "mailpit-only"
  ) {
    fail(
      "MAIL_EGRESS_UNPROVEN",
      "Mail delivery is not proven to terminate in private Mailpit.",
    );
  }

  const limits = exactKeys(
    root.limits,
    ["services", "totalCpu", "totalMemoryMiB", "totalReservationMiB"],
    "limits",
  );
  exactKeys(limits.services, Object.keys(EXPECTED_LIMITS), "limits.services");
  for (const service of Object.keys(EXPECTED_LIMITS)) {
    exactKeys(
      limits.services[service],
      ["cpus", "memoryMiB", "reservationMiB"],
      `limits.services.${service}`,
    );
  }
  if (
    JSON.stringify(canonicalValue(limits.services)) !==
      JSON.stringify(canonicalValue(EXPECTED_LIMITS)) ||
    limits.totalCpu !== 3 ||
    limits.totalMemoryMiB !== 3200 ||
    limits.totalReservationMiB !== 1984
  ) {
    fail(
      "RESOURCE_LIMIT_DRIFT",
      "Resource limits do not match the hardened Compose contract.",
    );
  }

  const manifestSha256 = sha256Canonical(root);
  return Object.freeze({
    decision: mode === "observed" ? "PASS" : "PLAN_ONLY",
    authorizesDeployment: mode === "observed",
    schemaVersion: 1,
    sourceSha: source.exactCommitSha,
    composeProjectName,
    environmentId: coolify.environmentId,
    publicAppUrl: webOrigin,
    alertReceiverUrl: `${alertOrigin}/v1/operational-alerts`,
    alertReceiverHost: new URL(alertOrigin).hostname,
    s3: Object.freeze({
      endpoint: s3.endpoint,
      region: s3.region,
      bucket: s3.bucket,
      forcePathStyle: booleanAt(s3.forcePathStyle, "s3.forcePathStyle"),
    }),
    manifestSha256,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const file = argument("--file");
  if (!file) fail("PROVISIONING_FILE_MISSING", "Pass --file <path>.");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const summary = validateStagingProvisioning(manifest, {
    expectedSourceSha: argument("--expected-source-sha"),
  });
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
