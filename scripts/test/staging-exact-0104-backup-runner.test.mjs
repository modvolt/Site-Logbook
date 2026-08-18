import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  runStagingExact0104Backup,
  StagingExact0104BackupRunnerError,
  writeStagingExact0104BackupEvidence,
} from "../run-staging-exact-0104-backup.mjs";

const SHA = "a".repeat(40);
const CONFIRMATION = "CREATE_FRESH_EXACT_0104_STAGING_BACKUP_AND_RESTORE_TEST";
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
    backupEvidenceId: 71,
    backupRestoreMaxAgeHours: 24,
    ...overrides,
  };
}

function resolvedCompose(inputs = inspectInputs()) {
  const common = {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: crypto
      .createHash("sha256")
      .update(canonicalJson(inputs))
      .digest("hex"),
  };
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
      "exact-0104-backup": {
        image: inputs.images.api,
        command: ["node", "dist/external-schema-exact-0104-backup.mjs"],
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
        profiles: ["exact-0104-backup"],
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
          STAGING_EXACT_0104_BACKUP_ACTION: "",
          STAGING_EXACT_0104_BACKUP_CONFIRMATION: "",
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
    networks: {
      default: { name: networkName, ipam: {} },
    },
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
    networks: {
      [networkName]: { NetworkID: "8".repeat(64) },
    },
    portBindings: {},
    networkPorts: { "5432/tcp": null },
  };
}

function baseline() {
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt: "2026-08-10T10:00:00.000Z",
    completedAt: "2026-08-10T10:01:00.000Z",
    inputSha256: `sha256:${"b".repeat(64)}`,
    operation: "verified-noop",
    precheck: {
      phase: "pre",
      operation: "verified-noop",
      decision: "READY_0104",
      candidateSourceSha: SHA,
      predecessorSourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
      appliedMigrations: 104,
      predecessorMigrations: 104,
      latestAppliedTag: "0104_thin_sheva_callister",
      missingToPredecessor: 0,
      backupEvidenceId: 71,
      backupRestoreAgeHours: 0,
      inputSha256: `sha256:${"b".repeat(64)}`,
      authorizes0105: false,
    },
    migration: { executed: false, summary: null },
    postcheck: {
      phase: "post",
      operation: "ready",
      decision: "READY_0104",
      candidateSourceSha: SHA,
      predecessorSourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
      appliedMigrations: 104,
      predecessorMigrations: 104,
      latestAppliedTag: "0104_thin_sheva_callister",
      missingToPredecessor: 0,
      backupEvidenceId: 71,
      backupRestoreAgeHours: 0,
      inputSha256: `sha256:${"b".repeat(64)}`,
      authorizes0105: false,
    },
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
    },
    requiresFreshExact0104BackupAndRestore: true,
    authorizes0105: false,
  };
}

function marker(overrides = {}) {
  return `[staging-exact-0104-backup] PASS ${JSON.stringify({
    decision: "CREATED_AND_RESTORE_VERIFIED",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    expectedMigrations: 104,
    latestExpectedTag: "0104_thin_sheva_callister",
    excludedMigration0100Present: false,
    excludedMigration0105Present: false,
    externalStateRows: 0,
    previousBackupId: 71,
    backupId: 72,
    createdAt: "2026-08-10T10:02:00.000Z",
    restoreTestedAt: "2026-08-10T10:03:00.000Z",
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    sizeBytes: 4096,
    maxPayloadBytes: 256 * 1024 * 1024,
    encryptionFormat: "mve1",
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "exact-0104-recovery-binding-required",
    authorizes0105: false,
    ...overrides,
  })}\n`;
}

function setup(
  overrides = {},
  mutateCompose = undefined,
  mutatePostgres = undefined,
) {
  const bytes = Buffer.from(canonicalJson(baseline()), "utf8");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
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
    return { status: 0, stdout: marker(overrides) };
  };
  return {
    calls,
    options: {
      expectedSourceSha: SHA,
      confirmation: CONFIRMATION,
      baselineExecutionBytes: bytes,
      baselineExecutionChecksumText: `${sha256}  staging-baseline-0104-execution.json\n`,
      expectedBaselineExecutionSha256: sha256,
      inspectDeploymentBytes: inspectBytes,
      inspectDeploymentChecksumText: `${inspectSha256}  staging-deployment-inspect.json\n`,
      expectedInspectDeploymentSha256: inspectSha256,
      execute,
      now: (() => {
        const values = [
          new Date("2026-08-10T10:01:30.000Z"),
          new Date("2026-08-10T10:03:30.000Z"),
        ];
        return () => values.shift();
      })(),
    },
  };
}

test("runs the isolated exact-0104 backup and binds it to baseline execution", () => {
  const fixture = setup();
  const evidence = runStagingExact0104Backup(fixture.options);
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.gate.backupId, 72);
  assert.equal(
    evidence.inspectDeploymentInputsSha256,
    `sha256:${fixture.options.expectedInspectDeploymentSha256}`,
  );
  assert.equal(evidence.authorizes0105, false);
  assert.equal(fixture.calls.filter((args) => args.includes("ps")).length, 4);
  const run = fixture.calls.find(
    (args) => args.includes("run") && args.includes("exact-0104-backup"),
  );
  assert.ok(run);
  assert.ok(run.includes("--no-deps"));
  assert.ok(
    run.includes(`STAGING_EXACT_0104_BACKUP_CONFIRMATION=${CONFIRMATION}`),
  );
  assert.deepEqual(run.slice(-3), [
    "exact-0104-backup",
    "node",
    "dist/external-schema-exact-0104-backup.mjs",
  ]);
});

test("fails before accepting stale, destructive or non-quiescent evidence", () => {
  for (const overrides of [
    { backupId: 71 },
    { createdAt: "2026-08-10T10:00:30.000Z" },
    { retentionPruned: true },
    { destructiveRestorePerformed: true },
    { maxPayloadBytes: 512 * 1024 * 1024 },
    { sizeBytes: 256 * 1024 * 1024 + 1 },
  ]) {
    const fixture = setup(overrides);
    assert.throws(
      () => runStagingExact0104Backup(fixture.options),
      StagingExact0104BackupRunnerError,
    );
  }

  const fixture = setup();
  const originalExecute = fixture.options.execute;
  fixture.options.execute = (command, args) =>
    args.includes("ps")
      ? { status: 0, stdout: "postgres\napi\n" }
      : originalExecute(command, args);
  assert.throws(
    () => runStagingExact0104Backup(fixture.options),
    /EXACT_0104_BACKUP_RUNTIME_NOT_QUIESCENT/,
  );
});

test("rejects inspect or resolved target drift before the stateful one-shot", () => {
  const hashMismatch = setup();
  hashMismatch.options.expectedInspectDeploymentSha256 = "9".repeat(64);
  assert.throws(
    () => runStagingExact0104Backup(hashMismatch.options),
    /EXACT_0104_BACKUP_INSPECT_HASH_MISMATCH/,
  );
  assert.equal(hashMismatch.calls.length, 0);

  const targetMismatch = setup({}, (compose) => {
    compose.services["exact-0104-backup"].environment.S3_BUCKET =
      "site-logbook-staging-other";
  });
  assert.throws(
    () => runStagingExact0104Backup(targetMismatch.options),
    /EXACT_0104_BACKUP_COMPOSE_MISMATCH/,
  );
  assert.equal(
    targetMismatch.calls.some((args) => args.includes("run")),
    false,
  );
});

test("rejects executable, database mount, or live-container drift before run", () => {
  const fixtures = [
    setup({}, (compose) => {
      compose.services["exact-0104-backup"].command = ["node", "other.mjs"];
    }),
    setup({}, (compose) => {
      compose.services["exact-0104-backup"].logging.driver = "syslog";
    }),
    setup({}, (compose) => {
      compose.services["exact-0104-backup"].configs = [];
    }),
    setup({}, (compose) => {
      compose.services["exact-0104-backup"].environment.NODE_OPTIONS =
        "--import=data:text/javascript,process.exit(0)";
    }),
    setup({}, (compose) => {
      compose.services.postgres.volumes[0].source = "production_pgdata";
    }),
    setup({}, (compose) => {
      compose.services.postgres.healthcheck.test = ["CMD-SHELL", "true"];
    }),
    setup({}, undefined, (postgres) => {
      postgres.configImage = "postgres:16-alpine@sha256:" + "9".repeat(64);
    }),
    setup({}, undefined, (postgres) => {
      postgres.mounts[0].Name = "production_pgdata";
    }),
  ];
  for (const fixture of fixtures) {
    assert.throws(() => runStagingExact0104Backup(fixture.options));
    assert.equal(
      fixture.calls.some((args) => args.includes("run")),
      false,
    );
  }
});

test("rechecks the live postgres boundary after a failed one-shot", () => {
  const fixture = setup();
  const originalExecute = fixture.options.execute;
  fixture.options.execute = (command, args) =>
    args.includes("run") && args.includes("exact-0104-backup")
      ? { status: 1, stdout: "", stderr: "redacted failure" }
      : originalExecute(command, args);

  assert.throws(
    () => runStagingExact0104Backup(fixture.options),
    /EXACT_0104_BACKUP_COMMAND_FAILED/,
  );
  assert.equal(
    fixture.calls.filter((args) => args.includes("--services")).length,
    2,
  );
});

test("writes canonical execution evidence once", () => {
  const fixture = setup();
  const evidence = runStagingExact0104Backup(fixture.options);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "exact-0104-backup-"),
  );
  try {
    const files = writeStagingExact0104BackupEvidence(directory, evidence);
    assert.equal(
      fs.readFileSync(files.target, "utf8"),
      canonicalJson(evidence),
    );
    assert.throws(
      () => writeStagingExact0104BackupEvidence(directory, evidence),
      /EXACT_0104_BACKUP_OUTPUT_EXISTS/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
