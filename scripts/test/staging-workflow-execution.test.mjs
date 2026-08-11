import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  dockerIsolationArgs,
  extractQuotedHeredoc,
  parseWorkflow,
  readWorkflow,
  requireRunScript,
  resolveContainerUser,
  runBashHarness,
  WORKFLOW_HARNESS_IMAGE,
} from "../workflow-execution-harness.mjs";

const SOURCE_SHA = "6dddd64676631fffca6aef9baf74d79b127f8a01";
const CALLER_WORKFLOW_SHA = "1".repeat(40);
const LEDGER_RUN_ID = "31420000001";
const REGISTRY_HISTORY_ACCEPTANCE =
  "ACCEPT_EXTERNAL_LEDGER_RESIDUAL_WITHOUT_DELETED_HISTORY_PROOF_NO_DEPLOY";
const PREDECESSOR_SOURCE_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const PACKAGE_NAMES = [
  "site-logbook-staging-preflight",
  "site-logbook-staging-mailpit",
  "site-logbook-staging-api",
  "site-logbook-staging-web",
  "site-logbook-staging-alert-receiver",
];
const PACKAGE_BUILD_SPECS = [
  {
    dockerfileDir: "deploy/staging/preflight",
    buildArg: "BUILD_SHA",
    buildEnv: "BUILD_SHA",
    baseImageDigests: [
      "sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
    ],
  },
  {
    dockerfileDir: "deploy/staging/mailpit",
    buildArg: "BUILD_SHA",
    buildEnv: "BUILD_SHA",
    baseImageDigests: [
      "sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d",
      "sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
    ],
  },
  {
    dockerfileDir: "artifacts/api-server",
    buildArg: "BUILD_SHA",
    buildEnv: "BUILD_SHA",
    baseImageDigests: [
      "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
    ],
  },
  {
    dockerfileDir: "artifacts/stavba",
    buildArg: "VITE_BUILD_SHA",
    buildEnv: "VITE_BUILD_SHA",
    baseImageDigests: [
      "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
      "sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10",
    ],
  },
  {
    dockerfileDir: "deploy/operational-alert-receiver",
    buildArg: "BUILD_SHA",
    buildEnv: "RECEIVER_BUILD_SHA",
    baseImageDigests: [
      "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
    ],
  },
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
const callerIdentityScript = requireRunScript(
  workflow,
  "validate-public-source",
  "Require exact private manual caller workflow",
);
const registryLedgerScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Require canonical reviewed visible-history registry ledger",
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
const preflightEvidenceScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Create secret-free preflight publication evidence",
);
const completeEvidenceScript = requireRunScript(
  workflow,
  "publish-staging-images",
  "Create and validate secret-free immutable image manifest",
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
  repos/modvolt/site-logbook-registry/git/ref/heads/main)
    cat "$HARNESS_ROOT/fixtures/caller-main.json"
    ;;
  repos/modvolt/site-logbook-registry/actions/runs/*)
    cat "$HARNESS_ROOT/fixtures/current-run.json"
    ;;
  "repos/modvolt/site-logbook-registry/actions/workflows/publish-staging-images.yml/runs?event=workflow_dispatch&per_page=100")
    cat "$HARNESS_ROOT/fixtures/run-history.json"
    ;;
  "/user/packages?package_type=container&visibility=private&per_page=100")
    [[ "\${MOCK_INVENTORY_FAIL:-false}" != "true" ]] || exit 73
    cat "$HARNESS_ROOT/fixtures/inventory.json"
    ;;
  /user/packages/container/*/versions/*)
    package="\${endpoint#/user/packages/container/}"
    package="\${package%%/*}"
    cat "$HARNESS_ROOT/fixtures/selected-$package.json"
    ;;
  "/user/packages/container/"*"/versions?state=active&per_page=100")
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
  *"{{json .Image}}"*) cat "$HARNESS_ROOT/fixtures/image.json" ;;
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

function packageMetadata(name, index, versionCount = 1) {
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
    version_count: versionCount,
  };
}

function packageVersion(index, tags = [SOURCE_SHA]) {
  return {
    id: 2000 + index,
    name: ROOT_DIGESTS[index],
    metadata: { package_type: "container", container: { tags } },
  };
}

function baseFixtureFiles() {
  return {
    "bin/gh": MOCK_GH,
    "fixtures/caller.json": JSON.stringify({
      full_name: "modvolt/site-logbook-registry",
      owner: { login: "modvolt" },
      private: true,
      default_branch: "main",
    }),
    "fixtures/caller-main.json": JSON.stringify({
      ref: "refs/heads/main",
      object: { type: "commit", sha: CALLER_WORKFLOW_SHA },
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
    if (present) {
      files[`fixtures/selected-${name}.json`] = JSON.stringify(
        packageVersion(index),
      );
    }
  });
  files["fixtures/inventory.json"] = JSON.stringify(inventory);
  return files;
}

function registryLedger(stage = "preflight-only", overrides = {}) {
  const complete = stage === "complete";
  const value = {
    deletedHistoryControl: {
      decision: "explicitly-accepted-external-ledger",
      deletedApiQueried: false,
      historicalAbsenceProven: false,
      mode: "reviewed-caller-visible-history-ledger",
    },
    expectedInitialPackageState: complete ? "10000" : "00000",
    kind: "site-logbook-staging-registry-ledger-entry",
    packageNames: [...PACKAGE_NAMES],
    previousEntry: {
      ledgerEntrySha256: complete ? `sha256:${"9".repeat(64)}` : null,
      preflightDigest: complete ? ROOT_DIGESTS[0] : null,
    },
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    stage,
    ...overrides,
  };
  return JSON.stringify(value);
}

function ledgerSha256(ledger) {
  return `sha256:${crypto.createHash("sha256").update(ledger).digest("hex")}`;
}

function callerRun(overrides = {}) {
  return {
    id: Number(LEDGER_RUN_ID),
    run_attempt: 1,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: CALLER_WORKFLOW_SHA,
    path: ".github/workflows/publish-staging-images.yml",
    head_repository: { full_name: "modvolt/site-logbook-registry" },
    status: "in_progress",
    ...overrides,
  };
}

function runRegistryLedger({
  stage = "preflight-only",
  ledger = registryLedger(stage),
  currentRun = callerRun(),
  historyRuns = [callerRun()],
  environment = {},
} = {}) {
  return runBashHarness({
    script: registryLedgerScript,
    files: {
      ...baseFixtureFiles(),
      "fixtures/current-run.json": JSON.stringify(currentRun),
      "fixtures/run-history.json": JSON.stringify({
        total_count: historyRuns.length,
        workflow_runs: historyRuns,
      }),
    },
    environment: {
      CALLER_GITHUB_TOKEN: "mock-caller-token-not-a-secret",
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      CALLER_WORKFLOW_SHA,
      EXPECTED_PREFLIGHT_DIGEST: stage === "complete" ? ROOT_DIGESTS[0] : "",
      GITHUB_OUTPUT: "{HARNESS_ROOT}/github-output.txt",
      GITHUB_RUN_ATTEMPT_VALUE: "1",
      GITHUB_RUN_ID_VALUE: LEDGER_RUN_ID,
      HARNESS_ROOT: "{HARNESS_ROOT}",
      PUBLICATION_STAGE: stage,
      REGISTRY_HISTORY_ACCEPTANCE,
      REGISTRY_LEDGER_JSON: ledger,
      RUNNER_TEMP: "{HARNESS_ROOT}",
      SOURCE_SHA,
      ...environment,
    },
    captureFiles: ["github-output.txt", "staging-registry-ledger-entry.json"],
  });
}

function commonEnvironment() {
  return {
    APPROVED_CALLER_REPOSITORY: "modvolt/site-logbook-registry",
    CALLER_GITHUB_TOKEN: "mock-caller-token-not-a-secret",
    CALLER_REPOSITORY: "modvolt/site-logbook-registry",
    CALLER_REPOSITORY_OWNER: "modvolt",
    CALLER_WORKFLOW_SHA,
    GH_TOKEN: "mock-token-not-a-secret",
    HARNESS_ROOT: "{HARNESS_ROOT}",
    PRIVATE_REGISTRY_OWNER: "modvolt",
    PUBLICATION_CONFIRMED: "true",
    SOURCE_SHA,
  };
}

function runCallerIdentity(environment = {}) {
  return runBashHarness({
    script: callerIdentityScript,
    environment: {
      APPROVED_CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      APPROVED_CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      CALLER_ACTOR: "modvolt",
      CALLER_EVENT_NAME: "workflow_dispatch",
      CALLER_REF: "refs/heads/main",
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_TRIGGERING_ACTOR: "modvolt",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      ...environment,
    },
  });
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
  const previousEntry =
    state === "00000"
      ? { ledgerEntrySha256: null, preflightDigest: null }
      : {
          ledgerEntrySha256: `sha256:${"9".repeat(64)}`,
          preflightDigest: ROOT_DIGESTS[0],
        };
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
      REGISTRY_LEDGER_JSON: registryLedger(stage, {
        expectedInitialPackageState: state,
        previousEntry,
      }),
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
  const spec = PACKAGE_BUILD_SPECS[index];
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
    [`fixtures/selected-${packageName}.json`]: JSON.stringify(
      packageVersion(index),
    ),
    "fixtures/manifest.json": JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: ROOT_DIGESTS[index],
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: RUNNABLE_DIGEST,
          size: 1234,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: ATTESTATION_DIGEST,
          size: 4321,
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": RUNNABLE_DIGEST,
          },
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    }),
    "fixtures/image.json": JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/modvolt/Site-Logbook",
          "org.opencontainers.image.revision": SOURCE_SHA,
          "org.opencontainers.image.url": `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
        },
        Env: [`${spec.buildEnv}=${SOURCE_SHA}`],
      },
    }),
    "fixtures/provenance.json": JSON.stringify({
      SLSA: {
        buildType: "https://mobyproject.org/buildkit@v1",
        invocation: {
          environment: { platform: "linux/amd64" },
          configSource: { entryPoint: "Dockerfile" },
          parameters: {
            args: { [`build-arg:${spec.buildArg}`]: SOURCE_SHA },
            root: {
              configSource: { path: "Dockerfile" },
              request: {
                args: {
                  "vcs:localdir:context": ".",
                  "vcs:localdir:dockerfile": spec.dockerfileDir,
                  "vcs:revision": SOURCE_SHA,
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
              revision: SOURCE_SHA,
            },
          },
        },
        materials: spec.baseImageDigests.map((digest) => ({
          digest: { sha256: digest.slice("sha256:".length) },
        })),
      },
    }),
    "fixtures/sbom.json": JSON.stringify({
      SPDX: {
        SPDXID: "SPDXRef-DOCUMENT",
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        documentNamespace: "https://github.com/modvolt/Site-Logbook/sbom/test",
        creationInfo: {
          created: "2026-08-10T00:00:00Z",
          creators: ["Tool: buildkit-syft-scanner"],
        },
        packages: [{ SPDXID: "SPDXRef-Package", name: packageName }],
        relationships: [
          {
            spdxElementId: "SPDXRef-DOCUMENT",
            relationshipType: "CONTAINS",
            relatedSpdxElement: "SPDXRef-Package",
          },
        ],
      },
    }),
  };
}

function candidatePackageEvidence(index = 0) {
  const packageName = PACKAGE_NAMES[index];
  const spec = PACKAGE_BUILD_SPECS[index];
  return {
    packageName,
    packageId: String(1000 + index),
    visibility: "private",
    repository: "modvolt/site-logbook-registry",
    registryRepository: `ghcr.io/modvolt/${packageName}`,
    sourceSha: SOURCE_SHA,
    versionId: String(2000 + index),
    digest: ROOT_DIGESTS[index],
    runnableManifestDigest: RUNNABLE_DIGEST,
    platform: "linux/amd64",
    activeInventoryPaginated: true,
    activeVersionCount: 1,
    packageVersionCount: 1,
    deletedInventoryMode: "not-queryable-exact-read-scope",
    visibleDeletedTagConflictChecked: false,
    deletedVersionCount: null,
    deletedHistoryScope: "external-audit-ledger-only",
    selectedVersionRefetched: true,
    remoteManifestVerified: true,
    runtimeMetadata: {
      source: "https://github.com/modvolt/Site-Logbook",
      revision: SOURCE_SHA,
      url: `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
      buildSha: SOURCE_SHA,
      buildShaEnv: spec.buildEnv,
    },
    provenance: {
      buildType: "https://mobyproject.org/buildkit@v1",
      vcsSource: "https://github.com/modvolt/Site-Logbook",
      vcsRevision: SOURCE_SHA,
      dockerfile: `${spec.dockerfileDir}/Dockerfile`,
      buildArg: spec.buildArg,
      buildSha: SOURCE_SHA,
      verifiedBaseImageDigests: spec.baseImageDigests,
    },
    sbom: { spdxVersion: "SPDX-2.3", packageCount: 1, relationshipCount: 1 },
  };
}

function runPreflightEvidence(packageEvidence = candidatePackageEvidence()) {
  const ledger = registryLedger("preflight-only");
  return runBashHarness({
    script: preflightEvidenceScript,
    files: {
      "runner-temp/preflight-package.json": JSON.stringify(packageEvidence),
      "runner-temp/staging-registry-ledger-entry.json": ledger,
    },
    environment: {
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      CALLER_WORKFLOW_SHA,
      HARNESS_ROOT: "{HARNESS_ROOT}",
      INITIAL_PACKAGE_STATE: "00000",
      LEDGER_ENTRY_SHA256: ledgerSha256(ledger),
      PREFLIGHT_DIGEST: ROOT_DIGESTS[0],
      PREFLIGHT_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-preflight",
      REGISTRY_WRITE: "true",
      RUN_ATTEMPT: "1",
      RUN_ID: "31400000000",
      RUNNER_TEMP: "{HARNESS_ROOT}/runner-temp",
      SOURCE_SHA,
    },
    captureFiles: [
      "preflight-publication.json",
      "preflight-publication.sha256",
      "staging-registry-ledger-entry.json",
    ],
  });
}

function runCompleteEvidence({
  packageEvidence = PACKAGE_NAMES.map((_, index) =>
    candidatePackageEvidence(index),
  ),
  initialPackageState = "10000",
  registryWrite = "true",
  runAttempt = "1",
} = {}) {
  const [preflight, mailpit, api, web, alertReceiver] = packageEvidence;
  const ledger = registryLedger("complete", {
    expectedInitialPackageState: initialPackageState,
  });
  return runBashHarness({
    script: completeEvidenceScript,
    files: {
      "runner-temp/preflight-package.json": JSON.stringify(preflight),
      "runner-temp/mailpit-package.json": JSON.stringify(mailpit),
      "runner-temp/api-package.json": JSON.stringify(api),
      "runner-temp/web-package.json": JSON.stringify(web),
      "runner-temp/alert-receiver-package.json": JSON.stringify(alertReceiver),
      "runner-temp/staging-registry-ledger-entry.json": ledger,
    },
    environment: {
      ALERT_RECEIVER_DIGEST: ROOT_DIGESTS[4],
      ALERT_RECEIVER_REPOSITORY:
        "ghcr.io/modvolt/site-logbook-staging-alert-receiver",
      API_DIGEST: ROOT_DIGESTS[2],
      API_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-api",
      CALLER_REPOSITORY: "modvolt/site-logbook-registry",
      CALLER_WORKFLOW_REF:
        "modvolt/site-logbook-registry/.github/workflows/publish-staging-images.yml@refs/heads/main",
      CALLER_WORKFLOW_SHA,
      HARNESS_ROOT: "{HARNESS_ROOT}",
      INITIAL_PACKAGE_STATE: initialPackageState,
      LEDGER_ENTRY_SHA256: ledgerSha256(ledger),
      MAILPIT_DIGEST: ROOT_DIGESTS[1],
      MAILPIT_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-mailpit",
      PREFLIGHT_DIGEST: ROOT_DIGESTS[0],
      PREFLIGHT_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-preflight",
      REGISTRY_WRITE: registryWrite,
      RUN_ATTEMPT: runAttempt,
      RUN_ID: "31400000001",
      RUNNER_TEMP: "{HARNESS_ROOT}/runner-temp",
      SOURCE_SHA,
      WEB_DIGEST: ROOT_DIGESTS[3],
      WEB_REPOSITORY: "ghcr.io/modvolt/site-logbook-staging-web",
    },
    captureFiles: [
      "staging-images.json",
      "staging-images.sha256",
      "staging-registry-ledger-entry.json",
    ],
  });
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
    actions: "read",
    contents: "read",
    packages: "write",
  });
  const publisherSteps = workflow.jobs["publish-staging-images"].steps;
  assert.equal(
    publisherSteps.find(
      (step) => step.name === "Upload preflight-only publication evidence",
    ).with.path,
    "preflight-publication.json\npreflight-publication.sha256\nstaging-registry-ledger-entry.json\n",
  );
  assert.equal(
    publisherSteps.find(
      (step) => step.name === "Upload immutable image manifest",
    ).with.path,
    "staging-images.json\nstaging-images.sha256\nstaging-registry-ledger-entry.json\n",
  );
  assert.deepEqual(
    workflow.on.workflow_call.inputs.registry_history_acceptance,
    {
      description:
        "Exact reviewed acceptance of the external-ledger residual limitation",
      required: true,
      type: "string",
    },
  );
  assert.deepEqual(workflow.on.workflow_call.inputs.registry_ledger_json, {
    description:
      "Canonical stage-specific external-ledger entry hard-coded by the reviewed private caller",
    required: true,
    type: "string",
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

test("pins the workflow harness to LF-canonical Dockerfile bytes", () => {
  assert.equal(
    WORKFLOW_HARNESS_IMAGE,
    "site-logbook/workflow-harness:alpine-3.22.1-7b2d54e4ed3722df",
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

test("executes the exact private manual caller guard fail-closed", () => {
  const accepted = runCallerIdentity();
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const [variable, value, expected] of [
    ["CALLER_REPOSITORY", "modvolt/other", /approved private repository/u],
    ["CALLER_EVENT_NAME", "push", /manual workflow dispatch/u],
    ["CALLER_REF", "refs/heads/feature", /private default branch/u],
    ["CALLER_ACTOR", "other", /caller actor/u],
    ["CALLER_TRIGGERING_ACTOR", "other", /triggering actor/u],
    [
      "CALLER_WORKFLOW_REF",
      "modvolt/site-logbook-registry/.github/workflows/other.yml@refs/heads/main",
      /workflow path and ref/u,
    ],
  ]) {
    const rejected = runCallerIdentity({ [variable]: value });
    assert.notEqual(rejected.status, 0, `${variable} unexpectedly passed`);
    assert.match(rejected.stderr, expected, variable);
  }
});

test("accepts canonical stage-specific registry ledgers and binds their exact bytes", () => {
  for (const stage of ["preflight-only", "complete"]) {
    const expected = registryLedger(stage);
    const result = runRegistryLedger({ stage, ledger: expected });
    assert.equal(result.status, 0, `${stage}: ${result.stderr}`);
    assert.equal(
      result.captured["staging-registry-ledger-entry.json"],
      expected,
      stage,
    );
    const output = parseGithubOutput(result.captured["github-output.txt"]);
    const digest = crypto.createHash("sha256").update(expected).digest("hex");
    assert.equal(output.ledger_sha256, `sha256:${digest}`, stage);
  }
});

test("rejects malformed, noncanonical, duplicate-key, or semantically widened registry ledgers", () => {
  const mutations = [
    `${registryLedger()} `,
    registryLedger().replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ),
    registryLedger("preflight-only", { sourceSha: "0".repeat(40) }),
    registryLedger("preflight-only", { stage: "complete" }),
    registryLedger("preflight-only", {
      expectedInitialPackageState: "11111",
    }),
    registryLedger("preflight-only", { packageNames: [PACKAGE_NAMES[0]] }),
    registryLedger("preflight-only", {
      deletedHistoryControl: {
        decision: "historical-absence-proven",
        deletedApiQueried: false,
        historicalAbsenceProven: true,
        mode: "reviewed-caller-visible-history-ledger",
      },
    }),
    registryLedger("complete", {
      previousEntry: {
        ledgerEntrySha256: "not-a-digest",
        preflightDigest: ROOT_DIGESTS[0],
      },
    }),
    registryLedger("complete", {
      previousEntry: {
        ledgerEntrySha256: `sha256:${"9".repeat(64)}`,
        preflightDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
  ];
  for (const ledger of mutations) {
    const result = runRegistryLedger({
      stage: ledger.includes('"stage":"complete"')
        ? "complete"
        : "preflight-only",
      ledger,
    });
    assert.notEqual(result.status, 0, ledger);
    assert.match(result.stderr, /ledger|canonical|stage contract/u);
  }

  const acceptance = runRegistryLedger({
    environment: { REGISTRY_HISTORY_ACCEPTANCE: "ACCEPT_ANYTHING" },
  });
  assert.notEqual(acceptance.status, 0);
  assert.match(acceptance.stderr, /acceptance phrase/u);
});

test("enforces a first attempt and unique visible dispatch for each reviewed private caller commit", () => {
  for (const [currentRun, environment, pattern] of [
    [callerRun({ run_attempt: 2 }), {}, /first-attempt/u],
    [callerRun({ path: ".github/workflows/other.yml" }), {}, /first-attempt/u],
    [callerRun({ head_sha: "2".repeat(40) }), {}, /first-attempt/u],
    [callerRun({ status: "completed" }), {}, /first-attempt/u],
    [callerRun(), { GITHUB_RUN_ATTEMPT_VALUE: "2" }, /first attempt/u],
  ]) {
    const result = runRegistryLedger({ currentRun, environment });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }

  const replay = runRegistryLedger({
    historyRuns: [
      callerRun(),
      callerRun({ id: Number(LEDGER_RUN_ID) + 1, status: "completed" }),
    ],
  });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /already dispatched|ambiguous/u);

  const duplicateIds = runRegistryLedger({
    historyRuns: [callerRun(), callerRun()],
  });
  assert.notEqual(duplicateIds.status, 0);
  assert.match(duplicateIds.stderr, /already dispatched|ambiguous/u);

  const apiCap = runRegistryLedger({
    historyRuns: Array.from({ length: 1000 }, (_, index) =>
      index === 0
        ? callerRun()
        : callerRun({
            id: Number(LEDGER_RUN_ID) + index,
            head_sha: index.toString(16).padStart(40, "0"),
            status: "completed",
          }),
    ),
  });
  assert.notEqual(apiCap.status, 0);
  assert.match(apiCap.stderr, /ambiguous|non-unique/u);
});

test("shellcheck accepts the exact extracted workflow scripts", () => {
  const result = runBashHarness({
    script: `set -euo pipefail
shellcheck --shell=bash scripts/registry-ledger.sh scripts/metadata-credential.sh scripts/package-state.sh scripts/tag-absence.sh scripts/package-verifier.sh
`,
    files: {
      "scripts/registry-ledger.sh": registryLedgerScript,
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
          /the reviewed ledger initial package state is invalid|partial recovery requires a separate review/u,
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
        default_branch: "main",
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

  const staleCallerMain = runPackageState("preflight-only", "00000", {
    files: {
      "fixtures/caller-main.json": JSON.stringify({
        ref: "refs/heads/main",
        object: { type: "commit", sha: "2".repeat(40) },
      }),
    },
  });
  assert.notEqual(staleCallerMain.status, 0);
  assert.match(staleCallerMain.stderr, /not the live private main head/u);
});

test("rejects duplicate exact tags and a complete-stage digest mismatch", () => {
  const duplicateMetadata = packageMetadata(PACKAGE_NAMES[0], 0, 2);
  const duplicateTag = runPackageState("preflight-only", "10000", {
    files: {
      "fixtures/inventory.json": JSON.stringify([
        duplicateMetadata,
        ...PACKAGE_NAMES.slice(1).map((name, index) =>
          packageMetadata(name, index + 1),
        ),
      ]),
      [`fixtures/package-${PACKAGE_NAMES[0]}.json`]:
        JSON.stringify(duplicateMetadata),
      [`fixtures/versions-${PACKAGE_NAMES[0]}.json`]: JSON.stringify([
        packageVersion(0),
        {
          ...packageVersion(0),
          id: 2999,
          name: `sha256:${"9".repeat(64)}`,
        },
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

test("binds candidate state reads to complete active inventory and immutable refetch", () => {
  const name = PACKAGE_NAMES[0];
  const parityMetadata = packageMetadata(name, 0, 2);
  const parity = runPackageState("preflight-only", "10000", {
    files: {
      "fixtures/inventory.json": JSON.stringify([
        parityMetadata,
        ...PACKAGE_NAMES.slice(1).map((packageName, index) =>
          packageMetadata(packageName, index + 1),
        ),
      ]),
      [`fixtures/package-${name}.json`]: JSON.stringify(parityMetadata),
    },
  });
  assert.notEqual(parity.status, 0);
  assert.match(parity.stderr, /package versions.*malformed/u);

  const aliased = runPackageState("preflight-only", "10000", {
    files: {
      [`fixtures/selected-${name}.json`]: JSON.stringify(
        packageVersion(0, [SOURCE_SHA, "mutable-alias"]),
      ),
    },
  });
  assert.notEqual(aliased.status, 0);
  assert.match(aliased.stderr, /not immutable/u);
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
  for (const [index, packageName] of PACKAGE_NAMES.entries()) {
    const spec = PACKAGE_BUILD_SPECS[index];
    const result = runVerifier({ packageName });
    assert.equal(result.status, 0, `${packageName}: ${result.stderr}`);
    const evidence = JSON.parse(result.captured["evidence.json"]);
    assert.equal(evidence.digest, ROOT_DIGESTS[index]);
    assert.equal(evidence.runnableManifestDigest, RUNNABLE_DIGEST);
    assert.equal(evidence.platform, "linux/amd64");
    assert.equal(evidence.activeInventoryPaginated, true);
    assert.equal(evidence.activeVersionCount, 1);
    assert.equal(evidence.packageVersionCount, 1);
    assert.equal(
      evidence.deletedInventoryMode,
      "not-queryable-exact-read-scope",
    );
    assert.equal(evidence.visibleDeletedTagConflictChecked, false);
    assert.equal(evidence.deletedVersionCount, null);
    assert.equal(evidence.deletedHistoryScope, "external-audit-ledger-only");
    assert.equal(evidence.selectedVersionRefetched, true);
    assert.equal(evidence.remoteManifestVerified, true);
    assert.deepEqual(evidence.runtimeMetadata, {
      source: "https://github.com/modvolt/Site-Logbook",
      revision: SOURCE_SHA,
      url: `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
      buildSha: SOURCE_SHA,
      buildShaEnv: spec.buildEnv,
    });
    assert.equal(evidence.provenance.vcsRevision, SOURCE_SHA);
    assert.equal(
      evidence.provenance.dockerfile,
      `${spec.dockerfileDir}/Dockerfile`,
    );
    assert.equal(evidence.provenance.buildArg, spec.buildArg);
    assert.deepEqual(
      evidence.provenance.verifiedBaseImageDigests,
      spec.baseImageDigests,
    );
    assert.equal(evidence.sbom.spdxVersion, "SPDX-2.3");
    assert.equal(evidence.sbom.packageCount, 1);
    assert.equal(evidence.sbom.relationshipCount, 1);
  }
});

test("emits and validates schema-v3 preflight publication evidence", () => {
  const result = runPreflightEvidence();
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.captured["preflight-publication.json"]);
  assert.equal(evidence.schemaVersion, 3);
  assert.equal(evidence.kind, "site-logbook-staging-preflight-publication");
  assert.equal(evidence.initialPackageState, "00000");
  assert.equal(evidence.registryAction, "published");
  assert.deepEqual(evidence.deletedHistoryControl, {
    mode: "reviewed-caller-visible-history-ledger",
    decision: "explicitly-accepted-external-ledger",
    ledgerEntrySha256: ledgerSha256(registryLedger("preflight-only")),
    callerWorkflowSha: CALLER_WORKFLOW_SHA,
    visibleRunUniquenessVerified: true,
    workflowRunHistoryScope: "github-visible-workflow-runs-below-1000-api-cap",
    deletedApiQueried: false,
  });
  assert.deepEqual(
    evidence.registryLedger,
    JSON.parse(result.captured["staging-registry-ledger-entry.json"]),
  );
  assert.equal(evidence.package.packageName, PACKAGE_NAMES[0]);
  assert.equal(evidence.package.deletedVersionCount, null);
  assert.equal(
    evidence.package.provenance.verifiedBaseImageDigests[0],
    PACKAGE_BUILD_SPECS[0].baseImageDigests[0],
  );
  assert.match(
    result.captured["preflight-publication.sha256"],
    /^[0-9a-f]{64}[ ]{2}preflight-publication\.json\n$/u,
  );

  const invalid = candidatePackageEvidence();
  invalid.sbom.packageCount = 0;
  const rejected = runPreflightEvidence(invalid);
  assert.notEqual(rejected.status, 0);
});

test("emits and validates schema-v3 complete publication evidence for all packages", () => {
  const result = runCompleteEvidence();
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.captured["staging-images.json"]);
  assert.equal(evidence.schemaVersion, 3);
  assert.equal(evidence.kind, "site-logbook-staging-images");
  assert.equal(evidence.publicationStage, "complete");
  assert.equal(evidence.initialPackageState, "10000");
  assert.equal(evidence.registryAction, "published");
  assert.deepEqual(evidence.deletedHistoryControl, {
    mode: "reviewed-caller-visible-history-ledger",
    decision: "explicitly-accepted-external-ledger",
    ledgerEntrySha256: ledgerSha256(registryLedger("complete")),
    callerWorkflowSha: CALLER_WORKFLOW_SHA,
    visibleRunUniquenessVerified: true,
    workflowRunHistoryScope: "github-visible-workflow-runs-below-1000-api-cap",
    deletedApiQueried: false,
  });
  assert.deepEqual(
    evidence.registryLedger,
    JSON.parse(result.captured["staging-registry-ledger-entry.json"]),
  );
  assert.deepEqual(Object.keys(evidence.packages).sort(), [
    "alertReceiver",
    "api",
    "mailpit",
    "preflight",
    "web",
  ]);
  for (const [index, key] of [
    "preflight",
    "mailpit",
    "api",
    "web",
    "alertReceiver",
  ].entries()) {
    assert.equal(evidence.packages[key].packageName, PACKAGE_NAMES[index]);
    assert.equal(evidence.packages[key].digest, ROOT_DIGESTS[index]);
  }
  assert.match(
    result.captured["staging-images.sha256"],
    /^[0-9a-f]{64}[ ]{2}staging-images\.json\n$/u,
  );

  const noop = runCompleteEvidence({
    initialPackageState: "11111",
    registryWrite: "false",
  });
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(
    JSON.parse(noop.captured["staging-images.json"]).registryAction,
    "verified-noop",
  );

  const wrongAttempt = runCompleteEvidence({ runAttempt: "2" });
  assert.notEqual(wrongAttempt.status, 0);
});

test("rejects candidate inventory, runtime metadata, provenance, and SBOM drift", () => {
  const base = validRemoteFixtureFiles();
  const metadata = JSON.parse(
    base[`fixtures/package-${PACKAGE_NAMES[0]}.json`],
  );
  metadata.version_count = 2;
  const parity = runVerifier({
    files: {
      [`fixtures/package-${PACKAGE_NAMES[0]}.json`]: JSON.stringify(metadata),
    },
  });
  assert.notEqual(parity.status, 0);
  assert.match(parity.stderr, /ACTIVE_VERSION_INVENTORY_NOT_READY/u);

  const selected = JSON.parse(
    base[`fixtures/selected-${PACKAGE_NAMES[0]}.json`],
  );
  selected.metadata.container.tags.push("mutable-alias");
  const refetch = runVerifier({
    files: {
      [`fixtures/selected-${PACKAGE_NAMES[0]}.json`]: JSON.stringify(selected),
    },
  });
  assert.notEqual(refetch.status, 0);
  assert.match(refetch.stderr, /SELECTED_VERSION_REFETCH_NOT_READY/u);

  for (const [fixture, mutate, diagnostic] of [
    [
      "fixtures/image.json",
      (value) => {
        value.config.Labels["org.opencontainers.image.source"] =
          "https://github.com/modvolt/site-logbook-registry";
      },
      "RUNTIME_METADATA_NOT_READY",
    ],
    [
      "fixtures/image.json",
      (value) => {
        value.config.Env = ["BUILD_SHA=wrong"];
      },
      "RUNTIME_METADATA_NOT_READY",
    ],
    [
      "fixtures/provenance.json",
      (value) => {
        value.SLSA.invocation.parameters.args["build-arg:BUILD_SHA"] =
          "0".repeat(40);
      },
      "PROVENANCE_NOT_READY",
    ],
    [
      "fixtures/provenance.json",
      (value) => {
        value.SLSA.invocation.parameters.root.request.args[
          "vcs:localdir:dockerfile"
        ] = "artifacts/stavba";
      },
      "PROVENANCE_NOT_READY",
    ],
    [
      "fixtures/provenance.json",
      (value) => {
        value.SLSA.materials = [];
      },
      "PROVENANCE_NOT_READY",
    ],
    [
      "fixtures/sbom.json",
      (value) => {
        value.SPDX.packages = [];
      },
      "SBOM_NOT_READY",
    ],
    [
      "fixtures/sbom.json",
      (value) => {
        value.SPDX.relationships[0].relationshipType = "DESCRIBES";
      },
      "SBOM_NOT_READY",
    ],
  ]) {
    const value = JSON.parse(base[fixture]);
    mutate(value);
    const result = runVerifier({ files: { [fixture]: JSON.stringify(value) } });
    assert.notEqual(result.status, 0, fixture);
    assert.match(result.stderr, new RegExp(diagnostic, "u"), fixture);
  }
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
