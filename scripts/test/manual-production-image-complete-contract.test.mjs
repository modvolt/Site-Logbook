import assert from "node:assert/strict";
import test from "node:test";

import {
  MANUAL_PRODUCTION_IMAGE_COMPLETE_KIND,
  MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
  MANUAL_PRODUCTION_IMAGE_COMPLETE_SCHEMA,
  parseManualProductionImageCompleteReceipt,
  sealManualProductionImageCompleteReceipt,
  validateManualProductionImageCompleteReceipt,
} from "../production-evidence/manual-production-image-complete-contract.mjs";
import {
  PRODUCTION_IMAGE_SPECS,
  canonicalJson,
  reviewedImageSetSha256,
  sha256,
} from "../production-evidence/production-image-publication-contract.mjs";

const SOURCE_SHA = "7e3e50ca10e3877d2f4ee3a098380a44565623c5";
const TREE_SHA = "bbec44e0691ab407f1fb3f9c5da2fb622dd96bcb";
const CUSTODY_SHA = sha256("manual-custody");

function digest(name) {
  return sha256(`manual-complete:${name}`);
}

function imageFixture(key, index) {
  const spec = PRODUCTION_IMAGE_SPECS[key];
  const imageDigest = digest(`${key}:image`);
  const configDigest = digest(`${key}:config`);
  const layers = [
    {
      digest: digest(`${key}:layer`),
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 1000 + index,
    },
  ];
  const filesystemProjection = {
    format: "oci-layer-manifest/v1",
    configDigest,
    layers,
    entryCount: layers.length,
  };
  return {
    component: spec.component,
    repository: spec.repository,
    image: `${spec.repository}@${imageDigest}`,
    digest: imageDigest,
    runnableManifestDigest: digest(`${key}:runnable`),
    configDigest,
    sourceSha: SOURCE_SHA,
    platform: "linux/amd64",
    visibility: "private",
    published: true,
    registryVerified: true,
    registryEvidenceSha256: digest(`${key}:placeholder`),
    build: {
      dockerfile: spec.dockerfile,
      target: spec.target,
      buildArg: spec.buildArg,
      buildArgValue: SOURCE_SHA,
      imageProfile: spec.imageProfile,
      mutatingEntrypointsPresent: spec.mutatingEntrypointsPresent,
    },
    provenance: {
      mediaType: "application/vnd.in-toto+json",
      sha256: digest(`${key}:provenance`),
      buildType: "https://mobyproject.org/buildkit@v1",
      vcsSource: "https://github.com/modvolt/Site-Logbook",
      vcsRevision: SOURCE_SHA,
      dockerfile: spec.dockerfile,
      target: spec.target,
      buildArg: spec.buildArg,
      buildArgValue: SOURCE_SHA,
    },
    sbom: {
      mediaType: "application/spdx+json",
      sha256: digest(`${key}:sbom`),
      spdxVersion: "SPDX-2.3",
      packageCount: 20 + index,
      relationshipCount: 19 + index,
    },
    filesystemManifest: {
      ...filesystemProjection,
      sha256: sha256(canonicalJson(filesystemProjection)),
    },
    ociArchive: {
      sha256: digest(`${key}:archive`),
      sizeBytes: 10_000 + index,
      indexDigest: imageDigest,
    },
  };
}

function registryResult(image, preWriteDigestState = "absent") {
  return {
    schemaVersion: "site-logbook.production-image-registry-publication/v1",
    sourceSha: SOURCE_SHA,
    component: image.component,
    repository: image.repository,
    digest: image.digest,
    immutableImage: image.image,
    referenceMode: "digest-only",
    preWriteDigestState,
    digestAlreadyPresent: preWriteDigestState === "present",
    registryWritePerformed: preWriteDigestState === "absent",
    sourceRecheckPerformed: true,
    digestReferenceVerified: true,
    runnableManifestVerified: true,
    attestationManifestVerified: true,
    allReviewedBlobsVerified: true,
    publishedAt: "2026-08-24T17:00:00.000Z",
  };
}

function receiptFixture() {
  const images = {
    api: imageFixture("api", 0),
    controlPlane: imageFixture("controlPlane", 1),
    hostOperator: imageFixture("hostOperator", 2),
    web: imageFixture("web", 3),
  };
  const results = {};
  for (const [key, image] of Object.entries(images)) {
    const result = registryResult(image, key === "api" ? "present" : "absent");
    results[key] = result;
    image.registryEvidenceSha256 = sha256(canonicalJson(result));
  }
  const reviewedSet = reviewedImageSetSha256(images);
  const summary = {
    schemaVersion:
      "site-logbook.production-image-manual-registry-publication/v1",
    kind: "site-logbook-production-image-manual-registry-publication",
    sourceSha: SOURCE_SHA,
    custodySha256: CUSTODY_SHA,
    reviewedImageSetSha256: reviewedSet,
    allFourImagesRegistryVerified: true,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    migrationAuthorized: false,
    migrationPerformed: false,
    productionTargetsTouched: false,
    publishedAt: "2026-08-24T17:00:00.000Z",
    images: results,
  };
  return {
    schemaVersion: MANUAL_PRODUCTION_IMAGE_COMPLETE_SCHEMA,
    kind: MANUAL_PRODUCTION_IMAGE_COMPLETE_KIND,
    publicationMode: MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
    source: {
      repository: "modvolt/Site-Logbook",
      ref: "refs/heads/main",
      sha: SOURCE_SHA,
      treeSha: TREE_SHA,
      mergeParentShas: [
        "e50c7823b7f61dcf114d0ddec03a8fba6d28e12c",
        "d6db4650d21270e341166776e0ac26a0eebf81e0",
      ],
      qualityGate: {
        workflowName: "Quality gate",
        workflowPath: ".github/workflows/quality-gate.yml",
        event: "push",
        headBranch: "main",
        headSha: SOURCE_SHA,
        runId: "32658240237",
        runAttempt: "1",
        conclusion: "success",
      },
    },
    custody: {
      receiptSha256: CUSTODY_SHA,
      verificationSha256: digest("custody-verification"),
      publicationNonceSha256: digest("nonce"),
      createdAt: "2026-08-24T16:39:50.380Z",
      verifiedAt: "2026-08-24T16:39:50.394Z",
      expiresAt: "2026-08-25T16:39:50.380Z",
    },
    registry: {
      summary,
      sha256: sha256(canonicalJson(summary)),
    },
    packageMetadata: {
      observedAt: "2026-08-24T17:01:00.000Z",
      packages: Object.fromEntries(
        Object.entries(PRODUCTION_IMAGE_SPECS).map(([key, spec], index) => [
          key,
          {
            name: spec.repository.split("/").at(-1),
            packageType: "container",
            ownerLogin: "modvolt",
            ownerId: "289280891",
            visibility: "private",
            id: String(10_000 + index),
            versionCount: 1 + index,
          },
        ]),
      ),
    },
    rawEvidence: {
      custodySha256: CUSTODY_SHA,
      custodyVerificationSha256: digest("custody-verification"),
      packageMetadataSha256: digest("package-metadata"),
      registrySummarySha256: sha256(canonicalJson(summary)),
      images: Object.fromEntries(
        Object.keys(images).map((key) => [key, digest(`${key}:raw-image`)]),
      ),
      registryResults: Object.fromEntries(
        Object.entries(images).map(([key, image]) => [
          key,
          image.registryEvidenceSha256,
        ]),
      ),
    },
    images,
    reviewedImageSetSha256: reviewedSet,
    policy: {
      registryWriteCompleted: true,
      packagesVisibilityVerified: true,
      platform: "linux/amd64",
      githubActionsArtifactClaimed: false,
      productionTargetsTouched: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      migrationAuthorized: false,
      migrationPerformed: false,
    },
    createdAt: "2026-08-24T17:02:00.000Z",
  };
}

test("seals and parses a truthful manual complete receipt without publication run or artifact identity", () => {
  const receipt = receiptFixture();
  const sealed = sealManualProductionImageCompleteReceipt(receipt);
  assert.equal(sealed.canonical, canonicalJson(receipt));
  assert.equal(sealed.sha256, sha256(sealed.canonical));
  const parsed = parseManualProductionImageCompleteReceipt(sealed.canonical, {
    expectedSourceSha: SOURCE_SHA,
    expectedReceiptSha256: sealed.sha256,
  });
  assert.deepEqual(parsed.receipt, receipt);
  assert.equal(parsed.canonical.includes("completeRunId"), false);
  assert.equal(parsed.canonical.includes("artifactId"), false);
});

test("rejects invented GitHub publication run and artifact claims", () => {
  for (const [field, value] of [
    ["completeRunId", "32699999999"],
    ["artifactId", "123456"],
    ["preflightArtifactDigest", digest("invented-artifact")],
  ]) {
    const receipt = receiptFixture();
    receipt[field] = value;
    assert.throws(
      () => validateManualProductionImageCompleteReceipt(receipt),
      /MANUAL_PRODUCTION_IMAGE_GITHUB_IDENTITY_FORBIDDEN/,
    );
  }
});

test("rejects partial registry evidence and digest drift", () => {
  const partial = receiptFixture();
  delete partial.registry.summary.images.web;
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(partial),
    /MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID/,
  );

  const drifted = receiptFixture();
  drifted.registry.summary.images.api.digest = digest("wrong-registry-digest");
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(drifted),
    /MANUAL_PRODUCTION_IMAGE_BINDING_INVALID/,
  );

  const filesystemDrift = receiptFixture();
  filesystemDrift.images.api.filesystemManifest.layers[0].size += 1;
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(filesystemDrift),
    /MANUAL_PRODUCTION_IMAGE_BINDING_INVALID/,
  );

  const oversizedArchive = receiptFixture();
  oversizedArchive.images.api.ociArchive.sizeBytes =
    20 * 1024 * 1024 * 1024 + 1;
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(oversizedArchive),
    /MANUAL_PRODUCTION_IMAGE_BINDING_INVALID/,
  );
});

test("rejects package visibility, owner and version drift", () => {
  const cases = [
    (receipt) => (receipt.packageMetadata.packages.api.visibility = "public"),
    (receipt) => (receipt.packageMetadata.packages.api.ownerId = "1"),
    (receipt) => (receipt.packageMetadata.packages.api.versionCount = 0),
  ];
  for (const mutate of cases) {
    const receipt = receiptFixture();
    mutate(receipt);
    assert.throws(
      () => validateManualProductionImageCompleteReceipt(receipt),
      /MANUAL_PRODUCTION_IMAGE_(BINDING|POLICY)_INVALID/,
    );
  }
});

test("rejects deployment or migration authorization and invalid chronology", () => {
  for (const field of [
    "productionTargetsTouched",
    "deploymentAuthorized",
    "deploymentPerformed",
    "migrationAuthorized",
    "migrationPerformed",
  ]) {
    const receipt = receiptFixture();
    receipt.policy[field] = true;
    assert.throws(
      () => validateManualProductionImageCompleteReceipt(receipt),
      /MANUAL_PRODUCTION_IMAGE_POLICY_INVALID/,
    );
  }
  const stale = receiptFixture();
  stale.createdAt = "2026-08-25T16:40:00.000Z";
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(stale),
    /MANUAL_PRODUCTION_IMAGE_TIME_INVALID/,
  );
});

test("requires canonical secret-free bytes and the reviewed receipt digest", () => {
  const sealed = sealManualProductionImageCompleteReceipt(receiptFixture());
  assert.throws(
    () => parseManualProductionImageCompleteReceipt(`${sealed.canonical}\n`),
    /MANUAL_PRODUCTION_IMAGE_BINDING_INVALID/,
  );
  assert.throws(
    () =>
      parseManualProductionImageCompleteReceipt(sealed.canonical, {
        expectedReceiptSha256: digest("wrong-receipt"),
      }),
    /MANUAL_PRODUCTION_IMAGE_BINDING_INVALID/,
  );
  const secret = receiptFixture();
  secret.packageMetadata.packages.api.accessToken = "ghp_12345678901234567890";
  assert.throws(
    () => validateManualProductionImageCompleteReceipt(secret),
    /PRODUCTION_IMAGE_SECRET_MATERIAL/,
  );
});
