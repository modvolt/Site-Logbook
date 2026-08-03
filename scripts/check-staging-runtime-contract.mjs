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
  mailpit: {
    cpus: "0.25",
    memLimit: "256m",
    memReservation: "128m",
  },
  api: { cpus: "1.00", memLimit: "1g", memReservation: "768m" },
  web: { cpus: "0.25", memLimit: "128m", memReservation: "64m" },
});

const REQUIRED_IMAGE_VARIABLES = Object.freeze([
  "STAGING_PREFLIGHT_IMAGE",
  "STAGING_MAILPIT_IMAGE",
  "STAGING_API_IMAGE",
  "STAGING_WEB_IMAGE",
]);

const PINNED_ACTIONS = Object.freeze([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
  "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
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

function serviceBlock(compose, service) {
  const marker = `  ${service}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) {
    fail("STAGING_SERVICE_MISSING", `${service} is missing from Compose.`);
  }
  const remainder = compose.slice(start + marker.length);
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

  const exampleEnv = readSource(".env.staging.example", overrides);
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
  requireText(publishWorkflow, "workflow_dispatch:", "manual workflow trigger");
  requireText(
    publishWorkflow,
    "expected_sha:",
    "exact source SHA confirmation",
  );
  requireText(publishWorkflow, "packages: write", "GHCR write permission");
  for (const action of PINNED_ACTIONS) {
    requireText(publishWorkflow, action, `pinned action ${action}`);
  }
  if ((publishWorkflow.match(/\bpush: true\b/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
      "the manual workflow must publish exactly four custom images.",
    );
  }
  if ((publishWorkflow.match(/platforms: linux\/amd64/g) ?? []).length !== 4) {
    fail(
      "STAGING_IMAGE_PLATFORM_DRIFT",
      "all four custom images must target the approved linux/amd64 host.",
    );
  }
  requireText(
    publishWorkflow,
    "staging-images.json",
    "secret-free immutable image manifest",
  );
  if (/\b(?:coolify|kubectl|ssh)\b/i.test(publishWorkflow)) {
    fail(
      "STAGING_IMAGE_WORKFLOW_DEPLOYS",
      "the publication workflow must not contact a deployment plane.",
    );
  }

  const qualityWorkflow = readSource(
    ".github/workflows/quality-gate.yml",
    overrides,
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

  return Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    runtimeBuildDefinitions: 0,
    services: Object.keys(EXPECTED_RESOURCES),
    totalCpuLimit: 2.25,
    totalMemoryLimitMiB: 2304,
    immutableCustomImages: REQUIRED_IMAGE_VARIABLES.length,
    pinnedBaseImageFamilies: 5,
    publicationMode: "manual-ghcr-no-deploy",
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
