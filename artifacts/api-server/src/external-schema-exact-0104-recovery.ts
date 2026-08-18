import {
  ExternalSchemaPreflightError,
  runExternalSchemaExact0104Recovery,
} from "@workspace/db/external-schema-preflight";
import {
  readStagingExact0104RecoveryEnvironment,
  StagingExact0104RecoveryError,
} from "@workspace/db/staging-exact-0104-recovery";

async function main(): Promise<void> {
  const recovery = readStagingExact0104RecoveryEnvironment();
  const result = await runExternalSchemaExact0104Recovery(recovery.runtime);
  // Deliberately excludes DATABASE_URL, object paths, key ids and raw table counts.
  process.stdout.write(
    `[staging-exact-0104-recovery] PASS ${JSON.stringify({
      ...result,
      recoveryInputsSha256: `sha256:${recovery.inputsSha256}`,
      baselineExecutionSha256: `sha256:${recovery.baselineExecutionSha256}`,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  let failure: { code: string; message: string };
  if (
    error instanceof ExternalSchemaPreflightError ||
    error instanceof StagingExact0104RecoveryError
  ) {
    failure = { code: error.code, message: error.message };
  } else {
    failure = {
      code: "UNEXPECTED_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.stderr.write(
    `[staging-exact-0104-recovery] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
