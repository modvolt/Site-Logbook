import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_IMAGE_PUBLICATION_SCHEMA =
  "site-logbook.production-image-publication/v1";
export const PRODUCTION_IMAGE_PUBLICATION_KIND =
  "site-logbook-production-image-publication-receipt";
export const PRODUCTION_IMAGE_PUBLICATION_WORKFLOW =
  ".github/workflows/production-images.yml";
export const PRODUCTION_IMAGE_SECRET_SCAN_SCOPE = Object.freeze({
  metadata: "all-reachable-oci-json-and-buildkit-provenance",
  filesystemPayloads: "digest-bound-not-content-scanned",
});
export const PRODUCTION_IMAGE_PUBLICATION_CALLER = Object.freeze({
  repository: "modvolt/site-logbook-registry",
  workflowRef:
    "modvolt/site-logbook-registry/.github/workflows/publish-production-images.yml@refs/heads/main",
});

const SOURCE_REPOSITORY = "modvolt/Site-Logbook";
const SOURCE_URL = "https://github.com/modvolt/Site-Logbook";
const SOURCE_REF = "refs/heads/main";
const QUALITY_WORKFLOW_PATH = ".github/workflows/quality-gate.yml";
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_PREFLIGHT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OCI_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_SOURCE_RECHECK_BYTES = 1024 * 1024;
const MAX_STRICT_JSON_BYTES = 64 * 1024 * 1024;
const MAX_STRICT_JSON_DEPTH = 256;

export const PRODUCTION_IMAGE_SPECS = Object.freeze({
  api: Object.freeze({
    component: "api",
    repository: "ghcr.io/modvolt/site-logbook-production-api",
    dockerfile: "artifacts/api-server/Dockerfile",
    target: "production",
    buildArg: "BUILD_SHA",
    configBuildEnvironment: "BUILD_SHA",
    imageProfile: "production",
    mutatingEntrypointsPresent: false,
  }),
  controlPlane: Object.freeze({
    component: "control-plane",
    repository: "ghcr.io/modvolt/site-logbook-control-plane",
    dockerfile: "artifacts/api-server/Dockerfile",
    target: "control-plane",
    buildArg: "BUILD_SHA",
    configBuildEnvironment: "BUILD_SHA",
    imageProfile: "control-plane",
    mutatingEntrypointsPresent: true,
  }),
  hostOperator: Object.freeze({
    component: "host-operator",
    repository: "ghcr.io/modvolt/site-logbook-host-operator",
    dockerfile: "artifacts/api-server/Dockerfile",
    target: "host-operator",
    buildArg: "BUILD_SHA",
    configBuildEnvironment: null,
    imageProfile: "host-operator",
    mutatingEntrypointsPresent: true,
  }),
  web: Object.freeze({
    component: "web",
    repository: "ghcr.io/modvolt/site-logbook-production-web",
    dockerfile: "artifacts/stavba/Dockerfile",
    target: "runtime",
    buildArg: "VITE_BUILD_SHA",
    configBuildEnvironment: "VITE_BUILD_SHA",
    imageProfile: "production-web",
    mutatingEntrypointsPresent: false,
  }),
});

const FORBIDDEN_KEY =
  /(password|passwd|secret|token|credential|private.?key|database.?url|access.?key|session|cookie)/iu;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]*|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\b(?:PGPASSWORD|POSTGRES_PASSWORD|DATABASE_URL|DIRECT_URL|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|S3_ACCESS_KEY|S3_SECRET_KEY|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD)\s*=|\bSCRAM-SHA-256\$|\bBearer\s+[A-Za-z0-9._~+/-]+=*|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/iu;

export class ProductionImagePublicationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionImagePublicationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionImagePublicationError(code, message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_IMAGE_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, field) {
  const object = objectAt(value, field);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "PRODUCTION_IMAGE_SCHEMA_INVALID",
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
    fail("PRODUCTION_IMAGE_SCHEMA_INVALID", `${field} must be exact text.`);
  }
  return value;
}

function exactSha(value, field) {
  const result = exactString(value, field);
  if (!SHA.test(result) || /^0{40}$/u.test(result)) {
    fail("PRODUCTION_IMAGE_SHA_INVALID", `${field} must be a Git SHA.`);
  }
  return result;
}

function exactDigest(value, field) {
  const result = exactString(value, field);
  if (!DIGEST.test(result) || /^sha256:0{64}$/u.test(result)) {
    fail(
      "PRODUCTION_IMAGE_DIGEST_INVALID",
      `${field} must be a non-zero SHA-256 digest.`,
    );
  }
  return result;
}

function exactPositiveInteger(value, field) {
  const result = exactString(value, field);
  if (!POSITIVE_INTEGER.test(result)) {
    fail(
      "PRODUCTION_IMAGE_RUN_IDENTITY_INVALID",
      `${field} must be a positive integer string.`,
    );
  }
  return result;
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_IMAGE_BINDING_INVALID",
      `${field} does not match the reviewed binding.`,
    );
  }
}

export function assertSecretFree(value, field = "receipt") {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      fail(
        "PRODUCTION_IMAGE_SECRET_MATERIAL",
        `${field} contains forbidden secret-shaped material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) || FORBIDDEN_VALUE.test(key)) {
      fail(
        "PRODUCTION_IMAGE_SECRET_MATERIAL",
        `${field} contains a forbidden secret field.`,
      );
    }
    assertSecretFree(entry, `${field}.${key}`);
  }
}

function strictJsonFailure() {
  fail(
    "PRODUCTION_IMAGE_JSON_INVALID",
    "JSON input must be valid UTF-8 strict JSON with unique object keys.",
  );
}

function strictJsonText(raw) {
  if (typeof raw === "string") {
    if (
      Buffer.byteLength(raw, "utf8") > MAX_STRICT_JSON_BYTES ||
      raw.charCodeAt(0) === 0xfeff
    ) {
      strictJsonFailure();
    }
    return raw;
  }
  if (!Buffer.isBuffer(raw) && !ArrayBuffer.isView(raw)) {
    strictJsonFailure();
  }
  if (raw.byteLength > MAX_STRICT_JSON_BYTES) strictJsonFailure();
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    strictJsonFailure();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    strictJsonFailure();
  }
}

function assertUniqueJsonObjectKeys(raw) {
  let cursor = 0;
  const numberPattern =
    /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
  const whitespace = new Set([0x09, 0x0a, 0x0d, 0x20]);

  const skipWhitespace = () => {
    while (cursor < raw.length && whitespace.has(raw.charCodeAt(cursor))) {
      cursor += 1;
    }
  };

  const parseString = () => {
    if (raw[cursor] !== '"') strictJsonFailure();
    const start = cursor;
    cursor += 1;
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      if (code === 0x22) {
        cursor += 1;
        try {
          return JSON.parse(raw.slice(start, cursor));
        } catch {
          strictJsonFailure();
        }
      }
      if (code === 0x5c) {
        cursor += 1;
        if (cursor >= raw.length) strictJsonFailure();
        const escape = raw[cursor];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(raw.slice(cursor + 1, cursor + 5))) {
            strictJsonFailure();
          }
          cursor += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) strictJsonFailure();
        cursor += 1;
        continue;
      }
      if (code <= 0x1f) strictJsonFailure();
      cursor += 1;
    }
    strictJsonFailure();
  };

  const parseValue = (depth) => {
    if (depth > MAX_STRICT_JSON_DEPTH) strictJsonFailure();
    skipWhitespace();
    const token = raw[cursor];
    if (token === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (raw[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        const key = parseString();
        if (keys.has(key)) strictJsonFailure();
        keys.add(key);
        skipWhitespace();
        if (raw[cursor] !== ":") strictJsonFailure();
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ",") strictJsonFailure();
        cursor += 1;
        skipWhitespace();
      }
      strictJsonFailure();
    }
    if (token === "[") {
      cursor += 1;
      skipWhitespace();
      if (raw[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ",") strictJsonFailure();
        cursor += 1;
      }
      strictJsonFailure();
    }
    if (token === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (raw.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    numberPattern.lastIndex = cursor;
    const number = numberPattern.exec(raw);
    if (!number) strictJsonFailure();
    cursor = numberPattern.lastIndex;
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== raw.length) strictJsonFailure();
}

export function parseStrictSecretFreeJson(raw, field = "json") {
  const text = strictJsonText(raw);
  assertUniqueJsonObjectKeys(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    strictJsonFailure();
  }
  assertSecretFree(value, field);
  return value;
}

function assertBuildkitProvenanceSecretFree(value, field) {
  // BuildKit's reachable JSON provenance is part of the enforced scan scope.
  // Compressed/binary filesystem layer payloads are only digest-bound below;
  // this verifier deliberately makes no secret-complete payload-scan claim.
  assertSecretFree(value, field);
}

function validateTime(value, field) {
  const result = exactString(value, field);
  const millis = Date.parse(result);
  if (
    !Number.isFinite(millis) ||
    !result.endsWith("Z") ||
    new Date(millis).toISOString() !== result
  ) {
    fail(
      "PRODUCTION_IMAGE_TIME_INVALID",
      `${field} must be canonical UTC with millisecond precision.`,
    );
  }
  return result;
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
      "PRODUCTION_IMAGE_SOURCE_NOT_MERGED_MAIN",
      "receipt.source.mergeParentShas must prove one exact two-parent merge commit.",
    );
  }
  const parentShas = source.mergeParentShas.map((entry, index) =>
    exactSha(entry, `receipt.source.mergeParentShas[${index}]`),
  );
  if (parentShas[0] === parentShas[1] || parentShas.includes(sourceSha)) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_NOT_MERGED_MAIN",
      "The merge parents must be distinct from each other and the merge SHA.",
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
    QUALITY_WORKFLOW_PATH,
    "qualityGate.workflowPath",
  );
  requireEqual(gate.event, "push", "qualityGate.event");
  requireEqual(gate.headBranch, "main", "qualityGate.headBranch");
  requireEqual(
    exactSha(gate.headSha, "qualityGate.headSha"),
    sourceSha,
    "qualityGate.headSha",
  );
  exactPositiveInteger(gate.runId, "qualityGate.runId");
  requireEqual(
    exactPositiveInteger(gate.runAttempt, "qualityGate.runAttempt"),
    "1",
    "qualityGate.runAttempt",
  );
  requireEqual(gate.conclusion, "success", "qualityGate.conclusion");
  return sourceSha;
}

function validateCaller(value) {
  const caller = exactKeys(
    value,
    [
      "repository",
      "repositoryId",
      "workflowRef",
      "workflowSha",
      "eventName",
      "ref",
      "actor",
      "actorId",
      "triggeringActor",
      "runId",
      "runAttempt",
    ],
    "receipt.caller",
  );
  requireEqual(
    caller.repository,
    PRODUCTION_IMAGE_PUBLICATION_CALLER.repository,
    "receipt.caller.repository",
  );
  exactPositiveInteger(caller.repositoryId, "receipt.caller.repositoryId");
  requireEqual(
    caller.workflowRef,
    PRODUCTION_IMAGE_PUBLICATION_CALLER.workflowRef,
    "receipt.caller.workflowRef",
  );
  exactSha(caller.workflowSha, "receipt.caller.workflowSha");
  requireEqual(
    caller.eventName,
    "workflow_dispatch",
    "receipt.caller.eventName",
  );
  requireEqual(caller.ref, SOURCE_REF, "receipt.caller.ref");
  requireEqual(caller.actor, "modvolt", "receipt.caller.actor");
  requireEqual(caller.actorId, "289280891", "receipt.caller.actorId");
  requireEqual(
    caller.triggeringActor,
    "modvolt",
    "receipt.caller.triggeringActor",
  );
  const runId = exactPositiveInteger(caller.runId, "receipt.caller.runId");
  requireEqual(
    exactPositiveInteger(caller.runAttempt, "receipt.caller.runAttempt"),
    "1",
    "receipt.caller.runAttempt",
  );
  return runId;
}

function validatePublisher(value, sourceSha) {
  const publisher = exactKeys(
    value,
    [
      "repository",
      "workflowPath",
      "jobWorkflowRef",
      "sourceSha",
      "workflowFileSha256",
    ],
    "receipt.publisher",
  );
  requireEqual(
    publisher.repository,
    SOURCE_REPOSITORY,
    "receipt.publisher.repository",
  );
  requireEqual(
    publisher.workflowPath,
    PRODUCTION_IMAGE_PUBLICATION_WORKFLOW,
    "receipt.publisher.workflowPath",
  );
  requireEqual(
    publisher.jobWorkflowRef,
    `${SOURCE_REPOSITORY}/${PRODUCTION_IMAGE_PUBLICATION_WORKFLOW}@${sourceSha}`,
    "receipt.publisher.jobWorkflowRef",
  );
  requireEqual(
    exactSha(publisher.sourceSha, "receipt.publisher.sourceSha"),
    sourceSha,
    "receipt.publisher.sourceSha",
  );
  exactDigest(
    publisher.workflowFileSha256,
    "receipt.publisher.workflowFileSha256",
  );
}

function reviewedImageSetProjection(images) {
  return Object.fromEntries(
    Object.entries(images).map(([key, image]) => {
      const projection = structuredClone(image);
      delete projection.published;
      delete projection.registryVerified;
      delete projection.registryEvidenceSha256;
      return [key, projection];
    }),
  );
}

export function reviewedImageSetSha256(images) {
  return sha256(canonicalJson(reviewedImageSetProjection(images)));
}

function validateChain(value, stage, currentRunId, sourceSha, images) {
  const chain = exactKeys(
    value,
    [
      "preflightReceiptSha256",
      "preflightRunId",
      "preflightRunAttempt",
      "preflightArtifactId",
      "preflightArtifactDigest",
      "preflightArtifactCreatedAt",
      "preflightArtifactExpiresAt",
      "preflightCreatedAt",
      "publicationNonceSha256",
      "singleUseKeySha256",
      "reviewedImageSetSha256",
    ],
    "receipt.chain",
  );
  const publicationNonceSha256 = exactDigest(
    chain.publicationNonceSha256,
    "receipt.chain.publicationNonceSha256",
  );
  requireEqual(
    exactDigest(
      chain.reviewedImageSetSha256,
      "receipt.chain.reviewedImageSetSha256",
    ),
    reviewedImageSetSha256(images),
    "receipt.chain.reviewedImageSetSha256",
  );

  if (stage === "preflight-only") {
    if (
      chain.preflightReceiptSha256 !== null ||
      chain.preflightRunId !== null ||
      chain.preflightRunAttempt !== null ||
      chain.preflightArtifactId !== null ||
      chain.preflightArtifactDigest !== null ||
      chain.preflightArtifactCreatedAt !== null ||
      chain.preflightArtifactExpiresAt !== null ||
      chain.preflightCreatedAt !== null
    ) {
      fail(
        "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
        "preflight-only must not claim predecessor evidence.",
      );
    }
    requireEqual(
      exactDigest(chain.singleUseKeySha256, "receipt.chain.singleUseKeySha256"),
      sha256(
        canonicalJson({
          sourceSha,
          preflightRunId: currentRunId,
          publicationNonceSha256,
        }),
      ),
      "receipt.chain.singleUseKeySha256",
    );
    return;
  }

  exactDigest(
    chain.preflightReceiptSha256,
    "receipt.chain.preflightReceiptSha256",
  );
  const preflightRunId = exactPositiveInteger(
    chain.preflightRunId,
    "receipt.chain.preflightRunId",
  );
  requireEqual(
    exactPositiveInteger(
      chain.preflightRunAttempt,
      "receipt.chain.preflightRunAttempt",
    ),
    "1",
    "receipt.chain.preflightRunAttempt",
  );
  if (preflightRunId === currentRunId) {
    fail(
      "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
      "complete must bind a distinct preceding preflight-only run.",
    );
  }
  exactPositiveInteger(
    chain.preflightArtifactId,
    "receipt.chain.preflightArtifactId",
  );
  exactDigest(
    chain.preflightArtifactDigest,
    "receipt.chain.preflightArtifactDigest",
  );
  const artifactCreatedAt = validateTime(
    chain.preflightArtifactCreatedAt,
    "receipt.chain.preflightArtifactCreatedAt",
  );
  const artifactExpiresAt = validateTime(
    chain.preflightArtifactExpiresAt,
    "receipt.chain.preflightArtifactExpiresAt",
  );
  const preflightCreatedAt = validateTime(
    chain.preflightCreatedAt,
    "receipt.chain.preflightCreatedAt",
  );
  if (
    Date.parse(artifactExpiresAt) <= Date.parse(artifactCreatedAt) ||
    Math.abs(Date.parse(artifactCreatedAt) - Date.parse(preflightCreatedAt)) >
      15 * 60 * 1000
  ) {
    fail(
      "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
      "preflight artifact chronology is not one bounded snapshot.",
    );
  }
  requireEqual(
    exactDigest(chain.singleUseKeySha256, "receipt.chain.singleUseKeySha256"),
    sha256(
      canonicalJson({
        sourceSha,
        preflightRunId,
        publicationNonceSha256,
      }),
    ),
    "receipt.chain.singleUseKeySha256",
  );
}

function validatePolicy(value, stage) {
  const policy = exactKeys(
    value,
    [
      "registryWritePermitted",
      "packagesVisibility",
      "platform",
      "productionTargetsTouched",
      "deploymentAuthorized",
      "migrationAuthorized",
    ],
    "receipt.policy",
  );
  requireEqual(
    policy.registryWritePermitted,
    stage === "complete",
    "receipt.policy.registryWritePermitted",
  );
  requireEqual(
    policy.packagesVisibility,
    "private",
    "receipt.policy.packagesVisibility",
  );
  requireEqual(policy.platform, "linux/amd64", "receipt.policy.platform");
  requireEqual(
    policy.productionTargetsTouched,
    false,
    "receipt.policy.productionTargetsTouched",
  );
  requireEqual(
    policy.deploymentAuthorized,
    false,
    "receipt.policy.deploymentAuthorized",
  );
  requireEqual(
    policy.migrationAuthorized,
    false,
    "receipt.policy.migrationAuthorized",
  );
}

function validateFilesystemManifest(value, imageField) {
  const manifest = exactKeys(
    value,
    ["format", "configDigest", "layers", "entryCount", "sha256"],
    `${imageField}.filesystemManifest`,
  );
  requireEqual(
    manifest.format,
    "oci-layer-manifest/v1",
    `${imageField}.filesystemManifest.format`,
  );
  const configDigest = exactDigest(
    manifest.configDigest,
    `${imageField}.filesystemManifest.configDigest`,
  );
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    fail(
      "PRODUCTION_IMAGE_FILESYSTEM_MANIFEST_INVALID",
      `${imageField}.filesystemManifest.layers must be non-empty.`,
    );
  }
  const layers = manifest.layers.map((entry, index) => {
    const layer = exactKeys(
      entry,
      ["digest", "mediaType", "size"],
      `${imageField}.filesystemManifest.layers[${index}]`,
    );
    exactDigest(
      layer.digest,
      `${imageField}.filesystemManifest.layers[${index}].digest`,
    );
    const mediaType = exactString(
      layer.mediaType,
      `${imageField}.filesystemManifest.layers[${index}].mediaType`,
    );
    if (!/^application\/vnd\.(?:oci|docker)\./u.test(mediaType)) {
      fail(
        "PRODUCTION_IMAGE_FILESYSTEM_MANIFEST_INVALID",
        `${imageField} contains an unexpected layer media type.`,
      );
    }
    if (!Number.isSafeInteger(layer.size) || layer.size <= 0) {
      fail(
        "PRODUCTION_IMAGE_FILESYSTEM_MANIFEST_INVALID",
        `${imageField} contains an invalid layer size.`,
      );
    }
    return layer;
  });
  requireEqual(
    manifest.entryCount,
    layers.length,
    `${imageField}.filesystemManifest.entryCount`,
  );
  const projection = {
    format: manifest.format,
    configDigest,
    layers,
    entryCount: layers.length,
  };
  requireEqual(
    exactDigest(manifest.sha256, `${imageField}.filesystemManifest.sha256`),
    sha256(canonicalJson(projection)),
    `${imageField}.filesystemManifest.sha256`,
  );
  return configDigest;
}

function validateProvenance(value, imageField, spec, sourceSha) {
  const provenance = exactKeys(
    value,
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
    `${imageField}.provenance`,
  );
  requireEqual(
    provenance.mediaType,
    "application/vnd.in-toto+json",
    `${imageField}.provenance.mediaType`,
  );
  exactDigest(provenance.sha256, `${imageField}.provenance.sha256`);
  requireEqual(
    provenance.buildType,
    "https://mobyproject.org/buildkit@v1",
    `${imageField}.provenance.buildType`,
  );
  requireEqual(
    provenance.vcsSource,
    SOURCE_URL,
    `${imageField}.provenance.vcsSource`,
  );
  requireEqual(
    exactSha(provenance.vcsRevision, `${imageField}.provenance.vcsRevision`),
    sourceSha,
    `${imageField}.provenance.vcsRevision`,
  );
  for (const field of ["dockerfile", "target", "buildArg"]) {
    requireEqual(
      provenance[field],
      spec[field],
      `${imageField}.provenance.${field}`,
    );
  }
  requireEqual(
    exactSha(
      provenance.buildArgValue,
      `${imageField}.provenance.buildArgValue`,
    ),
    sourceSha,
    `${imageField}.provenance.buildArgValue`,
  );
}

function validateSbom(value, imageField) {
  const sbom = exactKeys(
    value,
    ["mediaType", "sha256", "spdxVersion", "packageCount", "relationshipCount"],
    `${imageField}.sbom`,
  );
  requireEqual(
    sbom.mediaType,
    "application/spdx+json",
    `${imageField}.sbom.mediaType`,
  );
  exactDigest(sbom.sha256, `${imageField}.sbom.sha256`);
  if (sbom.spdxVersion !== "SPDX-2.2" && sbom.spdxVersion !== "SPDX-2.3") {
    fail(
      "PRODUCTION_IMAGE_SBOM_INVALID",
      `${imageField}.sbom.spdxVersion is not approved.`,
    );
  }
  for (const field of ["packageCount", "relationshipCount"]) {
    if (!Number.isSafeInteger(sbom[field]) || sbom[field] <= 0) {
      fail(
        "PRODUCTION_IMAGE_SBOM_INVALID",
        `${imageField}.sbom.${field} must be positive.`,
      );
    }
  }
}

function validateImage(value, key, stage, sourceSha) {
  const imageField = `receipt.images.${key}`;
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
    imageField,
  );
  const spec = PRODUCTION_IMAGE_SPECS[key];
  requireEqual(image.component, spec.component, `${imageField}.component`);
  requireEqual(image.repository, spec.repository, `${imageField}.repository`);
  const digest = exactDigest(image.digest, `${imageField}.digest`);
  requireEqual(
    image.image,
    `${spec.repository}@${digest}`,
    `${imageField}.image`,
  );
  exactDigest(
    image.runnableManifestDigest,
    `${imageField}.runnableManifestDigest`,
  );
  const configDigest = exactDigest(
    image.configDigest,
    `${imageField}.configDigest`,
  );
  requireEqual(
    exactSha(image.sourceSha, `${imageField}.sourceSha`),
    sourceSha,
    `${imageField}.sourceSha`,
  );
  requireEqual(image.platform, "linux/amd64", `${imageField}.platform`);
  requireEqual(image.visibility, "private", `${imageField}.visibility`);
  requireEqual(
    image.published,
    stage === "complete",
    `${imageField}.published`,
  );
  requireEqual(
    image.registryVerified,
    stage === "complete",
    `${imageField}.registryVerified`,
  );
  if (stage === "preflight-only") {
    requireEqual(
      image.registryEvidenceSha256,
      null,
      `${imageField}.registryEvidenceSha256`,
    );
  } else {
    exactDigest(
      image.registryEvidenceSha256,
      `${imageField}.registryEvidenceSha256`,
    );
  }

  const ociArchive = exactKeys(
    image.ociArchive,
    ["sha256", "sizeBytes", "indexDigest"],
    `${imageField}.ociArchive`,
  );
  exactDigest(ociArchive.sha256, `${imageField}.ociArchive.sha256`);
  if (
    !Number.isSafeInteger(ociArchive.sizeBytes) ||
    ociArchive.sizeBytes <= 0 ||
    ociArchive.sizeBytes > MAX_OCI_ARCHIVE_BYTES
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_ARCHIVE_INVALID",
      `${imageField}.ociArchive.sizeBytes is outside the bounded archive policy.`,
    );
  }
  requireEqual(
    exactDigest(ociArchive.indexDigest, `${imageField}.ociArchive.indexDigest`),
    digest,
    `${imageField}.ociArchive.indexDigest`,
  );

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
    `${imageField}.build`,
  );
  for (const field of ["dockerfile", "target", "buildArg", "imageProfile"]) {
    requireEqual(build[field], spec[field], `${imageField}.build.${field}`);
  }
  requireEqual(
    build.mutatingEntrypointsPresent,
    spec.mutatingEntrypointsPresent,
    `${imageField}.build.mutatingEntrypointsPresent`,
  );
  requireEqual(
    exactSha(build.buildArgValue, `${imageField}.build.buildArgValue`),
    sourceSha,
    `${imageField}.build.buildArgValue`,
  );
  validateProvenance(image.provenance, imageField, spec, sourceSha);
  validateSbom(image.sbom, imageField);
  requireEqual(
    validateFilesystemManifest(image.filesystemManifest, imageField),
    configDigest,
    `${imageField}.configDigest`,
  );
}

export function validateProductionImagePublicationReceipt(value) {
  assertSecretFree(value);
  const receipt = exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "publicationStage",
      "source",
      "caller",
      "publisher",
      "chain",
      "policy",
      "images",
      "createdAt",
    ],
    "receipt",
  );
  requireEqual(
    receipt.schemaVersion,
    PRODUCTION_IMAGE_PUBLICATION_SCHEMA,
    "receipt.schemaVersion",
  );
  requireEqual(receipt.kind, PRODUCTION_IMAGE_PUBLICATION_KIND, "receipt.kind");
  if (
    receipt.publicationStage !== "preflight-only" &&
    receipt.publicationStage !== "complete"
  ) {
    fail(
      "PRODUCTION_IMAGE_STAGE_INVALID",
      "publicationStage must be preflight-only or complete.",
    );
  }
  const sourceSha = validateSource(receipt.source);
  const currentRunId = validateCaller(receipt.caller);
  validatePublisher(receipt.publisher, sourceSha);
  validatePolicy(receipt.policy, receipt.publicationStage);
  const images = exactKeys(
    receipt.images,
    Object.keys(PRODUCTION_IMAGE_SPECS),
    "receipt.images",
  );
  for (const key of Object.keys(PRODUCTION_IMAGE_SPECS)) {
    validateImage(images[key], key, receipt.publicationStage, sourceSha);
  }
  validateChain(
    receipt.chain,
    receipt.publicationStage,
    currentRunId,
    sourceSha,
    images,
  );
  validateTime(receipt.createdAt, "receipt.createdAt");
  return receipt;
}

export function sealProductionImagePublicationReceipt(value) {
  const receipt = validateProductionImagePublicationReceipt(
    structuredClone(value),
  );
  const canonical = canonicalJson(receipt);
  if (Buffer.byteLength(canonical) > MAX_CANONICAL_BYTES) {
    fail(
      "PRODUCTION_IMAGE_ARTIFACT_INVALID",
      "The canonical receipt exceeds its bounded size.",
    );
  }
  return Object.freeze({
    receipt: Object.freeze(receipt),
    canonical,
    sha256: sha256(canonical),
  });
}

export function parseProductionImagePublicationReceipt(
  raw,
  {
    expectedStage,
    expectedSourceSha,
    expectedRunId,
    expectedRunAttempt,
    expectedReceiptSha256,
    now,
    maxAgeMs,
  } = {},
) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_CANONICAL_BYTES) {
    fail(
      "PRODUCTION_IMAGE_ARTIFACT_INVALID",
      "The receipt must be bounded UTF-8 text.",
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_IMAGE_ARTIFACT_INVALID", "The receipt must be JSON.");
  }
  if (canonicalJson(value) !== raw) {
    fail(
      "PRODUCTION_IMAGE_ARTIFACT_INVALID",
      "The receipt must be canonical JSON with one trailing LF.",
    );
  }
  const sealed = sealProductionImagePublicationReceipt(value);
  if (expectedStage !== undefined) {
    requireEqual(
      sealed.receipt.publicationStage,
      expectedStage,
      "expectedStage",
    );
  }
  if (expectedSourceSha !== undefined) {
    requireEqual(
      sealed.receipt.source.sha,
      expectedSourceSha,
      "expectedSourceSha",
    );
  }
  if (expectedRunId !== undefined) {
    requireEqual(sealed.receipt.caller.runId, expectedRunId, "expectedRunId");
  }
  if (expectedRunAttempt !== undefined) {
    requireEqual(
      sealed.receipt.caller.runAttempt,
      expectedRunAttempt,
      "expectedRunAttempt",
    );
  }
  if (expectedReceiptSha256 !== undefined) {
    requireEqual(sealed.sha256, expectedReceiptSha256, "expectedReceiptSha256");
  }
  if (now !== undefined || maxAgeMs !== undefined) {
    const effectiveNow = now ?? Date.now();
    const effectiveMaxAge = maxAgeMs ?? MAX_PREFLIGHT_AGE_MS;
    if (
      !Number.isFinite(effectiveNow) ||
      !Number.isSafeInteger(effectiveMaxAge) ||
      effectiveMaxAge <= 0
    ) {
      fail(
        "PRODUCTION_IMAGE_FRESHNESS_INVALID",
        "Receipt freshness arguments are invalid.",
      );
    }
    const createdAt = Date.parse(sealed.receipt.createdAt);
    if (
      createdAt > effectiveNow + 5 * 60 * 1000 ||
      effectiveNow - createdAt > effectiveMaxAge
    ) {
      fail(
        "PRODUCTION_IMAGE_FRESHNESS_INVALID",
        "The publication receipt is future-dated or stale.",
      );
    }
  }
  return sealed;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", accept);
  });
  return `sha256:${hash.digest("hex")}`;
}

function jsonFile(path, field, maxBytes = 64 * 1024 * 1024) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
    fail("PRODUCTION_IMAGE_OCI_LAYOUT_INVALID", `${field} has invalid size.`);
  }
  try {
    return parseStrictSecretFreeJson(readFileSync(path), field);
  } catch (error) {
    if (
      error instanceof ProductionImagePublicationError &&
      error.code === "PRODUCTION_IMAGE_SECRET_MATERIAL"
    ) {
      throw error;
    }
    fail("PRODUCTION_IMAGE_OCI_LAYOUT_INVALID", `${field} must be JSON.`);
  }
}

function resolveInside(root, ...parts) {
  const candidate = resolve(root, ...parts);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      "OCI layout path escaped its reviewed root.",
    );
  }
  let cursor = root;
  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        "OCI layout must not contain symbolic links.",
      );
    }
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (
    actualRelative === ".." ||
    actualRelative.startsWith(`..\\`) ||
    actualRelative.startsWith("../") ||
    isAbsolute(actualRelative)
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      "OCI layout real path escaped its reviewed root.",
    );
  }
  return candidate;
}

function blobPath(root, digest, field) {
  const parsed = exactDigest(digest, field);
  return resolveInside(root, "blobs", "sha256", parsed.slice("sha256:".length));
}

function rawProvenance(value, image, spec, field) {
  const statement = objectAt(value, field);
  requireEqual(
    statement._type,
    "https://in-toto.io/Statement/v0.1",
    `${field}._type`,
  );
  requireEqual(
    statement.predicateType,
    "https://slsa.dev/provenance/v0.2",
    `${field}.predicateType`,
  );
  const predicate = objectAt(statement.predicate, `${field}.predicate`);
  requireEqual(
    predicate.buildType,
    "https://mobyproject.org/buildkit@v1",
    `${field}.predicate.buildType`,
  );
  const invocation = objectAt(
    predicate.invocation,
    `${field}.predicate.invocation`,
  );
  const parameters = objectAt(
    invocation.parameters,
    `${field}.predicate.invocation.parameters`,
  );
  const args = objectAt(
    parameters.args,
    `${field}.predicate.invocation.parameters.args`,
  );
  requireEqual(
    args[`build-arg:${spec.buildArg}`],
    image.sourceSha,
    `${field}.buildArg`,
  );
  requireEqual(args.target, spec.target, `${field}.target`);
  requireEqual(
    invocation.configSource?.entryPoint,
    "Dockerfile",
    `${field}.dockerfile.entryPoint`,
  );
  const requestArgs = parameters.root?.request?.args;
  objectAt(
    requestArgs,
    `${field}.predicate.invocation.parameters.root.request.args`,
  );
  requireEqual(
    requestArgs["vcs:localdir:dockerfile"],
    dirname(spec.dockerfile).replaceAll("\\", "/"),
    `${field}.dockerfile.directory`,
  );
  requireEqual(
    requestArgs["vcs:revision"],
    image.sourceSha,
    `${field}.vcsRevision`,
  );
  requireEqual(requestArgs["vcs:source"], SOURCE_URL, `${field}.vcsSource`);
  const vcs =
    predicate.metadata?.["https://mobyproject.org/buildkit@v1#metadata"]?.vcs;
  requireEqual(
    vcs?.revision,
    image.sourceSha,
    `${field}.metadata.vcs.revision`,
  );
  requireEqual(vcs?.source, SOURCE_URL, `${field}.metadata.vcs.source`);
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    fail(
      "PRODUCTION_IMAGE_PROVENANCE_INVALID",
      `${field} must contain exactly one reviewed runnable-manifest subject.`,
    );
  }
  const subject = exactKeys(
    statement.subject[0],
    ["name", "digest"],
    `${field}.subject[0]`,
  );
  const subjectDigest = exactKeys(
    subject.digest,
    ["sha256"],
    `${field}.subject[0].digest`,
  );
  requireEqual(
    subject.name,
    `pkg:docker/${spec.repository}@${image.sourceSha}?platform=linux%2Famd64`,
    `${field}.subject[0].name`,
  );
  const runnableHex = image.runnableManifestDigest.slice("sha256:".length);
  requireEqual(
    subjectDigest.sha256,
    runnableHex,
    `${field}.subject[0].digest.sha256`,
  );
}

function rawSbom(value, image, field) {
  requireEqual(
    value?._type,
    "https://in-toto.io/Statement/v0.1",
    `${field}._type`,
  );
  requireEqual(
    value?.predicateType,
    "https://spdx.dev/Document",
    `${field}.predicateType`,
  );
  const spdx = objectAt(value?.predicate, `${field}.predicate`);
  requireEqual(
    spdx.spdxVersion,
    image.sbom.spdxVersion,
    `${field}.spdxVersion`,
  );
  requireEqual(
    Array.isArray(spdx.packages) ? spdx.packages.length : -1,
    image.sbom.packageCount,
    `${field}.packageCount`,
  );
  requireEqual(
    Array.isArray(spdx.relationships) ? spdx.relationships.length : -1,
    image.sbom.relationshipCount,
    `${field}.relationshipCount`,
  );
}

export async function verifyReviewedOciLayout({
  layoutDirectory,
  archivePath,
  image,
  imageKey,
}) {
  const spec = PRODUCTION_IMAGE_SPECS[imageKey];
  if (!spec) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      "Unknown production image key.",
    );
  }
  requireEqual(image.repository, spec.repository, `${imageKey}.repository`);
  requireEqual(image.component, spec.component, `${imageKey}.component`);
  if (lstatSync(resolve(layoutDirectory)).isSymbolicLink()) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      "OCI layout root must not be a symlink.",
    );
  }
  const root = realpathSync(resolve(layoutDirectory));
  if (!statSync(root).isDirectory()) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      "OCI layout root is not a directory.",
    );
  }
  const archiveStats = lstatSync(archivePath);
  if (
    !archiveStats.isFile() ||
    archiveStats.size !== image.ociArchive.sizeBytes
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_ARCHIVE_INVALID",
      `${imageKey} archive size does not match the reviewed receipt.`,
    );
  }
  if (
    JSON.stringify(readdirSync(root).sort()) !==
      JSON.stringify(["blobs", "index.json", "oci-layout"]) ||
    JSON.stringify(readdirSync(resolveInside(root, "blobs")).sort()) !==
      JSON.stringify(["sha256"])
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} OCI layout contains unexpected top-level content.`,
    );
  }
  requireEqual(
    await sha256File(archivePath),
    image.ociArchive.sha256,
    `${imageKey}.ociArchive.sha256`,
  );
  const layout = jsonFile(
    resolveInside(root, "oci-layout"),
    `${imageKey}.oci-layout`,
  );
  if (
    JSON.stringify(layout) !== JSON.stringify({ imageLayoutVersion: "1.0.0" })
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} has an unexpected OCI layout marker.`,
    );
  }
  const layoutIndexPath = resolveInside(root, "index.json");
  const layoutIndex = jsonFile(layoutIndexPath, `${imageKey}.layoutIndex`);
  requireEqual(
    layoutIndex.schemaVersion,
    2,
    `${imageKey}.layoutIndex.schemaVersion`,
  );
  requireEqual(
    layoutIndex.mediaType,
    "application/vnd.oci.image.index.v1+json",
    `${imageKey}.layoutIndex.mediaType`,
  );
  if (
    !Array.isArray(layoutIndex.manifests) ||
    layoutIndex.manifests.length !== 1
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} layout must contain one root descriptor.`,
    );
  }
  const layoutRootDescriptor = layoutIndex.manifests[0];
  requireEqual(
    layoutRootDescriptor?.mediaType,
    "application/vnd.oci.image.index.v1+json",
    `${imageKey}.layoutRoot.mediaType`,
  );
  requireEqual(
    exactDigest(layoutRootDescriptor?.digest, `${imageKey}.layoutRoot.digest`),
    image.digest,
    `${imageKey}.layoutRoot.digest`,
  );
  if (
    !Number.isSafeInteger(layoutRootDescriptor?.size) ||
    layoutRootDescriptor.size <= 0
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} layout root descriptor size is invalid.`,
    );
  }
  requireEqual(
    exactString(
      layoutRootDescriptor?.annotations?.["io.containerd.image.name"],
      `${imageKey}.layoutRoot.imageName`,
    ),
    `${image.repository}:${image.sourceSha}`,
    `${imageKey}.layoutRoot.imageName`,
  );
  requireEqual(
    exactString(
      layoutRootDescriptor?.annotations?.["org.opencontainers.image.ref.name"],
      `${imageKey}.layoutRoot.refName`,
    ),
    image.sourceSha,
    `${imageKey}.layoutRoot.refName`,
  );
  let indexPath;
  try {
    indexPath = blobPath(
      root,
      layoutRootDescriptor.digest,
      `${imageKey}.layoutRoot.digest`,
    );
  } catch (error) {
    if (error instanceof ProductionImagePublicationError) throw error;
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} root image index blob is missing or invalid.`,
    );
  }
  requireEqual(
    await sha256File(indexPath),
    image.digest,
    `${imageKey}.indexDigest`,
  );
  requireEqual(
    statSync(indexPath).size,
    layoutRootDescriptor.size,
    `${imageKey}.layoutRoot.size`,
  );
  const index = jsonFile(indexPath, `${imageKey}.index`);
  requireEqual(index.schemaVersion, 2, `${imageKey}.index.schemaVersion`);
  requireEqual(
    index.mediaType,
    "application/vnd.oci.image.index.v1+json",
    `${imageKey}.index.mediaType`,
  );
  if (!Array.isArray(index.manifests) || index.manifests.length !== 2) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} index is incomplete.`,
    );
  }
  for (const [descriptorIndex, descriptor] of index.manifests.entries()) {
    requireEqual(
      descriptor?.mediaType,
      "application/vnd.oci.image.manifest.v1+json",
      `${imageKey}.index.manifests[${descriptorIndex}].mediaType`,
    );
    exactDigest(
      descriptor?.digest,
      `${imageKey}.index.manifests[${descriptorIndex}].digest`,
    );
    if (!Number.isSafeInteger(descriptor?.size) || descriptor.size <= 0) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} index manifest descriptor size is invalid.`,
      );
    }
  }
  const runnableDescriptors = index.manifests.filter(
    (descriptor) =>
      descriptor?.platform?.os === "linux" &&
      descriptor?.platform?.architecture === "amd64" &&
      descriptor?.annotations?.["vnd.docker.reference.type"] !==
        "attestation-manifest",
  );
  const attestationDescriptors = index.manifests.filter(
    (descriptor) =>
      descriptor?.annotations?.["vnd.docker.reference.type"] ===
      "attestation-manifest",
  );
  if (runnableDescriptors.length !== 1 || attestationDescriptors.length !== 1) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} must have one runnable and one attestation manifest.`,
    );
  }
  const runnableDescriptor = runnableDescriptors[0];
  const attestationDescriptor = attestationDescriptors[0];
  requireEqual(
    canonicalJson(runnableDescriptor.platform),
    canonicalJson({ architecture: "amd64", os: "linux" }),
    `${imageKey}.runnableDescriptor.platform`,
  );
  requireEqual(
    canonicalJson(attestationDescriptor.platform),
    canonicalJson({ architecture: "unknown", os: "unknown" }),
    `${imageKey}.attestationDescriptor.platform`,
  );
  requireEqual(
    runnableDescriptor.digest,
    image.runnableManifestDigest,
    `${imageKey}.runnableManifestDigest`,
  );
  requireEqual(
    attestationDescriptor.annotations?.["vnd.docker.reference.digest"],
    image.runnableManifestDigest,
    `${imageKey}.attestationSubject`,
  );
  const runnablePath = blobPath(
    root,
    runnableDescriptor.digest,
    `${imageKey}.runnableDescriptor.digest`,
  );
  const attestationPath = blobPath(
    root,
    attestationDescriptor.digest,
    `${imageKey}.attestationDescriptor.digest`,
  );
  requireEqual(
    await sha256File(runnablePath),
    runnableDescriptor.digest,
    `${imageKey}.runnableBlob`,
  );
  requireEqual(
    await sha256File(attestationPath),
    attestationDescriptor.digest,
    `${imageKey}.attestationBlob`,
  );
  requireEqual(
    statSync(runnablePath).size,
    runnableDescriptor.size,
    `${imageKey}.runnableDescriptor.size`,
  );
  requireEqual(
    statSync(attestationPath).size,
    attestationDescriptor.size,
    `${imageKey}.attestationDescriptor.size`,
  );
  requireEqual(
    attestationDescriptor.platform?.os,
    "unknown",
    `${imageKey}.attestationDescriptor.platform.os`,
  );
  requireEqual(
    attestationDescriptor.platform?.architecture,
    "unknown",
    `${imageKey}.attestationDescriptor.platform.architecture`,
  );
  const runnable = jsonFile(runnablePath, `${imageKey}.runnableManifest`);
  requireEqual(
    runnable.schemaVersion,
    2,
    `${imageKey}.runnableManifest.schemaVersion`,
  );
  requireEqual(
    runnable.mediaType,
    "application/vnd.oci.image.manifest.v1+json",
    `${imageKey}.runnableManifest.mediaType`,
  );
  requireEqual(
    runnable.config?.digest,
    image.configDigest,
    `${imageKey}.configDigest`,
  );
  const layers = Array.isArray(runnable.layers)
    ? runnable.layers.map(({ digest, mediaType, size }) => ({
        digest,
        mediaType,
        size,
      }))
    : [];
  requireEqual(
    canonicalJson(layers),
    canonicalJson(image.filesystemManifest.layers),
    `${imageKey}.filesystemLayers`,
  );
  const configPath = blobPath(
    root,
    image.configDigest,
    `${imageKey}.configDigest`,
  );
  requireEqual(
    await sha256File(configPath),
    image.configDigest,
    `${imageKey}.configBlob`,
  );
  requireEqual(
    statSync(configPath).size,
    runnable.config?.size,
    `${imageKey}.configDescriptor.size`,
  );
  for (const [layerIndex, layer] of (runnable.layers ?? []).entries()) {
    const path = blobPath(
      root,
      layer.digest,
      `${imageKey}.layers[${layerIndex}].digest`,
    );
    requireEqual(
      await sha256File(path),
      layer.digest,
      `${imageKey}.layers[${layerIndex}]`,
    );
    requireEqual(
      statSync(path).size,
      layer.size,
      `${imageKey}.layers[${layerIndex}].size`,
    );
  }
  const config = jsonFile(configPath, `${imageKey}.config`);
  requireEqual(
    config.config?.Labels?.["org.opencontainers.image.source"],
    SOURCE_URL,
    `${imageKey}.config.sourceLabel`,
  );
  requireEqual(
    config.config?.Labels?.["org.opencontainers.image.revision"],
    image.sourceSha,
    `${imageKey}.config.revisionLabel`,
  );
  requireEqual(
    config.config?.Labels?.["org.opencontainers.image.url"],
    `${SOURCE_URL}/commit/${image.sourceSha}`,
    `${imageKey}.config.commitUrlLabel`,
  );
  const configEnvironment = config.config?.Env;
  if (!Array.isArray(configEnvironment)) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} config does not contain an OCI environment array.`,
    );
  }
  const buildEnvironment = spec.configBuildEnvironment;
  const buildEnvironmentName = buildEnvironment ?? spec.buildArg;
  const buildEnvironmentEntries = configEnvironment.filter(
    (entry) =>
      typeof entry === "string" && entry.startsWith(`${buildEnvironmentName}=`),
  );
  if (buildEnvironment === null) {
    if (buildEnvironmentEntries.length !== 0) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} config exposes a mutable runtime source SHA.`,
      );
    }
  } else if (
    buildEnvironmentEntries.length !== 1 ||
    buildEnvironmentEntries[0] !== `${buildEnvironment}=${image.sourceSha}`
  ) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} config does not contain exactly one baked source SHA.`,
    );
  }

  const attestation = jsonFile(
    attestationPath,
    `${imageKey}.attestationManifest`,
  );
  requireEqual(
    attestation.schemaVersion,
    2,
    `${imageKey}.attestation.schemaVersion`,
  );
  requireEqual(
    attestation.mediaType,
    "application/vnd.oci.image.manifest.v1+json",
    `${imageKey}.attestation.mediaType`,
  );
  if (!Array.isArray(attestation.layers) || attestation.layers.length !== 2) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} attestation manifest must contain exactly two reviewed layers.`,
    );
  }
  for (const [layerIndex, descriptor] of attestation.layers.entries()) {
    requireEqual(
      descriptor?.mediaType,
      "application/vnd.in-toto+json",
      `${imageKey}.attestation.layers[${layerIndex}].mediaType`,
    );
    exactDigest(
      descriptor?.digest,
      `${imageKey}.attestation.layers[${layerIndex}].digest`,
    );
    if (!Number.isSafeInteger(descriptor?.size) || descriptor.size <= 0) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} attestation layer descriptor size is invalid.`,
      );
    }
    const predicateType = exactString(
      descriptor?.annotations?.["in-toto.io/predicate-type"],
      `${imageKey}.attestation.layers[${layerIndex}].predicateType`,
    );
    if (
      predicateType !== "https://slsa.dev/provenance/v0.2" &&
      predicateType !== "https://spdx.dev/Document"
    ) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} attestation layer predicate type is not reviewed.`,
      );
    }
  }
  const provenanceLayers = (attestation.layers ?? []).filter(
    (descriptor) =>
      descriptor?.annotations?.["in-toto.io/predicate-type"] ===
      "https://slsa.dev/provenance/v0.2",
  );
  const sbomLayers = (attestation.layers ?? []).filter(
    (descriptor) =>
      descriptor?.annotations?.["in-toto.io/predicate-type"] ===
      "https://spdx.dev/Document",
  );
  if (provenanceLayers.length !== 1 || sbomLayers.length !== 1) {
    fail(
      "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
      `${imageKey} attestation predicates are incomplete or ambiguous.`,
    );
  }
  requireEqual(
    provenanceLayers[0].digest,
    image.provenance.sha256,
    `${imageKey}.provenance.sha256`,
  );
  requireEqual(
    sbomLayers[0].digest,
    image.sbom.sha256,
    `${imageKey}.sbom.sha256`,
  );
  const provenancePath = blobPath(
    root,
    image.provenance.sha256,
    `${imageKey}.provenance.sha256`,
  );
  const sbomPath = blobPath(root, image.sbom.sha256, `${imageKey}.sbom.sha256`);
  requireEqual(
    await sha256File(provenancePath),
    image.provenance.sha256,
    `${imageKey}.provenanceBlob`,
  );
  requireEqual(
    await sha256File(sbomPath),
    image.sbom.sha256,
    `${imageKey}.sbomBlob`,
  );
  requireEqual(
    statSync(provenancePath).size,
    provenanceLayers[0].size,
    `${imageKey}.provenanceDescriptor.size`,
  );
  requireEqual(
    statSync(sbomPath).size,
    sbomLayers[0].size,
    `${imageKey}.sbomDescriptor.size`,
  );
  const attestationConfigPath = blobPath(
    root,
    attestation.config?.digest,
    `${imageKey}.attestationConfig.digest`,
  );
  requireEqual(
    attestation.config?.mediaType,
    "application/vnd.oci.image.config.v1+json",
    `${imageKey}.attestationConfig.mediaType`,
  );
  requireEqual(
    await sha256File(attestationConfigPath),
    attestation.config.digest,
    `${imageKey}.attestationConfig`,
  );
  requireEqual(
    statSync(attestationConfigPath).size,
    attestation.config?.size,
    `${imageKey}.attestationConfig.size`,
  );
  const rawProvenanceValue = jsonFile(provenancePath, `${imageKey}.provenance`);
  const rawSbomValue = jsonFile(sbomPath, `${imageKey}.sbom`);
  const attestationConfigValue = jsonFile(
    attestationConfigPath,
    `${imageKey}.attestationConfig`,
  );
  assertSecretFree(index, `${imageKey}.index`);
  assertSecretFree(runnable, `${imageKey}.runnableManifest`);
  assertSecretFree(config, `${imageKey}.config`);
  assertSecretFree(attestation, `${imageKey}.attestationManifest`);
  assertSecretFree(attestationConfigValue, `${imageKey}.attestationConfig`);
  assertBuildkitProvenanceSecretFree(
    rawProvenanceValue,
    `${imageKey}.provenance`,
  );
  assertSecretFree(rawSbomValue, `${imageKey}.sbom`);
  rawProvenance(rawProvenanceValue, image, spec, `${imageKey}.provenance`);
  rawSbom(rawSbomValue, image, `${imageKey}.sbom`);

  const blobDirectory = resolveInside(root, "blobs", "sha256");
  const reachableDigests = new Set([
    layoutRootDescriptor.digest,
    runnableDescriptor.digest,
    attestationDescriptor.digest,
    runnable.config.digest,
    ...(runnable.layers ?? []).map((layer) => layer.digest),
    attestation.config.digest,
    ...(attestation.layers ?? []).map((layer) => layer.digest),
  ]);
  const blobFiles = [];
  for (const name of readdirSync(blobDirectory).sort()) {
    if (!/^[0-9a-f]{64}$/u.test(name)) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} contains a non-digest blob name.`,
      );
    }
    const path = resolveInside(blobDirectory, name);
    if (!statSync(path).isFile()) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} contains a non-file blob.`,
      );
    }
    requireEqual(
      await sha256File(path),
      `sha256:${name}`,
      `${imageKey}.blob.${name}`,
    );
    if (!reachableDigests.has(`sha256:${name}`)) {
      fail(
        "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
        `${imageKey} contains an unreferenced blob.`,
      );
    }
    blobFiles.push({ digest: `sha256:${name}`, path });
  }
  requireEqual(
    blobFiles.length,
    reachableDigests.size,
    `${imageKey}.reachableBlobCount`,
  );
  return Object.freeze({
    root,
    layoutIndexPath,
    layoutIndex,
    layoutRootDescriptor,
    indexPath,
    index,
    runnableDescriptor,
    attestationDescriptor,
    manifestDescriptors: [runnableDescriptor, attestationDescriptor],
    blobFiles,
  });
}

export function classifyExactLookupStatus(status, field = "lookup") {
  if (status === 200) return "present";
  if (status === 404) return "absent";
  fail(
    "PRODUCTION_IMAGE_LOOKUP_FAILED",
    `${field} returned HTTP ${status}; only exact 200 or 404 are meaningful.`,
  );
}

async function registryBearer(
  fetchImpl,
  repositoryPath,
  actor,
  publicationToken,
) {
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", `repository:${repositoryPath}:pull,push`);
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${actor}:${publicationToken}`).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_NETWORK_FAILED",
      "GHCR bearer-token request failed before publication.",
    );
  }
  if (response.status !== 200) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_AUTH_FAILED",
      `GHCR bearer-token request returned HTTP ${response.status}.`,
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_AUTH_FAILED",
      "GHCR bearer-token response was not exact JSON.",
    );
  }
  const bearer = value?.token ?? value?.access_token;
  if (typeof bearer !== "string" || bearer.length < 20) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_AUTH_FAILED",
      "GHCR did not return a usable scoped bearer token.",
    );
  }
  return bearer;
}

function registryUrl(repositoryPath, suffix) {
  const url = new URL(`https://ghcr.io/v2/${repositoryPath}/${suffix}`);
  if (url.protocol !== "https:" || url.hostname !== "ghcr.io") {
    fail("PRODUCTION_IMAGE_REGISTRY_INVALID", "Unexpected registry origin.");
  }
  return url;
}

async function registryFetch(fetchImpl, bearer, url, options = {}) {
  try {
    return await fetchImpl(url, {
      ...options,
      headers: {
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json",
        Authorization: `Bearer ${bearer}`,
        ...(options.headers ?? {}),
      },
      redirect: options.redirect ?? "error",
      signal: options.signal ?? AbortSignal.timeout(60_000),
    });
  } catch {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_NETWORK_FAILED",
      "GHCR request failed; publication state is unknown and must not be retried blindly.",
    );
  }
}

async function credentialFreeRegistryUpload(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(300_000),
    });
  } catch {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_NETWORK_FAILED",
      "Credential-free registry blob upload failed; publication state is unknown and must not be retried blindly.",
    );
  }
}

function exactManifestReference(reference, field) {
  if (!DIGEST.test(reference)) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_INVALID",
      `${field} must be an exact sha256 digest reference.`,
    );
  }
  return reference;
}

async function uploadBlob(fetchImpl, bearer, repositoryPath, blob) {
  const start = await registryFetch(
    fetchImpl,
    bearer,
    registryUrl(repositoryPath, "blobs/uploads/"),
    { method: "POST" },
  );
  if (start.status !== 202) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_WRITE_FAILED",
      `GHCR blob upload start returned HTTP ${start.status}.`,
    );
  }
  const location = start.headers.get("location");
  if (!location) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_WRITE_FAILED",
      "GHCR blob upload did not return a location.",
    );
  }
  const uploadUrl = new URL(location, "https://ghcr.io");
  if (
    uploadUrl.protocol !== "https:" ||
    uploadUrl.username !== "" ||
    uploadUrl.password !== "" ||
    (uploadUrl.port !== "" && uploadUrl.port !== "443") ||
    (uploadUrl.hostname === "ghcr.io" &&
      !uploadUrl.pathname.startsWith(`/v2/${repositoryPath}/blobs/uploads/`))
  ) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_WRITE_FAILED",
      "GHCR blob upload location is unsafe.",
    );
  }
  uploadUrl.searchParams.set("digest", blob.digest);
  const uploadOptions = {
    method: "PUT",
    headers: {
      "Content-Length": String(statSync(blob.path).size),
      "Content-Type": "application/octet-stream",
    },
    body: createReadStream(blob.path),
    duplex: "half",
    signal: AbortSignal.timeout(300_000),
  };
  const upload =
    uploadUrl.hostname === "ghcr.io"
      ? await registryFetch(fetchImpl, bearer, uploadUrl, uploadOptions)
      : await credentialFreeRegistryUpload(fetchImpl, uploadUrl, uploadOptions);
  if (upload.status !== 201) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_WRITE_FAILED",
      `GHCR blob upload returned HTTP ${upload.status}.`,
    );
  }
}

async function putManifest(
  fetchImpl,
  bearer,
  repositoryPath,
  reference,
  path,
  mediaType,
) {
  const exactReference = exactManifestReference(
    reference,
    "manifest.reference",
  );
  const bytes = readFileSync(path);
  const response = await registryFetch(
    fetchImpl,
    bearer,
    registryUrl(repositoryPath, `manifests/${exactReference}`),
    {
      method: "PUT",
      headers: {
        "Content-Length": String(bytes.length),
        "Content-Type": mediaType,
      },
      body: bytes,
    },
  );
  if (response.status !== 201) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_WRITE_FAILED",
      `GHCR manifest write returned HTTP ${response.status}.`,
    );
  }
  return response;
}

async function verifyRegistryReference(
  fetchImpl,
  bearer,
  repositoryPath,
  reference,
  expectedDigest,
) {
  const exactReference = exactManifestReference(
    reference,
    "manifest.reference",
  );
  const response = await registryFetch(
    fetchImpl,
    bearer,
    registryUrl(repositoryPath, `manifests/${exactReference}`),
  );
  if (response.status !== 200) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_VERIFY_FAILED",
      `GHCR reference verification returned HTTP ${response.status}.`,
    );
  }
  requireEqual(
    response.headers.get("docker-content-digest"),
    expectedDigest,
    `registry.${reference}.digestHeader`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  requireEqual(
    sha256(bytes),
    expectedDigest,
    `registry.${reference}.manifestBytes`,
  );
}

async function exactManifestState(
  fetchImpl,
  bearer,
  repositoryPath,
  reference,
  expectedDigest,
  field,
) {
  const exactReference = exactManifestReference(
    reference,
    `${field}.reference`,
  );
  const response = await registryFetch(
    fetchImpl,
    bearer,
    registryUrl(repositoryPath, `manifests/${exactReference}`),
  );
  const state = classifyExactLookupStatus(response.status, field);
  if (state === "present") {
    requireEqual(
      response.headers.get("docker-content-digest"),
      expectedDigest,
      `${field}.digestHeader`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    requireEqual(sha256(bytes), expectedDigest, `${field}.manifestBytes`);
  }
  return state;
}

async function verifyRegistryBlob(
  fetchImpl,
  bearer,
  repositoryPath,
  blob,
  field,
) {
  let response = await registryFetch(
    fetchImpl,
    bearer,
    registryUrl(repositoryPath, `blobs/${blob.digest}`),
    {
      headers: { "Accept-Encoding": "identity" },
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    },
  );
  for (
    let redirectCount = 0;
    response.status >= 300 && response.status < 400;
    redirectCount += 1
  ) {
    if (redirectCount >= 3) {
      fail(
        "PRODUCTION_IMAGE_REGISTRY_VERIFY_FAILED",
        `${field} exceeded the bounded HTTPS redirect count.`,
      );
    }
    const location = response.headers.get("location");
    if (!location) {
      fail(
        "PRODUCTION_IMAGE_REGISTRY_VERIFY_FAILED",
        `${field} redirect omitted its location.`,
      );
    }
    const redirected = new URL(location, "https://ghcr.io");
    if (
      redirected.protocol !== "https:" ||
      redirected.username !== "" ||
      redirected.password !== ""
    ) {
      fail(
        "PRODUCTION_IMAGE_REGISTRY_VERIFY_FAILED",
        `${field} redirected outside credential-free HTTPS.`,
      );
    }
    try {
      response = await fetchImpl(redirected, {
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      fail(
        "PRODUCTION_IMAGE_REGISTRY_NETWORK_FAILED",
        `${field} redirected blob verification failed.`,
      );
    }
  }
  if (response.status !== 200 || !response.body) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_VERIFY_FAILED",
      `${field} returned HTTP ${response.status}.`,
    );
  }
  const headerDigest = response.headers.get("docker-content-digest");
  if (headerDigest !== null) {
    requireEqual(headerDigest, blob.digest, `${field}.digestHeader`);
  }
  const expectedSize = statSync(blob.path).size;
  const hash = createHash("sha256");
  let actualSize = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    actualSize += bytes.length;
    hash.update(bytes);
  }
  requireEqual(actualSize, expectedSize, `${field}.size`);
  requireEqual(`sha256:${hash.digest("hex")}`, blob.digest, `${field}.bytes`);
}

async function verifyRegistryGraph(
  fetchImpl,
  bearer,
  repositoryPath,
  graph,
  image,
  imageKey,
) {
  await verifyRegistryReference(
    fetchImpl,
    bearer,
    repositoryPath,
    image.digest,
    image.digest,
  );
  for (const descriptor of graph.manifestDescriptors) {
    await verifyRegistryReference(
      fetchImpl,
      bearer,
      repositoryPath,
      descriptor.digest,
      descriptor.digest,
    );
  }
  for (const blob of graph.blobFiles) {
    await verifyRegistryBlob(
      fetchImpl,
      bearer,
      repositoryPath,
      blob,
      `${imageKey}.blob.${blob.digest}`,
    );
  }
}

async function publicGitHubJson(fetchImpl, url, field) {
  const expected = new URL(url);
  if (
    expected.protocol !== "https:" ||
    expected.hostname !== "api.github.com" ||
    expected.port !== ""
  ) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      `${field} has an unexpected public API origin.`,
    );
  }
  let response;
  try {
    response = await fetchImpl(expected, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "site-logbook-production-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      `${field} failed at the transport layer.`,
    );
  }
  if (response.status !== 200 || !response.body) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      `${field} returned HTTP ${response.status}.`,
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SOURCE_RECHECK_BYTES) {
      fail(
        "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
        `${field} exceeded its bounded response size.`,
      );
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      `${field} did not return JSON.`,
    );
  }
}

export async function recheckExactProductionSource({
  receipt,
  fetchImpl = fetch,
}) {
  const source = objectAt(receipt?.source, "sourceRecheck.receipt.source");
  requireEqual(
    source.repository,
    SOURCE_REPOSITORY,
    "sourceRecheck.repository",
  );
  requireEqual(source.ref, SOURCE_REF, "sourceRecheck.ref");
  const sourceSha = exactSha(source.sha, "sourceRecheck.sourceSha");
  const qualityGate = objectAt(
    source.qualityGate,
    "sourceRecheck.receipt.source.qualityGate",
  );
  const qualityRunId = exactPositiveInteger(
    qualityGate.runId,
    "sourceRecheck.qualityRunId",
  );

  const qualityRun = await publicGitHubJson(
    fetchImpl,
    `https://api.github.com/repos/modvolt/Site-Logbook/actions/runs/${qualityRunId}`,
    "exact Quality gate recheck",
  );
  if (
    String(qualityRun?.id) !== qualityRunId ||
    qualityRun?.name !== "Quality gate" ||
    qualityRun?.path !== QUALITY_WORKFLOW_PATH ||
    qualityRun?.event !== "push" ||
    qualityRun?.head_branch !== "main" ||
    qualityRun?.head_sha !== sourceSha ||
    qualityRun?.run_attempt !== 1 ||
    qualityRun?.status !== "completed" ||
    qualityRun?.conclusion !== "success" ||
    qualityRun?.repository?.full_name !== SOURCE_REPOSITORY ||
    qualityRun?.head_repository?.full_name !== SOURCE_REPOSITORY
  ) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      "The reviewed exact-SHA first-attempt push Quality gate is no longer exact and green.",
    );
  }

  const mainRef = await publicGitHubJson(
    fetchImpl,
    "https://api.github.com/repos/modvolt/Site-Logbook/git/ref/heads/main",
    "final current public main recheck",
  );
  if (mainRef?.object?.type !== "commit" || mainRef.object.sha !== sourceSha) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      "Current public main no longer equals the reviewed source SHA.",
    );
  }
  return true;
}

function validateRegistryPublicationAuth(actor, publicationToken) {
  if (
    actor !== "modvolt" ||
    typeof publicationToken !== "string" ||
    publicationToken.length < 20 ||
    publicationToken.length > 4096
  ) {
    fail(
      "PRODUCTION_IMAGE_REGISTRY_AUTH_FAILED",
      "Exact registry actor and in-memory publication token are required.",
    );
  }
}

async function prepareReviewedOciPublication({
  layoutDirectory,
  archivePath,
  image,
  imageKey,
  actor,
  publicationToken,
  resultPath,
  fetchImpl,
}) {
  const graph = await verifyReviewedOciLayout({
    layoutDirectory,
    archivePath,
    image,
    imageKey,
  });
  const repositoryPath = image.repository.slice("ghcr.io/".length);
  const bearer = await registryBearer(
    fetchImpl,
    repositoryPath,
    actor,
    publicationToken,
  );
  const digestState = await exactManifestState(
    fetchImpl,
    bearer,
    repositoryPath,
    image.digest,
    image.digest,
    `${imageKey} pre-write digest lookup`,
  );
  if (digestState === "present") {
    await verifyRegistryGraph(
      fetchImpl,
      bearer,
      repositoryPath,
      graph,
      image,
      imageKey,
    );
  }
  return Object.freeze({
    graph,
    repositoryPath,
    bearer,
    digestState,
    image,
    imageKey,
    resultPath,
    fetchImpl,
  });
}

async function writePreparedOciPublication(prepared) {
  for (const blob of prepared.graph.blobFiles) {
    await uploadBlob(
      prepared.fetchImpl,
      prepared.bearer,
      prepared.repositoryPath,
      blob,
    );
  }
  for (const descriptor of prepared.graph.manifestDescriptors) {
    const path = blobPath(
      prepared.graph.root,
      descriptor.digest,
      `${prepared.imageKey}.manifestDescriptor.digest`,
    );
    await putManifest(
      prepared.fetchImpl,
      prepared.bearer,
      prepared.repositoryPath,
      descriptor.digest,
      path,
      descriptor.mediaType,
    );
  }
  await putManifest(
    prepared.fetchImpl,
    prepared.bearer,
    prepared.repositoryPath,
    prepared.image.digest,
    prepared.graph.indexPath,
    prepared.graph.index.mediaType,
  );
}

async function requireSourceRecheck(sourceRecheck, context) {
  if (typeof sourceRecheck !== "function") {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      "A source-pinned recheck callback is required before registry publication.",
    );
  }
  let accepted;
  try {
    accepted = await sourceRecheck(Object.freeze(context));
  } catch (error) {
    if (error instanceof ProductionImagePublicationError) throw error;
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      "The source-pinned recheck callback failed closed.",
    );
  }
  if (accepted !== true) {
    fail(
      "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
      "The source-pinned recheck callback did not return exact success.",
    );
  }
}

function registryPublicationResult(prepared, publishedAt) {
  const result = {
    schemaVersion: "site-logbook.production-image-registry-publication/v1",
    sourceSha: prepared.image.sourceSha,
    component: prepared.image.component,
    repository: prepared.image.repository,
    digest: prepared.image.digest,
    immutableImage: prepared.image.image,
    referenceMode: "digest-only",
    preWriteDigestState: prepared.digestState,
    digestAlreadyPresent: prepared.digestState === "present",
    registryWritePerformed: prepared.digestState === "absent",
    sourceRecheckPerformed: true,
    digestReferenceVerified: true,
    runnableManifestVerified: true,
    attestationManifestVerified: true,
    allReviewedBlobsVerified: true,
    publishedAt,
  };
  assertSecretFree(result, "registryPublicationResult");
  const canonical = canonicalJson(result);
  return Object.freeze({ result, canonical, sha256: sha256(canonical) });
}

export async function publishReviewedOciLayout({
  layoutDirectory,
  archivePath,
  image,
  imageKey,
  actor,
  publicationToken,
  resultPath,
  fetchImpl = fetch,
  now = () => new Date(),
  sourceRecheck,
}) {
  validateRegistryPublicationAuth(actor, publicationToken);
  const prepared = await prepareReviewedOciPublication({
    layoutDirectory,
    archivePath,
    image,
    imageKey,
    actor,
    publicationToken,
    resultPath,
    fetchImpl,
  });
  await requireSourceRecheck(sourceRecheck, {
    sourceSha: image.sourceSha,
    imageKeys: [imageKey],
  });
  if (prepared.digestState === "absent") {
    await writePreparedOciPublication(prepared);
  }
  await verifyRegistryGraph(
    fetchImpl,
    prepared.bearer,
    prepared.repositoryPath,
    prepared.graph,
    image,
    imageKey,
  );
  const publishedAt = validateTime(
    now().toISOString(),
    "registryPublicationResult.publishedAt",
  );
  const result = registryPublicationResult(prepared, publishedAt);
  writeExclusive(resultPath, result.canonical);
  return result;
}

export async function publishReviewedOciSet({
  receipt,
  publications,
  actor,
  publicationToken,
  fetchImpl = fetch,
  sourceFetchImpl = fetch,
  sourceRecheck,
  now = () => new Date(),
}) {
  validateRegistryPublicationAuth(actor, publicationToken);
  const sealed = sealProductionImagePublicationReceipt(receipt);
  requireEqual(
    sealed.receipt.publicationStage,
    "preflight-only",
    "publicationSet.receipt.publicationStage",
  );
  const exactPublications = exactKeys(
    publications,
    Object.keys(PRODUCTION_IMAGE_SPECS),
    "publicationSet.publications",
  );
  const resultPaths = new Set();
  const prepared = [];
  for (const imageKey of Object.keys(PRODUCTION_IMAGE_SPECS)) {
    const publication = exactKeys(
      exactPublications[imageKey],
      ["layoutDirectory", "archivePath", "resultPath"],
      `publicationSet.publications.${imageKey}`,
    );
    for (const field of ["layoutDirectory", "archivePath", "resultPath"]) {
      exactString(publication[field], `publicationSet.${imageKey}.${field}`);
    }
    if (resultPaths.has(resolve(publication.resultPath))) {
      fail(
        "PRODUCTION_IMAGE_OUTPUT_INVALID",
        "Registry publication result paths must be distinct.",
      );
    }
    resultPaths.add(resolve(publication.resultPath));
    prepared.push(
      await prepareReviewedOciPublication({
        ...publication,
        image: sealed.receipt.images[imageKey],
        imageKey,
        actor,
        publicationToken,
        fetchImpl,
      }),
    );
  }

  const exactRecheck =
    sourceRecheck ??
    (() =>
      recheckExactProductionSource({
        receipt: sealed.receipt,
        fetchImpl: sourceFetchImpl,
      }));
  await requireSourceRecheck(exactRecheck, {
    receipt: sealed.receipt,
    sourceSha: sealed.receipt.source.sha,
    qualityRunId: sealed.receipt.source.qualityGate.runId,
    imageKeys: Object.freeze(Object.keys(PRODUCTION_IMAGE_SPECS)),
  });

  for (const publication of prepared) {
    if (publication.digestState === "absent") {
      await writePreparedOciPublication(publication);
    }
  }
  for (const publication of prepared) {
    await verifyRegistryGraph(
      publication.fetchImpl,
      publication.bearer,
      publication.repositoryPath,
      publication.graph,
      publication.image,
      publication.imageKey,
    );
  }

  const publishedAt = validateTime(
    now().toISOString(),
    "registryPublicationResult.publishedAt",
  );
  const results = Object.fromEntries(
    prepared.map((publication) => [
      publication.imageKey,
      registryPublicationResult(publication, publishedAt),
    ]),
  );
  for (const publication of prepared) {
    writeExclusive(
      publication.resultPath,
      results[publication.imageKey].canonical,
    );
  }
  return Object.freeze(results);
}

function argumentValue(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) fail("PRODUCTION_IMAGE_CLI_INVALID", `${name} is required.`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail("PRODUCTION_IMAGE_CLI_INVALID", `${name} requires a value.`);
  }
  return value;
}

function writeExclusive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, bytes, { encoding: "utf8" });
  } catch (error) {
    fail(
      "PRODUCTION_IMAGE_OUTPUT_INVALID",
      `Refusing to overwrite or create output ${path}: ${error.message}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "seal") {
    const inputPath = argumentValue(args, "--input");
    const receiptPath = argumentValue(args, "--receipt");
    const checksumPath = argumentValue(args, "--checksum");
    let value;
    try {
      value = JSON.parse(readFileSync(inputPath, "utf8"));
    } catch (error) {
      fail(
        "PRODUCTION_IMAGE_INPUT_INVALID",
        `Could not read receipt input: ${error.message}`,
      );
    }
    const sealed = sealProductionImagePublicationReceipt(value);
    writeExclusive(receiptPath, sealed.canonical);
    writeExclusive(checksumPath, `${sealed.sha256}\n`);
    process.stdout.write(`${sealed.sha256}\n`);
    return;
  }
  if (command === "verify") {
    const receiptPath = argumentValue(args, "--receipt");
    const expectedStage = argumentValue(args, "--expected-stage", {
      required: false,
    });
    const expectedSourceSha = argumentValue(args, "--expected-source-sha", {
      required: false,
    });
    const expectedRunId = argumentValue(args, "--expected-run-id", {
      required: false,
    });
    const expectedRunAttempt = argumentValue(args, "--expected-run-attempt", {
      required: false,
    });
    const expectedReceiptSha256 = argumentValue(
      args,
      "--expected-receipt-sha256",
      { required: false },
    );
    const maxAgeMinutes = argumentValue(args, "--max-age-minutes", {
      required: false,
    });
    if (
      maxAgeMinutes !== undefined &&
      (!POSITIVE_INTEGER.test(maxAgeMinutes) || Number(maxAgeMinutes) > 1440)
    ) {
      fail(
        "PRODUCTION_IMAGE_CLI_INVALID",
        "--max-age-minutes must be an integer from 1 through 1440.",
      );
    }
    const sealed = parseProductionImagePublicationReceipt(
      readFileSync(receiptPath, "utf8"),
      {
        expectedStage,
        expectedSourceSha,
        expectedRunId,
        expectedRunAttempt,
        expectedReceiptSha256,
        ...(maxAgeMinutes === undefined
          ? {}
          : { now: Date.now(), maxAgeMs: Number(maxAgeMinutes) * 60 * 1000 }),
      },
    );
    process.stdout.write(`${sealed.sha256}\n`);
    return;
  }
  if (command === "verify-oci") {
    const receiptPath = argumentValue(args, "--receipt");
    const imageKey = argumentValue(args, "--image-key");
    const layoutDirectory = argumentValue(args, "--layout");
    const archivePath = argumentValue(args, "--archive");
    const sealed = parseProductionImagePublicationReceipt(
      readFileSync(receiptPath, "utf8"),
      { expectedStage: "preflight-only" },
    );
    const image = sealed.receipt.images[imageKey];
    if (!image) {
      fail("PRODUCTION_IMAGE_CLI_INVALID", "--image-key is not reviewed.");
    }
    await verifyReviewedOciLayout({
      layoutDirectory,
      archivePath,
      image,
      imageKey,
    });
    process.stdout.write(`${image.digest}\n`);
    return;
  }
  if (command === "publish-oci-set") {
    const receiptPath = argumentValue(args, "--receipt");
    const sealed = parseProductionImagePublicationReceipt(
      readFileSync(receiptPath, "utf8"),
      { expectedStage: "preflight-only" },
    );
    const publications = {
      api: {
        layoutDirectory: argumentValue(args, "--api-layout"),
        archivePath: argumentValue(args, "--api-archive"),
        resultPath: argumentValue(args, "--api-result"),
      },
      controlPlane: {
        layoutDirectory: argumentValue(args, "--control-plane-layout"),
        archivePath: argumentValue(args, "--control-plane-archive"),
        resultPath: argumentValue(args, "--control-plane-result"),
      },
      hostOperator: {
        layoutDirectory: argumentValue(args, "--host-operator-layout"),
        archivePath: argumentValue(args, "--host-operator-archive"),
        resultPath: argumentValue(args, "--host-operator-result"),
      },
      web: {
        layoutDirectory: argumentValue(args, "--web-layout"),
        archivePath: argumentValue(args, "--web-archive"),
        resultPath: argumentValue(args, "--web-result"),
      },
    };
    const actor = process.env.GHCR_PUBLICATION_ACTOR;
    const publicationToken = process.env.GHCR_PUBLICATION_TOKEN;
    delete process.env.GHCR_PUBLICATION_TOKEN;
    const results = await publishReviewedOciSet({
      receipt: sealed.receipt,
      publications,
      actor,
      publicationToken,
    });
    process.stdout.write(
      `${canonicalJson(
        Object.fromEntries(
          Object.entries(results).map(([key, result]) => [key, result.sha256]),
        ),
      )}`,
    );
    return;
  }
  fail(
    "PRODUCTION_IMAGE_CLI_INVALID",
    "Usage: seal | verify | verify-oci | publish-oci-set with the documented exact file arguments.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
