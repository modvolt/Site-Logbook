import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  createStagingExact0104RecoveryBinding,
  StagingExact0104RecoveryBindingError,
  writeStagingExact0104RecoveryBinding,
} from "../check-staging-exact-0104-recovery-binding.mjs";

const SOURCE_SHA = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";
const OLD_BACKUP_ID = 71;

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function artifacts(overrides = {}) {
  const inputs = {
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104",
    action: "apply-0104-baseline",
    productionTargetsTouched: false,
    environmentId: "site-logbook-staging",
    composeProjectName: "site-logbook-staging",
    database: {
      host: "postgres",
      name: "site_logbook_staging",
      user: "site_logbook_staging",
    },
    externalAccountsEnabled: false,
    candidate: {
      sourceSha: SOURCE_SHA,
      imageManifestSha256: "a".repeat(64),
      provisioningManifestSha256: "b".repeat(64),
      inspectInputsSha256: "c".repeat(64),
      apiImage: `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"d".repeat(64)}`,
    },
    predecessor: {
      sourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
      sourceTree: "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c",
      imageManifestSha256: "e".repeat(64),
      apiImage: `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"f".repeat(64)}`,
      publisherRun: { id: "123", attempt: "1" },
    },
    backup: { evidenceId: OLD_BACKUP_ID, restoreMaxAgeHours: 24 },
    target: {
      migrationCount: 104,
      latestTag: "0104_thin_sheva_callister",
      excluded0100: true,
      excluded0105: true,
    },
    nextGate: "fresh-exact-0104-backup-and-restore-required",
    authorizes0105: false,
  };
  const inputsBytes = Buffer.from(canonicalJson(inputs));
  const inputsSha256 = digest(inputsBytes);
  const execution = {
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt: "2026-08-09T18:00:00.000Z",
    completedAt: "2026-08-09T18:01:00.000Z",
    inputSha256: `sha256:${inputsSha256}`,
    operation: "migrate",
    precheck: {
      phase: "pre",
      operation: "migrate",
      decision: "BASELINE_0104_REQUIRED",
      candidateSourceSha: SOURCE_SHA,
      predecessorSourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
      appliedMigrations: 103,
      predecessorMigrations: 104,
      latestAppliedTag: "0103_example",
      missingToPredecessor: 1,
      backupEvidenceId: OLD_BACKUP_ID,
      backupRestoreAgeHours: 1,
      inputSha256: `sha256:${inputsSha256}`,
      authorizes0105: false,
    },
    migration: {
      executed: true,
      summary: {
        expected: 104,
        applied: 104,
        newlyApplied: 1,
        latestExpected: "0104_thin_sheva_callister",
      },
    },
    postcheck: {
      phase: "post",
      operation: "ready",
      decision: "READY_0104",
      candidateSourceSha: SOURCE_SHA,
      predecessorSourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
      appliedMigrations: 104,
      predecessorMigrations: 104,
      latestAppliedTag: "0104_thin_sheva_callister",
      missingToPredecessor: 0,
      backupEvidenceId: OLD_BACKUP_ID,
      backupRestoreAgeHours: 1,
      inputSha256: `sha256:${inputsSha256}`,
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
    ...overrides,
  };
  const executionBytes = Buffer.from(canonicalJson(execution));
  const executionSha256 = digest(executionBytes);
  return {
    inputsBytes,
    inputsSha256,
    inputsChecksumText: `${inputsSha256}  staging-baseline-0104-inputs.json\n`,
    executionBytes,
    executionSha256,
    executionChecksumText: `${executionSha256}  staging-baseline-0104-execution.json\n`,
  };
}

function binding(overrides = {}, executionOverrides = {}) {
  const value = artifacts(executionOverrides);
  return createStagingExact0104RecoveryBinding({
    baselineInputsBytes: value.inputsBytes,
    baselineInputsChecksumText: value.inputsChecksumText,
    expectedBaselineInputsSha256: value.inputsSha256,
    baselineExecutionBytes: value.executionBytes,
    baselineExecutionChecksumText: value.executionChecksumText,
    expectedBaselineExecutionSha256: value.executionSha256,
    backupEvidenceId: 72,
    backupRestoreMaxAgeHours: 24,
    ...overrides,
  });
}

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) =>
      error instanceof StagingExact0104RecoveryBindingError &&
      error.code === code,
  );
}

test("binds a new post-baseline backup without authorizing 0105", () => {
  const result = binding();
  assert.equal(result.decision, "PASS");
  assert.equal(result.inputs.backup.evidenceId, 72);
  assert.equal(
    result.inputs.backup.mustBeCreatedAfter,
    "2026-08-09T18:01:00.000Z",
  );
  assert.equal(result.inputs.target.migrationCount, 104);
  assert.equal(result.inputs.authorizes0105, false);
  assert.equal(result.environment.STAGING_SCHEMA_ACTION, "inspect");
  assert.equal(
    result.environment.STAGING_EXACT_0104_RECOVERY_INPUTS_SHA256,
    result.inputsSha256,
  );
});

test("accepts an exact-0104 verified-noop baseline without a migrator run", () => {
  const result = binding(
    {},
    {
      operation: "verified-noop",
      precheck: {
        phase: "pre",
        operation: "verified-noop",
        decision: "READY_0104",
        candidateSourceSha: SOURCE_SHA,
        predecessorSourceSha: "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3",
        appliedMigrations: 104,
        predecessorMigrations: 104,
        latestAppliedTag: "0104_thin_sheva_callister",
        missingToPredecessor: 0,
        backupEvidenceId: OLD_BACKUP_ID,
        backupRestoreAgeHours: 1,
        inputSha256: `sha256:${artifacts().inputsSha256}`,
        authorizes0105: false,
      },
      migration: { executed: false, summary: null },
    },
  );
  assert.equal(result.inputs.baseline.operation, "verified-noop");
});

test("rejects stale artifacts, widened baseline and reused backup id", () => {
  const value = artifacts();
  expectCode("RECOVERY_BINDING_ARTIFACT_UNTRUSTED", () =>
    createStagingExact0104RecoveryBinding({
      baselineInputsBytes: value.inputsBytes,
      baselineInputsChecksumText: `${"0".repeat(64)}  staging-baseline-0104-inputs.json\n`,
      expectedBaselineInputsSha256: value.inputsSha256,
      baselineExecutionBytes: value.executionBytes,
      baselineExecutionChecksumText: value.executionChecksumText,
      expectedBaselineExecutionSha256: value.executionSha256,
      backupEvidenceId: 72,
      backupRestoreMaxAgeHours: 24,
    }),
  );
  expectCode("RECOVERY_BINDING_BACKUP_NOT_NEW", () =>
    binding({ backupEvidenceId: OLD_BACKUP_ID }),
  );
  expectCode("RECOVERY_BINDING_BASELINE_EXECUTION_INVALID", () =>
    binding({}, { authorizes0105: true }),
  );
});

test("rejects sensitive or unapproved fields in inherited artifacts", () => {
  expectCode("RECOVERY_BINDING_SECRET_MATERIAL", () =>
    binding({}, { databaseUrl: "redacted" }),
  );
  expectCode("RECOVERY_BINDING_SCHEMA_INVALID", () =>
    binding({}, { unexpected: false }),
  );
  expectCode("RECOVERY_BINDING_BASELINE_MIGRATION_INVALID", () =>
    binding(
      {},
      {
        migration: {
          executed: true,
          summary: {
            expected: 104,
            applied: 104,
            newlyApplied: 0,
            latestExpected: "0104_thin_sheva_callister",
          },
        },
      },
    ),
  );
});

test("writes canonical recovery inputs exactly once", () => {
  const result = binding();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-binding-"));
  try {
    const files = writeStagingExact0104RecoveryBinding(directory, result);
    assert.equal(
      JSON.parse(fs.readFileSync(files.inputs, "utf8")).nextGate,
      "separate-0105-transition-binding-required",
    );
    expectCode("RECOVERY_BINDING_OUTPUT_EXISTS", () =>
      writeStagingExact0104RecoveryBinding(directory, result),
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
