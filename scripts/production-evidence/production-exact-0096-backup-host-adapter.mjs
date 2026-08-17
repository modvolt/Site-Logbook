import { execFile as execFileCallback } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";
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
  // The file sync above makes bytes durable; syncing the parent makes the
  // no-clobber directory entry durable on the Linux production host.
  await syncProductionExact0096EvidenceDirectory(config.evidenceDirectory);
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

export async function syncProductionExact0096EvidenceDirectory(
  directory,
  { openDirectory = open, platform = process.platform } = {},
) {
  const directoryHandle = await openDirectory(directory, "r");
  try {
    if (platform !== "win32") await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
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
  let terminalErrorObserved = false;
  let closed = false;
  let closing = false;
  let stderr = "";
  let killTimer;
  let stdoutLineBytes = 0;
  const stdoutLine = Buffer.allocUnsafe(
    PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
  );
  let responseExpected = false;
  const responseLines = [];
  const waiters = [];
  const rejectWaiters = (error) => {
    terminalError = terminalError ?? error;
    while (waiters.length > 0) {
      terminalErrorObserved = true;
      waiters.shift().reject(terminalError);
    }
  };
  const poison = (error) => {
    const firstFailure = terminalError === null;
    rejectWaiters(error);
    if (!closed && firstFailure) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    }
  };
  const deliverResponse = (line) => {
    if (terminalError) return;
    if (!responseExpected) {
      poison(
        new ProductionExact0096HostAdapterError(
          "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
          "Long-lived producer emitted a surplus response line.",
        ),
      );
      return;
    }
    responseExpected = false;
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(line);
      return;
    }
    if (responseLines.length === 0) {
      responseLines.push(line);
      return;
    }
    poison(
      new ProductionExact0096HostAdapterError(
        "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
        "Long-lived producer emitted surplus response lines.",
      ),
    );
  };
  child.stdout.on("data", (chunk) => {
    if (terminalError) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segmentBytes = end - offset;
      const nextLineBytes = stdoutLineBytes + segmentBytes;
      const completeBytes = nextLineBytes + (newline === -1 ? 0 : 1);
      if (
        completeBytes > PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES ||
        (newline === -1 &&
          nextLineBytes >= PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES)
      ) {
        poison(
          new ProductionExact0096HostAdapterError(
            "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
            "Long-lived producer response exceeded the reviewed byte boundary.",
          ),
        );
        return;
      }
      if (segmentBytes > 0) {
        bytes.copy(stdoutLine, stdoutLineBytes, offset, end);
        stdoutLineBytes = nextLineBytes;
      }
      if (newline === -1) return;
      stdoutLine[stdoutLineBytes] = 0x0a;
      const line = stdoutLine.subarray(0, stdoutLineBytes + 1).toString("utf8");
      stdoutLineBytes = 0;
      deliverResponse(line);
      if (terminalError) return;
      offset = newline + 1;
    }
  });
  child.stderr.on("data", (chunk) => {
    const remaining = 64 * 1024 - Buffer.byteLength(stderr);
    if (remaining > 0) {
      stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
    }
    poison(
      new ProductionExact0096HostAdapterError(
        "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
        "Long-lived producer emitted stderr.",
      ),
    );
  });
  child.once("error", () =>
    poison(
      new ProductionExact0096HostAdapterError(
        "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
        "Long-lived producer failed to start.",
      ),
    ),
  );
  const exited = new Promise((resolve) => {
    child.once("close", (code) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      const exitCode = Number(code ?? -1);
      if (
        exitCode !== 0 ||
        stderr !== "" ||
        waiters.length > 0 ||
        responseLines.length > 0 ||
        stdoutLineBytes > 0 ||
        responseExpected ||
        (!closing && terminalError === null)
      ) {
        rejectWaiters(
          new ProductionExact0096HostAdapterError(
            "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
            "Long-lived producer closed before a clean session shutdown.",
          ),
        );
      }
      resolve(exitCode);
    });
  });
  const abortSession = () => {
    poison(
      new ProductionExact0096HostAdapterError(
        "PRODUCTION_BACKUP_HOST_SESSION_ABORTED",
        "Long-lived producer was aborted.",
      ),
    );
  };
  signal.addEventListener("abort", abortSession, { once: true });

  const nextResponse = () => {
    if (terminalError) {
      terminalErrorObserved = true;
      return Promise.reject(terminalError);
    }
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
        responseExpected = true;
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
        responseExpected = false;
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
      const cleanupAfterTerminalFailure =
        terminalError !== null && terminalErrorObserved;
      closing = true;
      if (!closed) child.stdin.end();
      let timer;
      let exitCode;
      try {
        [exitCode] = await Promise.race([
          Promise.all([exited, sequence]),
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
        ]);
      } finally {
        signal.removeEventListener("abort", abortSession);
        if (timer) clearTimeout(timer);
      }
      if (
        !cleanupAfterTerminalFailure &&
        (exitCode !== 0 || stderr !== "" || terminalError !== null)
      ) {
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
  { activation, hostHandlers, hostSignal, producerHandlers },
) {
  const config = exactConfig(rawConfig);
  if (activation !== PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION) {
    fail(
      "PRODUCTION_BACKUP_HOST_COMPOSITE_DARK",
      "The composite stays dark without the exact reviewed activation binding.",
    );
  }
  if (
    typeof hostHandlers !== "function" ||
    !(hostSignal instanceof AbortSignal) ||
    hostSignal.aborted
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_HANDLERS_INVALID",
      "Host handlers must be a factory bound to the live internal AbortSignal.",
    );
  }
  const host = exactHandlerSet(
    hostHandlers(hostSignal),
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
  let overallTimedOut = false;
  const deadline = setTimeout(() => {
    overallTimedOut = true;
    controller.abort(new Error("PRODUCTION_BACKUP_OVERALL_TIMEOUT"));
  }, overallTimeoutMs);
  deadline.unref();
  let session;
  let result;
  let primaryError;
  let rejectForAbort;
  let executionSettlement;
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
        {
          activation,
          hostHandlers,
          hostSignal: controller.signal,
          producerHandlers: session.handlers,
        },
      ),
    });
    executionSettlement = execution.then(
      () => undefined,
      () => undefined,
    );
    const aborted = new Promise((_, reject) => {
      rejectForAbort = () =>
        reject(
          new ProductionExact0096HostAdapterError(
            overallTimedOut
              ? "PRODUCTION_BACKUP_OVERALL_TIMEOUT"
              : "PRODUCTION_BACKUP_HOST_SESSION_ABORTED",
            overallTimedOut
              ? "The complete backup/restore executor exceeded its reviewed deadline."
              : "The complete backup/restore executor was aborted.",
          ),
        );
      controller.signal.addEventListener("abort", rejectForAbort, {
        once: true,
      });
      if (controller.signal.aborted) rejectForAbort();
    });
    result = await Promise.race([execution, aborted]);
  } catch (error) {
    primaryError = error;
  }
  clearTimeout(deadline);
  signal.removeEventListener("abort", abort);
  if (rejectForAbort) {
    controller.signal.removeEventListener("abort", rejectForAbort);
  }
  if (controller.signal.aborted && executionSettlement) {
    let settlementTimer;
    try {
      await Promise.race([
        executionSettlement,
        new Promise((_, reject) => {
          settlementTimer = setTimeout(
            () =>
              reject(
                new ProductionExact0096HostAdapterError(
                  "PRODUCTION_BACKUP_HOST_SETTLEMENT_TIMEOUT",
                  "Aborted host execution did not settle within the reviewed boundary.",
                ),
              ),
            exactConfig(config).timeoutMs,
          );
          settlementTimer.unref();
        }),
      ]);
    } catch (error) {
      primaryError = error;
    } finally {
      if (settlementTimer) clearTimeout(settlementTimer);
    }
  }
  let closeError;
  try {
    await session?.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  return result;
}
