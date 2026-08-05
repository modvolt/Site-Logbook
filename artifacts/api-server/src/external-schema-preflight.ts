import {
  ExternalSchemaPreflightError,
  readExternalSchemaPreflightEnvironment,
  runExternalSchemaPreflight,
} from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const config = readExternalSchemaPreflightEnvironment();
  const summary = await runExternalSchemaPreflight(config);
  // The summary deliberately excludes DATABASE_URL, object paths, hashes,
  // encryption key ids and every secret value.
  process.stdout.write(
    `[external-schema-preflight] PASS ${JSON.stringify(summary)}\n`,
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
    `[external-schema-preflight] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
