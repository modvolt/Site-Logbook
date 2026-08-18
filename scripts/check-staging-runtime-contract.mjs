import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";

const EXPECTED_BASE_IMAGES = Object.freeze({
  "artifacts/api-server/Dockerfile": [
    "node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
  ],
  "artifacts/stavba/Dockerfile": [
    "node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
    "nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10",
  ],
  "deploy/staging/mailpit/Dockerfile": [
    "axllent/mailpit:v1.30.0@sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d",
    "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
  ],
  "deploy/staging/preflight/Dockerfile": [
    "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
  ],
  "deploy/operational-alert-receiver/Dockerfile": [
    "node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
  ],
});

const EXPECTED_RESOURCES = Object.freeze({
  "staging-preflight": {
    cpus: "0.25",
    memLimit: "128m",
    memReservation: "64m",
  },
  postgres: {
    cpus: "0.50",
    memLimit: "768m",
    memReservation: "512m",
  },
  "external-schema-gate": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
  "accounting-schema-gate": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
  mailpit: {
    cpus: "0.25",
    memLimit: "256m",
    memReservation: "128m",
  },
  api: { cpus: "1.00", memLimit: "1g", memReservation: "768m" },
  "alert-receiver": {
    cpus: "0.25",
    memLimit: "128m",
    memReservation: "64m",
  },
  web: { cpus: "0.25", memLimit: "128m", memReservation: "64m" },
});

const EXPECTED_BASELINE_RESOURCES = Object.freeze({
  "baseline-0104-preflight": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
  "baseline-0104-migrator": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
  "baseline-0104-postflight": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
});

const EXPECTED_RECOVERY_RESOURCES = Object.freeze({
  "exact-0104-recovery-gate": {
    cpus: "0.25",
    memLimit: "384m",
    memReservation: "192m",
  },
});

const EXPECTED_EXACT_0104_BACKUP_RESOURCES = Object.freeze({
  "exact-0104-backup": {
    cpus: "0.50",
    memLimit: "1536m",
    memReservation: "384m",
  },
  "exact-0105-accounting-backup": {
    cpus: "0.50",
    memLimit: "1536m",
    memReservation: "384m",
  },
});

const REQUIRED_IMAGE_VARIABLES = Object.freeze([
  "STAGING_PREFLIGHT_IMAGE",
  "STAGING_MAILPIT_IMAGE",
  "STAGING_API_IMAGE",
  "STAGING_WEB_IMAGE",
  "STAGING_ALERT_RECEIVER_IMAGE",
]);

const PINNED_ACTIONS = Object.freeze([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
  "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
  "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

const PINNED_QUALITY_ACTIONS = Object.freeze([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
]);

const PINNED_SMOKE_ACTIONS = Object.freeze([
  ...PINNED_QUALITY_ACTIONS,
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

const PINNED_PREDECESSOR_ACTIONS = Object.freeze([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
  "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
  "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

export class StagingRuntimeContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingRuntimeContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingRuntimeContractError(code, message);
}

function requireExactPinnedActions(workflow, expected, label) {
  const actual = [
    ...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm),
  ].map((match) => match[1]);
  if (
    actual.length !== expected.length ||
    actual.some((action, index) => action !== expected[index])
  ) {
    fail(
      "STAGING_WORKFLOW_ACTION_DRIFT",
      `${label} must use only the expected Actions pinned to exact reviewed commit SHAs in the required order.`,
    );
  }
}

export function classifyStagingPublicationState(stage, state) {
  if (!/^[01]{5}$/.test(state)) {
    return Object.freeze({ decision: "STOP", reason: "invalid-state" });
  }
  if (stage === "preflight-only" && state === "00000") {
    return Object.freeze({ decision: "PUBLISH_PREFLIGHT" });
  }
  if (stage === "preflight-only" && state === "10000") {
    return Object.freeze({ decision: "VERIFIED_PREFLIGHT_NOOP" });
  }
  if (stage === "complete" && state === "10000") {
    return Object.freeze({ decision: "PUBLISH_REMAINING" });
  }
  if (stage === "complete" && state === "11111") {
    return Object.freeze({ decision: "VERIFIED_COMPLETE_NOOP" });
  }
  return Object.freeze({ decision: "STOP", reason: "partial-or-wrong-stage" });
}

function readSource(relativePath, overrides) {
  if (Object.hasOwn(overrides, relativePath)) {
    return overrides[relativePath];
  }
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function requireText(source, expected, field) {
  if (!source.includes(expected)) {
    fail("STAGING_RUNTIME_CONTRACT_MISSING", `${field} is missing.`);
  }
}

function requirePublicationText(source, expected, code, field) {
  if (!source.includes(expected)) {
    fail(code, `${field} is missing from the staging image publisher.`);
  }
}

function serviceBlock(compose, service) {
  const escapedService = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`^  ${escapedService}:\\r?$`, "m");
  const match = marker.exec(compose);
  if (!match) {
    fail("STAGING_SERVICE_MISSING", `${service} is missing from Compose.`);
  }
  const remainder = compose
    .slice(match.index + match[0].length)
    .replace(/^\r?\n/, "");
  const nextService = remainder.search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
  return nextService < 0 ? remainder : remainder.slice(0, nextService);
}

function requireServiceValue(block, key, value, service) {
  const expected = `    ${key}: ${value}`;
  if (!block.split(/\r?\n/).includes(expected)) {
    fail(
      "STAGING_RESOURCE_LIMIT_DRIFT",
      `${service}.${key} must equal ${value}.`,
    );
  }
}

function validateDockerfile(relativePath, source) {
  requireText(
    source,
    "# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89",
    `${relativePath} pinned Dockerfile frontend`,
  );
  const fromLines = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FROM "));
  if (
    fromLines.length === 0 ||
    fromLines.some(
      (line) => !/@sha256:[0-9a-f]{64}(?:\s+AS\s+[a-zA-Z0-9_-]+)?$/.test(line),
    )
  ) {
    fail(
      "STAGING_BASE_IMAGE_MUTABLE",
      `${relativePath} contains an unpinned FROM image.`,
    );
  }
  for (const expected of EXPECTED_BASE_IMAGES[relativePath]) {
    requireText(source, expected, `${relativePath} expected base image`);
  }
  requireText(
    source,
    "org.opencontainers.image.revision=",
    `${relativePath} revision label`,
  );
  if (relativePath.startsWith("artifacts/")) {
    requireText(
      source,
      "pnpm@11.9.0",
      `${relativePath} repository-aligned pnpm version`,
    );
  }
}

export function validateStagingRuntimeContract(overrides = {}) {
  const compose = readSource("docker-compose.staging.yml", overrides);
  if (/^\s+build\s*:/m.test(compose)) {
    fail(
      "STAGING_HOST_BUILD_FORBIDDEN",
      "docker-compose.staging.yml must not contain build definitions.",
    );
  }
  if (/^\s+(?:ports|networks):\s*$/m.test(compose)) {
    fail(
      "STAGING_NETWORK_BOUNDARY_DRIFT",
      "staging Compose must not publish ports or define networks.",
    );
  }

  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    requireText(
      compose,
      `image: \${${variable}:?set immutable`,
      `${variable} immutable image input`,
    );
    requireText(
      serviceBlock(compose, "staging-preflight"),
      `${variable}: \${${variable}:?set immutable`,
      `preflight ${variable} validation input`,
    );
  }
  requireText(compose, `image: ${POSTGRES_IMAGE}`, "PostgreSQL image digest");

  for (const [service, resources] of Object.entries(EXPECTED_RESOURCES)) {
    const block = serviceBlock(compose, service);
    requireServiceValue(block, "pull_policy", "always", service);
    requireServiceValue(block, "cpus", `"${resources.cpus}"`, service);
    requireServiceValue(block, "mem_limit", resources.memLimit, service);
    requireServiceValue(
      block,
      "mem_reservation",
      resources.memReservation,
      service,
    );
  }
  for (const [service, resources] of Object.entries(
    EXPECTED_BASELINE_RESOURCES,
  )) {
    const block = serviceBlock(compose, service);
    requireServiceValue(block, "pull_policy", "always", service);
    requireServiceValue(block, "cpus", `"${resources.cpus}"`, service);
    requireServiceValue(block, "mem_limit", resources.memLimit, service);
    requireServiceValue(
      block,
      "mem_reservation",
      resources.memReservation,
      service,
    );
    requireText(
      block,
      '    profiles: ["baseline-0104"]',
      `${service} manual-only profile`,
    );
    for (const forbidden of [
      /^ {4}ports:/m,
      /^ {4}expose:/m,
      /^ {4}volumes:/m,
      /^ {4}depends_on:/m,
      /^ {4}build:/m,
    ]) {
      if (forbidden.test(block)) {
        fail(
          "STAGING_BASELINE_SURFACE_WIDENED",
          `${service} must remain a dependency-free one-shot service without ports or mounts.`,
        );
      }
    }
  }
  for (const [service, resources] of Object.entries(
    EXPECTED_RECOVERY_RESOURCES,
  )) {
    const block = serviceBlock(compose, service);
    requireServiceValue(block, "pull_policy", "always", service);
    requireServiceValue(block, "cpus", `"${resources.cpus}"`, service);
    requireServiceValue(block, "mem_limit", resources.memLimit, service);
    requireServiceValue(
      block,
      "mem_reservation",
      resources.memReservation,
      service,
    );
    requireText(
      block,
      '    profiles: ["exact-0104-recovery"]',
      `${service} read-only manual profile`,
    );
    for (const forbidden of [
      /^ {4}ports:/m,
      /^ {4}expose:/m,
      /^ {4}volumes:/m,
      /^ {4}depends_on:/m,
      /^ {4}build:/m,
    ]) {
      if (forbidden.test(block)) {
        fail(
          "STAGING_RECOVERY_SURFACE_WIDENED",
          `${service} must remain dependency-free and have no ports or mounts.`,
        );
      }
    }
  }

  for (const [service, resources] of Object.entries(
    EXPECTED_EXACT_0104_BACKUP_RESOURCES,
  )) {
    const block = serviceBlock(compose, service);
    requireServiceValue(block, "pull_policy", "always", service);
    requireServiceValue(block, "cpus", `"${resources.cpus}"`, service);
    requireServiceValue(block, "mem_limit", resources.memLimit, service);
    requireServiceValue(
      block,
      "mem_reservation",
      resources.memReservation,
      service,
    );
    const exact0105 = service === "exact-0105-accounting-backup";
    for (const boundary of [
      exact0105
        ? '    profiles: ["exact-0105-accounting-backup"]'
        : '    profiles: ["exact-0104-backup"]',
      "    read_only: true",
      "      - no-new-privileges:true",
      "      - /tmp:size=536870912,mode=1777",
      exact0105
        ? "      STAGING_EXACT_0105_BACKUP_ACTION: ${STAGING_EXACT_0105_BACKUP_ACTION-}"
        : "      STAGING_EXACT_0104_BACKUP_ACTION: ${STAGING_EXACT_0104_BACKUP_ACTION-}",
      exact0105
        ? "      STAGING_EXACT_0105_BACKUP_CONFIRMATION: ${STAGING_EXACT_0105_BACKUP_CONFIRMATION-}"
        : "      STAGING_EXACT_0104_BACKUP_CONFIRMATION: ${STAGING_EXACT_0104_BACKUP_CONFIRMATION-}",
      exact0105
        ? "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?keep inspect during exact-0105 backup creation}"
        : "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?keep inspect during exact-0104 backup creation}",
      "      STAGING_COMPOSE_PROJECT_NAME: ${STAGING_COMPOSE_PROJECT_NAME:-site-logbook-staging}",
      "      STAGING_IMAGE_MANIFEST_SHA256: ${STAGING_IMAGE_MANIFEST_SHA256:?set the separately approved image manifest checksum}",
      "      STAGING_PROVISIONING_MANIFEST_SHA256: ${STAGING_PROVISIONING_MANIFEST_SHA256:?set the observed provisioning manifest checksum}",
      "      STAGING_DEPLOYMENT_INPUTS_SHA256: ${STAGING_DEPLOYMENT_INPUTS_SHA256:?set the canonical inspect deployment input checksum}",
      ...(exact0105
        ? [
            "      ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: ${ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION-}",
          ]
        : []),
      '      BACKUP_ENABLED: "true"',
      exact0105
        ? "      - dist/accounting-schema-exact-0105-backup.mjs"
        : "      - dist/external-schema-exact-0104-backup.mjs",
    ]) {
      requireText(block, boundary, `${service} boundary ${boundary}`);
    }
    for (const forbidden of [
      /^ {4}ports:/m,
      /^ {4}expose:/m,
      /^ {4}volumes:/m,
      /^ {4}depends_on:/m,
      /^ {4}build:/m,
    ]) {
      if (forbidden.test(block)) {
        fail(
          "STAGING_EXACT_0104_BACKUP_SURFACE_WIDENED",
          `${service} must remain a dependency-free one-shot service without ports or persistent mounts.`,
        );
      }
    }
  }

  for (const relativePath of Object.keys(EXPECTED_BASE_IMAGES)) {
    validateDockerfile(relativePath, readSource(relativePath, overrides));
  }
  const apiBuild = readSource("artifacts/api-server/build.mjs", overrides);
  requireText(
    apiBuild,
    'path.resolve(artifactDir, "src/external-schema-preflight.ts")',
    "API external schema preflight bundle entrypoint",
  );
  for (const entrypoint of [
    "external-schema-inventory.ts",
    "external-schema-steady-state.ts",
    "external-schema-gate.ts",
    "external-schema-baseline-0104.ts",
    "external-schema-exact-0104-backup.ts",
    "accounting-schema-inventory.ts",
    "accounting-schema-gate.ts",
    "accounting-schema-steady-state.ts",
    "accounting-schema-exact-0105-backup.ts",
  ]) {
    requireText(
      apiBuild,
      `path.resolve(artifactDir, "src/${entrypoint}")`,
      `API ${entrypoint} bundle entrypoint`,
    );
  }
  requireText(
    apiBuild,
    '"src/external-schema-exact-0104-recovery.ts"',
    "API external-schema-exact-0104-recovery.ts bundle entrypoint",
  );
  const schemaGateRunner = readSource(
    "artifacts/api-server/src/external-schema-gate.ts",
    overrides,
  );
  for (const boundary of [
    'if (action === "steady-0105")',
    'if (action !== "apply-0105")',
    'error.code !== "APPLIED_COUNT_MISMATCH"',
    'inventory.decision !== "READY_0104"',
    "dependencies.migrate ?? runMigrations",
    "migration.newlyApplied !== 0 && migration.newlyApplied !== 1",
    'migration.newlyApplied === 1 ? "APPLIED" : "NOOP"',
    '"MIGRATION_APPLY_COUNT_INVALID"',
    'EXTERNAL_SCHEMA_PREFLIGHT_MODE: "post"',
    "runExternalSchemaSteadyState",
    "transitionEvidence(summary, env)",
    "summary.backupEvidence.checkedAt",
  ]) {
    requireText(
      schemaGateRunner,
      boundary,
      `state-aware external schema gate ${boundary}`,
    );
  }
  for (const forbidden of [
    'from "node:child_process"',
    "function runMigrator(",
    "await runMigrator(",
  ]) {
    if (schemaGateRunner.includes(forbidden)) {
      fail(
        "STAGING_RUNTIME_CONTRACT_MISSING",
        `state-aware external schema gate still contains child migrator boundary ${forbidden}`,
      );
    }
  }
  const schemaInventoryRunner = readSource(
    "artifacts/api-server/src/external-schema-inventory.ts",
    overrides,
  );
  requireText(
    schemaInventoryRunner,
    "runExternalSchemaInventory",
    "read-only external schema inventory runner",
  );
  const schemaSteadyStateRunner = readSource(
    "artifacts/api-server/src/external-schema-steady-state.ts",
    overrides,
  );
  requireText(
    schemaSteadyStateRunner,
    "runExternalSchemaSteadyState",
    "external schema steady-state runner",
  );
  const baselineGateRunner = readSource(
    "artifacts/api-server/src/external-schema-baseline-0104.ts",
    overrides,
  );
  for (const boundary of [
    "readStagingBaseline0104Environment",
    "runExternalSchemaInventory",
    "evaluateStagingBaseline0104Decision",
    'baseline.phase === "pre" ? "PRECHECK" : "POSTCHECK"',
    "authorizes0105: false",
  ]) {
    requireText(
      baselineGateRunner,
      boundary,
      `exact-0104 candidate gate ${boundary}`,
    );
  }
  const recoveryGateRunner = readSource(
    "artifacts/api-server/src/external-schema-exact-0104-recovery.ts",
    overrides,
  );
  for (const boundary of [
    "readStagingExact0104RecoveryEnvironment",
    "runExternalSchemaExact0104Recovery",
    "[staging-exact-0104-recovery] PASS ",
    "...result",
  ]) {
    requireText(
      recoveryGateRunner,
      boundary,
      `exact-0104 recovery gate ${boundary}`,
    );
  }
  const recoveryEnvironmentContract = readSource(
    "lib/db/src/staging-exact-0104-recovery.ts",
    overrides,
  );
  for (const boundary of [
    "RECOVERY_SECRET_MATERIAL",
    "scanForSensitiveFields(value, field);",
    "baselineCompletedAt",
  ]) {
    requireText(
      recoveryEnvironmentContract,
      boundary,
      `exact-0104 recovery environment ${boundary}`,
    );
  }
  const receiverDockerfile = readSource(
    "deploy/operational-alert-receiver/Dockerfile",
    overrides,
  );
  requireText(
    receiverDockerfile,
    "RECEIVER_BUILD_SHA=$BUILD_SHA",
    "receiver exact-SHA runtime identity",
  );
  requireText(
    receiverDockerfile,
    "HEALTHCHECK",
    "receiver container healthcheck",
  );
  const receiverBlock = serviceBlock(compose, "alert-receiver");
  for (const boundary of [
    "    read_only: true",
    "      - ALL",
    "      - no-new-privileges:true",
    "      - staging_alert_receipts:/var/lib/operational-alert-receiver",
    "      RECEIVER_BUILD_SHA: ${STAGING_BUILD_SHA:?set the exact 40-character deployed commit SHA}",
    "      RECEIVER_BEARER_TOKEN: ${STAGING_OPERATIONAL_ALERT_BEARER_TOKEN:?set a staging-only operational alert bearer token}",
    "      DEAD_MAN_TARGET_URL: ${STAGING_PUBLIC_APP_URL:?set STAGING_PUBLIC_APP_URL}/api/healthz",
  ]) {
    requireText(receiverBlock, boundary, `alert receiver boundary ${boundary}`);
  }
  const apiBlock = serviceBlock(compose, "api");
  for (const boundary of [
    "      API_TRUSTED_PROXY_CIDRS: ${STAGING_API_TRUSTED_PROXY_CIDRS:?set exact staging nginx/edge proxy CIDRs}",
    "      EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    "      OPERATIONAL_ALERT_TRANSPORT: https_webhook",
    "      OPERATIONAL_ALERT_WEBHOOK_URL: ${STAGING_OPERATIONAL_ALERT_RECEIVER_URL:?set the public staging alert receiver HTTPS URL}",
    "      OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS: ${STAGING_OPERATIONAL_ALERT_RECEIVER_HOST:?set the exact staging alert receiver hostname}",
    "      OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN: ${STAGING_OPERATIONAL_ALERT_BEARER_TOKEN:?set a staging-only operational alert bearer token}",
  ]) {
    requireText(apiBlock, boundary, `API alert transport boundary ${boundary}`);
  }
  const schemaGateBlock = serviceBlock(compose, "external-schema-gate");
  for (const boundary of [
    "    read_only: true",
    "      - ALL",
    "      - no-new-privileges:true",
    "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?set inspect, apply-0105 or steady-0105}",
    "      EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: ${STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION-}",
    "      STAGING_IMAGE_MANIFEST_SOURCE_SHA: ${STAGING_IMAGE_MANIFEST_SOURCE_SHA:?set sourceSha from the approved immutable image manifest}",
    "      STAGING_DEPLOYMENT_INPUTS_SHA256: ${STAGING_DEPLOYMENT_INPUTS_SHA256:?set the canonical secret-free deployment input checksum}",
    "      EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    "      STAGING_DATABASE_HOST: postgres",
    "      STAGING_DATABASE_NAME: site_logbook_staging",
    "      STAGING_DATABASE_USER: site_logbook_staging",
    "      STAGING_BACKUP_EVIDENCE_ID: ${STAGING_BACKUP_EVIDENCE_ID-}",
    "      STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: ${STAGING_BACKUP_RESTORE_MAX_AGE_HOURS-}",
    "      - dist/external-schema-gate.mjs",
    "      disable: true",
  ]) {
    requireText(
      schemaGateBlock,
      boundary,
      `external schema gate boundary ${boundary}`,
    );
  }
  const accountingSchemaGateBlock = serviceBlock(
    compose,
    "accounting-schema-gate",
  );
  for (const boundary of [
    "    read_only: true",
    "      - ALL",
    "      - no-new-privileges:true",
    "      STAGING_ACCOUNTING_SCHEMA_ACTION: ${STAGING_ACCOUNTING_SCHEMA_ACTION:?set steady-0106 after the separately approved transition}",
    "      ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: ${ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION-}",
    "      STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256: ${STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256:?set the canonical accounting transition input checksum}",
    "      STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256: ${STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256:?set the exact-0105 backup execution checksum}",
    "      STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES: ${STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES:?set 268435456}",
    "      STAGING_EXACT_0105_BACKUP_SIZE_BYTES: ${STAGING_EXACT_0105_BACKUP_SIZE_BYTES:?set the reviewed encrypted backup size}",
    "      STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: ${STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION-}",
    "      - dist/accounting-schema-gate.mjs",
    "      disable: true",
  ]) {
    requireText(
      accountingSchemaGateBlock,
      boundary,
      `accounting schema gate boundary ${boundary}`,
    );
  }
  const recoveryGateBlock = serviceBlock(compose, "exact-0104-recovery-gate");
  for (const boundary of [
    "    image: ${STAGING_API_IMAGE:?set immutable API image repository@sha256:<64 hex digest>}",
    '    restart: "no"',
    "    read_only: true",
    "      - ALL",
    "      - no-new-privileges:true",
    "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?keep inspect during exact-0104 recovery evidence}",
    "      STAGING_EXACT_0104_RECOVERY_INPUTS_B64: ${STAGING_EXACT_0104_RECOVERY_INPUTS_B64-}",
    "      STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256: ${STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256-}",
    "      STAGING_BASELINE_0104_EXECUTION_B64: ${STAGING_BASELINE_0104_EXECUTION_B64-}",
    "      STAGING_BASELINE_0104_EXECUTION_SHA256: ${STAGING_BASELINE_0104_EXECUTION_SHA256-}",
    "      STAGING_EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    "      EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    "      - dist/external-schema-exact-0104-recovery.mjs",
    "      disable: true",
  ]) {
    requireText(
      recoveryGateBlock,
      boundary,
      `exact-0104 recovery service boundary ${boundary}`,
    );
  }
  if (/^ {6}BUILD_SHA:/m.test(recoveryGateBlock)) {
    fail(
      "STAGING_RECOVERY_BUILD_SHA_OVERRIDE_FORBIDDEN",
      "The recovery gate must keep the candidate image's baked BUILD_SHA.",
    );
  }
  const baselinePreflightBlock = serviceBlock(
    compose,
    "baseline-0104-preflight",
  );
  const baselineMigratorBlock = serviceBlock(compose, "baseline-0104-migrator");
  const baselinePostflightBlock = serviceBlock(
    compose,
    "baseline-0104-postflight",
  );
  for (const [block, phase] of [
    [baselinePreflightBlock, "pre"],
    [baselinePostflightBlock, "post"],
  ]) {
    for (const boundary of [
      "    image: ${STAGING_API_IMAGE:?set immutable API image repository@sha256:<64 hex digest>}",
      '    restart: "no"',
      "    read_only: true",
      "      - ALL",
      "      - no-new-privileges:true",
      "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?keep inspect during the 0104 baseline}",
      "      STAGING_BASELINE_0104_ACTION: ${STAGING_BASELINE_0104_ACTION-}",
      "      STAGING_BASELINE_0104_CONFIRMATION: ${STAGING_BASELINE_0104_CONFIRMATION-}",
      `      STAGING_BASELINE_0104_PHASE: ${phase}`,
      "      STAGING_BASELINE_0104_INPUTS_B64: ${STAGING_BASELINE_0104_INPUTS_B64-}",
      "      STAGING_BASELINE_0104_INPUTS_SHA256: ${STAGING_BASELINE_0104_INPUTS_SHA256-}",
      "      STAGING_PREDECESSOR_0104_MANIFEST_B64: ${STAGING_PREDECESSOR_0104_MANIFEST_B64-}",
      "      STAGING_PREDECESSOR_0104_MANIFEST_SHA256: ${STAGING_PREDECESSOR_0104_MANIFEST_SHA256-}",
      "      STAGING_PREDECESSOR_0104_API_IMAGE: ${STAGING_PREDECESSOR_0104_API_IMAGE-}",
      "      STAGING_EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
      "      EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
      "      - dist/external-schema-baseline-0104.mjs",
      "      disable: true",
    ]) {
      requireText(
        block,
        boundary,
        `baseline ${phase}flight boundary ${boundary}`,
      );
    }
    if (/^ {6}BUILD_SHA:/m.test(block)) {
      fail(
        "STAGING_BASELINE_BUILD_SHA_OVERRIDE_FORBIDDEN",
        `Baseline ${phase}flight must keep the candidate image's baked BUILD_SHA.`,
      );
    }
  }
  for (const boundary of [
    "    image: ${STAGING_PREDECESSOR_0104_API_IMAGE:-ghcr.io/modvolt/site-logbook-staging-api@sha256:0000000000000000000000000000000000000000000000000000000000000000}",
    '    restart: "no"',
    "    read_only: true",
    "      - ALL",
    "      - no-new-privileges:true",
    '        [ "$$STAGING_BASELINE_0104_ACTION" = "apply-0104-baseline" ]',
    '        [ "$$STAGING_BASELINE_0104_CONFIRMATION" = "APPLY_FIXED_PREDECESSOR_0104_TO_ISOLATED_SITE_LOGBOOK_STAGING" ]',
    '        [ "$$STAGING_PREDECESSOR_0104_SOURCE_SHA" = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3" ]',
    '        [ "$$BUILD_SHA" = "$$STAGING_PREDECESSOR_0104_SOURCE_SHA" ]',
    "        exec node dist/migrate.mjs",
    "      disable: true",
  ]) {
    requireText(
      baselineMigratorBlock,
      boundary,
      `fixed predecessor migrator boundary ${boundary}`,
    );
  }
  for (const boundary of [
    "      external-schema-gate:",
    "      accounting-schema-gate:",
    "        condition: service_completed_successfully",
    "      STAGING_IMAGE_MANIFEST_SOURCE_SHA: ${STAGING_IMAGE_MANIFEST_SOURCE_SHA:?set sourceSha from the approved immutable image manifest}",
    "        node dist/external-schema-steady-state.mjs &&",
    "        exec node --enable-source-maps dist/index.mjs",
  ]) {
    requireText(apiBlock, boundary, `API postflight boundary ${boundary}`);
  }
  if (/^ {6}BUILD_SHA:/m.test(apiBlock)) {
    fail(
      "STAGING_API_BUILD_SHA_OVERRIDE_FORBIDDEN",
      "The API must keep the immutable image's baked BUILD_SHA.",
    );
  }
  for (const forbidden of [
    "EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION:",
    "STAGING_BACKUP_EVIDENCE_ID:",
    "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS:",
  ]) {
    if (apiBlock.includes(forbidden)) {
      fail(
        "STAGING_API_TRANSITION_EVIDENCE_COUPLED",
        `Routine API startup must not retain ${forbidden}`,
      );
    }
  }

  const exampleEnv = readSource(".env.staging.example", overrides);
  requireText(
    exampleEnv,
    "STAGING_API_TRUSTED_PROXY_CIDRS=",
    "staging trusted proxy input",
  );
  if (!/^STAGING_EXTERNAL_ACCOUNTS_ENABLED=false$/m.test(exampleEnv)) {
    fail(
      "STAGING_EXTERNAL_ACCOUNTS_DARK_ROLLOUT_BROKEN",
      "STAGING_EXTERNAL_ACCOUNTS_ENABLED must be explicitly false in .env.staging.example.",
    );
  }
  for (const input of [
    "STAGING_SCHEMA_ACTION=inspect",
    "STAGING_IMAGE_MANIFEST_SOURCE_SHA=",
    "STAGING_IMAGE_MANIFEST_B64=",
    "STAGING_IMAGE_MANIFEST_SHA256=",
    "STAGING_PROVISIONING_MANIFEST_SHA256=",
    "STAGING_DEPLOYMENT_INPUTS_SHA256=",
    "STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION=",
    "STAGING_BACKUP_EVIDENCE_ID=",
    "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS=24",
    "STAGING_BASELINE_0104_ACTION=",
    "STAGING_BASELINE_0104_CONFIRMATION=",
    "STAGING_BASELINE_0104_INPUTS_B64=",
    "STAGING_BASELINE_0104_INPUTS_SHA256=",
    "STAGING_PREDECESSOR_0104_MANIFEST_B64=",
    "STAGING_PREDECESSOR_0104_MANIFEST_SHA256=",
    "STAGING_PREDECESSOR_0104_API_IMAGE=",
    "STAGING_PREDECESSOR_0104_SOURCE_SHA=",
    "STAGING_EXACT_0104_BACKUP_ACTION=",
    "STAGING_EXACT_0104_BACKUP_CONFIRMATION=",
    "STAGING_EXACT_0104_RECOVERY_INPUTS_B64=",
    "STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256=",
    "STAGING_BASELINE_0104_EXECUTION_B64=",
    "STAGING_BASELINE_0104_EXECUTION_SHA256=",
  ]) {
    requireText(exampleEnv, input, `external schema staging input ${input}`);
  }
  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    if (!new RegExp(`^${variable}=$`, "m").test(exampleEnv)) {
      fail(
        "STAGING_IMAGE_INPUT_MISSING",
        `${variable} must be an empty input in .env.staging.example.`,
      );
    }
  }

  const preflight = readSource(
    "deploy/staging/preflight/preflight.sh",
    overrides,
  );
  const preflightBlock = serviceBlock(compose, "staging-preflight");
  requireText(
    preflightBlock,
    "      STAGING_EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    "staging preflight external-account flag input",
  );
  for (const boundary of [
    "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?set inspect, apply-0105 or steady-0105}",
    "      STAGING_IMAGE_MANIFEST_SOURCE_SHA: ${STAGING_IMAGE_MANIFEST_SOURCE_SHA:?set sourceSha from the approved immutable image manifest}",
    "      STAGING_IMAGE_MANIFEST_B64: ${STAGING_IMAGE_MANIFEST_B64:?set the exact validated staging-images.json as base64}",
    "      STAGING_IMAGE_MANIFEST_SHA256: ${STAGING_IMAGE_MANIFEST_SHA256:?set the separately approved image manifest checksum}",
    "      STAGING_PROVISIONING_MANIFEST_SHA256: ${STAGING_PROVISIONING_MANIFEST_SHA256:?set the observed provisioning manifest checksum}",
    "      STAGING_DEPLOYMENT_INPUTS_SHA256: ${STAGING_DEPLOYMENT_INPUTS_SHA256:?set the canonical secret-free deployment input checksum}",
    "      STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: ${STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION-}",
    "      STAGING_BACKUP_EVIDENCE_ID: ${STAGING_BACKUP_EVIDENCE_ID-}",
    "      STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: ${STAGING_BACKUP_RESTORE_MAX_AGE_HOURS-}",
  ]) {
    requireText(
      preflightBlock,
      boundary,
      `staging preflight input ${boundary}`,
    );
  }
  requireText(
    preflight,
    '[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "false" ]',
    "staging preflight external-account dark-rollout guard",
  );
  for (const boundary of [
    '[ "$STAGING_IMAGE_MANIFEST_SOURCE_SHA" = "$STAGING_BUILD_SHA" ]',
    "printf '%s' \"$STAGING_IMAGE_MANIFEST_B64\" | base64 -d",
    '[ "$manifest_sha256" = "$STAGING_IMAGE_MANIFEST_SHA256" ]',
    "registry_ledger=$(jq -cS '.registryLedger' \"$manifest_file\")",
    "embedded registry ledger does not match its canonical checksum",
    '.callerRepository == "modvolt/site-logbook-registry"',
    '.platform == "linux/amd64"',
    ".schemaVersion == 3",
    '.kind == "site-logbook-staging-images"',
    '.registryLedger.stage == "complete"',
    ".activeInventoryPaginated == true",
    '.deletedInventoryMode == "not-queryable-exact-read-scope"',
    '.runtimeMetadata == {source: "https://github.com/modvolt/Site-Logbook"',
    '.provenance.buildType == "https://mobyproject.org/buildkit@v1"',
    ".sbom.packageCount > 0",
    "deployment_inputs_sha256=$(printf '%s\\n' \"$deployment_inputs\" | sha256sum",
    '[ "$deployment_inputs_sha256" = "$STAGING_DEPLOYMENT_INPUTS_SHA256" ]',
    'case "$STAGING_SCHEMA_ACTION" in',
    "  inspect)",
    "  apply-0105)",
    "  steady-0105)",
    "inspect mode forbids a mutation confirmation",
    '[ "$STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION" = "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING" ]',
    "steady mode must not depend on historical transition backup evidence",
    'case "$STAGING_BACKUP_EVIDENCE_ID" in',
    '"$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" -le 168',
  ]) {
    requireText(
      preflight,
      boundary,
      `staging preflight fail-closed guard ${boundary}`,
    );
  }
  requireText(
    preflight,
    ". /usr/local/lib/staging-proxy-cidrs.sh",
    "staging trusted proxy preflight",
  );
  const proxyPreflight = readSource(
    "deploy/staging/preflight/validate-proxy-cidrs.sh",
    overrides,
  );
  requireText(
    proxyPreflight,
    "trusted proxy address is invalid or has a leading zero",
    "staging trusted proxy canonical IPv4 preflight",
  );
  for (const variable of REQUIRED_IMAGE_VARIABLES) {
    requireText(
      preflight,
      `validate_immutable_image "$${variable}" ${variable}`,
      `runtime validation for ${variable}`,
    );
  }

  const publishWorkflow = readSource(
    ".github/workflows/staging-images.yml",
    overrides,
  );
  const validatePublicSourceJob = publishWorkflow.match(
    /^ {2}validate-public-source:\r?\n[\s\S]*?(?=^ {2}publish-staging-images:)/m,
  )?.[0];
  const publishStagingImagesJob = publishWorkflow.match(
    /^ {2}publish-staging-images:\r?\n[\s\S]*$/m,
  )?.[0];
  if (!validatePublicSourceJob || !publishStagingImagesJob) {
    fail(
      "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
      "the candidate publisher jobs could not be isolated for validation.",
    );
  }
  for (const [dockerfile, buildIdentity, expectedCount] of [
    ["deploy/staging/preflight/Dockerfile", "ENV BUILD_SHA=$BUILD_SHA", 1],
    ["deploy/staging/mailpit/Dockerfile", "ENV BUILD_SHA=$BUILD_SHA", 1],
    ["artifacts/stavba/Dockerfile", "ENV VITE_BUILD_SHA=$VITE_BUILD_SHA", 2],
  ]) {
    const dockerfileSource = readSource(dockerfile, overrides);
    if (dockerfileSource.split(buildIdentity).length - 1 !== expectedCount) {
      fail(
        "STAGING_RUNTIME_CONTRACT_MISSING",
        `immutable candidate runtime identity ${dockerfile} is missing or duplicated.`,
      );
    }
  }
  if (/\bworkflow_dispatch\s*:/.test(publishWorkflow)) {
    fail(
      "STAGING_IMAGE_PUBLIC_DIRECT_DISPATCH",
      "the public source repository must not expose a direct image publisher.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "workflow_call:",
    "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
    "private-caller reusable workflow trigger",
  );
  for (const input of [
    "source_sha:",
    "source_ref:",
    "source_pr_number:",
    "publication_stage:",
    "expected_preflight_digest:",
    "confirm_registry_publication:",
    "registry_history_acceptance:",
    "registry_ledger_json:",
  ]) {
    requirePublicationText(
      publishWorkflow,
      input,
      "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
      `required workflow_call input ${input}`,
    );
  }
  for (const credentialBoundary of [
    "    secrets:\n      packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: true",
    "packages_metadata_token:",
    "Dedicated classic PAT with exactly read:packages",
    "Require dedicated read-only Packages metadata credential",
    "GH_TOKEN: ${{ secrets.packages_metadata_token }}",
    "REGISTRY_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    '[[ "$GH_TOKEN" != "$REGISTRY_GITHUB_TOKEN" ]]',
    "gh api --include",
    "normalized_scopes",
    '[[ "$normalized_scopes" == "read:packages" ]]',
    '.login == "modvolt"',
    ".id == 289280891",
    '.type == "User"',
    "CALLER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "CALLER_WORKFLOW_SHA: ${{ github.workflow_sha }}",
    'GH_TOKEN="$CALLER_GITHUB_TOKEN" gh api',
    '"repos/${CALLER_REPOSITORY}/git/ref/heads/main"',
    '.default_branch == "main"',
    ".object.sha == $workflowSha",
  ]) {
    requirePublicationText(
      publishWorkflow,
      credentialBoundary,
      "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
      `dedicated Packages metadata credential boundary ${credentialBoundary}`,
    );
  }
  if (
    (
      publishWorkflow.match(
        /CALLER_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/g,
      ) ?? []
    ).length !== 4
  ) {
    fail(
      "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
      "every caller ledger, metadata and evidence boundary must bind the exact caller workflow SHA.",
    );
  }
  if (
    (
      publishStagingImagesJob.match(
        /GH_TOKEN="\$CALLER_GITHUB_TOKEN" gh api/g,
      ) ?? []
    ).length !== 4
  ) {
    fail(
      "STAGING_IMAGE_METADATA_CREDENTIAL_GUARD_MISSING",
      "the package-write job must use the caller token exactly for repository metadata and the live private main ref.",
    );
  }
  if (
    (
      publishWorkflow.match(
        /^\s+GH_TOKEN: \$\{\{ secrets\.packages_metadata_token \}\}$/gm,
      ) ?? []
    ).length !== 13 ||
    /^\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m.test(publishWorkflow) ||
    (publishWorkflow.match(/\$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? [])
      .length !== 4 ||
    (
      publishWorkflow.match(/\$\{\{ secrets\.packages_metadata_token \}\}/g) ??
      []
    ).length !== 13
  ) {
    fail(
      "STAGING_IMAGE_METADATA_CREDENTIAL_BOUNDARY_BROKEN",
      "all Packages REST reads must use the named read-only credential while GITHUB_TOKEN remains isolated to caller metadata and registry login.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "permissions: {}\n\nconcurrency:",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "deny-by-default workflow permissions",
  );
  requirePublicationText(
    publishWorkflow,
    "group: site-logbook-images-publication",
    "STAGING_IMAGE_CONCURRENCY_GUARD_MISSING",
    "fixed package-namespace concurrency group",
  );
  requirePublicationText(
    publishWorkflow,
    "validate-public-source:\n    permissions: {}",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "token-free public source validation job",
  );
  for (const callerBoundary of [
    "Require exact private manual caller workflow",
    "APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry",
    "APPROVED_CALLER_WORKFLOW_REF: modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
    "CALLER_ACTOR: ${{ github.actor }}",
    "CALLER_EVENT_NAME: ${{ github.event_name }}",
    "CALLER_REF: ${{ github.ref }}",
    "CALLER_REPOSITORY: ${{ github.repository }}",
    "CALLER_TRIGGERING_ACTOR: ${{ github.triggering_actor }}",
    "CALLER_WORKFLOW_REF: ${{ github.workflow_ref }}",
    '[[ "${CALLER_REPOSITORY,,}" == "$APPROVED_CALLER_REPOSITORY" ]]',
    '[[ "$CALLER_EVENT_NAME" == "workflow_dispatch" ]]',
    '[[ "$CALLER_REF" == "refs/heads/main" ]]',
    '[[ "${CALLER_ACTOR,,}" == "modvolt" ]]',
    '[[ "${CALLER_TRIGGERING_ACTOR,,}" == "modvolt" ]]',
    '[[ "${CALLER_WORKFLOW_REF,,}" == "$APPROVED_CALLER_WORKFLOW_REF" ]]',
  ]) {
    requirePublicationText(
      validatePublicSourceJob,
      callerBoundary,
      "STAGING_IMAGE_CALLER_IDENTITY_GUARD_MISSING",
      `exact private caller boundary ${callerBoundary}`,
    );
  }
  requirePublicationText(
    publishStagingImagesJob,
    "APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "package-write job approved private caller repository",
  );
  requirePublicationText(
    publishWorkflow,
    "publish-staging-images:\n    needs: validate-public-source\n    permissions:\n      actions: read\n      contents: read\n      packages: write",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "isolated package publication permission",
  );
  if ((publishWorkflow.match(/packages: write/g) ?? []).length !== 1) {
    fail(
      "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
      "only the package publication job may receive packages: write.",
    );
  }
  if ((publishWorkflow.match(/actions: read/g) ?? []).length !== 1) {
    fail(
      "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
      "only the package publication job may read private caller Actions history.",
    );
  }
  for (const inputBoundary of [
    "registry_history_acceptance:\n        description: Exact reviewed acceptance of the external-ledger residual limitation\n        required: true\n        type: string",
    "registry_ledger_json:\n        description: Canonical stage-specific external-ledger entry hard-coded by the reviewed private caller\n        required: true\n        type: string",
  ]) {
    requirePublicationText(
      publishWorkflow,
      inputBoundary,
      "STAGING_IMAGE_REGISTRY_LEDGER_GUARD_MISSING",
      `reviewed visible-history registry ledger input ${inputBoundary}`,
    );
  }
  for (const ledgerBoundary of [
    "Require canonical reviewed visible-history registry ledger",
    "ACCEPT_EXTERNAL_LEDGER_RESIDUAL_WITHOUT_DELETED_HISTORY_PROOF_NO_DEPLOY",
    'canonical_ledger="$(jq -cS . <<<"$REGISTRY_LEDGER_JSON")"',
    '[[ "$canonical_ledger" == "$REGISTRY_LEDGER_JSON" ]]',
    '.kind == "site-logbook-staging-registry-ledger-entry"',
    'decision: "explicitly-accepted-external-ledger"',
    "historicalAbsenceProven: false",
    '[[ "$GITHUB_RUN_ATTEMPT_VALUE" == "1" ]]',
    "actions/runs/${GITHUB_RUN_ID_VALUE}",
    "actions/workflows/publish-staging-images.yml/runs?event=workflow_dispatch&per_page=100",
    "totalCounts",
    ".[0] < 1000",
    "the reviewed private caller commit has an ambiguous or non-unique visible dispatch history",
    "staging-registry-ledger-entry.json",
    "ledger_sha256=",
    "registryLedger: $registryLedger[0]",
    'sha256sum "${RUNNER_TEMP}/staging-registry-ledger-entry.json"',
    '[[ "$state" == "$expected_initial_state" ]]',
    "ledger_preflight_digest",
  ]) {
    requirePublicationText(
      publishStagingImagesJob,
      ledgerBoundary,
      "STAGING_IMAGE_REGISTRY_LEDGER_GUARD_MISSING",
      `reviewed visible-history registry ledger boundary ${ledgerBoundary}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "SOURCE_REPOSITORY: modvolt/Site-Logbook",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "fixed public source repository",
  );
  requirePublicationText(
    publishWorkflow,
    "APPROVED_SOURCE_REF: agent/phase16c3-staging-preflight",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "approved candidate ref",
  );
  requirePublicationText(
    publishWorkflow,
    "public_source_api()",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "unauthenticated public source API helper",
  );
  const publicHelper = publishWorkflow.match(
    /^ {10}public_source_api\(\) \{\r?\n([\s\S]*?)^ {10}\}/m,
  )?.[1];
  if (!publicHelper) {
    fail(
      "STAGING_IMAGE_SOURCE_GUARD_MISSING",
      "the public source API helper could not be isolated for validation.",
    );
  }
  for (const forbidden of [
    "Authorization",
    "GH_TOKEN",
    "github.token",
    "secrets.GITHUB_TOKEN",
    "gh api",
  ]) {
    if (publicHelper.includes(forbidden)) {
      fail(
        "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
        `the public source API helper must not contain ${forbidden}.`,
      );
    }
  }
  for (const transportGuard of [
    "curl --disable",
    "--proto '=https'",
    "--connect-timeout 10 --max-time 30",
  ]) {
    if (!publicHelper.includes(transportGuard)) {
      fail(
        "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
        `the public source API helper is missing ${transportGuard}.`,
      );
    }
  }
  requirePublicationText(
    publishWorkflow,
    "https://api.github.com/repos/${SOURCE_REPOSITORY}/git/ref/heads/${SOURCE_REF}",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "candidate branch head lookup",
  );
  requirePublicationText(
    publishWorkflow,
    ".head.sha == $sha",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact PR head SHA check",
  );
  requirePublicationText(
    publishWorkflow,
    "repository: modvolt/Site-Logbook",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact public source checkout repository",
  );
  requirePublicationText(
    publishWorkflow,
    "ref: ${{ inputs.source_sha }}",
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
    "exact public source checkout SHA",
  );
  requirePublicationText(
    publishWorkflow,
    "actions/workflows/quality-gate.yml/runs?head_sha=${SOURCE_SHA}&event=pull_request&per_page=100",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "exact-SHA pull-request Quality gate lookup",
  );
  if (
    /gh api\s+[\s\S]{0,120}repos\/\$\{SOURCE_REPOSITORY\}\//.test(
      publishWorkflow,
    )
  ) {
    fail(
      "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
      "public source metadata must not use the caller-scoped GitHub token.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '.status == "completed" and .conclusion == "success"',
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "successful Quality gate conclusion",
  );
  requirePublicationText(
    publishWorkflow,
    "sort_by([.run_number, .run_attempt]) |\n             last |",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "latest exact-SHA Quality gate selection",
  );
  requirePublicationText(
    publishWorkflow,
    ".head_sha == $sha",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate head SHA coupling",
  );
  requirePublicationText(
    publishWorkflow,
    "any(.pull_requests[]?; .number == $pr)",
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate source PR coupling",
  );
  requirePublicationText(
    publishWorkflow,
    '--argjson pr "$SOURCE_PR_NUMBER"',
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
    "Quality gate source PR argument binding",
  );
  requirePublicationText(
    publishWorkflow,
    "APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "exact private caller repository",
  );
  requirePublicationText(
    publishWorkflow,
    '[[ "${CALLER_REPOSITORY,,}" == "$APPROVED_CALLER_REPOSITORY" ]]',
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "exact private caller identity check",
  );
  requirePublicationText(
    publishWorkflow,
    ".private == true",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "private caller repository check",
  );
  requirePublicationText(
    publishWorkflow,
    '.visibility == "private"',
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "GHCR package visibility check",
  );
  requirePublicationText(
    publishWorkflow,
    "'/user/packages?package_type=container&visibility=private&per_page=100'",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "identity-bound private package inventory",
  );
  requirePublicationText(
    publishWorkflow,
    "/user/packages/container/${package_name}",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "identity-bound private package metadata lookup",
  );
  requirePublicationText(
    publishWorkflow,
    "/user/packages/container/${package_name}/versions?state=active&per_page=100",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "identity-bound private package version lookup",
  );
  if (
    /\/users\/modvolt\/packages/.test(publishWorkflow) ||
    (publishWorkflow.match(/\/user\/packages/g) ?? []).length !== 10 ||
    (
      publishWorkflow.match(
        /\/user\/packages\?package_type=container&visibility=private&per_page=100/g,
      ) ?? []
    ).length !== 2 ||
    publishWorkflow.indexOf(
      "Require dedicated read-only Packages metadata credential",
    ) > publishWorkflow.indexOf("/user/packages")
  ) {
    fail(
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "every package read must use the authenticated-user namespace only after the exact metadata identity and scope gate.",
    );
  }
  if (
    (publishWorkflow.match(/versions\?state=active&per_page=100/g) ?? [])
      .length !== 3 ||
    (publishWorkflow.match(/length == \$expected/g) ?? []).length !== 3 ||
    (publishWorkflow.match(/versions\/\$\{version_id\}/g) ?? []).length !== 2
  ) {
    fail(
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "candidate package state, absence and final verification must bind complete active pagination and exact selected-version refetches.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    "(.repository.full_name | ascii_downcase) == $caller",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "private caller package linkage check",
  );
  requirePublicationText(
    publishWorkflow,
    ".repository.private == true",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "linked repository privacy check",
  );
  for (const stageGuard of [
    '"$PUBLICATION_STAGE" == "preflight-only"',
    '"$PUBLICATION_STAGE" == "complete"',
    "if: inputs.publication_stage == 'preflight-only'",
    "if: inputs.publication_stage == 'complete'",
    "PREFLIGHT_DIGEST: ${{ inputs.expected_preflight_digest }}",
  ]) {
    requirePublicationText(
      publishWorkflow,
      stageGuard,
      "STAGING_IMAGE_STAGE_GUARD_MISSING",
      `two-stage publication guard ${stageGuard}`,
    );
  }
  for (const stateTransition of [
    "preflight-only:00000",
    "preflight-only:10000",
    "complete:10000",
    "complete:11111",
  ]) {
    requirePublicationText(
      publishWorkflow,
      stateTransition,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `exact-SHA state transition ${stateTransition}`,
    );
  }
  for (const stateOutput of [
    'echo "publish_preflight=${publish_preflight}"',
    'echo "publish_remaining=${publish_remaining}"',
    'echo "${package_key}_digest=${exact_digests[$package_key]}"',
  ]) {
    requirePublicationText(
      publishWorkflow,
      stateOutput,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "idempotent exact-SHA package-state output",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '} >> "$GITHUB_OUTPUT"',
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "grouped package-state output",
  );
  requirePublicationText(
    publishWorkflow,
    "length == 1 and .[0].name == $digest",
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
    "unique exact-SHA remote digest binding",
  );
  for (const remoteAttestation of [
    "docker buildx imagetools inspect",
    "--format '{{json .Provenance}}'",
    "--format '{{json .SBOM}}'",
    "--format '{{json .Image}}'",
    ".schemaVersion == 2 and",
    '.mediaType == "application/vnd.oci.image.index.v1+json" and',
    "($runnable | length) == 1",
    "($manifests | length) == 2",
    '(.size | type) == "number" and .size > 0',
    "($attestations | length) == 1",
    "all($attestations[];",
    "vnd.docker.reference.digest",
    '.SLSA.buildType == "https://mobyproject.org/buildkit@v1"',
    '.SLSA.invocation.environment.platform == "linux/amd64"',
    ".SLSA.metadata.completeness.parameters == true",
    '.SLSA.invocation.parameters.args["build-arg:" + $argName] == $sha',
    "vcs:localdir:dockerfile",
    "org.opencontainers.image.url",
    '.SPDX.SPDXID == "SPDXRef-DOCUMENT"',
    '.SPDX.dataLicense == "CC0-1.0"',
    '$relationship.relationshipType == "CONTAINS"',
    "remoteManifestVerified: true",
    "runnableManifestDigest",
    "activeInventoryPaginated: true",
    'deletedInventoryMode: "not-queryable-exact-read-scope"',
    'deletedHistoryScope: "external-audit-ledger-only"',
    "selectedVersionRefetched: true",
    "runtimeMetadata:",
    "provenance:",
    "sbom:",
  ]) {
    requirePublicationText(
      publishWorkflow,
      remoteAttestation,
      "STAGING_IMAGE_ATTESTATION_MISSING",
      `remote attestation proof ${remoteAttestation}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "assert-exact-tag-absent.sh",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "immediate exact-tag absence helper",
  );
  for (const immediateGuard of [
    "Recheck preflight tag absence immediately before publication",
    "Recheck Mailpit tag absence immediately before publication",
    "Recheck API tag absence immediately before publication",
    "Recheck web tag absence immediately before publication",
    "Recheck alert receiver tag absence immediately before publication",
  ]) {
    requirePublicationText(
      publishWorkflow,
      immediateGuard,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `pre-push TOCTOU guard ${immediateGuard}`,
    );
  }
  for (const packageName of [
    "site-logbook-staging-preflight",
    "site-logbook-staging-mailpit",
    "site-logbook-staging-api",
    "site-logbook-staging-web",
    "site-logbook-staging-alert-receiver",
  ]) {
    requirePublicationText(
      publishWorkflow,
      `"\${RUNNER_TEMP}/assert-exact-tag-absent.sh" ${packageName}`,
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      `immediate exact-tag absence invocation for ${packageName}`,
    );
  }
  for (const verificationStep of [
    "Verify first published package is private before continuing",
    "Verify Mailpit package is private and digest-bound",
    "Verify API package is private and digest-bound",
    "Verify web package is private and digest-bound",
    "Verify alert receiver package is private and digest-bound",
  ]) {
    requirePublicationText(
      publishWorkflow,
      verificationStep,
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
      `sequential package verification ${verificationStep}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "Verify first published package is private before continuing",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "fail-fast first package privacy verification",
  );
  requirePublicationText(
    publishWorkflow,
    "Verify all published packages remain private",
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    "post-publication privacy verification",
  );
  if (
    (
      publishWorkflow.match(
        /org\.opencontainers\.image\.source=https:\/\/github\.com\/modvolt\/Site-Logbook/g,
      ) ?? []
    ).length !== 5
  ) {
    fail(
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
      "all five images must link to the exact public source repository.",
    );
  }
  if (
    (
      publishWorkflow.match(
        /org\.opencontainers\.image\.url=https:\/\/github\.com\/modvolt\/Site-Logbook\/commit\/\$\{\{ inputs\.source_sha \}\}/g,
      ) ?? []
    ).length !== 5
  ) {
    fail(
      "STAGING_IMAGE_SOURCE_GUARD_MISSING",
      "all five images must preserve the exact public source commit URL.",
    );
  }
  requirePublicationText(
    publishWorkflow,
    '[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
    "nonempty sha256 digest validation",
  );
  for (const imageName of [
    "site-logbook-staging-preflight",
    "site-logbook-staging-mailpit",
    "site-logbook-staging-api",
    "site-logbook-staging-web",
    "site-logbook-staging-alert-receiver",
  ]) {
    requirePublicationText(
      publishWorkflow,
      `^ghcr\\\\.io/modvolt/${imageName}@sha256:[0-9a-f]{64}$`,
      "STAGING_IMAGE_DIGEST_GUARD_MISSING",
      `immutable manifest namespace for ${imageName}`,
    );
  }
  requirePublicationText(
    publishWorkflow,
    "confirm_registry_publication:",
    "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
    "explicit publication confirmation",
  );
  requireText(publishWorkflow, "packages: write", "GHCR write permission");
  for (const action of PINNED_ACTIONS) {
    requireText(publishWorkflow, action, `pinned action ${action}`);
  }
  if ((publishWorkflow.match(/\bpush: true\b/g) ?? []).length !== 5) {
    fail(
      "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
      "the manual workflow must publish exactly five custom images.",
    );
  }
  if ((publishWorkflow.match(/\bpush: false\b/g) ?? []).length !== 5) {
    fail(
      "STAGING_IMAGE_PREBUILD_GUARD_MISSING",
      "each image publication stage must validate builds without a registry write first.",
    );
  }
  for (const buildValidation of [
    "Validate preflight image build without registry write",
    "Validate Mailpit image build without registry write",
    "Validate API image build without registry write",
    "Validate web image build without registry write",
    "Validate alert receiver image build without registry write",
  ]) {
    requireText(
      publishWorkflow,
      buildValidation,
      `complete-stage no-write prebuild ${buildValidation}`,
    );
  }
  if ((publishWorkflow.match(/platforms: linux\/amd64/g) ?? []).length !== 10) {
    fail(
      "STAGING_IMAGE_PLATFORM_DRIFT",
      "all ten validation and publication builds must target the approved linux/amd64 host.",
    );
  }
  if (
    (publishWorkflow.match(/provenance: mode=max,version=v0\.2/g) ?? [])
      .length !== 5
  ) {
    fail(
      "STAGING_IMAGE_ATTESTATION_MISSING",
      "all five custom images must publish maximum BuildKit provenance.",
    );
  }
  for (const toolchainPin of [
    "version: v0.34.1",
    "driver-opts: image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
  ]) {
    requireText(
      publishWorkflow,
      toolchainPin,
      `candidate publisher toolchain pin ${toolchainPin}`,
    );
  }
  if ((publishWorkflow.match(/\bsbom: true\b/g) ?? []).length !== 5) {
    fail(
      "STAGING_IMAGE_ATTESTATION_MISSING",
      "all five custom images must publish an SBOM attestation.",
    );
  }
  requireText(
    publishWorkflow,
    "staging-images.json",
    "secret-free immutable image manifest",
  );
  requireText(
    publishWorkflow,
    "preflight-publication.json",
    "secret-free preflight publication evidence",
  );
  for (const checksum of [
    "preflight-publication.sha256",
    "staging-images.sha256",
    "remaining-mailpit-package.sha256",
    "remaining-api-package.sha256",
    "remaining-web-package.sha256",
    "remaining-alert-receiver-package.sha256",
  ]) {
    requireText(publishWorkflow, checksum, `${checksum} evidence checksum`);
  }
  const orderedRecoverySteps = [
    "Verify Mailpit package is private and digest-bound",
    "Upload Mailpit partial-publication recovery evidence",
    "Recheck API tag absence immediately before publication",
    "Build and publish API image",
    "Verify API package is private and digest-bound",
    "Upload API partial-publication recovery evidence",
    "Recheck web tag absence immediately before publication",
    "Build and publish web image",
    "Verify web package is private and digest-bound",
    "Upload web partial-publication recovery evidence",
    "Recheck alert receiver tag absence immediately before publication",
    "Build and publish alert receiver image",
    "Verify alert receiver package is private and digest-bound",
    "Upload alert receiver partial-publication recovery evidence",
    "Verify all published packages remain private",
    "Create and validate secret-free immutable image manifest",
  ];
  let previousRecoveryStep = -1;
  for (const recoveryStep of orderedRecoverySteps) {
    const recoveryStepIndex = publishWorkflow.indexOf(recoveryStep);
    if (recoveryStepIndex <= previousRecoveryStep) {
      fail(
        "STAGING_IMAGE_RECOVERY_EVIDENCE_ORDER_BROKEN",
        `${recoveryStep} is missing or out of fail-closed order.`,
      );
    }
    previousRecoveryStep = recoveryStepIndex;
  }
  for (const evidenceField of [
    "initialPackageState",
    "registryAction",
    "callerWorkflowRef",
    'kind: "site-logbook-staging-images"',
    'publicationStage: "complete"',
    "schemaVersion: 3",
    "deletedHistoryControl",
    'mode: "reviewed-caller-visible-history-ledger"',
    'decision: "explicitly-accepted-external-ledger"',
    "ledgerEntrySha256",
    "callerWorkflowSha",
    "visibleRunUniquenessVerified: true",
    'workflowRunHistoryScope: "github-visible-workflow-runs-below-1000-api-cap"',
    "deletedApiQueried: false",
    "registryLedger",
    "activeVersionCount",
    "packageVersionCount",
    "buildShaEnv",
    "verifiedBaseImageDigests",
  ]) {
    requireText(
      publishWorkflow,
      evidenceField,
      `publication evidence field ${evidenceField}`,
    );
  }
  for (const flatArtifactPath of [
    "path: |\n            preflight-publication.json\n            preflight-publication.sha256\n            staging-registry-ledger-entry.json",
    "path: |\n            staging-images.json\n            staging-images.sha256\n            staging-registry-ledger-entry.json",
  ]) {
    requireText(
      publishWorkflow,
      flatArtifactPath,
      `flat publication artifact path ${flatArtifactPath}`,
    );
  }
  if (/\b(?:coolify|kubectl|ssh)\b/i.test(publishWorkflow)) {
    fail(
      "STAGING_IMAGE_WORKFLOW_DEPLOYS",
      "the publication workflow must not contact a deployment plane.",
    );
  }

  const imageManifestValidator = readSource(
    "scripts/verify-staging-image-manifest.mjs",
    overrides,
  );
  for (const boundary of [
    "expectedManifestSha256",
    "IMAGE_MANIFEST_TRUST_MISMATCH",
    "IMAGE_MANIFEST_DUPLICATE_KEY",
    "modvolt/site-logbook-registry",
    "linux/amd64",
    "INTERNALLY_CONSISTENT_UNTRUSTED",
  ]) {
    requireText(
      imageManifestValidator,
      boundary,
      `offline image manifest boundary ${boundary}`,
    );
  }
  const provisioningValidator = readSource(
    "scripts/check-staging-provisioning.mjs",
    overrides,
  );
  for (const boundary of [
    "site-logbook-coolify-staging",
    "PRODUCTION_TARGET_REUSE",
    "coolify-per-resource",
    "staging-bucket-only",
    "mailpit-only",
    "totalMemoryMiB !== 3200",
  ]) {
    requireText(
      provisioningValidator,
      boundary,
      `observed provisioning boundary ${boundary}`,
    );
  }
  const deploymentBinding = readSource(
    "scripts/check-staging-deployment-binding.mjs",
    overrides,
  );
  for (const boundary of [
    'schemaAction: "inspect"',
    'schemaAction: "apply-0105"',
    'schemaAction: "steady-0105"',
    "STAGING_IMAGE_MANIFEST_B64",
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    "expectedCallerWorkflowSha",
    '"--expected-caller-workflow-sha"',
    "DEPLOYMENT_BINDING_PROVISIONING_UNOBSERVED",
    "staging-deployment-transition.sha256",
    "staging-deployment-steady.sha256",
    "export function validateStagingDeploymentInputs",
    'value.environmentId !== "site-logbook-staging"',
    "coolifyEnvironmentId",
    "expectedImageManifestSha256",
    "expectedProvisioningManifestSha256",
    "expectedProvisioning",
    "forbiddenPublicHost",
    "export function validateResolvedStagingComposeTarget",
    '"exact-0104-recovery-gate"',
    '"exact-0105-accounting-backup"',
    '"accounting-schema-gate"',
    "export const STAGING_POSTGRES_INSPECT_FORMAT",
    "export function validateRunningStagingPostgresContainer",
    "postgresVolumeName",
    "defaultNetworkName",
    'projection.path !== "docker-entrypoint.sh"',
    "The schema transition target must not receive an S3 write surface.",
  ]) {
    requireText(
      deploymentBinding,
      boundary,
      `canonical deployment binding ${boundary}`,
    );
  }
  const evidenceValidator = readSource(
    "scripts/check-staging-release-evidence.mjs",
    overrides,
  );
  for (const boundary of [
    'requireValue(root.schemaVersion, 4, "schemaVersion")',
    "expectedCallerWorkflowSha: callerWorkflowSha",
    '"0105_smooth_nitro"',
    "excludedMigration0100Present",
    "production-copy-restricted",
    "canonicalJsonArtifact",
    "validateStagingProvisioning",
    "validateStagingDeploymentInputs",
    "productionCopyPresentInsideApprovedBoundary",
    "rawProductionDataOutsideApprovedBoundary",
    "sourceBackupExecutionSha256",
    "backupMaxPayloadBytes",
    "backupSizeBytes",
    "sourceExecutionSha256",
    "maxPayloadBytes",
    "EVIDENCE_ARTIFACT_MISMATCH",
    '"--steady-inputs"',
    '"--bootstrap"',
    "releaseEvidenceFileSha256",
  ]) {
    requireText(
      evidenceValidator,
      boundary,
      `schema-v4 release evidence boundary ${boundary}`,
    );
  }
  const activationRunbook = readSource(
    "docs/audit/13-staging-activation-runbook.md",
    overrides,
  );
  for (const boundary of [
    "API image při běžném startu žádnou migraci automaticky nespouští.",
    "úspěšný one-shot `external-schema-gate`",
    "schválený režim `apply-0105`",
    "všemi osmi raw artefakty",
    "--image-manifest staging-images.json",
    "--inspect-inputs <initial-binding-dir>\\staging-deployment-inspect.json",
    "--transition-inputs staging-deployment-transition.json",
    "--steady-inputs staging-deployment-steady.json",
    "--schema-gate-evidence staging-schema-gate.json",
    "--backup-evidence staging-backup-evidence.json",
    "--provisioning staging-provisioning-observed.json",
    "--bootstrap staging-bootstrap-summary.json",
    "Schéma evidence verze 4",
    "schválený společný recovery point DB + objektů klasifikovaný přesně jako",
    "`production-copy-restricted`, s oddělenými staging credentials",
    "recovery point není evidovaný jako `production-copy-restricted`",
    "data `production-copy-restricted` neopustí schválené staging hranice",
    "STAGING_EXTERNAL_ACCOUNTS_ENABLED",
    "STAGING_IMAGE_MANIFEST_SHA256",
    "STAGING_PROVISIONING_MANIFEST_SHA256",
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    "`diagnostics.view` i `users.manage`",
    "staging:create-exact-0104-backup",
    "<backup-execution-dir>\\staging-exact-0104-backup-execution.json",
    "staging-exact-0104-recovery-environment.json",
    "--expected-inspect-inputs-sha256",
    "gate:staging-exact-0104-recovery-binding",
    "staging:verify-exact-0104-recovery",
    "--expected-source-sha <40-hex>",
    "--expected-inputs-sha256 <64-hex> --inspect-inputs <recovery-binding-dir>\\staging-exact-0104-recovery-inspect.json",
    "--inspect-inputs <recovery-binding-dir>\\staging-exact-0104-recovery-inspect.json",
    "staging:apply-0105-transition",
    "newlyApplied=0",
    "první no-op bez",
  ]) {
    requireText(
      activationRunbook,
      boundary,
      `active staging runbook boundary ${boundary}`,
    );
  }
  for (const staleBoundary of [
    "API image při startu automaticky aplikuje existující migrace",
    "Schéma evidence verze 3",
    "anonymizovaný společný recovery point",
    "není doložena anonymizace recovery pointu",
    "anonymizovaná data neopustí schválené staging hranice",
  ]) {
    if (activationRunbook.includes(staleBoundary)) {
      fail(
        "STAGING_ACTIVATION_RUNBOOK_STALE",
        `the active staging runbook still contains stale boundary ${staleBoundary}.`,
      );
    }
  }
  const schemaGateEntrypoint = readSource(
    "artifacts/api-server/src/external-schema-gate.ts",
    overrides,
  );
  for (const boundary of [
    'decision: "APPLIED"',
    "excludedMigration0100Present: false",
    "backupRestoreMaxAgeHours",
    "sourceBackupExecutionSha256",
    "backupMaxPayloadBytes",
    "backupSizeBytes",
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    "inputSha256: `sha256:${deploymentInputsSha256}`",
    "async function verifyTransitionNoop(",
    "runMigrations",
    'migration.newlyApplied === 1 ? "APPLIED" : "NOOP"',
    "MIGRATION_APPLY_COUNT_INVALID",
    "[external-schema-gate] ${result.mode} ${JSON.stringify(result.evidence)}",
  ]) {
    requireText(
      schemaGateEntrypoint,
      boundary,
      `schema transition evidence boundary ${boundary}`,
    );
  }
  const exact0104BackupEntrypoint = readSource(
    "artifacts/api-server/src/external-schema-exact-0104-backup.ts",
    overrides,
  );
  for (const boundary of [
    "CREATE_FRESH_EXACT_0104_STAGING_BACKUP_AND_RESTORE_TEST",
    "STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
    'inventory.decision !== "READY_0104"',
    "skipRetentionPrune: true",
    "    maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,\n  });",
    "    { maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES },\n  );",
    "testBackupRestore",
    "observedNewBackupId !== restored.id",
    "authorizes0105: false",
  ]) {
    requireText(
      exact0104BackupEntrypoint,
      boundary,
      `exact-0104 backup entrypoint ${boundary}`,
    );
  }
  const backupLibrary = readSource(
    "artifacts/api-server/src/lib/backup.ts",
    overrides,
  );
  for (const boundary of [
    "skipRetentionPrune?: boolean",
    "if (!skipRetentionPrune)",
    "maxPayloadBytes?: number",
    "dumpStat.size > maxPayloadBytes",
    "storedSize > maxPayloadBytes",
    "row.sizeBytes > options.maxPayloadBytes",
    "maxBytes: options.maxPayloadBytes",
  ]) {
    requireText(backupLibrary, boundary, `backup prune boundary ${boundary}`);
  }
  const objectStorageLibrary = readSource(
    "artifacts/api-server/src/lib/objectStorage.ts",
    overrides,
  );
  for (const boundary of [
    "options: { maxBytes?: number } = {}",
    "totalBytes > options.maxBytes",
    "Recovery object exceeds the approved",
  ]) {
    requireText(
      objectStorageLibrary,
      boundary,
      `bounded recovery object read ${boundary}`,
    );
  }
  const exact0104BackupRunner = readSource(
    "scripts/run-staging-exact-0104-backup.mjs",
    overrides,
  );
  for (const boundary of [
    'services.length !== 1 || services[0] !== "postgres"',
    '"exact-0104-backup"',
    '"--no-deps"',
    "createdAt <= baseline.completedAt",
    'expectedSchemaAction: "inspect"',
    '"config", "--format", "json"',
    'targetService: "exact-0104-backup"',
    "STAGING_POSTGRES_INSPECT_FORMAT",
    "validateRunningStagingPostgresContainer",
    '"dist/external-schema-exact-0104-backup.mjs"',
    "MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
    "value.sizeBytes > MAX_PAYLOAD_BYTES",
    "value.maxPayloadBytes !== MAX_PAYLOAD_BYTES",
    '"final quiescence check"',
    'requiredArgument("--inspect-inputs")',
    '"--expected-inspect-inputs-sha256"',
    "inspectDeploymentInputsSha256",
    "staging-exact-0104-backup-execution.sha256",
    "authorizes0105: false",
  ]) {
    requireText(
      exact0104BackupRunner,
      boundary,
      `exact-0104 backup runner ${boundary}`,
    );
  }
  const exact0105BackupEntrypoint = readSource(
    "artifacts/api-server/src/accounting-schema-exact-0105-backup.ts",
    overrides,
  );
  for (const boundary of [
    "CREATE_FRESH_EXACT_0105_STAGING_BACKUP_AND_RESTORE_TEST_NO_0106",
    "STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
    'inventory.decision !== "READY_0105"',
    "inventory.latestAppliedTag !== LATEST_0105",
    "inventory.externalStateRows !== 0",
    "skipRetentionPrune: true",
    "boundedPayload(row.sizeBytes",
    "observedNewBackupId !== restored.id",
    'nextGate: "accounting-0106-transition-binding-required"',
    "authorizes0106: false",
  ]) {
    requireText(
      exact0105BackupEntrypoint,
      boundary,
      `exact-0105 backup entrypoint ${boundary}`,
    );
  }
  const exact0105BackupRunner = readSource(
    "scripts/run-staging-exact-0105-backup.mjs",
    overrides,
  );
  for (const boundary of [
    'services.length !== 1 || services[0] !== "postgres"',
    'targetService: "exact-0105-accounting-backup"',
    '"config", "--format", "json"',
    "STAGING_POSTGRES_INSPECT_FORMAT",
    "validateRunningStagingPostgresContainer",
    '"--no-deps"',
    '"dist/accounting-schema-exact-0105-backup.mjs"',
    "MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
    'positiveInteger(value.sizeBytes, "backup size") > MAX_PAYLOAD_BYTES',
    '"final quiescence check"',
    'requiredArgument("--inspect-inputs")',
    '"--expected-inspect-inputs-sha256"',
    "inspectDeploymentInputsSha256",
    "staging-exact-0105-backup-execution.sha256",
    "accountingSchema0106GateStarted: false",
    "authorizes0106: false",
  ]) {
    requireText(
      exact0105BackupRunner,
      boundary,
      `exact-0105 backup runner ${boundary}`,
    );
  }
  const accounting0106Binding = readSource(
    "scripts/check-staging-accounting-0106-binding.mjs",
    overrides,
  );
  for (const boundary of [
    "staging-accounting-0106-transition.json",
    "staging-accounting-0106-inspect.json",
    "staging-accounting-0106.env",
    "validateAccounting0106TransitionInputs",
    "validateExact0105BackupExecution",
    'tag: "0105_smooth_nitro"',
    'tag: "0106_graceful_frog_thor"',
    "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
    "maxPayloadBytes !== MAX_PAYLOAD_BYTES",
    "productionTargetsTouched: false",
  ]) {
    requireText(
      accounting0106Binding,
      boundary,
      `accounting 0106 binding ${boundary}`,
    );
  }
  const accounting0106Runner = readSource(
    "scripts/run-staging-accounting-0106-transition.mjs",
    overrides,
  );
  for (const boundary of [
    "staging-accounting-0106-intent.json",
    "staging-accounting-0106-execution.json",
    "dist/accounting-schema-inventory.mjs",
    'value.decision === "READY_0105"',
    'value.decision === "ALREADY_0106"',
    "ACCOUNTING_0106_UNEXPECTED_NOOP",
    'targetService: "accounting-schema-gate"',
    '"config", "--format", "json"',
    "STAGING_POSTGRES_INSPECT_FORMAT",
    "validateRunningStagingPostgresContainer",
    '"ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION="',
    "`ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`",
    '"dist/accounting-schema-gate.mjs"',
    '"post-inventory quiescence check"',
    '"pre-transition quiescence check"',
    '"final quiescence check"',
    "MAX_PAYLOAD_BYTES = 256 * 1024 * 1024",
    "authorizesApplicationStart: false",
  ]) {
    requireText(
      accounting0106Runner,
      boundary,
      `accounting 0106 transition runner ${boundary}`,
    );
  }
  const accounting0106Verifier = readSource(
    "scripts/verify-staging-accounting-0106-execution.mjs",
    overrides,
  );
  for (const boundary of [
    "verifyStagingAccounting0106Execution",
    "validateStagingAccounting0106Execution",
    "validateStagingAccounting0106TransitionArtifacts",
    "staging-accounting-0106-execution.json",
    "eligibleForStagingApplicationStartApproval: true",
    "deployPerformed: false",
    'nextGate: "separate-staging-application-start-approval"',
  ]) {
    requireText(
      accounting0106Verifier,
      boundary,
      `accounting 0106 execution verifier ${boundary}`,
    );
  }
  const schemaTransitionRunner = readSource(
    "scripts/run-staging-schema-transition.mjs",
    overrides,
  );
  for (const boundary of [
    "staging-schema-transition-intent.json",
    "dist/external-schema-inventory.mjs",
    'value.decision !== "READY_0104"',
    "SCHEMA_TRANSITION_UNEXPECTED_NOOP",
    "validateApplied(marker.value, inputs, recovery)",
    'expectedSchemaAction: "apply-0105"',
    '"config", "--format", "json"',
    'targetService: "external-schema-gate"',
    "STAGING_POSTGRES_INSPECT_FORMAT",
    "validateRunningStagingPostgresContainer",
    '"EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION="',
    "`EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`",
    '"dist/external-schema-gate.mjs"',
    '"post-inventory quiescence check"',
    '"pre-transition quiescence check"',
    '"final quiescence check"',
    "writeFinalBundle",
    "staging-schema-gate.json",
    "staging-backup-evidence.json",
    "sourceExecutionSha256",
    "MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024",
    "STAGING_EXACT_0104_BACKUP_EXECUTION_SHA256",
  ]) {
    requireText(
      schemaTransitionRunner,
      boundary,
      `schema transition runner ${boundary}`,
    );
  }
  const stagingSmokeWorkflow = readSource(
    ".github/workflows/staging-smoke.yml",
    overrides,
  );
  requireExactPinnedActions(
    stagingSmokeWorkflow,
    PINNED_SMOKE_ACTIONS,
    "staging smoke workflow",
  );
  requireText(
    stagingSmokeWorkflow,
    "persist-credentials: false",
    "staging smoke checkout credential isolation",
  );
  for (const boundary of [
    "STAGING_IMAGE_MANIFEST_SHA256",
    "STAGING_PROVISIONING_MANIFEST_SHA256",
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    "staging-bootstrap-summary.sha256",
    "if-no-files-found: error",
  ]) {
    requireText(
      stagingSmokeWorkflow,
      boundary,
      `staging bootstrap evidence boundary ${boundary}`,
    );
  }
  const packageJson = readSource("package.json", overrides);
  for (const command of [
    "gate:staging-image-manifest",
    "gate:staging-predecessor-image",
    "gate:staging-provisioning",
    "gate:staging-deployment-binding",
    "staging-deployment-binding.test.mjs",
    "staging-predecessor-image.test.mjs",
  ]) {
    requireText(packageJson, command, `staging contract command ${command}`);
  }

  const predecessorWorkflow = readSource(
    ".github/workflows/staging-predecessor-image.yml",
    overrides,
  );
  requireExactPinnedActions(
    predecessorWorkflow,
    PINNED_PREDECESSOR_ACTIONS,
    "fixed predecessor API publication workflow",
  );
  for (const boundary of [
    "workflow_call:",
    "confirm_predecessor_registry_publication:",
    "verify_existing_only:",
    "Require the exact predecessor tag to exist and structurally disable every build or push step",
    "    secrets:\n      packages_metadata_token:\n        description: Dedicated classic PAT with exactly read:packages for private Packages REST metadata\n        required: true",
    "packages_metadata_token:",
    "Dedicated classic PAT with exactly read:packages",
    "Require dedicated read-only Packages metadata credential",
    "GH_TOKEN: ${{ secrets.packages_metadata_token }}",
    "REGISTRY_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    '[[ "$GH_TOKEN" != "$REGISTRY_GITHUB_TOKEN" ]]',
    '[[ "$normalized_scopes" == "read:packages" ]]',
    '.login == "modvolt"',
    ".id == 289280891",
    '.type == "User"',
    "CALLER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    'GH_TOKEN="$CALLER_GITHUB_TOKEN" gh api',
    "VERIFY_EXISTING_ONLY: ${{ inputs.verify_existing_only }}",
    '[[ "$VERIFY_EXISTING_ONLY" == "true" || "$VERIFY_EXISTING_ONLY" == "false" ]]',
    "verify-existing-only requires an already-present exact predecessor tag and forbids publication.",
    "Prove verify-existing-only cannot publish",
    "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
    "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
    "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
    "site-logbook-images-publication",
    "site-logbook-staging-api",
    "'/user/packages?package_type=container&visibility=private&per_page=100'",
    '"/user/packages/container/${PACKAGE_NAME}"',
    "artifacts/api-server/Dockerfile",
    "version: v0.34.1",
    "driver-opts: image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
    "persist-credentials: false",
    "0104_thin_sheva_callister",
    '[[ "${#sql_files[@]}" == "104" ]]',
    '[[ "${sql_files[*]}" != *"0100_"* && "${sql_files[*]}" != *"0105_"* ]]',
    "length == 0",
    "versions?state=active&per_page=100",
    "versions?state=deleted&per_page=100",
    ".version_count >= 0",
    "length == $expected",
    "versions/${selected_version_id}",
    "versions/${version_id}",
    'if [[ "$VERIFY_EXISTING_ONLY" == "false" ]]; then',
    "activeInventoryPaginated: true",
    "deletedInventoryMode: $deletedInventoryMode",
    'deleted_inventory_mode="not-applicable-verify-existing-only"',
    'deleted_inventory_mode="queried-visible-package-versions"',
    "visibleDeletedTagConflictChecked: $visibleDeletedTagConflictChecked",
    'visible_deleted_tag_conflict_checked="false"',
    "deletedVersionCount: $deletedVersionCount",
    "deletedHistoryScope: $deletedHistoryScope",
    'deleted_history_scope="not-applicable-no-write"',
    "selectedVersionRefetched: true",
    "org.opencontainers.image.revision",
    "https://mobyproject.org/buildkit@v1#metadata",
    '.SLSA.invocation.configSource.entryPoint == "Dockerfile"',
    '.SLSA.invocation.parameters.root.configSource.path == "Dockerfile"',
    '.SLSA.invocation.parameters.root.request.args["vcs:localdir:context"] == "."',
    '.SLSA.invocation.parameters.root.request.args["vcs:localdir:dockerfile"] == "artifacts/api-server"',
    '.SLSA.invocation.parameters.root.request.args["vcs:revision"] == $sha',
    '.SLSA.invocation.parameters.root.request.args["vcs:source"]',
    '.SLSA.invocation.parameters.root.request.args["vcs:localdir:dockerfile"] + "/" + .SLSA.invocation.configSource.entryPoint',
    '.SLSA.invocation.parameters.args["build-arg:BUILD_SHA"] == $sha',
    "(.metadata.container.tags // []) == [$sha]",
    "runtimeMetadata: {source: $runtimeSource",
    'provenance: {buildType: "https://mobyproject.org/buildkit@v1"',
    "sbom: {spdxVersion: $sbomVersion",
    "($packages | length) > 0",
    "($relationships | length) > 0",
    "([ $packages[].SPDXID ]) as $packageIds",
    "any($relationships[];",
    ". as $relationship |",
    "($packageIds | index($relationship.spdxElementId))",
    '$relationship.relationshipType == "CONTAINS"',
    'dataLicense == "CC0-1.0"',
    "provenance: mode=max,version=v0.2",
    "sbom: true",
    'VERIFICATION_ATTEMPTS: "36"',
    'VERIFICATION_POLL_SECONDS: "5"',
    'for attempt in $(seq 1 "$VERIFICATION_ATTEMPTS")',
    "PACKAGE_METADATA_NOT_READY",
    "ACTIVE_VERSION_INVENTORY_NOT_READY",
    "DELETED_VERSION_INVENTORY_NOT_READY",
    "SELECTED_VERSION_REFETCH_NOT_READY",
    "OCI_INDEX_NOT_READY",
    "RUNTIME_METADATA_NOT_READY",
    "PROVENANCE_NOT_READY",
    "SBOM_NOT_READY",
    "Fixed predecessor verification exhausted",
    '[[ "$verification_succeeded" == "true" ]]',
    '[[ "$registry_action" == "verified-noop" && "$INITIAL_TAG_STATE" == "present" ]]',
    "execution_mode=verify-existing-only",
    "execution_mode=publication-capable",
    '{schemaVersion: 3, kind: "site-logbook-staging-predecessor-api", executionMode: $executionMode',
    ".schemaVersion == 3 and",
    'kind: "site-logbook-staging-predecessor-api"',
    "staging-predecessor-image.sha256",
    "if-no-files-found: error",
  ]) {
    requireText(
      predecessorWorkflow,
      boundary,
      `fixed predecessor publication boundary ${boundary}`,
    );
  }
  if (
    /\/users\/modvolt\/packages/.test(predecessorWorkflow) ||
    (predecessorWorkflow.match(/\/user\/packages/g) ?? []).length !== 13 ||
    (
      predecessorWorkflow.match(
        /\/user\/packages\?package_type=container&visibility=private&per_page=100/g,
      ) ?? []
    ).length !== 2 ||
    predecessorWorkflow.indexOf(
      "Require dedicated read-only Packages metadata credential",
    ) > predecessorWorkflow.indexOf("/user/packages")
  ) {
    fail(
      "STAGING_PREDECESSOR_PACKAGE_API_NAMESPACE_DRIFT",
      "the predecessor publisher must use the authenticated-user package namespace only after the exact metadata identity and scope gate.",
    );
  }
  if (
    (
      predecessorWorkflow.match(
        /^\s+GH_TOKEN: \$\{\{ secrets\.packages_metadata_token \}\}$/gm,
      ) ?? []
    ).length !== 4 ||
    /^\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m.test(
      predecessorWorkflow,
    ) ||
    (predecessorWorkflow.match(/\$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? [])
      .length !== 3 ||
    (
      predecessorWorkflow.match(
        /\$\{\{ secrets\.packages_metadata_token \}\}/g,
      ) ?? []
    ).length !== 4
  ) {
    fail(
      "STAGING_PREDECESSOR_METADATA_CREDENTIAL_DRIFT",
      "all predecessor Packages REST reads must use the named read-only credential while GITHUB_TOKEN remains isolated to caller metadata and registry login.",
    );
  }
  if (
    (predecessorWorkflow.match(/versions\?state=active&per_page=100/g) ?? [])
      .length !== 3 ||
    (predecessorWorkflow.match(/versions\?state=deleted&per_page=100/g) ?? [])
      .length !== 3 ||
    (
      predecessorWorkflow.match(
        /if \[\[ "\$VERIFY_EXISTING_ONLY" == "false" \]\]; then\n\s+deleted_versions_json="\$\(/g,
      ) ?? []
    ).length !== 2 ||
    (predecessorWorkflow.match(/length == \$expected/g) ?? []).length !== 3 ||
    (predecessorWorkflow.match(/\n\s+length == 0 and/g) ?? []).length !== 3 ||
    (
      predecessorWorkflow.match(
        /\(\.metadata\.container\.tags \/\/ \[\]\) == \[\$sha\]/g,
      ) ?? []
    ).length !== 2
  ) {
    fail(
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
      "the predecessor publisher must paginate active versions at every gate, query deleted versions only in publication-capable guards, reject visible tombstones before writes and refetch an exact single tag.",
    );
  }
  for (const forbidden of [
    /^\s*workflow_dispatch:/m,
    /^\s+source_sha:/m,
    /^\s+source_ref:/m,
    /^\s+source_pr_number:/m,
    /site-logbook-staging-preflight/,
    /site-logbook-staging-mailpit/,
    /site-logbook-staging-web/,
    /site-logbook-staging-alert-receiver/,
    /coolify/i,
    /DATABASE_URL/,
    /\bS3_[A-Z0-9_]+\b/,
  ]) {
    if (forbidden.test(predecessorWorkflow)) {
      fail(
        "STAGING_PREDECESSOR_SCOPE_WIDENED",
        `the fixed predecessor publisher contains forbidden surface ${forbidden}.`,
      );
    }
  }
  if ((predecessorWorkflow.match(/\bpackages: write\b/g) ?? []).length !== 1) {
    fail(
      "STAGING_PREDECESSOR_PERMISSION_DRIFT",
      "the fixed predecessor publisher must grant package write exactly once.",
    );
  }
  if (
    (predecessorWorkflow.match(/\bpush: false\b/g) ?? []).length !== 1 ||
    (predecessorWorkflow.match(/\bpush: true\b/g) ?? []).length !== 1 ||
    (predecessorWorkflow.match(/\bprovenance: mode=max,version=v0\.2\b/g) ?? [])
      .length !== 2 ||
    (predecessorWorkflow.match(/\bsbom: true\b/g) ?? []).length !== 2
  ) {
    fail(
      "STAGING_PREDECESSOR_PUBLICATION_DRIFT",
      "the fixed predecessor publisher must prebuild once with exact attestations and publish at most one identically attested API image.",
    );
  }
  const verifyOnlyPublicationGuard =
    "if: inputs.verify_existing_only == false && steps.package-state.outputs.publish == 'true'";
  if (
    (
      predecessorWorkflow.match(
        /if: inputs\.verify_existing_only == false && steps\.package-state\.outputs\.publish == 'true'/g,
      ) ?? []
    ).length !== 3 ||
    (
      predecessorWorkflow.match(
        /^\s+if: steps\.package-state\.outputs\.publish == 'true'$/gm,
      ) ?? []
    ).length !== 0 ||
    !predecessorWorkflow.includes(verifyOnlyPublicationGuard)
  ) {
    fail(
      "STAGING_PREDECESSOR_VERIFY_ONLY_DRIFT",
      "every predecessor build, tag-absence, and push step must be structurally disabled in verify-existing-only mode.",
    );
  }
  if (
    (predecessorWorkflow.match(/platforms: linux\/amd64/g) ?? []).length !== 2
  ) {
    fail(
      "STAGING_PREDECESSOR_PLATFORM_DRIFT",
      "both predecessor API build stages must remain linux/amd64.",
    );
  }

  const predecessorWrapperTemplate = readSource(
    "docs/audit/16-c3-private-predecessor-wrapper.template.yml",
    overrides,
  );
  const predecessorVerifyOnlyPhrase =
    "VERIFY_EXISTING_FIXED_SITE_LOGBOOK_STAGING_PREDECESSOR_0104_NO_DEPLOY_NO_PUSH";
  for (const boundary of [
    "workflow_dispatch:",
    predecessorVerifyOnlyPhrase,
    "Verify existing fixed Site Logbook staging predecessor (manual, no deploy, no push)",
    '[[ "$REF" == "refs/heads/main" ]]',
    '[[ "${ACTOR,,}" == "modvolt" ]]',
    '[[ "${TRIGGERING_ACTOR,,}" == "modvolt" ]]',
    "packages: write",
    "modvolt/Site-Logbook/.github/workflows/staging-predecessor-image.yml@ec1c13c11e9e42dbfc258dc353adb3db3bcc67d8",
    "secrets:\n      packages_metadata_token: ${{ secrets.SITE_LOGBOOK_GHCR_METADATA_READ_TOKEN }}",
    "confirm_predecessor_registry_publication: true",
    "verify_existing_only: true",
  ]) {
    requireText(
      predecessorWrapperTemplate,
      boundary,
      `private predecessor wrapper boundary ${boundary}`,
    );
  }
  if (
    (
      predecessorWrapperTemplate.match(
        /group: site-logbook-registry-publication/g,
      ) ?? []
    ).length !== 1 ||
    (predecessorWrapperTemplate.match(/cancel-in-progress: false/g) ?? [])
      .length !== 1 ||
    predecessorWrapperTemplate.includes(
      "group: site-logbook-images-publication",
    )
  ) {
    fail(
      "STAGING_PREDECESSOR_WRAPPER_CONCURRENCY_COLLISION",
      "the private caller must serialize registry workflows without reusing the called workflow concurrency group.",
    );
  }
  if (
    (
      predecessorWrapperTemplate.match(
        new RegExp(predecessorVerifyOnlyPhrase, "g"),
      ) ?? []
    ).length !== 2 ||
    predecessorWrapperTemplate.includes(
      "PUBLISH_FIXED_SITE_LOGBOOK_STAGING_PREDECESSOR_0104_NO_DEPLOY",
    ) ||
    predecessorWrapperTemplate.includes("verify_existing_only: false") ||
    (predecessorWrapperTemplate.match(/\bpackages: write\b/g) ?? []).length !==
      1 ||
    (
      predecessorWrapperTemplate.match(
        /^\s+packages_metadata_token: \$\{\{ secrets\.SITE_LOGBOOK_GHCR_METADATA_READ_TOKEN \}\}$/gm,
      ) ?? []
    ).length !== 1 ||
    (predecessorWrapperTemplate.match(/\$\{\{ secrets\.[A-Z0-9_]+ \}\}/g) ?? [])
      .length !== 1 ||
    /secrets:\s*inherit/.test(predecessorWrapperTemplate) ||
    /source_sha|source_ref|source_pr_number/i.test(
      predecessorWrapperTemplate,
    ) ||
    /coolify|DATABASE_URL|\bS3_[A-Z0-9_]+\b/i.test(predecessorWrapperTemplate)
  ) {
    fail(
      "STAGING_PREDECESSOR_WRAPPER_DRIFT",
      "the private predecessor wrapper template widened its permission, source, secret, or deployment surface.",
    );
  }

  const baselineBinding = readSource(
    "scripts/check-staging-baseline-0104-binding.mjs",
    overrides,
  );
  for (const boundary of [
    "createStagingDeploymentBinding",
    "expectedCandidateCallerWorkflowSha",
    '"--expected-candidate-caller-workflow-sha"',
    "validateStagingPredecessorImage",
    'kind: "site-logbook-staging-baseline-0104"',
    'const BASELINE_ACTION = "apply-0104-baseline"',
    "productionTargetsTouched: false",
    "migrationCount: 104",
    'const FIXED_PREDECESSOR_TAIL = "0104_thin_sheva_callister"',
    'nextGate: "fresh-exact-0104-backup-and-restore-required"',
    "authorizes0105: false",
    "staging-baseline-0104-inputs.sha256",
  ]) {
    requireText(
      baselineBinding,
      boundary,
      `exact-0104 binding boundary ${boundary}`,
    );
  }
  const baselineRunner = readSource(
    "scripts/run-staging-baseline-0104.mjs",
    overrides,
  );
  for (const boundary of [
    "APPLY_FIXED_PREDECESSOR_0104_TO_ISOLATED_SITE_LOGBOOK_STAGING",
    'services.length !== 1 || services[0] !== "postgres"',
    '"baseline-0104-preflight"',
    '"baseline-0104-migrator"',
    '"baseline-0104-postflight"',
    '"--no-deps"',
    'precheck.operation === "migrate"',
    "requiresFreshExact0104BackupAndRestore: true",
    "authorizes0105: false",
    "staging-baseline-0104-execution.sha256",
  ]) {
    requireText(
      baselineRunner,
      boundary,
      `exact-0104 runner boundary ${boundary}`,
    );
  }

  const recoveryBinding = readSource(
    "scripts/check-staging-exact-0104-recovery-binding.mjs",
    overrides,
  );
  for (const boundary of [
    'kind: "site-logbook-staging-exact-0104-recovery"',
    'nextGate: "separate-0105-transition-binding-required"',
    "mustBeCreatedAfter: execution.completedAt",
    '"--backup-execution"',
    '"--backup-execution-checksum"',
    '"--expected-backup-execution-sha256"',
    '"--inspect-inputs"',
    '"--inspect-inputs-checksum"',
    '"--expected-inspect-inputs-sha256"',
    "validateExact0104BackupExecution",
    "validateStagingDeploymentInputs",
    "originalInspect.backupEvidenceId !== baseline.oldBackupId",
    "backupEvidenceId: exactBackup.backupId",
    "STAGING_DEPLOYMENT_INPUTS_SHA256: recoveryInspectSha256",
    "executionSha256: exactBackup.executionSha256",
    "maxPayloadBytes: exactBackup.maxPayloadBytes",
    "sizeBytes: exactBackup.sizeBytes",
    "productionTargetsTouched: false",
    "authorizes0105: false",
    "RECOVERY_BINDING_SECRET_MATERIAL",
    "staging-exact-0104-recovery-inputs.sha256",
    "staging-exact-0104-recovery-inspect.sha256",
  ]) {
    requireText(
      recoveryBinding,
      boundary,
      `exact-0104 recovery binding ${boundary}`,
    );
  }
  const recoveryRunner = readSource(
    "scripts/run-staging-exact-0104-recovery.mjs",
    overrides,
  );
  for (const boundary of [
    'services.length !== 1 || services[0] !== "postgres"',
    '"exact-0104-recovery-gate"',
    '"--no-deps"',
    '"config", "--format", "json"',
    'targetService: "exact-0104-recovery-gate"',
    "validateResolvedStagingComposeTarget",
    "STAGING_POSTGRES_INSPECT_FORMAT",
    "validateRunningStagingPostgresContainer",
    "expectedInspectDeploymentSha256",
    "staging-exact-0104-recovery-inspect.json",
    "value.buildSha !== expectedSourceSha",
    '"dist/external-schema-exact-0104-recovery.mjs"',
    '"final quiescence check"',
    "createdAt <= baselineCompletedAt",
    'nextGate: "separate-0105-transition-binding-required"',
    "authorizes0105: false",
    "RECOVERY_EVIDENCE_SCHEMA_INVALID",
    "sourceExecutionSha256",
    "MAX_BACKUP_PAYLOAD_BYTES = 256 * 1024 * 1024",
    "backup.sizeBytes > backup.maxPayloadBytes",
    "staging-exact-0104-recovery-execution.sha256",
  ]) {
    requireText(
      recoveryRunner,
      boundary,
      `exact-0104 recovery runner ${boundary}`,
    );
  }

  const qualityWorkflow = readSource(
    ".github/workflows/quality-gate.yml",
    overrides,
  );
  requireExactPinnedActions(
    qualityWorkflow,
    PINNED_QUALITY_ACTIONS,
    "Quality gate workflow",
  );
  requireText(
    qualityWorkflow,
    "persist-credentials: false",
    "Quality gate checkout credential isolation",
  );
  requireText(
    qualityWorkflow,
    "pnpm gate:staging-runtime",
    "Quality gate staging runtime validation",
  );
  requireText(
    qualityWorkflow,
    "pnpm test:staging-contract",
    "Quality gate staging contract tests",
  );
  requireText(
    qualityWorkflow,
    "pnpm --filter @workspace/db test:external-schema-preflight",
    "Quality gate external schema preflight tests",
  );

  for (const command of [
    "gate:staging-baseline-0104-binding",
    "staging:apply-0104-baseline",
    "staging-baseline-binding.test.mjs",
    "staging-baseline-runner.test.mjs",
    "gate:staging-exact-0104-recovery-binding",
    "staging:verify-exact-0104-recovery",
    "staging-exact-0104-recovery-binding.test.mjs",
    "staging-exact-0104-recovery-runner.test.mjs",
    "staging:create-exact-0104-backup",
    "staging-exact-0104-backup-runner.test.mjs",
    "staging:apply-0105-transition",
    "staging-schema-transition-runner.test.mjs",
    "staging:create-exact-0105-accounting-backup",
    "gate:staging-accounting-0106-binding",
    "staging:apply-accounting-0106-transition",
    "gate:staging-accounting-0106-execution",
    "staging-exact-0105-backup-runner.test.mjs",
    "staging-accounting-0106-binding.test.mjs",
    "staging-accounting-0106-transition-runner.test.mjs",
  ]) {
    requireText(packageJson, command, `exact-0104 package command ${command}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    runtimeBuildDefinitions: 0,
    services: Object.keys(EXPECTED_RESOURCES),
    totalCpuLimit: 3,
    totalMemoryLimitMiB: 3200,
    immutableCustomImages: REQUIRED_IMAGE_VARIABLES.length,
    pinnedBaseImageFamilies: 5,
    publicationMode: "private-caller-ghcr-no-deploy",
    predecessorPublicationMode: "fixed-exact-0104-api-private-caller-no-deploy",
    predecessorBaselineMode:
      "candidate-precheck-fixed-migrator-candidate-postcheck-no-0105",
    exact0104RecoveryMode:
      "new-encrypted-backup-restore-evidence-read-only-no-0105",
    exact0104BackupMode: "one-shot-create-restore-test-no-prune-no-api-no-0105",
    exact0105BackupMode: "one-shot-create-restore-test-no-prune-no-api-no-0106",
    accounting0106TransitionMode:
      "ready-0105-intent-live-postgres-bound-apply-or-reviewed-noop-no-app-start",
    schemaTransitionEvidenceMode:
      "ready-0104-intent-single-snapshot-atomic-finalization",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      `${JSON.stringify(validateStagingRuntimeContract(), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
