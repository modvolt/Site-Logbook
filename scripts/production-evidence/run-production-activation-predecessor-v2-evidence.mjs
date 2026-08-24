#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION,
  PRODUCTION_ACTIVATION_APPROVAL_SCHEMA,
  parseProductionActivationApprovalV2,
  verifyProductionActivationContractV2,
} from "../../artifacts/api-server/src/lib/production-activation-contract.ts";
import { canonicalProductionActivationJson } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import {
  OBSERVATION_REQUEST_SCHEMA,
  verifyProductionApiImageProvenanceArtifact,
  verifyProductionObservationExports,
} from "./host-attestation-contract.mjs";

export const PRODUCTION_ACTIVATION_PREDECESSOR_V2_DESCRIPTOR_SCHEMA =
  "site-logbook.production-activation-predecessor-v2-evidence-descriptor/v1";
export const PRODUCTION_ACTIVATION_PREDECESSOR_V2_ASSEMBLY_CONFIRMATION =
  PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION;
export const PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT =
  "activation-evidence-v2.json";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 64;
const MAX_AGE_MS = 10 * 60 * 1000;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
const NONCE = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._@/-]{2,127}$/;
const FORBIDDEN_KEY =
  /(?:password|secret|private.?key|access.?key|session|cookie|token|authorization|database.?url|mnemonic|passphrase)/i;
const PUBLIC_IDENTITY_OR_POLICY_KEYS = new Set([
  "adminSessionUser",
  "activeApplicationSessions",
  "sessionUser",
  "snapshotTokenSha256",
  "public.user_sessions",
  "public.work_session_billing_links",
  "public.work_session_breaks",
  "public.work_session_events",
  "public.work_sessions",
  "user_sessions",
  "work_session_billing_links",
  "work_session_breaks",
  "work_session_events",
  "work_sessions",
  "requiresExplicitCoolifySecretTransfer",
]);

const INPUT_KEYS = Object.freeze([
  "apiImageProvenance",
  "apiImageProvenanceSignature",
  "challenge",
  "coolifyObservation",
  "dockerObservation",
  "exact0096Backup",
  "migration0096To0107",
  "observationRequest",
  "postgresObservation",
  "runtimeDatabaseCredentialCutover",
]);

export class ProductionActivationPredecessorV2EvidenceError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionActivationPredecessorV2EvidenceError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ProductionActivationPredecessorV2EvidenceError(code, message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function exactObject(value, keys, field) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_SCHEMA_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return value;
}

function exactString(value, field, pattern) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value !== value.trim() ||
    (pattern && !pattern.test(value))
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_SCHEMA_INVALID",
      `${field} is invalid.`,
    );
  }
  return value;
}

function exactTimestamp(value, field) {
  const text = exactString(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_TIME_INVALID",
      `${field} must be canonical UTC.`,
    );
  }
  return Object.freeze({ text, millis });
}

function rawSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function prefixedSha256(bytes) {
  return `sha256:${rawSha256(bytes)}`;
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
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PRIVATE_MATERIAL",
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
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && !PUBLIC_IDENTITY_OR_POLICY_KEYS.has(key)) {
      fail(
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PRIVATE_MATERIAL",
        `${field}.${key} has a forbidden private-material field name.`,
      );
    }
    scanSecretFree(entry, `${field}.${key}`);
  }
}

function relativePath(value, field) {
  const exact = exactString(value, field);
  const normalized = path.normalize(exact);
  if (
    path.isAbsolute(exact) ||
    exact.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.parse(normalized).root
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
      `${field} must remain below the descriptor directory.`,
    );
  }
  return normalized;
}

function resolveBelow(base, relative, field) {
  const target = path.resolve(base, relativePath(relative, field));
  const relation = path.relative(base, target);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
      `${field} escapes the descriptor directory.`,
    );
  }
  return target;
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

async function readStableSingleLinkFile(file, maximumBytes, field) {
  let before;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_INPUT_INVALID",
      `${field} is unavailable.`,
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
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_INPUT_INVALID",
      `${field} must be one bounded regular single-link file.`,
    );
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW)
    ? fsConstants.O_NOFOLLOW
    : 0;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, opened)) {
      fail(
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_INPUT_CHANGED",
        `${field} changed before it was opened.`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(file, { bigint: true });
    if (
      bytes.length !== Number(opened.size) ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(after, pathAfter)
    ) {
      fail(
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_INPUT_CHANGED",
        `${field} changed during its bounded read.`,
      );
    }
    return Object.freeze({
      bytes,
      realPath: path.resolve(await realpath(file)),
    });
  } catch (error) {
    if (error instanceof ProductionActivationPredecessorV2EvidenceError) {
      throw error;
    }
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_INPUT_INVALID",
      `${field} could not be read safely.`,
      error,
    );
  } finally {
    await handle?.close();
  }
}

function parseCanonicalJson(bytes, field) {
  if (bytes.includes(0x0d)) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_CANONICAL_INVALID",
      `${field} must use LF bytes.`,
    );
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_CANONICAL_INVALID",
      `${field} must be UTF-8 JSON.`,
      error,
    );
  }
  if (
    !text.endsWith("\n") ||
    text.endsWith("\n\n") ||
    canonicalProductionActivationJson(value) !== text
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_CANONICAL_INVALID",
      `${field} must be sorted canonical JSON with one trailing LF.`,
    );
  }
  return Object.freeze({ bytes, text, value });
}

function parseArtifact(value, field) {
  const artifact = exactObject(value, ["kind", "payload", "sha256"], field);
  exactString(artifact.kind, `${field}.kind`, /^[a-z0-9][a-z0-9._-]{2,127}$/);
  exactString(artifact.sha256, `${field}.sha256`, RAW_SHA256);
  const canonical = canonicalProductionActivationJson(artifact.payload);
  if (rawSha256(Buffer.from(canonical, "utf8")) !== artifact.sha256) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_DIGEST_INVALID",
      `${field}.sha256 differs from its canonical payload.`,
    );
  }
  return artifact;
}

function wrapArtifact(kind, parsed) {
  return Object.freeze({
    kind,
    payload: parsed.value,
    sha256: rawSha256(parsed.bytes),
  });
}

function parseDescriptor(value) {
  const descriptor = exactObject(
    value,
    [
      "authorizesApplicationStart",
      "executionDefault",
      "inputs",
      "kind",
      "outputDirectory",
      "schemaVersion",
      "sourceSha",
    ],
    "descriptor",
  );
  const inputs = exactObject(
    descriptor.inputs,
    INPUT_KEYS,
    "descriptor.inputs",
  );
  if (
    descriptor.schemaVersion !==
      PRODUCTION_ACTIVATION_PREDECESSOR_V2_DESCRIPTOR_SCHEMA ||
    descriptor.kind !==
      "site-logbook-production-activation-predecessor-v2-evidence" ||
    descriptor.executionDefault !== "disabled" ||
    descriptor.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_DESCRIPTOR_INVALID",
      "descriptor must be exact and default-dark.",
    );
  }
  exactString(descriptor.sourceSha, "descriptor.sourceSha", SOURCE_SHA);
  relativePath(descriptor.outputDirectory, "descriptor.outputDirectory");
  for (const [key, valuePath] of Object.entries(inputs)) {
    relativePath(valuePath, `descriptor.inputs.${key}`);
  }
  return Object.freeze({
    ...descriptor,
    inputs: Object.freeze({ ...inputs }),
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (command !== "assemble" || rest.length % 2 !== 0) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_ARGUMENTS_INVALID",
      "the only command is assemble with exact option pairs.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !/^--[a-z][a-z-]*$/.test(String(flag)) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(options, flag.slice(2))
    ) {
      fail(
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_ARGUMENTS_INVALID",
        "options are invalid or duplicated.",
      );
    }
    options[flag.slice(2)] = value;
  }
  const expected = ["approved-at", "confirmation", "descriptor", "operator"];
  if (
    JSON.stringify(Object.keys(options).sort()) !==
      JSON.stringify(expected.sort()) ||
    options.confirmation !==
      PRODUCTION_ACTIVATION_PREDECESSOR_V2_ASSEMBLY_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_CONFIRMATION_REQUIRED",
      "the exact attended v2 approval confirmation is required.",
    );
  }
  exactTimestamp(options["approved-at"], "approved-at");
  exactString(options.operator, "operator", OPERATOR);
  return Object.freeze({ command, options: Object.freeze(options) });
}

async function assertRealDirectory(directory, field) {
  const state = await lstat(directory, { bigint: true });
  const resolved = path.resolve(await realpath(directory));
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    resolved !== path.resolve(directory)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
      `${field} must be one real directory.`,
    );
  }
  return resolved;
}

async function persistExclusive(outputDirectory, canonical) {
  const target = path.join(
    outputDirectory,
    PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT,
  );
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(canonical, "utf8");
    await handle.sync();
  } catch (error) {
    fail(
      error?.code === "EEXIST"
        ? "PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT_EXISTS"
        : "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PERSISTENCE_FAILED",
      "the canonical predecessor output was not exclusively persisted.",
      error,
    );
  } finally {
    await handle?.close();
  }
  const readback = await readStableSingleLinkFile(
    target,
    MAX_INPUT_BYTES,
    "output",
  );
  if (!readback.bytes.equals(Buffer.from(canonical, "utf8"))) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PERSISTENCE_FAILED",
      "durable output readback differs.",
    );
  }
  return target;
}

async function assertOutputAbsent(outputDirectory) {
  const target = path.join(
    outputDirectory,
    PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT,
  );
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PERSISTENCE_FAILED",
      "the fixed output path could not be inspected safely.",
      error,
    );
  }
  fail(
    "PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT_EXISTS",
    "the fixed predecessor output already exists and will not be replaced.",
  );
}

function requireSame(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_BINDING_INVALID",
      `${field} differs from the exact observed authority.`,
    );
  }
}

async function executeCore(argv, dependencies) {
  const { options } = parseCli(argv);
  if (!path.isAbsolute(options.descriptor)) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
      "descriptor must be an absolute path.",
    );
  }
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now <= 0) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_TIME_INVALID",
      "current time is invalid.",
    );
  }
  const approvedAt = exactTimestamp(options["approved-at"], "approved-at");
  if (approvedAt.millis > now || now - approvedAt.millis > MAX_AGE_MS) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_TIME_INVALID",
      "approval is future-dated or stale.",
    );
  }

  const descriptorFile = path.resolve(options.descriptor);
  const descriptorDirectory = await assertRealDirectory(
    path.dirname(descriptorFile),
    "descriptorDirectory",
  );
  const descriptorInput = await readStableSingleLinkFile(
    descriptorFile,
    MAX_INPUT_BYTES,
    "descriptor",
  );
  const descriptor = parseDescriptor(
    parseCanonicalJson(descriptorInput.bytes, "descriptor").value,
  );
  const outputDirectory = await assertRealDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.outputDirectory,
      "descriptor.outputDirectory",
    ),
    "outputDirectory",
  );
  await assertOutputAbsent(outputDirectory);

  const loaded = {};
  const realPaths = new Set([descriptorInput.realPath]);
  for (const key of INPUT_KEYS) {
    const input = await readStableSingleLinkFile(
      resolveBelow(
        descriptorDirectory,
        descriptor.inputs[key],
        `descriptor.inputs.${key}`,
      ),
      key === "apiImageProvenanceSignature"
        ? MAX_SIGNATURE_BYTES
        : key === "apiImageProvenance"
          ? MAX_PROVENANCE_BYTES
          : MAX_INPUT_BYTES,
      key,
    );
    if (realPaths.has(input.realPath)) {
      fail(
        "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
        "descriptor inputs must be distinct files.",
      );
    }
    realPaths.add(input.realPath);
    loaded[key] = input;
  }

  if (loaded.apiImageProvenanceSignature.bytes.length !== 64) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_SIGNATURE_INVALID",
      "API image provenance signature must be exactly 64 raw bytes.",
    );
  }

  const parsed = {};
  for (const key of INPUT_KEYS.filter(
    (entry) => entry !== "apiImageProvenanceSignature",
  )) {
    parsed[key] = parseCanonicalJson(loaded[key].bytes, key);
  }
  const challenge = exactObject(
    parsed.challenge.value,
    ["apiImage", "containerId", "kind", "nonce", "sourceSha"],
    "challenge",
  );
  if (challenge.kind !== "site-logbook-production-activation-challenge-v3") {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_BINDING_INVALID",
      "challenge must be the live v3 HOLD challenge.",
    );
  }
  exactString(challenge.sourceSha, "challenge.sourceSha", SOURCE_SHA);
  exactString(challenge.apiImage, "challenge.apiImage", IMAGE);
  exactString(challenge.containerId, "challenge.containerId", CONTAINER_ID);
  exactString(challenge.nonce, "challenge.nonce", NONCE);
  requireSame(challenge.sourceSha, descriptor.sourceSha, "challenge.sourceSha");

  const request = exactObject(
    parsed.observationRequest.value,
    [
      "composeProject",
      "databaseName",
      "databaseUser",
      "expectedApiImage",
      "expectedNetworkServices",
      "postgresService",
      "postgresVolumeDestination",
      "schemaFingerprintSha256",
      "schemaVersion",
      "sourceSha",
    ],
    "observationRequest",
  );
  if (
    request.schemaVersion !== OBSERVATION_REQUEST_SCHEMA ||
    request.databaseUser !== "site_logbook_runtime" ||
    request.postgresService !== "postgres" ||
    request.postgresVolumeDestination !== "/var/lib/postgresql/data" ||
    JSON.stringify(request.expectedNetworkServices) !==
      JSON.stringify(["api", "postgres", "web"])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_BINDING_INVALID",
      "observation request is not the exact runtime production topology.",
    );
  }
  exactString(
    request.databaseName,
    "observationRequest.databaseName",
    IDENTIFIER,
  );
  exactString(
    request.schemaFingerprintSha256,
    "observationRequest.schemaFingerprintSha256",
    SHA256,
  );
  requireSame(request.sourceSha, challenge.sourceSha, "request.sourceSha");
  requireSame(
    request.expectedApiImage,
    challenge.apiImage,
    "request.expectedApiImage",
  );

  const provenanceSignatureB64 =
    loaded.apiImageProvenanceSignature.bytes.toString("base64");
  const provenanceVerdict = dependencies.verifyProvenance({
    canonical: parsed.apiImageProvenance.text,
    signature: loaded.apiImageProvenanceSignature.bytes,
    sourceSha: challenge.sourceSha,
    expectedApiImage: challenge.apiImage,
  });
  requireSame(
    provenanceVerdict.sourceSha,
    challenge.sourceSha,
    "provenance.sourceSha",
  );
  requireSame(
    provenanceVerdict.subjectImage,
    challenge.apiImage,
    "provenance.subjectImage",
  );

  const observationVerdict = dependencies.verifyObservations({
    request,
    coolifyCanonical: parsed.coolifyObservation.text,
    dockerCanonical: parsed.dockerObservation.text,
    postgresCanonical: parsed.postgresObservation.text,
    activationIssuedAt: approvedAt.text,
  });
  requireSame(
    observationVerdict.sourceSha,
    challenge.sourceSha,
    "observations.sourceSha",
  );
  requireSame(
    observationVerdict.apiImage,
    challenge.apiImage,
    "observations.apiImage",
  );
  requireSame(
    observationVerdict.databaseUser,
    "site_logbook_runtime",
    "observations.databaseUser",
  );
  requireSame(
    observationVerdict.desiredConfigSha256,
    observationVerdict.deployedConfigSha256,
    "observations.desiredConfigSha256",
  );

  const exact0096Backup = exactObject(
    parsed.exact0096Backup.value,
    ["detachedSignature", "passReceipt", "plan", "signature", "trace"],
    "exact0096Backup",
  );
  for (const key of Object.keys(exact0096Backup)) {
    parseArtifact(exact0096Backup[key], `exact0096Backup.${key}`);
  }
  const migration = exactObject(
    parsed.migration0096To0107.value,
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
    "migration0096To0107",
  );
  for (const key of [
    "finalLive",
    "intent",
    "persistence",
    "plan",
    "postcommit",
    "role",
    "transitionPass",
  ]) {
    parseArtifact(migration[key], `migration0096To0107.${key}`);
  }
  if (!Array.isArray(migration.receipts) || migration.receipts.length !== 10) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_SCHEMA_INVALID",
      "migration0096To0107 must contain exactly ten receipts.",
    );
  }
  migration.receipts.forEach((artifact, index) =>
    parseArtifact(artifact, `migration0096To0107.receipts[${index}]`),
  );
  const credential = exactObject(
    parsed.runtimeDatabaseCredentialCutover.value,
    ["passReceipt", "request"],
    "runtimeDatabaseCredentialCutover",
  );
  const credentialRequest = parseArtifact(
    credential.request,
    "runtimeDatabaseCredentialCutover.request",
  );
  const credentialReceipt = parseArtifact(
    credential.passReceipt,
    "runtimeDatabaseCredentialCutover.passReceipt",
  );
  const transitionPass = parseArtifact(
    migration.transitionPass,
    "migration0096To0107.transitionPass",
  );
  const transitionPayload = exactObject(
    transitionPass.payload,
    Object.keys(transitionPass.payload),
    "migration0096To0107.transitionPass.payload",
  );
  exactString(
    transitionPayload.finalLiveIdentitySha256,
    "transitionPass.finalLiveIdentitySha256",
    SHA256,
  );

  const finalObservations = Object.freeze({
    coolify: wrapArtifact(
      "site-logbook-production-host-coolify-export",
      parsed.coolifyObservation,
    ),
    docker: wrapArtifact(
      "site-logbook-production-host-docker-export",
      parsed.dockerObservation,
    ),
    postgres: wrapArtifact(
      "site-logbook-production-host-postgres-export",
      parsed.postgresObservation,
    ),
  });
  const rawConfig = (value, field) =>
    exactString(value, field, SHA256).slice("sha256:".length);
  const approvalValue = Object.freeze({
    schemaVersion: PRODUCTION_ACTIVATION_APPROVAL_SCHEMA,
    kind: "site-logbook-production-activation-approval-v2",
    decision: "APPROVE",
    confirmation: PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION,
    sourceSha: challenge.sourceSha,
    apiImage: challenge.apiImage,
    nonce: challenge.nonce,
    containerId: challenge.containerId,
    desiredConfigSha256: rawConfig(
      observationVerdict.desiredConfigSha256,
      "observations.desiredConfigSha256",
    ),
    deployedConfigSha256: rawConfig(
      observationVerdict.deployedConfigSha256,
      "observations.deployedConfigSha256",
    ),
    resolvedComposeSha256: rawConfig(
      observationVerdict.resolvedComposeSha256,
      "observations.resolvedComposeSha256",
    ),
    databaseName: observationVerdict.databaseName,
    databaseUser: observationVerdict.databaseUser,
    schemaFingerprintSha256: observationVerdict.schemaFingerprintSha256,
    composeProject: request.composeProject,
    postgresService: request.postgresService,
    postgresVolumeDestination: request.postgresVolumeDestination,
    expectedNetworkServices: [...request.expectedNetworkServices],
    migrationTransitionSha256: `sha256:${transitionPass.sha256}`,
    finalLiveIdentitySha256: transitionPayload.finalLiveIdentitySha256,
    credentialRequestSha256: `sha256:${credentialRequest.sha256}`,
    credentialReceiptSha256: `sha256:${credentialReceipt.sha256}`,
    coolifyObservationSha256: `sha256:${finalObservations.coolify.sha256}`,
    dockerObservationSha256: `sha256:${finalObservations.docker.sha256}`,
    postgresObservationSha256: `sha256:${finalObservations.postgres.sha256}`,
    approvedAt: approvedAt.text,
    operator: options.operator,
    authorizesApplicationStart: true,
    authorizesDeployment: false,
  });
  const approvalCanonical = canonicalProductionActivationJson(approvalValue);
  parseProductionActivationApprovalV2(approvalCanonical);
  const activationApproval = wrapArtifact(
    "site-logbook-production-activation-approval-v2",
    Object.freeze({
      value: approvalValue,
      bytes: Buffer.from(approvalCanonical, "utf8"),
    }),
  );
  const evidence = Object.freeze({
    activationApproval,
    apiImageProvenance: Object.freeze({
      canonical: parsed.apiImageProvenance.text,
      signatureB64: provenanceSignatureB64,
    }),
    exact0096Backup,
    finalObservations,
    migration0096To0107: migration,
    runtimeDatabaseCredentialCutover: credential,
  });
  scanSecretFree(evidence, "activationPredecessorV2Evidence");

  const issuedAt = approvedAt.text;
  const verificationBundle = Object.freeze({
    activation: Object.freeze({
      schemaVersion: 2,
      kind: "site-logbook-production-activation-bundle-v2",
      sourceSha: challenge.sourceSha,
      apiImage: challenge.apiImage,
      desiredConfigSha256: approvalValue.desiredConfigSha256,
      deployedConfigSha256: approvalValue.deployedConfigSha256,
      resolvedComposeSha256: approvalValue.resolvedComposeSha256,
      containerId: challenge.containerId,
      nonce: challenge.nonce,
      evidence,
      issuedAt,
    }),
    activationSignature: Object.freeze({}),
    hostAttestation: Object.freeze({
      schemaVersion: 2,
      kind: "site-logbook-production-host-attestation-v2",
      observedAt: observationVerdict.capturedAt,
    }),
    hostAttestationSignature: Object.freeze({}),
  });
  const release = await dependencies.verifyContract(verificationBundle);
  requireSame(release.sourceSha, challenge.sourceSha, "release.sourceSha");
  requireSame(release.apiImage, challenge.apiImage, "release.apiImage");
  requireSame(
    release.databaseUser,
    "site_logbook_runtime",
    "release.databaseUser",
  );
  requireSame(
    release.schemaFingerprintSha256,
    observationVerdict.schemaFingerprintSha256,
    "release.schemaFingerprintSha256",
  );

  const canonical = canonicalProductionActivationJson(evidence);
  const output = await persistExclusive(outputDirectory, canonical);
  return Object.freeze({
    decision: "PREDECESSOR_V2_EVIDENCE_DURABLE",
    output,
    sha256: prefixedSha256(Buffer.from(canonical, "utf8")),
    approvalSha256: prefixedSha256(Buffer.from(approvalCanonical, "utf8")),
    sourceSha: challenge.sourceSha,
    apiImage: challenge.apiImage,
    containerId: challenge.containerId,
    nonce: challenge.nonce,
    semanticContractVerified: true,
    authorizesDeployment: false,
  });
}

const DIRECT_DEPENDENCIES = Object.freeze({
  now: Date.now,
  verifyContract: verifyProductionActivationContractV2,
  verifyObservations: verifyProductionObservationExports,
  verifyProvenance: verifyProductionApiImageProvenanceArtifact,
});

export async function executeProductionActivationPredecessorV2Evidence(argv) {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_AUTHORITY_INVALID",
      "production assembly accepts argv only.",
    );
  }
  return executeCore(argv, DIRECT_DEPENDENCIES);
}

export async function executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
  argv,
  authority,
) {
  if (
    process.env.NODE_ENV !== "test" ||
    arguments.length !== 2 ||
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    JSON.stringify(Object.keys(authority).sort()) !==
      JSON.stringify(
        [
          "now",
          "verifyContract",
          "verifyObservations",
          "verifyProvenance",
        ].sort(),
      ) ||
    Object.values(authority).some((value) => typeof value !== "function")
  ) {
    fail(
      "PRODUCTION_ACTIVATION_PREDECESSOR_V2_AUTHORITY_INVALID",
      "test authority is unavailable outside an explicit test process.",
    );
  }
  return executeCore(argv, Object.freeze({ ...authority }));
}

function usage() {
  return [
    "Usage:",
    `  node --import ./lib/db/node_modules/tsx/dist/loader.mjs scripts/production-evidence/run-production-activation-predecessor-v2-evidence.mjs assemble --descriptor ABSOLUTE_FILE --operator ID --approved-at CANONICAL_UTC --confirmation ${PRODUCTION_ACTIVATION_PREDECESSOR_V2_ASSEMBLY_CONFIRMATION}`,
    "",
    `The fixed output basename is ${PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT}; it is never overwritten.`,
    "The result remains non-deploying public evidence until the existing signed activation-v3 producer verifies it again.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const result = await executeProductionActivationPredecessorV2Evidence(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      error instanceof ProductionActivationPredecessorV2EvidenceError
        ? error.code
        : "PRODUCTION_ACTIVATION_PREDECESSOR_V2_FAILED";
    process.stderr.write(`${code}: assembly failed.\n${usage()}\n`);
    process.exitCode = 1;
  });
}
