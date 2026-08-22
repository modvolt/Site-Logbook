import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  constants as fsConstants,
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyProductionApiImageProvenanceArtifact } from "./host-attestation-contract.mjs";

export const PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION =
  "PUBLISH_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_BUNDLE_V2";
export const PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES = 1024 * 1024;
export const PRODUCTION_ACTIVATION_EVIDENCE_MAX_BYTES = 960 * 1024;
export const PRODUCTION_ACTIVATION_PUBLIC_KEY_MAX_BYTES = 16 * 1024;
export const PRODUCTION_ACTIVATION_LIFETIME_MS = 5 * 60 * 1000;
export const PRODUCTION_ACTIVATION_MAX_AGE_MS = 10 * 60 * 1000;

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const CUSTODY_SCRIPT = path.join(
  SCRIPT_DIRECTORY,
  "production-signing-custody.mjs",
);
const OUTPUT_BASENAME = "activation-bundle-v2.json";
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_PIN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
const NONCE = /^[0-9a-f]{64}$/;
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const VOLUME_DESTINATION = /^\/[a-z0-9._/-]{1,255}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._@/-]{2,127}$/;
const FORBIDDEN_KEY =
  /(?:password|secret|private.?key|access.?key|session|cookie|token|authorization|database.?url|mnemonic|passphrase)/i;
const PUBLIC_IDENTITY_OR_POLICY_KEYS = new Set([
  "adminSessionUser",
  "sessionUser",
  "requiresExplicitCoolifySecretTransfer",
]);
const APPROVAL_KEYS = [
  "schemaVersion",
  "kind",
  "decision",
  "confirmation",
  "sourceSha",
  "apiImage",
  "nonce",
  "containerId",
  "desiredConfigSha256",
  "deployedConfigSha256",
  "resolvedComposeSha256",
  "databaseName",
  "databaseUser",
  "schemaFingerprintSha256",
  "composeProject",
  "postgresService",
  "postgresVolumeDestination",
  "expectedNetworkServices",
  "migrationTransitionSha256",
  "finalLiveIdentitySha256",
  "credentialRequestSha256",
  "credentialReceiptSha256",
  "coolifyObservationSha256",
  "dockerObservationSha256",
  "postgresObservationSha256",
  "approvedAt",
  "operator",
  "authorizesApplicationStart",
  "authorizesDeployment",
];

export class ProductionActivationBundleError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionActivationBundleError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ProductionActivationBundleError(code, message, { cause });
}

function usage() {
  return [
    "Usage:",
    `  pnpm production:activation-bundle -- publish --challenge ABSOLUTE_FILE --evidence ABSOLUTE_FILE --publisher-public-key ABSOLUTE_FILE --host-public-key ABSOLUTE_FILE --vault ABSOLUTE_DIRECTORY --output ABSOLUTE_FILE --confirm ${PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION}`,
    "",
    `The output basename must be ${OUTPUT_BASENAME} and must not already exist.`,
    "The command invokes the current-user attended DPAPI custody signer twice; private key material is never accepted through argv, environment, stdin, or stdout.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "publish" || rest.length % 2 !== 0) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_ARGUMENTS_INVALID",
      "command is invalid.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_ARGUMENTS_INVALID",
        "options must be exact --name value pairs.",
      );
    }
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_ARGUMENTS_INVALID",
        "duplicate option is forbidden.",
      );
    }
    options[name] = value;
  }
  return options;
}

function exactOptions(options) {
  const expected = [
    "challenge",
    "confirm",
    "evidence",
    "host-public-key",
    "output",
    "publisher-public-key",
    "vault",
  ].sort();
  const actual = Object.keys(options).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_ARGUMENTS_INVALID",
      "publish requires only the reviewed option set.",
    );
  }
}

function absolutePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !path.isAbsolute(value)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PATH_INVALID",
      `${field} must be an absolute path.`,
    );
  }
  return path.resolve(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys, field) {
  if (!isRecord(value)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return value;
}

function exactString(value, field, pattern) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value !== value.trim() ||
    (pattern && !pattern.test(value))
  ) {
    fail("PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactDetachedSignatureBase64(value, field) {
  const encoded = exactString(value, field, /^[A-Za-z0-9+/]{86}==$/);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
      `${field} must be one canonical padded-base64 Ed25519 signature.`,
    );
  }
  return encoded;
}

function exactCanonicalArtifact(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 16 * 1024
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
      `${field} must be one bounded canonical artifact.`,
    );
  }
  return value;
}

function exactEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_BINDING_INVALID",
      `${field} differs from the exact reviewed binding.`,
    );
  }
}

function canonicalValue(value, field = "value") {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
        `${field} contains a non-safe-integer number.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalValue(entry, `${field}[${index}]`),
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key], `${field}.${key}`)]),
    );
  }
  fail(
    "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
    `${field} contains a non-JSON value.`,
  );
}

export function canonicalProductionActivationBundleJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

export async function readStableActivationInput(file, maximumBytes) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_INPUT_UNSAFE",
      "input must be one regular, non-symlink, single-link file.",
    );
  }
  if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_INPUT_SIZE_INVALID",
      "input is outside the reviewed byte boundary.",
    );
  }
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_INPUT_CHANGED",
        "input changed while it was opened.",
      );
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        maximumBytes + 1 - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(file, { bigint: true });
    if (
      offset > maximumBytes ||
      !sameIdentity(opened, afterRead) ||
      !sameIdentity(afterRead, afterPath) ||
      BigInt(offset) !== afterRead.size
    ) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_INPUT_CHANGED",
        "input was not stable for the complete bounded read.",
      );
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseCanonicalJson(bytes, field) {
  if (bytes.includes(0x0d)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
      `${field} must use canonical LF bytes.`,
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
      `${field} must be valid UTF-8.`,
      error,
    );
  }
  if (!text.endsWith("\n") || text.endsWith("\n\n")) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
      `${field} must end in exactly one LF.`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
      `${field} must be valid JSON.`,
      error,
    );
  }
  if (canonicalProductionActivationBundleJson(value) !== text) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CANONICAL_INVALID",
      `${field} is not canonical sorted-key JSON.`,
    );
  }
  return value;
}

function scanSecretFree(value, field = "input") {
  if (typeof value === "string") {
    if (
      /-----BEGIN [^-]*PRIVATE KEY-----/i.test(value) ||
      /(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s/@:]+:[^\s/@]+@/i.test(
        value,
      ) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
      /\bSCRAM-SHA-256\$/.test(value) ||
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value) ||
      /\bgithub_pat_[A-Za-z0-9_]{16,}\b/.test(value) ||
      /\bgh[pousr]_[A-Za-z0-9]{16,}\b/.test(value)
    ) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_PRIVATE_MATERIAL",
        `${field} contains forbidden private material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && !PUBLIC_IDENTITY_OR_POLICY_KEYS.has(key)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_PRIVATE_MATERIAL",
        `${field}.${key} is a forbidden private-material field.`,
      );
    }
    scanSecretFree(entry, `${field}.${key}`);
  }
}

function parseArtifact(value, field) {
  const artifact = exactObject(value, ["kind", "payload", "sha256"], field);
  exactString(artifact.kind, `${field}.kind`, ARTIFACT_KIND);
  exactString(artifact.sha256, `${field}.sha256`, SHA256);
  exactEqual(
    artifact.sha256,
    sha256Hex(canonicalProductionActivationBundleJson(artifact.payload)),
    `${field}.sha256`,
  );
  return artifact;
}

function parseTimestamp(value, field) {
  const text = exactString(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  return { text, millis };
}

function parseChallenge(value) {
  const challenge = exactObject(
    value,
    ["apiImage", "containerId", "kind", "nonce", "sourceSha"],
    "challenge",
  );
  exactEqual(
    challenge.kind,
    "site-logbook-production-activation-challenge-v2",
    "challenge.kind",
  );
  exactString(challenge.sourceSha, "challenge.sourceSha", SOURCE_SHA);
  exactString(challenge.apiImage, "challenge.apiImage", IMAGE);
  exactString(challenge.containerId, "challenge.containerId", CONTAINER_ID);
  exactString(challenge.nonce, "challenge.nonce", NONCE);
  return challenge;
}

function parseEvidence(value, challenge, now, verifyApiImageProvenance) {
  scanSecretFree(value, "evidence");
  const evidence = exactObject(
    value,
    [
      "activationApproval",
      "apiImageProvenance",
      "exact0096Backup",
      "finalObservations",
      "migration0096To0107",
      "runtimeDatabaseCredentialCutover",
    ],
    "evidence",
  );
  const apiImageProvenance = exactObject(
    evidence.apiImageProvenance,
    ["canonical", "signatureB64"],
    "evidence.apiImageProvenance",
  );
  const provenanceCanonical = exactCanonicalArtifact(
    apiImageProvenance.canonical,
    "evidence.apiImageProvenance.canonical",
  );
  const provenanceSignatureB64 = exactDetachedSignatureBase64(
    apiImageProvenance.signatureB64,
    "evidence.apiImageProvenance.signatureB64",
  );
  let provenanceVerdict;
  try {
    provenanceVerdict = verifyApiImageProvenance({
      canonical: provenanceCanonical,
      signature: provenanceSignatureB64,
      sourceSha: challenge.sourceSha,
      expectedApiImage: challenge.apiImage,
    });
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PROVENANCE_INVALID",
      "API image provenance is not the exact source-pinned signed v2 artifact.",
      error,
    );
  }
  exactEqual(
    provenanceVerdict.sourceSha,
    challenge.sourceSha,
    "apiImageProvenance.sourceSha",
  );
  exactEqual(
    provenanceVerdict.subjectImage,
    challenge.apiImage,
    "apiImageProvenance.subjectImage",
  );
  for (const field of [
    "publicationReceiptSha256",
    "reviewedImageSetSha256",
    "subjectRunnableManifestDigest",
    "ociProvenanceSha256",
  ]) {
    exactString(
      provenanceVerdict[field],
      `apiImageProvenance.${field}`,
      SHA256_PIN,
    );
  }
  const backup = exactObject(
    evidence.exact0096Backup,
    ["detachedSignature", "passReceipt", "plan", "signature", "trace"],
    "evidence.exact0096Backup",
  );
  for (const key of [
    "plan",
    "trace",
    "passReceipt",
    "signature",
    "detachedSignature",
  ]) {
    parseArtifact(backup[key], `evidence.exact0096Backup.${key}`);
  }

  const migration = exactObject(
    evidence.migration0096To0107,
    [
      "finalLive",
      "intent",
      "persistence",
      "plan",
      "postcommit",
      "receipts",
      "role",
      "transitionPass",
    ],
    "evidence.migration0096To0107",
  );
  for (const key of [
    "plan",
    "intent",
    "persistence",
    "finalLive",
    "role",
    "postcommit",
    "transitionPass",
  ]) {
    parseArtifact(migration[key], `evidence.migration0096To0107.${key}`);
  }
  if (!Array.isArray(migration.receipts) || migration.receipts.length !== 10) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
      "migration receipts must contain exactly ten artifacts.",
    );
  }
  migration.receipts.forEach((entry, index) =>
    parseArtifact(entry, `evidence.migration0096To0107.receipts[${index}]`),
  );

  const credential = exactObject(
    evidence.runtimeDatabaseCredentialCutover,
    ["passReceipt", "request"],
    "evidence.runtimeDatabaseCredentialCutover",
  );
  parseArtifact(
    credential.request,
    "evidence.runtimeDatabaseCredentialCutover.request",
  );
  parseArtifact(
    credential.passReceipt,
    "evidence.runtimeDatabaseCredentialCutover.passReceipt",
  );

  const observations = exactObject(
    evidence.finalObservations,
    ["coolify", "docker", "postgres"],
    "evidence.finalObservations",
  );
  const observationTimes = [];
  for (const key of ["coolify", "docker", "postgres"]) {
    const artifact = parseArtifact(
      observations[key],
      `evidence.finalObservations.${key}`,
    );
    if (!isRecord(artifact.payload)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_SCHEMA_INVALID",
        `evidence.finalObservations.${key}.payload must be an object.`,
      );
    }
    observationTimes.push(
      parseTimestamp(
        artifact.payload.observedAt,
        `evidence.finalObservations.${key}.payload.observedAt`,
      ).millis,
    );
  }

  const approvalArtifact = parseArtifact(
    evidence.activationApproval,
    "evidence.activationApproval",
  );
  const approval = exactObject(
    approvalArtifact.payload,
    APPROVAL_KEYS,
    "evidence.activationApproval.payload",
  );
  exactEqual(
    approval.schemaVersion,
    "site-logbook.production-activation-approval/v2",
    "approval.schemaVersion",
  );
  exactEqual(
    approval.kind,
    "site-logbook-production-activation-approval-v2",
    "approval.kind",
  );
  exactEqual(approval.decision, "APPROVE", "approval.decision");
  exactEqual(
    approval.confirmation,
    "AUTHORIZE_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_V2",
    "approval.confirmation",
  );
  exactEqual(
    approval.authorizesApplicationStart,
    true,
    "approval.authorizesApplicationStart",
  );
  exactEqual(
    approval.authorizesDeployment,
    false,
    "approval.authorizesDeployment",
  );
  for (const key of ["sourceSha", "apiImage", "nonce", "containerId"]) {
    exactEqual(approval[key], challenge[key], `approval.${key}`);
  }
  for (const key of [
    "desiredConfigSha256",
    "deployedConfigSha256",
    "resolvedComposeSha256",
  ]) {
    exactString(approval[key], `approval.${key}`, SHA256);
  }
  exactEqual(
    approval.desiredConfigSha256,
    approval.deployedConfigSha256,
    "approval.desiredConfigSha256",
  );
  exactString(approval.databaseName, "approval.databaseName", IDENTIFIER);
  exactEqual(
    approval.databaseUser,
    "site_logbook_runtime",
    "approval.databaseUser",
  );
  exactString(
    approval.schemaFingerprintSha256,
    "approval.schemaFingerprintSha256",
    /^sha256:[0-9a-f]{64}$/,
  );
  exactString(approval.composeProject, "approval.composeProject", COMPOSE_NAME);
  exactEqual(approval.postgresService, "postgres", "approval.postgresService");
  exactString(
    approval.postgresVolumeDestination,
    "approval.postgresVolumeDestination",
    VOLUME_DESTINATION,
  );
  if (
    JSON.stringify(approval.expectedNetworkServices) !==
    JSON.stringify(["api", "postgres", "web"])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_BINDING_INVALID",
      "approval.expectedNetworkServices is not the exact production set.",
    );
  }
  for (const key of [
    "migrationTransitionSha256",
    "finalLiveIdentitySha256",
    "credentialRequestSha256",
    "credentialReceiptSha256",
    "coolifyObservationSha256",
    "dockerObservationSha256",
    "postgresObservationSha256",
  ]) {
    exactString(approval[key], `approval.${key}`, /^sha256:[0-9a-f]{64}$/);
  }
  exactString(approval.operator, "approval.operator", OPERATOR);
  const approvedAt = parseTimestamp(approval.approvedAt, "approval.approvedAt");
  const observedAt = Math.max(...observationTimes);
  if (
    observedAt > approvedAt.millis ||
    approvedAt.millis > now ||
    now - observedAt > PRODUCTION_ACTIVATION_MAX_AGE_MS ||
    now - approvedAt.millis > PRODUCTION_ACTIVATION_MAX_AGE_MS
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_TIME_INVALID",
      "observations and approval are stale, future-dated, or misordered.",
    );
  }
  return {
    evidence,
    observedAt,
    observedConfiguration: {
      desiredConfigSha256: approval.desiredConfigSha256,
      deployedConfigSha256: approval.deployedConfigSha256,
      resolvedComposeSha256: approval.resolvedComposeSha256,
    },
  };
}

async function parsePublicKey(file, field) {
  const bytes = await readStableActivationInput(
    file,
    PRODUCTION_ACTIVATION_PUBLIC_KEY_MAX_BYTES,
  );
  const text = bytes.toString("utf8");
  if (
    bytes.includes(0x0d) ||
    !text.endsWith("\n") ||
    text.endsWith("\n\n") ||
    /PRIVATE KEY/i.test(text)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PUBLIC_KEY_INVALID",
      `${field} must be canonical LF public PEM bytes.`,
    );
  }
  let key;
  try {
    key = createPublicKey(bytes);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PUBLIC_KEY_INVALID",
      `${field} cannot be parsed.`,
      error,
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PUBLIC_KEY_INVALID",
      `${field} must be Ed25519.`,
    );
  }
  const canonicalPem = Buffer.from(
    key.export({ type: "spki", format: "pem" }).toString(),
    "utf8",
  );
  if (!bytes.equals(canonicalPem)) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PUBLIC_KEY_INVALID",
      `${field} must use the exact canonical SPKI PEM encoding.`,
    );
  }
  const spkiDer = key.export({ type: "spki", format: "der" });
  return {
    bytes,
    key,
    spkiDer,
    sha256: `sha256:${sha256Hex(spkiDer)}`,
  };
}

async function writeExclusiveSynced(file, bytes) {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOutputAvailable(output) {
  if (path.basename(output) !== OUTPUT_BASENAME) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_INVALID",
      `output basename must be ${OUTPUT_BASENAME}.`,
    );
  }
  const parentState = await lstat(path.dirname(output));
  if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_INVALID",
      "output parent must be an existing non-symlink directory.",
    );
  }
  let state;
  try {
    state = await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (state) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_EXISTS",
      "output already exists and will not be replaced.",
    );
  }
}

async function publishAtomicNoClobber(output, bytes) {
  const directory = path.dirname(output);
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_INVALID",
      "output parent must be an existing non-symlink directory.",
    );
  }
  const temporary = path.join(
    directory,
    `.${OUTPUT_BASENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let linked = false;
  try {
    await writeExclusiveSynced(temporary, bytes);
    try {
      await link(temporary, output);
      linked = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(
          "PRODUCTION_ACTIVATION_BUNDLE_OUTPUT_EXISTS",
          "output appeared concurrently and will not be replaced.",
        );
      }
      throw error;
    }
    await unlink(temporary);
    const readback = await readStableActivationInput(
      output,
      PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES,
    );
    if (!readback.equals(bytes)) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_PERSISTENCE_INVALID",
        "published bundle differs from the exact signed bytes.",
      );
    }
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, fsConstants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    if (!linked) await rm(temporary, { force: true });
  }
}

function boundedChildOutput(stream, child, onOverflow) {
  const chunks = [];
  let total = 0;
  stream.on("data", (chunk) => {
    total += chunk.length;
    if (total > 16 * 1024) {
      onOverflow();
      child.kill();
      return;
    }
    chunks.push(chunk);
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

export async function runAttendedCustodySignature({
  vault,
  purpose,
  input,
  output,
}) {
  if (purpose !== "publisher-provenance" && purpose !== "host-attestation") {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CUSTODY_INVALID",
      "custody purpose is invalid.",
    );
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CUSTODY_SCRIPT,
        "sign",
        "--vault",
        vault,
        "--purpose",
        purpose,
        "--input",
        input,
        "--output",
        output,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let overflow = false;
    const stdout = boundedChildOutput(child.stdout, child, () => {
      overflow = true;
    });
    const stderr = boundedChildOutput(child.stderr, child, () => {
      overflow = true;
    });
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new ProductionActivationBundleError(
          "PRODUCTION_ACTIVATION_BUNDLE_CUSTODY_FAILED",
          "attended custody signer could not start.",
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const safeStdout = stdout();
      stderr();
      if (
        overflow ||
        code !== 0 ||
        !safeStdout.includes("signed=true") ||
        !safeStdout.includes(`purpose=${purpose}`) ||
        !safeStdout.includes("privateMaterialPrinted=false")
      ) {
        reject(
          new ProductionActivationBundleError(
            "PRODUCTION_ACTIVATION_BUNDLE_CUSTODY_FAILED",
            "attended custody signer failed without exposing its output.",
          ),
        );
        return;
      }
      resolve();
    });
  });
  return readStableActivationInput(output, 128);
}

async function verifyWithRuntimeContracts({
  bundleBytes,
  challenge,
  publisherPublicKeyFile,
  publisherPublicKeySha256,
  hostPublicKeyFile,
  hostPublicKeySha256,
  now,
}) {
  const [{ validateProductionActivationBundleTransport }, contract] =
    await Promise.all([
      import("../../artifacts/api-server/src/lib/production-activation-hold.ts"),
      import("../../artifacts/api-server/src/lib/production-activation-contract.ts"),
    ]);
  const parsed = await validateProductionActivationBundleTransport(
    bundleBytes,
    {
      sourceSha: challenge.sourceSha,
      apiImage: challenge.apiImage,
      containerId: challenge.containerId,
      nonce: challenge.nonce,
    },
    publisherPublicKeyFile,
    publisherPublicKeySha256,
    hostPublicKeyFile,
    hostPublicKeySha256,
    now,
  );
  await contract.verifyProductionActivationContractV2(parsed);
}

export async function publishProductionActivationBundle(
  rawOptions,
  dependencies = {},
) {
  const options = { ...rawOptions };
  exactOptions(options);
  if (options.confirm !== PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_CONFIRMATION_REQUIRED",
      "the exact attended publication confirmation is required.",
    );
  }
  const challengeFile = absolutePath(options.challenge, "challenge");
  const evidenceFile = absolutePath(options.evidence, "evidence");
  const publisherPublicKeyFile = absolutePath(
    options["publisher-public-key"],
    "publisher-public-key",
  );
  const hostPublicKeyFile = absolutePath(
    options["host-public-key"],
    "host-public-key",
  );
  const vault = absolutePath(options.vault, "vault");
  const output = absolutePath(options.output, "output");
  await assertOutputAvailable(output);

  const now = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_TIME_INVALID",
      "current time is invalid.",
    );
  }
  const challenge = parseChallenge(
    parseCanonicalJson(
      await readStableActivationInput(challengeFile, 16 * 1024),
      "challenge",
    ),
  );
  const verifyApiImageProvenance =
    dependencies.verifyApiImageProvenance ??
    ((input) => verifyProductionApiImageProvenanceArtifact(input));
  const { evidence, observedAt, observedConfiguration } = parseEvidence(
    parseCanonicalJson(
      await readStableActivationInput(
        evidenceFile,
        PRODUCTION_ACTIVATION_EVIDENCE_MAX_BYTES,
      ),
      "evidence",
    ),
    challenge,
    now,
    verifyApiImageProvenance,
  );
  const [publisherKey, hostKey] = await Promise.all([
    parsePublicKey(publisherPublicKeyFile, "publisher-public-key"),
    parsePublicKey(hostPublicKeyFile, "host-public-key"),
  ]);
  if (
    publisherKey.sha256 === hostKey.sha256 ||
    publisherKey.spkiDer.equals(hostKey.spkiDer)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_BUNDLE_PUBLIC_KEY_INVALID",
      "publisher and host custody keys must be distinct.",
    );
  }

  const hostAttestation = {
    schemaVersion: 2,
    kind: "site-logbook-production-host-attestation-v2",
    sourceSha: challenge.sourceSha,
    apiImage: challenge.apiImage,
    desiredConfigSha256: observedConfiguration.desiredConfigSha256,
    deployedConfigSha256: observedConfiguration.deployedConfigSha256,
    resolvedComposeSha256: observedConfiguration.resolvedComposeSha256,
    containerId: challenge.containerId,
    nonce: challenge.nonce,
    activationEvidenceSha256: sha256Hex(
      canonicalProductionActivationBundleJson(evidence),
    ),
    observedAt: new Date(observedAt).toISOString(),
  };
  const activation = {
    schemaVersion: 2,
    kind: "site-logbook-production-activation-bundle-v2",
    sourceSha: challenge.sourceSha,
    apiImage: challenge.apiImage,
    desiredConfigSha256: observedConfiguration.desiredConfigSha256,
    deployedConfigSha256: observedConfiguration.deployedConfigSha256,
    resolvedComposeSha256: observedConfiguration.resolvedComposeSha256,
    containerId: challenge.containerId,
    nonce: challenge.nonce,
    evidence,
    hostAttestationSha256: sha256Hex(
      canonicalProductionActivationBundleJson(hostAttestation),
    ),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PRODUCTION_ACTIVATION_LIFETIME_MS).toISOString(),
  };
  const activationCanonical =
    canonicalProductionActivationBundleJson(activation);
  const hostCanonical =
    canonicalProductionActivationBundleJson(hostAttestation);
  scanSecretFree(activation, "activation");
  scanSecretFree(hostAttestation, "hostAttestation");

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "site-logbook-activation-v2-"),
  );
  if (process.platform !== "win32") await chmod(temporaryDirectory, 0o700);
  const signWithCustody =
    dependencies.signWithCustody ?? runAttendedCustodySignature;
  let publisherSignature;
  let hostSignature;
  try {
    const activationInput = path.join(temporaryDirectory, "activation.json");
    const hostInput = path.join(temporaryDirectory, "host-attestation.json");
    const activationSignatureFile = path.join(
      temporaryDirectory,
      "activation.signature",
    );
    const hostSignatureFile = path.join(
      temporaryDirectory,
      "host-attestation.signature",
    );
    await Promise.all([
      writeExclusiveSynced(activationInput, activationCanonical),
      writeExclusiveSynced(hostInput, hostCanonical),
    ]);
    publisherSignature = await signWithCustody({
      vault,
      purpose: "publisher-provenance",
      input: activationInput,
      output: activationSignatureFile,
    });
    hostSignature = await signWithCustody({
      vault,
      purpose: "host-attestation",
      input: hostInput,
      output: hostSignatureFile,
    });
    if (
      !Buffer.isBuffer(publisherSignature) ||
      publisherSignature.length !== 64 ||
      !verify(
        null,
        Buffer.from(activationCanonical),
        publisherKey.key,
        publisherSignature,
      )
    ) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_SIGNATURE_INVALID",
        "publisher custody signature is invalid.",
      );
    }
    if (
      !Buffer.isBuffer(hostSignature) ||
      hostSignature.length !== 64 ||
      !verify(null, Buffer.from(hostCanonical), hostKey.key, hostSignature)
    ) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_SIGNATURE_INVALID",
        "host custody signature is invalid.",
      );
    }
    const bundle = {
      activation,
      activationSignature: {
        algorithm: "Ed25519",
        keyId: publisherKey.sha256,
        signatureBase64: publisherSignature.toString("base64"),
      },
      hostAttestation,
      hostAttestationSignature: {
        algorithm: "Ed25519",
        keyId: hostKey.sha256,
        signatureBase64: hostSignature.toString("base64"),
      },
    };
    scanSecretFree(bundle, "bundle");
    const canonical = canonicalProductionActivationBundleJson(bundle);
    const bytes = Buffer.from(canonical, "utf8");
    if (bytes.length > PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES) {
      fail(
        "PRODUCTION_ACTIVATION_BUNDLE_SIZE_INVALID",
        "signed bundle exceeds the runtime transport boundary.",
      );
    }
    const verifyBundle =
      dependencies.verifyBundle ?? verifyWithRuntimeContracts;
    await verifyBundle({
      bundle,
      bundleBytes: bytes,
      challenge,
      publisherPublicKeyFile,
      publisherPublicKeySha256: publisherKey.sha256,
      hostPublicKeyFile,
      hostPublicKeySha256: hostKey.sha256,
      now,
    });
    // Complete ephemeral custody cleanup before the atomic publication point,
    // so a cleanup failure can never produce a false negative after commit.
    await rm(temporaryDirectory, { recursive: true, force: true });
    await publishAtomicNoClobber(output, bytes);
    return Object.freeze({
      output,
      sha256: `sha256:${sha256Hex(bytes)}`,
      sourceSha: challenge.sourceSha,
      containerId: challenge.containerId,
      nonce: challenge.nonce,
      issuedAt: activation.issuedAt,
      expiresAt: activation.expiresAt,
      signaturesVerified: true,
      semanticContractVerified: true,
      privateMaterialPrinted: false,
    });
  } finally {
    publisherSignature?.fill(0);
    hostSignature?.fill(0);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await publishProductionActivationBundle(options);
  process.stdout.write(
    [
      "published=true",
      `output=${result.output}`,
      `bundleSha256=${result.sha256}`,
      `sourceSha=${result.sourceSha}`,
      `containerId=${result.containerId}`,
      `nonce=${result.nonce}`,
      `issuedAt=${result.issuedAt}`,
      `expiresAt=${result.expiresAt}`,
      "publisherSignatureVerified=true",
      "hostSignatureVerified=true",
      "semanticContractVerified=true",
      "privateMaterialPrinted=false",
      "",
    ].join("\n"),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      error instanceof ProductionActivationBundleError
        ? error.code
        : "PRODUCTION_ACTIVATION_BUNDLE_FAILED";
    process.stderr.write(`${code}: publication failed.\n${usage()}\n`);
    process.exitCode = 1;
  });
}
