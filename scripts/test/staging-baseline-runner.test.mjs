import assert from "node:assert/strict";
import test from "node:test";
import {
  StagingBaseline0104RunnerError,
  runStagingBaseline0104,
} from "../run-staging-baseline-0104.mjs";

const INPUT_SHA = "a".repeat(64);
const CANDIDATE_SHA = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";
const PREDECESSOR_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const CONFIRMATION =
  "APPLY_FIXED_PREDECESSOR_0104_TO_ISOLATED_SITE_LOGBOOK_STAGING";

function gateMarker(phase, operation, overrides = {}) {
  const pre = phase === "pre";
  const migrate = operation === "migrate";
  const value = {
    phase,
    operation,
    decision: migrate ? "BASELINE_0104_REQUIRED" : "READY_0104",
    candidateSourceSha: CANDIDATE_SHA,
    predecessorSourceSha: PREDECESSOR_SHA,
    appliedMigrations: migrate ? 103 : 104,
    predecessorMigrations: 104,
    latestAppliedTag: migrate
      ? "0103_previous"
      : "0104_thin_sheva_callister",
    missingToPredecessor: migrate ? 1 : 0,
    backupEvidenceId: 77,
    backupRestoreAgeHours: 1.25,
    inputSha256: `sha256:${INPUT_SHA}`,
    authorizes0105: false,
    ...overrides,
  };
  return `[staging-baseline-0104] ${pre ? "PRECHECK" : "POSTCHECK"} ${JSON.stringify(value)}\n`;
}

function executor({ preOperation = "migrate", running = "postgres\n", post = {} } = {}) {
  const calls = [];
  const execute = (args) => {
    calls.push(args);
    if (args.includes("ps")) return { status: 0, stdout: running, stderr: "" };
    const service = args.at(-1);
    if (service === "baseline-0104-preflight") {
      return {
        status: 0,
        stdout: gateMarker("pre", preOperation),
        stderr: "",
      };
    }
    if (service === "baseline-0104-migrator") {
      return {
        status: 0,
        stdout: `[migration] success ${JSON.stringify({
          expected: 104,
          applied: 104,
          newlyApplied: 1,
          latestExpected: "0104_thin_sheva_callister",
        })}\n`,
        stderr: "",
      };
    }
    if (service === "baseline-0104-postflight") {
      return {
        status: 0,
        stdout: gateMarker("post", "ready", post),
        stderr: "",
      };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  return { execute, calls };
}

function options(execute) {
  const times = [
    new Date("2026-08-09T20:00:00.000Z"),
    new Date("2026-08-09T20:01:00.000Z"),
  ];
  return {
    expectedInputsSha256: INPUT_SHA,
    confirmation: CONFIRMATION,
    execute,
    now: () => times.shift(),
  };
}

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) =>
      error instanceof StagingBaseline0104RunnerError && error.code === code,
  );
}

test("runs precheck, fixed predecessor migrator and exact-0104 postcheck", () => {
  const mock = executor();
  const evidence = runStagingBaseline0104(options(mock.execute));
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.operation, "migrate");
  assert.equal(evidence.migration.executed, true);
  assert.equal(evidence.migration.summary.newlyApplied, 1);
  assert.equal(evidence.postcheck.latestAppliedTag, "0104_thin_sheva_callister");
  assert.equal(evidence.requiresFreshExact0104BackupAndRestore, true);
  assert.equal(evidence.authorizes0105, false);
  assert.equal(
    mock.calls.filter((args) => args.at(-1) === "baseline-0104-migrator")
      .length,
    1,
  );
});

test("is idempotent at exact 0104 and skips the predecessor migrator", () => {
  const mock = executor({ preOperation: "verified-noop" });
  const evidence = runStagingBaseline0104(options(mock.execute));
  assert.equal(evidence.operation, "verified-noop");
  assert.equal(evidence.migration.executed, false);
  assert.equal(evidence.migration.summary, null);
  assert.equal(
    mock.calls.filter((args) => args.at(-1) === "baseline-0104-migrator")
      .length,
    0,
  );
});

test("refuses any running service besides isolated postgres", () => {
  const mock = executor({ running: "postgres\napi\n" });
  expectCode("BASELINE_RUNTIME_NOT_QUIESCENT", () =>
    runStagingBaseline0104(options(mock.execute)),
  );
  assert.equal(
    mock.calls.some((args) => args.at(-1) === "baseline-0104-preflight"),
    false,
  );
});

test("requires separate expected checksum and exact runner confirmation", () => {
  const mock = executor();
  expectCode("BASELINE_EXPECTED_INPUTS_INVALID", () =>
    runStagingBaseline0104({
      ...options(mock.execute),
      expectedInputsSha256: "short",
    }),
  );
  expectCode("BASELINE_RUNNER_CONFIRMATION_INVALID", () =>
    runStagingBaseline0104({
      ...options(mock.execute),
      confirmation: "approve",
    }),
  );
});

test("fails closed on missing marker, command failure and non-0104 postcheck", () => {
  const missingMarker = executor();
  const original = missingMarker.execute;
  missingMarker.execute = (args) =>
    args.at(-1) === "baseline-0104-preflight"
      ? { status: 0, stdout: "no marker\n", stderr: "" }
      : original(args);
  expectCode("BASELINE_EVIDENCE_MARKER_INVALID", () =>
    runStagingBaseline0104(options(missingMarker.execute)),
  );

  const commandFailure = executor();
  const originalFailure = commandFailure.execute;
  commandFailure.execute = (args) =>
    args.at(-1) === "baseline-0104-preflight"
      ? { status: 1, stdout: "", stderr: "secret-shaped diagnostic" }
      : originalFailure(args);
  expectCode("BASELINE_COMMAND_FAILED", () =>
    runStagingBaseline0104(options(commandFailure.execute)),
  );

  const wrongPost = executor({
    post: {
      decision: "ALREADY_0105",
      appliedMigrations: 105,
      latestAppliedTag: "0105_smooth_nitro",
    },
  });
  expectCode("BASELINE_EVIDENCE_STATE_INVALID", () =>
    runStagingBaseline0104(options(wrongPost.execute)),
  );
});
