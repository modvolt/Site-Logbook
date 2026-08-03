import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  StagingRuntimeContractError,
  validateStagingRuntimeContract,
} from "../check-staging-runtime-contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function source(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("accepts the immutable pull-only staging runtime", () => {
  const summary = validateStagingRuntimeContract();
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.runtimeBuildDefinitions, 0);
  assert.equal(summary.totalCpuLimit, 2.25);
  assert.equal(summary.totalMemoryLimitMiB, 2304);
  assert.equal(summary.immutableCustomImages, 4);
});

test("rejects a Coolify host build or resource-limit drift", () => {
  const compose = source("docker-compose.staging.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          / {2}staging-preflight:\r?\n/,
          "  staging-preflight:\n    build: .\n",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_HOST_BUILD_FORBIDDEN",
  );
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          '    cpus: "1.00"',
          '    cpus: "1.50"',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RESOURCE_LIMIT_DRIFT",
  );
});

test("rejects mutable base images and incomplete publication", () => {
  const apiDockerfile = source("artifacts/api-server/Dockerfile");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/Dockerfile": apiDockerfile.replace(
          /node:24-slim@sha256:[0-9a-f]{64}/,
          "node:24-slim",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_BASE_IMAGE_MUTABLE",
  );

  const workflow = source(".github/workflows/staging-images.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".github/workflows/staging-images.yml": workflow.replace(
          "          push: true",
          "          push: false",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
  );
});
