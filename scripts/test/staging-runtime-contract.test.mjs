import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  StagingRuntimeContractError,
  classifyStagingPublicationState,
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
  assert.equal(summary.totalCpuLimit, 2.75);
  assert.equal(summary.totalMemoryLimitMiB, 2816);
  assert.equal(summary.immutableCustomImages, 5);
  assert.equal(summary.publicationMode, "private-caller-ghcr-no-deploy");
  assert.equal(
    summary.predecessorPublicationMode,
    "fixed-exact-0104-api-private-caller-no-deploy",
  );
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

test("requires external accounts to stay explicitly disabled before staging starts", () => {
  const compose = source("docker-compose.staging.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "docker-compose.staging.yml": compose.replace(
          "      STAGING_EXTERNAL_ACCOUNTS_ENABLED: ${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
          "",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  const exampleEnv = source(".env.staging.example");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".env.staging.example": exampleEnv.replace(
          "STAGING_EXTERNAL_ACCOUNTS_ENABLED=false",
          "STAGING_EXTERNAL_ACCOUNTS_ENABLED=true",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_EXTERNAL_ACCOUNTS_DARK_ROLLOUT_BROKEN",
  );

  const preflight = source("deploy/staging/preflight/preflight.sh");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "deploy/staging/preflight/preflight.sh": preflight.replace(
          '[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "false" ]',
          '[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "true" ]',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );

  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "deploy/staging/preflight/preflight.sh": preflight.replace(
          "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING",
          "ALLOW_ANY_SCHEMA_CHANGE",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("separates inventory, transition and steady-state restart gates", () => {
  const compose = source("docker-compose.staging.yml");
  for (const [needle, replacement, expectedCode] of [
    [
      "      - dist/external-schema-gate.mjs",
      "      - dist/migrate.mjs",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "        node dist/external-schema-steady-state.mjs &&",
      "        true &&",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      "      STAGING_SCHEMA_ACTION: ${STAGING_SCHEMA_ACTION:?set inspect, apply-0105 or steady-0105}",
      "",
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      '      PORT: "5000"',
      '      PORT: "5000"\n      BUILD_SHA: ${STAGING_BUILD_SHA}',
      "STAGING_API_BUILD_SHA_OVERRIDE_FORBIDDEN",
    ],
    [
      '      PORT: "5000"',
      '      PORT: "5000"\n      STAGING_BACKUP_EVIDENCE_ID: stale-transition-id',
      "STAGING_API_TRANSITION_EVIDENCE_COUPLED",
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "docker-compose.staging.yml": compose.replace(needle, replacement),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }

  const apiBuild = source("artifacts/api-server/build.mjs");
  for (const entrypoint of [
    "external-schema-preflight.ts",
    "external-schema-inventory.ts",
    "external-schema-steady-state.ts",
    "external-schema-gate.ts",
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          "artifacts/api-server/build.mjs": apiBuild.replace(
            `      path.resolve(artifactDir, "src/${entrypoint}"),\n`,
            "",
          ),
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
    );
  }

  const gateRunner = source("artifacts/api-server/src/external-schema-gate.ts");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        "artifacts/api-server/src/external-schema-gate.ts": gateRunner.replace(
          'if (action === "steady-0105")',
          'if (action === "apply-0105")',
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("keeps the external schema preflight in the exact-SHA Quality gate", () => {
  const workflow = source(".github/workflows/quality-gate.yml");
  assert.throws(
    () =>
      validateStagingRuntimeContract({
        ".github/workflows/quality-gate.yml": workflow.replace(
          "pnpm --filter @workspace/db test:external-schema-preflight",
          "true",
        ),
      }),
    (error) =>
      error instanceof StagingRuntimeContractError &&
      error.code === "STAGING_RUNTIME_CONTRACT_MISSING",
  );
});

test("requires exact reviewed Action SHAs in Quality gate and staging smoke", () => {
  const qualityWorkflow = source(".github/workflows/quality-gate.yml");
  const smokeWorkflow = source(".github/workflows/staging-smoke.yml");
  for (const [relativePath, workflow, mutated] of [
    [
      ".github/workflows/quality-gate.yml",
      qualityWorkflow,
      qualityWorkflow.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
    ],
    [
      ".github/workflows/quality-gate.yml",
      qualityWorkflow,
      qualityWorkflow.replace(
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "actions/setup-node@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ],
    [
      ".github/workflows/staging-smoke.yml",
      smokeWorkflow,
      smokeWorkflow.replace(
        "      - run: pnpm install --frozen-lockfile",
        "      - uses: example/unknown-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: pnpm install --frozen-lockfile",
      ),
    ],
    [
      ".github/workflows/staging-smoke.yml",
      smokeWorkflow,
      smokeWorkflow.replace(
        /\n {6}- name: Upload secret-free operational alert drill evidence[\s\S]*? {10}retention-days: 14\n/,
        "\n",
      ),
    ],
  ]) {
    assert.throws(
      () =>
        validateStagingRuntimeContract({
          [relativePath]: mutated,
        }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === "STAGING_WORKFLOW_ACTION_DRIFT",
    );
  }
});

test("keeps predecessor publication fixed to one exact-0104 API image", () => {
  const relativePath = ".github/workflows/staging-predecessor-image.yml";
  const workflow = source(relativePath);
  for (const [mutated, expectedCode] of [
    [
      workflow.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
      "STAGING_WORKFLOW_ACTION_DRIFT",
    ],
    [
      workflow.replaceAll(
        "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(
        "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(
        "site-logbook-staging-api",
        "site-logbook-staging-predecessor-api",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "  workflow_call:",
        "  workflow_dispatch:\n  workflow_call:",
      ),
      "STAGING_PREDECESSOR_SCOPE_WIDENED",
    ],
    [
      workflow.replace("          push: false", "          push: true"),
      "STAGING_PREDECESSOR_PUBLICATION_DRIFT",
    ],
    [
      workflow.replace(
        "          provenance: mode=max,version=v0.2",
        "          provenance: false",
      ),
      "STAGING_PREDECESSOR_PUBLICATION_DRIFT",
    ],
    [
      workflow.replace(
        "          platforms: linux/amd64",
        "          platforms: linux/arm64",
      ),
      "STAGING_PREDECESSOR_PLATFORM_DRIFT",
    ],
    [
      workflow.replace("version: v0.34.1", "version: latest"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
        "moby/buildkit:buildx-stable-1",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '[[ "${#sql_files[@]}" == "104" ]]',
        '[[ "${#sql_files[@]}" == "105" ]]',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("length == 0", "length >= 0"),
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
    ],
    [
      workflow.replaceAll("versions?state=deleted", "versions?state=active"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replaceAll(".version_count >= 0", ".version_count >= -1"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("length == $expected", "length >= 0"),
      "STAGING_PREDECESSOR_INVENTORY_DRIFT",
    ],
    [
      workflow.replace(
        "versions/${selected_version_id}",
        "versions/${EXPECTED_SOURCE_SHA}",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '.SLSA.invocation.parameters.args["build-arg:BUILD_SHA"] == $sha',
        "([.SLSA.invocation.parameters | .. | strings | select(. == $sha)] | length) > 0",
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace("($packages | length) > 0", "($packages | length) >= 0"),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
    [
      workflow.replace(
        '$relationship.relationshipType == "CONTAINS"',
        '$relationship.relationshipType != ""',
      ),
      "STAGING_RUNTIME_CONTRACT_MISSING",
    ],
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) =>
        error instanceof StagingRuntimeContractError &&
        error.code === expectedCode,
    );
  }
});

test("keeps the private predecessor wrapper manual, main-only and commit-pinned", () => {
  const relativePath =
    "docs/audit/16-c3-private-predecessor-wrapper.template.yml";
  const workflow = source(relativePath);
  for (const mutated of [
    workflow.replace("refs/heads/main", "refs/heads/feature"),
    workflow.replace(
      "@e7222e759b4ecf523defa0329d2dfd3fadd2c5eb",
      "@agent/phase16c3-staging-preflight",
    ),
    workflow.replace("packages: write", "packages: read"),
    workflow.replace(
      "    with:\n      confirm_predecessor_registry_publication: true",
      "    secrets: inherit\n    with:\n      confirm_predecessor_registry_publication: true",
    ),
  ]) {
    assert.throws(
      () => validateStagingRuntimeContract({ [relativePath]: mutated }),
      (error) => error instanceof StagingRuntimeContractError,
    );
  }
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
      "APPROVED_SOURCE_REF: agent/phase16c3-staging-preflight",
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
    workflow.replace(
      '.status == "completed" and .conclusion == "success"',
      '.conclusion != "failure"',
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "actions/workflows/quality-gate.yml/runs?head_sha=${SOURCE_SHA}&event=pull_request&per_page=100",
      "actions/workflows/quality-gate.yml/runs?per_page=100",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "sort_by([.run_number, .run_attempt]) |\n             last |",
      "first |",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "any(.pull_requests[]?; .number == $pr)",
      "(.pull_requests | length) >= 0",
    ),
    "STAGING_IMAGE_QUALITY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace('            --argjson pr "$SOURCE_PR_NUMBER" \\\n', ""),
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
    workflow.replaceAll(".private == true", ".private != false"),
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
  assertWorkflowContractError(
    workflow.replaceAll(
      "(.repository.full_name | ascii_downcase) == $caller",
      "(.repository.full_name | ascii_downcase) != $caller",
    ),
    "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
  );
});

test("enforces a fixed two-stage append-only package state gate", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "group: site-logbook-images-publication",
      "group: staging-images-${{ inputs.source_sha }}",
    ),
    "STAGING_IMAGE_CONCURRENCY_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll(
      "if: inputs.publication_stage == 'preflight-only'",
      "if: always()",
    ),
    "STAGING_IMAGE_STAGE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace("preflight-only:00000", "preflight-only:11111"),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "'/user/packages?package_type=container&per_page=100'",
      "'/users/modvolt/packages?package_type=container&per_page=100'",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replaceAll("length == 1 and .[0].name == $digest", "length > 0"),
    "STAGING_IMAGE_DIGEST_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Recheck API tag absence immediately before publication",
      "Skip API tag recheck",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '"${RUNNER_TEMP}/assert-exact-tag-absent.sh" site-logbook-staging-api',
      "true # removed API tag absence check",
    ),
    "STAGING_IMAGE_PACKAGE_STATE_GUARD_MISSING",
  );
});

test("classifies exact-SHA publication states fail-closed", () => {
  const allowed = new Map([
    ["preflight-only:00000", "PUBLISH_PREFLIGHT"],
    ["preflight-only:10000", "VERIFIED_PREFLIGHT_NOOP"],
    ["complete:10000", "PUBLISH_REMAINING"],
    ["complete:11111", "VERIFIED_COMPLETE_NOOP"],
  ]);
  for (const stage of ["preflight-only", "complete"]) {
    for (let value = 0; value < 32; value += 1) {
      const state = value.toString(2).padStart(5, "0");
      const key = `${stage}:${state}`;
      const result = classifyStagingPublicationState(stage, state);
      assert.equal(result.decision, allowed.get(key) ?? "STOP", key);
    }
  }
  assert.equal(
    classifyStagingPublicationState("unexpected", "00000").decision,
    "STOP",
  );
  assert.equal(
    classifyStagingPublicationState("complete", "partial").decision,
    "STOP",
  );
});

test("verifies each remote package before the next publication", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  for (const step of [
    "Verify Mailpit package is private and digest-bound",
    "Verify API package is private and digest-bound",
    "Verify web package is private and digest-bound",
    "Verify alert receiver package is private and digest-bound",
  ]) {
    assertWorkflowContractError(
      workflow.replace(step, "Omit remote package gate"),
      "STAGING_IMAGE_PRIVACY_GUARD_MISSING",
    );
  }
  assertWorkflowContractError(
    workflow.replaceAll("preflight-publication.sha256", "preflight.txt"),
    "STAGING_RUNTIME_CONTRACT_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "Upload API partial-publication recovery evidence",
      "Omit API recovery artifact",
    ),
    "STAGING_IMAGE_RECOVERY_EVIDENCE_ORDER_BROKEN",
  );
  assertWorkflowContractError(
    workflow.replace("          push: false", "          push: true"),
    "STAGING_IMAGE_PUBLICATION_INCOMPLETE",
  );
});

test("requires strict digest namespace and provenance guards", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replaceAll(
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
  assertWorkflowContractError(
    workflow.replace("($runnable | length) == 1", "($runnable | length) >= 1"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(".schemaVersion == 2", ".schemaVersion >= 1"),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      "($attestations | length) == 1",
      "($attestations | length) >= 1",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.annotations["vnd.docker.reference.digest"] == $runnable[0].digest',
      "true",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.SLSA.invocation.environment.platform == "linux/amd64"',
      ".SLSA.invocation.environment.platform != null",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace(
      '.SPDX.SPDXID == "SPDXRef-DOCUMENT"',
      ".SPDX.SPDXID != null",
    ),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
  assertWorkflowContractError(
    workflow.replace('test("^SPDX-[0-9]+\\\\.[0-9]+$")', 'test(".*")'),
    "STAGING_IMAGE_ATTESTATION_MISSING",
  );
});

test("requires all validation and publication builds to remain linux/amd64", () => {
  const workflow = source(".github/workflows/staging-images.yml");
  assertWorkflowContractError(
    workflow.replace(
      "          platforms: linux/amd64",
      "          platforms: linux/arm64",
    ),
    "STAGING_IMAGE_PLATFORM_DRIFT",
  );
});
