import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { createProductionExact0096BackupHostDependencies } from "../production-evidence/production-exact-0096-backup-host-adapter.mjs";

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
        apiContainerId: "2".repeat(64),
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
    apiContainerId: "2".repeat(64),
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
