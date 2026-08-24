import { spawn, spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import {
  constants as fsConstants,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
  assertProductionPublisherProvenanceTrustRootBinding,
} from "../../artifacts/api-server/src/lib/production-publisher-provenance-pinned-keys.mjs";
import {
  IMAGE_PROVENANCE_SCHEMA,
  assertSecretFree,
  canonicalJson,
  sha256,
  verifyProductionApiImageProvenanceArtifact,
  verifyProductionApiImageProvenanceArtifactWithTestAuthority,
} from "./host-attestation-contract.mjs";
import {
  PRODUCTION_IMAGE_SPECS,
  parseStrictSecretFreeJson,
  parseProductionImagePublicationReceipt,
} from "./production-image-publication-contract.mjs";
import {
  MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
  parseManualProductionImageCompleteReceipt,
  validateManualProductionImageCompleteReceiptAgainstRawEvidence,
} from "./manual-production-image-complete-contract.mjs";

export const PRODUCTION_API_IMAGE_PROVENANCE_CONFIRMATION =
  "PRODUCE_AND_SIGN_EXACT_SITE_LOGBOOK_PRODUCTION_API_IMAGE_PROVENANCE";
export const PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_CONFIRMATION =
  "PRODUCE_AND_SIGN_EXACT_SITE_LOGBOOK_MANUAL_OFFLINE_PRODUCTION_API_IMAGE_PROVENANCE";
export const PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_SCHEMA =
  "site-logbook.production-api-image-provenance-production-receipt/v1";
export const PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_KIND =
  "site-logbook-production-api-image-provenance-production-receipt";
export const PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_RECEIPT_SCHEMA =
  "site-logbook.production-api-image-provenance-manual-production-receipt/v1";
export const PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_RECEIPT_KIND =
  "site-logbook-production-api-image-provenance-manual-production-receipt";
export const PRODUCTION_API_IMAGE_PROVENANCE_FILES = Object.freeze({
  provenance: "production-api-image-provenance.json",
  signature: "production-api-image-provenance.sig",
  receipt: "production-api-image-provenance-production-receipt.json",
});

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const CUSTODY_SCRIPT = path.join(
  SCRIPT_DIRECTORY,
  "production-signing-custody.mjs",
);
const MAX_PUBLICATION_RECEIPT_BYTES = 1024 * 1024;
const MAX_API_OCI_PROVENANCE_BYTES = 16 * 1024 * 1024;
const MAX_MANUAL_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;
const CUSTODY_TIMEOUT_MS = 120_000;
const CUSTODY_TERMINATION_TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const KEY_ID = /^ed25519:[a-z0-9][a-z0-9._-]{2,63}$/u;
const API_IMAGE =
  /^ghcr\.io\/modvolt\/site-logbook-production-api@sha256:[0-9a-f]{64}$/u;
const OUTPUT_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const SOURCE_URL = "https://github.com/modvolt/Site-Logbook";
const API_BUILD_SUBJECT_REPOSITORY = PRODUCTION_IMAGE_SPECS.api.repository;

export class ProductionApiImageProvenanceError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionApiImageProvenanceError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ProductionApiImageProvenanceError(code, message, { cause });
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_API_PROVENANCE_REQUEST_INVALID", `${field} is invalid.`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_REQUEST_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return value;
}

function exactText(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail("PRODUCTION_API_PROVENANCE_REQUEST_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactSha(value, field) {
  const result = exactText(value, field).toLowerCase();
  if (!SHA.test(result) || /^0{40}$/u.test(result)) {
    fail("PRODUCTION_API_PROVENANCE_BINDING_INVALID", `${field} is invalid.`);
  }
  return result;
}

function exactDigest(value, field) {
  const result = exactText(value, field).toLowerCase();
  if (!DIGEST.test(result) || /^sha256:0{64}$/u.test(result)) {
    fail("PRODUCTION_API_PROVENANCE_BINDING_INVALID", `${field} is invalid.`);
  }
  return result;
}

function exactPositiveInteger(value, field) {
  const result = exactText(value, field);
  if (!POSITIVE_INTEGER.test(result)) {
    fail("PRODUCTION_API_PROVENANCE_BINDING_INVALID", `${field} is invalid.`);
  }
  return result;
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_API_PROVENANCE_BINDING_INVALID",
      `${field} does not match the approved publication binding.`,
    );
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function absoluteOutsideRepository(value, field) {
  const input = exactText(value, field);
  if (!path.isAbsolute(input)) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} must be absolute.`,
    );
  }
  const resolved = path.resolve(input);
  if (isWithin(REPOSITORY_ROOT, resolved)) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} must remain outside the repository.`,
    );
  }
  return resolved;
}

function sameNode(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function sameFileSnapshot(left, right) {
  return (
    sameNode(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function noReparseState(target, field) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const segments = path
    .relative(root, absolute)
    .split(path.sep)
    .filter(Boolean);
  let cursor = root;
  let state;
  try {
    state = await lstat(cursor, { bigint: true });
    if (state.isSymbolicLink()) {
      fail(
        "PRODUCTION_API_PROVENANCE_PATH_INVALID",
        `${field} contains a reparse-point ancestor.`,
      );
    }
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      state = await lstat(cursor, { bigint: true });
      if (state.isSymbolicLink()) {
        fail(
          "PRODUCTION_API_PROVENANCE_PATH_INVALID",
          `${field} contains a reparse-point ancestor.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof ProductionApiImageProvenanceError) throw error;
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} ancestry is unavailable or unstable.`,
      error,
    );
  }
  return state;
}

async function inspectStableDirectory(directory, field) {
  const before = await noReparseState(directory, field);
  if (!before.isDirectory()) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} must be an existing non-reparse directory.`,
    );
  }
  let real;
  let after;
  try {
    real = await realpath(directory);
    after = await lstat(directory, { bigint: true });
  } catch (error) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} could not be resolved stably.`,
      error,
    );
  }
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameNode(before, after)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} changed while it was resolved.`,
    );
  }
  return Object.freeze({ path: path.resolve(real), state: after });
}

async function assertDirectoryIdentity(directory, expected, field) {
  let current;
  try {
    current = await lstat(directory, { bigint: true });
  } catch (error) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} is no longer available.`,
      error,
    );
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameNode(current, expected)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} identity changed during publication.`,
    );
  }
  return current;
}

async function readStableSingleLinkFile(
  file,
  maxBytes,
  field,
  allowEmpty = false,
  beforeRead,
) {
  const before = await noReparseState(file, field);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (!allowEmpty && before.size <= 0n) ||
    before.size > BigInt(maxBytes)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
      `${field} must be one bounded regular single-link file.`,
    );
  }
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    const resolvedPath = path.resolve(await realpath(file));
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      fail(
        "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
        `${field} changed before it was opened.`,
      );
    }
    await beforeRead?.(Object.freeze({ field, maxBytes }));
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      fail(
        "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
        `${field} exceeded its byte limit while it was read.`,
      );
    }
    const bytes = bounded.subarray(0, offset);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(file, { bigint: true });
    if (
      !sameFileSnapshot(opened, after) ||
      !sameFileSnapshot(after, pathAfter) ||
      BigInt(bytes.length) !== opened.size
    ) {
      fail(
        "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
        `${field} changed while it was read.`,
      );
    }
    return Object.freeze({ bytes, state: pathAfter, path: resolvedPath });
  } catch (error) {
    if (error instanceof ProductionApiImageProvenanceError) throw error;
    fail(
      "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
      `${field} could not be read safely.`,
      error,
    );
  } finally {
    await handle?.close();
  }
}

function decodeUtf8(bytes, field) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(
      "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
      `${field} must be valid UTF-8.`,
      error,
    );
  }
}

function provenanceObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_API_PROVENANCE_OCI_INVALID",
      `${field} must be an object.`,
    );
  }
  return value;
}

function requireProvenanceEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_API_PROVENANCE_OCI_INVALID",
      `${field} does not match the reviewed API OCI provenance binding.`,
    );
  }
}

function verifyApiOciProvenanceBytes(bytes, publication, request) {
  const actualSha256 = sha256(bytes);
  const api = publication.receipt.images.api;
  requireEqual(
    actualSha256,
    request.apiOciProvenanceSha256,
    "apiOciProvenance.inputSha256",
  );
  requireEqual(
    actualSha256,
    api.provenance.sha256,
    "receipt.images.api.provenance.sha256",
  );
  let statement;
  try {
    statement = parseStrictSecretFreeJson(bytes, "apiOciProvenance");
  } catch (error) {
    if (error?.code === "PRODUCTION_IMAGE_SECRET_MATERIAL") {
      fail(
        "PRODUCTION_API_PROVENANCE_OCI_SECRET_MATERIAL",
        "The API OCI provenance input contains forbidden secret-shaped material.",
        error,
      );
    }
    fail(
      "PRODUCTION_API_PROVENANCE_OCI_INVALID",
      "The API OCI provenance input must be one JSON statement.",
      error,
    );
  }
  provenanceObject(statement, "apiOciProvenance");
  requireProvenanceEqual(
    statement._type,
    "https://in-toto.io/Statement/v0.1",
    "apiOciProvenance._type",
  );
  requireProvenanceEqual(
    statement.predicateType,
    "https://slsa.dev/provenance/v0.2",
    "apiOciProvenance.predicateType",
  );
  const predicate = provenanceObject(
    statement.predicate,
    "apiOciProvenance.predicate",
  );
  requireProvenanceEqual(
    predicate.buildType,
    api.provenance.buildType,
    "apiOciProvenance.predicate.buildType",
  );
  const invocation = provenanceObject(
    predicate.invocation,
    "apiOciProvenance.predicate.invocation",
  );
  requireProvenanceEqual(
    invocation.configSource?.entryPoint,
    "Dockerfile",
    "apiOciProvenance.predicate.invocation.configSource.entryPoint",
  );
  const parameters = provenanceObject(
    invocation.parameters,
    "apiOciProvenance.predicate.invocation.parameters",
  );
  const args = provenanceObject(
    parameters.args,
    "apiOciProvenance.predicate.invocation.parameters.args",
  );
  requireProvenanceEqual(
    args[`build-arg:${api.provenance.buildArg}`],
    publication.receipt.source.sha,
    "apiOciProvenance.predicate.invocation.parameters.args.buildArg",
  );
  requireProvenanceEqual(
    args.target,
    api.provenance.target,
    "apiOciProvenance.predicate.invocation.parameters.args.target",
  );
  const requestArgs = provenanceObject(
    provenanceObject(
      parameters.root,
      "apiOciProvenance.predicate.invocation.parameters.root",
    ).request,
    "apiOciProvenance.predicate.invocation.parameters.root.request",
  ).args;
  provenanceObject(
    requestArgs,
    "apiOciProvenance.predicate.invocation.parameters.root.request.args",
  );
  requireProvenanceEqual(
    requestArgs["vcs:localdir:dockerfile"],
    path.posix.dirname(api.provenance.dockerfile),
    "apiOciProvenance.dockerfileDirectory",
  );
  requireProvenanceEqual(
    requestArgs["vcs:revision"],
    publication.receipt.source.sha,
    "apiOciProvenance.vcsRevision",
  );
  requireProvenanceEqual(
    requestArgs["vcs:source"],
    SOURCE_URL,
    "apiOciProvenance.vcsSource",
  );
  const vcs = provenanceObject(
    predicate.metadata,
    "apiOciProvenance.predicate.metadata",
  )["https://mobyproject.org/buildkit@v1#metadata"]?.vcs;
  provenanceObject(vcs, "apiOciProvenance.predicate.metadata.vcs");
  requireProvenanceEqual(
    vcs.source,
    SOURCE_URL,
    "apiOciProvenance.predicate.metadata.vcs.source",
  );
  requireProvenanceEqual(
    vcs.revision,
    publication.receipt.source.sha,
    "apiOciProvenance.predicate.metadata.vcs.revision",
  );
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    fail(
      "PRODUCTION_API_PROVENANCE_OCI_INVALID",
      "The API OCI provenance must contain exactly one runnable-manifest subject.",
    );
  }
  const subject = provenanceObject(
    statement.subject[0],
    "apiOciProvenance.subject[0]",
  );
  requireProvenanceEqual(
    subject.name,
    `pkg:docker/${API_BUILD_SUBJECT_REPOSITORY}@${publication.receipt.source.sha}?platform=linux%2Famd64`,
    "apiOciProvenance.subject[0].name",
  );
  const subjectDigest = provenanceObject(
    subject.digest,
    "apiOciProvenance.subject[0].digest",
  );
  requireProvenanceEqual(
    subjectDigest.sha256,
    api.runnableManifestDigest.slice("sha256:".length),
    "apiOciProvenance.subject[0].digest.sha256",
  );
  return Object.freeze({ sha256: actualSha256 });
}

async function readPinnedManualEvidenceEntry(entry, field) {
  const input = await readStableSingleLinkFile(
    entry.path,
    MAX_MANUAL_EVIDENCE_BYTES,
    field,
    false,
  );
  requireEqual(sha256(input.bytes), entry.sha256, `${field}.sha256`);
  let value;
  try {
    value = parseStrictSecretFreeJson(input.bytes, field);
  } catch (error) {
    fail(
      "PRODUCTION_API_PROVENANCE_INPUT_INVALID",
      `${field} must be strict secret-free JSON pinned by the caller.`,
      error,
    );
  }
  return Object.freeze({ input, value, sha256: entry.sha256 });
}

async function readPinnedManualEvidence(request) {
  const custody = await readPinnedManualEvidenceEntry(
    request.manualEvidence.custody,
    "manualCustody",
  );
  const custodyVerification = await readPinnedManualEvidenceEntry(
    request.manualEvidence.custodyVerification,
    "manualCustodyVerification",
  );
  const packageMetadata = await readPinnedManualEvidenceEntry(
    request.manualEvidence.packageMetadata,
    "manualPackageMetadata",
  );
  const registrySummary = await readPinnedManualEvidenceEntry(
    request.manualEvidence.registrySummary,
    "manualRegistrySummary",
  );
  const images = {};
  const registryResults = {};
  for (const key of Object.keys(PRODUCTION_IMAGE_SPECS)) {
    images[key] = await readPinnedManualEvidenceEntry(
      request.manualEvidence.images[key],
      `manualImage.${key}`,
    );
    registryResults[key] = await readPinnedManualEvidenceEntry(
      request.manualEvidence.registryResults[key],
      `manualRegistryResult.${key}`,
    );
  }
  return Object.freeze({
    custody,
    custodyVerification,
    packageMetadata,
    registrySummary,
    images: Object.freeze(images),
    registryResults: Object.freeze(registryResults),
    inputs: Object.freeze([
      custody.input,
      custodyVerification.input,
      packageMetadata.input,
      registrySummary.input,
      ...Object.values(images).map((entry) => entry.input),
      ...Object.values(registryResults).map((entry) => entry.input),
    ]),
  });
}

async function assertMissing(target, field) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      `${field} could not be inspected.`,
      error,
    );
  }
  fail(
    "PRODUCTION_API_PROVENANCE_OUTPUT_EXISTS",
    `${field} already exists and will not be replaced.`,
  );
}

async function writeExclusiveSynced(file, bytes) {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  let opened;
  let failure;
  try {
    handle = await open(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
    opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
      fail(
        "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
        "An exclusive output did not resolve to one regular single-link file.",
      );
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (
      !sameNode(opened, after) ||
      after.size !== BigInt(Buffer.byteLength(bytes)) ||
      after.nlink !== 1n
    ) {
      fail(
        "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
        "An exclusive output changed while it was written.",
      );
    }
    opened = after;
  } catch (error) {
    failure = error;
  } finally {
    await handle?.close();
  }
  if (failure) {
    if (opened) await unlinkOwned(file, opened, false);
    if (failure instanceof ProductionApiImageProvenanceError) throw failure;
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "An output file could not be created durably and exclusively.",
      failure,
    );
  }
  let pathState;
  try {
    pathState = await lstat(file, { bigint: true });
  } catch (error) {
    if (opened) await unlinkOwned(file, opened, false);
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "An exclusive output disappeared before verification.",
      error,
    );
  }
  if (!sameFileSnapshot(opened, pathState)) {
    await unlinkOwned(file, opened, false);
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "An exclusive output path changed after it was written.",
    );
  }
  return pathState;
}

async function syncDirectory(directory, expected, field) {
  await assertDirectoryIdentity(directory, expected, field);
  if (process.platform !== "win32") {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameNode(opened, expected)) {
        fail(
          "PRODUCTION_API_PROVENANCE_PATH_INVALID",
          `${field} changed before directory fsync.`,
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await assertDirectoryIdentity(directory, expected, field);
}

async function unlinkOwned(file, expected, strict = true) {
  let current;
  try {
    current = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (!strict) return false;
    throw error;
  }
  if (!sameNode(current, expected)) {
    if (!strict) return false;
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "Refusing to remove a path whose identity is not producer-owned.",
    );
  }
  await unlink(file);
  return true;
}

async function rmdirOwnedIfEmpty(directory, expected, strict = true) {
  let current;
  try {
    current = await lstat(directory, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (!strict) return false;
    throw error;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameNode(current, expected)
  ) {
    if (!strict) return false;
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "Refusing to remove a directory whose identity is not producer-owned.",
    );
  }
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (!strict && (error?.code === "ENOENT" || error?.code === "ENOTEMPTY")) {
      return false;
    }
    throw error;
  }
}

function exactEnvironmentValue(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      `${field} is unavailable or unsafe.`,
    );
  }
  return value;
}

function publisherCustodyEnvironment(source) {
  const rootCandidate = source.SystemRoot ?? source.SYSTEMROOT ?? source.WINDIR;
  const environment = {};
  if (rootCandidate !== undefined) {
    const root = exactEnvironmentValue(rootCandidate, "SystemRoot");
    environment.SystemRoot = root;
    environment.WINDIR = root;
  }
  for (const key of [
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SystemDrive",
    "COMSPEC",
  ]) {
    if (source[key] !== undefined) {
      environment[key] = exactEnvironmentValue(source[key], key);
    }
  }
  if (process.platform === "win32" && environment.SystemRoot === undefined) {
    fail(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      "A trusted Windows SystemRoot is required for the custody process.",
    );
  }
  return Object.freeze(environment);
}

function publisherCustodySpawnSpec(
  { vault, input, output },
  sourceEnvironment,
) {
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      CUSTODY_SCRIPT,
      "sign",
      "--vault",
      vault,
      "--purpose",
      "publisher-provenance",
      "--input",
      input,
      "--output",
      output,
    ]),
    options: Object.freeze({
      cwd: REPOSITORY_ROOT,
      env: publisherCustodyEnvironment(sourceEnvironment),
      stdio: Object.freeze(["ignore", "pipe", "pipe"]),
      windowsHide: true,
      detached: process.platform !== "win32",
    }),
  });
}

export function buildProductionPublisherCustodySpawnSpecForTest(
  request,
  sourceEnvironment,
) {
  return publisherCustodySpawnSpec(request, sourceEnvironment);
}

function waitForCustodyOutcome(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let total = 0;
    let timeout;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolvePromise(outcome);
    };
    const onError = (error) => finish({ type: "error", error });
    const onClose = (code, signal) => finish({ type: "close", code, signal });
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_CHILD_OUTPUT_BYTES) finish({ type: "overflow" });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    timeout = setTimeout(() => finish({ type: "timeout" }), timeoutMs);
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeout;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      callback();
    };
    const onClose = () => finish(resolvePromise);
    const onError = (error) => finish(() => rejectPromise(error));
    child.once("close", onClose);
    child.once("error", onError);
    timeout = setTimeout(
      () =>
        finish(() =>
          rejectPromise(
            new ProductionApiImageProvenanceError(
              "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
              "Custody process-tree termination could not be confirmed within the reviewed bound.",
            ),
          ),
        ),
      timeoutMs,
    );
  });
}

async function terminateCustodyProcessTree(child, environment) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    const taskkill = path.join(
      environment.SystemRoot,
      "System32",
      "taskkill.exe",
    );
    const result = spawnSync(
      taskkill,
      ["/PID", String(child.pid), "/T", "/F"],
      {
        env: environment,
        stdio: "ignore",
        windowsHide: true,
        timeout: CUSTODY_TERMINATION_TIMEOUT_MS,
      },
    );
    if (!result.error && result.status === 0) return true;
    return false;
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

async function runPublisherCustodySignatureCore(
  request,
  {
    sourceEnvironment,
    spawnChild,
    terminateTree,
    timeoutMs,
    terminationTimeoutMs,
  },
) {
  const spec = publisherCustodySpawnSpec(request, sourceEnvironment);
  let child;
  try {
    child = spawnChild(spec.command, spec.args, spec.options);
  } catch (error) {
    throw new ProductionApiImageProvenanceError(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      "The attended custody signer could not start.",
      { cause: error },
    );
  }
  const outcome = await waitForCustodyOutcome(child, timeoutMs);
  if (outcome.type === "timeout" || outcome.type === "overflow") {
    let treeTerminationVerified = false;
    let terminationFailure;
    try {
      treeTerminationVerified =
        (await terminateTree(child, spec.options.env)) === true;
    } catch (error) {
      terminationFailure = error;
      try {
        child.kill("SIGKILL");
      } catch {
        // waitForChildClose below is the bounded parent-process authority.
      }
    }
    if (!treeTerminationVerified && terminationFailure === undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        // waitForChildClose below is the bounded parent-process authority.
      }
    }
    await waitForChildClose(child, terminationTimeoutMs);
    if (!treeTerminationVerified) {
      throw new ProductionApiImageProvenanceError(
        "PRODUCTION_API_PROVENANCE_CUSTODY_TREE_TERMINATION_UNVERIFIED",
        "The custody parent process closed, but termination of its complete process tree could not be verified.",
        terminationFailure === undefined
          ? undefined
          : { cause: terminationFailure },
      );
    }
    throw new ProductionApiImageProvenanceError(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      outcome.type === "timeout"
        ? "The attended custody signer exceeded its reviewed time bound and its process tree was terminated."
        : "The attended custody signer exceeded its bounded output and its process tree was terminated.",
    );
  }
  if (outcome.type === "error") {
    throw new ProductionApiImageProvenanceError(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      "The attended custody signer could not start.",
      { cause: outcome.error },
    );
  }
  if (outcome.code !== 0) {
    throw new ProductionApiImageProvenanceError(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      "The attended custody signer failed without exposing its output.",
    );
  }
}

async function runPublisherCustodySignature(request) {
  return runPublisherCustodySignatureCore(request, {
    sourceEnvironment: process.env,
    spawnChild: spawn,
    terminateTree: terminateCustodyProcessTree,
    timeoutMs: CUSTODY_TIMEOUT_MS,
    terminationTimeoutMs: CUSTODY_TERMINATION_TIMEOUT_MS,
  });
}

export async function runProductionPublisherCustodySignatureWithTestProcess(
  request,
  dependencies,
) {
  const exact = exactKeys(
    dependencies,
    [
      "sourceEnvironment",
      "spawnChild",
      "terminateTree",
      "timeoutMs",
      "terminationTimeoutMs",
    ],
    "custodyTestProcess",
  );
  return runPublisherCustodySignatureCore(request, exact);
}

function parseRequest(rawRequest) {
  if (rawRequest?.publicationMode === MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE) {
    return parseManualRequest(rawRequest);
  }
  const request = exactKeys(
    rawRequest,
    [
      "publicationReceipt",
      "publicationReceiptSha256",
      "apiOciProvenance",
      "sourceSha",
      "completeRunId",
      "completeRunAttempt",
      "apiImage",
      "apiOciProvenanceSha256",
      "publisherKeyId",
      "vault",
      "outputDirectory",
      "confirmation",
    ],
    "request",
  );
  if (request.confirmation !== PRODUCTION_API_IMAGE_PROVENANCE_CONFIRMATION) {
    fail(
      "PRODUCTION_API_PROVENANCE_DARK",
      "The exact attended provenance confirmation is required.",
    );
  }
  const publicationReceipt = absoluteOutsideRepository(
    request.publicationReceipt,
    "publicationReceipt",
  );
  const vault = absoluteOutsideRepository(request.vault, "vault");
  const apiOciProvenance = absoluteOutsideRepository(
    request.apiOciProvenance,
    "apiOciProvenance",
  );
  const outputDirectory = absoluteOutsideRepository(
    request.outputDirectory,
    "outputDirectory",
  );
  if (!OUTPUT_BASENAME.test(path.basename(outputDirectory))) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "outputDirectory basename is invalid.",
    );
  }
  if (
    publicationReceipt === apiOciProvenance ||
    isWithin(vault, publicationReceipt) ||
    isWithin(vault, apiOciProvenance) ||
    isWithin(vault, outputDirectory) ||
    isWithin(outputDirectory, vault)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "Publication inputs, outputs and the custody vault must remain separated.",
    );
  }
  const apiImage = exactText(request.apiImage, "apiImage").toLowerCase();
  if (!API_IMAGE.test(apiImage)) {
    fail(
      "PRODUCTION_API_PROVENANCE_BINDING_INVALID",
      "apiImage is not the immutable production API repository.",
    );
  }
  const publisherKeyId = exactText(request.publisherKeyId, "publisherKeyId");
  if (!KEY_ID.test(publisherKeyId)) {
    fail(
      "PRODUCTION_API_PROVENANCE_BINDING_INVALID",
      "publisherKeyId is invalid.",
    );
  }
  return Object.freeze({
    publicationMode: "github-actions",
    publicationReceipt,
    publicationReceiptSha256: exactDigest(
      request.publicationReceiptSha256,
      "publicationReceiptSha256",
    ),
    apiOciProvenance,
    sourceSha: exactSha(request.sourceSha, "sourceSha"),
    completeRunId: exactPositiveInteger(request.completeRunId, "completeRunId"),
    completeRunAttempt: exactPositiveInteger(
      request.completeRunAttempt,
      "completeRunAttempt",
    ),
    apiImage,
    apiOciProvenanceSha256: exactDigest(
      request.apiOciProvenanceSha256,
      "apiOciProvenanceSha256",
    ),
    publisherKeyId,
    vault,
    outputDirectory,
  });
}

function parseManualRequest(rawRequest) {
  const request = exactKeys(
    rawRequest,
    [
      "publicationMode",
      "manualCompleteReceipt",
      "manualCompleteReceiptSha256",
      "manualCustody",
      "manualCustodySha256",
      "manualCustodyVerification",
      "manualCustodyVerificationSha256",
      "manualPackageMetadata",
      "manualPackageMetadataSha256",
      "manualRegistrySummary",
      "manualRegistrySummarySha256",
      "manualImageApi",
      "manualImageApiSha256",
      "manualImageControlPlane",
      "manualImageControlPlaneSha256",
      "manualImageHostOperator",
      "manualImageHostOperatorSha256",
      "manualImageWeb",
      "manualImageWebSha256",
      "manualRegistryResultApi",
      "manualRegistryResultApiSha256",
      "manualRegistryResultControlPlane",
      "manualRegistryResultControlPlaneSha256",
      "manualRegistryResultHostOperator",
      "manualRegistryResultHostOperatorSha256",
      "manualRegistryResultWeb",
      "manualRegistryResultWebSha256",
      "apiOciProvenance",
      "sourceSha",
      "apiImage",
      "apiOciProvenanceSha256",
      "publisherKeyId",
      "vault",
      "outputDirectory",
      "confirmation",
    ],
    "request",
  );
  if (
    request.publicationMode !== MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE ||
    request.confirmation !== PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_DARK",
      "The exact attended manual-offline provenance confirmation is required.",
    );
  }
  const publicationReceipt = absoluteOutsideRepository(
    request.manualCompleteReceipt,
    "manualCompleteReceipt",
  );
  const vault = absoluteOutsideRepository(request.vault, "vault");
  const apiOciProvenance = absoluteOutsideRepository(
    request.apiOciProvenance,
    "apiOciProvenance",
  );
  const outputDirectory = absoluteOutsideRepository(
    request.outputDirectory,
    "outputDirectory",
  );
  const manualEvidence = Object.freeze({
    custody: Object.freeze({
      path: absoluteOutsideRepository(request.manualCustody, "manualCustody"),
      sha256: exactDigest(request.manualCustodySha256, "manualCustodySha256"),
    }),
    custodyVerification: Object.freeze({
      path: absoluteOutsideRepository(
        request.manualCustodyVerification,
        "manualCustodyVerification",
      ),
      sha256: exactDigest(
        request.manualCustodyVerificationSha256,
        "manualCustodyVerificationSha256",
      ),
    }),
    packageMetadata: Object.freeze({
      path: absoluteOutsideRepository(
        request.manualPackageMetadata,
        "manualPackageMetadata",
      ),
      sha256: exactDigest(
        request.manualPackageMetadataSha256,
        "manualPackageMetadataSha256",
      ),
    }),
    registrySummary: Object.freeze({
      path: absoluteOutsideRepository(
        request.manualRegistrySummary,
        "manualRegistrySummary",
      ),
      sha256: exactDigest(
        request.manualRegistrySummarySha256,
        "manualRegistrySummarySha256",
      ),
    }),
    images: Object.freeze({
      api: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualImageApi,
          "manualImageApi",
        ),
        sha256: exactDigest(
          request.manualImageApiSha256,
          "manualImageApiSha256",
        ),
      }),
      controlPlane: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualImageControlPlane,
          "manualImageControlPlane",
        ),
        sha256: exactDigest(
          request.manualImageControlPlaneSha256,
          "manualImageControlPlaneSha256",
        ),
      }),
      hostOperator: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualImageHostOperator,
          "manualImageHostOperator",
        ),
        sha256: exactDigest(
          request.manualImageHostOperatorSha256,
          "manualImageHostOperatorSha256",
        ),
      }),
      web: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualImageWeb,
          "manualImageWeb",
        ),
        sha256: exactDigest(
          request.manualImageWebSha256,
          "manualImageWebSha256",
        ),
      }),
    }),
    registryResults: Object.freeze({
      api: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualRegistryResultApi,
          "manualRegistryResultApi",
        ),
        sha256: exactDigest(
          request.manualRegistryResultApiSha256,
          "manualRegistryResultApiSha256",
        ),
      }),
      controlPlane: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualRegistryResultControlPlane,
          "manualRegistryResultControlPlane",
        ),
        sha256: exactDigest(
          request.manualRegistryResultControlPlaneSha256,
          "manualRegistryResultControlPlaneSha256",
        ),
      }),
      hostOperator: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualRegistryResultHostOperator,
          "manualRegistryResultHostOperator",
        ),
        sha256: exactDigest(
          request.manualRegistryResultHostOperatorSha256,
          "manualRegistryResultHostOperatorSha256",
        ),
      }),
      web: Object.freeze({
        path: absoluteOutsideRepository(
          request.manualRegistryResultWeb,
          "manualRegistryResultWeb",
        ),
        sha256: exactDigest(
          request.manualRegistryResultWebSha256,
          "manualRegistryResultWebSha256",
        ),
      }),
    }),
  });
  if (!OUTPUT_BASENAME.test(path.basename(outputDirectory))) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "outputDirectory basename is invalid.",
    );
  }
  if (
    publicationReceipt === apiOciProvenance ||
    isWithin(vault, publicationReceipt) ||
    isWithin(vault, apiOciProvenance) ||
    isWithin(vault, outputDirectory) ||
    isWithin(outputDirectory, vault)
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "Manual inputs, outputs and the custody vault must remain separated.",
    );
  }
  const manualEvidencePaths = [
    manualEvidence.custody.path,
    manualEvidence.custodyVerification.path,
    manualEvidence.packageMetadata.path,
    manualEvidence.registrySummary.path,
    ...Object.values(manualEvidence.images).map((entry) => entry.path),
    ...Object.values(manualEvidence.registryResults).map((entry) => entry.path),
  ];
  const separatedPaths = [
    publicationReceipt,
    apiOciProvenance,
    ...manualEvidencePaths,
  ];
  if (
    new Set(separatedPaths).size !== separatedPaths.length ||
    manualEvidencePaths.some(
      (entry) =>
        isWithin(vault, entry) ||
        isWithin(outputDirectory, entry) ||
        isWithin(entry, vault) ||
        isWithin(entry, outputDirectory),
    )
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "Manual evidence inputs must be mutually distinct and separated from custody and output paths.",
    );
  }
  const apiImage = exactText(request.apiImage, "apiImage").toLowerCase();
  if (!API_IMAGE.test(apiImage)) {
    fail(
      "PRODUCTION_API_PROVENANCE_BINDING_INVALID",
      "apiImage is not the immutable production API repository.",
    );
  }
  const publisherKeyId = exactText(request.publisherKeyId, "publisherKeyId");
  if (!KEY_ID.test(publisherKeyId)) {
    fail(
      "PRODUCTION_API_PROVENANCE_BINDING_INVALID",
      "publisherKeyId is invalid.",
    );
  }
  return Object.freeze({
    publicationMode: MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
    publicationReceipt,
    publicationReceiptSha256: exactDigest(
      request.manualCompleteReceiptSha256,
      "manualCompleteReceiptSha256",
    ),
    apiOciProvenance,
    sourceSha: exactSha(request.sourceSha, "sourceSha"),
    apiImage,
    apiOciProvenanceSha256: exactDigest(
      request.apiOciProvenanceSha256,
      "apiOciProvenanceSha256",
    ),
    publisherKeyId,
    vault,
    outputDirectory,
    manualEvidence,
  });
}

function publisherAuthority(keys, expectedPin, keyId) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    fail(
      "PRODUCTION_API_PROVENANCE_KEY_INVALID",
      "The publisher trust root is unavailable.",
    );
  }
  const keyNames = Object.keys(keys);
  if (keyNames.length !== 1 || keyNames[0] !== keyId) {
    fail(
      "PRODUCTION_API_PROVENANCE_KEY_INVALID",
      "The exact single publisher trust root is not selected.",
    );
  }
  let key;
  try {
    key = createPublicKey(keys[keyId]);
  } catch (error) {
    fail(
      "PRODUCTION_API_PROVENANCE_KEY_INVALID",
      "The pinned publisher public key cannot be parsed.",
      error,
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail(
      "PRODUCTION_API_PROVENANCE_KEY_INVALID",
      "The publisher trust root must be Ed25519.",
    );
  }
  const actualPin = sha256(key.export({ type: "spki", format: "der" }));
  requireEqual(actualPin, expectedPin, "publisherPublicKeySha256");
  return Object.freeze({ key, sha256: actualPin });
}

function reviewedImageSetSha256FromPublication(publication, request) {
  return request.publicationMode === MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE
    ? publication.receipt.reviewedImageSetSha256
    : publication.receipt.chain.reviewedImageSetSha256;
}

function buildProvenance(publication, request) {
  const receipt = publication.receipt;
  const api = receipt.images.api;
  requireEqual(receipt.source.sha, request.sourceSha, "receipt.source.sha");
  if (request.publicationMode === "github-actions") {
    requireEqual(
      receipt.caller.runId,
      request.completeRunId,
      "receipt.caller.runId",
    );
    requireEqual(
      receipt.caller.runAttempt,
      request.completeRunAttempt,
      "receipt.caller.runAttempt",
    );
  }
  requireEqual(api.image, request.apiImage, "receipt.images.api.image");
  requireEqual(
    api.digest,
    `sha256:${request.apiImage.split("@sha256:")[1]}`,
    "receipt.images.api.digest",
  );
  requireEqual(
    api.provenance.sha256,
    request.apiOciProvenanceSha256,
    "receipt.images.api.provenance.sha256",
  );
  requireEqual(
    api.build.imageProfile,
    "production",
    "receipt.images.api.build.imageProfile",
  );
  requireEqual(
    api.build.mutatingEntrypointsPresent,
    false,
    "receipt.images.api.build.mutatingEntrypointsPresent",
  );
  const value = Object.freeze({
    schemaVersion: IMAGE_PROVENANCE_SCHEMA,
    keyId: request.publisherKeyId,
    subjectImage: api.image,
    subjectDigest: api.digest,
    sourceSha: receipt.source.sha,
    publicationReceiptSha256: request.publicationReceiptSha256,
    reviewedImageSetSha256: reviewedImageSetSha256FromPublication(
      publication,
      request,
    ),
    subjectRunnableManifestDigest: api.runnableManifestDigest,
    ociProvenanceSha256: api.provenance.sha256,
    buildProfile: api.build.imageProfile,
    mutatingEntrypointsPresent: api.build.mutatingEntrypointsPresent,
  });
  assertSecretFree(value, "productionApiImageProvenance");
  return Object.freeze({ value, canonical: canonicalJson(value) });
}

function buildProductionReceipt({
  publication,
  request,
  provenanceCanonical,
  signature,
  publisherPublicKeySha256,
}) {
  const api = publication.receipt.images.api;
  const output = Object.freeze({
    keyId: request.publisherKeyId,
    publisherPublicKeySha256,
    provenanceSha256: sha256(provenanceCanonical),
    signatureSha256: sha256(signature),
    provenanceFile: PRODUCTION_API_IMAGE_PROVENANCE_FILES.provenance,
    signatureFile: PRODUCTION_API_IMAGE_PROVENANCE_FILES.signature,
  });
  const policy = Object.freeze({
    additionalRegistryWritePerformed: false,
    productionTargetsTouched: false,
    deploymentAuthorized: false,
    migrationAuthorized: false,
    applicationStartAuthorized: false,
    privateMaterialPrinted: false,
    persistenceMode: "exclusive-directory-hardlink-fsync-readback",
  });
  if (request.publicationMode === MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE) {
    const value = Object.freeze({
      schemaVersion: PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_RECEIPT_SCHEMA,
      kind: PRODUCTION_API_IMAGE_PROVENANCE_MANUAL_RECEIPT_KIND,
      publication: Object.freeze({
        mode: MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
        receiptSha256: publication.sha256,
        sourceSha: publication.receipt.source.sha,
        manualCustodyReceiptSha256: publication.receipt.custody.receiptSha256,
        manualCustodyVerificationSha256:
          publication.receipt.custody.verificationSha256,
        registryPublicationSha256: publication.receipt.registry.sha256,
        packageMetadataObservedAt:
          publication.receipt.packageMetadata.observedAt,
        reviewedImageSetSha256: publication.receipt.reviewedImageSetSha256,
        apiImage: api.image,
        apiDigest: api.digest,
        apiRunnableManifestDigest: api.runnableManifestDigest,
        apiConfigDigest: api.configDigest,
        apiOciProvenanceSha256: api.provenance.sha256,
        apiRegistryEvidenceSha256: api.registryEvidenceSha256,
      }),
      rawEvidence: Object.freeze({
        custodySha256: request.manualEvidence.custody.sha256,
        custodyVerificationSha256:
          request.manualEvidence.custodyVerification.sha256,
        packageMetadataSha256: request.manualEvidence.packageMetadata.sha256,
        registrySummarySha256: request.manualEvidence.registrySummary.sha256,
        images: Object.freeze(
          Object.fromEntries(
            Object.entries(request.manualEvidence.images).map(
              ([key, entry]) => [key, entry.sha256],
            ),
          ),
        ),
        registryResults: Object.freeze(
          Object.fromEntries(
            Object.entries(request.manualEvidence.registryResults).map(
              ([key, entry]) => [key, entry.sha256],
            ),
          ),
        ),
      }),
      output,
      policy,
    });
    assertSecretFree(
      value,
      "productionApiImageProvenanceManualProductionReceipt",
    );
    return Object.freeze({ value, canonical: canonicalJson(value) });
  }
  const value = Object.freeze({
    schemaVersion: PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_SCHEMA,
    kind: PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_KIND,
    publication: Object.freeze({
      receiptSha256: publication.sha256,
      sourceSha: publication.receipt.source.sha,
      completeRunId: publication.receipt.caller.runId,
      completeRunAttempt: publication.receipt.caller.runAttempt,
      reviewedImageSetSha256: publication.receipt.chain.reviewedImageSetSha256,
      apiImage: api.image,
      apiDigest: api.digest,
      apiRunnableManifestDigest: api.runnableManifestDigest,
      apiConfigDigest: api.configDigest,
      apiOciProvenanceSha256: api.provenance.sha256,
      apiRegistryEvidenceSha256: api.registryEvidenceSha256,
    }),
    output,
    policy,
  });
  assertSecretFree(value, "productionApiImageProvenanceProductionReceipt");
  return Object.freeze({ value, canonical: canonicalJson(value) });
}

async function cleanupOwnedDirectory(directory, directoryState, ownedFiles) {
  if (!directoryState) return;
  let current;
  try {
    current = await lstat(directory, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameNode(current, directoryState)
  ) {
    return;
  }
  for (const [file, state] of ownedFiles) {
    await unlinkOwned(file, state, false);
  }
  await rmdirOwnedIfEmpty(directory, directoryState, false);
}

function assertRealPathSeparation({
  repository,
  vault,
  outputDirectory,
  inputPaths,
}) {
  if (
    !Array.isArray(inputPaths) ||
    inputPaths.length < 2 ||
    new Set(inputPaths).size !== inputPaths.length
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "Resolved evidence inputs must be mutually distinct.",
    );
  }
  if (
    isWithin(repository, vault) ||
    isWithin(repository, outputDirectory) ||
    isWithin(vault, outputDirectory) ||
    isWithin(outputDirectory, vault) ||
    inputPaths.some(
      (entry) =>
        isWithin(repository, entry) ||
        isWithin(vault, entry) ||
        isWithin(outputDirectory, entry),
    )
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_PATH_INVALID",
      "Resolved repository, custody, input and output paths are not separated.",
    );
  }
}

async function runProducerCore(
  rawRequest,
  dependencies,
  productionAuthoritySealed = false,
) {
  const request = parseRequest(rawRequest);
  const {
    trustedPublisherKeys,
    expectedPublisherPublicKeySha256,
    signWithCustody,
    clock = Date.now,
    testHooks = Object.freeze({}),
  } = dependencies;
  if (typeof signWithCustody !== "function") {
    fail(
      "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
      "The attended custody signer is unavailable.",
    );
  }
  if (typeof clock !== "function") {
    fail(
      "PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID",
      "The sign-time clock is unavailable.",
    );
  }
  const authority = publisherAuthority(
    trustedPublisherKeys,
    exactDigest(
      expectedPublisherPublicKeySha256,
      "expectedPublisherPublicKeySha256",
    ),
    request.publisherKeyId,
  );
  const outputParent = path.dirname(request.outputDirectory);
  const repositoryInfo = await inspectStableDirectory(
    REPOSITORY_ROOT,
    "repository",
  );
  const vaultInfo = await inspectStableDirectory(request.vault, "vault");
  const outputParentInfo = await inspectStableDirectory(
    outputParent,
    "outputDirectory parent",
  );
  await assertMissing(request.outputDirectory, "outputDirectory");

  const publicationInput = await readStableSingleLinkFile(
    request.publicationReceipt,
    MAX_PUBLICATION_RECEIPT_BYTES,
    "publicationReceipt",
    false,
    testHooks.beforeInputRead,
  );
  const publicationRaw = decodeUtf8(
    publicationInput.bytes,
    "publicationReceipt",
  );
  const publication =
    request.publicationMode === MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE
      ? parseManualProductionImageCompleteReceipt(publicationRaw, {
          expectedSourceSha: request.sourceSha,
          expectedReceiptSha256: request.publicationReceiptSha256,
        })
      : parseProductionImagePublicationReceipt(publicationRaw, {
          expectedStage: "complete",
          expectedSourceSha: request.sourceSha,
          expectedRunId: request.completeRunId,
          expectedRunAttempt: request.completeRunAttempt,
          expectedReceiptSha256: request.publicationReceiptSha256,
        });
  const manualEvidence =
    request.publicationMode === MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE
      ? await readPinnedManualEvidence(request)
      : undefined;
  const apiOciProvenanceInput = await readStableSingleLinkFile(
    request.apiOciProvenance,
    MAX_API_OCI_PROVENANCE_BYTES,
    "apiOciProvenance",
    false,
    testHooks.beforeInputRead,
  );
  verifyApiOciProvenanceBytes(
    apiOciProvenanceInput.bytes,
    publication,
    request,
  );
  const resolvedOutputDirectory = path.join(
    outputParentInfo.path,
    path.basename(request.outputDirectory),
  );
  assertRealPathSeparation({
    repository: repositoryInfo.path,
    vault: vaultInfo.path,
    outputDirectory: resolvedOutputDirectory,
    inputPaths: [
      publicationInput.path,
      apiOciProvenanceInput.path,
      ...(manualEvidence?.inputs.map((entry) => entry.path) ?? []),
    ],
  });
  if (manualEvidence) {
    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      fail(
        "PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID",
        "The sign-time clock returned an invalid value.",
      );
    }
    validateManualProductionImageCompleteReceiptAgainstRawEvidence(
      publication.receipt,
      {
        custody: manualEvidence.custody.value,
        custodySha256: manualEvidence.custody.sha256,
        custodyVerification: manualEvidence.custodyVerification.value,
        custodyVerificationSha256: manualEvidence.custodyVerification.sha256,
        packageMetadata: manualEvidence.packageMetadata.value,
        packageMetadataSha256: manualEvidence.packageMetadata.sha256,
        registrySummary: manualEvidence.registrySummary.value,
        registrySummarySha256: manualEvidence.registrySummary.sha256,
        images: Object.fromEntries(
          Object.entries(manualEvidence.images).map(([key, entry]) => [
            key,
            entry.value,
          ]),
        ),
        imageSha256: Object.fromEntries(
          Object.entries(manualEvidence.images).map(([key, entry]) => [
            key,
            entry.sha256,
          ]),
        ),
        registryResults: Object.fromEntries(
          Object.entries(manualEvidence.registryResults).map(([key, entry]) => [
            key,
            entry.value,
          ]),
        ),
        registryResultSha256: Object.fromEntries(
          Object.entries(manualEvidence.registryResults).map(([key, entry]) => [
            key,
            entry.sha256,
          ]),
        ),
        nowMs,
      },
    );
  }
  const provenance = buildProvenance(publication, request);

  const stageBasename = `.${path.basename(request.outputDirectory)}.${process.pid}.${randomBytes(12).toString("hex")}.stage`;
  const stageDirectory = path.join(outputParent, stageBasename);
  const signingInput = path.join(
    stageDirectory,
    ".publisher-signing-input.json",
  );
  const signingOutput = path.join(stageDirectory, ".publisher-signature.raw");
  const finalNames = Object.values(PRODUCTION_API_IMAGE_PROVENANCE_FILES);
  const stageOwnedFiles = new Map();
  const finalOwnedFiles = new Map();
  let stageState;
  let finalState;
  try {
    await assertDirectoryIdentity(
      outputParent,
      outputParentInfo.state,
      "outputDirectory parent",
    );
    await mkdir(stageDirectory, { mode: 0o700 });
    stageState = await noReparseState(stageDirectory, "stageDirectory");
    if (!stageState.isDirectory() || stageState.isSymbolicLink()) {
      fail(
        "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
        "The producer-owned staging path is not a stable directory.",
      );
    }
    stageOwnedFiles.set(
      signingInput,
      await writeExclusiveSynced(signingInput, provenance.canonical),
    );
    await signWithCustody({
      vault: request.vault,
      input: signingInput,
      output: signingOutput,
    });
    await assertDirectoryIdentity(stageDirectory, stageState, "stageDirectory");
    let signerOutputState;
    try {
      signerOutputState = await lstat(signingOutput, { bigint: true });
    } catch (error) {
      fail(
        "PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID",
        "The custody signer did not create its designated output.",
        error,
      );
    }
    stageOwnedFiles.set(signingOutput, signerOutputState);
    const signatureInput = await readStableSingleLinkFile(
      signingOutput,
      MAX_SIGNATURE_BYTES,
      "publisherSignature",
      true,
    );
    const signature = signatureInput.bytes;
    if (!sameNode(signerOutputState, signatureInput.state)) {
      fail(
        "PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID",
        "The custody signer output identity changed before validation.",
      );
    }
    if (signature.length !== MAX_SIGNATURE_BYTES) {
      fail(
        "PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID",
        "The detached publisher signature must be exactly 64 bytes.",
      );
    }
    if (
      !verifySignature(
        null,
        Buffer.from(provenance.canonical, "utf8"),
        authority.key,
        signature,
      )
    ) {
      fail(
        "PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID",
        "The detached publisher signature does not match the pinned key.",
      );
    }
    const hostVerificationInput = {
      canonical: provenance.canonical,
      signature,
      sourceSha: request.sourceSha,
      expectedApiImage: request.apiImage,
    };
    const verified = productionAuthoritySealed
      ? verifyProductionApiImageProvenanceArtifact(hostVerificationInput)
      : verifyProductionApiImageProvenanceArtifactWithTestAuthority(
          hostVerificationInput,
          { trustedImageProvenanceKeys: trustedPublisherKeys },
        );
    requireEqual(
      verified.sha256,
      sha256(provenance.canonical),
      "hostParser.provenanceSha256",
    );
    const productionReceipt = buildProductionReceipt({
      publication,
      request,
      provenanceCanonical: provenance.canonical,
      signature,
      publisherPublicKeySha256: authority.sha256,
    });

    await unlinkOwned(signingInput, stageOwnedFiles.get(signingInput));
    stageOwnedFiles.delete(signingInput);
    await unlinkOwned(signingOutput, stageOwnedFiles.get(signingOutput));
    stageOwnedFiles.delete(signingOutput);
    const expectedBytes = Object.freeze({
      [PRODUCTION_API_IMAGE_PROVENANCE_FILES.provenance]: Buffer.from(
        provenance.canonical,
        "utf8",
      ),
      [PRODUCTION_API_IMAGE_PROVENANCE_FILES.signature]: signature,
      [PRODUCTION_API_IMAGE_PROVENANCE_FILES.receipt]: Buffer.from(
        productionReceipt.canonical,
        "utf8",
      ),
    });
    for (const [name, bytes] of Object.entries(expectedBytes)) {
      await testHooks.beforeStageOutputWrite?.(name);
      const target = path.join(stageDirectory, name);
      stageOwnedFiles.set(target, await writeExclusiveSynced(target, bytes));
    }
    await syncDirectory(stageDirectory, stageState, "stageDirectory");

    await testHooks.beforeFinalDirectoryCreate?.();
    await assertDirectoryIdentity(
      outputParent,
      outputParentInfo.state,
      "outputDirectory parent",
    );
    await assertMissing(request.outputDirectory, "outputDirectory");
    try {
      await mkdir(request.outputDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(
          "PRODUCTION_API_PROVENANCE_OUTPUT_EXISTS",
          "outputDirectory appeared concurrently and will not be replaced.",
        );
      }
      throw error;
    }
    finalState = await noReparseState(
      request.outputDirectory,
      "outputDirectory",
    );
    if (!finalState.isDirectory() || finalState.isSymbolicLink()) {
      fail(
        "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
        "The producer-owned output path is not a stable directory.",
      );
    }
    const finalRealPath = path.resolve(await realpath(request.outputDirectory));
    requireEqual(
      finalRealPath,
      resolvedOutputDirectory,
      "outputDirectory.resolvedPath",
    );
    for (const name of finalNames) {
      await assertDirectoryIdentity(
        stageDirectory,
        stageState,
        "stageDirectory",
      );
      await assertDirectoryIdentity(
        request.outputDirectory,
        finalState,
        "outputDirectory",
      );
      const source = path.join(stageDirectory, name);
      const destination = path.join(request.outputDirectory, name);
      const sourceState = await lstat(source, { bigint: true });
      if (!sameNode(sourceState, stageOwnedFiles.get(source))) {
        fail(
          "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
          "A staged output changed before publication.",
        );
      }
      await link(source, destination);
      finalOwnedFiles.set(destination, sourceState);
      const destinationState = await lstat(destination, { bigint: true });
      if (!sameNode(destinationState, sourceState)) {
        fail(
          "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
          "A published hard link does not bind the staged inode.",
        );
      }
    }
    await syncDirectory(request.outputDirectory, finalState, "outputDirectory");
    for (const name of finalNames) {
      const source = path.join(stageDirectory, name);
      await unlinkOwned(source, stageOwnedFiles.get(source));
      stageOwnedFiles.delete(source);
    }
    await rmdirOwnedIfEmpty(stageDirectory, stageState);
    stageState = undefined;

    await syncDirectory(request.outputDirectory, finalState, "outputDirectory");
    await syncDirectory(
      outputParent,
      outputParentInfo.state,
      "outputDirectory parent",
    );
    await testHooks.beforeFinalValidation?.({
      outputDirectory: request.outputDirectory,
      files: PRODUCTION_API_IMAGE_PROVENANCE_FILES,
    });
    await assertDirectoryIdentity(
      request.outputDirectory,
      finalState,
      "outputDirectory",
    );
    for (const [name, expected] of Object.entries(expectedBytes)) {
      const readback = await readStableSingleLinkFile(
        path.join(request.outputDirectory, name),
        MAX_PUBLICATION_RECEIPT_BYTES,
        `output.${name}`,
      );
      if (
        !sameNode(
          readback.state,
          finalOwnedFiles.get(path.join(request.outputDirectory, name)),
        ) ||
        !readback.bytes.equals(expected)
      ) {
        fail(
          "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
          "Durable output read-back differs from the exact verified bytes.",
        );
      }
    }
    await assertDirectoryIdentity(
      request.outputDirectory,
      finalState,
      "outputDirectory",
    );
    await assertDirectoryIdentity(
      outputParent,
      outputParentInfo.state,
      "outputDirectory parent",
    );

    return Object.freeze({
      sourceSha: request.sourceSha,
      apiImage: request.apiImage,
      publicationReceiptSha256: publication.sha256,
      apiOciProvenanceSha256: request.apiOciProvenanceSha256,
      provenanceSha256: sha256(provenance.canonical),
      signatureSha256: sha256(signature),
      productionReceiptSha256: sha256(productionReceipt.canonical),
      outputDirectory: request.outputDirectory,
      files: PRODUCTION_API_IMAGE_PROVENANCE_FILES,
      productionTargetsTouched: false,
      privateMaterialPrinted: false,
    });
  } catch (error) {
    let cleanupError;
    try {
      await cleanupOwnedDirectory(stageDirectory, stageState, stageOwnedFiles);
      await cleanupOwnedDirectory(
        request.outputDirectory,
        finalState,
        finalOwnedFiles,
      );
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      fail(
        "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
        "Producer-owned partial output could not be cleaned up safely.",
        cleanupError,
      );
    }
    if (error instanceof ProductionApiImageProvenanceError) throw error;
    fail(
      "PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED",
      "The provenance output set could not be published safely.",
      error,
    );
  }
}

export async function runProductionApiImageProvenanceProducer(rawRequest) {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID",
      "Production publisher authority cannot be injected.",
    );
  }
  if (assertProductionPublisherProvenanceTrustRootBinding() !== true) {
    fail(
      "PRODUCTION_API_PROVENANCE_KEY_INVALID",
      "The publisher trust-root binding is invalid.",
    );
  }
  return runProducerCore(
    rawRequest,
    {
      trustedPublisherKeys: PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
      expectedPublisherPublicKeySha256:
        PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
      signWithCustody: runPublisherCustodySignature,
    },
    true,
  );
}

export async function runProductionApiImageProvenanceProducerWithTestAuthority(
  rawRequest,
  dependencies,
) {
  const dependencyKeys = Object.keys(dependencies ?? {}).sort();
  const expectedDependencyKeys = [
    "trustedPublisherKeys",
    "expectedPublisherPublicKeySha256",
    "signWithCustody",
    ...(Object.hasOwn(dependencies ?? {}, "clock") ? ["clock"] : []),
    ...(Object.hasOwn(dependencies ?? {}, "testHooks") ? ["testHooks"] : []),
  ];
  const authority = exactKeys(
    dependencies,
    expectedDependencyKeys,
    "testAuthority",
  );
  if (
    JSON.stringify(dependencyKeys) !==
    JSON.stringify([...expectedDependencyKeys].sort())
  ) {
    fail(
      "PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID",
      "The test authority contains an unreviewed dependency.",
    );
  }
  const testHooks = authority.testHooks ?? {};
  const allowedHooks = new Set([
    "beforeInputRead",
    "beforeStageOutputWrite",
    "beforeFinalDirectoryCreate",
    "beforeFinalValidation",
  ]);
  for (const [name, hook] of Object.entries(testHooks)) {
    if (!allowedHooks.has(name) || typeof hook !== "function") {
      fail(
        "PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID",
        "The test authority contains an invalid persistence hook.",
      );
    }
  }
  return runProducerCore(rawRequest, {
    ...authority,
    testHooks: Object.freeze({ ...testHooks }),
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const token = rest[index];
    const value = rest[index + 1];
    if (!token?.startsWith("--") || value == null || value.startsWith("--")) {
      fail(
        "PRODUCTION_API_PROVENANCE_REQUEST_INVALID",
        "Every CLI option must have one explicit value.",
      );
    }
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) {
      fail(
        "PRODUCTION_API_PROVENANCE_REQUEST_INVALID",
        "Duplicate CLI options are forbidden.",
      );
    }
    options[name] = value;
  }
  if (command === "produce-manual-offline") {
    const mapped = exactKeys(
      options,
      [
        "manual-complete-receipt",
        "manual-complete-receipt-sha256",
        "manual-custody",
        "manual-custody-sha256",
        "manual-custody-verification",
        "manual-custody-verification-sha256",
        "manual-package-metadata",
        "manual-package-metadata-sha256",
        "manual-registry-summary",
        "manual-registry-summary-sha256",
        "manual-image-api",
        "manual-image-api-sha256",
        "manual-image-control-plane",
        "manual-image-control-plane-sha256",
        "manual-image-host-operator",
        "manual-image-host-operator-sha256",
        "manual-image-web",
        "manual-image-web-sha256",
        "manual-registry-result-api",
        "manual-registry-result-api-sha256",
        "manual-registry-result-control-plane",
        "manual-registry-result-control-plane-sha256",
        "manual-registry-result-host-operator",
        "manual-registry-result-host-operator-sha256",
        "manual-registry-result-web",
        "manual-registry-result-web-sha256",
        "api-oci-provenance",
        "source-sha",
        "api-image",
        "api-oci-provenance-sha256",
        "publisher-key-id",
        "vault",
        "output-directory",
        "confirm",
      ],
      "options",
    );
    return {
      publicationMode: MANUAL_PRODUCTION_IMAGE_COMPLETE_MODE,
      manualCompleteReceipt: mapped["manual-complete-receipt"],
      manualCompleteReceiptSha256: mapped["manual-complete-receipt-sha256"],
      manualCustody: mapped["manual-custody"],
      manualCustodySha256: mapped["manual-custody-sha256"],
      manualCustodyVerification: mapped["manual-custody-verification"],
      manualCustodyVerificationSha256:
        mapped["manual-custody-verification-sha256"],
      manualPackageMetadata: mapped["manual-package-metadata"],
      manualPackageMetadataSha256: mapped["manual-package-metadata-sha256"],
      manualRegistrySummary: mapped["manual-registry-summary"],
      manualRegistrySummarySha256: mapped["manual-registry-summary-sha256"],
      manualImageApi: mapped["manual-image-api"],
      manualImageApiSha256: mapped["manual-image-api-sha256"],
      manualImageControlPlane: mapped["manual-image-control-plane"],
      manualImageControlPlaneSha256:
        mapped["manual-image-control-plane-sha256"],
      manualImageHostOperator: mapped["manual-image-host-operator"],
      manualImageHostOperatorSha256:
        mapped["manual-image-host-operator-sha256"],
      manualImageWeb: mapped["manual-image-web"],
      manualImageWebSha256: mapped["manual-image-web-sha256"],
      manualRegistryResultApi: mapped["manual-registry-result-api"],
      manualRegistryResultApiSha256:
        mapped["manual-registry-result-api-sha256"],
      manualRegistryResultControlPlane:
        mapped["manual-registry-result-control-plane"],
      manualRegistryResultControlPlaneSha256:
        mapped["manual-registry-result-control-plane-sha256"],
      manualRegistryResultHostOperator:
        mapped["manual-registry-result-host-operator"],
      manualRegistryResultHostOperatorSha256:
        mapped["manual-registry-result-host-operator-sha256"],
      manualRegistryResultWeb: mapped["manual-registry-result-web"],
      manualRegistryResultWebSha256:
        mapped["manual-registry-result-web-sha256"],
      apiOciProvenance: mapped["api-oci-provenance"],
      sourceSha: mapped["source-sha"],
      apiImage: mapped["api-image"],
      apiOciProvenanceSha256: mapped["api-oci-provenance-sha256"],
      publisherKeyId: mapped["publisher-key-id"],
      vault: mapped.vault,
      outputDirectory: mapped["output-directory"],
      confirmation: mapped.confirm,
    };
  }
  if (command !== "produce") {
    fail(
      "PRODUCTION_API_PROVENANCE_DARK",
      "Only the exact reviewed producer commands are available.",
    );
  }
  const mapped = exactKeys(
    options,
    [
      "publication-receipt",
      "publication-receipt-sha256",
      "api-oci-provenance",
      "source-sha",
      "complete-run-id",
      "complete-run-attempt",
      "api-image",
      "api-oci-provenance-sha256",
      "publisher-key-id",
      "vault",
      "output-directory",
      "confirm",
    ],
    "options",
  );
  return {
    publicationReceipt: mapped["publication-receipt"],
    publicationReceiptSha256: mapped["publication-receipt-sha256"],
    apiOciProvenance: mapped["api-oci-provenance"],
    sourceSha: mapped["source-sha"],
    completeRunId: mapped["complete-run-id"],
    completeRunAttempt: mapped["complete-run-attempt"],
    apiImage: mapped["api-image"],
    apiOciProvenanceSha256: mapped["api-oci-provenance-sha256"],
    publisherKeyId: mapped["publisher-key-id"],
    vault: mapped.vault,
    outputDirectory: mapped["output-directory"],
    confirmation: mapped.confirm,
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/production-evidence/production-api-image-provenance.mjs produce --publication-receipt ABSOLUTE_PATH --publication-receipt-sha256 sha256:... --api-oci-provenance ABSOLUTE_PATH --source-sha 40_HEX --complete-run-id INTEGER --complete-run-attempt INTEGER --api-image ghcr.io/modvolt/site-logbook-production-api@sha256:... --api-oci-provenance-sha256 sha256:... --publisher-key-id ed25519:... --vault ABSOLUTE_PATH --output-directory NEW_ABSOLUTE_PATH --confirm PRODUCE_AND_SIGN_EXACT_SITE_LOGBOOK_PRODUCTION_API_IMAGE_PROVENANCE",
    "  node scripts/production-evidence/production-api-image-provenance.mjs produce-manual-offline [EXACT_OPTIONS_BELOW]",
    "    --manual-complete-receipt ABSOLUTE_PATH --manual-complete-receipt-sha256 sha256:...",
    "    --manual-custody ABSOLUTE_PATH --manual-custody-sha256 sha256:... --manual-custody-verification ABSOLUTE_PATH --manual-custody-verification-sha256 sha256:...",
    "    --manual-package-metadata ABSOLUTE_PATH --manual-package-metadata-sha256 sha256:... --manual-registry-summary ABSOLUTE_PATH --manual-registry-summary-sha256 sha256:...",
    "    --manual-image-api ABSOLUTE_PATH --manual-image-api-sha256 sha256:... --manual-image-control-plane ABSOLUTE_PATH --manual-image-control-plane-sha256 sha256:...",
    "    --manual-image-host-operator ABSOLUTE_PATH --manual-image-host-operator-sha256 sha256:... --manual-image-web ABSOLUTE_PATH --manual-image-web-sha256 sha256:...",
    "    --manual-registry-result-api ABSOLUTE_PATH --manual-registry-result-api-sha256 sha256:... --manual-registry-result-control-plane ABSOLUTE_PATH --manual-registry-result-control-plane-sha256 sha256:...",
    "    --manual-registry-result-host-operator ABSOLUTE_PATH --manual-registry-result-host-operator-sha256 sha256:... --manual-registry-result-web ABSOLUTE_PATH --manual-registry-result-web-sha256 sha256:...",
    "    --api-oci-provenance ABSOLUTE_PATH --source-sha 40_HEX --api-image ghcr.io/modvolt/site-logbook-production-api@sha256:... --api-oci-provenance-sha256 sha256:...",
    "    --publisher-key-id ed25519:... --vault ABSOLUTE_PATH --output-directory NEW_ABSOLUTE_PATH --confirm PRODUCE_AND_SIGN_EXACT_SITE_LOGBOOK_MANUAL_OFFLINE_PRODUCTION_API_IMAGE_PROVENANCE",
    "",
    "The complete publication receipt digest and all image/source bindings must be independently reviewed.",
    "The command emits public digests only; private key material never enters argv, env or stdout.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runProductionApiImageProvenanceProducer(parseArgs(argv));
  process.stdout.write(
    [
      "produced=true",
      `sourceSha=${result.sourceSha}`,
      `apiImage=${result.apiImage}`,
      `publicationReceiptSha256=${result.publicationReceiptSha256}`,
      `apiOciProvenanceSha256=${result.apiOciProvenanceSha256}`,
      `provenanceSha256=${result.provenanceSha256}`,
      `signatureSha256=${result.signatureSha256}`,
      `productionReceiptSha256=${result.productionReceiptSha256}`,
      "productionTargetsTouched=false",
      "privateMaterialPrinted=false",
      "",
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof ProductionApiImageProvenanceError
        ? error.message
        : "PRODUCTION_API_PROVENANCE_FAILED: Unknown error";
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
