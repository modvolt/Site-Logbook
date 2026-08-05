import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const MAX_MANIFEST_BYTES = 128 * 1024;
const IMAGE_SPECS = Object.freeze({
  preflight: {
    packageName: "site-logbook-staging-preflight",
    repository: "ghcr.io/modvolt/site-logbook-staging-preflight",
  },
  mailpit: {
    packageName: "site-logbook-staging-mailpit",
    repository: "ghcr.io/modvolt/site-logbook-staging-mailpit",
  },
  api: {
    packageName: "site-logbook-staging-api",
    repository: "ghcr.io/modvolt/site-logbook-staging-api",
  },
  web: {
    packageName: "site-logbook-staging-web",
    repository: "ghcr.io/modvolt/site-logbook-staging-web",
  },
  alertReceiver: {
    packageName: "site-logbook-staging-alert-receiver",
    repository: "ghcr.io/modvolt/site-logbook-staging-alert-receiver",
  },
});

export class StagingImageManifestError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingImageManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingImageManifestError(code, message);
}

function assertKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("IMAGE_MANIFEST_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      "IMAGE_MANIFEST_SCHEMA_INVALID",
      `${field} has missing or unknown fields.`,
    );
  }
}

function requireString(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("IMAGE_MANIFEST_SCHEMA_INVALID", `${field} has an invalid value.`);
  }
  return value;
}

function parseStrictJson(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    fail("IMAGE_MANIFEST_INPUT_INVALID", "Manifest input must be raw bytes.");
  }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    fail(
      "IMAGE_MANIFEST_SIZE_INVALID",
      "Manifest size must be 1 through 131072 bytes.",
    );
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail("IMAGE_MANIFEST_ENCODING_INVALID", "UTF-8 BOM is forbidden.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("IMAGE_MANIFEST_ENCODING_INVALID", "Manifest must be valid UTF-8.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("IMAGE_MANIFEST_JSON_INVALID", "Manifest must be strict JSON.");
  }
  const duplicateCheck = parseDocument(text, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (duplicateCheck.errors.length > 0) {
    fail("IMAGE_MANIFEST_DUPLICATE_KEY", "Manifest contains a duplicate key.");
  }
  return parsed;
}

function validateChecksum(bytes, checksumText, expectedManifestSha256) {
  if (typeof checksumText !== "string") {
    fail("IMAGE_MANIFEST_CHECKSUM_INVALID", "Checksum sidecar is required.");
  }
  const match = /^([0-9a-f]{64})[ ]{2}staging-images\.json\n$/.exec(
    checksumText,
  );
  if (!match) {
    fail(
      "IMAGE_MANIFEST_CHECKSUM_INVALID",
      "Checksum sidecar must use the exact GNU sha256sum format.",
    );
  }
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (match[1] !== actual) {
    fail(
      "IMAGE_MANIFEST_CHECKSUM_MISMATCH",
      "Manifest bytes do not match their checksum sidecar.",
    );
  }
  if (expectedManifestSha256 !== undefined) {
    requireString(expectedManifestSha256, SHA256, "expectedManifestSha256");
    if (expectedManifestSha256 !== actual) {
      fail(
        "IMAGE_MANIFEST_TRUST_MISMATCH",
        "Manifest does not match the separately approved checksum.",
      );
    }
  }
  return actual;
}

export function validateStagingImageManifest(
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
      "sourceSha",
      "callerRepository",
      "callerWorkflowRef",
      "initialPackageState",
      "registryAction",
      "publisherRun",
      "images",
      "packages",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== 1) {
    fail("IMAGE_MANIFEST_SCHEMA_INVALID", "schemaVersion must equal 1.");
  }
  const sourceSha = requireString(manifest.sourceSha, SHA40, "sourceSha");
  if (/^0{40}$/.test(sourceSha)) {
    fail(
      "IMAGE_MANIFEST_SOURCE_MISMATCH",
      "sourceSha cannot be a placeholder.",
    );
  }
  if (options.expectedSourceSha && sourceSha !== options.expectedSourceSha) {
    fail(
      "IMAGE_MANIFEST_SOURCE_MISMATCH",
      "sourceSha does not match the approved source SHA.",
    );
  }
  if (manifest.callerRepository !== "modvolt/site-logbook-registry") {
    fail(
      "IMAGE_MANIFEST_CALLER_INVALID",
      "callerRepository is not the private registry repository.",
    );
  }
  requireString(manifest.callerWorkflowRef, /^\S+$/, "callerWorkflowRef");
  if (
    options.expectedCallerWorkflowRef &&
    manifest.callerWorkflowRef !== options.expectedCallerWorkflowRef
  ) {
    fail(
      "IMAGE_MANIFEST_CALLER_INVALID",
      "callerWorkflowRef does not match the approved workflow ref.",
    );
  }
  const allowedPublication =
    (manifest.initialPackageState === "10000" &&
      manifest.registryAction === "published") ||
    (manifest.initialPackageState === "11111" &&
      manifest.registryAction === "verified-noop");
  if (!allowedPublication) {
    fail(
      "IMAGE_MANIFEST_PUBLICATION_STATE_INVALID",
      "Package state and registry action are not a complete-stage pair.",
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
    options.expectedRunId &&
    manifest.publisherRun.id !== options.expectedRunId
  ) {
    fail(
      "IMAGE_MANIFEST_RUN_MISMATCH",
      "publisherRun.id does not match trusted evidence.",
    );
  }
  if (
    options.expectedRunAttempt &&
    manifest.publisherRun.attempt !== options.expectedRunAttempt
  ) {
    fail(
      "IMAGE_MANIFEST_RUN_MISMATCH",
      "publisherRun.attempt does not match trusted evidence.",
    );
  }

  const imageKeys = Object.keys(IMAGE_SPECS);
  assertKeys(manifest.images, imageKeys, "images");
  assertKeys(manifest.packages, imageKeys, "packages");
  for (const [key, spec] of Object.entries(IMAGE_SPECS)) {
    const imagePattern = new RegExp(
      `^${spec.repository.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`,
    );
    const image = requireString(
      manifest.images[key],
      imagePattern,
      `images.${key}`,
    );
    const digest = image.slice(image.indexOf("@") + 1);
    const pkg = manifest.packages[key];
    assertKeys(
      pkg,
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
      `packages.${key}`,
    );
    if (
      pkg.packageName !== spec.packageName ||
      !POSITIVE_DECIMAL.test(pkg.packageId) ||
      pkg.visibility !== "private" ||
      pkg.repository !== "modvolt/site-logbook-registry" ||
      pkg.registryRepository !== spec.repository ||
      pkg.sourceSha !== sourceSha ||
      !POSITIVE_DECIMAL.test(pkg.versionId) ||
      pkg.digest !== digest ||
      !/^sha256:[0-9a-f]{64}$/.test(pkg.runnableManifestDigest) ||
      pkg.platform !== "linux/amd64" ||
      pkg.remoteManifestVerified !== true ||
      pkg.provenanceVerified !== true ||
      pkg.sbomVerified !== true
    ) {
      fail(
        "IMAGE_MANIFEST_PACKAGE_INVALID",
        `packages.${key} is not bound to its verified image.`,
      );
    }
  }

  const trusted = options.expectedManifestSha256 !== undefined;
  return Object.freeze({
    decision: trusted ? "PASS" : "INTERNALLY_CONSISTENT_UNTRUSTED",
    trusted,
    schemaVersion: 1,
    sourceSha,
    manifestSha256,
    callerWorkflowRef: manifest.callerWorkflowRef,
    publisherRun: Object.freeze({ ...manifest.publisherRun }),
    images: Object.freeze({ ...manifest.images }),
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
      "IMAGE_MANIFEST_INPUT_INVALID",
      `${label} must be a regular nonsymlink file.`,
    );
  }
}

function main() {
  const manifestPath = path.resolve(argument("--manifest") ?? "");
  const checksumPath = path.resolve(argument("--checksum") ?? "");
  if (!argument("--manifest") || !argument("--checksum")) {
    fail("IMAGE_MANIFEST_INPUT_INVALID", "Pass --manifest and --checksum.");
  }
  requireRegularFile(manifestPath, "manifest");
  requireRegularFile(checksumPath, "checksum");
  const result = validateStagingImageManifest(
    fs.readFileSync(manifestPath),
    fs.readFileSync(checksumPath, "utf8"),
    {
      expectedManifestSha256: argument("--expected-manifest-sha256"),
      expectedSourceSha: argument("--expected-source-sha"),
      expectedCallerWorkflowRef: argument("--expected-caller-workflow-ref"),
      expectedRunId: argument("--expected-run-id"),
      expectedRunAttempt: argument("--expected-run-attempt"),
    },
  );
  const output = { ...result };
  if (!result.trusted) {
    delete output.manifestBase64;
    delete output.images;
  }
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
