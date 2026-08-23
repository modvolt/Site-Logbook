import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

export const PRODUCTION_HOST_OPERATOR_BUILD_PROFILE =
  "site-logbook-production-host-operator/v1";
export const PRODUCTION_ACTIVATION_BUNDLE_TRANSFER_CONFIRMATION =
  "PUBLISH_DIGEST_VERIFIED_SITE_LOGBOOK_ACTIVATION_BUNDLE_V2_ON_HOST";
export const PRODUCTION_ACTIVATION_BUNDLE_BASENAME =
  "activation-bundle-v2.json";
export const PRODUCTION_ACTIVATION_0108_BUNDLE_TRANSFER_CONFIRMATION =
  "PUBLISH_DIGEST_VERIFIED_SITE_LOGBOOK_ACTIVATION_BUNDLE_V3_ON_HOST";
export const PRODUCTION_ACTIVATION_0108_BUNDLE_BASENAME =
  "activation-bundle-v3.json";
export const PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES = 1024 * 1024;

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256_PIN = /^sha256:[0-9a-f]{64}$/;
const PRIVATE_FIELD =
  /(?:password|secret|private.?key|access.?key|session|cookie|token|authorization|database.?url|mnemonic|passphrase)/i;
const PUBLIC_IDENTITY_OR_POLICY_FIELDS = new Set([
  "adminSessionUser",
  "sessionUser",
  "requiresExplicitCoolifySecretTransfer",
]);
const PRIVATE_VALUE =
  /(-----BEGIN [^-]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s/@:]+:[^\s/@]+@|\bAKIA[0-9A-Z]{16}\b|\bSCRAM-SHA-256\$|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bgithub_pat_[A-Za-z0-9_]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{16,}\b)/i;

export class ProductionHostOperatorPackagingError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionHostOperatorPackagingError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ProductionHostOperatorPackagingError(code, message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function productionHostOperatorUsage() {
  return [
    "Usage:",
    "  production-host-evidence-operator observe [the exact sealed host-evidence options]",
    "  production-host-evidence-operator attest [the exact sealed host-evidence options]",
    "  production-host-evidence-operator verify [the exact sealed host-evidence options]",
    `  production-host-evidence-operator publish-activation-bundle --input ABSOLUTE_FILE --expected-sha256 sha256:HEX64 --evidence-dir ABSOLUTE_DIRECTORY --confirm ${PRODUCTION_ACTIVATION_BUNDLE_TRANSFER_CONFIRMATION}`,
    `  production-host-evidence-operator publish-activation-0108-bundle --input ABSOLUTE_FILE --expected-sha256 sha256:HEX64 --evidence-dir ABSOLUTE_DIRECTORY --confirm ${PRODUCTION_ACTIVATION_0108_BUNDLE_TRANSFER_CONFIRMATION}`,
    "",
    "No command is the default-dark state. The image never receives a private key or transport credential.",
    `Build profile: ${PRODUCTION_HOST_OPERATOR_BUILD_PROFILE}`,
  ].join("\n");
}

function immutableSourceSha(value) {
  if (
    typeof value !== "string" ||
    !SOURCE_SHA.test(value) ||
    /^0{40}$/.test(value)
  ) {
    fail(
      "PRODUCTION_HOST_OPERATOR_SOURCE_INVALID",
      "the bundle has no immutable exact source SHA.",
    );
  }
  return value;
}

function absolutePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !path.isAbsolute(value)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_PATH_INVALID",
      `${field} must be an absolute path.`,
    );
  }
  return path.resolve(value);
}

function parsePublishOptions(argv, protocolVersion = 2) {
  if (argv.length % 2 !== 0) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_ARGUMENTS_INVALID",
      "every option requires one value.",
    );
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_ARGUMENTS_INVALID",
        "options must be exact --name value pairs.",
      );
    }
    const key = option.slice(2);
    if (Object.hasOwn(options, key)) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_ARGUMENTS_INVALID",
        "duplicate options are forbidden.",
      );
    }
    options[key] = value;
  }
  const expected = [
    "confirm",
    "evidence-dir",
    "expected-sha256",
    "input",
  ].sort();
  if (
    JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_ARGUMENTS_INVALID",
      "publish-activation-bundle requires only the reviewed option set.",
    );
  }
  const confirmation =
    protocolVersion === 3
      ? PRODUCTION_ACTIVATION_0108_BUNDLE_TRANSFER_CONFIRMATION
      : PRODUCTION_ACTIVATION_BUNDLE_TRANSFER_CONFIRMATION;
  if (options.confirm !== confirmation) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DARK",
      "the exact attended host-publication confirmation is required.",
    );
  }
  if (
    !SHA256_PIN.test(options["expected-sha256"]) ||
    /^sha256:0{64}$/.test(options["expected-sha256"])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DIGEST_INVALID",
      "expected-sha256 must be one non-zero lowercase SHA-256 pin.",
    );
  }
  return Object.freeze({
    input: absolutePath(options.input, "input"),
    evidenceDirectory: absolutePath(options["evidence-dir"], "evidence-dir"),
    expectedSha256: options["expected-sha256"],
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys, field) {
  if (!isRecord(value)) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_SCHEMA_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return value;
}

function canonicalValue(value, field = "bundle") {
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
        "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
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
    "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
    `${field} contains a non-JSON value.`,
  );
}

export function canonicalProductionActivationTransferJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function scanPrivateMaterial(value, field = "bundle") {
  if (typeof value === "string") {
    if (PRIVATE_VALUE.test(value)) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_PRIVATE_MATERIAL",
        `${field} contains forbidden private material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanPrivateMaterial(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_FIELD.test(key) && !PUBLIC_IDENTITY_OR_POLICY_FIELDS.has(key)) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_PRIVATE_MATERIAL",
        `${field}.${key} is a forbidden private-material field.`,
      );
    }
    scanPrivateMaterial(entry, `${field}.${key}`);
  }
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

export async function readStableSingleLinkFile(
  file,
  maximumBytes = PRODUCTION_ACTIVATION_BUNDLE_MAX_BYTES,
) {
  let before;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_INPUT_UNSAFE",
      "input must be one stable regular file.",
      error,
    );
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_INPUT_UNSAFE",
      "input must be one bounded regular, non-symlink, single-link file.",
    );
  }
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_INPUT_UNSAFE",
      "input could not be opened without following links.",
      error,
    );
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_INPUT_CHANGED",
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
      BigInt(offset) !== afterRead.size ||
      !sameFile(opened, afterRead) ||
      !sameFile(afterRead, afterPath)
    ) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_INPUT_CHANGED",
        "input was not stable for the complete bounded read.",
      );
    }
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function parseCanonicalActivationBundle(
  bytes,
  expectedSourceSha,
  protocolVersion = 2,
) {
  if (bytes.includes(0x0d)) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
      "input must use canonical LF bytes.",
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
      "input must be valid UTF-8.",
      error,
    );
  }
  if (!text.endsWith("\n") || text.endsWith("\n\n")) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
      "input must end in exactly one LF.",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
      "input must be valid JSON.",
      error,
    );
  }
  if (canonicalProductionActivationTransferJson(value) !== text) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_CANONICAL_INVALID",
      "input is not canonical sorted-key JSON.",
    );
  }
  scanPrivateMaterial(value);
  const bundle = exactObject(
    value,
    [
      "activation",
      "activationSignature",
      "hostAttestation",
      "hostAttestationSignature",
    ],
    "bundle",
  );
  const activation = isRecord(bundle.activation) ? bundle.activation : {};
  const hostAttestation = isRecord(bundle.hostAttestation)
    ? bundle.hostAttestation
    : {};
  if (
    activation.schemaVersion !== protocolVersion ||
    activation.kind !==
      `site-logbook-production-activation-bundle-v${protocolVersion}` ||
    activation.sourceSha !== expectedSourceSha ||
    hostAttestation.schemaVersion !== protocolVersion ||
    hostAttestation.kind !==
      `site-logbook-production-host-attestation-v${protocolVersion}` ||
    hostAttestation.sourceSha !== expectedSourceSha
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_SOURCE_MISMATCH",
      `bundle source and v${protocolVersion} kinds must match the immutable host-operator build.`,
    );
  }
  for (const [field, raw] of [
    ["activationSignature", bundle.activationSignature],
    ["hostAttestationSignature", bundle.hostAttestationSignature],
  ]) {
    const signature = exactObject(
      raw,
      ["algorithm", "keyId", "signatureBase64"],
      field,
    );
    let decoded;
    try {
      decoded = Buffer.from(signature.signatureBase64, "base64");
    } catch {
      decoded = Buffer.alloc(0);
    }
    if (
      signature.algorithm !== "Ed25519" ||
      typeof signature.keyId !== "string" ||
      !SHA256_PIN.test(signature.keyId) ||
      typeof signature.signatureBase64 !== "string" ||
      decoded.length !== 64 ||
      decoded.toString("base64") !== signature.signatureBase64
    ) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_SCHEMA_INVALID",
        `${field} is not one canonical Ed25519 signature descriptor.`,
      );
    }
  }
  return value;
}

async function inspectEvidenceDirectory(directory) {
  let stats;
  let resolved;
  try {
    [stats, resolved] = await Promise.all([
      lstat(directory, { bigint: true }),
      realpath(directory),
    ]);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DIRECTORY_UNSAFE",
      "evidence-dir must already be one real directory.",
      error,
    );
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    path.resolve(resolved) !== path.resolve(directory)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DIRECTORY_UNSAFE",
      "evidence-dir must be a non-symlink canonical directory.",
    );
  }
  return stats;
}

async function syncDirectory(directory) {
  const directoryFlag =
    typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | directoryFlag | noFollow,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_DIRECTORY_UNSAFE",
        "evidence-dir changed before fsync.",
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishAtomicNoClobber(
  directory,
  bytes,
  outputBasename,
  dependencies = {},
) {
  const destination = path.join(directory, outputBasename);
  const temporary = path.join(
    directory,
    `.${outputBasename}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  const sync = dependencies.syncDirectory ?? syncDirectory;
  let temporaryExists = false;
  let linked = false;
  try {
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        noFollow,
      0o600,
    );
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(
          "PRODUCTION_ACTIVATION_TRANSFER_DESTINATION_EXISTS",
          `${outputBasename} already exists and will not be overwritten.`,
        );
      }
      throw error;
    }
    await sync(directory);
    await unlink(temporary);
    temporaryExists = false;
    await sync(directory);
    const readback = await readStableSingleLinkFile(destination, bytes.length);
    if (!readback.equals(bytes)) {
      fail(
        "PRODUCTION_ACTIVATION_TRANSFER_READBACK_MISMATCH",
        "published bytes differ from the digest-verified input.",
      );
    }
    return destination;
  } finally {
    if (temporaryExists && !linked) {
      await unlink(temporary).catch(() => {});
    }
  }
}

async function publishTransferredActivationBundleVersion(
  argv,
  embeddedSourceSha,
  dependencies,
  protocolVersion,
) {
  const sourceSha = immutableSourceSha(embeddedSourceSha);
  const outputBasename =
    protocolVersion === 3
      ? PRODUCTION_ACTIVATION_0108_BUNDLE_BASENAME
      : PRODUCTION_ACTIVATION_BUNDLE_BASENAME;
  const options = parsePublishOptions(argv, protocolVersion);
  const destination = path.join(options.evidenceDirectory, outputBasename);
  if (path.resolve(options.input) === path.resolve(destination)) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_PATH_INVALID",
      "input must be a separate staged file.",
    );
  }
  const directoryBefore = await inspectEvidenceDirectory(
    options.evidenceDirectory,
  );
  const bytes = await readStableSingleLinkFile(options.input);
  parseCanonicalActivationBundle(bytes, sourceSha, protocolVersion);
  const actualSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualSha256 !== options.expectedSha256) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DIGEST_MISMATCH",
      "staged bytes differ from the independently transferred SHA-256 pin.",
    );
  }
  const output = await publishAtomicNoClobber(
    options.evidenceDirectory,
    bytes,
    outputBasename,
    dependencies,
  );
  const directoryAfter = await inspectEvidenceDirectory(
    options.evidenceDirectory,
  );
  if (
    directoryBefore.dev !== directoryAfter.dev ||
    directoryBefore.ino !== directoryAfter.ino
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TRANSFER_DIRECTORY_CHANGED",
      "evidence-dir identity changed during publication.",
    );
  }
  return Object.freeze({ output, sha256: actualSha256, sourceSha });
}

export async function publishTransferredActivationBundle(
  argv,
  embeddedSourceSha,
  dependencies = {},
) {
  return publishTransferredActivationBundleVersion(
    argv,
    embeddedSourceSha,
    dependencies,
    2,
  );
}

export async function publishTransferredActivation0108Bundle(
  argv,
  embeddedSourceSha,
  dependencies = {},
) {
  return publishTransferredActivationBundleVersion(
    argv,
    embeddedSourceSha,
    dependencies,
    3,
  );
}

export async function runProductionHostOperator(argv, dependencies = {}) {
  const sourceSha = immutableSourceSha(dependencies.sourceSha);
  const [command, ...rest] = argv;
  if (
    command === "publish-activation-bundle" ||
    command === "publish-activation-0108-bundle"
  ) {
    const publish =
      command === "publish-activation-0108-bundle"
        ? publishTransferredActivation0108Bundle
        : publishTransferredActivationBundle;
    const result = await publish(rest, sourceSha, dependencies.publication);
    process.stdout.write(
      `activationBundle=${result.output}\nactivationBundleSha256=${result.sha256}\nsourceSha=${result.sourceSha}\n`,
    );
    return result;
  }
  if (!command || !["observe", "attest", "verify"].includes(command)) {
    fail(
      "PRODUCTION_HOST_OPERATOR_DARK",
      "an exact reviewed subcommand is required.",
    );
  }
  if (typeof dependencies.runHostEvidence !== "function") {
    fail(
      "PRODUCTION_HOST_OPERATOR_PACKAGING_INVALID",
      "the sealed host-evidence runner is unavailable.",
    );
  }
  return dependencies.runHostEvidence([command, ...rest], sourceSha);
}
