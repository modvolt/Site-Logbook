import assert from "node:assert/strict";
import test from "node:test";
import {
  runStagingExact0104Recovery,
  StagingExact0104RecoveryRunnerError,
} from "../run-staging-exact-0104-recovery.mjs";

const INPUT_SHA = "a".repeat(64);
const SOURCE_SHA = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";

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
      ...backupOverrides,
    },
    authorizes0105: false,
    recoveryInputsSha256: `sha256:${INPUT_SHA}`,
    baselineExecutionSha256: `sha256:${"f".repeat(64)}`,
    ...overrides,
  };
  return `[staging-exact-0104-recovery] PASS ${JSON.stringify(value)}\n`;
}

function executor({
  running = "postgres\n",
  output = marker(),
  status = 0,
} = {}) {
  const calls = [];
  const execute = (args) => {
    calls.push(args);
    if (args.includes("ps")) return { status: 0, stdout: running, stderr: "" };
    if (args.at(-1) === "exact-0104-recovery-gate") {
      return { status, stdout: output, stderr: "redacted" };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  return { calls, execute };
}

function options(execute) {
  const times = [
    new Date("2026-08-09T18:05:00.000Z"),
    new Date("2026-08-09T18:06:00.000Z"),
  ];
  return {
    expectedInputsSha256: INPUT_SHA,
    execute,
    now: () => times.shift(),
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

test("captures read-only exact-0104 backup and restore evidence", () => {
  const mock = executor();
  const evidence = runStagingExact0104Recovery(options(mock.execute));
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.gate.backup.id, 72);
  assert.equal(
    evidence.runtimeIsolation.onlyPostgresRunningAtEveryBoundary,
    true,
  );
  assert.equal(evidence.nextGate, "separate-0105-transition-binding-required");
  assert.equal(evidence.authorizes0105, false);
  assert.equal(
    mock.calls.filter((args) => args.at(-1) === "exact-0104-recovery-gate")
      .length,
    1,
  );
});

test("refuses a non-quiescent project before reading recovery evidence", () => {
  const mock = executor({ running: "postgres\napi\n" });
  expectCode("RECOVERY_RUNTIME_NOT_QUIESCENT", () =>
    runStagingExact0104Recovery(options(mock.execute)),
  );
  assert.equal(
    mock.calls.some((args) => args.at(-1) === "exact-0104-recovery-gate"),
    false,
  );
});

test("rejects stale input binding, pre-baseline backup and 0105 widening", () => {
  const mock = executor();
  expectCode("RECOVERY_EXPECTED_INPUTS_INVALID", () =>
    runStagingExact0104Recovery({
      ...options(mock.execute),
      expectedInputsSha256: "short",
    }),
  );
  const oldBackup = executor({
    output: marker({}, { createdAt: "2026-08-09T18:00:00.000Z" }),
  });
  expectCode("RECOVERY_EVIDENCE_TIME_INVALID", () =>
    runStagingExact0104Recovery(options(oldBackup.execute)),
  );
  const widened = executor({ output: marker({ authorizes0105: true }) });
  expectCode("RECOVERY_EVIDENCE_INVALID", () =>
    runStagingExact0104Recovery(options(widened.execute)),
  );
});

test("rejects extra root or backup fields instead of persisting them", () => {
  const extraRoot = executor({ output: marker({ databaseUrl: "redacted" }) });
  expectCode("RECOVERY_EVIDENCE_SCHEMA_INVALID", () =>
    runStagingExact0104Recovery(options(extraRoot.execute)),
  );
  const extraBackup = executor({
    output: marker({}, { encryptionKeyId: "not-a-fingerprint" }),
  });
  expectCode("RECOVERY_EVIDENCE_SCHEMA_INVALID", () =>
    runStagingExact0104Recovery(options(extraBackup.execute)),
  );
});

test("does not include command stderr when the gate fails", () => {
  const failed = executor({ status: 1, output: "" });
  assert.throws(
    () => runStagingExact0104Recovery(options(failed.execute)),
    (error) => {
      assert.ok(error instanceof StagingExact0104RecoveryRunnerError);
      assert.equal(error.code, "RECOVERY_COMMAND_FAILED");
      assert.doesNotMatch(error.message, /redacted/);
      return true;
    },
  );
});
