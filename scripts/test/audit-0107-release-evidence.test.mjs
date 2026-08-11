import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  createRuntimeMigrationReleaseBinding,
  validateAudit0107ReleaseEvidence,
} from "../check-audit-0107-release-evidence.mjs";

const BUILD_SHA = "a".repeat(40);
const CLEAN_OPAQUE_SHA256 =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const TARGET_KNOWN_ROWS_SHA256 =
  "sha256:d34407b4cdb8b0dc8bb9d07cd6cd500be5853d3112e142fe44e0efa5b8cd7cc1";

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(value, canonical = true) {
  const bytes = Buffer.from(
    canonical ? canonicalJson(value) : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return { b64: bytes.toString("base64"), sha256: digest(bytes) };
}

function lineage() {
  return {
    decision: "ALREADY_0107",
    knownAppliedRowsSha256: TARGET_KNOWN_ROWS_SHA256,
    mode: "clean",
    knownExpectedMigrations: 107,
    knownAppliedMigrations: 107,
    latestKnownAppliedTag: "0107_canonical_audit_evidence",
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: 0,
    opaqueLegacyRowsSha256: CLEAN_OPAQUE_SHA256,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  };
}

function backupEvidence() {
  return {
    id: 82,
    sizeBytes: 4096,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    encryptionKeyIdFingerprint: `sha256:${"e".repeat(64)}`,
    objectPathFingerprint: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-08-12T07:55:00.000Z",
    restoreTestedAt: "2026-08-12T07:57:00.000Z",
    checkedAt: "2026-08-12T07:59:00.000Z",
    restoreAgeHours: 0.033,
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    verifiedTablesSha256: `sha256:${"8".repeat(64)}`,
    destructiveRestorePerformed: false,
  };
}

function runtimeBinding() {
  const livePostgresTarget = {
    containerId: "1".repeat(64),
    image:
      "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
    imageId: "2".repeat(64),
    volumeName: "site-logbook-staging_pgdata",
    networkName: "site-logbook-staging_default",
    networkId: "3".repeat(64),
  };
  return {
    resolvedComposeSha256: `sha256:${"6".repeat(64)}`,
    deploymentConfigSha256: `sha256:${"7".repeat(64)}`,
    livePostgresTarget: {
      ...livePostgresTarget,
      projectionSha256: digest(
        Buffer.from(canonicalJson(livePostgresTarget), "utf8"),
      ),
    },
  };
}

function intent() {
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-audit-0107-intent",
    productionTargetsTouched: false,
    sourceSha: BUILD_SHA,
    transitionInputsSha256: `sha256:${"1".repeat(64)}`,
    derivedInspectInputsSha256: `sha256:${"2".repeat(64)}`,
    backupExecutionSha256: `sha256:${"3".repeat(64)}`,
    runtimeBinding: runtimeBinding(),
    lineage: {
      mode: "clean",
      opaqueLegacyRows: [],
      opaqueLegacyRowsSha256: CLEAN_OPAQUE_SHA256,
    },
    backupEvidence: backupEvidence(),
    confirmation: "APPLY_0107_AUDIT_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING",
    authorizesOnly: "isolated-exact-0106-to-0107-audit-transition",
    authorizesApplicationStart: false,
  };
}

function execution(intentSha256) {
  const backup = backupEvidence();
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-audit-0107-execution",
    decision: "PASS",
    operation: "applied",
    productionTargetsTouched: false,
    startedAt: "2026-08-12T08:00:00.000Z",
    completedAt: "2026-08-12T08:05:00.000Z",
    sourceSha: BUILD_SHA,
    transitionInputsSha256: `sha256:${"1".repeat(64)}`,
    derivedInspectInputsSha256: `sha256:${"2".repeat(64)}`,
    backupExecutionSha256: `sha256:${"3".repeat(64)}`,
    intentSha256,
    runtimeBinding: runtimeBinding(),
    schemaGate: {
      schemaVersion: "site-logbook.audit-schema-gate/v1",
      kind: "audit-schema-gate",
      mode: "APPLIED",
      decision: "ALREADY_0107",
      before: {
        decision: "READY_0106",
        knownAppliedMigrations: 106,
        knownAppliedRowsSha256:
          "sha256:cfbf74de83f99c3ca49fb717a6784265e8ef193e75e894aab9924fb7b80e16ee",
        opaqueLegacyRowCount: 0,
        opaqueLegacyRowsSha256: CLEAN_OPAQUE_SHA256,
      },
      after: steady(),
      newlyApplied: 1,
      migration: {
        idx: 107,
        when: 1786484628859,
        tag: "0107_canonical_audit_evidence",
        sha256:
          "sha256:5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339",
      },
      transition: {
        inputSha256: `sha256:${"1".repeat(64)}`,
        sourceBackupExecutionSha256: `sha256:${"3".repeat(64)}`,
        backupEvidenceId: 82,
        backupRestoreAgeHours: 0.033,
        backupRestoreMaxAgeHours: 24,
        backupMaxPayloadBytes: 256 * 1024 * 1024,
        backupSizeBytes: 4096,
        backupEvidence: backup,
      },
      authorizesApplicationStart: true,
    },
    backupEvidence: backup,
    lineage: {
      mode: "clean",
      knownMigrationCount: 107,
      totalJournalRows: 107,
      opaqueLegacyRows: [],
      opaqueLegacyRowsSha256: CLEAN_OPAQUE_SHA256,
      opaqueLegacyMeaningInferred: false,
    },
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      samePostgresContainerAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      auditSchema0107GateStartedOnlyAsOneShot: true,
    },
    migration0107AppliedOrVerified: true,
    authorizesApplicationStart: false,
    nextGate: "audit-0107-release-evidence-required",
  };
}

function steady() {
  return {
    schemaVersion: "site-logbook.audit-schema-steady-state/v1",
    kind: "audit-schema-steady-state",
    decision: "ALREADY_0107",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: BUILD_SHA,
    lineage: lineage(),
    schema: {
      targetTag: "0107_canonical_audit_evidence",
      targetSqlSha256:
        "sha256:5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339",
      targetSnapshotSha256:
        "sha256:4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb",
      auditEventRows: 0,
      auditOutboxRows: 0,
      auditHeadRows: 1,
    },
    authorizesApplicationStart: true,
  };
}

function release(executionSha256, intentSha256, steadySha256) {
  return {
    schemaVersion: 5,
    kind: "site-logbook-staging-audit-0107-release-evidence",
    buildSha: BUILD_SHA,
    deploymentBinding: {
      resolvedComposeSha256: `sha256:${"6".repeat(64)}`,
      deploymentConfigSha256: `sha256:${"7".repeat(64)}`,
      livePostgresTargetSha256:
        runtimeBinding().livePostgresTarget.projectionSha256,
    },
    predecessorReleaseEvidence: {
      schemaVersion: 4,
      decision: "PASS",
      fileSha256: `sha256:${"5".repeat(64)}`,
    },
    artifacts: {
      audit0107ExecutionSha256: executionSha256,
      audit0107IntentSha256: intentSha256,
      audit0107SteadyStateSha256: steadySha256,
    },
    lineage: lineage(),
    approval: {
      mode: "solo_maintainer",
      operator: "owner-a",
      reviewer: null,
      serviceOwner: "owner-a",
      approvedAt: "2026-08-12T08:10:00.000Z",
      executionReviewed: true,
      steadyStateReviewed: true,
      exactBuildShaReviewed: true,
      predecessorReleaseEvidenceReviewed: true,
      resolvedComposeReviewed: true,
      deploymentConfigReviewed: true,
      livePostgresTargetReviewed: true,
      authorizesApplicationStart: true,
      soloMaintainerRiskAccepted: true,
      compensatingControls: {
        mainBranchProtected: true,
        exactShaQualityGateRequired: true,
        environmentBranchRestricted: true,
      },
    },
  };
}

function validInput(mutator = () => {}) {
  const intentValue = intent();
  const initialIntent = artifact(intentValue);
  const executionValue = execution(initialIntent.sha256);
  const steadyValue = steady();
  const executionArtifact = artifact(executionValue);
  const intentArtifact = artifact(intentValue);
  const steadyArtifact = artifact(steadyValue);
  const releaseValue = release(
    executionArtifact.sha256,
    intentArtifact.sha256,
    steadyArtifact.sha256,
  );
  mutator({ executionValue, intentValue, steadyValue, releaseValue });
  const finalIntent = artifact(intentValue);
  executionValue.intentSha256 = finalIntent.sha256;
  const finalExecution = artifact(executionValue);
  const finalSteady = artifact(steadyValue);
  releaseValue.artifacts.audit0107ExecutionSha256 = finalExecution.sha256;
  releaseValue.artifacts.audit0107IntentSha256 = finalIntent.sha256;
  releaseValue.artifacts.audit0107SteadyStateSha256 = finalSteady.sha256;
  const releaseArtifact = artifact(releaseValue);
  return {
    buildSha: BUILD_SHA,
    resolvedComposeSha256: `sha256:${"6".repeat(64)}`,
    deploymentConfigSha256: `sha256:${"7".repeat(64)}`,
    livePostgresTargetSha256:
      runtimeBinding().livePostgresTarget.projectionSha256,
    releaseEvidenceB64: releaseArtifact.b64,
    releaseEvidenceSha256: releaseArtifact.sha256,
    executionEvidenceB64: finalExecution.b64,
    executionEvidenceSha256: finalExecution.sha256,
    intentEvidenceB64: finalIntent.b64,
    intentEvidenceSha256: finalIntent.sha256,
    steadyStateEvidenceB64: finalSteady.b64,
    steadyStateEvidenceSha256: finalSteady.sha256,
  };
}

test("accepts separate v4 binding, non-authorizing execution, steady proof and v5 approval", () => {
  const summary = validateAudit0107ReleaseEvidence(validInput(), {
    now: Date.parse("2026-08-12T08:15:00.000Z"),
  });
  assert.equal(summary.decision, "PASS");
  assert.equal(summary.buildSha, BUILD_SHA);
  assert.equal(summary.lineage.opaqueLegacyRowCount, 0);
  assert.deepEqual(createRuntimeMigrationReleaseBinding(summary), {
    schemaVersion: "site-logbook.runtime-migration-release-binding/v1",
    buildSha: BUILD_SHA,
    releaseEvidenceSha256: summary.releaseEvidenceSha256,
    lineage: summary.lineage,
  });
});

test("does not reinterpret the host execution artifact as startup authorization", () => {
  const input = validInput(({ executionValue }) => {
    executionValue.authorizesApplicationStart = true;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(input, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /execution\.authorizesApplicationStart must equal false/,
  );
});

test("keeps the predecessor schema-v4 evidence as a separate immutable binding", () => {
  const input = validInput(({ releaseValue }) => {
    releaseValue.predecessorReleaseEvidence.schemaVersion = 5;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(input, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /predecessorReleaseEvidence\.schemaVersion must equal 4/,
  );
});

test("rejects BUILD_SHA drift, noncanonical bytes and missing release approval", () => {
  const drift = validInput();
  drift.buildSha = "b".repeat(40);
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(drift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /execution\.sourceSha/,
  );

  const noncanonical = validInput();
  const parsed = JSON.parse(
    Buffer.from(noncanonical.steadyStateEvidenceB64, "base64").toString("utf8"),
  );
  const pretty = artifact(parsed, false);
  noncanonical.steadyStateEvidenceB64 = pretty.b64;
  noncanonical.steadyStateEvidenceSha256 = pretty.sha256;
  assert.throws(
    () => validateAudit0107ReleaseEvidence(noncanonical),
    /steadyStateEvidence must use canonical sorted JSON/,
  );

  const denied = validInput(({ releaseValue }) => {
    releaseValue.approval.authorizesApplicationStart = false;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(denied, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /approval\.authorizesApplicationStart must equal true/,
  );
});

test("binds the approved compose and secret-free deployment configuration digests", () => {
  const composeDrift = validInput();
  composeDrift.resolvedComposeSha256 = `sha256:${"8".repeat(64)}`;
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(composeDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /deploymentBinding\.resolvedComposeSha256/,
  );

  const configDrift = validInput();
  configDrift.deploymentConfigSha256 = `sha256:${"9".repeat(64)}`;
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(configDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /deploymentBinding\.deploymentConfigSha256/,
  );
});

test("requires the raw canonical intent and exact live Postgres target binding", () => {
  const intentDrift = validInput(({ intentValue }) => {
    intentValue.authorizesOnly = "different-transition";
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(intentDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /intent\.authorizesOnly/,
  );

  const runtimeDrift = validInput(({ intentValue }) => {
    intentValue.runtimeBinding.resolvedComposeSha256 = `sha256:${"8".repeat(64)}`;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(runtimeDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /intent\.runtimeBinding/,
  );

  const targetDrift = validInput();
  targetDrift.livePostgresTargetSha256 = `sha256:${"9".repeat(64)}`;
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(targetDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /livePostgresTargetSha256/,
  );
});

test("rejects weakened one-shot isolation and non-exact known journal lineage", () => {
  const isolationDrift = validInput(({ executionValue }) => {
    executionValue.runtimeIsolation.apiStarted = true;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(isolationDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /runtimeIsolation\.apiStarted must equal false/,
  );

  const journalDrift = validInput(({ steadyValue, releaseValue }) => {
    steadyValue.lineage.knownAppliedRowsSha256 = `sha256:${"9".repeat(64)}`;
    releaseValue.lineage.knownAppliedRowsSha256 = `sha256:${"9".repeat(64)}`;
  });
  assert.throws(
    () =>
      validateAudit0107ReleaseEvidence(journalDrift, {
        now: Date.parse("2026-08-12T08:15:00.000Z"),
      }),
    /knownAppliedRowsSha256/,
  );
});
