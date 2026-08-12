import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
  rejectProductionExact0096BackupSecrets,
} from "./production-exact-0096-backup-contract.mjs";
import { validateProductionExact0096BackupExecutorDependencies } from "./production-exact-0096-backup-planner.mjs";

const execFile = promisify(execFileCallback);
const OPERATION = /^[a-z][A-Za-z0-9]{2,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ABSOLUTE_CONTAINER_PATH = /^\/[A-Za-z0-9._/-]{3,511}$/;
const REVIEWED_PRODUCER_ENTRYPOINT =
  "/app/dist/production-exact-0096-backup-producer.mjs";
const METHODS = Object.freeze([
  "observeExecutorIdentity",
  "observeImmutableProductionSourceReadOnly",
  "proveProductionWritersStopped",
  "openExportedReadOnlySnapshot",
  "readFrozenRelationManifestMeasurements",
  "createBoundedPgDumpCustom",
  "encryptAndPersistVersionedPayload",
  "headExactVersionedPayloadReadOnly",
  "restoreIntoNewDisposablePostgres16",
  "observeRestoredJournalSchemaAndContentReadOnly",
  "reobserveProductionSourceReadOnly",
]);

export class ProductionExact0096HostAdapterError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096HostAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionExact0096HostAdapterError(code, message);
}

function exactConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    JSON.stringify(Object.keys(config).sort()) !==
      JSON.stringify(
        [
          "activated",
          "apiContainerId",
          "containerRequestDirectory",
          "evidenceDirectory",
          "hostRequestDirectory",
          "producerEntrypoint",
          "timeoutMs",
        ].sort(),
      ) ||
    config.activated !== true
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_DARK",
      "The host adapter is default-dark until exact reviewed activation config is supplied.",
    );
  }
  if (
    !HEX64.test(config.apiContainerId) ||
    !ABSOLUTE_CONTAINER_PATH.test(config.containerRequestDirectory) ||
    !ABSOLUTE_CONTAINER_PATH.test(config.producerEntrypoint) ||
    config.producerEntrypoint !== REVIEWED_PRODUCER_ENTRYPOINT ||
    !isAbsolute(config.hostRequestDirectory) ||
    !isAbsolute(config.evidenceDirectory) ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1_000 ||
    config.timeoutMs > 15 * 60_000
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_INVALID",
      "Host adapter binding or timeout is invalid.",
    );
  }
  return Object.freeze({ ...config });
}

function exactCanonical(raw, field) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw) < 2 ||
    Buffer.byteLength(raw) > PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
      `${field} output is absent or oversized.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_BACKUP_HOST_OUTPUT_INVALID", `${field} is not JSON.`);
  }
  if (canonicalProductionExact0096BackupJson(parsed) !== raw) {
    fail(
      "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
      `${field} is not exact canonical JSON with one LF.`,
    );
  }
  rejectProductionExact0096BackupSecrets(parsed, field);
  return raw;
}

async function writeRequestExclusive(config, method, input, invocation) {
  rejectProductionExact0096BackupSecrets(input, `request.${method}`);
  const canonical = canonicalProductionExact0096BackupJson(input);
  if (Buffer.byteLength(canonical) > PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES) {
    fail("PRODUCTION_BACKUP_HOST_INPUT_INVALID", "Request is oversized.");
  }
  await mkdir(config.hostRequestDirectory, { recursive: true, mode: 0o700 });
  const name = `${invocation}-${method}.json`;
  const hostPath = join(config.hostRequestDirectory, name);
  const handle = await open(hostPath, "wx", 0o600);
  try {
    await handle.writeFile(canonical);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    hostPath,
    containerPath: `${config.containerRequestDirectory}/${name}`,
  });
}

async function invoke(
  config,
  method,
  input,
  invocation,
  signal,
  run = execFile,
) {
  if (!METHODS.includes(method) || !OPERATION.test(method)) {
    fail("PRODUCTION_BACKUP_HOST_OPERATION_INVALID", "Operation is invalid.");
  }
  const request = await writeRequestExclusive(
    config,
    method,
    input,
    invocation,
  );
  try {
    const result = await run(
      "docker",
      [
        "container",
        "exec",
        config.apiContainerId,
        "node",
        config.producerEntrypoint,
        method,
        "--request-file",
        request.containerPath,
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
        signal,
        timeout: config.timeoutMs,
      },
    );
    if (result.stderr !== "") {
      fail(
        "PRODUCTION_BACKUP_HOST_COMMAND_FAILED",
        `${method} emitted unexpected stderr.`,
      );
    }
    return exactCanonical(result.stdout, `producer.${method}`);
  } finally {
    await rm(request.hostPath, { force: true });
  }
}

async function persistExclusive(config, kind, canonical) {
  exactCanonical(canonical, kind);
  await mkdir(config.evidenceDirectory, { recursive: true, mode: 0o700 });
  const artifactSha256 = productionExact0096BackupSha256(canonical);
  const name = `${kind}-${artifactSha256.slice("sha256:".length)}.json`;
  const target = join(config.evidenceDirectory, name);
  let existingTargetObserved = false;
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(canonical);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "EEXIST") existingTargetObserved = true;
    throw error;
  }
  const readback = await readFile(target, "utf8");
  if (readback !== canonical) {
    fail(
      "PRODUCTION_BACKUP_EXCLUSIVE_PERSISTENCE_FAILED",
      `${kind} readback differs from written canonical bytes.`,
    );
  }
  const storageIdentitySha256 = `sha256:${createHash("sha256")
    .update(
      canonicalProductionExact0096BackupJson({
        kind: "site-logbook-production-exact-0096-local-evidence-store",
        resolvedRoot: resolve(config.evidenceDirectory),
      }),
    )
    .digest("hex")}`;
  return canonicalProductionExact0096BackupJson({
    artifactSha256,
    canonicalReadbackBytes: Buffer.byteLength(readback),
    canonicalReadbackSha256: productionExact0096BackupSha256(readback),
    existingTargetObserved,
    persistedExclusive: true,
    storageIdentitySha256,
  });
}

export function createProductionExact0096BackupHostDependencies(
  rawConfig,
  dependencies = {},
) {
  const config = exactConfig(rawConfig);
  const invocation = dependencies.invocationId ?? "";
  if (!HEX64.test(invocation) || /^0{64}$/.test(invocation)) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_INVALID",
      "A non-zero producer invocation id is required.",
    );
  }
  const run = dependencies.execFile ?? execFile;
  const signal = dependencies.signal;
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_INVALID",
      "A live operation AbortSignal is required.",
    );
  }
  const executor = Object.fromEntries(
    METHODS.map((method) => [
      method,
      async (input) => invoke(config, method, input, invocation, signal, run),
    ]),
  );
  executor.emitCanonicalExecutorTraceExclusive = async ({ traceCanonical }) =>
    persistExclusive(config, "executor-trace", traceCanonical);
  executor.persistReceiptExclusive = async ({ receiptCanonical }) =>
    persistExclusive(config, "restore-receipt", receiptCanonical);
  return validateProductionExact0096BackupExecutorDependencies(executor);
}
