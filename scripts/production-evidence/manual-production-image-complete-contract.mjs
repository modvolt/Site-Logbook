import {
  PRODUCTION_IMAGE_SPECS,
  assertSecretFree,
  canonicalJson,
  parseStrictSecretFreeJson,
  reviewedImageSetSha256,
  sha256,
} from "./production-image-publication-contract.mjs";

export const MANUAL_PRODUCTION_IMAGE_COMPLETE_SCHEMA =
  "site-logbook.production-image-manual-complete/v1";
export const MANUAL_PRODUCTION_IMAGE_COMPLETE_KIND =
  "site-logbook-production-image-manual-complete";
export const MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE = "manual-offline";

const SOURCE_REPOSITORY = "modvolt/Site-Logbook";
const SOURCE_REF = "refs/heads/main";
const SOURCE_URL = "https://github.com/modvolt/Site-Logbook";
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_OCI_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024;
export const MANUAL_PRODUCTION_IMAGE_MAX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const IMAGE_KEYS = Object.freeze(Object.keys(PRODUCTION_IMAGE_SPECS));
const FORBIDDEN_PUBLICATION_IDENTITY_KEYS = new Set([
  "artifactDigest",
  "artifactId",
  "caller",
  "completeRunAttempt",
  "completeRunId",
  "preflightArtifactDigest",
  "preflightArtifactId",
  "preflightRunAttempt",
  "preflightRunId",
  "publisher",
]);

export class ManualProductionImageCompleteError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ManualProductionImageCompleteError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ManualProductionImageCompleteError(code, message);
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  return value;
}

function exactKeys(value, expectedKeys, field) {
  const object = objectAt(value, field);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return object;
}

function exactString(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID",
      `${field} must be exact text.`,
    );
  }
  return value;
}

function exactSha(value, field) {
  const result = exactString(value, field);
  if (!SHA.test(result) || /^0{40}$/u.test(result)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} must be a Git SHA.`,
    );
  }
  return result;
}

function exactDigest(value, field) {
  const result = exactString(value, field);
  if (!DIGEST.test(result) || /^sha256:0{64}$/u.test(result)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} must be a non-zero SHA-256 digest.`,
    );
  }
  return result;
}

function exactPositiveIntegerString(value, field) {
  const result = exactString(value, field);
  if (!POSITIVE_INTEGER.test(result)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} must be a positive integer string.`,
    );
  }
  return result;
}

function exactPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function exactBoolean(value, expected, field) {
  if (value !== expected) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_POLICY_INVALID",
      `${field} does not match the reviewed policy.`,
    );
  }
  return value;
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} does not match the reviewed binding.`,
    );
  }
}

function exactTime(value, field) {
  const result = exactString(value, field);
  const millis = Date.parse(result);
  if (
    !Number.isFinite(millis) ||
    !result.endsWith("Z") ||
    new Date(millis).toISOString() !== result
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      `${field} must be canonical UTC with millisecond precision.`,
    );
  }
  return result;
}

function assertNoPublicationIdentityClaims(value, field = "receipt") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoPublicationIdentityClaims(entry, `${field}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PUBLICATION_IDENTITY_KEYS.has(key)) {
      fail(
        "MANUAL_PRODUCTION_IMAGE_GITHUB_IDENTITY_FORBIDDEN",
        `${field}.${key} must not claim a GitHub publication run or artifact.`,
      );
    }
    assertNoPublicationIdentityClaims(entry, `${field}.${key}`);
  }
}

function validateSource(value) {
  const source = exactKeys(
    value,
    ["repository", "ref", "sha", "treeSha", "mergeParentShas", "qualityGate"],
    "receipt.source",
  );
  requireEqual(
    source.repository,
    SOURCE_REPOSITORY,
    "receipt.source.repository",
  );
  requireEqual(source.ref, SOURCE_REF, "receipt.source.ref");
  const sourceSha = exactSha(source.sha, "receipt.source.sha");
  exactSha(source.treeSha, "receipt.source.treeSha");
  if (
    !Array.isArray(source.mergeParentShas) ||
    source.mergeParentShas.length !== 2
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      "receipt.source.mergeParentShas must contain exactly two parents.",
    );
  }
  const parents = source.mergeParentShas.map((entry, index) =>
    exactSha(entry, `receipt.source.mergeParentShas[${index}]`),
  );
  if (parents[0] === parents[1] || parents.includes(sourceSha)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      "receipt.source merge parents are ambiguous.",
    );
  }
  const gate = exactKeys(
    source.qualityGate,
    [
      "workflowName",
      "workflowPath",
      "event",
      "headBranch",
      "headSha",
      "runId",
      "runAttempt",
      "conclusion",
    ],
    "receipt.source.qualityGate",
  );
  requireEqual(gate.workflowName, "Quality gate", "qualityGate.workflowName");
  requireEqual(
    gate.workflowPath,
    ".github/workflows/quality-gate.yml",
    "qualityGate.workflowPath",
  );
  requireEqual(gate.event, "push", "qualityGate.event");
  requireEqual(gate.headBranch, "main", "qualityGate.headBranch");
  requireEqual(
    exactSha(gate.headSha, "qualityGate.headSha"),
    sourceSha,
    "qualityGate.headSha",
  );
  exactPositiveIntegerString(gate.runId, "qualityGate.runId");
  requireEqual(
    exactPositiveIntegerString(gate.runAttempt, "qualityGate.runAttempt"),
    "1",
    "qualityGate.runAttempt",
  );
  requireEqual(gate.conclusion, "success", "qualityGate.conclusion");
  return sourceSha;
}

function validateLayers(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID",
      `${field} must be non-empty.`,
    );
  }
  return value.map((entry, index) => {
    const layer = exactKeys(
      entry,
      ["digest", "mediaType", "size"],
      `${field}[${index}]`,
    );
    exactDigest(layer.digest, `${field}[${index}].digest`);
    const mediaType = exactString(
      layer.mediaType,
      `${field}[${index}].mediaType`,
    );
    if (!/^application\/vnd\.(?:oci|docker)\./u.test(mediaType)) {
      fail(
        "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
        `${field}[${index}].mediaType is not an OCI or Docker layer.`,
      );
    }
    exactPositiveInteger(layer.size, `${field}[${index}].size`);
    return layer;
  });
}

function validateImage(value, key, sourceSha) {
  const field = `receipt.images.${key}`;
  const image = exactKeys(
    value,
    [
      "component",
      "repository",
      "image",
      "digest",
      "runnableManifestDigest",
      "configDigest",
      "sourceSha",
      "platform",
      "visibility",
      "published",
      "registryVerified",
      "registryEvidenceSha256",
      "build",
      "provenance",
      "sbom",
      "filesystemManifest",
      "ociArchive",
    ],
    field,
  );
  const spec = PRODUCTION_IMAGE_SPECS[key];
  requireEqual(image.component, spec.component, `${field}.component`);
  requireEqual(image.repository, spec.repository, `${field}.repository`);
  const digest = exactDigest(image.digest, `${field}.digest`);
  requireEqual(image.image, `${spec.repository}@${digest}`, `${field}.image`);
  exactDigest(image.runnableManifestDigest, `${field}.runnableManifestDigest`);
  const configDigest = exactDigest(image.configDigest, `${field}.configDigest`);
  requireEqual(
    exactSha(image.sourceSha, `${field}.sourceSha`),
    sourceSha,
    `${field}.sourceSha`,
  );
  requireEqual(image.platform, "linux/amd64", `${field}.platform`);
  requireEqual(image.visibility, "private", `${field}.visibility`);
  exactBoolean(image.published, true, `${field}.published`);
  exactBoolean(image.registryVerified, true, `${field}.registryVerified`);
  exactDigest(image.registryEvidenceSha256, `${field}.registryEvidenceSha256`);

  const build = exactKeys(
    image.build,
    [
      "dockerfile",
      "target",
      "buildArg",
      "buildArgValue",
      "imageProfile",
      "mutatingEntrypointsPresent",
    ],
    `${field}.build`,
  );
  for (const name of ["dockerfile", "target", "buildArg", "imageProfile"]) {
    requireEqual(build[name], spec[name], `${field}.build.${name}`);
  }
  requireEqual(
    exactSha(build.buildArgValue, `${field}.build.buildArgValue`),
    sourceSha,
    `${field}.build.buildArgValue`,
  );
  requireEqual(
    build.mutatingEntrypointsPresent,
    spec.mutatingEntrypointsPresent,
    `${field}.build.mutatingEntrypointsPresent`,
  );

  const provenance = exactKeys(
    image.provenance,
    [
      "mediaType",
      "sha256",
      "buildType",
      "vcsSource",
      "vcsRevision",
      "dockerfile",
      "target",
      "buildArg",
      "buildArgValue",
    ],
    `${field}.provenance`,
  );
  requireEqual(
    provenance.mediaType,
    "application/vnd.in-toto+json",
    `${field}.provenance.mediaType`,
  );
  exactDigest(provenance.sha256, `${field}.provenance.sha256`);
  requireEqual(
    provenance.buildType,
    "https://mobyproject.org/buildkit@v1",
    `${field}.provenance.buildType`,
  );
  requireEqual(
    provenance.vcsSource,
    SOURCE_URL,
    `${field}.provenance.vcsSource`,
  );
  requireEqual(
    exactSha(provenance.vcsRevision, `${field}.provenance.vcsRevision`),
    sourceSha,
    `${field}.provenance.vcsRevision`,
  );
  for (const name of ["dockerfile", "target", "buildArg"]) {
    requireEqual(provenance[name], spec[name], `${field}.provenance.${name}`);
  }
  requireEqual(
    exactSha(provenance.buildArgValue, `${field}.provenance.buildArgValue`),
    sourceSha,
    `${field}.provenance.buildArgValue`,
  );

  const sbom = exactKeys(
    image.sbom,
    ["mediaType", "sha256", "spdxVersion", "packageCount", "relationshipCount"],
    `${field}.sbom`,
  );
  requireEqual(
    sbom.mediaType,
    "application/spdx+json",
    `${field}.sbom.mediaType`,
  );
  exactDigest(sbom.sha256, `${field}.sbom.sha256`);
  if (sbom.spdxVersion !== "SPDX-2.2" && sbom.spdxVersion !== "SPDX-2.3") {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field}.sbom.spdxVersion is not approved.`,
    );
  }
  exactPositiveInteger(sbom.packageCount, `${field}.sbom.packageCount`);
  exactPositiveInteger(
    sbom.relationshipCount,
    `${field}.sbom.relationshipCount`,
  );

  const filesystem = exactKeys(
    image.filesystemManifest,
    ["format", "configDigest", "layers", "entryCount", "sha256"],
    `${field}.filesystemManifest`,
  );
  requireEqual(
    filesystem.format,
    "oci-layer-manifest/v1",
    `${field}.filesystemManifest.format`,
  );
  requireEqual(
    exactDigest(
      filesystem.configDigest,
      `${field}.filesystemManifest.configDigest`,
    ),
    configDigest,
    `${field}.filesystemManifest.configDigest`,
  );
  const layers = validateLayers(
    filesystem.layers,
    `${field}.filesystemManifest.layers`,
  );
  requireEqual(
    filesystem.entryCount,
    layers.length,
    `${field}.filesystemManifest.entryCount`,
  );
  requireEqual(
    exactDigest(filesystem.sha256, `${field}.filesystemManifest.sha256`),
    sha256(
      canonicalJson({
        format: filesystem.format,
        configDigest,
        layers,
        entryCount: layers.length,
      }),
    ),
    `${field}.filesystemManifest.sha256`,
  );

  const archive = exactKeys(
    image.ociArchive,
    ["sha256", "sizeBytes", "indexDigest"],
    `${field}.ociArchive`,
  );
  exactDigest(archive.sha256, `${field}.ociArchive.sha256`);
  const archiveSize = exactPositiveInteger(
    archive.sizeBytes,
    `${field}.ociArchive.sizeBytes`,
  );
  if (archiveSize > MAX_OCI_ARCHIVE_BYTES) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field}.ociArchive.sizeBytes exceeds the bounded archive policy.`,
    );
  }
  requireEqual(
    exactDigest(archive.indexDigest, `${field}.ociArchive.indexDigest`),
    digest,
    `${field}.ociArchive.indexDigest`,
  );
  return image;
}

function validateRegistryResult(value, key, image, sourceSha) {
  const field = `receipt.registry.summary.images.${key}`;
  const result = exactKeys(
    value,
    [
      "schemaVersion",
      "sourceSha",
      "component",
      "repository",
      "digest",
      "immutableImage",
      "referenceMode",
      "preWriteDigestState",
      "digestAlreadyPresent",
      "registryWritePerformed",
      "sourceRecheckPerformed",
      "digestReferenceVerified",
      "runnableManifestVerified",
      "attestationManifestVerified",
      "allReviewedBlobsVerified",
      "publishedAt",
    ],
    field,
  );
  requireEqual(
    result.schemaVersion,
    "site-logbook.production-image-registry-publication/v1",
    `${field}.schemaVersion`,
  );
  requireEqual(
    exactSha(result.sourceSha, `${field}.sourceSha`),
    sourceSha,
    `${field}.sourceSha`,
  );
  requireEqual(result.component, image.component, `${field}.component`);
  requireEqual(result.repository, image.repository, `${field}.repository`);
  requireEqual(
    exactDigest(result.digest, `${field}.digest`),
    image.digest,
    `${field}.digest`,
  );
  requireEqual(result.immutableImage, image.image, `${field}.immutableImage`);
  requireEqual(result.referenceMode, "digest-only", `${field}.referenceMode`);
  if (
    result.preWriteDigestState !== "present" &&
    result.preWriteDigestState !== "absent"
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      `${field}.preWriteDigestState is invalid.`,
    );
  }
  requireEqual(
    result.digestAlreadyPresent,
    result.preWriteDigestState === "present",
    `${field}.digestAlreadyPresent`,
  );
  requireEqual(
    result.registryWritePerformed,
    result.preWriteDigestState === "absent",
    `${field}.registryWritePerformed`,
  );
  for (const name of [
    "sourceRecheckPerformed",
    "digestReferenceVerified",
    "runnableManifestVerified",
    "attestationManifestVerified",
    "allReviewedBlobsVerified",
  ]) {
    exactBoolean(result[name], true, `${field}.${name}`);
  }
  exactTime(result.publishedAt, `${field}.publishedAt`);
  return result;
}

function validateRegistry(
  value,
  images,
  sourceSha,
  custodySha,
  reviewedSetSha,
) {
  const registry = exactKeys(value, ["summary", "sha256"], "receipt.registry");
  const summary = exactKeys(
    registry.summary,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "custodySha256",
      "reviewedImageSetSha256",
      "allFourImagesRegistryVerified",
      "deploymentAuthorized",
      "deploymentPerformed",
      "migrationAuthorized",
      "migrationPerformed",
      "productionTargetsTouched",
      "publishedAt",
      "images",
    ],
    "receipt.registry.summary",
  );
  requireEqual(
    summary.schemaVersion,
    "site-logbook.production-image-manual-registry-publication/v1",
    "receipt.registry.summary.schemaVersion",
  );
  requireEqual(
    summary.kind,
    "site-logbook-production-image-manual-registry-publication",
    "receipt.registry.summary.kind",
  );
  requireEqual(
    exactSha(summary.sourceSha, "receipt.registry.summary.sourceSha"),
    sourceSha,
    "receipt.registry.summary.sourceSha",
  );
  requireEqual(
    exactDigest(
      summary.custodySha256,
      "receipt.registry.summary.custodySha256",
    ),
    custodySha,
    "receipt.registry.summary.custodySha256",
  );
  requireEqual(
    exactDigest(
      summary.reviewedImageSetSha256,
      "receipt.registry.summary.reviewedImageSetSha256",
    ),
    reviewedSetSha,
    "receipt.registry.summary.reviewedImageSetSha256",
  );
  exactBoolean(
    summary.allFourImagesRegistryVerified,
    true,
    "receipt.registry.summary.allFourImagesRegistryVerified",
  );
  for (const name of [
    "deploymentAuthorized",
    "deploymentPerformed",
    "migrationAuthorized",
    "migrationPerformed",
    "productionTargetsTouched",
  ]) {
    exactBoolean(summary[name], false, `receipt.registry.summary.${name}`);
  }
  const results = exactKeys(
    summary.images,
    IMAGE_KEYS,
    "receipt.registry.summary.images",
  );
  for (const key of IMAGE_KEYS) {
    validateRegistryResult(results[key], key, images[key], sourceSha);
  }
  exactTime(summary.publishedAt, "receipt.registry.summary.publishedAt");
  exactDigest(registry.sha256, "receipt.registry.sha256");
  return summary;
}

function validatePackages(value, registryPublishedAt) {
  const metadata = exactKeys(
    value,
    ["observedAt", "packages"],
    "receipt.packageMetadata",
  );
  const observedAt = exactTime(
    metadata.observedAt,
    "receipt.packageMetadata.observedAt",
  );
  if (Date.parse(observedAt) < Date.parse(registryPublishedAt)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "package metadata predates registry publication.",
    );
  }
  const packages = exactKeys(
    metadata.packages,
    IMAGE_KEYS,
    "receipt.packageMetadata.packages",
  );
  for (const key of IMAGE_KEYS) {
    const field = `receipt.packageMetadata.packages.${key}`;
    const entry = exactKeys(
      packages[key],
      [
        "name",
        "packageType",
        "ownerLogin",
        "ownerId",
        "visibility",
        "id",
        "versionCount",
      ],
      field,
    );
    const expectedName = PRODUCTION_IMAGE_SPECS[key].repository
      .split("/")
      .at(-1);
    requireEqual(entry.name, expectedName, `${field}.name`);
    requireEqual(entry.packageType, "container", `${field}.packageType`);
    requireEqual(entry.ownerLogin, "modvolt", `${field}.ownerLogin`);
    requireEqual(
      exactPositiveIntegerString(entry.ownerId, `${field}.ownerId`),
      "289280891",
      `${field}.ownerId`,
    );
    requireEqual(entry.visibility, "private", `${field}.visibility`);
    exactPositiveIntegerString(entry.id, `${field}.id`);
    exactPositiveInteger(entry.versionCount, `${field}.versionCount`);
  }
  return observedAt;
}

function validateRawEvidenceDigestProjection(value) {
  const projection = exactKeys(
    value,
    [
      "custodySha256",
      "custodyVerificationSha256",
      "packageMetadataSha256",
      "registrySummarySha256",
      "images",
      "registryResults",
    ],
    "receipt.rawEvidence",
  );
  for (const name of [
    "custodySha256",
    "custodyVerificationSha256",
    "packageMetadataSha256",
    "registrySummarySha256",
  ]) {
    exactDigest(projection[name], `receipt.rawEvidence.${name}`);
  }
  const images = exactKeys(
    projection.images,
    IMAGE_KEYS,
    "receipt.rawEvidence.images",
  );
  const registryResults = exactKeys(
    projection.registryResults,
    IMAGE_KEYS,
    "receipt.rawEvidence.registryResults",
  );
  for (const key of IMAGE_KEYS) {
    exactDigest(images[key], `receipt.rawEvidence.images.${key}`);
    exactDigest(
      registryResults[key],
      `receipt.rawEvidence.registryResults.${key}`,
    );
  }
  return projection;
}

export function validateManualProductionImageCompleteReceipt(value) {
  assertSecretFree(value, "manualCompleteReceipt");
  assertNoPublicationIdentityClaims(value);
  const receipt = exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "publicationMode",
      "source",
      "custody",
      "registry",
      "packageMetadata",
      "rawEvidence",
      "images",
      "reviewedImageSetSha256",
      "policy",
      "createdAt",
    ],
    "receipt",
  );
  requireEqual(
    receipt.schemaVersion,
    MANUAL_PRODUCTION_IMAGE_COMPLETE_SCHEMA,
    "receipt.schemaVersion",
  );
  requireEqual(
    receipt.kind,
    MANUAL_PRODUCTION_IMAGE_COMPLETE_KIND,
    "receipt.kind",
  );
  requireEqual(
    receipt.publicationMode,
    MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
    "receipt.publicationMode",
  );
  const sourceSha = validateSource(receipt.source);

  const custody = exactKeys(
    receipt.custody,
    [
      "receiptSha256",
      "verificationSha256",
      "publicationNonceSha256",
      "createdAt",
      "verifiedAt",
      "expiresAt",
    ],
    "receipt.custody",
  );
  const custodySha = exactDigest(
    custody.receiptSha256,
    "receipt.custody.receiptSha256",
  );
  exactDigest(custody.verificationSha256, "receipt.custody.verificationSha256");
  exactDigest(
    custody.publicationNonceSha256,
    "receipt.custody.publicationNonceSha256",
  );
  const custodyCreatedAt = exactTime(
    custody.createdAt,
    "receipt.custody.createdAt",
  );
  const custodyVerifiedAt = exactTime(
    custody.verifiedAt,
    "receipt.custody.verifiedAt",
  );
  const custodyExpiresAt = exactTime(
    custody.expiresAt,
    "receipt.custody.expiresAt",
  );
  if (
    Date.parse(custodyCreatedAt) > Date.parse(custodyVerifiedAt) ||
    Date.parse(custodyVerifiedAt) >= Date.parse(custodyExpiresAt) ||
    Date.parse(custodyExpiresAt) - Date.parse(custodyCreatedAt) >
      24 * 60 * 60 * 1000
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "manual custody chronology is invalid.",
    );
  }

  const images = exactKeys(receipt.images, IMAGE_KEYS, "receipt.images");
  for (const key of IMAGE_KEYS) validateImage(images[key], key, sourceSha);
  const reviewedSetSha = exactDigest(
    receipt.reviewedImageSetSha256,
    "receipt.reviewedImageSetSha256",
  );
  requireEqual(
    reviewedSetSha,
    reviewedImageSetSha256(images),
    "receipt.reviewedImageSetSha256",
  );
  const registrySummary = validateRegistry(
    receipt.registry,
    images,
    sourceSha,
    custodySha,
    reviewedSetSha,
  );
  if (Date.parse(registrySummary.publishedAt) < Date.parse(custodyVerifiedAt)) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "registry publication predates custody verification.",
    );
  }
  const packageObservedAt = validatePackages(
    receipt.packageMetadata,
    registrySummary.publishedAt,
  );
  validateRawEvidenceDigestProjection(receipt.rawEvidence);

  const policy = exactKeys(
    receipt.policy,
    [
      "registryWriteCompleted",
      "packagesVisibilityVerified",
      "platform",
      "githubActionsArtifactClaimed",
      "productionTargetsTouched",
      "deploymentAuthorized",
      "deploymentPerformed",
      "migrationAuthorized",
      "migrationPerformed",
    ],
    "receipt.policy",
  );
  exactBoolean(
    policy.registryWriteCompleted,
    true,
    "receipt.policy.registryWriteCompleted",
  );
  exactBoolean(
    policy.packagesVisibilityVerified,
    true,
    "receipt.policy.packagesVisibilityVerified",
  );
  requireEqual(policy.platform, "linux/amd64", "receipt.policy.platform");
  for (const name of [
    "githubActionsArtifactClaimed",
    "productionTargetsTouched",
    "deploymentAuthorized",
    "deploymentPerformed",
    "migrationAuthorized",
    "migrationPerformed",
  ]) {
    exactBoolean(policy[name], false, `receipt.policy.${name}`);
  }
  const createdAt = exactTime(receipt.createdAt, "receipt.createdAt");
  if (
    Date.parse(createdAt) < Date.parse(packageObservedAt) ||
    Date.parse(createdAt) > Date.parse(custodyExpiresAt)
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "manual complete receipt chronology is invalid.",
    );
  }
  return receipt;
}

function requireSemanticEqual(actual, expected, field) {
  requireEqual(canonicalJson(actual), canonicalJson(expected), field);
}

function normalizedUtc(value, field) {
  const text = exactString(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || !text.endsWith("Z")) {
    fail("MANUAL_PRODUCTION_IMAGE_TIME_INVALID", `${field} must be UTC time.`);
  }
  return new Date(millis).toISOString();
}

function validateRawReviewedImage(value, key, sourceSha) {
  const field = `evidence.images.${key}`;
  const image = objectAt(value, field);
  requireEqual(image.published, false, `${field}.published`);
  requireEqual(image.registryVerified, false, `${field}.registryVerified`);
  requireEqual(
    image.registryEvidenceSha256,
    null,
    `${field}.registryEvidenceSha256`,
  );
  const completed = structuredClone(image);
  completed.published = true;
  completed.registryVerified = true;
  completed.registryEvidenceSha256 = sha256(`reviewed-image:${key}`);
  validateImage(completed, key, sourceSha);
  return image;
}

function validateRawCustody(value) {
  const custody = exactKeys(
    value,
    [
      "builder",
      "execution",
      "extraction",
      "images",
      "kind",
      "policy",
      "reviewedImageSetSha256",
      "schemaVersion",
      "source",
      "workflowFileSha256",
    ],
    "evidence.custody",
  );
  requireEqual(
    custody.schemaVersion,
    "site-logbook.production-image-manual-custody/v1",
    "evidence.custody.schemaVersion",
  );
  requireEqual(
    custody.kind,
    "site-logbook-production-image-manual-custody",
    "evidence.custody.kind",
  );
  const sourceSha = validateSource(custody.source);
  exactDigest(
    custody.workflowFileSha256,
    "evidence.custody.workflowFileSha256",
  );
  const builder = exactKeys(
    custody.builder,
    [
      "buildkit",
      "buildx",
      "dockerCliImage",
      "exactSourceCheckout",
      "platform",
      "slsaProvenanceVersion",
    ],
    "evidence.custody.builder",
  );
  for (const name of ["buildkit", "buildx", "dockerCliImage"]) {
    exactString(builder[name], `evidence.custody.builder.${name}`);
  }
  requireEqual(
    builder.exactSourceCheckout,
    "linux-native-git-object-checkout",
    "evidence.custody.builder.exactSourceCheckout",
  );
  requireEqual(
    builder.platform,
    "linux/amd64",
    "evidence.custody.builder.platform",
  );
  requireEqual(
    builder.slsaProvenanceVersion,
    "v0.2",
    "evidence.custody.builder.slsaProvenanceVersion",
  );
  const execution = exactKeys(
    custody.execution,
    ["createdAt", "expiresAt", "mode", "operator", "publicationNonceSha256"],
    "evidence.custody.execution",
  );
  requireEqual(
    execution.mode,
    "operator-local",
    "evidence.custody.execution.mode",
  );
  requireEqual(
    execution.operator,
    "modvolt",
    "evidence.custody.execution.operator",
  );
  const createdAt = normalizedUtc(
    execution.createdAt,
    "evidence.custody.execution.createdAt",
  );
  const expiresAt = normalizedUtc(
    execution.expiresAt,
    "evidence.custody.execution.expiresAt",
  );
  const publicationNonceSha256 = exactDigest(
    execution.publicationNonceSha256,
    "evidence.custody.execution.publicationNonceSha256",
  );
  const extraction = exactKeys(
    custody.extraction,
    ["layoutsDirectory", "policy"],
    "evidence.custody.extraction",
  );
  exactString(
    extraction.layoutsDirectory,
    "evidence.custody.extraction.layoutsDirectory",
  );
  requireEqual(
    extraction.policy,
    "workflow-safe-extract-oci-v1",
    "evidence.custody.extraction.policy",
  );
  const policy = exactKeys(
    custody.policy,
    [
      "deploymentAuthorized",
      "githubActionsArtifactClaimed",
      "migrationAuthorized",
      "productionTargetsTouched",
      "registryWritePermitted",
    ],
    "evidence.custody.policy",
  );
  for (const name of [
    "deploymentAuthorized",
    "githubActionsArtifactClaimed",
    "migrationAuthorized",
    "productionTargetsTouched",
    "registryWritePermitted",
  ]) {
    exactBoolean(policy[name], false, `evidence.custody.policy.${name}`);
  }
  const images = exactKeys(
    custody.images,
    IMAGE_KEYS,
    "evidence.custody.images",
  );
  for (const key of IMAGE_KEYS) {
    validateRawReviewedImage(images[key], key, sourceSha);
  }
  const reviewedSetSha256 = exactDigest(
    custody.reviewedImageSetSha256,
    "evidence.custody.reviewedImageSetSha256",
  );
  requireEqual(
    reviewedSetSha256,
    reviewedImageSetSha256(images),
    "evidence.custody.reviewedImageSetSha256",
  );
  return {
    value: custody,
    sourceSha,
    createdAt,
    expiresAt,
    publicationNonceSha256,
    reviewedSetSha256,
    images,
  };
}

function validateRawCustodyVerification(value, custody, custodySha256) {
  const verification = exactKeys(
    value,
    [
      "allReviewedOciLayoutsVerified",
      "currentPublicMainRechecked",
      "custodySha256",
      "kind",
      "qualityRunRechecked",
      "reviewedImageSetSha256",
      "safeExtractionVerified",
      "schemaVersion",
      "sourceSha",
      "sourceTreeSha",
      "verifiedAt",
    ],
    "evidence.custodyVerification",
  );
  requireEqual(
    verification.schemaVersion,
    "site-logbook.production-image-manual-custody-verification/v1",
    "evidence.custodyVerification.schemaVersion",
  );
  requireEqual(
    verification.kind,
    "site-logbook-production-image-manual-custody-verification",
    "evidence.custodyVerification.kind",
  );
  for (const name of [
    "allReviewedOciLayoutsVerified",
    "currentPublicMainRechecked",
    "qualityRunRechecked",
    "safeExtractionVerified",
  ]) {
    exactBoolean(
      verification[name],
      true,
      `evidence.custodyVerification.${name}`,
    );
  }
  requireEqual(
    exactDigest(
      verification.custodySha256,
      "evidence.custodyVerification.custodySha256",
    ),
    custodySha256,
    "evidence.custodyVerification.custodySha256",
  );
  requireEqual(
    exactDigest(
      verification.reviewedImageSetSha256,
      "evidence.custodyVerification.reviewedImageSetSha256",
    ),
    custody.reviewedSetSha256,
    "evidence.custodyVerification.reviewedImageSetSha256",
  );
  requireEqual(
    exactSha(verification.sourceSha, "evidence.custodyVerification.sourceSha"),
    custody.sourceSha,
    "evidence.custodyVerification.sourceSha",
  );
  requireEqual(
    exactSha(
      verification.sourceTreeSha,
      "evidence.custodyVerification.sourceTreeSha",
    ),
    custody.value.source.treeSha,
    "evidence.custodyVerification.sourceTreeSha",
  );
  return {
    value: verification,
    verifiedAt: normalizedUtc(
      verification.verifiedAt,
      "evidence.custodyVerification.verifiedAt",
    ),
  };
}

function normalizeRawPackageMetadata(value, sourceSha, registrySha256) {
  const metadata = exactKeys(
    value,
    [
      "actor",
      "actorId",
      "kind",
      "oauthScopes",
      "observedAt",
      "packages",
      "registryPublicationSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "evidence.packageMetadata",
  );
  requireEqual(
    metadata.schemaVersion,
    "site-logbook.production-image-manual-package-metadata/v1",
    "evidence.packageMetadata.schemaVersion",
  );
  requireEqual(
    metadata.kind,
    "site-logbook-production-image-manual-package-metadata",
    "evidence.packageMetadata.kind",
  );
  requireEqual(metadata.actor, "modvolt", "evidence.packageMetadata.actor");
  requireEqual(metadata.actorId, 289280891, "evidence.packageMetadata.actorId");
  if (
    !Array.isArray(metadata.oauthScopes) ||
    metadata.oauthScopes.length !== 1 ||
    metadata.oauthScopes[0] !== "write:packages"
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
      "evidence.packageMetadata.oauthScopes must be the reviewed package-write scope.",
    );
  }
  requireEqual(
    exactSha(metadata.sourceSha, "evidence.packageMetadata.sourceSha"),
    sourceSha,
    "evidence.packageMetadata.sourceSha",
  );
  requireEqual(
    exactDigest(
      metadata.registryPublicationSha256,
      "evidence.packageMetadata.registryPublicationSha256",
    ),
    registrySha256,
    "evidence.packageMetadata.registryPublicationSha256",
  );
  if (
    !Array.isArray(metadata.packages) ||
    metadata.packages.length !== IMAGE_KEYS.length
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SCHEMA_INVALID",
      "evidence.packageMetadata.packages must contain exactly four entries.",
    );
  }
  const normalizedPackages = {};
  for (const [index, entryValue] of metadata.packages.entries()) {
    const field = `evidence.packageMetadata.packages[${index}]`;
    const entry = exactKeys(
      entryValue,
      ["id", "name", "owner", "package_type", "version_count", "visibility"],
      field,
    );
    const key = IMAGE_KEYS.find(
      (candidate) =>
        PRODUCTION_IMAGE_SPECS[candidate].repository.split("/").at(-1) ===
        entry.name,
    );
    if (!key || Object.hasOwn(normalizedPackages, key)) {
      fail(
        "MANUAL_PRODUCTION_IMAGE_BINDING_INVALID",
        `${field}.name is missing, duplicated or foreign.`,
      );
    }
    const owner = exactKeys(entry.owner, ["id", "login"], `${field}.owner`);
    requireEqual(owner.login, "modvolt", `${field}.owner.login`);
    requireEqual(owner.id, 289280891, `${field}.owner.id`);
    requireEqual(entry.package_type, "container", `${field}.package_type`);
    requireEqual(entry.visibility, "private", `${field}.visibility`);
    exactPositiveInteger(entry.id, `${field}.id`);
    exactPositiveInteger(entry.version_count, `${field}.version_count`);
    normalizedPackages[key] = {
      name: entry.name,
      packageType: entry.package_type,
      ownerLogin: owner.login,
      ownerId: String(owner.id),
      visibility: entry.visibility,
      id: String(entry.id),
      versionCount: entry.version_count,
    };
  }
  return {
    observedAt: normalizedUtc(
      metadata.observedAt,
      "evidence.packageMetadata.observedAt",
    ),
    packages: normalizedPackages,
  };
}

function assertNotFuture(value, nowMs, field) {
  if (
    Date.parse(value) >
    nowMs + MANUAL_PRODUCTION_IMAGE_MAX_FUTURE_TOLERANCE_MS
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      `${field} is beyond the five-minute sign-time tolerance.`,
    );
  }
}

export function validateManualProductionImageCompleteReceiptAgainstRawEvidence(
  receiptValue,
  evidenceValue,
) {
  const evidence = exactKeys(
    evidenceValue,
    [
      "custody",
      "custodySha256",
      "custodyVerification",
      "custodyVerificationSha256",
      "packageMetadata",
      "packageMetadataSha256",
      "registrySummary",
      "registrySummarySha256",
      "images",
      "imageSha256",
      "registryResults",
      "registryResultSha256",
      "nowMs",
    ],
    "evidence",
  );
  assertSecretFree(evidence, "manualCompleteRawEvidence");
  if (!Number.isSafeInteger(evidence.nowMs) || evidence.nowMs <= 0) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "evidence.nowMs must be a positive safe integer.",
    );
  }
  const custodySha256 = exactDigest(
    evidence.custodySha256,
    "evidence.custodySha256",
  );
  const custodyVerificationSha256 = exactDigest(
    evidence.custodyVerificationSha256,
    "evidence.custodyVerificationSha256",
  );
  exactDigest(evidence.packageMetadataSha256, "evidence.packageMetadataSha256");
  const registrySummarySha256 = exactDigest(
    evidence.registrySummarySha256,
    "evidence.registrySummarySha256",
  );
  const imageValues = exactKeys(evidence.images, IMAGE_KEYS, "evidence.images");
  const imageDigests = exactKeys(
    evidence.imageSha256,
    IMAGE_KEYS,
    "evidence.imageSha256",
  );
  const resultValues = exactKeys(
    evidence.registryResults,
    IMAGE_KEYS,
    "evidence.registryResults",
  );
  const resultDigests = exactKeys(
    evidence.registryResultSha256,
    IMAGE_KEYS,
    "evidence.registryResultSha256",
  );
  for (const key of IMAGE_KEYS) {
    exactDigest(imageDigests[key], `evidence.imageSha256.${key}`);
    exactDigest(resultDigests[key], `evidence.registryResultSha256.${key}`);
  }

  const receipt = validateManualProductionImageCompleteReceipt(receiptValue);
  const custody = validateRawCustody(evidence.custody);
  const verification = validateRawCustodyVerification(
    evidence.custodyVerification,
    custody,
    custodySha256,
  );
  requireEqual(
    custody.sourceSha,
    receipt.source.sha,
    "evidence.custody.source.sha",
  );
  const completedImages = {};
  for (const key of IMAGE_KEYS) {
    const rawImage = validateRawReviewedImage(
      imageValues[key],
      key,
      custody.sourceSha,
    );
    requireSemanticEqual(
      rawImage,
      custody.images[key],
      `evidence.images.${key}.custodyProjection`,
    );
    const completed = structuredClone(rawImage);
    completed.published = true;
    completed.registryVerified = true;
    completed.registryEvidenceSha256 = resultDigests[key];
    validateImage(completed, key, custody.sourceSha);
    validateRegistryResult(
      resultValues[key],
      key,
      completed,
      custody.sourceSha,
    );
    completedImages[key] = completed;
  }
  const reviewedSetSha256 = reviewedImageSetSha256(completedImages);
  requireEqual(
    reviewedSetSha256,
    custody.reviewedSetSha256,
    "evidence.reviewedImageSetSha256",
  );
  const registrySummary = validateRegistry(
    {
      summary: evidence.registrySummary,
      sha256: registrySummarySha256,
    },
    completedImages,
    custody.sourceSha,
    custodySha256,
    reviewedSetSha256,
  );
  for (const key of IMAGE_KEYS) {
    requireSemanticEqual(
      registrySummary.images[key],
      resultValues[key],
      `evidence.registrySummary.images.${key}`,
    );
  }
  const packageMetadata = normalizeRawPackageMetadata(
    evidence.packageMetadata,
    custody.sourceSha,
    registrySummarySha256,
  );
  validatePackages(packageMetadata, registrySummary.publishedAt);

  const expectedCustodyProjection = {
    receiptSha256: custodySha256,
    verificationSha256: custodyVerificationSha256,
    publicationNonceSha256: custody.publicationNonceSha256,
    createdAt: custody.createdAt,
    verifiedAt: verification.verifiedAt,
    expiresAt: custody.expiresAt,
  };
  requireSemanticEqual(receipt.source, custody.value.source, "receipt.source");
  requireSemanticEqual(
    receipt.custody,
    expectedCustodyProjection,
    "receipt.custody",
  );
  requireSemanticEqual(receipt.images, completedImages, "receipt.images");
  requireSemanticEqual(
    receipt.registry.summary,
    registrySummary,
    "receipt.registry.summary",
  );
  requireEqual(
    receipt.registry.sha256,
    registrySummarySha256,
    "receipt.registry.sha256",
  );
  requireSemanticEqual(
    receipt.packageMetadata,
    packageMetadata,
    "receipt.packageMetadata",
  );
  requireEqual(
    receipt.reviewedImageSetSha256,
    reviewedSetSha256,
    "receipt.reviewedImageSetSha256",
  );
  requireSemanticEqual(
    receipt.rawEvidence,
    {
      custodySha256,
      custodyVerificationSha256,
      packageMetadataSha256: evidence.packageMetadataSha256,
      registrySummarySha256,
      images: imageDigests,
      registryResults: resultDigests,
    },
    "receipt.rawEvidence",
  );

  if (
    Date.parse(custody.createdAt) > evidence.nowMs ||
    evidence.nowMs > Date.parse(custody.expiresAt)
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_TIME_INVALID",
      "manual custody is not valid at signing time.",
    );
  }
  for (const [field, value] of [
    ["receipt.createdAt", receipt.createdAt],
    ["custodyVerification.verifiedAt", verification.verifiedAt],
    ["packageMetadata.observedAt", packageMetadata.observedAt],
    ["registrySummary.publishedAt", registrySummary.publishedAt],
    ...IMAGE_KEYS.map((key) => [
      `registryResults.${key}.publishedAt`,
      normalizedUtc(
        resultValues[key].publishedAt,
        `evidence.registryResults.${key}.publishedAt`,
      ),
    ]),
  ]) {
    assertNotFuture(value, evidence.nowMs, field);
  }
  return receipt;
}

export function sealManualProductionImageCompleteReceipt(value) {
  const receipt = validateManualProductionImageCompleteReceipt(value);
  const canonical = canonicalJson(receipt);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SIZE_INVALID",
      "manual complete receipt is too large.",
    );
  }
  return Object.freeze({
    receipt: Object.freeze(receipt),
    canonical,
    sha256: sha256(canonical),
  });
}

export function parseManualProductionImageCompleteReceipt(
  raw,
  { expectedSourceSha, expectedReceiptSha256 } = {},
) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_CANONICAL_BYTES
  ) {
    fail(
      "MANUAL_PRODUCTION_IMAGE_SIZE_INVALID",
      "manual complete receipt is not bounded text.",
    );
  }
  const value = parseStrictSecretFreeJson(text, "manualCompleteReceipt");
  const sealed = sealManualProductionImageCompleteReceipt(value);
  requireEqual(text, sealed.canonical, "manualCompleteReceipt.canonical");
  if (expectedSourceSha !== undefined) {
    requireEqual(
      sealed.receipt.source.sha,
      exactSha(expectedSourceSha, "expectedSourceSha"),
      "expectedSourceSha",
    );
  }
  if (expectedReceiptSha256 !== undefined) {
    requireEqual(
      sealed.sha256,
      exactDigest(expectedReceiptSha256, "expectedReceiptSha256"),
      "expectedReceiptSha256",
    );
  }
  return sealed;
}
