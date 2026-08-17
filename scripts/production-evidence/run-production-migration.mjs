#!/usr/bin/env node

import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";

import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  exactObject,
  exactString,
  exactTimestamp,
  parseProductionMigrationLiveIdentity,
} from "./production-migration-contract.mjs";
import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createNodeExclusiveArtifactStore,
  createPgProductionMigrationDatabase,
  createProductionMigrationBackupAuthority,
  createProductionMigrationRoleBinding,
  loadProductionMigrationCatalog,
} from "./production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
  PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
  PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
  PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
  ProductionMigrationRunnerError,
  createProductionMigrationExecutable,
} from "./production-migration-runner.mjs";
import {
  PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA,
  PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA,
  canonicalProductionExact0096BackupJson,
} from "./production-exact-0096-backup-contract.mjs";

export const PRODUCTION_MIGRATION_RUNNER_DESCRIPTOR_SCHEMA =
  "site-logbook.production-migration-runner-descriptor/v1";

const MAX_DESCRIPTOR_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 512 * 1024;
const DEFAULT_OVERALL_TIMEOUT_MS = 36 * 60 * 1000;
const MAX_OVERALL_TIMEOUT_MS = 40 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5_000;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,127}$/;
const STORAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const AUTHORITY_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMANDS = new Set([
  "prepare",
  "inspect",
  "resume",
  "apply",
  "apply-role-ceremony",
  "finalize",
]);
const AUTHORITY_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PRODUCTION_MIGRATION_AUTHORITY_BINDINGS = Object.freeze({
  runtime: Object.freeze({
    id: "site-logbook.production-migration.runtime.docker/v1",
    path: path.join(
      AUTHORITY_DIRECTORY,
      "production-migration-docker-runtime-authority.mjs",
    ),
    sha256: "3bff51ed493c4edfed2c9c4fb0af8104e300ac87b051add5d40ce3f28cdb8a15",
  }),
  role: Object.freeze({
    id: "site-logbook.production-migration.role/v1",
    path: path.join(
      AUTHORITY_DIRECTORY,
      "production-migration-role-authority.ts",
    ),
    sha256: "3aa36563d041ed5642ad27f3f6dc22429c2d16efda3df7d4b5c3d3d122ff3e0e",
  }),
});

function fail(code, message, options) {
  throw new ProductionMigrationRunnerError(code, message, options);
}

function relativePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    path.isAbsolute(value) ||
    value.includes("\0")
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_PATH_INVALID",
      `${field} must be one descriptor-relative path.`,
    );
  }
  const normalized = path.normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.parse(normalized).root
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_PATH_INVALID",
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
      "PRODUCTION_MIGRATION_RUNNER_PATH_INVALID",
      `${field} escapes the descriptor directory.`,
    );
  }
  return target;
}

async function assertRealPathBelow(baseReal, target, field, kind) {
  let metadata;
  let targetReal;
  try {
    metadata = await lstat(target, { bigint: true });
    targetReal = await realpath(target);
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_PATH_UNAVAILABLE",
      `${field} is unavailable.`,
      { cause: error },
    );
  }
  const relation = path.relative(baseReal, targetReal);
  if (
    metadata.isSymbolicLink() ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation) ||
    (kind === "file" && (!metadata.isFile() || metadata.nlink !== 1n)) ||
    (kind === "directory" && !metadata.isDirectory())
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_PATH_INVALID",
      `${field} must be one real ${kind} below the descriptor directory.`,
    );
  }
  return Object.freeze({ path: targetReal, metadata });
}

async function readStableFile(baseReal, target, field, maximumBytes) {
  const before = await assertRealPathBelow(baseReal, target, field, "file");
  if (before.metadata.size > BigInt(maximumBytes)) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID",
      `${field} exceeds the reviewed byte ceiling.`,
    );
  }
  const bytes = await readFile(before.path);
  const after = await lstat(before.path, { bigint: true });
  if (
    after.dev !== before.metadata.dev ||
    after.ino !== before.metadata.ino ||
    after.size !== before.metadata.size ||
    after.mtimeNs !== before.metadata.mtimeNs ||
    bytes.length !== Number(before.metadata.size)
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INPUT_DRIFT",
      `${field} changed during its bounded read.`,
    );
  }
  return bytes;
}

function parseDescriptor(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_DESCRIPTOR_INVALID",
      "Runner descriptor must be strict JSON.",
      { cause: error },
    );
  }
  const value = exactObject(
    parsed,
    [
      "schemaVersion",
      "kind",
      "executionDefault",
      "migrationsDirectory",
      "artifactDirectory",
      "authorities",
      "roleCeremony",
      "connection",
      "inputs",
      "roleBinding",
      "intentId",
      "authorizesApplicationStart",
    ],
    "runnerDescriptor",
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_RUNNER_DESCRIPTOR_SCHEMA ||
    value.kind !== "site-logbook-production-migration-runner-descriptor" ||
    value.executionDefault !== "disabled" ||
    value.authorizesApplicationStart !== false ||
    !/^[0-9a-f]{64}$/.test(String(value.intentId))
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_DESCRIPTOR_INVALID",
      "Runner descriptor is not exact, default-dark and non-authorizing.",
    );
  }
  exactObject(
    value.authorities,
    ["runtime", "role"],
    "runnerDescriptor.authorities",
  );
  for (const kind of ["runtime", "role"]) {
    const authority = exactObject(
      value.authorities[kind],
      ["id", "sha256"],
      `runnerDescriptor.authorities.${kind}`,
    );
    if (
      !AUTHORITY_ID.test(String(authority.id)) ||
      !SHA256.test(String(authority.sha256))
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_INVALID",
        `runnerDescriptor.authorities.${kind} is not one exact id/digest pair.`,
      );
    }
  }
  const roleCeremony = exactObject(
    value.roleCeremony,
    ["activation", "transactionReceipt", "postCommitProjection"],
    "runnerDescriptor.roleCeremony",
  );
  const ceremonyPaths = Object.entries(roleCeremony).map(([field, relative]) =>
    relativePath(relative, `runnerDescriptor.roleCeremony.${field}`),
  );
  if (new Set(ceremonyPaths).size !== ceremonyPaths.length) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_PATH_INVALID",
      "Role ceremony paths must be three distinct descriptor-relative files.",
    );
  }
  exactObject(
    value.inputs,
    [
      "targetEvidence",
      "baselineLiveIdentity",
      "backupPlan",
      "backupExecutorTrace",
      "backupReceipt",
      "backupSignatureEnvelope",
      "backupDetachedSignature",
      "rolePrecondition",
    ],
    "runnerDescriptor.inputs",
  );
  exactObject(
    value.roleBinding,
    ["databaseName", "sessionUser", "migrationRole", "runtimeRole"],
    "runnerDescriptor.roleBinding",
  );
  const connection = exactObject(
    value.connection,
    ["source", "reference"],
    "runnerDescriptor.connection",
  );
  if (!["environment", "file"].includes(connection.source)) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_CONNECTION_INVALID",
      "Connection material must come only from an environment variable or a mode-0600 file.",
    );
  }
  return value;
}

function decodeUtf8(bytes, field) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID",
      `${field} must contain exact UTF-8 bytes.`,
    );
  }
  return text;
}

async function readConnectionMaterial({
  descriptor,
  descriptorDirectoryReal,
  environment,
}) {
  const { source, reference } = descriptor.connection;
  let connectionString;
  if (source === "environment") {
    if (!ENVIRONMENT_NAME.test(String(reference))) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_CONNECTION_INVALID",
        "Environment connection reference is invalid.",
      );
    }
    connectionString = environment[reference];
  } else {
    const target = resolveBelow(
      descriptorDirectoryReal,
      reference,
      "runnerDescriptor.connection.reference",
    );
    const file = await assertRealPathBelow(
      descriptorDirectoryReal,
      target,
      "runnerDescriptor.connection.reference",
      "file",
    );
    if (
      process.platform !== "win32" &&
      (Number(file.metadata.mode) & 0o077) !== 0
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_CONNECTION_MODE_INVALID",
        "Connection file must deny every group and other permission bit.",
      );
    }
    const bytes = await readStableFile(
      descriptorDirectoryReal,
      file.path,
      "runnerDescriptor.connection.reference",
      16 * 1024,
    );
    connectionString = decodeUtf8(
      bytes,
      "runnerDescriptor.connection.reference",
    ).replace(/\r?\n$/, "");
  }
  if (
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    connectionString !== connectionString.trim() ||
    connectionString.includes("\0")
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_CONNECTION_UNAVAILABLE",
      "Connection material is unavailable or malformed.",
    );
  }
  return connectionString;
}

function abortFailure(signal) {
  if (signal?.reason instanceof ProductionMigrationRunnerError) {
    return signal.reason;
  }
  return new ProductionMigrationRunnerError(
    "PRODUCTION_MIGRATION_RUNNER_ABORTED",
    "Production migration command was aborted and failed closed.",
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortFailure(signal);
}

function awaitWithAbort(value, signal, { onLateResolve } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, result) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action(result);
      return true;
    };
    const onAbort = () => finish(reject, abortFailure(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        if (!finish(resolve, result)) {
          Promise.resolve(onLateResolve?.(result)).catch(() => {});
        }
      },
      (error) => finish(reject, error),
    );
  });
}

function timeoutMilliseconds(value) {
  const timeout = value ?? DEFAULT_OVERALL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_OVERALL_TIMEOUT_MS
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_TIMEOUT_INVALID",
      "Internal overall timeout must be a bounded positive integer.",
    );
  }
  return timeout;
}

export function createProductionMigrationAbortableConnect(pool, signal) {
  return async () => {
    const client = await awaitWithAbort(
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return pool.connect();
      }),
      signal,
      { onLateResolve: (lateClient) => lateClient?.release?.(true) },
    );
    if (!client || typeof client.query !== "function") return client;
    let released = false;
    const release = (destroy = false) => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      client.release?.(destroy);
    };
    const onAbort = () => release(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    return Object.freeze({
      query(...args) {
        throwIfAborted(signal);
        return awaitWithAbort(
          Promise.resolve().then(() => {
            throwIfAborted(signal);
            return client.query(...args);
          }),
          signal,
        );
      },
      release,
    });
  };
}

async function endPoolBounded(pool, signal) {
  if (!pool || typeof pool.end !== "function") return;
  let cleanupTimer;
  const cleanupTimeout = new Promise((_, reject) => {
    cleanupTimer = setTimeout(
      () =>
        reject(
          new ProductionMigrationRunnerError(
            "PRODUCTION_MIGRATION_RUNNER_CLEANUP_TIMEOUT",
            "PostgreSQL pool cleanup exceeded its fixed bound.",
          ),
        ),
      CLEANUP_TIMEOUT_MS,
    );
  });
  try {
    const boundedCleanup = Promise.race([
      Promise.resolve().then(() => pool.end()),
      cleanupTimeout,
    ]);
    boundedCleanup.catch(() => {});
    await awaitWithAbort(boundedCleanup, signal);
  } finally {
    clearTimeout(cleanupTimer);
  }
}

export async function resolveProductionMigrationPinnedAuthority(
  kind,
  selected,
  signal,
) {
  const pinned = PRODUCTION_MIGRATION_AUTHORITY_BINDINGS[kind];
  if (
    !pinned ||
    selected.id !== pinned.id ||
    selected.sha256 !== pinned.sha256
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_NOT_PINNED",
      `The selected ${kind} authority is not the source-pinned id/digest pair.`,
    );
  }
  const before = await lstat(pinned.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_NOT_PINNED",
      `The source-pinned ${kind} authority path is not one regular file.`,
    );
  }
  const bytes = await readFile(pinned.path);
  const after = await lstat(pinned.path, { bigint: true });
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    digest !== pinned.sha256
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_DIGEST_MISMATCH",
      `The source-pinned ${kind} authority bytes differ from the reviewed digest.`,
    );
  }
  return awaitWithAbort(import(pathToFileURL(pinned.path).href), signal);
}

async function assertPathAbsent(baseReal, target, field) {
  const parent = await assertRealPathBelow(
    baseReal,
    path.dirname(target),
    `${field}.directory`,
    "directory",
  );
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return parent.path;
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_PATH_UNAVAILABLE",
      `${field} could not be checked without mutation.`,
      { cause: error },
    );
  }
  fail(
    "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_ALREADY_ATTEMPTED",
    `${field} already exists; blind role-ceremony retry is forbidden.`,
  );
}

export async function persistProductionMigrationMode0600Exclusive(
  baseReal,
  target,
  field,
  canonical,
) {
  const parentReal = await assertPathAbsent(baseReal, target, field);
  const relation = path.relative(parentReal, target);
  if (path.dirname(relation) !== "." || path.basename(relation) !== relation) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_PATH_INVALID",
      `${field} is not descriptor-relative to its pinned parent directory.`,
    );
  }
  let file;
  let directory;
  let createdIdentity;
  let fileSynced = false;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    file = await open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
    createdIdentity = await file.stat({ bigint: true });
    await file.writeFile(canonical, "utf8");
    await file.sync();
    fileSynced = true;
    await file.close();
    file = undefined;
    directory = await open(parentReal, fsConstants.O_RDONLY);
    await directory.sync();
    const beforeReadback = await lstat(target, { bigint: true });
    if (
      !beforeReadback.isFile() ||
      beforeReadback.isSymbolicLink() ||
      beforeReadback.nlink !== 1n ||
      beforeReadback.dev !== createdIdentity.dev ||
      beforeReadback.ino !== createdIdentity.ino ||
      beforeReadback.size !== BigInt(Buffer.byteLength(canonical, "utf8")) ||
      (process.platform !== "win32" &&
        (Number(beforeReadback.mode) & 0o077) !== 0)
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_FAILED",
        `${field} does not have exact regular single-link mode-0600 custody.`,
      );
    }
    const readback = await readFile(target, "utf8");
    const afterReadback = await lstat(target, { bigint: true });
    if (
      readback !== canonical ||
      afterReadback.dev !== beforeReadback.dev ||
      afterReadback.ino !== beforeReadback.ino ||
      afterReadback.size !== beforeReadback.size ||
      afterReadback.mtimeNs !== beforeReadback.mtimeNs
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_FAILED",
        `${field} exact durable read-back differs from the committed evidence bytes.`,
      );
    }
  } catch (error) {
    if (createdIdentity && !fileSynced) {
      try {
        const partial = await lstat(target, { bigint: true });
        if (
          partial.isFile() &&
          !partial.isSymbolicLink() &&
          partial.dev === createdIdentity.dev &&
          partial.ino === createdIdentity.ino
        ) {
          await file?.close().catch(() => {});
          file = undefined;
          await unlink(target);
        }
      } catch {
        // The exact partial file is already absent or cannot be safely identified.
      }
    }
    if (error instanceof ProductionMigrationRunnerError) throw error;
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_FAILED",
      `${field} was not durably persisted with exclusive mode-0600 custody.`,
      { cause: error },
    );
  } finally {
    await file?.close().catch(() => {});
    await directory?.close().catch(() => {});
  }
}

async function loadPlanInput(descriptor, descriptorDirectoryReal) {
  const canonicals = {};
  for (const [field, relative] of Object.entries(descriptor.inputs)) {
    const target = resolveBelow(
      descriptorDirectoryReal,
      relative,
      `runnerDescriptor.inputs.${field}`,
    );
    const bytes = await readStableFile(
      descriptorDirectoryReal,
      target,
      `runnerDescriptor.inputs.${field}`,
      MAX_INPUT_BYTES,
    );
    canonicals[field] = decodeUtf8(bytes, `runnerDescriptor.inputs.${field}`);
  }
  const signature = canonicals.backupDetachedSignature.replace(/\n$/, "");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID",
      "Detached backup signature file is not one exact Ed25519 base64 value.",
    );
  }
  const live = parseProductionMigrationLiveIdentity(
    canonicals.baselineLiveIdentity,
    "runnerDescriptor.inputs.baselineLiveIdentity",
  );
  let backupPlan;
  let backupReceipt;
  try {
    backupPlan = JSON.parse(canonicals.backupPlan);
    backupReceipt = JSON.parse(canonicals.backupReceipt);
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID",
      "Exact backup plan and receipt must be strict canonical JSON.",
      { cause: error },
    );
  }
  if (
    backupPlan.schemaVersion !== PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA ||
    backupReceipt.schemaVersion !==
      PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA ||
    backupReceipt.decision !== "PASS" ||
    backupReceipt.authorizesProductionMigration !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_BACKUP_INVALID",
      "Runner requires the exact non-authorizing v3 backup plan and PASS restore receipt.",
    );
  }
  return Object.freeze({
    planInput: {
      sourceSha: live.value.sourceSha,
      targetEvidenceCanonical: canonicals.targetEvidence,
      baselineLiveIdentityCanonical: canonicals.baselineLiveIdentity,
      database: live.database,
      backupPlanCanonical: canonicals.backupPlan,
      backupExecutorTraceCanonical: canonicals.backupExecutorTrace,
      backupReceiptCanonical: canonicals.backupReceipt,
      backupSignatureEnvelopeCanonical: canonicals.backupSignatureEnvelope,
      backupDetachedSignatureB64: signature,
      rolePreconditionCanonical: canonicals.rolePrecondition,
      baselineInventory: live.value.inventory,
    },
    runtimeBindingCanonical: canonicalProductionExact0096BackupJson(
      backupPlan.runtimeBinding,
    ),
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_COMMAND_INVALID",
      "Command must be prepare, inspect, resume, apply, apply-role-ceremony or finalize.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !/^--[a-z][a-z-]*$/.test(String(flag)) ||
      value === undefined ||
      String(value).startsWith("--") ||
      Object.hasOwn(options, flag.slice(2))
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID",
        "CLI accepts only unique reviewed flag/value pairs.",
      );
    }
    options[flag.slice(2)] = value;
  }
  const required = {
    prepare: [
      "descriptor",
      "operator",
      "approved-at",
      "intent-confirmation",
      "activation-confirmation",
    ],
    inspect: ["descriptor", "receipt-count", "confirmation"],
    resume: [
      "descriptor",
      "receipt-count",
      "operator",
      "approved-at",
      "confirmation",
    ],
    apply: ["descriptor", "receipt-count", "resume-storage-id", "confirmation"],
    "apply-role-ceremony": ["descriptor", "receipt-count", "confirmation"],
    finalize: ["descriptor", "receipt-count", "confirmation"],
  }[command];
  const allowed = new Set(required);
  if (
    required.some((name) => !Object.hasOwn(options, name)) ||
    Object.keys(options).length !== required.length ||
    Object.keys(options).some((name) => !allowed.has(name))
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID",
      "CLI arguments are missing or outside the reviewed command surface.",
    );
  }
  return Object.freeze({ command, options });
}

function receiptCount(value) {
  if (!/^(?:0|[1-9]|10)$/.test(String(value))) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_RECEIPT_COUNT_INVALID",
      "--receipt-count must be an explicit integer from zero through ten.",
    );
  }
  return Number(value);
}

function exactCanonicalTimestamp(value, field) {
  let milliseconds;
  try {
    milliseconds = exactTimestamp(value, field);
  } catch {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID",
      `${field} must be one exact canonical UTC timestamp.`,
    );
  }
  if (new Date(milliseconds).toISOString() !== value) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID",
      `${field} must be one exact canonical UTC timestamp.`,
    );
  }
  return value;
}

function requireCliConfirmation(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED",
      `${field} requires its exact attended confirmation.`,
    );
  }
}

function preflightCliRequest(command, options) {
  exactString(options.descriptor, "--descriptor", 4096);
  if (options.descriptor !== options.descriptor.trim()) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID",
      "--descriptor must be one exact path value.",
    );
  }
  if (command === "prepare") {
    requireCliConfirmation(
      options["intent-confirmation"],
      PRODUCTION_MIGRATION_CONFIRMATION,
      "--intent-confirmation",
    );
    requireCliConfirmation(
      options["activation-confirmation"],
      PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
      "--activation-confirmation",
    );
    exactString(options.operator, "--operator", 256);
    exactCanonicalTimestamp(options["approved-at"], "--approved-at");
    return;
  }
  const count = receiptCount(options["receipt-count"]);
  if (command === "inspect") {
    requireCliConfirmation(
      options.confirmation,
      PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
      "--confirmation",
    );
    return;
  }
  if (command === "resume") {
    requireCliConfirmation(
      options.confirmation,
      PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
      "--confirmation",
    );
    if (count >= 10) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ALREADY_COMPLETE",
        "Resume requires an explicit receipt count from zero through nine.",
      );
    }
    exactString(options.operator, "--operator", 256);
    exactCanonicalTimestamp(options["approved-at"], "--approved-at");
    return;
  }
  if (command === "apply") {
    requireCliConfirmation(
      options.confirmation,
      PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
      "--confirmation",
    );
    if (count >= 10) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ALREADY_COMPLETE",
        "Apply requires an explicit receipt count from zero through nine.",
      );
    }
    const storageId = exactString(
      options["resume-storage-id"],
      "--resume-storage-id",
      128,
    );
    if (
      !STORAGE_ID.test(storageId) ||
      !storageId.startsWith(`resume-${String(count + 1).padStart(2, "0")}-`)
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_RESUME_INVALID",
        "--resume-storage-id must be exact and sequence-bound to --receipt-count.",
      );
    }
    return;
  }
  if (command === "apply-role-ceremony") {
    requireCliConfirmation(
      options.confirmation,
      PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
      "--confirmation",
    );
    if (count !== 10) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_DENIED",
        "Role ceremony requires the explicit receipt count ten.",
      );
    }
    return;
  }
  requireCliConfirmation(
    options.confirmation,
    PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
    "--confirmation",
  );
  if (count !== 10) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_FINALIZE_DENIED",
      "Finalize requires the explicit receipt count ten.",
    );
  }
}

export async function runProductionMigrationCli(
  argv,
  {
    createPool,
    now = () => new Date(),
    environment = process.env,
    signal: callerSignal,
    timeoutMs,
    authorityResolver = resolveProductionMigrationPinnedAuthority,
  } = {},
) {
  const { command, options } = parseCli(argv);
  preflightCliRequest(command, options);
  const overallTimeoutMs = timeoutMilliseconds(timeoutMs);
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(
      new ProductionMigrationRunnerError(
        "PRODUCTION_MIGRATION_RUNNER_ABORTED",
        "Production migration command was externally aborted and failed closed.",
      ),
    );
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const overallTimer = setTimeout(
    () =>
      controller.abort(
        new ProductionMigrationRunnerError(
          "PRODUCTION_MIGRATION_RUNNER_TIMEOUT",
          "Production migration command exceeded its fixed overall deadline and failed closed.",
        ),
      ),
    overallTimeoutMs,
  );
  const runSignal = controller.signal;
  let pool;
  let result;
  let operationError;
  try {
    throwIfAborted(runSignal);
    const descriptorPath = path.resolve(options.descriptor);
    const descriptorDirectory = path.dirname(descriptorPath);
    const descriptorDirectoryReal = await realpath(descriptorDirectory);
    const descriptorBytes = await readStableFile(
      descriptorDirectoryReal,
      descriptorPath,
      "descriptor",
      MAX_DESCRIPTOR_BYTES,
    );
    const descriptor = parseDescriptor(
      decodeUtf8(descriptorBytes, "descriptor"),
    );
    const migrationsDirectory = (
      await assertRealPathBelow(
        descriptorDirectoryReal,
        resolveBelow(
          descriptorDirectoryReal,
          descriptor.migrationsDirectory,
          "runnerDescriptor.migrationsDirectory",
        ),
        "runnerDescriptor.migrationsDirectory",
        "directory",
      )
    ).path;
    const artifactDirectory = (
      await assertRealPathBelow(
        descriptorDirectoryReal,
        resolveBelow(
          descriptorDirectoryReal,
          descriptor.artifactDirectory,
          "runnerDescriptor.artifactDirectory",
        ),
        "runnerDescriptor.artifactDirectory",
        "directory",
      )
    ).path;
    const runtimeModule = await awaitWithAbort(
      Promise.resolve().then(() =>
        authorityResolver("runtime", descriptor.authorities.runtime, runSignal),
      ),
      runSignal,
    );
    const roleModule = await awaitWithAbort(
      Promise.resolve().then(() =>
        authorityResolver("role", descriptor.authorities.role, runSignal),
      ),
      runSignal,
    );
    if (
      typeof runtimeModule.observeProductionMigrationRuntime !== "function" ||
      typeof roleModule.assertProductionMigrationRolePrecondition !==
        "function" ||
      typeof roleModule.assertProductionMigrationRolePostCommit !==
        "function" ||
      typeof roleModule.applyProductionMigrationRoleCeremony !== "function"
    ) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_UNAVAILABLE",
        "Authoritative runtime and role evidence modules are incomplete.",
      );
    }
    const { planInput, runtimeBindingCanonical } = await loadPlanInput(
      descriptor,
      descriptorDirectoryReal,
    );
    const roleBinding = createProductionMigrationRoleBinding(
      descriptor.roleBinding,
    );
    const ceremonyTargets = Object.fromEntries(
      Object.entries(descriptor.roleCeremony).map(([field, relative]) => [
        field,
        resolveBelow(
          descriptorDirectoryReal,
          relative,
          `runnerDescriptor.roleCeremony.${field}`,
        ),
      ]),
    );
    let roleCeremonyActivationCanonical;
    if (command === "apply-role-ceremony") {
      await assertPathAbsent(
        descriptorDirectoryReal,
        ceremonyTargets.transactionReceipt,
        "runnerDescriptor.roleCeremony.transactionReceipt",
      );
      await assertPathAbsent(
        descriptorDirectoryReal,
        ceremonyTargets.postCommitProjection,
        "runnerDescriptor.roleCeremony.postCommitProjection",
      );
      roleCeremonyActivationCanonical = decodeUtf8(
        await readStableFile(
          descriptorDirectoryReal,
          ceremonyTargets.activation,
          "runnerDescriptor.roleCeremony.activation",
          MAX_INPUT_BYTES,
        ),
        "runnerDescriptor.roleCeremony.activation",
      );
    }
    const connectionString = await readConnectionMaterial({
      descriptor,
      descriptorDirectoryReal,
      environment,
    });
    throwIfAborted(runSignal);
    if (typeof createPool === "function") {
      pool = createPool(connectionString, { signal: runSignal });
    } else {
      const requireFromDb = createRequire(
        new URL("../../lib/db/package.json", import.meta.url),
      );
      const { Pool } = requireFromDb("pg");
      pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: Math.min(overallTimeoutMs, 15_000),
      });
    }
    if (!pool || typeof pool.connect !== "function") {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_CONNECTION_UNAVAILABLE",
        "Fixed PostgreSQL pool is unavailable.",
      );
    }
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory,
    });
    const database = createPgProductionMigrationDatabase({
      connect: createProductionMigrationAbortableConnect(pool, runSignal),
      catalog,
      roleBindingCanonical: roleBinding.canonical,
      expectedRuntimeBindingCanonical: runtimeBindingCanonical,
      observeLiveRuntime: () =>
        awaitWithAbort(
          Promise.resolve().then(() =>
            runtimeModule.observeProductionMigrationRuntime({
              expectedRuntimeBindingCanonical: runtimeBindingCanonical,
              signal: runSignal,
            }),
          ),
          runSignal,
        ),
      now,
    });
    const roleAuthority = Object.freeze({
      assertPrecondition: (input) =>
        awaitWithAbort(
          Promise.resolve().then(() =>
            roleModule.assertProductionMigrationRolePrecondition(input, {
              signal: runSignal,
            }),
          ),
          runSignal,
        ),
      readPostCommitEvidence: async () => ({
        roleTransactionReceiptCanonical: decodeUtf8(
          await readStableFile(
            descriptorDirectoryReal,
            ceremonyTargets.transactionReceipt,
            "runnerDescriptor.roleCeremony.transactionReceipt",
            MAX_INPUT_BYTES,
          ),
          "runnerDescriptor.roleCeremony.transactionReceipt",
        ),
        postCommitRoleArtifactCanonical: decodeUtf8(
          await readStableFile(
            descriptorDirectoryReal,
            ceremonyTargets.postCommitProjection,
            "runnerDescriptor.roleCeremony.postCommitProjection",
            MAX_INPUT_BYTES,
          ),
          "runnerDescriptor.roleCeremony.postCommitProjection",
        ),
      }),
      assertPostCommit: (input) =>
        awaitWithAbort(
          Promise.resolve().then(() =>
            roleModule.assertProductionMigrationRolePostCommit(input, {
              signal: runSignal,
            }),
          ),
          runSignal,
        ),
      applyCeremony: ({ planCanonical, activationCanonical }) =>
        awaitWithAbort(
          Promise.resolve().then(() =>
            roleModule.applyProductionMigrationRoleCeremony({
              planCanonical,
              activationCanonical,
              advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
              connect: createProductionMigrationAbortableConnect(
                pool,
                runSignal,
              ),
              signal: runSignal,
              now,
            }),
          ),
          runSignal,
        ),
    });
    const executable = createProductionMigrationExecutable({
      planInput,
      roleBindingCanonical: roleBinding.canonical,
      intentId: descriptor.intentId,
      database,
      artifacts: createNodeExclusiveArtifactStore({
        directory: artifactDirectory,
      }),
      roleAuthority,
      backupAuthority: createProductionMigrationBackupAuthority(),
      now,
    });
    if (command === "prepare") {
      result = await awaitWithAbort(
        executable.prepare({
          operator: options.operator,
          approvedAt: options["approved-at"],
          intentConfirmation: options["intent-confirmation"],
          activationConfirmation: options["activation-confirmation"],
        }),
        runSignal,
      );
    } else if (command === "inspect") {
      result = await awaitWithAbort(
        executable.inspect({
          receiptCount: receiptCount(options["receipt-count"]),
          confirmation: options.confirmation,
        }),
        runSignal,
      );
    } else if (command === "resume") {
      result = await awaitWithAbort(
        executable.resume({
          receiptCount: receiptCount(options["receipt-count"]),
          operator: options.operator,
          approvedAt: options["approved-at"],
          confirmation: options.confirmation,
        }),
        runSignal,
      );
    } else if (command === "apply") {
      result = await awaitWithAbort(
        executable.apply({
          receiptCount: receiptCount(options["receipt-count"]),
          resumeStorageId: options["resume-storage-id"],
          confirmation: options.confirmation,
        }),
        runSignal,
      );
    } else if (command === "apply-role-ceremony") {
      result = await awaitWithAbort(
        executable.applyRoleCeremony({
          receiptCount: receiptCount(options["receipt-count"]),
          confirmation: options.confirmation,
          activationCanonical: roleCeremonyActivationCanonical,
          persistEvidence: async (evidence) => {
            const exact = exactObject(
              evidence,
              [
                "roleTransactionReceiptCanonical",
                "postCommitRoleArtifactCanonical",
                "authorizesApplicationStart",
              ],
              "roleCeremony.evidence",
            );
            if (
              typeof exact.roleTransactionReceiptCanonical !== "string" ||
              typeof exact.postCommitRoleArtifactCanonical !== "string" ||
              exact.authorizesApplicationStart !== false
            ) {
              fail(
                "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_EVIDENCE_INVALID",
                "Source-pinned role ceremony returned malformed evidence.",
              );
            }
            await persistProductionMigrationMode0600Exclusive(
              descriptorDirectoryReal,
              ceremonyTargets.transactionReceipt,
              "runnerDescriptor.roleCeremony.transactionReceipt",
              exact.roleTransactionReceiptCanonical,
            );
            await persistProductionMigrationMode0600Exclusive(
              descriptorDirectoryReal,
              ceremonyTargets.postCommitProjection,
              "runnerDescriptor.roleCeremony.postCommitProjection",
              exact.postCommitRoleArtifactCanonical,
            );
          },
        }),
        runSignal,
      );
    } else {
      result = await awaitWithAbort(
        executable.finalize({
          receiptCount: receiptCount(options["receipt-count"]),
          confirmation: options.confirmation,
        }),
        runSignal,
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      try {
        await endPoolBounded(pool, operationError ? undefined : runSignal);
      } catch (cleanupError) {
        operationError ??= cleanupError;
      }
    } finally {
      clearTimeout(overallTimer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
  if (operationError) throw operationError;
  return result;
}

async function main() {
  try {
    const commandArguments = process.argv.slice(2);
    if (commandArguments[0] === "--") commandArguments.shift();
    const result = await runProductionMigrationCli(commandArguments);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      typeof error?.code === "string"
        ? error.code
        : "PRODUCTION_MIGRATION_RUNNER_FAILED";
    process.stderr.write(
      `${code}: production migration command failed closed.\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}

export const PRODUCTION_MIGRATION_RUNNER_CONFIRMATIONS = Object.freeze({
  prepareIntent: PRODUCTION_MIGRATION_CONFIRMATION,
  prepareActivation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  inspect: PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
  resume: PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  apply: PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
  applyRoleCeremony: PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
  finalize: PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
});
