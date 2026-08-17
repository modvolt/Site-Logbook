import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { createProductionMigrationDockerRuntimeAuthority } from "../production-evidence/production-migration-docker-runtime-authority.mjs";
import { fixtureProductionRuntimeBinding } from "./production-exact-0096-backup-contract-fixtures.mjs";

function projections(binding) {
  const volumeLabels = {};
  binding.volumeLabelsSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(volumeLabels),
  );
  return {
    container: {
      Id: binding.containerId,
      Image: binding.postgresImageId,
      Config: {
        Image: binding.postgresImageRef,
        Labels: {
          "io.modvolt.site-logbook.resolved-config-sha256":
            binding.resolvedConfigSha256,
          "io.modvolt.site-logbook.deployment-config-sha256":
            binding.deploymentConfigSha256,
        },
      },
      State: { Status: "running" },
      Mounts: [{ Type: "volume", Name: binding.volumeName }],
      NetworkSettings: {
        Networks: {
          [binding.networkName]: { NetworkID: binding.networkId },
        },
      },
    },
    postgresImage: {
      Id: binding.postgresImageId,
      RepoDigests: [binding.postgresImageRef],
      Labels: {},
    },
    applicationImage: {
      Id: `sha256:${"9".repeat(64)}`,
      RepoDigests: [binding.applicationImageRef],
      Labels: { "org.opencontainers.image.revision": binding.sourceSha },
    },
    volume: {
      Name: binding.volumeName,
      CreatedAt: binding.volumeCreatedAt,
      Labels: volumeLabels,
    },
    network: {
      Id: binding.networkId,
      Name: binding.networkName,
      Containers: { [binding.containerId]: {} },
    },
  };
}

function fakeDocker(binding, { driftAtCall } = {}) {
  const values = projections(binding);
  const calls = [];
  return {
    calls,
    async execFile(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(command, "docker");
      assert.equal(options.signal instanceof AbortSignal, true);
      let value;
      if (args[0] === "container") value = values.container;
      else if (args[0] === "image" && args.at(-1) === binding.postgresImageRef)
        value = values.postgresImage;
      else if (args[0] === "image") value = values.applicationImage;
      else if (args[0] === "volume") value = values.volume;
      else if (args[0] === "network") value = values.network;
      else throw new Error("unexpected Docker argv");
      const projected = structuredClone(value);
      if (calls.length === driftAtCall) projected.Name = "drifted";
      return { stdout: JSON.stringify(projected), stderr: "" };
    },
  };
}

test("source runtime authority uses only fixed inspect argv and returns exact non-authorizing observation", async () => {
  const binding = fixtureProductionRuntimeBinding();
  const docker = fakeDocker(binding);
  const authority = createProductionMigrationDockerRuntimeAuthority({
    execFile: docker.execFile,
    now: () => new Date("2026-08-17T10:00:00.000Z"),
  });
  const controller = new AbortController();
  const result = await authority.observeProductionMigrationRuntime({
    expectedRuntimeBindingCanonical:
      canonicalProductionExact0096BackupJson(binding),
    signal: controller.signal,
  });
  assert.equal(docker.calls.length, 10);
  assert.equal(
    docker.calls.every(
      ({ args }) =>
        ["container", "image", "volume", "network"].includes(args[0]) &&
        args[1] === "inspect" &&
        args[2] === "--format" &&
        args.length === 5,
    ),
    true,
  );
  assert.equal(result.value.authorizesProductionMigration, false);
  assert.equal(result.value.productionTargetsTouched, false);
  assert.deepEqual(result.value.runtimeBinding, binding);
});

test("runtime authority fails closed on re-observation drift and on a pre-aborted signal", async () => {
  const binding = fixtureProductionRuntimeBinding();
  const docker = fakeDocker(binding, { driftAtCall: 10 });
  const authority = createProductionMigrationDockerRuntimeAuthority({
    execFile: docker.execFile,
  });
  await assert.rejects(
    authority.observeProductionMigrationRuntime({
      expectedRuntimeBindingCanonical:
        canonicalProductionExact0096BackupJson(binding),
      signal: new AbortController().signal,
    }),
    { code: "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT" },
  );

  const controller = new AbortController();
  controller.abort(new Error("test abort"));
  const noIo = fakeDocker(fixtureProductionRuntimeBinding());
  await assert.rejects(
    createProductionMigrationDockerRuntimeAuthority({
      execFile: noIo.execFile,
    }).observeProductionMigrationRuntime({
      expectedRuntimeBindingCanonical: canonicalProductionExact0096BackupJson(
        fixtureProductionRuntimeBinding(),
      ),
      signal: controller.signal,
    }),
    { code: "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_ABORTED" },
  );
  assert.equal(noIo.calls.length, 0);
});
