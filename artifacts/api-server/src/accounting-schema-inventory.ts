import {
  readAccountingSchemaInventoryEnvironment,
  runAccountingSchemaInventory,
} from "@workspace/db/accounting-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";

async function main(): Promise<void> {
  const summary = await runAccountingSchemaInventory(
    readAccountingSchemaInventoryEnvironment(),
  );
  process.stdout.write(
    `[accounting-schema-inventory] PASS ${JSON.stringify(summary)}\n`,
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
    `[accounting-schema-inventory] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
