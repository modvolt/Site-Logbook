import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { createProductionMigrationDockerRuntimeAuthority } from "../production-evidence/production-migration-docker-runtime-authority.mjs";
import {
  fixtureDigest,
  fixtureProductionRuntimeBinding,
} from "./production-exact-0096-backup-contract-fixtures.mjs";

const RESOLVED_CONFIG_LABEL = "io.modvolt.site-logbook.resolved-config-sha256";
const DEPLOYMENT_CONFIG_LABEL =
  "io.modvolt.site-logbook.deployment-config-sha256";
const SOURCE_SHA_LABEL = "org.opencontainers.image.revision";
const LEGACY_SOURCE_SHA = "6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5";
const LEGACY_PROJECT = "ef09696arga7h9ox6ojgv7ru";
const LEGACY_APPLICATION_REPOSITORY = `${LEGACY_PROJECT}_api`;
const LEGACY_POSTGRES_CONFIG_IMAGE = "postgres:16-alpine";
const LEGACY_VOLUME = `${LEGACY_PROJECT}_pgdata`;
const POSTGRES_DATA_DESTINATION = "/var/lib/postgresql/data";
const LEGACY_CONFIG_HASH =
  "a6b721760225d7b9ffe163067a8256c1bd7c87e7c30d8d972bba1d6adb8d847e";
const LEGACY_CONFIG_SURROGATE = `sha256:${LEGACY_CONFIG_HASH}`;

function labelsDigest(labels) {
  return productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(labels),
  );
}

function runtimeFixture(mode = "modern") {
  const binding = fixtureProductionRuntimeBinding();
  let volumeLabels = {};
  if (mode === "legacy") {
    Object.assign(binding, {
      sourceSha: LEGACY_SOURCE_SHA,
      applicationImageRef: `${LEGACY_APPLICATION_REPOSITORY}@${fixtureDigest("1")}`,
      postgresImageRef: `postgres@${fixtureDigest("3")}`,
      volumeName: LEGACY_VOLUME,
      networkName: LEGACY_PROJECT,
      resolvedConfigSha256: LEGACY_CONFIG_SURROGATE,
      deploymentConfigSha256: LEGACY_CONFIG_SURROGATE,
    });
    volumeLabels = {
      "com.docker.compose.project": LEGACY_PROJECT,
      "com.docker.compose.volume": LEGACY_VOLUME,
    };
  }
  binding.volumeLabelsSha256 = labelsDigest(volumeLabels);
  const values = {
    container: {
      Id: binding.containerId,
      Image: binding.postgresImageId,
      Config: {
        Image:
          mode === "legacy"
            ? LEGACY_POSTGRES_CONFIG_IMAGE
            : binding.postgresImageRef,
        Labels:
          mode === "legacy"
            ? {
                "com.docker.compose.project": LEGACY_PROJECT,
                "com.docker.compose.service": "postgres",
                "com.docker.compose.oneoff": "False",
                "com.docker.compose.container-number": "1",
                "com.docker.compose.config-hash": LEGACY_CONFIG_HASH,
                "coolify.managed": "true",
                "coolify.applicationId": "5",
              }
            : {
                [RESOLVED_CONFIG_LABEL]: binding.resolvedConfigSha256,
                [DEPLOYMENT_CONFIG_LABEL]: binding.deploymentConfigSha256,
              },
      },
      State: { Status: "running" },
      Mounts: [
        {
          Type: "volume",
          Name: binding.volumeName,
          Destination: POSTGRES_DATA_DESTINATION,
          RW: true,
        },
      ],
      NetworkSettings: {
        Networks: {
          [binding.networkName]: { NetworkID: binding.networkId },
        },
      },
    },
    postgresImage: {
      Id: binding.postgresImageId,
      RepoDigests: [binding.postgresImageRef],
      RepoTags: mode === "legacy" ? [LEGACY_POSTGRES_CONFIG_IMAGE] : undefined,
      Labels: null,
    },
    applicationImage: {
      Id: `sha256:${"9".repeat(64)}`,
      RepoDigests: [binding.applicationImageRef],
      RepoTags:
        mode === "legacy"
          ? [`${LEGACY_APPLICATION_REPOSITORY}:${LEGACY_SOURCE_SHA}`]
          : undefined,
      Labels:
        mode === "legacy" ? null : { [SOURCE_SHA_LABEL]: binding.sourceSha },
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
  return { binding, values };
}

function fakeDocker(binding, values, { driftAtCall } = {}) {
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
      if (calls.length === driftAtCall) projected.observationDrift = true;
      return { stdout: JSON.stringify(projected), stderr: "" };
    },
  };
}

async function observe(fixture, options = {}) {
  const docker = fakeDocker(fixture.binding, fixture.values, options);
  const authority = createProductionMigrationDockerRuntimeAuthority({
    execFile: docker.execFile,
    now: () => new Date("2026-08-17T10:00:00.000Z"),
  });
  const result = await authority.observeProductionMigrationRuntime({
    expectedRuntimeBindingCanonical: canonicalProductionExact0096BackupJson(
      fixture.binding,
    ),
    signal: new AbortController().signal,
  });
  return { docker, result };
}

async function rejectsDrift(fixture) {
  await assert.rejects(observe(fixture), {
    code: "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
  });
}

test("modern runtime authority uses only fixed inspect argv and returns exact non-authorizing observation", async () => {
  const fixture = runtimeFixture("modern");
  const { docker, result } = await observe(fixture);
  assert.equal(docker.calls.length, 10);
  assert.equal(
    docker.calls.every(
      ({ args }) =>
        ["container", "image", "volume", "network"].includes(args[0]) &&
        args[1] === "inspect" &&
        args[2] === "--format" &&
        args.length === 5 &&
        !args[3].includes(".Config.Env") &&
        !args[3].includes("HostConfig"),
    ),
    true,
  );
  const containerProjection = docker.calls[0].args[3];
  const imageProjection = docker.calls[1].args[3];
  assert.match(containerProjection, /Config\.Labels/);
  assert.match(imageProjection, /RepoTags/);
  assert.match(imageProjection, /index \.Config "Labels"/);
  assert.equal(typeof result, "string");
  const observation = JSON.parse(result);
  assert.equal(result, canonicalProductionExact0096BackupJson(observation));
  assert.equal(observation.authorizesProductionMigration, false);
  assert.equal(observation.productionTargetsTouched, false);
  assert.deepEqual(observation.runtimeBinding, fixture.binding);
});

test("exact frozen legacy runtime is accepted only through the one-time surrogate branch", async () => {
  const fixture = runtimeFixture("legacy");
  const { result } = await observe(fixture);
  const observation = JSON.parse(result);
  assert.equal(observation.authorizesProductionMigration, false);
  assert.deepEqual(observation.runtimeBinding, fixture.binding);
  assert.equal(
    fixture.binding.resolvedConfigSha256,
    fixture.binding.deploymentConfigSha256,
  );
  assert.equal(fixture.binding.resolvedConfigSha256, LEGACY_CONFIG_SURROGATE);
});

test("bounded pre-outage production snapshot is rejected while writer peers remain", async () => {
  const fixture = runtimeFixture("legacy");
  const volumeLabels = {
    "com.docker.compose.config-hash":
      "685679d53d058ddb549fac5df953a7c8b850ba311b07df50a42349510931a60c",
    "com.docker.compose.project": LEGACY_PROJECT,
    "com.docker.compose.version": "2.38.2",
    "com.docker.compose.volume": LEGACY_VOLUME,
  };
  Object.assign(fixture.binding, {
    applicationImageRef: `${LEGACY_APPLICATION_REPOSITORY}@sha256:0c9f06b6a4e8cbcb7aca94909db9c5e458fbb9d351d4dc2c8a66e8cbaaec15ea`,
    containerId:
      "e64ff65ef8af214a7c8c6be710cc42f03f957cfe46135411c743bde464e79a7a",
    postgresImageRef:
      "postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb",
    postgresImageId:
      "sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb",
    volumeCreatedAt: "2026-05-31T10:28:27.000Z",
    volumeLabelsSha256: labelsDigest(volumeLabels),
    networkId:
      "9532b7bf73d23956f07e07bea4f9c7a4d950346f7cbe812de66678ef97dc549d",
  });
  fixture.values.container.Id = fixture.binding.containerId;
  fixture.values.container.Image = fixture.binding.postgresImageId;
  fixture.values.container.Mounts[0].Name = fixture.binding.volumeName;
  fixture.values.container.NetworkSettings.Networks = {
    [fixture.binding.networkName]: { NetworkID: fixture.binding.networkId },
  };
  fixture.values.postgresImage.Id = fixture.binding.postgresImageId;
  fixture.values.postgresImage.RepoDigests = [fixture.binding.postgresImageRef];
  fixture.values.applicationImage.Id =
    "sha256:0c9f06b6a4e8cbcb7aca94909db9c5e458fbb9d351d4dc2c8a66e8cbaaec15ea";
  fixture.values.applicationImage.RepoDigests = [
    fixture.binding.applicationImageRef,
  ];
  fixture.values.volume.CreatedAt = "2026-05-31T10:28:27Z";
  fixture.values.volume.Labels = volumeLabels;
  fixture.values.network.Id = fixture.binding.networkId;
  fixture.values.network.Containers = Object.fromEntries(
    [
      "267bc8cd08f81aa0f199a15da31d7c45c9950b6cf0a47e611c65461ed27d869b",
      "318c403d2ae4af0b65c4ddbf81c20e3c4d50c375ff49eb2dd437efe555294cac",
      "b101040f2963817b1e672c527a6177921fb0b082f4efbf58600f963c65ce593a",
      "d74cecdc1c79ed6ea03fa701e6c54cc13c2f5a8f6e3445fd0625d439e853abe3",
      fixture.binding.containerId,
    ].map((id) => [id, {}]),
  );
  assert.equal(
    fixture.binding.volumeLabelsSha256,
    "sha256:31a07c6092f3e0e76e07b6b77e0b2f303e9cf37742c393c75de47a66887085a4",
  );

  await rejectsDrift(fixture);
});

test("legacy branch rejects partial modern labels and every frozen Compose/Coolify guard drift", async (t) => {
  const cases = [
    [
      "partial resolved label",
      ({ values }) => {
        values.container.Config.Labels[RESOLVED_CONFIG_LABEL] =
          LEGACY_CONFIG_SURROGATE;
      },
    ],
    [
      "partial deployment label",
      ({ values }) => {
        values.container.Config.Labels[DEPLOYMENT_CONFIG_LABEL] =
          LEGACY_CONFIG_SURROGATE;
      },
    ],
    [
      "wrong modern labels",
      ({ values }) => {
        values.container.Config.Labels[RESOLVED_CONFIG_LABEL] =
          fixtureDigest("d");
        values.container.Config.Labels[DEPLOYMENT_CONFIG_LABEL] =
          fixtureDigest("e");
      },
    ],
    [
      "source",
      ({ binding, values }) => {
        binding.sourceSha = "b".repeat(40);
        values.applicationImage.RepoTags = [
          `${LEGACY_APPLICATION_REPOSITORY}:${binding.sourceSha}`,
        ];
      },
    ],
    [
      "application repository",
      ({ binding, values }) => {
        binding.applicationImageRef = `foreign_api@${fixtureDigest("1")}`;
        values.applicationImage.RepoDigests = [binding.applicationImageRef];
        values.applicationImage.RepoTags = [`foreign_api:${binding.sourceSha}`];
      },
    ],
    [
      "application source tag",
      ({ values }) => {
        values.applicationImage.RepoTags = [
          `${LEGACY_APPLICATION_REPOSITORY}:${"b".repeat(40)}`,
        ];
      },
    ],
    [
      "additional application tag",
      ({ values }) => {
        values.applicationImage.RepoTags.push(
          `${LEGACY_APPLICATION_REPOSITORY}:${"b".repeat(40)}`,
        );
      },
    ],
    [
      "conflicting application revision",
      ({ values }) => {
        values.applicationImage.Labels = {
          [SOURCE_SHA_LABEL]: LEGACY_SOURCE_SHA,
        };
      },
    ],
    [
      "PostgreSQL repository",
      ({ binding, values }) => {
        binding.postgresImageRef = `foreign-postgres@${fixtureDigest("3")}`;
        values.postgresImage.RepoDigests = [binding.postgresImageRef];
        values.container.Config.Image = "foreign-postgres:16-alpine";
        values.postgresImage.RepoTags = [values.container.Config.Image];
      },
    ],
    [
      "PostgreSQL configured tag",
      ({ values }) => {
        values.container.Config.Image = "postgres:16";
        values.postgresImage.RepoTags = [values.container.Config.Image];
      },
    ],
    [
      "additional PostgreSQL tag",
      ({ values }) => {
        values.postgresImage.RepoTags.push("postgres:latest");
      },
    ],
    [
      "project label",
      ({ values }) => {
        values.container.Config.Labels["com.docker.compose.project"] =
          "foreign";
      },
    ],
    [
      "service label",
      ({ values }) => {
        values.container.Config.Labels["com.docker.compose.service"] = "api";
      },
    ],
    [
      "oneoff label",
      ({ values }) => {
        values.container.Config.Labels["com.docker.compose.oneoff"] = "True";
      },
    ],
    [
      "container-number label",
      ({ values }) => {
        values.container.Config.Labels["com.docker.compose.container-number"] =
          "2";
      },
    ],
    [
      "service config hash",
      ({ values }) => {
        values.container.Config.Labels["com.docker.compose.config-hash"] =
          "b".repeat(64);
      },
    ],
    [
      "Coolify managed label",
      ({ values }) => {
        values.container.Config.Labels["coolify.managed"] = "false";
      },
    ],
    [
      "Coolify application label",
      ({ values }) => {
        values.container.Config.Labels["coolify.applicationId"] = "6";
      },
    ],
    [
      "resolved surrogate",
      ({ binding }) => {
        binding.resolvedConfigSha256 = fixtureDigest("d");
      },
    ],
    [
      "deployment surrogate",
      ({ binding }) => {
        binding.deploymentConfigSha256 = fixtureDigest("d");
      },
    ],
    [
      "network name",
      ({ binding, values }) => {
        delete values.container.NetworkSettings.Networks[binding.networkName];
        binding.networkName = "foreign-network";
        values.container.NetworkSettings.Networks[binding.networkName] = {
          NetworkID: binding.networkId,
        };
        values.network.Name = binding.networkName;
      },
    ],
    [
      "volume name",
      ({ binding, values }) => {
        binding.volumeName = "foreign-volume";
        values.container.Mounts[0].Name = binding.volumeName;
        values.volume.Name = binding.volumeName;
        values.volume.Labels["com.docker.compose.volume"] = binding.volumeName;
        binding.volumeLabelsSha256 = labelsDigest(values.volume.Labels);
      },
    ],
    [
      "volume project label",
      ({ binding, values }) => {
        values.volume.Labels["com.docker.compose.project"] = "foreign";
        binding.volumeLabelsSha256 = labelsDigest(values.volume.Labels);
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = runtimeFixture("legacy");
      mutate(fixture);
      await rejectsDrift(fixture);
    });
  }
});

test("modern branch rejects individual runtime identity drift", async (t) => {
  const cases = [
    [
      "container ID",
      ({ values }) => {
        values.container.Id = "f".repeat(64);
      },
    ],
    [
      "container image ID",
      ({ values }) => {
        values.container.Image = fixtureDigest("f");
      },
    ],
    [
      "PostgreSQL Config.Image",
      ({ values }) => {
        values.container.Config.Image = "postgres:16-alpine";
      },
    ],
    [
      "container status",
      ({ values }) => {
        values.container.State.Status = "exited";
      },
    ],
    [
      "volume mount",
      ({ values }) => {
        values.container.Mounts = [];
      },
    ],
    [
      "volume mount destination",
      ({ values }) => {
        values.container.Mounts[0].Destination = "/tmp/not-pgdata";
      },
    ],
    [
      "read-only volume mount",
      ({ values }) => {
        values.container.Mounts[0].RW = false;
      },
    ],
    [
      "competing PGDATA mount",
      ({ values }) => {
        values.container.Mounts.push({
          Type: "bind",
          Source: "/tmp/foreign",
          Destination: POSTGRES_DATA_DESTINATION,
          RW: true,
        });
      },
    ],
    [
      "network attachment",
      ({ values }) => {
        values.container.NetworkSettings.Networks = {};
      },
    ],
    [
      "additional network attachment",
      ({ values }) => {
        values.container.NetworkSettings.Networks.foreign = {
          NetworkID: "f".repeat(64),
        };
      },
    ],
    [
      "PostgreSQL image ID",
      ({ values }) => {
        values.postgresImage.Id = fixtureDigest("f");
      },
    ],
    [
      "PostgreSQL RepoDigest",
      ({ values }) => {
        values.postgresImage.RepoDigests = [];
      },
    ],
    [
      "application image ID shape",
      ({ values }) => {
        values.applicationImage.Id = "not-a-digest";
      },
    ],
    [
      "application RepoDigest",
      ({ values }) => {
        values.applicationImage.RepoDigests = [];
      },
    ],
    [
      "application revision",
      ({ values }) => {
        values.applicationImage.Labels[SOURCE_SHA_LABEL] = "b".repeat(40);
      },
    ],
    [
      "resolved label",
      ({ values }) => {
        values.container.Config.Labels[RESOLVED_CONFIG_LABEL] =
          fixtureDigest("d");
      },
    ],
    [
      "deployment label",
      ({ values }) => {
        values.container.Config.Labels[DEPLOYMENT_CONFIG_LABEL] =
          fixtureDigest("d");
      },
    ],
    [
      "volume name",
      ({ values }) => {
        values.volume.Name = "foreign";
      },
    ],
    [
      "volume creation",
      ({ values }) => {
        values.volume.CreatedAt = "2026-08-01T08:00:01.000Z";
      },
    ],
    [
      "volume labels",
      ({ values }) => {
        values.volume.Labels = { drift: "true" };
      },
    ],
    [
      "network ID",
      ({ values }) => {
        values.network.Id = "f".repeat(64);
      },
    ],
    [
      "network name",
      ({ values }) => {
        values.network.Name = "foreign";
      },
    ],
    [
      "network membership",
      ({ values }) => {
        values.network.Containers = {};
      },
    ],
    [
      "network writer peer",
      ({ values }) => {
        values.network.Containers["f".repeat(64)] = {};
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = runtimeFixture("modern");
      mutate(fixture);
      await rejectsDrift(fixture);
    });
  }
});

test("runtime authority fails closed on re-observation drift and on a pre-aborted signal", async () => {
  const fixture = runtimeFixture("legacy");
  await assert.rejects(observe(fixture, { driftAtCall: 10 }), {
    code: "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_DRIFT",
  });

  const controller = new AbortController();
  controller.abort(new Error("test abort"));
  const noIoFixture = runtimeFixture("modern");
  const noIo = fakeDocker(noIoFixture.binding, noIoFixture.values);
  await assert.rejects(
    createProductionMigrationDockerRuntimeAuthority({
      execFile: noIo.execFile,
    }).observeProductionMigrationRuntime({
      expectedRuntimeBindingCanonical: canonicalProductionExact0096BackupJson(
        noIoFixture.binding,
      ),
      signal: controller.signal,
    }),
    { code: "PRODUCTION_MIGRATION_RUNTIME_AUTHORITY_ABORTED" },
  );
  assert.equal(noIo.calls.length, 0);
});
