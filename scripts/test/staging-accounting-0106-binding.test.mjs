import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStagingAccounting0106Binding,
  StagingAccounting0106BindingError,
  validateAccounting0106TransitionInputs,
  writeStagingAccounting0106Binding,
} from "../check-staging-accounting-0106-binding.mjs";
import { canonicalJson } from "../check-staging-provisioning.mjs";

const SHA = "a".repeat(40);

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
      api: `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`,
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
  return {
    bytes,
    sha256,
    checksum: `${sha256}  ${name}\n`,
  };
}

function backupExecution(inspectSha256, overrides = {}) {
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
      maxPayloadBytes: 256 * 1024 * 1024,
      encryptionFormat: "mve1",
      retentionPruned: false,
      destructiveRestorePerformed: false,
      nextGate: "accounting-0106-transition-binding-required",
      authorizes0106: false,
      ...overrides,
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

function validBinding(overrides = {}) {
  const inspect = artifact(inspectInputs(), "staging-deployment-inspect.json");
  const backup = artifact(
    backupExecution(inspect.sha256, overrides),
    "staging-exact-0105-backup-execution.json",
  );
  return createStagingAccounting0106Binding({
    expectedSourceSha: SHA,
    originalInspectBytes: inspect.bytes,
    originalInspectChecksumText: inspect.checksum,
    expectedOriginalInspectSha256: inspect.sha256,
    backupExecutionBytes: backup.bytes,
    backupExecutionChecksumText: backup.checksum,
    expectedBackupExecutionSha256: backup.sha256,
  });
}

test("derives exact 0106 transition inputs and a fresh-id inspect artifact", () => {
  const binding = validBinding();
  assert.equal(binding.decision, "PASS");
  assert.equal(binding.derivedInspect.backupEvidenceId, 82);
  assert.equal(binding.transition.backupEvidence.previousId, 81);
  assert.equal(binding.transition.backupEvidence.id, 82);
  assert.equal(binding.transition.predecessor.tag, "0105_smooth_nitro");
  assert.equal(binding.transition.target.tag, "0106_graceful_frog_thor");
  assert.equal(
    binding.transition.derivedInspectInputsSha256,
    `sha256:${binding.derivedInspectSha256}`,
  );
  assert.equal(
    binding.environment.STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256,
    binding.transitionSha256,
  );
  assert.equal(
    binding.environment.STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
    String(256 * 1024 * 1024),
  );
  assert.doesNotThrow(() =>
    validateAccounting0106TransitionInputs(binding.transition),
  );
});

test("rejects stale inspect lineage, unsafe backup evidence and payload widening", () => {
  for (const overrides of [
    { previousBackupId: 80 },
    { excludedMigration0106Present: true },
    { accountingEvidenceRows: 1 },
    { maxPayloadBytes: 512 * 1024 * 1024 },
    { sizeBytes: 256 * 1024 * 1024 + 1 },
    { authorizes0106: true },
  ]) {
    assert.throws(
      () => validBinding(overrides),
      StagingAccounting0106BindingError,
    );
  }
});

test("rejects noncanonical or differently hashed approved inputs", () => {
  const inspect = artifact(inspectInputs(), "staging-deployment-inspect.json");
  const backup = artifact(
    backupExecution(inspect.sha256),
    "staging-exact-0105-backup-execution.json",
  );
  assert.throws(
    () =>
      createStagingAccounting0106Binding({
        expectedSourceSha: SHA,
        originalInspectBytes: inspect.bytes,
        originalInspectChecksumText: inspect.checksum,
        expectedOriginalInspectSha256: "f".repeat(64),
        backupExecutionBytes: backup.bytes,
        backupExecutionChecksumText: backup.checksum,
        expectedBackupExecutionSha256: backup.sha256,
      }),
    /ACCOUNTING_0106_BINDING_HASH_MISMATCH/,
  );
  const prettyBytes = Buffer.from(
    `${JSON.stringify(backupExecution(inspect.sha256), null, 2)}\n`,
    "utf8",
  );
  const prettySha = crypto
    .createHash("sha256")
    .update(prettyBytes)
    .digest("hex");
  assert.throws(
    () =>
      createStagingAccounting0106Binding({
        expectedSourceSha: SHA,
        originalInspectBytes: inspect.bytes,
        originalInspectChecksumText: inspect.checksum,
        expectedOriginalInspectSha256: inspect.sha256,
        backupExecutionBytes: prettyBytes,
        backupExecutionChecksumText: `${prettySha}  staging-exact-0105-backup-execution.json\n`,
        expectedBackupExecutionSha256: prettySha,
      }),
    /ACCOUNTING_0106_BINDING_CANONICAL_INVALID/,
  );
});

test("writes both canonical artifacts, checksums and secret-free environment once", () => {
  const binding = validBinding();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "accounting-0106-binding-"),
  );
  try {
    const files = writeStagingAccounting0106Binding(directory, binding);
    assert.deepEqual(Object.keys(files).sort(), [
      "staging-accounting-0106-inspect.json",
      "staging-accounting-0106-inspect.sha256",
      "staging-accounting-0106-transition.json",
      "staging-accounting-0106-transition.sha256",
      "staging-accounting-0106.env",
    ]);
    assert.equal(
      fs.readFileSync(files["staging-accounting-0106-transition.json"], "utf8"),
      canonicalJson(binding.transition),
    );
    const environment = fs.readFileSync(
      files["staging-accounting-0106.env"],
      "utf8",
    );
    assert.match(
      environment,
      /^STAGING_DEPLOYMENT_INPUTS_SHA256=[0-9a-f]{64}$/m,
    );
    assert.doesNotMatch(environment, /(PASSWORD|SECRET_ACCESS_KEY|KEYRING)=/);
    assert.throws(
      () => writeStagingAccounting0106Binding(directory, binding),
      /ACCOUNTING_0106_BINDING_OUTPUT_EXISTS/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
