import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import {
  PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
  createProductionExact0096BackupHostDependencies,
  createProductionExact0096BackupLongLivedHostSession,
  runProductionExact0096BackupWithLongLivedHostSession,
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
  const hostHandlers = Object.fromEntries(
    hostOperations.map((operation) => [
      operation,
      async (input) => {
        routed.push(`host:${operation}`);
        return fixtures[operation](input);
      },
    ]),
  );
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
      routed.push(`producer:${command.operation}`);
      void fixtures[command.operation]({}).then((canonical) =>
        child.stdout.write(canonical),
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
    timeoutMs: 5_000,
  };
  try {
    const result = await runProductionExact0096BackupWithLongLivedHostSession({
      planCanonical: plan.canonical,
      config,
      invocationId: id,
      signal: new AbortController().signal,
      spawn: () => child,
      activation: PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
      hostHandlers,
      overallTimeoutMs: 10_000,
    });
    assert.equal(result.receipt.value.decision, "PASS");
    assert.deepEqual(routed, [
      "host:observeExecutorIdentity",
      "host:observeImmutableProductionSourceReadOnly",
      "host:proveProductionWritersStopped",
      ...producerOperations.map((operation) => `producer:${operation}`),
      "host:restoreIntoNewDisposablePostgres16",
      "host:observeRestoredJournalSchemaAndContentReadOnly",
      "host:reobserveProductionSourceReadOnly",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
