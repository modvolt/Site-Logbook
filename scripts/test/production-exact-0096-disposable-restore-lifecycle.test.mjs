import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProductionExact0096DisposableRestoreLifecycle } from "../production-evidence/production-exact-0096-disposable-restore-lifecycle.mjs";

const invocationId = "1".repeat(64);
const suffix = invocationId.slice(0, 16);
const containerName = `slb-exact0096-${suffix}-postgres`;
const networkName = `slb-exact0096-${suffix}-network`;
const volumeName = `slb-exact0096-${suffix}-volume`;
const postgresImageRef = `docker.io/library/postgres@sha256:${"3".repeat(64)}`;
const executorImageRef = `ghcr.io/modvolt/site-logbook-api@sha256:${"2".repeat(64)}`;
const executorContainerId = "9".repeat(64);

function config(overrides = {}) {
  return {
    activated: true,
    executorContainerId,
    executorImageRef,
    invocationId,
    postgresImageRef,
    sourceContainerId: "4".repeat(64),
    sourceNetworkId: "5".repeat(64),
    sourceVolumeName: "site_logbook_postgres_data",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function successfulDocker(calls) {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2] === executorContainerId) {
        return {
          stdout: JSON.stringify([
            {
              Id: executorContainerId,
              Image: `sha256:${"a".repeat(64)}`,
              Config: { Image: executorImageRef },
            },
          ]),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([
          {
            Id: "6".repeat(64),
            Image: `sha256:${"7".repeat(64)}`,
            Config: { Image: postgresImageRef },
            HostConfig: { NetworkMode: networkName },
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const imageRef = args[2];
      return {
        stdout: JSON.stringify([
          {
            Id:
              imageRef === postgresImageRef
                ? `sha256:${"7".repeat(64)}`
                : `sha256:${"a".repeat(64)}`,
            RepoDigests: [imageRef],
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify([{ Id: "8".repeat(64), Internal: true }]),
        stderr: "",
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify([
          {
            Name: volumeName,
            CreatedAt: "2026-08-12T10:00:00.000Z",
            Labels: {
              "cz.modvolt.invocation": invocationId,
              "cz.modvolt.site-logbook.production-exact-0096-restore": "true",
            },
          },
        ]),
        stderr: "",
      };
    }
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
}

function successfulSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.once("finish", () =>
      queueMicrotask(() => child.emit("close", 0)),
    );
    return child;
  };
}

test("disposable restore lifecycle remains default-dark", async () => {
  let called = false;
  await assert.rejects(
    () =>
      createProductionExact0096DisposableRestoreLifecycle(
        { activated: false },
        { execFile: async () => (called = true) },
      ),
    /LIFECYCLE_DARK/,
  );
  assert.equal(called, false);
});

test("creates an internal, immutable-image, source-distinct restore and cleans every resource", async () => {
  const execCalls = [];
  const spawnCalls = [];
  const lifecycle = await createProductionExact0096DisposableRestoreLifecycle(
    config(),
    {
      execFile: successfulDocker(execCalls),
      spawn: successfulSpawn(spawnCalls),
      now: () => new Date("2026-08-12T10:01:00.000Z"),
    },
  );
  assert.equal(lifecycle.database.serverVersionMajor, 16);
  assert.equal(lifecycle.runtimeBinding.networkName, networkName);
  assert.equal(lifecycle.runtimeBinding.volumeName, volumeName);
  assert.notEqual(
    lifecycle.runtimeBinding.containerId,
    config().sourceContainerId,
  );
  assert.notEqual(lifecycle.runtimeBinding.networkId, config().sourceNetworkId);

  const networkCreate = execCalls.find(
    ({ args }) => args[0] === "network" && args[1] === "create",
  );
  assert.ok(networkCreate.args.includes("--internal"));
  const containerCreate = execCalls.find(
    ({ args }) => args[0] === "container" && args[1] === "create",
  );
  assert.ok(containerCreate.args.includes("--read-only"));
  assert.ok(containerCreate.args.includes("no-new-privileges=true"));
  assert.equal(
    containerCreate.args.filter((value) => value === "--cap-add").length,
    5,
  );
  for (const capability of [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "SETGID",
    "SETUID",
  ]) {
    assert.ok(containerCreate.args.includes(capability));
  }
  assert.equal(containerCreate.args.includes("NET_RAW"), false);
  assert.equal(containerCreate.args.includes("--publish"), false);
  assert.equal(containerCreate.args.includes(config().sourceVolumeName), false);
  assert.equal(containerCreate.args.at(-1), postgresImageRef);

  const restore = lifecycle.createPgRestoreDestination();
  restore.destination.end(Buffer.from("PGDMP", "ascii"));
  assert.deepEqual(await restore.completion, {
    exitCode: 0,
    completedAt: "2026-08-12T10:01:00.000Z",
  });
  assert.deepEqual(spawnCalls[0].args.slice(0, 4), [
    "container",
    "exec",
    "--interactive",
    containerName,
  ]);
  assert.equal(spawnCalls[0].args.includes("--exit-on-error"), true);
  await lifecycle.close();
  assert.equal(
    execCalls.some(({ args }) =>
      args.join(" ").includes(`container rm --force ${containerName}`),
    ),
    true,
  );
  assert.equal(
    execCalls.some(({ args }) => args.join(" ") === `volume rm ${volumeName}`),
    true,
  );
  assert.equal(
    execCalls.some(
      ({ args }) => args.join(" ") === `network rm ${networkName}`,
    ),
    true,
  );
});

test("rejects mutable PostgreSQL tags before Docker is invoked", async () => {
  let called = false;
  await assert.rejects(
    () =>
      createProductionExact0096DisposableRestoreLifecycle(
        config({ postgresImageRef: "postgres:16" }),
        { execFile: async () => (called = true) },
      ),
    /LIFECYCLE_INVALID/,
  );
  assert.equal(called, false);
});

test("removes exact disposable resources when restore exits non-zero", async () => {
  const execCalls = [];
  const lifecycle = await createProductionExact0096DisposableRestoreLifecycle(
    config(),
    {
      execFile: successfulDocker(execCalls),
      spawn: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        child.stdin.once("finish", () =>
          queueMicrotask(() => child.emit("close", 1)),
        );
        return child;
      },
    },
  );
  const restore = lifecycle.createPgRestoreDestination();
  restore.destination.end(Buffer.from("invalid", "ascii"));
  await assert.rejects(restore.completion, /PG_RESTORE_FAILED/);
  await lifecycle.close();
  assert.equal(
    execCalls.some(({ args }) =>
      args.join(" ").includes(`container rm --force ${containerName}`),
    ),
    true,
  );
  assert.equal(
    execCalls.some(({ args }) => args.join(" ") === `volume rm ${volumeName}`),
    true,
  );
  assert.equal(
    execCalls.some(
      ({ args }) => args.join(" ") === `network rm ${networkName}`,
    ),
    true,
  );
});
