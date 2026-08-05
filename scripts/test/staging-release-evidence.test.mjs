import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { validateStagingReleaseEvidence } from "../check-staging-release-evidence.mjs";

const NOW = new Date("2026-08-02T12:30:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function fixtureArtifacts() {
  const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
  const imageManifest = jsonBytes({
    schemaVersion: 1,
    sourceSha: SHA,
    publisherRun: { id: "987654321", attempt: "1" },
  });
  const provisioning = jsonBytes({
    schemaVersion: 1,
    validationMode: "observed",
    productionTargetsTouched: false,
    coolify: { source: { exactCommitSha: SHA } },
  });
  const bound = {
    schemaVersion: 1,
    sourceSha: SHA,
    imageManifestSha256: digest(imageManifest).slice("sha256:".length),
    provisioningManifestSha256: digest(provisioning).slice("sha256:".length),
    externalAccountsEnabled: false,
    images: {
      preflight: "preflight",
      mailpit: "mailpit",
      api: "api",
      web: "web",
      alertReceiver: "alert-receiver",
    },
  };
  const inspectInputs = jsonBytes({
    ...bound,
    schemaAction: "inspect",
    backupEvidenceId: 71,
    backupRestoreMaxAgeHours: 24,
  });
  const transitionInputs = jsonBytes({
    ...bound,
    schemaAction: "apply-0105",
    backupEvidenceId: 71,
    backupRestoreMaxAgeHours: 24,
  });
  const steadyInputs = jsonBytes({ ...bound, schemaAction: "steady-0105" });
  const schemaGate = jsonBytes({
    decision: "APPLIED",
    sourceSha: SHA,
    latestExpectedTag: "0105_smooth_nitro",
    expectedMigrations: 105,
    excludedMigration0100Present: false,
    externalStateRows: 0,
    backupEvidenceId: 71,
    backupRestoreAgeHours: 2,
    backupRestoreMaxAgeHours: 24,
    inputSha256: digest(transitionInputs),
  });
  const backupEvidence = jsonBytes({
    id: 71,
    status: "success",
    sizeBytes: 1024,
    encryptedBackupSha256: `sha256:${"a".repeat(64)}`,
    encryptionFormat: "mve1",
    restoreStatus: "ok",
    createdAt: "2026-08-02T07:45:00.000Z",
    restoreTestedAt: "2026-08-02T08:45:00.000Z",
    checkedAt: "2026-08-02T09:45:00.000Z",
    restoreAgeHours: 2,
  });
  const bootstrap = jsonBytes({
    schemaVersion: 1,
    sourceSha: SHA,
    capturedAt: "2026-08-02T11:30:00.000Z",
    workflowRun: { id: 123456789, attempt: 1 },
    bindings: {
      imageManifestSha256: digest(imageManifest).slice("sha256:".length),
      provisioningManifestSha256: digest(provisioning).slice("sha256:".length),
      deploymentInputsSha256: digest(steadyInputs).slice("sha256:".length),
    },
    readiness: {
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      appliedMigrations: 105,
      migrationParity: true,
      excludedMigration0100Present: false,
      schemaAction: "steady-0105",
    },
    darkRollout: {
      externalAccountsEnabled: false,
      externalAccountCount: 0,
    },
  });
  return {
    imageManifest,
    inspectInputs,
    transitionInputs,
    steadyInputs,
    schemaGate,
    backupEvidence,
    provisioning,
    bootstrap,
  };
}

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function validEvidence(artifactBytes = fixtureArtifacts()) {
  const hashes = Object.fromEntries(
    Object.entries(artifactBytes).map(([key, bytes]) => [key, digest(bytes)]),
  );
  return {
    schemaVersion: 4,
    run: {
      id: "phase16-20260802-001",
      environmentId: "modvolt-staging-eu1",
      baseUrl: "https://stage-173.example.test",
      commitSha: SHA,
      startedAt: "2026-08-02T10:00:00.000Z",
      completedAt: "2026-08-02T12:00:00.000Z",
    },
    isolation: {
      confirmed: true,
      productionTargetsTouched: false,
      rawProductionDataExposed: false,
      mailSandbox: true,
    },
    ci: {
      conclusion: "success",
      runId: 123456789,
      runAttempt: 1,
      commitSha: SHA,
      workflowUrl:
        "https://github.com/modvolt/Site-Logbook/actions/runs/123456789",
    },
    deployment: {
      healthStatus: "ok",
      healthVersion: SHA,
      migrationParity: true,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      appliedMigrations: 105,
      missingMigrationTags: [],
      excludedMigration0100Present: false,
      schemaAction: "steady-0105",
      externalAccountsEnabled: false,
      externalState: {
        externalUsers: 0,
        externalAccounts: 0,
        externalScopes: 0,
        externalEvents: 0,
        totalRows: 0,
      },
      steadyInputSha256: hashes.steadyInputs,
    },
    schemaTransition: {
      decision: "APPLIED",
      sourceSha: SHA,
      latestExpectedTag: "0105_smooth_nitro",
      expectedMigrations: 105,
      externalStateRows: 0,
      backupEvidenceId: 71,
      backupRestoreAgeHours: 2,
      backupRestoreMaxAgeHours: 24,
      inputSha256: hashes.transitionInputs,
      evidenceArtifactSha256: hashes.schemaGate,
    },
    backupEvidence: {
      id: 71,
      status: "success",
      sizeBytes: 1024,
      encryptedBackupSha256: `sha256:${"a".repeat(64)}`,
      encryptionFormat: "mve1",
      restoreStatus: "ok",
      createdAt: "2026-08-02T07:45:00.000Z",
      restoreTestedAt: "2026-08-02T08:45:00.000Z",
      checkedAt: "2026-08-02T09:45:00.000Z",
      restoreAgeHours: 2,
      evidenceArtifactSha256: hashes.backupEvidence,
    },
    artifacts: {
      imageManifest: {
        schemaVersion: 1,
        sourceSha: SHA,
        sha256: hashes.imageManifest,
        publisherWorkflowUrl:
          "https://github.com/modvolt/site-logbook-registry/actions/runs/987654321",
        publisherRunId: "987654321",
        publisherRunAttempt: 1,
      },
      deploymentInputs: {
        inspectSha256: hashes.inspectInputs,
        transitionSha256: hashes.transitionInputs,
        steadySha256: hashes.steadyInputs,
      },
      provisioning: { schemaVersion: 1, sha256: hashes.provisioning },
      bootstrap: {
        schemaVersion: 1,
        sha256: hashes.bootstrap,
        workflowUrl:
          "https://github.com/modvolt/Site-Logbook/actions/runs/123456789",
        runId: 123456789,
        runAttempt: 1,
        sourceSha: SHA,
        capturedAt: "2026-08-02T11:30:00.000Z",
      },
    },
    storage: {
      policyPreflight: "pass",
      distinctTarget: true,
      versioning: "enabled",
      immutableRetention: "enabled",
      targetFingerprint: `sha256:${"b".repeat(64)}`,
    },
    recovery: {
      performed: true,
      dataClassification: "production-copy-restricted",
      databaseRestore: true,
      objectRestore: true,
      objectHashesVerified: true,
      businessSmoke: true,
      objectCountExpected: 13,
      objectCountRestored: 13,
      sourceCreatedAt: "2026-08-02T08:30:00.000Z",
      startedAt: "2026-08-02T10:15:00.000Z",
      completedAt: "2026-08-02T11:45:00.000Z",
      rpoMinutes: 195,
      approvedRpoMinutes: 240,
      rtoMinutes: 90,
      approvedRtoMinutes: 240,
    },
    browser: {
      authSmoke: "pass",
      adminHealth: "pass",
      pwaAssets: "pass",
      desktopSmoke: "pass",
      mobileSmoke: "pass",
    },
    mail: { sandboxDelivery: "pass" },
    alerts: {
      freshnessAlertDelivery: "pass",
      receiverHealth: "pass",
      receiverBuildSha: SHA,
      receiverSyntheticDelivery: "pass",
      durableOutboxDelivery: "pass",
      persistentIdempotency: "pass",
      deadManTrigger: "pass",
      deadManRecovery: "pass",
    },
    approvals: {
      mode: "dual_control",
      operator: "operator-a",
      reviewer: "reviewer-b",
      serviceOwner: "owner-c",
      approvedAt: "2026-08-02T12:10:00.000Z",
    },
  };
}

function validate(evidence, artifactBytes, options = {}) {
  return validateStagingReleaseEvidence(evidence, {
    now: NOW,
    artifactBytes,
    ...options,
  });
}

test("accepts complete schema-v4 exact-0105 staging evidence", () => {
  const artifactBytes = fixtureArtifacts();
  const summary = validate(validEvidence(artifactBytes), artifactBytes);
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.schemaVersion, 4);
  assert.equal(summary.expectedMigrations, 105);
  assert.equal(summary.latestExpectedTag, "0105_smooth_nitro");
  assert.equal(summary.approvalMode, "dual_control");
});

test("rejects production targets, secrets, stale evidence, and commit drift", () => {
  const artifactBytes = fixtureArtifacts();
  const production = validEvidence(artifactBytes);
  production.run.baseUrl = "https://modvoltapp.cz";
  assert.throws(
    () => validate(production, artifactBytes),
    /EVIDENCE_TARGET_UNSAFE/,
  );

  const secret = validEvidence(artifactBytes);
  secret.notes = { apiToken: "must-never-be-here" };
  assert.throws(
    () => validate(secret, artifactBytes),
    /EVIDENCE_CONTAINS_SECRET/,
  );

  assert.throws(
    () =>
      validate(validEvidence(artifactBytes), artifactBytes, {
        now: new Date("2026-08-05T12:01:00.000Z"),
      }),
    /EVIDENCE_STALE/,
  );
  const drift = validEvidence(artifactBytes);
  drift.deployment.healthVersion = "f".repeat(40);
  assert.throws(
    () => validate(drift, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );
});

test("rejects every exact-0105 dark-rollout invariant drift", () => {
  const artifactBytes = fixtureArtifacts();
  for (const mutate of [
    (evidence) => (evidence.deployment.latestExpectedTag = "0104_previous"),
    (evidence) => (evidence.deployment.expectedMigrations = 104),
    (evidence) => (evidence.deployment.appliedMigrations = 105.5),
    (evidence) => (evidence.deployment.excludedMigration0100Present = true),
    (evidence) => (evidence.deployment.externalAccountsEnabled = true),
    (evidence) => (evidence.deployment.externalState.externalAccounts = 1),
  ]) {
    const evidence = validEvidence(artifactBytes);
    mutate(evidence);
    assert.throws(() => validate(evidence, artifactBytes));
  }
});

test("recomputes every artifact hash and rejects byte tampering", () => {
  const artifactBytes = fixtureArtifacts();
  const evidence = validEvidence(artifactBytes);
  const tampered = { ...artifactBytes, bootstrap: Buffer.from("tampered\n") };
  assert.throws(
    () => validate(evidence, tampered),
    /EVIDENCE_ARTIFACT_MISMATCH/,
  );
  const missing = { ...artifactBytes };
  delete missing.schemaGate;
  assert.throws(() => validate(evidence, missing), /EVIDENCE_ARTIFACT_MISSING/);
});

test("rejects backup, transition, workflow-run, and input-binding drift", () => {
  const artifactBytes = fixtureArtifacts();
  const staleBackup = validEvidence(artifactBytes);
  staleBackup.schemaTransition.backupRestoreAgeHours = 25;
  assert.throws(
    () => validate(staleBackup, artifactBytes),
    /EVIDENCE_BACKUP_STALE/,
  );

  const wrongBackup = validEvidence(artifactBytes);
  wrongBackup.backupEvidence.id = 72;
  assert.throws(
    () => validate(wrongBackup, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );

  const wrongWorkflow = validEvidence(artifactBytes);
  wrongWorkflow.ci.workflowUrl =
    "https://github.com/example/modvolt/actions/runs/123456789";
  assert.throws(
    () => validate(wrongWorkflow, artifactBytes),
    /EVIDENCE_WORKFLOW_URL_INVALID/,
  );

  const wrongBinding = validEvidence(artifactBytes);
  wrongBinding.artifacts.deploymentInputs.steadySha256 = `sha256:${"c".repeat(64)}`;
  assert.throws(
    () => validate(wrongBinding, artifactBytes),
    /EVIDENCE_GATE_NOT_PASSED/,
  );
});

test("accepts solo-maintainer controls and rejects a fake reviewer", () => {
  const artifactBytes = fixtureArtifacts();
  const solo = validEvidence(artifactBytes);
  solo.approvals = {
    mode: "solo_maintainer",
    operator: "owner-a",
    reviewer: null,
    serviceOwner: "owner-a",
    soloMaintainerRiskAccepted: true,
    compensatingControls: {
      mainBranchProtected: true,
      exactShaQualityGateRequired: true,
      environmentBranchRestricted: true,
    },
    approvedAt: "2026-08-02T12:10:00.000Z",
  };
  assert.equal(validate(solo, artifactBytes).approvalMode, "solo_maintainer");
  solo.approvals.reviewer = "owner-a";
  assert.throws(
    () => validate(solo, artifactBytes),
    /EVIDENCE_SOLO_MAINTAINER_INVALID/,
  );
});
