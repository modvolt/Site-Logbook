import {
  ExternalSchemaPreflightError,
  readExternalSchemaInventoryEnvironment,
  runExternalSchemaInventory,
} from "@workspace/db/external-schema-preflight";
import {
  evaluateStagingBaseline0104Decision,
  readStagingBaseline0104Environment,
  StagingBaseline0104Error,
} from "@workspace/db/staging-baseline-0104";

async function main(): Promise<void> {
  const baseline = readStagingBaseline0104Environment();
  const inventory = await runExternalSchemaInventory(
    readExternalSchemaInventoryEnvironment(),
  );
  const decision = evaluateStagingBaseline0104Decision(
    baseline.phase,
    inventory,
  );
  const marker = baseline.phase === "pre" ? "PRECHECK" : "POSTCHECK";
  // Deliberately excludes DATABASE_URL, object paths, hashes and key ids.
  process.stdout.write(
    `[staging-baseline-0104] ${marker} ${JSON.stringify({
      phase: baseline.phase,
      operation: decision.operation,
      decision: decision.decision,
      candidateSourceSha: baseline.candidateSourceSha,
      predecessorSourceSha: baseline.predecessorSourceSha,
      appliedMigrations: inventory.appliedMigrations,
      predecessorMigrations: inventory.predecessorMigrations,
      latestAppliedTag: inventory.latestAppliedTag,
      missingToPredecessor: inventory.missingToPredecessor,
      backupEvidenceId: inventory.backupEvidenceId,
      backupRestoreAgeHours: inventory.backupRestoreAgeHours,
      inputSha256: `sha256:${baseline.inputsSha256}`,
      authorizes0105: false,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  let failure: { code: string; message: string };
  if (
    error instanceof ExternalSchemaPreflightError ||
    error instanceof StagingBaseline0104Error
  ) {
    failure = { code: error.code, message: error.message };
  } else {
    failure = {
      code: "UNEXPECTED_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.stderr.write(
    `[staging-baseline-0104] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
