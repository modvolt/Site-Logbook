import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  StagingPredecessorImageError,
  validateStagingPredecessorImage,
} from "../verify-staging-predecessor-image.mjs";

const SOURCE_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const SOURCE_TREE = "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
const DIGEST = `sha256:${"a".repeat(64)}`;

function fixture(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "site-logbook-staging-predecessor-api",
    sourceSha: SOURCE_SHA,
    sourceTree: SOURCE_TREE,
    migrationContract: {
      count: 104,
      tail: "0104_thin_sheva_callister",
      excluded0100: true,
      excluded0105: true,
    },
    callerRepository: "modvolt/site-logbook-registry",
    callerWorkflowRef:
      "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
    initialTagState: "absent",
    registryAction: "published",
    publisherRun: { id: "123", attempt: "1" },
    toolchain: {
      buildx: "v0.34.1",
      buildkitImage:
        "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
    },
    image: `ghcr.io/modvolt/site-logbook-staging-api@${DIGEST}`,
    package: {
      packageName: "site-logbook-staging-api",
      packageId: "11",
      visibility: "private",
      repository: "modvolt/site-logbook-registry",
      registryRepository: "ghcr.io/modvolt/site-logbook-staging-api",
      sourceSha: SOURCE_SHA,
      versionId: "22",
      digest: DIGEST,
      runnableManifestDigest: `sha256:${"b".repeat(64)}`,
      platform: "linux/amd64",
      activeInventoryPaginated: true,
      activeVersionCount: 1,
      packageVersionCount: 1,
      visibleDeletedTagConflictChecked: true,
      deletedVersionCount: 0,
      deletedHistoryScope: "visible-package-versions-only",
      selectedVersionRefetched: true,
      remoteManifestVerified: true,
      runtimeMetadata: {
        source: "https://github.com/modvolt/Site-Logbook",
        revision: SOURCE_SHA,
        url: `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
        buildSha: SOURCE_SHA,
      },
      provenance: {
        buildType: "https://mobyproject.org/buildkit@v1",
        vcsSource: "https://github.com/modvolt/Site-Logbook",
        vcsRevision: SOURCE_SHA,
        dockerfile: "artifacts/api-server/Dockerfile",
        buildSha: SOURCE_SHA,
        baseImageDigest:
          "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
      },
      sbom: {
        spdxVersion: "SPDX-2.3",
        packageCount: 42,
        relationshipCount: 41,
      },
    },
    ...overrides,
  };
}

function encoded(manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    hash,
    checksum: `${hash}  staging-predecessor-image.json\n`,
  };
}

function expectCode(manifest, expectedCode, options = {}) {
  const data = encoded(manifest);
  assert.throws(
    () => validateStagingPredecessorImage(data.bytes, data.checksum, options),
    (error) =>
      error instanceof StagingPredecessorImageError &&
      error.code === expectedCode,
  );
}

test("accepts trusted fixed predecessor image evidence", () => {
  const data = encoded(fixture());
  const result = validateStagingPredecessorImage(data.bytes, data.checksum, {
    expectedManifestSha256: data.hash,
    expectedCallerWorkflowRef:
      "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main",
    expectedRunId: "123",
    expectedRunAttempt: "1",
  });
  assert.equal(result.decision, "PASS");
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.sourceTree, SOURCE_TREE);
  assert.equal(result.image, fixture().image);
  assert.ok(result.manifestBase64);
});

test("accepts only the idempotent present-tag no-op pair", () => {
  const data = encoded(
    fixture({ initialTagState: "present", registryAction: "verified-noop" }),
  );
  assert.equal(
    validateStagingPredecessorImage(data.bytes, data.checksum).decision,
    "INTERNALLY_CONSISTENT_UNTRUSTED",
  );
  expectCode(
    fixture({ initialTagState: "present", registryAction: "published" }),
    "PREDECESSOR_PUBLICATION_STATE_INVALID",
  );
});

test("rejects source, tree and migration drift", () => {
  expectCode(
    fixture({ sourceSha: "f".repeat(40) }),
    "PREDECESSOR_SOURCE_MISMATCH",
  );
  expectCode(
    fixture({ sourceTree: "e".repeat(40) }),
    "PREDECESSOR_SOURCE_MISMATCH",
  );
  expectCode(
    fixture({
      migrationContract: { ...fixture().migrationContract, count: 105 },
    }),
    "PREDECESSOR_MIGRATION_CONTRACT_INVALID",
  );
  expectCode(
    fixture({ toolchain: { ...fixture().toolchain, buildx: "latest" } }),
    "PREDECESSOR_TOOLCHAIN_INVALID",
  );
});

test("rejects caller, image and package widening", () => {
  expectCode(
    fixture({ callerRepository: "modvolt/Site-Logbook" }),
    "PREDECESSOR_CALLER_INVALID",
  );
  expectCode(
    fixture({ image: `ghcr.io/modvolt/other@${DIGEST}` }),
    "PREDECESSOR_SCHEMA_INVALID",
  );
  expectCode(
    fixture({ package: { ...fixture().package, platform: "linux/arm64" } }),
    "PREDECESSOR_PACKAGE_INVALID",
  );
  for (const boundary of [
    "activeInventoryPaginated",
    "visibleDeletedTagConflictChecked",
    "selectedVersionRefetched",
  ]) {
    expectCode(
      fixture({ package: { ...fixture().package, [boundary]: false } }),
      "PREDECESSOR_PACKAGE_INVALID",
    );
  }
  expectCode(
    fixture({ package: { ...fixture().package, deletedVersionCount: 1 } }),
    "PREDECESSOR_PACKAGE_INVALID",
  );
  expectCode(
    fixture({ package: { ...fixture().package, packageVersionCount: 2 } }),
    "PREDECESSOR_PACKAGE_INVALID",
  );
  expectCode(
    fixture({
      package: {
        ...fixture().package,
        runtimeMetadata: {
          ...fixture().package.runtimeMetadata,
          buildSha: "f".repeat(40),
        },
      },
    }),
    "PREDECESSOR_RUNTIME_METADATA_INVALID",
  );
  expectCode(
    fixture({
      package: {
        ...fixture().package,
        provenance: {
          ...fixture().package.provenance,
          dockerfile: "Dockerfile",
        },
      },
    }),
    "PREDECESSOR_PROVENANCE_INVALID",
  );
  expectCode(
    fixture({
      package: {
        ...fixture().package,
        sbom: { ...fixture().package.sbom, packageCount: 0 },
      },
    }),
    "PREDECESSOR_SBOM_INVALID",
  );
});

test("rejects unknown fields and secret-shaped evidence", () => {
  expectCode({ ...fixture(), extra: true }, "PREDECESSOR_SCHEMA_INVALID");
  expectCode(
    { ...fixture(), accessToken: "not-a-real-secret" },
    "PREDECESSOR_SECRET_MATERIAL",
  );
});

test("rejects checksum and separate trust mismatches", () => {
  const data = encoded(fixture());
  assert.throws(
    () =>
      validateStagingPredecessorImage(
        data.bytes,
        `${"0".repeat(64)}  staging-predecessor-image.json\n`,
      ),
    (error) =>
      error instanceof StagingPredecessorImageError &&
      error.code === "PREDECESSOR_CHECKSUM_MISMATCH",
  );
  assert.throws(
    () =>
      validateStagingPredecessorImage(data.bytes, data.checksum, {
        expectedManifestSha256: "0".repeat(64),
      }),
    (error) =>
      error instanceof StagingPredecessorImageError &&
      error.code === "PREDECESSOR_TRUST_MISMATCH",
  );
});
