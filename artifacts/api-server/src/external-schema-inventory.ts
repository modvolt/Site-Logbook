import {
  ExternalSchemaPreflightError,
  readExternalSchemaInventoryEnvironment,
  runExternalSchemaInventory,
} from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const config = readExternalSchemaInventoryEnvironment();
  const summary = await runExternalSchemaInventory(config);
  // Deliberately excludes DATABASE_URL, object paths, hashes and key ids.
  process.stdout.write(
    `[external-schema-inventory] PASS ${JSON.stringify(summary)}\n`,
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
    `[external-schema-inventory] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
