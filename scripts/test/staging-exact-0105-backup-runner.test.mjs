import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  runStagingExact0105Backup,
  StagingExact0105BackupRunnerError,
  writeStagingExact0105BackupEvidence,
} from "../run-staging-exact-0105-backup.mjs";

const SHA = "a".repeat(40);
const CONFIRMATION =
  "CREATE_FRESH_EXACT_0105_STAGING_BACKUP_AND_RESTORE_TEST_NO_0106";
const API_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`;
const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const POSTGRES_CONTAINER_ID = "6".repeat(64);

function inspectInputs(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceSha: SHA,
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
    backupEvidenceId: 81,
    backupRestoreMaxAgeHours: 24,
    ...overrides,
  };
}

function commonEnvironment(inputs) {
  return {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: crypto
      .createHash("sha256")
      .update(canonicalJson(inputs))
      .digest("hex"),
  };
}

function resolvedCompose(inputs = inspectInputs()) {
  const common = commonEnvironment(inputs);
  const networkName = `${inputs.composeProjectName}_default`;
  const volumeName = `${inputs.composeProjectName}_staging_pgdata`;
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
      "exact-0105-accounting-backup": {
        image: inputs.images.api,
        command: ["node", "dist/accounting-schema-exact-0105-backup.mjs"],
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
        profiles: ["exact-0105-accounting-backup"],
        networks: { default: null },
        cpus: 0.5,
        mem_limit: "1610612736",
        mem_reservation: "402653184",
        tmpfs: ["/tmp:size=536870912,mode=1777"],
        environment: {
          ...common,
          STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
          STAGING_SCHEMA_ACTION: inputs.schemaAction,
          STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
          STAGING_PROVISIONING_MANIFEST_SHA256:
            inputs.provisioningManifestSha256,
          STAGING_EXACT_0105_BACKUP_ACTION: "",
          STAGING_EXACT_0105_BACKUP_CONFIRMATION: "",
          ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
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
          BACKUP_ENABLED: "true",
          BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "staging-backup-key",
          BACKUP_ENCRYPTION_KEYRING: "staging-only-test-keyring",
          S3_ACCESS_KEY_ID: "staging-only-access-key",
          S3_ENDPOINT: inputs.s3Endpoint,
          S3_REGION: inputs.s3Region,
          S3_BUCKET: inputs.s3Bucket,
          S3_FORCE_PATH_STYLE: String(inputs.s3ForcePathStyle),
          S3_PRIVATE_PREFIX: "private",
          S3_SECRET_ACCESS_KEY: "staging-only-secret-key",
        },
      },
    },
    volumes: {
      staging_alert_receipts: {
        name: `${inputs.composeProjectName}_staging_alert_receipts`,
      },
      staging_mailca: { name: `${inputs.composeProjectName}_staging_mailca` },
      staging_mailtls: { name: `${inputs.composeProjectName}_staging_mailtls` },
      staging_pgdata: { name: volumeName },
    },
    networks: { default: { name: networkName, ipam: {} } },
  };
}

function postgresInspect(inputs = inspectInputs()) {
  const networkName = `${inputs.composeProjectName}_default`;
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
    networks: { [networkName]: { NetworkID: "8".repeat(64) } },
    portBindings: {},
    networkPorts: { "5432/tcp": null },
  };
}

function marker(overrides = {}) {
  return `[staging-exact-0105-backup] PASS ${JSON.stringify({
    decision: "CREATED_AND_RESTORE_VERIFIED",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    expectedMigrations: 105,
    latestExpectedTag: "0105_smooth_nitro",
    excludedMigration0100Present: false,
    excludedMigration0106Present: false,
    accountingEvidenceRows: 0,
    externalStateRows: 0,
    previousBackupId: 81,
    backupId: 82,
    createdAt: "2026-08-11T10:02:00.000Z",
    restoreTestedAt: "2026-08-11T10:03:00.000Z",
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    sizeBytes: 4096,
    maxPayloadBytes: 256 * 1024 * 1024,
    encryptionFormat: "mve1",
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "accounting-0106-transition-binding-required",
    authorizes0106: false,
    ...overrides,
  })}\n`;
}

function setup(
  markerOverrides = {},
  mutateCompose = undefined,
  mutatePostgres = undefined,
) {
  const inspect = inspectInputs();
  const inspectBytes = Buffer.from(canonicalJson(inspect), "utf8");
  const inspectSha256 = crypto
    .createHash("sha256")
    .update(inspectBytes)
    .digest("hex");
  const compose = resolvedCompose(inspect);
  mutateCompose?.(compose);
  const postgres = postgresInspect(inspect);
  mutatePostgres?.(postgres);
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes("config")) {
      return { status: 0, stdout: JSON.stringify(compose) };
    }
    if (args[0] === "inspect") {
      return { status: 0, stdout: JSON.stringify(postgres) };
    }
    if (args.includes("ps") && args.includes("--quiet")) {
      return { status: 0, stdout: `${POSTGRES_CONTAINER_ID}\n` };
    }
    if (args.includes("ps")) return { status: 0, stdout: "postgres\n" };
    return { status: 0, stdout: marker(markerOverrides) };
  };
  return {
    calls,
    options: {
      expectedSourceSha: SHA,
      confirmation: CONFIRMATION,
      inspectDeploymentBytes: inspectBytes,
      inspectDeploymentChecksumText: `${inspectSha256}  staging-deployment-inspect.json\n`,
      expectedInspectDeploymentSha256: inspectSha256,
      execute,
      now: (() => {
        const values = [
          new Date("2026-08-11T10:01:30.000Z"),
          new Date("2026-08-11T10:03:30.000Z"),
        ];
        return () => values.shift();
      })(),
    },
  };
}

test("runs the isolated exact-0105 backup without authorizing 0106", () => {
  const fixture = setup();
  const evidence = runStagingExact0105Backup(fixture.options);
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.gate.backupId, 82);
  assert.equal(evidence.gate.previousBackupId, 81);
  assert.equal(evidence.authorizes0106, false);
  assert.equal(
    evidence.runtimeIsolation.accountingSchema0106GateStarted,
    false,
  );
  assert.equal(fixture.calls.filter((args) => args.includes("ps")).length, 4);
  const run = fixture.calls.find(
    (args) =>
      args.includes("run") && args.includes("exact-0105-accounting-backup"),
  );
  assert.ok(run);
  assert.ok(run.includes("--no-deps"));
  assert.ok(
    run.includes(`STAGING_EXACT_0105_BACKUP_CONFIRMATION=${CONFIRMATION}`),
  );
  assert.deepEqual(run.slice(-3), [
    "exact-0105-accounting-backup",
    "node",
    "dist/accounting-schema-exact-0105-backup.mjs",
  ]);
});

test("rejects stale, unsafe, oversized or non-quiescent evidence", () => {
  for (const overrides of [
    { backupId: 81 },
    { excludedMigration0106Present: true },
    { accountingEvidenceRows: 1 },
    { retentionPruned: true },
    { destructiveRestorePerformed: true },
    { maxPayloadBytes: 512 * 1024 * 1024 },
    { sizeBytes: 256 * 1024 * 1024 + 1 },
  ]) {
    assert.throws(
      () => runStagingExact0105Backup(setup(overrides).options),
      StagingExact0105BackupRunnerError,
    );
  }
  const fixture = setup();
  const originalExecute = fixture.options.execute;
  fixture.options.execute = (command, args) =>
    args.includes("ps")
      ? { status: 0, stdout: "postgres\napi\n" }
      : originalExecute(command, args);
  assert.throws(
    () => runStagingExact0105Backup(fixture.options),
    /EXACT_0105_BACKUP_RUNTIME_NOT_QUIESCENT/,
  );
});

test("rejects target, command, volume and live postgres drift before run", () => {
  const fixtures = [
    setup({}, (compose) => {
      compose.services["exact-0105-accounting-backup"].environment.S3_BUCKET =
        "site-logbook-staging-other";
    }),
    setup({}, (compose) => {
      compose.services["exact-0105-accounting-backup"].command = [
        "node",
        "other.mjs",
      ];
    }),
    setup({}, (compose) => {
      compose.services.postgres.volumes[0].source = "production_pgdata";
    }),
    setup({}, undefined, (postgres) => {
      postgres.configImage = `postgres:16-alpine@sha256:${"9".repeat(64)}`;
    }),
    setup({}, undefined, (postgres) => {
      postgres.mounts[0].Name = "production_pgdata";
    }),
  ];
  for (const fixture of fixtures) {
    assert.throws(() => runStagingExact0105Backup(fixture.options));
    assert.equal(
      fixture.calls.some((args) => args.includes("run")),
      false,
    );
  }
});

test("rechecks the same postgres boundary after a failed one-shot", () => {
  const fixture = setup();
  const originalExecute = fixture.options.execute;
  fixture.options.execute = (command, args) =>
    args.includes("run") && args.includes("exact-0105-accounting-backup")
      ? { status: 1, stdout: "", stderr: "redacted failure" }
      : originalExecute(command, args);
  assert.throws(
    () => runStagingExact0105Backup(fixture.options),
    /EXACT_0105_BACKUP_COMMAND_FAILED/,
  );
  assert.equal(
    fixture.calls.filter((args) => args.includes("--services")).length,
    2,
  );
});

test("writes canonical exact-0105 execution evidence exactly once", () => {
  const evidence = runStagingExact0105Backup(setup().options);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "exact-0105-backup-"),
  );
  try {
    const files = writeStagingExact0105BackupEvidence(directory, evidence);
    assert.equal(
      fs.readFileSync(files.target, "utf8"),
      canonicalJson(evidence),
    );
    assert.equal(
      fs.readFileSync(files.checksum, "utf8"),
      `${files.sha256}  staging-exact-0105-backup-execution.json\n`,
    );
    assert.throws(
      () => writeStagingExact0105BackupEvidence(directory, evidence),
      /EXACT_0105_BACKUP_OUTPUT_EXISTS/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
