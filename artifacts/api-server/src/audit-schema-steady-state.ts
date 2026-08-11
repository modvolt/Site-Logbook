import { fileURLToPath } from "node:url";
import {
  readAuditSchemaRuntimeEnvironment,
  runAuditSchemaSteadyState,
} from "@workspace/db/audit-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const summary = await runAuditSchemaSteadyState(
    readAuditSchemaRuntimeEnvironment(),
  );
  process.stdout.write(
    `[audit-schema-steady-state] PASS ${JSON.stringify(summary)}\n`,
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
      `[audit-schema-steady-state] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
