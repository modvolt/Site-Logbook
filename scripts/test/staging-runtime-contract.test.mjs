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

function assertWorkflowContractError(workflow, expectedCode) {
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".github/workflows/staging-images.yml": workflow,
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === expectedCode,
  );
}

test("accepts the immutable pull-only staging runtime", () => {
  const summary = validateStagingRuntimeContract();
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.runtimeBuildDefinitions, 0);
  assert.equal(summary.totalCpuLimit, 2.25);
  assert.equal(summary.totalMemoryLimitMiB, 2304);
  assert.equal(summary.immutableCustomImages, 4);
  assert.equal(summary.publicationMode, "private-caller-ghcr-no-deploy");
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
  assertWorkflowContractError(
    workflow.replace("          push: true", "          push: false"),
    "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
  );
});

test("forbids a direct publisher in the public repository", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace("  workflow_call:", "  workflow_dispatch:"),
    "STAGING_IMAGE_PUBLIC_DIRECT_DISPATCH",
  );
});

test("isolates public validation from the package write token", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "validate-public-source:\n    permissions: {}",
      "validate-public-source:\n    permissions:\n      contents: read",
    ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace(
      "publish-staging-images:\n    needs: validate-public-source",
      "publish-staging-images:",
    ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
  assertWorkflowContractError(
    workflow
      .replace(
        "      contents: read\n      packages: write",
        "      contents: read\n      packages: write\n      actions: write",
      )
      .replace(
        "permissions: {}\n\nconcurrency:",
        "permissions:\n  packages: write\n\nconcurrency:",
      ),
    "STAGING_IMAGE_PERMISSION_BOUNDARY_BROKEN",
  );
});

test("keeps the public source helper credential-free", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const forbidden of [
    "Authorization",
    "GH_TOKEN",
    "github.token",
    "secrets.GITHUB_TOKEN",
    "gh api",
  ]) {
    assertWorkflowContractError(
      workflow.replace(
        '            local url="$1"',
        `            local url="$1"\n            # ${forbidden}`,
      ),
      "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
    );
  }
  assertWorkflowContractError(
    workflow.replace("            curl --disable \\", "            curl \\"),
    "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
  );
});

test("requires exact source branch, PR head, and checkout coupling", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "APPROVED_SOURCE_REF: agent/phase13-staging-gate",
      "APPROVED_SOURCE_REF: arbitrary-ref",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(".head.sha == $sha", ".head.sha != $sha"),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "repository: modvolt/Site-Logbook",
      "repository: untrusted/fork",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("public_source_api()", "public_repository_api()"),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "            public_source_api \\",
      "            gh api \\",
    ),
    "STAGING_IMAGE_SOURCE_AUTH_BOUNDARY_BROKEN",
  );
});

test("requires a successful exact-SHA pull-request Quality gate", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace('.conclusion == "success"', '.conclusion != "failure"'),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "actions/workflows/quality-gate.yml/runs?head_sha=${SOURCE_SHA}&event=pull_request&status=completed",
      "actions/workflows/quality-gate.yml/runs?per_page=100",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
});

test("requires a private caller and private package verification", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "APPROVED_CALLER_REPOSITORY: modvolt/site-logbook-registry",
      "APPROVED_CALLER_REPOSITORY: modvolt/untrusted-private-repo",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(".private == true", ".private != false"),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Verify first published package is private before continuing",
      "Continue after first package without checking privacy",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Verify all published packages remain private",
      "Inspect published package metadata",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}",
      "org.opencontainers.image.source=https://github.com/modvolt/Site-Logbook",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "org.opencontainers.image.url=https://github.com/modvolt/Site-Logbook/commit/${{ inputs.source_sha }}",
      "org.opencontainers.image.url=https://github.com/modvolt/Site-Logbook",
    ),
    "STAGING_IMAGE_SOURCE_GUARD_MISSING",
  );
});

test("requires strict digest namespace and provenance guards", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      '[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
      '[[ -n "$digest" ]]',
    ),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "^ghcr\\\\.io/modvolt/site-logbook-staging-api@sha256:[0-9a-f]{64}$",
      "^ghcr\\\\.io/[^/]+/site-logbook-staging-api@sha256:.*$",
    ),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "          provenance: mode=max",
      "          provenance: false",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("          sbom: true", "          sbom: false"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
});

test("requires all four images to remain linux/amd64", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "          platforms: linux/amd64",
      "          platforms: linux/arm64",
    ),
    "STAGING_IMAGE_PLATFORM_DRIFT",
  );
});
