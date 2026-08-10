import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const FIXED_SOURCE_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const FIXED_SOURCE_TREE = "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
const FIXED_CALLER_REPOSITORY = "modvolt/site-logbook-registry";
const FIXED_CALLER_WORKFLOW_REF =
  "modvolt/site-logbook-registry/.github/workflows/publish-staging-predecessor.yml@refs/heads/main";
const FIXED_PACKAGE = "site-logbook-staging-api";
const FIXED_REGISTRY_REPOSITORY = `ghcr.io/modvolt/${FIXED_PACKAGE}`;
const FIXED_BUILDX = "v0.34.1";
const FIXED_BUILDKIT_IMAGE =
  "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f";
const FIXED_BASE_IMAGE_DIGEST =
  "sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";
const FIXED_SOURCE_URL = "https://github.com/modvolt/Site-Logbook";
const FIXED_COMMIT_URL = `${FIXED_SOURCE_URL}/commit/${FIXED_SOURCE_SHA}`;
const VCS_SOURCE =
  /^(https:\/\/github\.com\/modvolt\/site-logbook(?:\.git)?|git\+https:\/\/github\.com\/modvolt\/site-logbook(?:\.git)?|git@github\.com:modvolt\/site-logbook\.git)$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

export class StagingPredecessorImageError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingPredecessorImageError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingPredecessorImageError(code, message);
}

function assertKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PREDECESSOR_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      "PREDECESSOR_SCHEMA_INVALID",
      `${field} has missing or unknown fields.`,
    );
  }
}

function requireString(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("PREDECESSOR_SCHEMA_INVALID", `${field} has an invalid value.`);
  }
  return value;
}

function rejectSecretMaterial(value, pathLabel = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectSecretMaterial(entry, `${pathLabel}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        /(password|secret|token|authorization|credential|private.?key|keyring)/i.test(
          key,
        )
      ) {
        fail(
          "PREDECESSOR_SECRET_MATERIAL",
          `${pathLabel}.${key} is forbidden in secret-free evidence.`,
        );
      }
      rejectSecretMaterial(child, `${pathLabel}.${key}`);
    }
    return;
  }
  if (
    typeof value === "string" &&
    /(-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+\S+|postgres(?:ql)?:\/\/[^\s]+@)/i.test(
      value,
    )
  ) {
    fail(
      "PREDECESSOR_SECRET_MATERIAL",
      `${pathLabel} contains forbidden secret-shaped material.`,
    );
  }
}

function parseStrictJson(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    fail("PREDECESSOR_INPUT_INVALID", "Manifest input must be raw bytes.");
  }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    fail(
      "PREDECESSOR_SIZE_INVALID",
      "Manifest size must be 1 through 65536 bytes.",
    );
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail("PREDECESSOR_ENCODING_INVALID", "UTF-8 BOM is forbidden.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("PREDECESSOR_ENCODING_INVALID", "Manifest must be valid UTF-8.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("PREDECESSOR_JSON_INVALID", "Manifest must be strict JSON.");
  }
  const duplicateCheck = parseDocument(text, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (duplicateCheck.errors.length > 0) {
    fail("PREDECESSOR_DUPLICATE_KEY", "Manifest contains a duplicate key.");
  }
  rejectSecretMaterial(parsed);
  return parsed;
}

function validateChecksum(bytes, checksumText, expectedManifestSha256) {
  if (typeof checksumText !== "string") {
    fail("PREDECESSOR_CHECKSUM_INVALID", "Checksum sidecar is required.");
  }
  const match = /^([0-9a-f]{64})[ ]{2}staging-predecessor-image\.json\n$/.exec(
    checksumText,
  );
  if (!match) {
    fail(
      "PREDECESSOR_CHECKSUM_INVALID",
      "Checksum sidecar must use the exact GNU sha256sum format.",
    );
  }
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (match[1] !== actual) {
    fail(
      "PREDECESSOR_CHECKSUM_MISMATCH",
      "Manifest bytes do not match their checksum sidecar.",
    );
  }
  if (expectedManifestSha256 !== undefined) {
    requireString(expectedManifestSha256, SHA256, "expectedManifestSha256");
    if (expectedManifestSha256 !== actual) {
      fail(
        "PREDECESSOR_TRUST_MISMATCH",
        "Manifest does not match the separately approved checksum.",
      );
    }
  }
  return actual;
}

export function validateStagingPredecessorImage(
  manifestBytes,
  checksumText,
  options = {},
) {
  const manifestSha256 = validateChecksum(
    manifestBytes,
    checksumText,
    options.expectedManifestSha256,
  );
  const manifest = parseStrictJson(manifestBytes);
  assertKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "executionMode",
      "sourceSha",
      "sourceTree",
      "migrationContract",
      "callerRepository",
      "callerWorkflowRef",
      "initialTagState",
      "registryAction",
      "publisherRun",
      "toolchain",
      "image",
      "package",
    ],
    "manifest",
  );
  if (
    manifest.schemaVersion !== 3 ||
    manifest.kind !== "site-logbook-staging-predecessor-api" ||
    manifest.sourceSha !== FIXED_SOURCE_SHA ||
    manifest.sourceTree !== FIXED_SOURCE_TREE
  ) {
    fail(
      "PREDECESSOR_SOURCE_MISMATCH",
      "Manifest is not bound to the fixed audited predecessor source and tree.",
    );
  }
  assertKeys(manifest.toolchain, ["buildx", "buildkitImage"], "toolchain");
  if (
    manifest.toolchain.buildx !== FIXED_BUILDX ||
    manifest.toolchain.buildkitImage !== FIXED_BUILDKIT_IMAGE
  ) {
    fail(
      "PREDECESSOR_TOOLCHAIN_INVALID",
      "Publisher toolchain is not bound to the audited Buildx and BuildKit versions.",
    );
  }
  assertKeys(
    manifest.migrationContract,
    ["count", "tail", "excluded0100", "excluded0105"],
    "migrationContract",
  );
  if (
    manifest.migrationContract.count !== 104 ||
    manifest.migrationContract.tail !== "0104_thin_sheva_callister" ||
    manifest.migrationContract.excluded0100 !== true ||
    manifest.migrationContract.excluded0105 !== true
  ) {
    fail(
      "PREDECESSOR_MIGRATION_CONTRACT_INVALID",
      "Predecessor migration contract must be exact 104/0104 with 0100 and 0105 absent.",
    );
  }
  if (
    manifest.callerRepository !== FIXED_CALLER_REPOSITORY ||
    manifest.callerWorkflowRef !== FIXED_CALLER_WORKFLOW_REF
  ) {
    fail(
      "PREDECESSOR_CALLER_INVALID",
      "Manifest is not bound to the approved private main-branch wrapper.",
    );
  }
  if (
    options.expectedCallerWorkflowRef !== undefined &&
    options.expectedCallerWorkflowRef !== manifest.callerWorkflowRef
  ) {
    fail(
      "PREDECESSOR_CALLER_INVALID",
      "callerWorkflowRef does not match trusted evidence.",
    );
  }
  const validExecutionMode = [
    "verify-existing-only",
    "publication-capable",
  ].includes(manifest.executionMode);
  if (!validExecutionMode) {
    fail(
      "PREDECESSOR_EXECUTION_MODE_INVALID",
      "Evidence execution mode is not an allowed fixed predecessor mode.",
    );
  }
  const validPublicationState =
    (manifest.executionMode === "verify-existing-only" &&
      manifest.initialTagState === "present" &&
      manifest.registryAction === "verified-noop") ||
    (manifest.executionMode === "publication-capable" &&
      ((manifest.initialTagState === "absent" &&
        manifest.registryAction === "published") ||
        (manifest.initialTagState === "present" &&
          manifest.registryAction === "verified-noop")));
  if (!validPublicationState) {
    fail(
      "PREDECESSOR_PUBLICATION_STATE_INVALID",
      "Initial tag state and registry action are not an allowed immutable pair.",
    );
  }
  assertKeys(manifest.publisherRun, ["id", "attempt"], "publisherRun");
  requireString(manifest.publisherRun.id, POSITIVE_DECIMAL, "publisherRun.id");
  requireString(
    manifest.publisherRun.attempt,
    POSITIVE_DECIMAL,
    "publisherRun.attempt",
  );
  if (
    options.expectedRunId !== undefined &&
    options.expectedRunId !== manifest.publisherRun.id
  ) {
    fail("PREDECESSOR_RUN_MISMATCH", "publisherRun.id is not trusted.");
  }
  if (
    options.expectedRunAttempt !== undefined &&
    options.expectedRunAttempt !== manifest.publisherRun.attempt
  ) {
    fail("PREDECESSOR_RUN_MISMATCH", "publisherRun.attempt is not trusted.");
  }

  requireString(
    manifest.image,
    /^ghcr\.io\/modvolt\/site-logbook-staging-api@sha256:[0-9a-f]{64}$/,
    "image",
  );
  const digest = manifest.image.slice(manifest.image.indexOf("@") + 1);
  assertKeys(
    manifest.package,
    [
      "packageName",
      "packageId",
      "visibility",
      "repository",
      "registryRepository",
      "sourceSha",
      "versionId",
      "digest",
      "runnableManifestDigest",
      "platform",
      "activeInventoryPaginated",
      "activeVersionCount",
      "packageVersionCount",
      "deletedInventoryMode",
      "visibleDeletedTagConflictChecked",
      "deletedVersionCount",
      "deletedHistoryScope",
      "selectedVersionRefetched",
      "remoteManifestVerified",
      "runtimeMetadata",
      "provenance",
      "sbom",
    ],
    "package",
  );
  const pkg = manifest.package;
  if (
    pkg.packageName !== FIXED_PACKAGE ||
    !POSITIVE_DECIMAL.test(pkg.packageId) ||
    pkg.visibility !== "private" ||
    pkg.repository !== FIXED_CALLER_REPOSITORY ||
    pkg.registryRepository !== FIXED_REGISTRY_REPOSITORY ||
    pkg.sourceSha !== FIXED_SOURCE_SHA ||
    !POSITIVE_DECIMAL.test(pkg.versionId) ||
    !DIGEST.test(pkg.digest) ||
    pkg.digest !== digest ||
    !DIGEST.test(pkg.runnableManifestDigest) ||
    pkg.platform !== "linux/amd64" ||
    pkg.activeInventoryPaginated !== true ||
    !Number.isSafeInteger(pkg.activeVersionCount) ||
    pkg.activeVersionCount < 1 ||
    !Number.isSafeInteger(pkg.packageVersionCount) ||
    pkg.packageVersionCount !== pkg.activeVersionCount ||
    pkg.selectedVersionRefetched !== true ||
    pkg.remoteManifestVerified !== true
  ) {
    fail(
      "PREDECESSOR_PACKAGE_INVALID",
      "Package evidence is not bound to the fixed private exact-digest API image.",
    );
  }
  const validDeletedInventoryEvidence =
    (manifest.executionMode === "verify-existing-only" &&
      pkg.deletedInventoryMode === "not-applicable-verify-existing-only" &&
      pkg.visibleDeletedTagConflictChecked === false &&
      pkg.deletedVersionCount === null &&
      pkg.deletedHistoryScope === "not-applicable-no-write") ||
    (manifest.executionMode === "publication-capable" &&
      pkg.deletedInventoryMode === "queried-visible-package-versions" &&
      pkg.visibleDeletedTagConflictChecked === true &&
      pkg.deletedVersionCount === 0 &&
      pkg.deletedHistoryScope === "visible-package-versions-only");
  if (!validDeletedInventoryEvidence) {
    fail(
      "PREDECESSOR_DELETED_INVENTORY_INVALID",
      "Deleted-version evidence does not match the selected no-write or publication-capable mode.",
    );
  }
  assertKeys(
    pkg.runtimeMetadata,
    ["source", "revision", "url", "buildSha"],
    "package.runtimeMetadata",
  );
  if (
    pkg.runtimeMetadata.source !== FIXED_SOURCE_URL ||
    pkg.runtimeMetadata.revision !== FIXED_SOURCE_SHA ||
    pkg.runtimeMetadata.url !== FIXED_COMMIT_URL ||
    pkg.runtimeMetadata.buildSha !== FIXED_SOURCE_SHA
  ) {
    fail(
      "PREDECESSOR_RUNTIME_METADATA_INVALID",
      "Runtime image metadata is not bound to the exact predecessor source.",
    );
  }
  assertKeys(
    pkg.provenance,
    [
      "buildType",
      "vcsSource",
      "vcsRevision",
      "dockerfile",
      "buildSha",
      "baseImageDigest",
    ],
    "package.provenance",
  );
  if (
    pkg.provenance.buildType !== "https://mobyproject.org/buildkit@v1" ||
    !VCS_SOURCE.test(pkg.provenance.vcsSource) ||
    pkg.provenance.vcsRevision !== FIXED_SOURCE_SHA ||
    pkg.provenance.dockerfile !== "artifacts/api-server/Dockerfile" ||
    pkg.provenance.buildSha !== FIXED_SOURCE_SHA ||
    pkg.provenance.baseImageDigest !== FIXED_BASE_IMAGE_DIGEST
  ) {
    fail(
      "PREDECESSOR_PROVENANCE_INVALID",
      "Provenance is not bound to the exact source, Dockerfile and base image.",
    );
  }
  assertKeys(
    pkg.sbom,
    ["spdxVersion", "packageCount", "relationshipCount"],
    "package.sbom",
  );
  if (
    !["SPDX-2.2", "SPDX-2.3"].includes(pkg.sbom.spdxVersion) ||
    !Number.isSafeInteger(pkg.sbom.packageCount) ||
    pkg.sbom.packageCount < 1 ||
    !Number.isSafeInteger(pkg.sbom.relationshipCount) ||
    pkg.sbom.relationshipCount < 1
  ) {
    fail(
      "PREDECESSOR_SBOM_INVALID",
      "SBOM evidence must contain a supported SPDX package graph.",
    );
  }

  const trusted = options.expectedManifestSha256 !== undefined;
  return Object.freeze({
    decision: trusted ? "PASS" : "INTERNALLY_CONSISTENT_UNTRUSTED",
    trusted,
    schemaVersion: 3,
    executionMode: manifest.executionMode,
    sourceSha: FIXED_SOURCE_SHA,
    sourceTree: FIXED_SOURCE_TREE,
    manifestSha256,
    callerWorkflowRef: manifest.callerWorkflowRef,
    publisherRun: Object.freeze({ ...manifest.publisherRun }),
    image: manifest.image,
    manifestBase64: trusted ? manifestBytes.toString("base64") : undefined,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(
      "PREDECESSOR_INPUT_INVALID",
      `${label} must be a regular nonsymlink file.`,
    );
  }
}

function main() {
  if (!argument("--manifest") || !argument("--checksum")) {
    fail("PREDECESSOR_INPUT_INVALID", "Pass --manifest and --checksum.");
  }
  const manifestPath = path.resolve(argument("--manifest"));
  const checksumPath = path.resolve(argument("--checksum"));
  requireRegularFile(manifestPath, "manifest");
  requireRegularFile(checksumPath, "checksum");
  const result = validateStagingPredecessorImage(
    fs.readFileSync(manifestPath),
    fs.readFileSync(checksumPath, "utf8"),
    {
      expectedManifestSha256: argument("--expected-manifest-sha256"),
      expectedCallerWorkflowRef: argument("--expected-caller-workflow-ref"),
      expectedRunId: argument("--expected-run-id"),
      expectedRunAttempt: argument("--expected-run-attempt"),
    },
  );
  const output = { ...result };
  if (!result.trusted) delete output.manifestBase64;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
