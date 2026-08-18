import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./check-staging-provisioning.mjs";
import {
  validateStagingAccounting0106Execution,
  validateStagingAccounting0106TransitionArtifacts,
} from "./run-staging-accounting-0106-transition.mjs";

const SHA256 = /^[0-9a-f]{64}$/;

export class StagingAccounting0106ExecutionVerifierError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAccounting0106ExecutionVerifierError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingAccounting0106ExecutionVerifierError(code, message);
}

function trustedArtifact(bytes, checksumText, expectedSha256, name, label) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    !SHA256.test(expectedSha256 ?? "")
  ) {
    fail(
      "ACCOUNTING_0106_VERIFY_INPUT_INVALID",
      `${label} bytes and approved SHA-256 are required.`,
    );
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256 || checksumText !== `${sha256}  ${name}\n`) {
    fail(
      "ACCOUNTING_0106_VERIFY_HASH_MISMATCH",
      `${label} checksum does not match exact bytes.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "ACCOUNTING_0106_VERIFY_JSON_INVALID",
      `${label} must be strict JSON.`,
    );
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    fail(
      "ACCOUNTING_0106_VERIFY_CANONICAL_INVALID",
      `${label} must use canonical JSON bytes.`,
    );
  }
  return Object.freeze({ value, sha256 });
}

export function verifyStagingAccounting0106Execution({
  expectedSourceSha,
  transitionBytes,
  transitionChecksumText,
  expectedTransitionSha256,
  inspectBytes,
  inspectChecksumText,
  expectedInspectSha256,
  backupExecutionBytes,
  backupExecutionChecksumText,
  expectedBackupExecutionSha256,
  executionBytes,
  executionChecksumText,
  expectedExecutionSha256,
}) {
  const inputs = validateStagingAccounting0106TransitionArtifacts({
    expectedSourceSha,
    transitionBytes,
    transitionChecksumText,
    expectedTransitionSha256,
    inspectBytes,
    inspectChecksumText,
    expectedInspectSha256,
    backupExecutionBytes,
    backupExecutionChecksumText,
    expectedBackupExecutionSha256,
  });
  const execution = trustedArtifact(
    executionBytes,
    executionChecksumText,
    expectedExecutionSha256,
    "staging-accounting-0106-execution.json",
    "accounting 0106 execution",
  );
  const value = validateStagingAccounting0106Execution(execution.value, inputs);
  return Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    sourceSha: inputs.sourceSha,
    operation: value.operation,
    latestExpectedTag: value.schemaGate.latestExpectedTag,
    transitionInputsSha256: value.transitionInputsSha256,
    derivedInspectInputsSha256: value.derivedInspectInputsSha256,
    backupExecutionSha256: value.backupExecutionSha256,
    executionSha256: `sha256:${execution.sha256}`,
    productionTargetsTouched: false,
    eligibleForStagingApplicationStartApproval: true,
    deployPerformed: false,
    nextGate: "separate-staging-application-start-approval",
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value)
    fail("ACCOUNTING_0106_VERIFY_ARGUMENT_MISSING", `${name} is required.`);
  return value;
}

function readPair(fileFlag, checksumFlag) {
  return {
    bytes: fs.readFileSync(path.resolve(requiredArgument(fileFlag))),
    checksum: fs.readFileSync(
      path.resolve(requiredArgument(checksumFlag)),
      "utf8",
    ),
  };
}

function main() {
  const transition = readPair(
    "--transition-inputs",
    "--transition-inputs-checksum",
  );
  const inspect = readPair("--inspect-inputs", "--inspect-inputs-checksum");
  const backup = readPair("--backup-execution", "--backup-execution-checksum");
  const execution = readPair("--execution", "--execution-checksum");
  const result = verifyStagingAccounting0106Execution({
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    transitionBytes: transition.bytes,
    transitionChecksumText: transition.checksum,
    expectedTransitionSha256: requiredArgument(
      "--expected-transition-inputs-sha256",
    ),
    inspectBytes: inspect.bytes,
    inspectChecksumText: inspect.checksum,
    expectedInspectSha256: requiredArgument("--expected-inspect-inputs-sha256"),
    backupExecutionBytes: backup.bytes,
    backupExecutionChecksumText: backup.checksum,
    expectedBackupExecutionSha256: requiredArgument(
      "--expected-backup-execution-sha256",
    ),
    executionBytes: execution.bytes,
    executionChecksumText: execution.checksum,
    expectedExecutionSha256: requiredArgument("--expected-execution-sha256"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
