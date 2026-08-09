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
      "sourceSha",
      "sourceTree",
      "migrationContract",
      "callerRepository",
      "callerWorkflowRef",
      "initialTagState",
      "registryAction",
      "publisherRun",
      "image",
      "package",
    ],
    "manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "site-logbook-staging-predecessor-api" ||
    manifest.sourceSha !== FIXED_SOURCE_SHA ||
    manifest.sourceTree !== FIXED_SOURCE_TREE
  ) {
    fail(
      "PREDECESSOR_SOURCE_MISMATCH",
      "Manifest is not bound to the fixed audited predecessor source and tree.",
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
  const validPublicationState =
    (manifest.initialTagState === "absent" &&
      manifest.registryAction === "published") ||
    (manifest.initialTagState === "present" &&
      manifest.registryAction === "verified-noop");
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
      "remoteManifestVerified",
      "provenanceVerified",
      "sbomVerified",
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
    pkg.remoteManifestVerified !== true ||
    pkg.provenanceVerified !== true ||
    pkg.sbomVerified !== true
  ) {
    fail(
      "PREDECESSOR_PACKAGE_INVALID",
      "Package evidence is not bound to the fixed private exact-digest API image.",
    );
  }

  const trusted = options.expectedManifestSha256 !== undefined;
  return Object.freeze({
    decision: trusted ? "PASS" : "INTERNALLY_CONSISTENT_UNTRUSTED",
    trusted,
    schemaVersion: 1,
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
