import { execFile as execFileCallback } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
  rejectProductionExact0096BackupSecrets,
} from "./production-exact-0096-backup-contract.mjs";
import { validateProductionExact0096BackupExecutorDependencies } from "./production-exact-0096-backup-planner.mjs";
import { runProductionExact0096BackupEvidenceExecutor } from "./production-exact-0096-backup-receipt.mjs";

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
const HOST_METHODS = Object.freeze([
  "observeExecutorIdentity",
  "observeImmutableProductionSourceReadOnly",
  "proveProductionWritersStopped",
  "restoreIntoNewDisposablePostgres16",
  "observeRestoredJournalSchemaAndContentReadOnly",
  "reobserveProductionSourceReadOnly",
]);
const PRODUCER_METHODS = Object.freeze([
  "openExportedReadOnlySnapshot",
  "readFrozenRelationManifestMeasurements",
  "createBoundedPgDumpCustom",
  "encryptAndPersistVersionedPayload",
  "headExactVersionedPayloadReadOnly",
]);
export const PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION =
  "ACTIVATE_EXACT_0096_HOST_COMPOSITE_ELEVEN_OPERATIONS_NO_MIGRATION";

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
          "controlPlaneContainerId",
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
    !HEX64.test(config.controlPlaneContainerId) ||
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
        config.controlPlaneContainerId,
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

/**
 * Start exactly one producer process for an entire evidence run. Unlike the
 * legacy per-operation adapter above, this retains process-owned exported
 * snapshot and encrypted-dump state across the ordered DI operations. Request
 * bodies remain exclusive mode-0600 files; stdin contains only canonical
 * operation/path envelopes.
 */
export function createProductionExact0096BackupLongLivedHostSession(
  rawConfig,
  dependencies = {},
) {
  const config = exactConfig(rawConfig);
  const invocation = dependencies.invocationId ?? "";
  const signal = dependencies.signal;
  if (
    !HEX64.test(invocation) ||
    /^0{64}$/.test(invocation) ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_INVALID",
      "A non-zero invocation and live AbortSignal are required.",
    );
  }
  const spawn = dependencies.spawn ?? spawnProcess;
  const child = spawn(
    "docker",
    [
      "container",
      "exec",
      "--interactive",
      config.controlPlaneContainerId,
      "node",
      config.producerEntrypoint,
      "--session",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill?.("SIGTERM");
    fail(
      "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
      "Long-lived producer pipes are unavailable.",
    );
  }
  let terminalError = null;
  let closed = false;
  let stderr = "";
  const responseLines = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rejectWaiters = (error) => {
    terminalError = terminalError ?? error;
    while (waiters.length > 0) waiters.shift().reject(terminalError);
  };
  const poison = (error) => {
    rejectWaiters(error);
    if (!closed) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    }
  };
  lines.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(`${line}\n`);
    else responseLines.push(`${line}\n`);
  });
  child.stderr.on("data", (chunk) => {
    const remaining = 64 * 1024 - Buffer.byteLength(stderr);
    if (remaining > 0) {
      stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
    }
  });
  child.once("error", () =>
    rejectWaiters(
      new ProductionExact0096HostAdapterError(
        "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
        "Long-lived producer failed to start.",
      ),
    ),
  );
  const exited = new Promise((resolve) => {
    child.once("close", (code) => {
      closed = true;
      if (Number(code ?? -1) !== 0 || stderr !== "") {
        rejectWaiters(
          new ProductionExact0096HostAdapterError(
            "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
            "Long-lived producer closed non-zero or emitted stderr.",
          ),
        );
      }
      resolve(Number(code ?? -1));
    });
  });
  signal.addEventListener(
    "abort",
    () => {
      poison(
        new ProductionExact0096HostAdapterError(
          "PRODUCTION_BACKUP_HOST_SESSION_ABORTED",
          "Long-lived producer was aborted.",
        ),
      );
    },
    { once: true },
  );

  const nextResponse = () => {
    if (terminalError) return Promise.reject(terminalError);
    const buffered = responseLines.shift();
    if (buffered) return Promise.resolve(buffered);
    if (closed) {
      return Promise.reject(
        new ProductionExact0096HostAdapterError(
          "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
          "Long-lived producer is already closed.",
        ),
      );
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const responseWithin = async () => {
    let timer;
    try {
      return await Promise.race([
        nextResponse(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ProductionExact0096HostAdapterError(
                  "PRODUCTION_BACKUP_HOST_SESSION_TIMEOUT",
                  "Long-lived producer response exceeded the reviewed timeout.",
                ),
              ),
            config.timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let sequence = Promise.resolve();
  const invokeSession = (method, input) => {
    const execute = async () => {
      if (!METHODS.includes(method) || closed || terminalError) {
        fail(
          "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
          "Long-lived producer operation is unavailable.",
        );
      }
      const request = await writeRequestExclusive(
        config,
        method,
        input,
        invocation,
      );
      try {
        const command = canonicalProductionExact0096BackupJson({
          operation: method,
          requestPath: request.containerPath,
        });
        if (!child.stdin.write(command, "utf8")) {
          await new Promise((resolve) => child.stdin.once("drain", resolve));
        }
        try {
          const raw = await responseWithin();
          return exactCanonical(raw, `producer.${method}`);
        } catch (error) {
          poison(error);
          throw error;
        }
      } finally {
        await rm(request.hostPath, { force: true });
      }
    };
    const result = sequence.then(execute, execute);
    sequence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const producerHandlers = Object.freeze(
    Object.fromEntries(
      PRODUCER_METHODS.map((method) => [
        method,
        (input) => invokeSession(method, input),
      ]),
    ),
  );

  return Object.freeze({
    handlers: producerHandlers,
    async close() {
      if (!closed) child.stdin.end();
      let timer;
      const exitCode = await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new ProductionExact0096HostAdapterError(
              "PRODUCTION_BACKUP_HOST_SESSION_TIMEOUT",
              "Long-lived producer close exceeded the reviewed timeout.",
            );
            poison(error);
            reject(error);
          }, config.timeoutMs);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (exitCode !== 0 || stderr !== "") {
        fail(
          "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
          "Long-lived producer did not close cleanly.",
        );
      }
    },
  });
}

function exactHandlerSet(value, methods, code) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...methods].sort()) ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    fail(
      code,
      "Handler registry must contain every and only reviewed operation.",
    );
  }
  return Object.freeze({ ...value });
}

/**
 * Compose the six host-owned control-plane/restore operations with the five
 * process-owned producer operations. This is the only bridge that exposes the
 * complete eleven-operation executor interface.
 */
export function createProductionExact0096BackupCompositeDependencies(
  rawConfig,
  { activation, hostHandlers, producerHandlers },
) {
  const config = exactConfig(rawConfig);
  if (activation !== PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION) {
    fail(
      "PRODUCTION_BACKUP_HOST_COMPOSITE_DARK",
      "The composite stays dark without the exact reviewed activation binding.",
    );
  }
  const host = exactHandlerSet(
    hostHandlers,
    HOST_METHODS,
    "PRODUCTION_BACKUP_HOST_HANDLERS_INVALID",
  );
  const producer = exactHandlerSet(
    producerHandlers,
    PRODUCER_METHODS,
    "PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID",
  );
  return validateProductionExact0096BackupExecutorDependencies({
    ...host,
    ...producer,
    emitCanonicalExecutorTraceExclusive: async ({ traceCanonical }) =>
      persistExclusive(config, "executor-trace", traceCanonical),
    persistReceiptExclusive: async ({ receiptCanonical }) =>
      persistExclusive(config, "restore-receipt", receiptCanonical),
  });
}

export async function runProductionExact0096BackupWithLongLivedHostSession({
  planCanonical,
  config,
  invocationId,
  signal,
  spawn,
  activation,
  hostHandlers,
  overallTimeoutMs,
}) {
  if (
    !(signal instanceof AbortSignal) ||
    signal.aborted ||
    !Number.isSafeInteger(overallTimeoutMs) ||
    overallTimeoutMs < 1_000 ||
    overallTimeoutMs > 30 * 60_000
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_ADAPTER_INVALID",
      "A live signal and reviewed overall deadline are required.",
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new Error("PRODUCTION_BACKUP_OVERALL_TIMEOUT")),
    overallTimeoutMs,
  );
  deadline.unref();
  let session;
  try {
    session = createProductionExact0096BackupLongLivedHostSession(config, {
      invocationId,
      signal: controller.signal,
      ...(spawn ? { spawn } : {}),
    });
    const execution = runProductionExact0096BackupEvidenceExecutor({
      planCanonical,
      dependencies: createProductionExact0096BackupCompositeDependencies(
        config,
        { activation, hostHandlers, producerHandlers: session.handlers },
      ),
    });
    return await Promise.race([
      execution,
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new ProductionExact0096HostAdapterError(
                "PRODUCTION_BACKUP_OVERALL_TIMEOUT",
                "The complete backup/restore executor exceeded its reviewed deadline.",
              ),
            ),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    await session?.close();
  }
}
