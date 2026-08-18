import { fileURLToPath } from "node:url";
import { runAccountingSchemaSteadyState } from "@workspace/db/accounting-schema-preflight";
import {
  ExternalSchemaPreflightError,
  readExternalSchemaRuntimeEnvironment,
} from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const summary = await runAccountingSchemaSteadyState(
    readExternalSchemaRuntimeEnvironment(),
  );
  process.stdout.write(
    `[accounting-schema-steady-state] PASS ${JSON.stringify(summary)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const failure =
      error instanceof ExternalSchemaPreflightError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[accounting-schema-steady-state] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
