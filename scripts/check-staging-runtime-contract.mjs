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
  ]) {
    requireText(
      apiBuild,
      `path.resolve(artifactDir, "src/${entrypoint}")`,
      `API ${entrypoint} bundle entrypoint`,
    );
  }
  const schemaGateRunner = readSource(
    "artifacts/api-server/src/external-schema-gate.ts",
    overrides,
  );
  for (const boundary of [
    'if (action === "steady-0105")',
    'if (action !== "apply-0105")',
    'error.code !== "APPLIED_COUNT_MISMATCH"',
    'inventory.decision !== "READY_0104"',
    "await runMigrator();",
    "runExternalSchemaPreflight(post)",
    "runExternalSchemaSteadyState",
  ]) {
    requireText(
      schemaGateRunner,
      boundary,
      `state-aware external schema gate ${boundary}`,
    );
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
  for (const boundary of [
    "      external-schema-gate:",
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
    '.callerRepository == "modvolt/site-logbook-registry"',
    '.platform == "linux/amd64"',
    ".provenanceVerified == true",
    ".sbomVerified == true",
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
  ]) {
    requirePublicationText(
      publishWorkflow,
      input,
      "STAGING_IMAGE_REUSABLE_TRIGGER_MISSING",
      `required workflow_call input ${input}`,
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
  requirePublicationText(
    publishWorkflow,
    "publish-staging-images:\n    needs: validate-public-source\n    permissions:\n      contents: read\n      packages: write",
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
    "isolated package publication permission",
  );
  if ((publishWorkflow.match(/packages: write/g) ?? []).length !== 1) {
    fail(
      "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
      "only the package publication job may receive packages: write.",
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
    "'/user/packages?package_type=container&per_page=100'",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "authenticated private package inventory",
  );
  requirePublicationText(
    publishWorkflow,
    "user/packages/container/${package_name}/versions?per_page=100",
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
    "authenticated private package version lookup",
  );
  if (
    /users\/\$?\{?(?:PRIVATE_REGISTRY_OWNER|[Mm]odvolt)/.test(publishWorkflow)
  ) {
    fail(
      "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
      "private package metadata must not use the public-user package endpoint.",
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
    ".schemaVersion == 2 and",
    '.mediaType == "application/vnd.oci.image.index.v1+json" and',
    "($runnable | length) == 1",
    '$runnable[0].mediaType == "application/vnd.oci.image.manifest.v1+json"',
    "($attestations | length) == 1",
    "all($attestations[];",
    "vnd.docker.reference.digest",
    '.SLSA.buildType == "https://mobyproject.org/buildkit@v1"',
    '.SLSA.invocation.environment.platform == "linux/amd64"',
    '.SPDX.SPDXID == "SPDXRef-DOCUMENT"',
    '(.SPDX.spdxVersion | test("^SPDX-[0-9]+\\\\.[0-9]+$"))',
    "remoteManifestVerified: true",
    "runnableManifestDigest",
    "provenanceVerified: true",
    "sbomVerified: true",
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
        /org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}/g,
      ) ?? []
    ).length !== 5
  ) {
    fail(
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
      "all five images must link to the private caller repository.",
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
  if ((publishWorkflow.match(/provenance: mode=max/g) ?? []).length !== 5) {
    fail(
      "STAGING_IMAGE_ATTESTATION_MISSING",
      "all five custom images must publish maximum BuildKit provenance.",
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
  ]) {
    requireText(
      publishWorkflow,
      evidenceField,
      `publication evidence field ${evidenceField}`,
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
    "totalMemoryMiB !== 2816",
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
    "DEPLOYMENT_BINDING_PROVISIONING_UNOBSERVED",
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
    '"0105_smooth_nitro"',
    "excludedMigration0100Present",
    "production-copy-restricted",
    "EVIDENCE_ARTIFACT_MISMATCH",
    '"--steady-inputs"',
    '"--bootstrap"',
  ]) {
    requireText(
      evidenceValidator,
      boundary,
      `schema-v4 release evidence boundary ${boundary}`,
    );
  }
  const schemaGateEntrypoint = readSource(
    "artifacts/api-server/src/external-schema-gate.ts",
    overrides,
  );
  for (const boundary of [
    'decision: "APPLIED"',
    "excludedMigration0100Present: false",
    "backupRestoreMaxAgeHours",
    "STAGING_DEPLOYMENT_INPUTS_SHA256",
    "inputSha256: `sha256:${deploymentInputsSha256}`",
  ]) {
    requireText(
      schemaGateEntrypoint,
      boundary,
      `schema transition evidence boundary ${boundary}`,
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
    "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
    "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
    "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
    "site-logbook-images-publication",
    "site-logbook-staging-api",
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
    "activeInventoryPaginated: true",
    "visibleDeletedTagConflictChecked: true",
    "deletedVersionCount: $deletedVersionCount",
    'deletedHistoryScope: "visible-package-versions-only"',
    "selectedVersionRefetched: true",
    "org.opencontainers.image.revision",
    "https://mobyproject.org/buildkit@v1#metadata",
    '.SLSA.invocation.configSource.entryPoint == "artifacts/api-server/Dockerfile"',
    '.SLSA.invocation.parameters.args["build-arg:BUILD_SHA"] == $sha',
    "(.metadata.container.tags // []) == [$sha]",
    "runtimeMetadata: {source: $runtimeSource",
    'provenance: {buildType: "https://mobyproject.org/buildkit@v1"',
    "sbom: {spdxVersion: $sbomVersion",
    "($packages | length) > 0",
    "($relationships | length) > 0",
    '$relationship.relationshipType == "CONTAINS"',
    'dataLicense == "CC0-1.0"',
    "provenance: mode=max,version=v0.2",
    "sbom: true",
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
    (predecessorWorkflow.match(/versions\?state=active&per_page=100/g) ?? [])
      .length !== 3 ||
    (predecessorWorkflow.match(/versions\?state=deleted&per_page=100/g) ?? [])
      .length !== 3 ||
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
      "the predecessor publisher must paginate active and deleted versions at every gate, bind active count to package metadata, reject all visible tombstones and refetch an exact single tag.",
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
  for (const boundary of [
    "workflow_dispatch:",
    "PUBLISH_FIXED_SITE_LOGBOOK_STAGING_PREDECESSOR_0104_NO_DEPLOY",
    '[[ "$REF" == "refs/heads/main" ]]',
    '[[ "${ACTOR,,}" == "modvolt" ]]',
    '[[ "${TRIGGERING_ACTOR,,}" == "modvolt" ]]',
    "packages: write",
    "modvolt/Site-Logbook/.github/workflows/staging-predecessor-image.yml@a66bc2fcf5e0dd0dfbd45c450783b12d61c1c10f",
    "confirm_predecessor_registry_publication: true",
  ]) {
    requireText(
      predecessorWrapperTemplate,
      boundary,
      `private predecessor wrapper boundary ${boundary}`,
    );
  }
  if (
    (predecessorWrapperTemplate.match(/\bpackages: write\b/g) ?? []).length !==
      1 ||
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

  return Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    runtimeBuildDefinitions: 0,
    services: Object.keys(EXPECTED_RESOURCES),
    totalCpuLimit: 2.75,
    totalMemoryLimitMiB: 2816,
    immutableCustomImages: REQUIRED_IMAGE_VARIABLES.length,
    pinnedBaseImageFamilies: 5,
    publicationMode: "private-caller-ghcr-no-deploy",
    predecessorPublicationMode: "fixed-exact-0104-api-private-caller-no-deploy",
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
