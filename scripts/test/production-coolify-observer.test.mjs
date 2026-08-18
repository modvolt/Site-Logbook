import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PRODUCTION_COOLIFY_HTTPS_ORIGIN,
  PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION,
  PRODUCTION_COOLIFY_READ_ONLY_PATHS,
  collectCoolifyReadOnlyExport,
  productionCoolifyDeploymentReadOnlyPath,
} from "../production-evidence/coolify-readonly-observer.mjs";
import {
  COOLIFY_EXPORT_SCHEMA,
  PRODUCTION_TARGET,
} from "../production-evidence/host-attestation-contract.mjs";
import { productionCoolifyObserverTestCore as testCore } from "./support/production-coolify-observer-test-core.mjs";

const NOW = Date.parse("2026-08-18T09:00:00.000Z");
const REVISION = "4".repeat(40);
const DEPLOYMENT_ID = "deployment-production-0107";
const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (name, character) =>
  `ghcr.io/modvolt/${name}@sha256:${character.repeat(64)}`;
const images = Object.freeze({
  api: image("site-logbook-api", "1"),
  postgres: image("postgres", "2"),
  web: image("site-logbook-web", "3"),
});

function target() {
  return {
    projectId: PRODUCTION_TARGET.projectId,
    environmentId: PRODUCTION_TARGET.environmentId,
    environmentLabel: PRODUCTION_TARGET.environmentLabel,
    applicationId: PRODUCTION_TARGET.applicationId,
  };
}

function controlPlane() {
  return {
    ...testCore.controlPlaneBinding,
    bridgeSourceSha256: testCore.bridgeSourceSha256,
    status: "running",
    health: "healthy",
  };
}

function bridgeEnvelope(challenge) {
  return {
    controlPlane: controlPlane(),
    bridge: {
      schemaVersion: testCore.bridgeContract.bridgeSchema,
      challenge: {
        ...challenge,
        serverTime: new Date(NOW).toISOString(),
      },
      controlPlane: {
        version: testCore.controlPlaneBinding.version,
        sourceCommitSha: testCore.controlPlaneBinding.sourceCommitSha,
      },
      target: target(),
      pendingChanges: false,
      deployment: {
        deploymentId: DEPLOYMENT_ID,
        revision: REVISION,
        deployedAt: new Date(NOW - 10_000).toISOString(),
        status: "finished",
        pullRequestId: 0,
      },
      configuration: {
        desiredSha256: digest("7"),
        deployedSha256: digest("7"),
        storedSnapshotSha256: digest("7"),
      },
      resolvedCompose: {
        desiredSha256: digest("8"),
        deployedSha256: digest("8"),
        images: { ...images },
      },
    },
  };
}

function request(overrides = {}) {
  return {
    confirmation: PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION,
    expected: {
      deploymentId: DEPLOYMENT_ID,
      revision: REVISION,
      deployedNotBefore: new Date(NOW - 20_000).toISOString(),
      configurationSha256: digest("7"),
      resolvedComposeSha256: digest("8"),
      images: { ...images },
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function authoritativeReader(mutators = []) {
  const calls = [];
  return {
    calls,
    async readAttestation(call) {
      const value = bridgeEnvelope(call.challenge);
      mutators[calls.length]?.(value, call);
      calls.push(call);
      return structuredClone(value);
    },
  };
}

test("production Coolify API exports no synthetic authority or command seam", async () => {
  const productionApi =
    await import("../production-evidence/coolify-readonly-observer.mjs");
  assert.equal(
    Object.hasOwn(productionApi, "createProductionCoolifyObserverTestCore"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      productionApi,
      "PRODUCTION_COOLIFY_OBSERVER_TEST_CONFIRMATION",
    ),
    false,
  );
  assert.equal(
    Object.keys(productionApi).some((key) =>
      /TestAuthority|TestCore|Bridge|Command/.test(key),
    ),
    false,
  );
});

test("pins the reviewed API references and exact Coolify control-plane source/image/runtime", () => {
  assert.equal(PRODUCTION_COOLIFY_HTTPS_ORIGIN.startsWith("https://"), true);
  assert.equal(
    PRODUCTION_COOLIFY_READ_ONLY_PATHS.application,
    `/api/v1/applications/${PRODUCTION_TARGET.applicationId}`,
  );
  assert.equal(
    PRODUCTION_COOLIFY_READ_ONLY_PATHS.deployments,
    `/api/v1/deployments/applications/${PRODUCTION_TARGET.applicationId}?skip=0&take=10`,
  );
  assert.equal(
    productionCoolifyDeploymentReadOnlyPath(DEPLOYMENT_ID),
    `/api/v1/deployments/${DEPLOYMENT_ID}`,
  );
  assert.deepEqual(testCore.controlPlaneBinding, {
    version: "4.1.1",
    sourceCommitSha: "5a27427cad54e98c21a691a08077c20f94f84f73",
    containerId:
      "6d67a437666b353feaeb549c70f7c032e92269fc04170c87265919fe7c69e97c",
    containerImage: "ghcr.io/coollabsio/coolify:4.1.1",
    imageId:
      "sha256:4471528f3428c8cc78867bd809d545563d60c5d32483f7b6d958c624b29c5a0a",
    imageRef:
      "ghcr.io/coollabsio/coolify@sha256:4471528f3428c8cc78867bd809d545563d60c5d32483f7b6d958c624b29c5a0a",
    startedAt: "2026-06-27T00:16:08.215284422Z",
  });
  assert.equal(
    testCore.bridgeSourceSha256,
    `sha256:${createHash("sha256")
      .update(testCore.bridgeContract.phpSource)
      .digest("hex")}`,
  );
});

test("double-reads fresh host attestations and emits only equal secret-free hashes", async () => {
  const authority = authoritativeReader();
  const artifact = await testCore.collect(request(), {
    readAttestation: authority.readAttestation,
    now: () => NOW,
    random: () => Buffer.alloc(32, 0xa5),
  });

  assert.equal(artifact.value.schemaVersion, COOLIFY_EXPORT_SCHEMA);
  assert.equal(artifact.value.pendingChanges, false);
  assert.deepEqual(artifact.value.desiredConfig, artifact.value.deployedConfig);
  assert.deepEqual(artifact.value.desiredConfig.images, images);
  assert.equal(authority.calls.length, 2);
  assert.equal(authority.calls[0].challenge.ordinal, 1);
  assert.equal(authority.calls[1].challenge.ordinal, 2);
  assert.equal(
    authority.calls[0].challenge.nonce,
    authority.calls[1].challenge.nonce,
  );
  assert.match(authority.calls[0].challenge.nonce, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    artifact.canonical,
    /configuration_snapshot|docker_compose|DATABASE_PASSWORD|github_pat_/i,
  );
});

test("rejects replay, snapshot drift, pending changes and double-read races", async () => {
  const cases = [
    {
      mutate(value) {
        value.bridge.challenge.serverTime = new Date(
          NOW - 31_000,
        ).toISOString();
      },
      error: /PRODUCTION_COOLIFY_OBSERVER_REPLAY/,
    },
    {
      mutate(value) {
        value.bridge.deployment.deployedAt = new Date(
          NOW - 25 * 60 * 60_000,
        ).toISOString();
      },
      error: /PRODUCTION_COOLIFY_OBSERVER_REPLAY/,
    },
    {
      mutate(value) {
        value.bridge.configuration.storedSnapshotSha256 = digest("9");
      },
      error: /PRODUCTION_COOLIFY_OBSERVER_DRIFT/,
    },
    {
      mutate(value) {
        value.bridge.pendingChanges = true;
      },
      error: /PRODUCTION_COOLIFY_OBSERVER_DRIFT/,
    },
    {
      mutate(value) {
        value.controlPlane.startedAt = "2026-06-27T00:16:09.000000000Z";
      },
      error: /PRODUCTION_COOLIFY_OBSERVER_CONTROL_PLANE_DRIFT/,
    },
  ];
  for (const { mutate, error } of cases) {
    const authority = authoritativeReader([mutate, mutate]);
    await assert.rejects(
      testCore.collect(request(), {
        readAttestation: authority.readAttestation,
        now: () => NOW,
        random: () => Buffer.alloc(32, 1),
      }),
      error,
    );
  }

  const race = authoritativeReader([
    () => undefined,
    (value) => {
      value.bridge.deployment.deploymentId = "deployment-production-0107-race";
    },
  ]);
  await assert.rejects(
    testCore.collect(request(), {
      readAttestation: race.readAttestation,
      now: () => NOW,
      random: () => Buffer.alloc(32, 2),
    }),
    /PRODUCTION_COOLIFY_OBSERVER_RACE/,
  );
});

test("host bridge uses only fixed inspect/exec argv and source bytes", async () => {
  const commands = [];
  const challenge = {
    nonce: "ab".repeat(32),
    ordinal: 1,
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
  };
  const runDocker = async (args, options) => {
    commands.push({ args, options });
    if (args[0] === "container") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          Id: testCore.controlPlaneBinding.containerId,
          ConfigImage: testCore.controlPlaneBinding.containerImage,
          Image: testCore.controlPlaneBinding.imageId,
          State: {
            Status: "running",
            Running: true,
            Health: "healthy",
            StartedAt: testCore.controlPlaneBinding.startedAt,
          },
        }),
      };
    }
    if (args[0] === "image") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          Id: testCore.controlPlaneBinding.imageId,
          RepoDigests: [testCore.controlPlaneBinding.imageRef],
        }),
      };
    }
    assert.equal(args[0], "exec");
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(bridgeEnvelope(challenge).bridge),
    };
  };
  const readBridge = testCore.createHostBridgeAuthority(runDocker);
  const result = await readBridge({
    challenge,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result.controlPlane, controlPlane());
  assert.equal(commands.length, 5);
  assert.deepEqual(
    commands.map(({ args }) => args.slice(0, 2)),
    [
      ["container", "inspect"],
      ["image", "inspect"],
      ["exec", "-i"],
      ["container", "inspect"],
      ["image", "inspect"],
    ],
  );
  const execution = commands[2];
  assert.equal(execution.args[2], testCore.controlPlaneBinding.containerId);
  assert.equal(execution.args.includes("sh"), false);
  assert.equal(execution.args.includes("-c"), false);
  assert.equal(execution.options.input, testCore.bridgeContract.phpSource);
  assert.doesNotMatch(
    JSON.stringify(commands.map(({ args }) => args)),
    /Config\.Env|\.env|token|password|secret/i,
  );
});

test("production collector rejects dependency injection and transport errors stay redacted", async () => {
  const secret = "github_pat_transport_failure_must_not_escape_123456";
  await assert.rejects(
    collectCoolifyReadOnlyExport(request(), {
      readAttestation: async () => bridgeEnvelope({}),
    }),
    /PRODUCTION_COOLIFY_OBSERVER_REQUEST_INVALID/,
  );
  await assert.rejects(
    testCore.collect(request(), {
      readAttestation: async () => {
        throw new Error(secret);
      },
      now: () => NOW,
      random: () => Buffer.alloc(32, 3),
    }),
    (error) => {
      assert.match(error.message, /TRANSPORT_FAILURE/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("host bridge discards stderr and never echoes subprocess material", async () => {
  const secret = "DATABASE_PASSWORD=must-not-escape-observer";
  const readBridge = testCore.createHostBridgeAuthority(async () => ({
    exitCode: 0,
    stderr: secret,
    stdout: "{}",
  }));
  await assert.rejects(
    readBridge({
      challenge: {
        nonce: "cd".repeat(32),
        ordinal: 1,
        issuedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /HOST_BRIDGE_FAILURE/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("honors external abort and the hard timeout without invoking production Docker", async () => {
  const externallyAborted = new AbortController();
  externallyAborted.abort();
  await assert.rejects(
    testCore.collect(request({ signal: externallyAborted.signal }), {
      readAttestation: async () => bridgeEnvelope({}),
      now: () => NOW,
    }),
    /PRODUCTION_COOLIFY_OBSERVER_ABORTED/,
  );
  await assert.rejects(
    testCore.collect(request({ timeoutMs: 100 }), {
      readAttestation: () => new Promise(() => undefined),
      now: () => NOW,
      random: () => Buffer.alloc(32, 4),
    }),
    /PRODUCTION_COOLIFY_OBSERVER_ABORTED/,
  );
});
