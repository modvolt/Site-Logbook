import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUDIT_0107_FILES,
  audit0107Fail,
  readRegularFile,
  requiredArgument,
  trustedCanonicalArtifact,
} from "./staging-audit-0107-contract.mjs";
import {
  validateStagingAudit0107Execution,
  validateStagingAudit0107Intent,
  validateStagingAudit0107TransitionArtifacts,
} from "./run-staging-audit-0107-transition.mjs";
import { canonicalJson } from "./check-staging-provisioning.mjs";

export class StagingAudit0107ExecutionVerifierError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAudit0107ExecutionVerifierError";
    this.code = code;
  }
}

function wrap(error) {
  if (error instanceof StagingAudit0107ExecutionVerifierError) throw error;
  const code =
    typeof error?.code === "string" ? error.code : "AUDIT_0107_VERIFY_INVALID";
  throw new StagingAudit0107ExecutionVerifierError(
    code,
    error instanceof Error ? error.message : String(error),
  );
}

export function verifyStagingAudit0107Execution({
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
  intentBytes,
  intentChecksumText,
  expectedIntentSha256,
  executionBytes,
  executionChecksumText,
  expectedExecutionSha256,
}) {
  try {
    const inputs = validateStagingAudit0107TransitionArtifacts({
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
    const execution = trustedCanonicalArtifact({
      bytes: executionBytes,
      checksumText: executionChecksumText,
      expectedSha256: expectedExecutionSha256,
      name: AUDIT_0107_FILES.execution,
      label: "audit 0107 execution",
    });
    const intent = trustedCanonicalArtifact({
      bytes: intentBytes,
      checksumText: intentChecksumText,
      expectedSha256: expectedIntentSha256,
      name: AUDIT_0107_FILES.intent,
      label: "audit 0107 intent",
    });
    const intentValue = validateStagingAudit0107Intent(intent.value, inputs);
    const value = validateStagingAudit0107Execution(execution.value, inputs);
    if (
      value.intentSha256 !== `sha256:${intent.sha256}` ||
      canonicalJson(value.runtimeBinding) !==
        canonicalJson(intentValue.runtimeBinding)
    ) {
      audit0107Fail(
        "AUDIT_0107_INTENT_EXECUTION_MISMATCH",
        "Execution does not bind the exact canonical pre-transition intent bytes.",
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      decision: "PASS",
      sourceSha: inputs.sourceSha,
      operation: value.operation,
      latestExpectedTag: value.schemaGate.after.schema.targetTag,
      lineageMode: value.lineage.mode,
      opaqueLegacyRowsSha256: value.lineage.opaqueLegacyRowsSha256,
      transitionInputsSha256: value.transitionInputsSha256,
      derivedInspectInputsSha256: value.derivedInspectInputsSha256,
      backupExecutionSha256: value.backupExecutionSha256,
      intentSha256: value.intentSha256,
      resolvedComposeSha256: value.runtimeBinding.resolvedComposeSha256,
      deploymentConfigSha256: value.runtimeBinding.deploymentConfigSha256,
      livePostgresTargetSha256:
        value.runtimeBinding.livePostgresTarget.projectionSha256,
      executionSha256: `sha256:${execution.sha256}`,
      productionTargetsTouched: false,
      eligibleForSeparateStagingApplicationStartApproval: true,
      authorizesApplicationStart: false,
      deployPerformed: false,
      nextGate: "separate-audit-0107-startup-evidence",
    });
  } catch (error) {
    wrap(error);
  }
}

function readPair(fileFlag, checksumFlag, label) {
  const file = readRegularFile(requiredArgument(fileFlag), label);
  const checksum = readRegularFile(
    requiredArgument(checksumFlag),
    `${label} checksum`,
  );
  return {
    bytes: fs.readFileSync(file),
    checksum: fs.readFileSync(checksum, "utf8"),
  };
}

function main() {
  const transition = readPair(
    "--transition-inputs",
    "--transition-inputs-checksum",
    "transition inputs",
  );
  const inspect = readPair(
    "--inspect-inputs",
    "--inspect-inputs-checksum",
    "inspect inputs",
  );
  const backup = readPair(
    "--backup-execution",
    "--backup-execution-checksum",
    "backup execution",
  );
  const intent = readPair("--intent", "--intent-checksum", "transition intent");
  const execution = readPair(
    "--execution",
    "--execution-checksum",
    "execution",
  );
  const result = verifyStagingAudit0107Execution({
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
    intentBytes: intent.bytes,
    intentChecksumText: intent.checksum,
    expectedIntentSha256: requiredArgument("--expected-intent-sha256"),
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
    const failure =
      error instanceof StagingAudit0107ExecutionVerifierError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-audit-0107-execution-verifier] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}
