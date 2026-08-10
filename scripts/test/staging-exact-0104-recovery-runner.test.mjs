import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  runStagingExact0104Recovery,
  StagingExact0104RecoveryRunnerError,
} from "../run-staging-exact-0104-recovery.mjs";

const INPUT_SHA = "a".repeat(64);
const SOURCE_SHA = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";
const API_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`;
const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const POSTGRES_CONTAINER_ID = "6".repeat(64);

function inspectInputs(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    imageManifestSha256: "b".repeat(64),
    provisioningManifestSha256: "c".repeat(64),
    environmentId: "site-logbook-staging",
    coolifyEnvironmentId: "staging-environment",
    composeProjectName: "site-logbook-staging",
    publicAppUrl: "https://stage-site-logbook.cz",
    nginxServerName: "stage-site-logbook.cz",
    operationalAlertReceiverUrl:
      "https://stage-alert-site-logbook.cz/v1/operational-alerts",
    operationalAlertReceiverHost: "stage-alert-site-logbook.cz",
    s3Endpoint: "https://fsn1.your-objectstorage.com",
    s3Region: "fsn1",
    s3Bucket: "site-logbook-staging-r1",
    s3ForcePathStyle: false,
    externalAccountsEnabled: false,
    schemaAction: "inspect",
    images: {
      preflight: `ghcr.io/modvolt/site-logbook-staging-preflight@sha256:${"1".repeat(64)}`,
      mailpit: `ghcr.io/modvolt/site-logbook-staging-mailpit@sha256:${"2".repeat(64)}`,
      api: API_IMAGE,
      web: `ghcr.io/modvolt/site-logbook-staging-web@sha256:${"4".repeat(64)}`,
      alertReceiver: `ghcr.io/modvolt/site-logbook-staging-alert-receiver@sha256:${"5".repeat(64)}`,
    },
    backupEvidenceId: 72,
    backupRestoreMaxAgeHours: 24,
    ...overrides,
  };
}

function resolvedCompose(inputs, inspectSha256) {
  const common = {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: inspectSha256,
  };
  return {
    name: inputs.composeProjectName,
    services: {
      "staging-preflight": {
        environment: {
          ...common,
          STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
          STAGING_SCHEMA_ACTION: inputs.schemaAction,
          STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
          STAGING_PROVISIONING_MANIFEST_SHA256:
            inputs.provisioningManifestSha256,
          STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
          STAGING_API_IMAGE: inputs.images.api,
          STAGING_S3_ENDPOINT: inputs.s3Endpoint,
          STAGING_S3_REGION: inputs.s3Region,
          STAGING_S3_BUCKET: inputs.s3Bucket,
          STAGING_S3_FORCE_PATH_STYLE: String(inputs.s3ForcePathStyle),
        },
      },
      postgres: {
        image: POSTGRES_IMAGE,
        command: null,
        entrypoint: null,
        restart: "unless-stopped",
        pull_policy: "always",
        depends_on: {
          "staging-preflight": {
            condition: "service_completed_successfully",
            required: true,
          },
        },
        expose: ["5432"],
        healthcheck: {
          test: [
            "CMD-SHELL",
            "pg_isready -U site_logbook_staging -d site_logbook_staging",
          ],
          timeout: "5s",
          interval: "10s",
          retries: 10,
        },
        logging: {
          driver: "json-file",
          options: { "max-file": "3", "max-size": "10m" },
        },
        volumes: [
          {
            type: "volume",
            source: "staging_pgdata",
            target: "/var/lib/postgresql/data",
            volume: {},
          },
        ],
        networks: { default: null },
        cpus: 0.5,
        mem_limit: "805306368",
        mem_reservation: "536870912",
        environment: {
          POSTGRES_USER: "site_logbook_staging",
          POSTGRES_PASSWORD: "test",
          POSTGRES_DB: "site_logbook_staging",
        },
      },
      "exact-0104-recovery-gate": {
        image: inputs.images.api,
        command: ["node", "dist/external-schema-exact-0104-recovery.mjs"],
        entrypoint: null,
        restart: "no",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pull_policy: "always",
        healthcheck: { disable: true },
        logging: {
          driver: "json-file",
          options: { "max-file": "3", "max-size": "10m" },
        },
        profiles: ["exact-0104-recovery"],
        networks: { default: null },
        cpus: 0.25,
        mem_limit: "402653184",
        mem_reservation: "201326592",
        environment: {
          ...common,
          STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
          STAGING_SCHEMA_ACTION: inputs.schemaAction,
          STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
          STAGING_PROVISIONING_MANIFEST_SHA256:
            inputs.provisioningManifestSha256,
          STAGING_API_IMAGE: inputs.images.api,
          STAGING_EXACT_0104_RECOVERY_INPUTS_B64: "e30=",
          STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256: INPUT_SHA,
          STAGING_BASELINE_0104_EXECUTION_B64: "e30=",
          STAGING_BASELINE_0104_EXECUTION_SHA256: "f".repeat(64),
          EXTERNAL_ACCOUNTS_ENABLED: "false",
          STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
          STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
          STAGING_DATABASE_HOST: "postgres",
          STAGING_DATABASE_NAME: "site_logbook_staging",
          STAGING_DATABASE_USER: "site_logbook_staging",
          STAGING_BACKUP_EVIDENCE_ID: String(inputs.backupEvidenceId),
          STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(
            inputs.backupRestoreMaxAgeHours,
          ),
          DATABASE_URL:
            "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
        },
      },
    },
    volumes: {
      staging_alert_receipts: {
        name: `${inputs.composeProjectName}_staging_alert_receipts`,
      },
      staging_mailca: { name: `${inputs.composeProjectName}_staging_mailca` },
      staging_mailtls: { name: `${inputs.composeProjectName}_staging_mailtls` },
      staging_pgdata: {
        name: `${inputs.composeProjectName}_staging_pgdata`,
      },
    },
    networks: {
      default: { name: `${inputs.composeProjectName}_default`, ipam: {} },
    },
  };
}

function postgresInspect(inputs) {
  return {
    id: POSTGRES_CONTAINER_ID,
    running: true,
    configImage: POSTGRES_IMAGE,
    imageId: `sha256:${"7".repeat(64)}`,
    projectLabel: inputs.composeProjectName,
    serviceLabel: "postgres",
    path: "docker-entrypoint.sh",
    args: ["postgres"],
    mounts: [
      {
        Type: "volume",
        Name: `${inputs.composeProjectName}_staging_pgdata`,
        Source: `/var/lib/docker/volumes/${inputs.composeProjectName}_staging_pgdata/_data`,
        Destination: "/var/lib/postgresql/data",
        Driver: "local",
        Mode: "rw",
        RW: true,
        Propagation: "",
      },
    ],
    networks: {
      [`${inputs.composeProjectName}_default`]: { NetworkID: "8".repeat(64) },
    },
    portBindings: {},
    networkPorts: { "5432/tcp": null },
  };
}

function marker(overrides = {}, backupOverrides = {}) {
  const value = {
    decision: "READY_0104_RECOVERY",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SOURCE_SHA,
    expectedMigrations: 104,
    latestExpectedTag: "0104_thin_sheva_callister",
    excludedMigration0100Present: false,
    excludedMigration0105Present: false,
    externalStateRows: 0,
    baselineCompletedAt: "2026-08-09T18:01:00.000Z",
    backup: {
      id: 72,
      sizeBytes: 1024,
      encryptedBackupSha256: `sha256:${"b".repeat(64)}`,
      encryptionFormat: "mve1",
      encryptionKeyIdFingerprint: `sha256:${"c".repeat(64)}`,
      objectPathFingerprint: `sha256:${"d".repeat(64)}`,
      createdAt: "2026-08-09T18:02:00.000Z",
      restoreTestedAt: "2026-08-09T18:03:00.000Z",
      checkedAt: "2026-08-09T18:04:00.000Z",
      restoreAgeHours: 1 / 60,
      restoreDurationMs: 1500,
      verifiedTableCount: 4,
      verifiedTablesSha256: `sha256:${"e".repeat(64)}`,
      destructiveRestorePerformed: false,
      sourceExecutionSha256: `sha256:${"f".repeat(64)}`,
      maxPayloadBytes: 256 * 1024 * 1024,
      ...backupOverrides,
    },
    authorizes0105: false,
    recoveryInputsSha256: `sha256:${INPUT_SHA}`,
    baselineExecutionSha256: `sha256:${"f".repeat(64)}`,
    ...overrides,
  };
  return `[staging-exact-0104-recovery] PASS ${JSON.stringify(value)}\n`;
}

function setup({
  output = marker(),
  runStatus = 0,
  running = "postgres\n",
  mutateCompose,
  mutatePostgres,
} = {}) {
  const inputs = inspectInputs();
  const inspectBytes = Buffer.from(canonicalJson(inputs), "utf8");
  const inspectSha256 = crypto
    .createHash("sha256")
    .update(inspectBytes)
    .digest("hex");
  const compose = resolvedCompose(inputs, inspectSha256);
  mutateCompose?.(compose);
  const postgres = postgresInspect(inputs);
  mutatePostgres?.(postgres);
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    if (args.includes("config")) {
      return { status: 0, stdout: JSON.stringify(compose), stderr: "" };
    }
    if (args[0] === "inspect") {
      return { status: 0, stdout: JSON.stringify(postgres), stderr: "" };
    }
    if (args.includes("ps") && args.includes("--quiet")) {
      return { status: 0, stdout: `${POSTGRES_CONTAINER_ID}\n`, stderr: "" };
    }
    if (args.includes("ps")) {
      return { status: 0, stdout: running, stderr: "" };
    }
    if (args.at(-1) === "dist/external-schema-exact-0104-recovery.mjs") {
      return { status: runStatus, stdout: output, stderr: "redacted" };
    }
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  };
  const times = [
    new Date("2026-08-09T18:05:00.000Z"),
    new Date("2026-08-09T18:06:00.000Z"),
  ];
  return {
    calls,
    options: {
      expectedSourceSha: SOURCE_SHA,
      expectedInputsSha256: INPUT_SHA,
      inspectDeploymentBytes: inspectBytes,
      inspectDeploymentChecksumText: `${inspectSha256}  staging-exact-0104-recovery-inspect.json\n`,
      expectedInspectDeploymentSha256: inspectSha256,
      execute,
      now: () => times.shift(),
    },
  };
}

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) =>
      error instanceof StagingExact0104RecoveryRunnerError &&
      error.code === code,
  );
}

function isRecoveryRun(call) {
  return (
    call.args.includes("run") &&
    call.args.at(-1) === "dist/external-schema-exact-0104-recovery.mjs"
  );
}

test("captures exact-0104 recovery evidence from the approved resolved target", () => {
  const fixture = setup();
  const evidence = runStagingExact0104Recovery(fixture.options);
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.gate.backup.id, 72);
  assert.equal(
    evidence.runtimeIsolation.onlyPostgresRunningAtEveryBoundary,
    true,
  );
  assert.equal(evidence.nextGate, "separate-0105-transition-binding-required");
  assert.equal(evidence.authorizes0105, false);
  const run = fixture.calls.find(isRecoveryRun);
  assert.ok(run);
  assert.equal(run.command, "docker");
  assert.deepEqual(run.args.slice(-3), [
    "exact-0104-recovery-gate",
    "node",
    "dist/external-schema-exact-0104-recovery.mjs",
  ]);
  assert.equal(
    fixture.calls.filter((call) => call.args.includes("ps")).length,
    4,
  );
});

test("refuses inspect or resolved target drift before running recovery", () => {
  const hashMismatch = setup();
  hashMismatch.options.expectedInspectDeploymentSha256 = "9".repeat(64);
  expectCode("RECOVERY_INSPECT_HASH_MISMATCH", () =>
    runStagingExact0104Recovery(hashMismatch.options),
  );
  assert.equal(hashMismatch.calls.length, 0);

  const targetMismatch = setup({
    mutateCompose: (compose) => {
      compose.services["exact-0104-recovery-gate"].command = [
        "node",
        "other.mjs",
      ];
    },
  });
  expectCode("RECOVERY_COMPOSE_MISMATCH", () =>
    runStagingExact0104Recovery(targetMismatch.options),
  );
  assert.equal(targetMismatch.calls.some(isRecoveryRun), false);
});

test("refuses non-quiescent or live Postgres drift before recovery", () => {
  const nonQuiescent = setup({ running: "postgres\napi\n" });
  expectCode("RECOVERY_RUNTIME_NOT_QUIESCENT", () =>
    runStagingExact0104Recovery(nonQuiescent.options),
  );
  assert.equal(nonQuiescent.calls.some(isRecoveryRun), false);

  const liveDrift = setup({
    mutatePostgres: (postgres) => {
      postgres.mounts[0].Name = "production_pgdata";
    },
  });
  expectCode("RECOVERY_POSTGRES_CONTAINER_MISMATCH", () =>
    runStagingExact0104Recovery(liveDrift.options),
  );
  assert.equal(liveDrift.calls.some(isRecoveryRun), false);
});

test("always rechecks the same Postgres boundary when recovery fails", () => {
  const failed = setup({ runStatus: 1, output: "" });
  expectCode("RECOVERY_COMMAND_FAILED", () =>
    runStagingExact0104Recovery(failed.options),
  );
  assert.equal(
    failed.calls.filter((call) => call.args.includes("ps")).length,
    4,
  );
});

test("rejects stale input binding, pre-baseline backup and 0105 widening", () => {
  const invalidInput = setup();
  invalidInput.options.expectedInputsSha256 = "short";
  expectCode("RECOVERY_EXPECTED_INPUTS_INVALID", () =>
    runStagingExact0104Recovery(invalidInput.options),
  );
  const oldBackup = setup({
    output: marker({}, { createdAt: "2026-08-09T18:00:00.000Z" }),
  });
  expectCode("RECOVERY_EVIDENCE_TIME_INVALID", () =>
    runStagingExact0104Recovery(oldBackup.options),
  );
  const widened = setup({ output: marker({ authorizes0105: true }) });
  expectCode("RECOVERY_EVIDENCE_INVALID", () =>
    runStagingExact0104Recovery(widened.options),
  );
  const oversized = setup({
    output: marker({}, { sizeBytes: 256 * 1024 * 1024 + 1 }),
  });
  expectCode("RECOVERY_BACKUP_EVIDENCE_INVALID", () =>
    runStagingExact0104Recovery(oversized.options),
  );
  const wrongBuild = setup({ output: marker({ buildSha: "9".repeat(40) }) });
  expectCode("RECOVERY_EVIDENCE_INVALID", () =>
    runStagingExact0104Recovery(wrongBuild.options),
  );
});

test("rejects extra root or backup fields instead of persisting them", () => {
  const extraRoot = setup({ output: marker({ databaseUrl: "redacted" }) });
  expectCode("RECOVERY_EVIDENCE_SCHEMA_INVALID", () =>
    runStagingExact0104Recovery(extraRoot.options),
  );
  const extraBackup = setup({
    output: marker({}, { encryptionKeyId: "not-a-fingerprint" }),
  });
  expectCode("RECOVERY_EVIDENCE_SCHEMA_INVALID", () =>
    runStagingExact0104Recovery(extraBackup.options),
  );
});

test("does not include command stderr when the gate fails", () => {
  const failed = setup({ runStatus: 1, output: "" });
  assert.throws(
    () => runStagingExact0104Recovery(failed.options),
    (error) => {
      assert.ok(error instanceof StagingExact0104RecoveryRunnerError);
      assert.equal(error.code, "RECOVERY_COMMAND_FAILED");
      assert.doesNotMatch(error.message, /redacted/);
      return true;
    },
  );
});
