import test from "node:test";
import assert from "node:assert/strict";
import { validateStagingReleaseEvidence } from "../check-staging-release-evidence.mjs";

const NOW = new Date("2026-08-02T12:30:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function validEvidence() {
  return {
    schemaVersion: 2,
    run: {
      id: "phase13-20260802-001",
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
      commitSha: SHA,
      workflowUrl: "https://github.com/example/modvolt/actions/runs/123456789",
    },
    deployment: {
      healthStatus: "ok",
      healthVersion: SHA,
      migrationParity: true,
      expectedMigrations: 103,
      appliedMigrations: 103,
      missingMigrationTags: [],
    },
    storage: {
      policyPreflight: "pass",
      distinctTarget: true,
      versioning: "enabled",
      immutableRetention: "enabled",
      targetFingerprint: "sha256:staging-target-fingerprint",
    },
    recovery: {
      performed: true,
      dataClassification: "anonymized",
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
    alerts: { freshnessAlertDelivery: "pass" },
    approvals: {
      mode: "dual_control",
      operator: "operator-a",
      reviewer: "reviewer-b",
      serviceOwner: "owner-c",
      approvedAt: "2026-08-02T12:10:00.000Z",
    },
  };
}

test("accepts complete, fresh, dual-controlled staging evidence", () => {
  const summary = validateStagingReleaseEvidence(validEvidence(), { now: NOW });
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.commitSha, SHA);
  assert.equal(summary.objectCount, 13);
  assert.equal(summary.approvalMode, "dual_control");
});

test("rejects production targets and credential-bearing evidence", () => {
  const production = validEvidence();
  production.run.baseUrl = "https://modvoltapp.cz";
  assert.throws(
    () => validateStagingReleaseEvidence(production, { now: NOW }),
    /EVIDENCE_TARGET_UNSAFE/,
  );

  const loopback = validEvidence();
  loopback.run.baseUrl = "https://[::1]";
  assert.throws(
    () => validateStagingReleaseEvidence(loopback, { now: NOW }),
    /EVIDENCE_TARGET_UNSAFE/,
  );

  const secret = validEvidence();
  secret.notes = { apiToken: "must-never-be-here" };
  assert.throws(
    () => validateStagingReleaseEvidence(secret, { now: NOW }),
    /EVIDENCE_CONTAINS_SECRET/,
  );
});

test("rejects stale evidence and commit drift", () => {
  assert.throws(
    () =>
      validateStagingReleaseEvidence(validEvidence(), {
        now: new Date("2026-08-05T12:01:00.000Z"),
      }),
    /EVIDENCE_STALE/,
  );
  const drift = validEvidence();
  drift.deployment.healthVersion = "ffffffffffffffffffffffffffffffffffffffff";
  assert.throws(
    () => validateStagingReleaseEvidence(drift, { now: NOW }),
    /deployment.healthVersion/,
  );
});

test("rejects incomplete migrations, object mismatch, and RPO/RTO breaches", () => {
  const migrations = validEvidence();
  migrations.deployment.appliedMigrations = 102;
  assert.throws(
    () => validateStagingReleaseEvidence(migrations, { now: NOW }),
    /EVIDENCE_MIGRATION_MISMATCH/,
  );

  const objects = validEvidence();
  objects.recovery.objectCountRestored = 12;
  assert.throws(
    () => validateStagingReleaseEvidence(objects, { now: NOW }),
    /EVIDENCE_OBJECT_MISMATCH/,
  );

  const rpo = validEvidence();
  rpo.recovery.approvedRpoMinutes = 120;
  assert.throws(
    () => validateStagingReleaseEvidence(rpo, { now: NOW }),
    /EVIDENCE_RPO_BREACH/,
  );

  const rto = validEvidence();
  rto.recovery.approvedRtoMinutes = 60;
  assert.throws(
    () => validateStagingReleaseEvidence(rto, { now: NOW }),
    /EVIDENCE_RTO_BREACH/,
  );
});

test("rejects missing release gates and self-approval", () => {
  const pending = validEvidence();
  pending.browser.mobileSmoke = "pending";
  assert.throws(
    () => validateStagingReleaseEvidence(pending, { now: NOW }),
    /browser.mobileSmoke/,
  );

  const selfApproved = validEvidence();
  selfApproved.approvals.reviewer = selfApproved.approvals.operator;
  assert.throws(
    () => validateStagingReleaseEvidence(selfApproved, { now: NOW }),
    /EVIDENCE_DUAL_CONTROL_MISSING/,
  );
});

test("accepts an explicit solo-maintainer waiver with compensating controls", () => {
  const solo = validEvidence();
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

  const summary = validateStagingReleaseEvidence(solo, { now: NOW });
  assert.equal(summary.approvalMode, "solo_maintainer");
  assert.equal(summary.decision, "PASS");
});

test("rejects a fake reviewer or missing control in solo-maintainer mode", () => {
  const solo = validEvidence();
  solo.approvals = {
    mode: "solo_maintainer",
    operator: "owner-a",
    reviewer: "codex-is-not-an-independent-person",
    serviceOwner: "owner-a",
    soloMaintainerRiskAccepted: true,
    compensatingControls: {
      mainBranchProtected: true,
      exactShaQualityGateRequired: true,
      environmentBranchRestricted: true,
    },
    approvedAt: "2026-08-02T12:10:00.000Z",
  };
  assert.throws(
    () => validateStagingReleaseEvidence(solo, { now: NOW }),
    /EVIDENCE_SOLO_MAINTAINER_INVALID/,
  );

  solo.approvals.reviewer = null;
  solo.approvals.compensatingControls.mainBranchProtected = false;
  assert.throws(
    () => validateStagingReleaseEvidence(solo, { now: NOW }),
    /mainBranchProtected/,
  );
});
