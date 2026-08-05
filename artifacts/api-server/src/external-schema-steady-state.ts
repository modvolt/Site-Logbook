import {
  ExternalSchemaPreflightError,
  readExternalSchemaRuntimeEnvironment,
  runExternalSchemaSteadyState,
} from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const config = readExternalSchemaRuntimeEnvironment();
  const summary = await runExternalSchemaSteadyState(config);
  // Routine restarts prove schema/runtime state without historical backup data.
  process.stdout.write(
    `[external-schema-steady-state] PASS ${JSON.stringify(summary)}\n`,
  );
}

main().catch((error: unknown) => {
  const failure =
    error instanceof ExternalSchemaPreflightError
      ? { code: error.code, message: error.message }
      : {
          code: "UNEXPECTED_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(
    `[external-schema-steady-state] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
