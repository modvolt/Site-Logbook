import assert from "node:assert/strict";
import test from "node:test";
import {
  dockerIsolationArgs,
  extractQuotedHeredoc,
  parseWorkflow,
  readWorkflow,
  requireRunScript,
  resolveContainerUser,
  runBashHarness,
} from "../workflow-execution-harness.mjs";

const SOURCE_SHA = "6dddd64676631fffca6aef9baf74d79b127f8a01";
const PREDECESSOR_SOURCE_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const PACKAGE_NAMES = [
  "site-logbook-staging-preflight",
  "site-logbook-staging-mailpit",
  "site-logbook-staging-api",
  "site-logbook-staging-web",
  "site-logbook-staging-alert-receiver",
];
const ROOT_DIGESTS = PACKAGE_NAMES.map(
  (_, index) => `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
);
const RUNNABLE_DIGEST = `sha256:${"e".repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${"f".repeat(64)}`;
const workflow = readWorkflow();
const predecessorWorkflow = readWorkflow(
  ".github/workflows/staging-predecessor-image.yml",
);
const predecessorScripts = Object.fromEntries(
  Object.values(predecessorWorkflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.run === "string")
    .map((step, index) => [
      `scripts/predecessor-${String(index + 1).padStart(2, "0")}.sh`,
      step.run,
    ]),
);
const metadataCredentialScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Require dedicated read-only Packages metadata credential",
);
const predecessorMetadataCredentialScript = requireRunScript(
  predecessorWorkflow,
  "publish-fixed-predecessor-api",
  "Require dedicated read-only Packages metadata credential",
);
const predecessorPackageStateScript = requireRunScript(
  predecessorWorkflow,
  "publish-fixed-predecessor-api",
  "Require approved private manual caller and exact tag state",
);
const predecessorRemoteVerifierScript = requireRunScript(
  predecessorWorkflow,
  "publish-fixed-predecessor-api",
  "Verify private exact-digest predecessor package and attestations",
);
const predecessorEvidenceScript = requireRunScript(
  predecessorWorkflow,
  "publish-fixed-predecessor-api",
  "Create secret-free fixed predecessor publication evidence",
);
const packageStateScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Require private caller and exact staged package state",
);
const verifierSetupScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Configure fail-closed private package verifier",
);
const absenceScript = extractQuotedHeredoc(
  verifierSetupScript,
  "ABSENCE_SCRIPT",
);
const verifierScript = extractQuotedHeredoc(
  verifierSetupScript,
  "VERIFY_SCRIPT",
);

const MOCK_GH = `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${!#}"
case "$endpoint" in
  /user)
    [[ "\${MOCK_IDENTITY_FAIL:-false}" != "true" ]] || exit 72
    cat <<EOF
HTTP/2.0 200 OK
X-OAuth-Scopes: \${MOCK_OAUTH_SCOPES:-read:packages}

{"login":"\${MOCK_LOGIN:-modvolt}","id":\${MOCK_USER_ID:-289280891},"type":"\${MOCK_USER_TYPE:-User}"}
EOF
    ;;
  repos/modvolt/site-logbook-registry)
    cat "$HARNESS_ROOT/fixtures/caller.json"
    ;;
  "/user/packages?package_type=container&visibility=private&per_page=100")
    [[ "\${MOCK_INVENTORY_FAIL:-false}" != "true" ]] || exit 73
    cat "$HARNESS_ROOT/fixtures/inventory.json"
    ;;
  /user/packages/container/*/versions?per_page=100)
    package="\${endpoint#/user/packages/container/}"
    package="\${package%%/*}"
    [[ "\${MOCK_VERSIONS_FAIL_FOR:-}" != "$package" ]] || exit 74
    cat "$HARNESS_ROOT/fixtures/versions-$package.json"
    ;;
  /user/packages/container/*)
    package="\${endpoint#/user/packages/container/}"
    [[ "\${MOCK_PACKAGE_FAIL_FOR:-}" != "$package" ]] || exit 75
    cat "$HARNESS_ROOT/fixtures/package-$package.json"
    ;;
  *)
    echo "Unexpected mocked gh endpoint: $endpoint" >&2
    exit 76
    ;;
esac
`;

const MOCK_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"{{json .Manifest}}"*) cat "$HARNESS_ROOT/fixtures/manifest.json" ;;
  *"{{json .Provenance}}"*) cat "$HARNESS_ROOT/fixtures/provenance.json" ;;
  *"{{json .SBOM}}"*) cat "$HARNESS_ROOT/fixtures/sbom.json" ;;
  *) echo "Unexpected mocked docker call: $*" >&2; exit 77 ;;
esac
`;

const MOCK_SLEEP = `#!/usr/bin/env sh
exit 0
`;

const PREDECESSOR_MOCK_GH = `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${!#}"
printf '%s\n' "$endpoint" >> "$HARNESS_ROOT/predecessor-gh-api-calls.txt"
case "$endpoint" in
  repos/modvolt/site-logbook-registry)
    cat "$HARNESS_ROOT/fixtures/predecessor-caller.json"
    ;;
  "/user/packages?package_type=container&visibility=private&per_page=100")
    cat "$HARNESS_ROOT/fixtures/predecessor-inventory.json"
    ;;
  "/user/packages/container/site-logbook-staging-api/versions?state=active&per_page=100")
    cat "$HARNESS_ROOT/fixtures/predecessor-versions.json"
    ;;
  "/user/packages/container/site-logbook-staging-api/versions?state=deleted&per_page=100")
    [[ "\${MOCK_DELETED_VERSIONS_FORBIDDEN:-false}" != "true" ]] || exit 79
    cat "$HARNESS_ROOT/fixtures/predecessor-deleted-versions.json"
    ;;
  "/user/packages/container/site-logbook-staging-api/versions/9911")
    cat "$HARNESS_ROOT/fixtures/predecessor-selected-version.json"
    ;;
  "/user/packages/container/site-logbook-staging-api")
    cat "$HARNESS_ROOT/fixtures/predecessor-package.json"
    ;;
  *)
    echo "Unexpected predecessor gh endpoint: $endpoint" >&2
    exit 78
    ;;
esac
`;

const PREDECESSOR_MOCK_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$HARNESS_ROOT/predecessor-docker-calls.txt"
case "$*" in
  *"{{json .Manifest}}"*) cat "$HARNESS_ROOT/fixtures/predecessor-manifest.json" ;;
  *"{{json .Image}}"*) cat "$HARNESS_ROOT/fixtures/predecessor-image.json" ;;
  *"{{json .Provenance}}"*) cat "$HARNESS_ROOT/fixtures/predecessor-provenance.json" ;;
  *"{{json .SBOM}}"*) cat "$HARNESS_ROOT/fixtures/predecessor-sbom.json" ;;
  *) echo "Unexpected predecessor docker call: $*" >&2; exit 80 ;;
esac
`;

function packageMetadata(name, index) {
  return {
    id: 1000 + index,
    name,
    package_type: "container",
    owner: { login: "modvolt" },
    visibility: "private",
    repository: {
      full_name: "modvolt/site-logbook-registry",
      private: true,
    },
    version_count: 1,
  };
}

function packageVersion(index, tags = [SOURCE_SHA]) {
  return {
    id: 2000 + index,
    name: ROOT_DIGESTS[index],
    metadata: { container: { tags } },
  };
}

function baseFixtureFiles() {
  return {
    "bin/gh": MOCK_GH,
    "fixtures/caller.json": JSON.stringify({
      full_name: "modvolt/site-logbook-registry",
      owner: { login: "modvolt" },
      private: true,
    }),
  };
}

function stateFixtureFiles(state) {
  const files = baseFixtureFiles();
  const inventory = [];
  PACKAGE_NAMES.forEach((name, index) => {
    const metadata = packageMetadata(name, index);
    inventory.push(metadata);
    files[`fixtures/package-${name}.json`] = JSON.stringify(metadata);
    const present = state[index] === "1";
    files[`fixtures/versions-${name}.json`] = JSON.stringify([
      present
        ? packageVersion(index)
        : packageVersion(index, ["another-source-sha"]),
    ]);
  });
  files["fixtures/inventory.json"] = JSON.stringify(inventory);
  return files;
}

function commonEnvironment() {
  return {
    APPROVED_CALLER_REPOSITORY: "modvolt/site-logbook-registry",
    CALLER_GITHUB_TOKEN: "mock-caller-token-not-a-secret",
    CALLER_REPOSITORY: "modvolt/site-logbook-registry",
    CALLER_REPOSITORY_OWNER: "modvolt",
    GH_TOKEN: "mock-token-not-a-secret",
    HARNESS_ROOT: "{HARNESS_ROOT}",
    PRIVATE_REGISTRY_OWNER: "modvolt",
    PUBLICATION_CONFIRMED: "true",
    SOURCE_SHA,
  };
}

function runMetadataCredential(script, environment = {}) {
  return runBashHarness({
    script,
    files: baseFixtureFiles(),
    environment: {
      GH_TOKEN: "mock-read-packages-token-not-a-secret",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      REGISTRY_GITHUB_TOKEN: "mock-registry-token-not-a-secret",
      ...environment,
    },
  });
}

function runPredecessorPackageState({
  deletedVersionsForbidden = false,
  present,
  verifyExistingOnly,
}) {
  const digest = `sha256:${"c".repeat(64)}`;
  const packageJson = {
    id: 8811,
    name: "site-logbook-staging-api",
    package_type: "container",
    owner: { login: "modvolt" },
    visibility: "private",
    repository: {
      full_name: "modvolt/site-logbook-registry",
      private: true,
    },
    version_count: 1,
  };
  const versionJson = {
    id: 9911,
    name: digest,
    metadata: {
      package_type: "container",
      container: {
        tags: present ? [PREDECESSOR_SOURCE_SHA] : ["other-source"],
      },
    },
  };
  return runBashHarness({
    script: predecessorPackageStateScript,
    files: {
      "bin/gh": PREDECESSOR_MOCK_GH,
      "fixtures/predecessor-caller.json": JSON.stringify({
        full_name: "modvolt/site-logbook-registry",
        owner: { login: "modvolt" },
        private: true,
      }),
      "fixtures/predecessor-inventory.json": JSON.stringify(
        present ? [packageJson] : [],
      ),
      "fixtures/predecessor-package.json": JSON.stringify(packageJson),
      "fixtures/predecessor-versions.json": JSON.stringify([versionJson]),
      "fixtures/predecessor-deleted-versions.json": "[]",
      "fixtures/predecessor-selected-version.json": JSON.stringify(versionJson),
    },
    environment: {
      APPROVED_CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      APPROVED_CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
      CALLER_ACTOR: "modvolt",
      CALLER_GITHUB_TOKEN: "mock-caller-token-not-a-secret",
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_REPOSITORY_OWNER: "modvolt",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
      EXPECTED_SOURCE_SHA: PREDECESSOR_SOURCE_SHA,
      GH_TOKEN: "mock-read-packages-token-not-a-secret",
      GITHUB_OUTPUT: "{HARNESS_ROOT}/github-output.txt",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      PACKAGE_NAME: "site-logbook-staging-api",
      MOCK_DELETED_VERSIONS_FORBIDDEN: deletedVersionsForbidden
        ? "true"
        : "false",
      PUBLICATION_CONFIRMED: "true",
      TRIGGERING_ACTOR: "modvolt",
      VERIFY_EXISTING_ONLY: verifyExistingOnly ? "true" : "false",
    },
    captureFiles: ["github-output.txt", "predecessor-gh-api-calls.txt"],
  });
}

function runPredecessorRemoteVerifier({
  deletedVersionsForbidden = false,
  provenanceDockerfileDirectory = "artifacts/api-server",
  verifyExistingOnly,
}) {
  const digest = `sha256:${"c".repeat(64)}`;
  const runnableDigest = `sha256:${"d".repeat(64)}`;
  const packageJson = {
    id: 8811,
    name: "site-logbook-staging-api",
    package_type: "container",
    owner: { login: "modvolt" },
    visibility: "private",
    repository: {
      full_name: "modvolt/site-logbook-registry",
      private: true,
    },
    version_count: 1,
  };
  const versionJson = {
    id: 9911,
    name: digest,
    metadata: {
      package_type: "container",
      container: { tags: [PREDECESSOR_SOURCE_SHA] },
    },
  };
  return runBashHarness({
    script: predecessorRemoteVerifierScript,
    files: {
      "bin/docker": PREDECESSOR_MOCK_DOCKER,
      "bin/gh": PREDECESSOR_MOCK_GH,
      "bin/sleep": MOCK_SLEEP,
      "fixtures/predecessor-package.json": JSON.stringify(packageJson),
      "fixtures/predecessor-versions.json": JSON.stringify([versionJson]),
      "fixtures/predecessor-deleted-versions.json": "[]",
      "fixtures/predecessor-selected-version.json": JSON.stringify(versionJson),
      "fixtures/predecessor-manifest.json": JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest,
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            size: 123,
            digest: runnableDigest,
            platform: { os: "linux", architecture: "amd64" },
          },
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            size: 456,
            digest: `sha256:${"e".repeat(64)}`,
            annotations: {
              "vnd.docker.reference.type": "attestation-manifest",
              "vnd.docker.reference.digest": runnableDigest,
            },
            platform: { os: "unknown", architecture: "unknown" },
          },
        ],
      }),
      "fixtures/predecessor-image.json": JSON.stringify({
        architecture: "amd64",
        os: "linux",
        config: {
          Labels: {
            "org.opencontainers.image.source":
              "https://github.com/modvolt/Site-Logbook",
            "org.opencontainers.image.revision": PREDECESSOR_SOURCE_SHA,
            "org.opencontainers.image.url": `https://github.com/modvolt/Site-Logbook/commit/${PREDECESSOR_SOURCE_SHA}`,
          },
          Env: [`BUILD_SHA=${PREDECESSOR_SOURCE_SHA}`],
        },
      }),
      "fixtures/predecessor-provenance.json": JSON.stringify({
        SLSA: {
          buildType: "https://mobyproject.org/buildkit@v1",
          invocation: {
            environment: { platform: "linux/amd64" },
            configSource: { entryPoint: "Dockerfile" },
            parameters: {
              args: { "build-arg:BUILD_SHA": PREDECESSOR_SOURCE_SHA },
              root: {
                configSource: { path: "Dockerfile" },
                request: {
                  args: {
                    "vcs:localdir:context": ".",
                    "vcs:localdir:dockerfile": provenanceDockerfileDirectory,
                    "vcs:revision": PREDECESSOR_SOURCE_SHA,
                    "vcs:source": "https://github.com/modvolt/Site-Logbook",
                  },
                },
              },
            },
          },
          metadata: {
            completeness: { parameters: true, environment: true },
            "https://mobyproject.org/buildkit@v1#metadata": {
              vcs: {
                source: "https://github.com/modvolt/Site-Logbook",
                revision: PREDECESSOR_SOURCE_SHA,
              },
            },
          },
          materials: [
            {
              digest: {
                sha256:
                  "235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
              },
            },
          ],
        },
      }),
      "fixtures/predecessor-sbom.json": JSON.stringify({
        SPDX: {
          SPDXID: "SPDXRef-DOCUMENT",
          dataLicense: "CC0-1.0",
          spdxVersion: "SPDX-2.3",
          documentNamespace: "https://example.invalid/spdx/predecessor",
          creationInfo: {
            created: "2026-08-10T00:00:00Z",
            creators: ["Tool: buildkit"],
          },
          packages: [{ SPDXID: "SPDXRef-Package", name: "api-server" }],
          relationships: [
            {
              spdxElementId: "SPDXRef-DOCUMENT",
              relationshipType: "CONTAINS",
              relatedSpdxElement: "SPDXRef-Package",
            },
          ],
        },
      }),
    },
    environment: {
      EXPECTED_DIGEST: digest,
      EXPECTED_SOURCE_SHA: PREDECESSOR_SOURCE_SHA,
      GH_TOKEN: "mock-read-packages-token-not-a-secret",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      MOCK_DELETED_VERSIONS_FORBIDDEN: deletedVersionsForbidden
        ? "true"
        : "false",
      PACKAGE_NAME: "site-logbook-staging-api",
      REGISTRY_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-api",
      VERIFICATION_ATTEMPTS: "36",
      VERIFICATION_POLL_SECONDS: "5",
      VERIFY_EXISTING_ONLY: verifyExistingOnly ? "true" : "false",
    },
    captureFiles: [
      "predecessor-docker-calls.txt",
      "predecessor-gh-api-calls.txt",
      "predecessor-package.json",
    ],
  });
}

function runPredecessorEvidence({ verifyExistingOnly }) {
  const digest = `sha256:${"c".repeat(64)}`;
  const deletedFields = verifyExistingOnly
    ? {
        deletedInventoryMode: "not-applicable-verify-existing-only",
        visibleDeletedTagConflictChecked: false,
        deletedVersionCount: null,
        deletedHistoryScope: "not-applicable-no-write",
      }
    : {
        deletedInventoryMode: "queried-visible-package-versions",
        visibleDeletedTagConflictChecked: true,
        deletedVersionCount: 0,
        deletedHistoryScope: "visible-package-versions-only",
      };
  return runBashHarness({
    script: predecessorEvidenceScript,
    files: {
      "predecessor-package.json": JSON.stringify({
        packageName: "site-logbook-staging-api",
        packageId: "8811",
        visibility: "private",
        repository: "modvolt/site-logbook-registry",
        registryRepository: "ghcr.io/modvolt/site-logbook-staging-api",
        sourceSha: PREDECESSOR_SOURCE_SHA,
        versionId: "9911",
        digest,
        runnableManifestDigest: `sha256:${"d".repeat(64)}`,
        platform: "linux/amd64",
        activeInventoryPaginated: true,
        activeVersionCount: 1,
        packageVersionCount: 1,
        ...deletedFields,
        selectedVersionRefetched: true,
        remoteManifestVerified: true,
        runtimeMetadata: {
          source: "https://github.com/modvolt/Site-Logbook",
          revision: PREDECESSOR_SOURCE_SHA,
          url: `https://github.com/modvolt/Site-Logbook/commit/${PREDECESSOR_SOURCE_SHA}`,
          buildSha: PREDECESSOR_SOURCE_SHA,
        },
        provenance: {
          buildType: "https://mobyproject.org/buildkit@v1",
          vcsSource: "https://github.com/modvolt/Site-Logbook",
          vcsRevision: PREDECESSOR_SOURCE_SHA,
          dockerfile: "artifacts/api-server/Dockerfile",
          buildSha: PREDECESSOR_SOURCE_SHA,
          baseImageDigest:
            "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
        },
        sbom: {
          spdxVersion: "SPDX-2.3",
          packageCount: 1,
          relationshipCount: 1,
        },
      }),
    },
    environment: {
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
      DIGEST: digest,
      EXPECTED_SOURCE_SHA: PREDECESSOR_SOURCE_SHA,
      EXPECTED_SOURCE_TREE: "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      INITIAL_TAG_STATE: verifyExistingOnly ? "present" : "absent",
      PUBLISHED: verifyExistingOnly ? "false" : "true",
      RUN_ATTEMPT: "1",
      RUN_ID: "31380231076",
      VERIFY_EXISTING_ONLY: verifyExistingOnly ? "true" : "false",
    },
    captureFiles: [
      "staging-predecessor-image.json",
      "staging-predecessor-image.sha256",
    ],
  });
}

function parseGithubOutput(raw) {
  return Object.fromEntries(
    String(raw ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runPackageState(stage, state, options = {}) {
  const files = { ...stateFixtureFiles(state), ...(options.files ?? {}) };
  return runBashHarness({
    script: packageStateScript,
    files,
    environment: {
      ...commonEnvironment(),
      EXPECTED_PREFLIGHT_DIGEST:
        options.expectedPreflightDigest ??
        (stage === "complete" ? ROOT_DIGESTS[0] : ""),
      GITHUB_OUTPUT: "{HARNESS_ROOT}/github-output.txt",
      PUBLICATION_STAGE: stage,
      ...(options.environment ?? {}),
    },
    captureFiles: ["github-output.txt"],
  });
}

function runAbsenceCheck(packageName, files, environment = {}) {
  return runBashHarness({
    script: absenceScript,
    args: [packageName],
    files: { ...baseFixtureFiles(), ...files },
    environment: {
      GH_TOKEN: "mock-token-not-a-secret",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      SOURCE_SHA,
      ...environment,
    },
  });
}

function validRemoteFixtureFiles(packageName = PACKAGE_NAMES[0]) {
  const index = PACKAGE_NAMES.indexOf(packageName);
  const metadata = packageMetadata(packageName, index);
  return {
    ...baseFixtureFiles(),
    "bin/docker": MOCK_DOCKER,
    "bin/sleep": MOCK_SLEEP,
    "fixtures/inventory.json": JSON.stringify([metadata]),
    [`fixtures/package-${packageName}.json`]: JSON.stringify(metadata),
    [`fixtures/versions-${packageName}.json`]: JSON.stringify([
      packageVersion(index),
    ]),
    "fixtures/manifest.json": JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: ROOT_DIGESTS[index],
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: RUNNABLE_DIGEST,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: ATTESTATION_DIGEST,
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": RUNNABLE_DIGEST,
          },
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    }),
    "fixtures/provenance.json": JSON.stringify({
      SLSA: {
        buildType: "https://mobyproject.org/buildkit@v1",
        invocation: { environment: { platform: "linux/amd64" } },
      },
    }),
    "fixtures/sbom.json": JSON.stringify({
      SPDX: { SPDXID: "SPDXRef-DOCUMENT", spdxVersion: "SPDX-2.3" },
    }),
  };
}

function runVerifier({ files = {}, packageName = PACKAGE_NAMES[0] } = {}) {
  const index = PACKAGE_NAMES.indexOf(packageName);
  return runBashHarness({
    script: verifierScript,
    args: [packageName, ROOT_DIGESTS[index], "{HARNESS_ROOT}/evidence.json"],
    files: { ...validRemoteFixtureFiles(packageName), ...files },
    environment: {
      GH_TOKEN: "mock-token-not-a-secret",
      HARNESS_ROOT: "{HARNESS_ROOT}",
      SOURCE_SHA,
    },
    captureFiles: ["evidence.json"],
  });
}

test("parses the workflow as strict unique-key YAML and exposes the exact interface", () => {
  assert.deepEqual(workflow.on.workflow_call.inputs.publication_stage, {
    description: "Explicit two-stage gate (preflight-only or complete)",
    required: true,
    type: "string",
  });
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs["publish-staging-images"].permissions, {
    contents: "read",
    packages: "write",
  });
  assert.deepEqual(workflow.on.workflow_call.secrets.packages_metadata_token, {
    description:
      "Dedicated classic PAT with exactly read:packages for private Packages REST metadata",
    required: true,
  });
  assert.deepEqual(
    predecessorWorkflow.on.workflow_call.secrets.packages_metadata_token,
    {
      description:
        "Dedicated classic PAT with exactly read:packages for private Packages REST metadata",
      required: true,
    },
  );
  assert.deepEqual(
    predecessorWorkflow.on.workflow_call.inputs.verify_existing_only,
    {
      description:
        "Require the exact predecessor tag to exist and structurally disable every build or push step",
      required: true,
      type: "boolean",
    },
  );
  const predecessorPublicationSteps = predecessorWorkflow.jobs[
    "publish-fixed-predecessor-api"
  ].steps.filter((step) =>
    [
      "Validate predecessor API build without registry write",
      "Recheck exact predecessor tag absence immediately before publication",
      "Build and publish fixed predecessor API image",
    ].includes(step.name),
  );
  assert.equal(predecessorPublicationSteps.length, 3);
  assert.ok(
    predecessorPublicationSteps.every(
      (step) =>
        step.if ===
        "inputs.verify_existing_only == false && steps.package-state.outputs.publish == 'true'",
    ),
  );
  assert.throws(
    () => parseWorkflow("name: duplicate\npermissions: {}\npermissions: {}\n"),
    /unique-key YAML|Map keys must be unique/u,
  );
});

test("accepts only a distinct exact-scope modvolt Packages metadata credential", () => {
  for (const script of [
    metadataCredentialScript,
    predecessorMetadataCredentialScript,
  ]) {
    const accepted = runMetadataCredential(script);
    assert.equal(accepted.status, 0, accepted.stderr);

    const missing = runMetadataCredential(script, { GH_TOKEN: "" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /metadata credential is required/u);

    const reused = runMetadataCredential(script, {
      GH_TOKEN: "same-token",
      REGISTRY_GITHUB_TOKEN: "same-token",
    });
    assert.notEqual(reused.status, 0);
    assert.match(reused.stderr, /must be distinct from GITHUB_TOKEN/u);

    const broad = runMetadataCredential(script, {
      MOCK_OAUTH_SCOPES: "read:packages, repo",
    });
    assert.notEqual(broad.status, 0);
    assert.match(broad.stderr, /exactly the read:packages scope/u);

    const wrongOwner = runMetadataCredential(script, {
      MOCK_LOGIN: "attacker",
    });
    assert.notEqual(wrongOwner.status, 0);
    assert.match(wrongOwner.stderr, /exact modvolt user/u);

    const wrongId = runMetadataCredential(script, { MOCK_USER_ID: "1" });
    assert.notEqual(wrongId.status, 0);
    assert.match(wrongId.stderr, /exact modvolt user/u);

    const unsupported = runMetadataCredential(script, {
      MOCK_IDENTITY_FAIL: "true",
    });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /identity could not be read/u);
  }
});

test("makes fixed predecessor verify-existing-only fail closed before every publish step", () => {
  const exactExisting = runPredecessorPackageState({
    present: true,
    verifyExistingOnly: true,
  });
  assert.equal(exactExisting.status, 0, exactExisting.stderr);
  assert.deepEqual(
    parseGithubOutput(exactExisting.captured["github-output.txt"]),
    {
      existing_digest: `sha256:${"c".repeat(64)}`,
      initial_tag_state: "present",
      publish: "false",
    },
  );
  assert.doesNotMatch(
    exactExisting.captured["predecessor-gh-api-calls.txt"],
    /state=deleted/u,
  );

  const exactExistingWithForbiddenDeletedEndpoint = runPredecessorPackageState({
    deletedVersionsForbidden: true,
    present: true,
    verifyExistingOnly: true,
  });
  assert.equal(
    exactExistingWithForbiddenDeletedEndpoint.status,
    0,
    exactExistingWithForbiddenDeletedEndpoint.stderr,
  );
  assert.doesNotMatch(
    exactExistingWithForbiddenDeletedEndpoint.captured[
      "predecessor-gh-api-calls.txt"
    ],
    /state=deleted/u,
  );

  const absentVerifyOnly = runPredecessorPackageState({
    present: false,
    verifyExistingOnly: true,
  });
  assert.notEqual(absentVerifyOnly.status, 0);
  assert.match(
    absentVerifyOnly.stderr,
    /verify-existing-only requires an already-present exact predecessor tag and forbids publication/u,
  );

  const absentPublication = runPredecessorPackageState({
    present: false,
    verifyExistingOnly: false,
  });
  assert.equal(absentPublication.status, 0, absentPublication.stderr);
  assert.equal(
    parseGithubOutput(absentPublication.captured["github-output.txt"]).publish,
    "true",
  );

  const presentPublicationWithForbiddenDeletedEndpoint =
    runPredecessorPackageState({
      deletedVersionsForbidden: true,
      present: true,
      verifyExistingOnly: false,
    });
  assert.notEqual(presentPublicationWithForbiddenDeletedEndpoint.status, 0);
  assert.match(
    presentPublicationWithForbiddenDeletedEndpoint.stderr,
    /deleted staging API package versions could not be read/u,
  );
  assert.match(
    presentPublicationWithForbiddenDeletedEndpoint.captured[
      "predecessor-gh-api-calls.txt"
    ],
    /state=deleted/u,
  );
});

test("skips deleted-version REST reads in final verify-only inspection but retains the publication gate", () => {
  const verifyOnly = runPredecessorRemoteVerifier({
    deletedVersionsForbidden: true,
    verifyExistingOnly: true,
  });
  assert.equal(verifyOnly.status, 0, verifyOnly.stderr);
  assert.doesNotMatch(
    verifyOnly.stderr,
    /DELETED_VERSION_INVENTORY_NOT_READY/u,
  );
  assert.doesNotMatch(
    verifyOnly.captured["predecessor-gh-api-calls.txt"],
    /state=deleted/u,
  );

  const publicationCapable = runPredecessorRemoteVerifier({
    deletedVersionsForbidden: true,
    verifyExistingOnly: false,
  });
  assert.notEqual(publicationCapable.status, 0);
  assert.match(
    publicationCapable.stderr,
    /DELETED_VERSION_INVENTORY_NOT_READY/u,
  );
  assert.match(
    publicationCapable.captured["predecessor-gh-api-calls.txt"],
    /state=deleted/u,
  );
});

test("accepts the observed split predecessor Dockerfile provenance path", () => {
  const result = runPredecessorRemoteVerifier({
    verifyExistingOnly: true,
  });
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${result.captured["predecessor-docker-calls.txt"]}`,
  );
  const evidence = JSON.parse(result.captured["predecessor-package.json"]);
  assert.equal(
    evidence.provenance.dockerfile,
    "artifacts/api-server/Dockerfile",
  );

  const directoryDrift = runPredecessorRemoteVerifier({
    provenanceDockerfileDirectory: "artifacts/stavba",
    verifyExistingOnly: true,
  });
  assert.notEqual(directoryDrift.status, 0);
  assert.match(directoryDrift.stderr, /PROVENANCE_NOT_READY/u);
});

test("emits mode-bound schema v3 evidence without a false deleted-version claim", () => {
  const verifyOnly = runPredecessorEvidence({ verifyExistingOnly: true });
  assert.equal(verifyOnly.status, 0, verifyOnly.stderr);
  const verifyOnlyManifest = JSON.parse(
    verifyOnly.captured["staging-predecessor-image.json"],
  );
  assert.equal(verifyOnlyManifest.schemaVersion, 3);
  assert.equal(verifyOnlyManifest.executionMode, "verify-existing-only");
  assert.equal(verifyOnlyManifest.registryAction, "verified-noop");
  assert.equal(
    verifyOnlyManifest.package.deletedInventoryMode,
    "not-applicable-verify-existing-only",
  );
  assert.equal(
    verifyOnlyManifest.package.visibleDeletedTagConflictChecked,
    false,
  );
  assert.equal(verifyOnlyManifest.package.deletedVersionCount, null);

  const publicationCapable = runPredecessorEvidence({
    verifyExistingOnly: false,
  });
  assert.equal(publicationCapable.status, 0, publicationCapable.stderr);
  const publicationManifest = JSON.parse(
    publicationCapable.captured["staging-predecessor-image.json"],
  );
  assert.equal(publicationManifest.schemaVersion, 3);
  assert.equal(publicationManifest.executionMode, "publication-capable");
  assert.equal(publicationManifest.registryAction, "published");
  assert.equal(
    publicationManifest.package.deletedInventoryMode,
    "queried-visible-package-versions",
  );
  assert.equal(
    publicationManifest.package.visibleDeletedTagConflictChecked,
    true,
  );
  assert.equal(publicationManifest.package.deletedVersionCount, 0);
});

test("runs extracted scripts in a scrubbed, no-egress container", () => {
  assert.deepEqual(dockerIsolationArgs().slice(0, 2), ["--network", "none"]);
  assert.ok(dockerIsolationArgs().includes("--read-only"));
  assert.ok(dockerIsolationArgs().includes("no-new-privileges"));
  const result = runBashHarness({
    script: `set -euo pipefail
[[ -z "\${DATABASE_URL+x}" ]]
if wget -q -T 1 -O /dev/null http://192.0.2.1; then
  echo "Network access unexpectedly succeeded." >&2
  exit 1
fi
`,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("maps a POSIX harness to the owner of its private bind mount", () => {
  assert.equal(
    resolveContainerUser({
      platform: "linux",
      getuid: () => 1001,
      getgid: () => 121,
    }),
    "1001:121",
  );
  assert.equal(resolveContainerUser({ platform: "win32" }), null);
  assert.throws(
    () =>
      resolveContainerUser({
        platform: "linux",
        getuid: null,
        getgid: null,
      }),
    /numeric host UID and GID/u,
  );
});

test("accepts a genuinely empty inventory for first publication", () => {
  const result = runPackageState("preflight-only", "00000", {
    files: { "fixtures/inventory.json": "[]" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = parseGithubOutput(result.captured["github-output.txt"]);
  assert.equal(output.state, "00000");
  assert.equal(output.publish_preflight, "true");
  assert.equal(output.publish_remaining, "false");
});

test("shellcheck accepts the exact extracted workflow scripts", () => {
  const result = runBashHarness({
    script: `set -euo pipefail
shellcheck --shell=bash scripts/metadata-credential.sh scripts/package-state.sh scripts/tag-absence.sh scripts/package-verifier.sh
`,
    files: {
      "scripts/metadata-credential.sh": metadataCredentialScript,
      "scripts/package-state.sh": packageStateScript,
      "scripts/tag-absence.sh": absenceScript,
      "scripts/package-verifier.sh": verifierScript,
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("shellcheck accepts every fixed predecessor publisher script", () => {
  const scripts = Object.keys(predecessorScripts).join(" ");
  const result = runBashHarness({
    script: `set -euo pipefail
shellcheck --shell=bash ${scripts}
`,
    files: predecessorScripts,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("executes all 64 stage and exact-SHA package-state combinations fail-closed", () => {
  const allowed = new Map([
    ["preflight-only:00000", ["true", "false"]],
    ["preflight-only:10000", ["false", "false"]],
    ["complete:10000", ["false", "true"]],
    ["complete:11111", ["false", "false"]],
  ]);
  for (const stage of ["preflight-only", "complete"]) {
    for (let value = 0; value < 32; value += 1) {
      const state = value.toString(2).padStart(5, "0");
      const key = `${stage}:${state}`;
      const result = runPackageState(stage, state);
      if (!allowed.has(key)) {
        assert.notEqual(result.status, 0, `${key} unexpectedly passed`);
        assert.match(
          result.stderr,
          /partial recovery requires a separate review/u,
          key,
        );
        continue;
      }
      assert.equal(result.status, 0, `${key}: ${result.stderr}`);
      const output = parseGithubOutput(result.captured["github-output.txt"]);
      assert.equal(output.state, state, key);
      assert.deepEqual(
        [output.publish_preflight, output.publish_remaining],
        allowed.get(key),
        key,
      );
    }
  }
});

test("rejects malformed, duplicate, untrusted, or unavailable package metadata", () => {
  const malformed = runPackageState("preflight-only", "00000", {
    files: { "fixtures/inventory.json": JSON.stringify({ not: "an array" }) },
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /inventory is malformed/u);

  const duplicateMetadata = packageMetadata(PACKAGE_NAMES[0], 0);
  const duplicate = runPackageState("preflight-only", "00000", {
    files: {
      "fixtures/inventory.json": JSON.stringify([
        duplicateMetadata,
        duplicateMetadata,
      ]),
    },
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate package metadata/u);

  const caller = runPackageState("preflight-only", "00000", {
    files: {
      "fixtures/caller.json": JSON.stringify({
        full_name: "modvolt/site-logbook-registry",
        owner: { login: "modvolt" },
        private: false,
      }),
    },
  });
  assert.notEqual(caller.status, 0);
  assert.match(caller.stderr, /caller repository must be private/u);

  const unavailable = runPackageState("preflight-only", "00000", {
    environment: { MOCK_INVENTORY_FAIL: "true" },
  });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /inventory could not be read/u);

  const publicPackage = packageMetadata(PACKAGE_NAMES[0], 0);
  publicPackage.visibility = "public";
  const untrustedWithoutExactTag = runPackageState("preflight-only", "00000", {
    files: {
      [`fixtures/package-${PACKAGE_NAMES[0]}.json`]:
        JSON.stringify(publicPackage),
    },
  });
  assert.notEqual(untrustedWithoutExactTag.status, 0);
  assert.match(
    untrustedWithoutExactTag.stderr,
    /not private.*approved private caller/u,
  );
});

test("rejects duplicate exact tags and a complete-stage digest mismatch", () => {
  const duplicateTag = runPackageState("preflight-only", "10000", {
    files: {
      [`fixtures/versions-${PACKAGE_NAMES[0]}.json`]: JSON.stringify([
        packageVersion(0),
        { ...packageVersion(0), id: 2999 },
      ]),
    },
  });
  assert.notEqual(duplicateTag.status, 0);
  assert.match(duplicateTag.stderr, /exact source tag.*not unique/u);

  const digestMismatch = runPackageState("complete", "10000", {
    expectedPreflightDigest: `sha256:${"9".repeat(64)}`,
  });
  assert.notEqual(digestMismatch.status, 0);
  assert.match(digestMismatch.stderr, /approved preflight digest/u);
});

test("executes the immediate tag-absence guard and catches a TOCTOU tag appearance", () => {
  const absent = runAbsenceCheck(PACKAGE_NAMES[2], {
    "fixtures/inventory.json": "[]",
  });
  assert.equal(absent.status, 0, absent.stderr);

  const metadata = packageMetadata(PACKAGE_NAMES[2], 2);
  const packageWithoutTag = runAbsenceCheck(PACKAGE_NAMES[2], {
    "fixtures/inventory.json": JSON.stringify([metadata]),
    [`fixtures/package-${PACKAGE_NAMES[2]}.json`]: JSON.stringify(metadata),
    [`fixtures/versions-${PACKAGE_NAMES[2]}.json`]: JSON.stringify([
      packageVersion(2, ["another-source-sha"]),
    ]),
  });
  assert.equal(packageWithoutTag.status, 0, packageWithoutTag.stderr);

  const appeared = runAbsenceCheck(PACKAGE_NAMES[2], {
    "fixtures/inventory.json": JSON.stringify([metadata]),
    [`fixtures/package-${PACKAGE_NAMES[2]}.json`]: JSON.stringify(metadata),
    [`fixtures/versions-${PACKAGE_NAMES[2]}.json`]: JSON.stringify([
      packageVersion(2),
    ]),
  });
  assert.notEqual(appeared.status, 0);
  assert.match(appeared.stderr, /appeared before the approved push/u);
});

test("executes remote package, amd64, attestation, provenance, and SBOM verification", () => {
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.captured["evidence.json"]);
  assert.equal(evidence.digest, ROOT_DIGESTS[0]);
  assert.equal(evidence.runnableManifestDigest, RUNNABLE_DIGEST);
  assert.equal(evidence.platform, "linux/amd64");
  assert.equal(evidence.remoteManifestVerified, true);
  assert.equal(evidence.provenanceVerified, true);
  assert.equal(evidence.sbomVerified, true);
});

test("rejects extra runnable platforms and unbound or malformed attestations", () => {
  const base = validRemoteFixtureFiles();
  const wrongRoot = JSON.parse(base["fixtures/manifest.json"]);
  wrongRoot.mediaType = "application/vnd.oci.image.manifest.v1+json";
  const wrongRootType = runVerifier({
    files: { "fixtures/manifest.json": JSON.stringify(wrongRoot) },
  });
  assert.notEqual(wrongRootType.status, 0);

  const wrongRunnable = JSON.parse(base["fixtures/manifest.json"]);
  wrongRunnable.manifests[0].mediaType =
    "application/vnd.oci.image.index.v1+json";
  const wrongRunnableType = runVerifier({
    files: { "fixtures/manifest.json": JSON.stringify(wrongRunnable) },
  });
  assert.notEqual(wrongRunnableType.status, 0);

  const manifest = JSON.parse(base["fixtures/manifest.json"]);
  manifest.manifests.splice(1, 0, {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"1".repeat(64)}`,
    platform: { os: "linux", architecture: "arm64" },
  });
  const extraPlatform = runVerifier({
    files: { "fixtures/manifest.json": JSON.stringify(manifest) },
  });
  assert.notEqual(extraPlatform.status, 0);

  const unboundManifest = JSON.parse(base["fixtures/manifest.json"]);
  unboundManifest.manifests[1].annotations["vnd.docker.reference.digest"] =
    `sha256:${"2".repeat(64)}`;
  const unbound = runVerifier({
    files: { "fixtures/manifest.json": JSON.stringify(unboundManifest) },
  });
  assert.notEqual(unbound.status, 0);

  const mixedBindingManifest = JSON.parse(base["fixtures/manifest.json"]);
  mixedBindingManifest.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"3".repeat(64)}`,
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": `sha256:${"4".repeat(64)}`,
    },
    platform: { os: "unknown", architecture: "unknown" },
  });
  const mixedBinding = runVerifier({
    files: {
      "fixtures/manifest.json": JSON.stringify(mixedBindingManifest),
    },
  });
  assert.notEqual(mixedBinding.status, 0);

  const wrongProvenance = runVerifier({
    files: {
      "fixtures/provenance.json": JSON.stringify({
        SLSA: {
          buildType: "https://mobyproject.org/buildkit@v1",
          invocation: { environment: { platform: "linux/arm64" } },
        },
      }),
    },
  });
  assert.notEqual(wrongProvenance.status, 0);

  const wrongSbom = runVerifier({
    files: {
      "fixtures/sbom.json": JSON.stringify({
        SPDX: { SPDXID: "not-a-document", spdxVersion: "SPDX-2.3" },
      }),
    },
  });
  assert.notEqual(wrongSbom.status, 0);
});

test("keeps every registry push behind an immediate guard and ordered recovery evidence", () => {
  const steps = workflow.jobs["publish-staging-images"].steps;
  const publishIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        String(step.uses ?? "").startsWith("docker/build-push-action@") &&
        step.with?.push === true,
    )
    .map(({ index }) => index);
  assert.equal(publishIndexes.length, PACKAGE_NAMES.length);

  for (const index of publishIndexes) {
    const guard = steps[index - 1];
    const publication = steps[index];
    const packageSuffix = publication.id.replaceAll("_", "-");
    const outputKey = publication.id.replaceAll("-", "_");
    assert.match(
      guard.name,
      /^Recheck .* tag absence immediately before publication$/u,
    );
    assert.match(guard.run, /assert-exact-tag-absent\.sh/u);
    assert.equal(guard.if, publication.if);
    assert.doesNotMatch(String(publication.if ?? ""), /always\s*\(/u);
    assert.ok(![true, "true"].includes(guard["continue-on-error"]));
    assert.ok(![true, "true"].includes(publication["continue-on-error"]));
    assert.match(
      guard.run,
      new RegExp(`site-logbook-staging-${packageSuffix}`, "iu"),
    );
    assert.match(
      String(publication.with.tags),
      new RegExp(`steps\\.names\\.outputs\\.${outputKey}`, "u"),
    );
    assert.match(String(publication.with.tags), /inputs\.source_sha/u);
    const verificationWindow = steps.slice(index + 1, index + 5);
    assert.ok(
      verificationWindow.some((step) =>
        /Verify .*package|Verify first published package/u.test(step.name),
      ),
      `${steps[index].name} must be followed by a package verifier`,
    );
  }

  for (
    let publication = 1;
    publication < publishIndexes.length;
    publication += 1
  ) {
    const between = steps.slice(
      publishIndexes[publication - 1] + 1,
      publishIndexes[publication],
    );
    assert.ok(
      between.some((step) =>
        /Upload .*publication.* evidence/u.test(step.name),
      ),
      `durable evidence must be uploaded before publication ${publication + 1}`,
    );
  }

  const remainingPrebuilds = [
    "Validate Mailpit image build without registry write",
    "Validate API image build without registry write",
    "Validate web image build without registry write",
  ].map((name) => steps.findIndex((step) => step.name === name));
  assert.ok(
    remainingPrebuilds.every(
      (index) => index >= 0 && index < publishIndexes[1],
    ),
  );
});
