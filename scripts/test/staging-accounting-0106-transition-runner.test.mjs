import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStagingAccounting0106Binding } from "../check-staging-accounting-0106-binding.mjs";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  runStagingAccounting0106Transition,
  StagingAccounting0106TransitionRunnerError,
} from "../run-staging-accounting-0106-transition.mjs";
import { verifyStagingAccounting0106Execution } from "../verify-staging-accounting-0106-execution.mjs";

const SHA = "a".repeat(40);
const CONFIRMATION =
  "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING";
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const API_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`;
const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const POSTGRES_CONTAINER_ID = "6".repeat(64);

function inspectInputs() {
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
  };
}

function artifact(value, name) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, checksum: `${sha256}  ${name}\n` };
}

function backupExecution(inspectSha256) {
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0105-backup-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt: "2026-08-11T10:00:00.000Z",
    completedAt: "2026-08-11T10:03:00.000Z",
    sourceSha: SHA,
    inspectDeploymentInputsSha256: `sha256:${inspectSha256}`,
    gate: {
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
      createdAt: "2026-08-11T10:01:00.000Z",
      restoreTestedAt: "2026-08-11T10:02:00.000Z",
      restoreDurationMs: 60_000,
      verifiedTableCount: 5,
      sizeBytes: 4096,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      encryptionFormat: "mve1",
      retentionPruned: false,
      destructiveRestorePerformed: false,
      nextGate: "accounting-0106-transition-binding-required",
      authorizes0106: false,
    },
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      externalSchema0105GateStarted: false,
      accountingSchema0106GateStarted: false,
    },
    nextGate: "accounting-0106-transition-binding-required",
    authorizes0106: false,
  };
}

function createArtifacts() {
  const originalInspect = artifact(
    inspectInputs(),
    "staging-deployment-inspect.json",
  );
  const backup = artifact(
    backupExecution(originalInspect.sha256),
    "staging-exact-0105-backup-execution.json",
  );
  const binding = createStagingAccounting0106Binding({
    expectedSourceSha: SHA,
    originalInspectBytes: originalInspect.bytes,
    originalInspectChecksumText: originalInspect.checksum,
    expectedOriginalInspectSha256: originalInspect.sha256,
    backupExecutionBytes: backup.bytes,
    backupExecutionChecksumText: backup.checksum,
    expectedBackupExecutionSha256: backup.sha256,
  });
  return {
    binding,
    backup,
    inspect: artifact(
      binding.derivedInspect,
      "staging-accounting-0106-inspect.json",
    ),
    transition: artifact(
      binding.transition,
      "staging-accounting-0106-transition.json",
    ),
  };
}

function resolvedCompose(artifacts) {
  const inputs = artifacts.binding.derivedInspect;
  const common = {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: artifacts.inspect.sha256,
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
      "accounting-schema-gate": {
        image: inputs.images.api,
        command: ["node", "dist/accounting-schema-gate.mjs"],
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
          STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
          STAGING_SCHEMA_ACTION: inputs.schemaAction,
          STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
          STAGING_PROVISIONING_MANIFEST_SHA256:
            inputs.provisioningManifestSha256,
          STAGING_API_IMAGE: inputs.images.api,
          STAGING_DATABASE_HOST: "postgres",
          STAGING_DATABASE_NAME: "site_logbook_staging",
          STAGING_DATABASE_USER: "site_logbook_staging",
          STAGING_BACKUP_EVIDENCE_ID: String(inputs.backupEvidenceId),
          STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(
            inputs.backupRestoreMaxAgeHours,
          ),
          STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
          STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
          STAGING_ACCOUNTING_SCHEMA_ACTION: "steady-0106",
          ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
          STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256:
            artifacts.transition.sha256,
          STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256: artifacts.backup.sha256,
          STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES:
            String(MAX_PAYLOAD_BYTES),
          STAGING_EXACT_0105_BACKUP_SIZE_BYTES: "4096",
          EXTERNAL_ACCOUNTS_ENABLED: "false",
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

function inventory(decision = "READY_0105") {
  const already = decision === "ALREADY_0106";
  return {
    decision,
    appliedMigrations: already ? 106 : 105,
    predecessorMigrations: 105,
    latestAppliedTag: already ? "0106_graceful_frog_thor" : "0105_smooth_nitro",
    missingToPredecessor: 0,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    backupEvidenceId: already ? null : 82,
    backupRestoreAgeHours: already ? null : 0.017,
    externalStateRows: 0,
  };
}

function richBackup(backupExecutionSha256) {
  return {
    id: 82,
    sizeBytes: 4096,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    encryptionKeyIdFingerprint: `sha256:${"e".repeat(64)}`,
    objectPathFingerprint: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-08-11T10:01:00.000Z",
    restoreTestedAt: "2026-08-11T10:02:00.000Z",
    checkedAt: "2026-08-11T10:04:00.000Z",
    restoreAgeHours: 0.033,
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    verifiedTablesSha256: `sha256:${"1".repeat(64)}`,
    destructiveRestorePerformed: false,
    sourceExecutionSha256: `sha256:${backupExecutionSha256}`,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
  };
}

function gateEvidence(artifacts) {
  return {
    schemaGate: {
      decision: "APPLIED",
      sourceSha: SHA,
      predecessorTag: "0105_smooth_nitro",
      latestExpectedTag: "0106_graceful_frog_thor",
      expectedMigrations: 106,
      excludedMigration0100Present: false,
      accountingEvidenceRows: 0,
      externalStateRows: 0,
      backupEvidenceId: 82,
      backupRestoreAgeHours: 0.033,
      backupRestoreMaxAgeHours: 24,
      sourceBackupExecutionSha256: `sha256:${artifacts.backup.sha256}`,
      backupMaxPayloadBytes: MAX_PAYLOAD_BYTES,
      backupSizeBytes: 4096,
      inputSha256: `sha256:${artifacts.transition.sha256}`,
      migration: {
        idx: 106,
        when: 1786459128910,
        tag: "0106_graceful_frog_thor",
        sha256:
          "sha256:697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
      },
    },
    backupEvidence: richBackup(artifacts.backup.sha256),
  };
}

function setup({
  inventoryDecision = "READY_0105",
  operation = "APPLIED",
  mutateCompose,
  mutatePostgres,
} = {}) {
  const artifacts = createArtifacts();
  const compose = resolvedCompose(artifacts);
  mutateCompose?.(compose);
  const postgres = postgresInspect(artifacts.binding.derivedInspect);
  mutatePostgres?.(postgres);
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "accounting-0106-transition-"),
  );
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
    if (args.includes("dist/accounting-schema-inventory.mjs")) {
      return {
        status: 0,
        stdout: `[accounting-schema-inventory] PASS ${JSON.stringify(inventory(inventoryDecision))}\n`,
      };
    }
    return {
      status: 0,
      stdout: `[accounting-schema-gate] ${operation} ${JSON.stringify(gateEvidence(artifacts))}\n`,
    };
  };
  const times = [
    new Date("2026-08-11T10:03:30.000Z"),
    new Date("2026-08-11T10:04:30.000Z"),
  ];
  return {
    artifacts,
    calls,
    outputDirectory,
    options: {
      outputDirectory,
      expectedSourceSha: SHA,
      confirmation: CONFIRMATION,
      transitionBytes: artifacts.transition.bytes,
      transitionChecksumText: artifacts.transition.checksum,
      expectedTransitionSha256: artifacts.transition.sha256,
      inspectBytes: artifacts.inspect.bytes,
      inspectChecksumText: artifacts.inspect.checksum,
      expectedInspectSha256: artifacts.inspect.sha256,
      backupExecutionBytes: artifacts.backup.bytes,
      backupExecutionChecksumText: artifacts.backup.checksum,
      expectedBackupExecutionSha256: artifacts.backup.sha256,
      execute,
      now: () => times.shift(),
    },
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.outputDirectory, { recursive: true, force: true });
}

test("applies exact 0106 with canonical intent, execution and runtime isolation", () => {
  const fixture = setup();
  try {
    const result = runStagingAccounting0106Transition(fixture.options);
    assert.equal(result.execution.operation, "applied");
    assert.equal(result.execution.authorizesApplicationStart, false);
    assert.equal(
      result.execution.runtimeIsolation.samePostgresContainerAtEveryBoundary,
      true,
    );
    assert.equal(
      fs.readFileSync(result.files.target, "utf8"),
      canonicalJson(result.execution),
    );
    assert.equal(
      fs.readFileSync(result.files.checksum, "utf8"),
      `${result.files.sha256}  staging-accounting-0106-execution.json\n`,
    );
    const run = fixture.calls.find(
      (args) =>
        args.includes("run") &&
        args.includes("accounting-schema-gate") &&
        args.includes("dist/accounting-schema-gate.mjs"),
    );
    assert.ok(run);
    assert.ok(run.includes("--no-deps"));
    assert.ok(
      run.includes(`ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION=${CONFIRMATION}`),
    );
    assert.deepEqual(run.slice(-3), [
      "accounting-schema-gate",
      "node",
      "dist/accounting-schema-gate.mjs",
    ]);
  } finally {
    cleanup(fixture);
  }
});

test("rejects first-attempt NOOP but accepts exact intent recovery", () => {
  const first = setup({ operation: "NOOP" });
  try {
    assert.throws(
      () => runStagingAccounting0106Transition(first.options),
      /ACCOUNTING_0106_UNEXPECTED_NOOP/,
    );
    assert.equal(
      fs.existsSync(
        path.join(first.outputDirectory, "staging-accounting-0106-intent.json"),
      ),
      true,
    );
    const retry = setup({
      inventoryDecision: "ALREADY_0106",
      operation: "NOOP",
    });
    try {
      fs.copyFileSync(
        path.join(first.outputDirectory, "staging-accounting-0106-intent.json"),
        path.join(retry.outputDirectory, "staging-accounting-0106-intent.json"),
      );
      fs.copyFileSync(
        path.join(
          first.outputDirectory,
          "staging-accounting-0106-intent.sha256",
        ),
        path.join(
          retry.outputDirectory,
          "staging-accounting-0106-intent.sha256",
        ),
      );
      const result = runStagingAccounting0106Transition(retry.options);
      assert.equal(result.execution.operation, "verified-noop");
    } finally {
      cleanup(retry);
    }
  } finally {
    cleanup(first);
  }
});

test("rejects artifact, Compose, S3 and live postgres drift before mutation", () => {
  const fixtures = [
    setup({
      mutateCompose: (value) => {
        value.services["accounting-schema-gate"].command = [
          "node",
          "other.mjs",
        ];
      },
    }),
    setup({
      mutateCompose: (value) => {
        value.services["accounting-schema-gate"].environment.S3_BUCKET =
          "production";
      },
    }),
    setup({
      mutateCompose: (value) => {
        value.services.postgres.volumes[0].source = "production_pgdata";
      },
    }),
    setup({
      mutatePostgres: (value) => {
        value.mounts[0].Name = "production_pgdata";
      },
    }),
  ];
  try {
    for (const fixture of fixtures) {
      assert.throws(() => runStagingAccounting0106Transition(fixture.options));
      assert.equal(
        fixture.calls.some((args) =>
          args.includes("dist/accounting-schema-gate.mjs"),
        ),
        false,
      );
    }
    const tampered = setup();
    tampered.options.expectedTransitionSha256 = "f".repeat(64);
    assert.throws(
      () => runStagingAccounting0106Transition(tampered.options),
      /ACCOUNTING_0106_INPUT_HASH_MISMATCH/,
    );
    cleanup(tampered);
  } finally {
    for (const fixture of fixtures) cleanup(fixture);
  }
});

test("rechecks the same postgres boundary after a failed one-shot", () => {
  const fixture = setup();
  const original = fixture.options.execute;
  fixture.options.execute = (command, args) =>
    args.includes("dist/accounting-schema-gate.mjs")
      ? { status: 1, stdout: "", stderr: "redacted failure" }
      : original(command, args);
  try {
    assert.throws(
      () => runStagingAccounting0106Transition(fixture.options),
      /ACCOUNTING_0106_COMMAND_FAILED/,
    );
    assert.equal(
      fixture.calls.filter((args) => args.includes("--services")).length,
      4,
    );
  } finally {
    cleanup(fixture);
  }
});

test("independently rehashes and verifies the complete 0106 execution chain", () => {
  const fixture = setup();
  try {
    const result = runStagingAccounting0106Transition(fixture.options);
    const executionBytes = fs.readFileSync(result.files.target);
    const executionChecksumText = fs.readFileSync(
      result.files.checksum,
      "utf8",
    );
    const verified = verifyStagingAccounting0106Execution({
      expectedSourceSha: SHA,
      transitionBytes: fixture.artifacts.transition.bytes,
      transitionChecksumText: fixture.artifacts.transition.checksum,
      expectedTransitionSha256: fixture.artifacts.transition.sha256,
      inspectBytes: fixture.artifacts.inspect.bytes,
      inspectChecksumText: fixture.artifacts.inspect.checksum,
      expectedInspectSha256: fixture.artifacts.inspect.sha256,
      backupExecutionBytes: fixture.artifacts.backup.bytes,
      backupExecutionChecksumText: fixture.artifacts.backup.checksum,
      expectedBackupExecutionSha256: fixture.artifacts.backup.sha256,
      executionBytes,
      executionChecksumText,
      expectedExecutionSha256: result.files.sha256,
    });
    assert.equal(verified.decision, "PASS");
    assert.equal(verified.latestExpectedTag, "0106_graceful_frog_thor");
    assert.equal(verified.eligibleForStagingApplicationStartApproval, true);
    assert.equal(verified.deployPerformed, false);

    const unsafe = artifact(
      { ...result.execution, authorizesApplicationStart: true },
      "staging-accounting-0106-execution.json",
    );
    assert.throws(
      () =>
        verifyStagingAccounting0106Execution({
          expectedSourceSha: SHA,
          transitionBytes: fixture.artifacts.transition.bytes,
          transitionChecksumText: fixture.artifacts.transition.checksum,
          expectedTransitionSha256: fixture.artifacts.transition.sha256,
          inspectBytes: fixture.artifacts.inspect.bytes,
          inspectChecksumText: fixture.artifacts.inspect.checksum,
          expectedInspectSha256: fixture.artifacts.inspect.sha256,
          backupExecutionBytes: fixture.artifacts.backup.bytes,
          backupExecutionChecksumText: fixture.artifacts.backup.checksum,
          expectedBackupExecutionSha256: fixture.artifacts.backup.sha256,
          executionBytes: unsafe.bytes,
          executionChecksumText: unsafe.checksum,
          expectedExecutionSha256: unsafe.sha256,
        }),
      /ACCOUNTING_0106_EXECUTION_INVALID/,
    );
  } finally {
    cleanup(fixture);
  }
});
