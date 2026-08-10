import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  runStagingSchemaTransition,
  StagingSchemaTransitionRunnerError,
} from "../run-staging-schema-transition.mjs";

const SHA = "a".repeat(40);
const CONFIRMATION = "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const POSTGRES_CONTAINER_ID = "6".repeat(64);

function transitionInputs() {
  return {
    schemaVersion: 1,
    sourceSha: SHA,
    imageManifestSha256: "b".repeat(64),
    provisioningManifestSha256: "c".repeat(64),
    environmentId: "site-logbook-staging",
    coolifyEnvironmentId: "staging-environment",
    composeProjectName: "site-logbook-staging",
    publicAppUrl: "https://staging.example.cz",
    nginxServerName: "staging.example.cz",
    operationalAlertReceiverUrl:
      "https://alerts-staging.example.cz/v1/operational-alerts",
    operationalAlertReceiverHost: "alerts-staging.example.cz",
    s3Endpoint: "https://fsn1.your-objectstorage.com",
    s3Region: "fsn1",
    s3Bucket: "site-logbook-staging",
    s3ForcePathStyle: false,
    externalAccountsEnabled: false,
    schemaAction: "apply-0105",
    images: {
      preflight: `ghcr.io/modvolt/site-logbook-staging-preflight@sha256:${"1".repeat(64)}`,
      mailpit: `ghcr.io/modvolt/site-logbook-staging-mailpit@sha256:${"2".repeat(64)}`,
      api: `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`,
      web: `ghcr.io/modvolt/site-logbook-staging-web@sha256:${"4".repeat(64)}`,
      alertReceiver: `ghcr.io/modvolt/site-logbook-staging-alert-receiver@sha256:${"5".repeat(64)}`,
    },
    backupEvidenceId: 72,
    backupRestoreMaxAgeHours: 24,
  };
}

function resolvedCompose(inputs = transitionInputs()) {
  const deploymentSha256 = crypto
    .createHash("sha256")
    .update(canonicalJson(inputs))
    .digest("hex");
  const common = {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentSha256,
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
      "external-schema-gate": {
        image: inputs.images.api,
        command: ["node", "dist/external-schema-gate.mjs"],
        entrypoint: null,
        restart: "no",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pull_policy: "always",
        depends_on: {
          postgres: { condition: "service_healthy", required: true },
          "staging-preflight": {
            condition: "service_completed_successfully",
            required: true,
          },
        },
        healthcheck: { disable: true },
        logging: {
          driver: "json-file",
          options: { "max-file": "3", "max-size": "10m" },
        },
        networks: { default: null },
        cpus: 0.25,
        mem_limit: "402653184",
        mem_reservation: "201326592",
        environment: {
          ...common,
          STAGING_SCHEMA_ACTION: inputs.schemaAction,
          EXTERNAL_ACCOUNTS_ENABLED: "false",
          EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: CONFIRMATION,
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
      staging_pgdata: { name: volumeName },
    },
    networks: {
      default: { name: networkName, ipam: {} },
    },
  };
}

function postgresInspect(inputs = transitionInputs()) {
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

function richBackup() {
  return {
    id: 72,
    sizeBytes: 4096,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    encryptionKeyIdFingerprint: `sha256:${"e".repeat(64)}`,
    objectPathFingerprint: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-08-10T10:02:00.000Z",
    restoreTestedAt: "2026-08-10T10:03:00.000Z",
    checkedAt: "2026-08-10T10:04:00.000Z",
    restoreAgeHours: 0.017,
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    verifiedTablesSha256: `sha256:${"1".repeat(64)}`,
    destructiveRestorePerformed: false,
    sourceExecutionSha256: `sha256:${"9".repeat(64)}`,
    maxPayloadBytes: 256 * 1024 * 1024,
  };
}

function recoveryExecution() {
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0104-recovery-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt: "2026-08-10T10:03:30.000Z",
    completedAt: "2026-08-10T10:04:30.000Z",
    recoveryInputsSha256: `sha256:${"2".repeat(64)}`,
    gate: {
      decision: "READY_0104_RECOVERY",
      environmentId: "site-logbook-staging",
      databaseName: "site_logbook_staging",
      databaseUser: "site_logbook_staging",
      buildSha: SHA,
      expectedMigrations: 104,
      latestExpectedTag: "0104_thin_sheva_callister",
      excludedMigration0100Present: false,
      excludedMigration0105Present: false,
      externalStateRows: 0,
      baselineCompletedAt: "2026-08-10T10:01:00.000Z",
      backup: richBackup(),
      recoveryInputsSha256: `sha256:${"2".repeat(64)}`,
      baselineExecutionSha256: `sha256:${"3".repeat(64)}`,
      authorizes0105: false,
    },
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
    },
    nextGate: "separate-0105-transition-binding-required",
    authorizes0105: false,
  };
}

function artifact(value, filename) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    sha256,
    checksum: `${sha256}  ${filename}\n`,
  };
}

function inventoryMarker() {
  return `[external-schema-inventory] PASS ${JSON.stringify({
    decision: "READY_0104",
    appliedMigrations: 104,
    predecessorMigrations: 104,
    latestAppliedTag: "0104_thin_sheva_callister",
    missingToPredecessor: 0,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    backupEvidenceId: 72,
    backupRestoreAgeHours: 0.02,
  })}\n`;
}

function appliedMarker(overrides = {}) {
  const backupEvidence = {
    id: 72,
    status: "success",
    sizeBytes: 4096,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    restoreStatus: "ok",
    createdAt: "2026-08-10T10:02:00.000Z",
    restoreTestedAt: "2026-08-10T10:03:00.000Z",
    checkedAt: "2026-08-10T10:05:00.000Z",
    restoreAgeHours: 0.033,
    sourceExecutionSha256: `sha256:${"9".repeat(64)}`,
    maxPayloadBytes: 256 * 1024 * 1024,
  };
  const input = artifact(
    transitionInputs(),
    "staging-deployment-transition.json",
  );
  return `[external-schema-gate] APPLIED ${JSON.stringify({
    schemaGate: {
      decision: "APPLIED",
      sourceSha: SHA,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      excludedMigration0100Present: false,
      externalStateRows: 0,
      backupEvidenceId: 72,
      backupRestoreAgeHours: 0.033,
      backupRestoreMaxAgeHours: 24,
      sourceBackupExecutionSha256: `sha256:${"9".repeat(64)}`,
      backupMaxPayloadBytes: 256 * 1024 * 1024,
      backupSizeBytes: 4096,
      inputSha256: `sha256:${input.sha256}`,
    },
    backupEvidence,
    ...overrides,
  })}\n`;
}

function noopMarker() {
  return appliedMarker().replace(
    "[external-schema-gate] APPLIED ",
    "[external-schema-gate] NOOP ",
  );
}

function options(
  directory,
  transitionOutput = appliedMarker(),
  recoveryValue = recoveryExecution(),
  mutateCompose = undefined,
  mutatePostgres = undefined,
) {
  const transition = artifact(
    transitionInputs(),
    "staging-deployment-transition.json",
  );
  const recovery = artifact(
    recoveryValue,
    "staging-exact-0104-recovery-execution.json",
  );
  const compose = resolvedCompose(transition.value);
  mutateCompose?.(compose);
  const postgres = postgresInspect(transition.value);
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
    if (args.at(-1) === "dist/external-schema-inventory.mjs") {
      return { status: 0, stdout: inventoryMarker() };
    }
    return { status: 0, stdout: transitionOutput };
  };
  return {
    calls,
    value: {
      outputDirectory: directory,
      expectedSourceSha: SHA,
      confirmation: CONFIRMATION,
      transitionInputsBytes: transition.bytes,
      transitionInputsChecksumText: transition.checksum,
      expectedTransitionInputsSha256: transition.sha256,
      recoveryExecutionBytes: recovery.bytes,
      recoveryExecutionChecksumText: recovery.checksum,
      expectedRecoveryExecutionSha256: recovery.sha256,
      execute,
      now: () => new Date("2026-08-10T10:06:00.000Z"),
    },
  };
}

test("captures schema and backup evidence together from one APPLIED snapshot", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-"),
  );
  try {
    const fixture = options(directory);
    const result = runStagingSchemaTransition(fixture.value);
    assert.equal(result.decision, "PASS");
    assert.equal(result.recoveredFromReviewedIntent, false);
    const schema = JSON.parse(fs.readFileSync(result.files.schemaGate, "utf8"));
    const backup = JSON.parse(
      fs.readFileSync(result.files.backupEvidence, "utf8"),
    );
    assert.equal(schema.backupRestoreAgeHours, backup.restoreAgeHours);
    assert.equal(schema.backupEvidenceId, backup.id);
    assert.equal(
      schema.sourceBackupExecutionSha256,
      backup.sourceExecutionSha256,
    );
    assert.equal(schema.backupMaxPayloadBytes, 256 * 1024 * 1024);
    assert.ok(
      fixture.calls.some(
        (args) => args.at(-1) === "dist/external-schema-inventory.mjs",
      ),
    );
    const inventoryRun = fixture.calls.find(
      (args) => args.at(-1) === "dist/external-schema-inventory.mjs",
    );
    assert.ok(inventoryRun.includes("EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION="));
    const transitionRun = fixture.calls.find(
      (args) => args.at(-1) === "dist/external-schema-gate.mjs",
    );
    assert.ok(transitionRun);
    assert.ok(
      transitionRun.includes(
        `EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`,
      ),
    );
    assert.ok(
      transitionRun.includes(
        `STAGING_EXACT_0104_BACKUP_EXECUTION_SHA256=${"9".repeat(64)}`,
      ),
    );
    assert.ok(
      !transitionRun.some((value) =>
        value.startsWith("STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION="),
      ),
    );
    assert.deepEqual(transitionRun.slice(-3), [
      "external-schema-gate",
      "node",
      "dist/external-schema-gate.mjs",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("allows NOOP recovery only after a READY_0104 intent already exists", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-"),
  );
  try {
    const first = options(directory, noopMarker());
    assert.throws(
      () => runStagingSchemaTransition(first.value),
      /SCHEMA_TRANSITION_UNEXPECTED_NOOP/,
    );
    assert.ok(
      fs.existsSync(
        path.join(directory, "staging-schema-transition-intent.json"),
      ),
    );
    const second = options(directory, noopMarker());
    const result = runStagingSchemaTransition(second.value);
    assert.equal(result.recoveredFromReviewedIntent, true);
    const schema = JSON.parse(fs.readFileSync(result.files.schemaGate, "utf8"));
    const backup = JSON.parse(
      fs.readFileSync(result.files.backupEvidence, "utf8"),
    );
    assert.equal(schema.backupRestoreAgeHours, backup.restoreAgeHours);
    assert.ok(
      !second.calls.some(
        (args) => args.at(-1) === "dist/external-schema-inventory.mjs",
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects mismatched backup evidence and never writes a final bundle", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-"),
  );
  try {
    const marker = appliedMarker({
      backupEvidence: {
        ...JSON.parse(appliedMarker().split(" APPLIED ")[1]).backupEvidence,
        id: 73,
      },
    });
    const fixture = options(directory, marker);
    assert.throws(
      () => runStagingSchemaTransition(fixture.value),
      StagingSchemaTransitionRunnerError,
    );
    assert.equal(fs.existsSync(path.join(directory, "final")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects resolved Compose target drift before inventory or migration", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-target-drift-"),
  );
  try {
    const fixture = options(
      directory,
      appliedMarker(),
      recoveryExecution(),
      (compose) => {
        compose.services["external-schema-gate"].image =
          `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"9".repeat(64)}`;
      },
    );
    assert.throws(
      () => runStagingSchemaTransition(fixture.value),
      /SCHEMA_TRANSITION_COMPOSE_MISMATCH/,
    );
    assert.equal(
      fixture.calls.some((args) => args.includes("run")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the schema transition target free of S3 write configuration", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-s3-surface-"),
  );
  try {
    const fixture = options(
      directory,
      appliedMarker(),
      recoveryExecution(),
      (compose) => {
        compose.services["external-schema-gate"].environment.S3_BUCKET =
          "site-logbook-staging-r1";
      },
    );
    assert.throws(
      () => runStagingSchemaTransition(fixture.value),
      /SCHEMA_TRANSITION_COMPOSE_MISMATCH/,
    );
    assert.equal(
      fixture.calls.some((args) => args.includes("run")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects executable, database mount, or live-container drift before run", () => {
  const mutations = [
    {
      compose: (value) => {
        value.services["external-schema-gate"].read_only = false;
      },
    },
    {
      compose: (value) => {
        value.services["external-schema-gate"].healthcheck = {
          test: ["CMD-SHELL", "touch /tmp/unapproved"],
        };
      },
    },
    {
      compose: (value) => {
        value.services["external-schema-gate"].configs = [];
      },
    },
    {
      compose: (value) => {
        value.services["external-schema-gate"].environment.NODE_OPTIONS =
          "--import=data:text/javascript,process.exit(0)";
      },
    },
    {
      compose: (value) => {
        value.services.postgres.volumes[0].source = "production_pgdata";
      },
    },
    {
      compose: (value) => {
        value.services.postgres.logging.driver = "syslog";
      },
    },
    {
      postgres: (value) => {
        value.projectLabel = "production";
      },
    },
    {
      postgres: (value) => {
        value.portBindings = {
          "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }],
        };
      },
    },
  ];
  for (const mutation of mutations) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "schema-transition-runtime-drift-"),
    );
    try {
      const fixture = options(
        directory,
        appliedMarker(),
        recoveryExecution(),
        mutation.compose,
        mutation.postgres,
      );
      assert.throws(() => runStagingSchemaTransition(fixture.value));
      assert.equal(
        fixture.calls.some((args) => args.includes("run")),
        false,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("rechecks the live postgres boundary after a failed transition command", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "schema-transition-command-failure-"),
  );
  try {
    const fixture = options(directory);
    const originalExecute = fixture.value.execute;
    fixture.value.execute = (command, args) =>
      args.includes("run") && args.at(-1) === "dist/external-schema-gate.mjs"
        ? { status: 1, stdout: "", stderr: "redacted failure" }
        : originalExecute(command, args);

    assert.throws(
      () => runStagingSchemaTransition(fixture.value),
      /SCHEMA_TRANSITION_COMMAND_FAILED/,
    );
    assert.equal(
      fixture.calls.filter((args) => args.includes("--services")).length,
      4,
    );
    assert.equal(fs.existsSync(path.join(directory, "final")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects recovery artifacts with broken isolation, digest or chronology", () => {
  const mutations = [
    (value) => {
      value.runtimeIsolation.apiStarted = true;
    },
    (value) => {
      value.gate.recoveryInputsSha256 = `sha256:${"9".repeat(64)}`;
    },
    (value) => {
      value.gate.baselineExecutionSha256 = "sha256:invalid";
    },
    (value) => {
      value.gate.backup.encryptionKeyIdFingerprint = "sha256:invalid";
    },
    (value) => {
      value.gate.backup.restoreDurationMs = 0;
    },
    (value) => {
      value.gate.backup.sizeBytes = 256 * 1024 * 1024 + 1;
    },
    (value) => {
      value.gate.backup.maxPayloadBytes = 256 * 1024 * 1024 + 1;
    },
    (value) => {
      value.gate.backup.sourceExecutionSha256 = "sha256:invalid";
    },
    (value) => {
      value.gate.backup.createdAt = "2026-08-10T10:00:00.000Z";
    },
    (value) => {
      value.gate.backup.checkedAt = "2026-08-10T10:05:00.000Z";
    },
  ];
  for (const mutate of mutations) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "schema-transition-invalid-recovery-"),
    );
    try {
      const recovery = structuredClone(recoveryExecution());
      mutate(recovery);
      assert.throws(
        () =>
          runStagingSchemaTransition(
            options(directory, appliedMarker(), recovery).value,
          ),
        StagingSchemaTransitionRunnerError,
      );
      assert.equal(fs.existsSync(path.join(directory, "final")), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
