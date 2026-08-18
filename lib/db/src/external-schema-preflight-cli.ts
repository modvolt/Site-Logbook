import {
  ExternalSchemaPreflightError,
  readExternalSchemaPreflightEnvironment,
  runExternalSchemaPreflight,
} from "./external-schema-preflight.js";

async function main(): Promise<void> {
  const config = readExternalSchemaPreflightEnvironment();
  const summary = await runExternalSchemaPreflight(config);
  // The summary deliberately excludes DATABASE_URL and every secret value.
  process.stdout.write(
    `[external-schema-preflight] PASS ${JSON.stringify(summary)}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ExternalSchemaPreflightError) {
    process.stderr.write(
      `[external-schema-preflight] FAIL ${JSON.stringify({
        code: error.code,
        message: error.message,
      })}\n`,
    );
  } else {
    process.stderr.write(
      `[external-schema-preflight] FAIL ${JSON.stringify({
        code: "UNEXPECTED_FAILURE",
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  process.exitCode = 1;
});
