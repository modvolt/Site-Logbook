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
const PACKAGE_NAMES = [
  "site-logbook-staging-preflight",
  "site-logbook-staging-mailpit",
  "site-logbook-staging-api",
  "site-logbook-staging-web",
];
const ROOT_DIGESTS = PACKAGE_NAMES.map(
  (_, index) => `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
);
const RUNNABLE_DIGEST = `sha256:${"e".repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${"f".repeat(64)}`;
const workflow = readWorkflow();
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
  repos/modvolt/site-logbook-registry)
    cat "$HARNESS_ROOT/fixtures/caller.json"
    ;;
  "/user/packages?package_type=container&per_page=100")
    [[ "\${MOCK_INVENTORY_FAIL:-false}" != "true" ]] || exit 73
    cat "$HARNESS_ROOT/fixtures/inventory.json"
    ;;
  user/packages/container/*/versions?per_page=100)
    package="\${endpoint#user/packages/container/}"
    package="\${package%%/*}"
    [[ "\${MOCK_VERSIONS_FAIL_FOR:-}" != "$package" ]] || exit 74
    cat "$HARNESS_ROOT/fixtures/versions-$package.json"
    ;;
  user/packages/container/*)
    package="\${endpoint#user/packages/container/}"
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
    CALLER_REPOSITORY: "modvolt/site-logbook-registry",
    CALLER_REPOSITORY_OWNER: "modvolt",
    GH_TOKEN: "mock-token-not-a-secret",
    HARNESS_ROOT: "{HARNESS_ROOT}",
    PRIVATE_REGISTRY_OWNER: "modvolt",
    PUBLICATION_CONFIRMED: "true",
    SOURCE_SHA,
  };
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
  assert.throws(
    () => parseWorkflow("name: duplicate\npermissions: {}\npermissions: {}\n"),
    /unique-key YAML|Map keys must be unique/u,
  );
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
        getuid: undefined,
        getgid: undefined,
      }),
    /numeric host UID and GID/u,
  );
});

test("accepts a genuinely empty inventory for first publication", () => {
  const result = runPackageState("preflight-only", "0000", {
    files: { "fixtures/inventory.json": "[]" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = parseGithubOutput(result.captured["github-output.txt"]);
  assert.equal(output.state, "0000");
  assert.equal(output.publish_preflight, "true");
  assert.equal(output.publish_remaining, "false");
});

test("shellcheck accepts the exact extracted workflow scripts", () => {
  const result = runBashHarness({
    script: `set -euo pipefail
shellcheck --shell=bash scripts/package-state.sh scripts/tag-absence.sh scripts/package-verifier.sh
`,
    files: {
      "scripts/package-state.sh": packageStateScript,
      "scripts/tag-absence.sh": absenceScript,
      "scripts/package-verifier.sh": verifierScript,
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("executes all 32 stage and exact-SHA package-state combinations fail-closed", () => {
  const allowed = new Map([
    ["preflight-only:0000", ["true", "false"]],
    ["preflight-only:1000", ["false", "false"]],
    ["complete:1000", ["false", "true"]],
    ["complete:1111", ["false", "false"]],
  ]);
  for (const stage of ["preflight-only", "complete"]) {
    for (let value = 0; value < 16; value += 1) {
      const state = value.toString(2).padStart(4, "0");
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
  const malformed = runPackageState("preflight-only", "0000", {
    files: { "fixtures/inventory.json": JSON.stringify({ not: "an array" }) },
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /inventory is malformed/u);

  const duplicateMetadata = packageMetadata(PACKAGE_NAMES[0], 0);
  const duplicate = runPackageState("preflight-only", "0000", {
    files: {
      "fixtures/inventory.json": JSON.stringify([
        duplicateMetadata,
        duplicateMetadata,
      ]),
    },
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate package metadata/u);

  const caller = runPackageState("preflight-only", "0000", {
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

  const unavailable = runPackageState("preflight-only", "0000", {
    environment: { MOCK_INVENTORY_FAIL: "true" },
  });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /inventory could not be read/u);

  const publicPackage = packageMetadata(PACKAGE_NAMES[0], 0);
  publicPackage.visibility = "public";
  const untrustedWithoutExactTag = runPackageState("preflight-only", "0000", {
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
  const duplicateTag = runPackageState("preflight-only", "1000", {
    files: {
      [`fixtures/versions-${PACKAGE_NAMES[0]}.json`]: JSON.stringify([
        packageVersion(0),
        { ...packageVersion(0), id: 2999 },
      ]),
    },
  });
  assert.notEqual(duplicateTag.status, 0);
  assert.match(duplicateTag.stderr, /exact source tag.*not unique/u);

  const digestMismatch = runPackageState("complete", "1000", {
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
  assert.equal(publishIndexes.length, 4);

  for (const index of publishIndexes) {
    const guard = steps[index - 1];
    const publication = steps[index];
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
      new RegExp(`site-logbook-staging-${publication.id}`, "iu"),
    );
    assert.match(
      String(publication.with.tags),
      new RegExp(`steps\\.names\\.outputs\\.${publication.id}`, "u"),
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
