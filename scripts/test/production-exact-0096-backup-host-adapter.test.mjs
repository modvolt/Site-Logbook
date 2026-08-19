import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
  canonicalProductionExact0096BackupJson,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";
import {
  PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
  createProductionExact0096BackupHostDependencies,
  createProductionExact0096BackupLongLivedHostSession,
  runProductionExact0096BackupWithLongLivedHostSession,
  syncProductionExact0096EvidenceDirectory,
} from "../production-evidence/production-exact-0096-backup-host-adapter.mjs";
import { createProductionExact0096BackupPlan } from "../production-evidence/production-exact-0096-backup-planner.mjs";
import {
  fixtureExecutorDependencies,
  fixturePlanInput,
} from "./production-exact-0096-backup-contract-fixtures.mjs";

const id = "1".repeat(64);

test("host adapter stays dark and executes no command without exact activation", () => {
  let called = false;
  assert.throws(
    () =>
      createProductionExact0096BackupHostDependencies(
        { activated: false },
        {
          invocationId: id,
          signal: new AbortController().signal,
          execFile: async () => {
            called = true;
          },
        },
      ),
    /ADAPTER_DARK/,
  );
  assert.equal(called, false);
});

test("host adapter uses fixed docker exec argv, bounded canonical output and no shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-adapter-"));
  const hostRequestDirectory = join(root, "requests");
  const evidenceDirectory = join(root, "evidence");
  const calls = [];
  const execFile = async (...args) => {
    calls.push(args);
    return {
      stdout: canonicalProductionExact0096BackupJson({
        invocationId: id,
      }),
      stderr: "",
    };
  };
  try {
    const dependencies = createProductionExact0096BackupHostDependencies(
      {
        activated: true,
        controlPlaneContainerId: "2".repeat(64),
        containerRequestDirectory: "/run/site-logbook-production-backup",
        evidenceDirectory,
        hostRequestDirectory,
        producerEntrypoint:
          "/app/dist/production-exact-0096-backup-producer.mjs",
        timeoutMs: 60_000,
      },
      { invocationId: id, signal: new AbortController().signal, execFile },
    );
    const output = await dependencies.observeExecutorIdentity({
      planSha256: `sha256:${"a".repeat(64)}`,
    });
    assert.equal(JSON.parse(output).invocationId, id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "docker");
    assert.deepEqual(calls[0][1].slice(0, 5), [
      "container",
      "exec",
      "2".repeat(64),
      "node",
      "/app/dist/production-exact-0096-backup-producer.mjs",
    ]);
    assert.equal(calls[0][1][5], "observeExecutorIdentity");
    assert.equal(calls[0][2].shell, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive persistence proves store identity and exact readback and never clobbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-persist-"));
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 60_000,
  };
  const canonical = canonicalProductionExact0096BackupJson({ safe: true });
  try {
    const dependencies = createProductionExact0096BackupHostDependencies(
      config,
      {
        invocationId: id,
        signal: new AbortController().signal,
        execFile: async () => {
          throw new Error("no command expected");
        },
      },
    );
    const ack = JSON.parse(
      await dependencies.emitCanonicalExecutorTraceExclusive({
        traceCanonical: canonical,
      }),
    );
    assert.equal(ack.persistedExclusive, true);
    assert.equal(ack.existingTargetObserved, false);
    assert.equal(ack.canonicalReadbackBytes, Buffer.byteLength(canonical));
    assert.equal(ack.artifactSha256, ack.canonicalReadbackSha256);
    assert.match(ack.storageIdentitySha256, /^sha256:[0-9a-f]{64}$/);
    await assert.rejects(
      () =>
        dependencies.emitCanonicalExecutorTraceExclusive({
          traceCanonical: canonical,
        }),
      /EEXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux evidence persistence fsyncs and closes the parent directory handle", async () => {
  const calls = [];
  await syncProductionExact0096EvidenceDirectory("/evidence", {
    platform: "linux",
    openDirectory: async (path, flags) => {
      calls.push(["open", path, flags]);
      return {
        async sync() {
          calls.push(["sync"]);
        },
        async close() {
          calls.push(["close"]);
        },
      };
    },
  });
  assert.deepEqual(calls, [["open", "/evidence", "r"], ["sync"], ["close"]]);
});

test("long-lived adapter uses one interactive producer for sequential operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-session-"));
  const spawnCalls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let pending = "";
  child.stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    while (pending.includes("\n")) {
      const offset = pending.indexOf("\n");
      const command = JSON.parse(pending.slice(0, offset));
      pending = pending.slice(offset + 1);
      child.stdout.write(
        canonicalProductionExact0096BackupJson({
          operation: command.operation,
          retainedProcess: true,
        }),
      );
    }
  });
  child.stdin.on("finish", () => {
    child.stdout.end();
    queueMicrotask(() => child.emit("close", 0));
  });
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 60_000,
  };
  try {
    const session = createProductionExact0096BackupLongLivedHostSession(
      config,
      {
        invocationId: id,
        signal: new AbortController().signal,
        spawn: (file, args, options) => {
          spawnCalls.push({ file, args, options });
          return child;
        },
      },
    );
    const first = JSON.parse(
      await session.handlers.openExportedReadOnlySnapshot({
        transactionMode: "repeatable-read-read-only",
      }),
    );
    const second = JSON.parse(
      await session.handlers.readFrozenRelationManifestMeasurements({
        snapshotHandleId: "8".repeat(64),
      }),
    );
    assert.equal(first.retainedProcess, true);
    assert.equal(second.retainedProcess, true);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args.slice(-3), [
      "node",
      "/app/dist/production-exact-0096-backup-producer.mjs",
      "--session",
    ]);
    assert.equal(spawnCalls[0].args.includes("--interactive"), true);
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite routes six host and five process-owned operations through one hermetic run", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-composite-"));
  const hostRequestDirectory = join(root, "requests");
  const evidenceDirectory = join(root, "evidence");
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const fixtures = fixtureExecutorDependencies(plan);
  const hostOperations = [
    "observeExecutorIdentity",
    "observeImmutableProductionSourceReadOnly",
    "proveProductionWritersStopped",
    "restoreIntoNewDisposablePostgres16",
    "observeRestoredJournalSchemaAndContentReadOnly",
    "reobserveProductionSourceReadOnly",
  ];
  const producerOperations = [
    "openExportedReadOnlySnapshot",
    "readFrozenRelationManifestMeasurements",
    "createBoundedPgDumpCustom",
    "encryptAndPersistVersionedPayload",
    "headExactVersionedPayloadReadOnly",
  ];
  const routed = [];
  const outerController = new AbortController();
  let boundHostSignal;
  const hostHandlers = (hostSignal) => {
    boundHostSignal = hostSignal;
    return Object.fromEntries(
      hostOperations.map((operation) => [
        operation,
        async (input) => {
          routed.push(`host:${operation}`);
          return fixtures[operation](input);
        },
      ]),
    );
  };
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let childClosed = false;
  const closeChild = (code) => {
    if (childClosed) return;
    childClosed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", code));
  };
  child.kill = () => {
    closeChild(143);
    return true;
  };
  let cleanCloseCount = 0;
  let pending = "";
  child.stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    while (pending.includes("\n")) {
      const offset = pending.indexOf("\n");
      const command = JSON.parse(pending.slice(0, offset));
      pending = pending.slice(offset + 1);
      routed.push(`producer:${command.operation}`);
      void (async () => {
        try {
          const request = JSON.parse(
            await readFile(
              join(hostRequestDirectory, basename(command.requestPath)),
              "utf8",
            ),
          );
          child.stdout.write(await fixtures[command.operation](request));
        } catch {
          child.stderr.write("fixture producer failed\n");
          closeChild(1);
        }
      })();
    }
  });
  child.stdin.on("finish", () => {
    cleanCloseCount += 1;
    closeChild(0);
  });
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory,
    hostRequestDirectory,
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 5_000,
  };
  try {
    const result = await runProductionExact0096BackupWithLongLivedHostSession({
      planCanonical: plan.canonical,
      config,
      invocationId: id,
      signal: outerController.signal,
      spawn: () => child,
      activation: PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
      hostHandlers,
      overallTimeoutMs: 10_000,
    });
    assert.equal(result.receipt.value.decision, "PASS");
    assert.ok(boundHostSignal instanceof AbortSignal);
    assert.notEqual(boundHostSignal, outerController.signal);
    assert.deepEqual(routed, [
      "host:observeExecutorIdentity",
      "host:observeImmutableProductionSourceReadOnly",
      "host:proveProductionWritersStopped",
      ...producerOperations.map((operation) => `producer:${operation}`),
      "host:restoreIntoNewDisposablePostgres16",
      "host:observeRestoredJournalSchemaAndContentReadOnly",
      "host:reobserveProductionSourceReadOnly",
    ]);
    assert.equal(cleanCloseCount, 1);
    assert.deepEqual(await readdir(hostRequestDirectory), []);
    assert.equal((await readdir(evidenceDirectory)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overall deadline poisons one producer, closes it and removes the in-flight request without masking timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-timeout-"));
  const hostRequestDirectory = join(root, "requests");
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const fixtures = fixtureExecutorDependencies(plan);
  const hostOperations = [
    "observeExecutorIdentity",
    "observeImmutableProductionSourceReadOnly",
    "proveProductionWritersStopped",
    "restoreIntoNewDisposablePostgres16",
    "observeRestoredJournalSchemaAndContentReadOnly",
    "reobserveProductionSourceReadOnly",
  ];
  const hostHandlers = () =>
    Object.fromEntries(
      hostOperations.map((operation) => [operation, fixtures[operation]]),
    );
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const kills = [];
  let closeCount = 0;
  child.kill = (signal) => {
    kills.push(signal);
    queueMicrotask(() => {
      if (closeCount === 0) {
        closeCount += 1;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 143);
      }
    });
    return true;
  };
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory,
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 5_000,
  };
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        runProductionExact0096BackupWithLongLivedHostSession({
          planCanonical: plan.canonical,
          config,
          invocationId: id,
          signal: new AbortController().signal,
          spawn: () => child,
          activation: PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
          hostHandlers,
          overallTimeoutMs: 1_000,
        }),
      (error) => error?.code === "PRODUCTION_BACKUP_OVERALL_TIMEOUT",
    );
    assert.ok(Date.now() - startedAt < 3_000);
    assert.deepEqual(kills, ["SIGTERM"]);
    assert.equal(closeCount, 1);
    assert.deepEqual(await readdir(hostRequestDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overall deadline aborts and settles the signal-bound host operation before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-bound-timeout-"));
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const fixtures = fixtureExecutorDependencies(plan);
  const hostOperations = [
    "observeExecutorIdentity",
    "observeImmutableProductionSourceReadOnly",
    "proveProductionWritersStopped",
    "restoreIntoNewDisposablePostgres16",
    "observeRestoredJournalSchemaAndContentReadOnly",
    "reobserveProductionSourceReadOnly",
  ];
  let hostStarted = false;
  let hostAbortObserved = false;
  let hostCompletionCount = 0;
  const outerController = new AbortController();
  const hostHandlers = (hostSignal) =>
    Object.fromEntries(
      hostOperations.map((operation) => [
        operation,
        operation === "observeExecutorIdentity"
          ? async (input) =>
              new Promise((resolve, reject) => {
                hostStarted = true;
                hostSignal.addEventListener(
                  "abort",
                  () => {
                    hostAbortObserved = true;
                    setTimeout(async () => {
                      try {
                        const result = await fixtures[operation](input);
                        hostCompletionCount += 1;
                        resolve(result);
                      } catch (error) {
                        reject(error);
                      }
                    }, 50);
                  },
                  { once: true },
                );
              })
          : async (input) => {
              const result = await fixtures[operation](input);
              hostCompletionCount += 1;
              return result;
            },
      ]),
    );
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let childClosed = false;
  child.kill = () => {
    if (!childClosed) {
      childClosed = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 143));
    }
    return true;
  };
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 1_000,
  };
  try {
    await assert.rejects(
      () =>
        runProductionExact0096BackupWithLongLivedHostSession({
          planCanonical: plan.canonical,
          config,
          invocationId: id,
          signal: outerController.signal,
          spawn: () => child,
          activation: PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
          hostHandlers,
          overallTimeoutMs: 1_000,
        }),
      (error) => error?.code === "PRODUCTION_BACKUP_OVERALL_TIMEOUT",
    );
    assert.equal(hostStarted, true);
    assert.equal(hostAbortObserved, true);
    assert.ok(hostCompletionCount > 0);
    assert.equal(childClosed, true);
    const completionsAtReturn = hostCompletionCount;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(hostCompletionCount, completionsAtReturn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-lived adapter rejects stdout at the byte boundary before a newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-stdout-bound-"));
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const kills = [];
  let closed = false;
  child.kill = (signal) => {
    kills.push(signal);
    if (!closed) {
      closed = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 143));
    }
    return true;
  };
  child.stdin.once("data", () => {
    child.stdout.write(
      Buffer.alloc(PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES, 0x61),
    );
  });
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 5_000,
  };
  try {
    const session = createProductionExact0096BackupLongLivedHostSession(
      config,
      {
        invocationId: id,
        signal: new AbortController().signal,
        spawn: () => child,
      },
    );
    await assert.rejects(
      () => session.handlers.openExportedReadOnlySnapshot({ safe: true }),
      (error) => error?.code === "PRODUCTION_BACKUP_HOST_OUTPUT_INVALID",
    );
    await session.close();
    assert.deepEqual(kills, ["SIGTERM"]);
    assert.deepEqual(await readdir(config.hostRequestDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-lived adapter rejects one surplus response line on clean close", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-surplus-line-"));
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  const closeChild = (code) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", code));
  };
  child.kill = () => {
    closeChild(143);
    return true;
  };
  child.stdin.once("data", () => {
    child.stdout.write(canonicalProductionExact0096BackupJson({ safe: true }));
  });
  child.stdin.on("finish", () => {
    closeChild(0);
  });
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 5_000,
  };
  try {
    const session = createProductionExact0096BackupLongLivedHostSession(
      config,
      {
        invocationId: id,
        signal: new AbortController().signal,
        spawn: () => child,
      },
    );
    await session.handlers.openExportedReadOnlySnapshot({ safe: true });
    child.stdout.write(canonicalProductionExact0096BackupJson({ extra: true }));
    await assert.rejects(
      () => session.close(),
      (error) => error?.code === "PRODUCTION_BACKUP_HOST_SESSION_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite setup failure still closes the producer before returning the fail-closed error", async () => {
  const root = await mkdtemp(join(tmpdir(), "prod-host-setup-failure-"));
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const fixtures = fixtureExecutorDependencies(plan);
  const hostOperations = [
    "observeExecutorIdentity",
    "observeImmutableProductionSourceReadOnly",
    "proveProductionWritersStopped",
    "restoreIntoNewDisposablePostgres16",
    "observeRestoredJournalSchemaAndContentReadOnly",
    "reobserveProductionSourceReadOnly",
  ];
  let hostHandlerFactoryCalls = 0;
  const hostHandlers = () => {
    hostHandlerFactoryCalls += 1;
    return Object.fromEntries(
      hostOperations.map((operation) => [operation, fixtures[operation]]),
    );
  };
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let closeCount = 0;
  child.stdin.on("finish", () => {
    closeCount += 1;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0));
  });
  const config = {
    activated: true,
    controlPlaneContainerId: "2".repeat(64),
    containerRequestDirectory: "/run/site-logbook-production-backup",
    evidenceDirectory: join(root, "evidence"),
    hostRequestDirectory: join(root, "requests"),
    producerEntrypoint: "/app/dist/production-exact-0096-backup-producer.mjs",
    timeoutMs: 5_000,
  };
  try {
    await assert.rejects(
      () =>
        runProductionExact0096BackupWithLongLivedHostSession({
          planCanonical: plan.canonical,
          config,
          invocationId: id,
          signal: new AbortController().signal,
          spawn: () => child,
          activation: "NOT_REVIEWED",
          hostHandlers,
          overallTimeoutMs: 10_000,
        }),
      (error) => error?.code === "PRODUCTION_BACKUP_HOST_COMPOSITE_DARK",
    );
    assert.equal(closeCount, 1);
    assert.equal(hostHandlerFactoryCalls, 0);
    await assert.rejects(
      () => readdir(config.hostRequestDirectory),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
