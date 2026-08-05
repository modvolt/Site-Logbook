import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ExternalSchemaPreflightError,
  readExternalSchemaInventoryEnvironment,
  readExternalSchemaPreflightEnvironment,
  readExternalSchemaRuntimeEnvironment,
  runExternalSchemaInventory,
  runExternalSchemaPreflight,
  runExternalSchemaSteadyState,
} from "@workspace/db/external-schema-preflight";

function runMigrator(): Promise<void> {
  const migrator = fileURLToPath(new URL("./migrate.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [migrator], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Standard migrator failed with ${
              signal ? `signal ${signal}` : `exit code ${String(code)}`
            }.`,
          ),
        );
    });
  });
}

async function verifySteadyState(): Promise<void> {
  const summary = await runExternalSchemaSteadyState(
    readExternalSchemaRuntimeEnvironment(),
  );
  process.stdout.write(
    `[external-schema-gate] NOOP ${JSON.stringify(summary)}\n`,
  );
}

async function main(): Promise<void> {
  const action = process.env.STAGING_SCHEMA_ACTION;
  if (action === "steady-0105") {
    await verifySteadyState();
    return;
  }
  if (action !== "apply-0105") {
    throw new ExternalSchemaPreflightError(
      "SCHEMA_ACTION_INVALID",
      "The transition gate accepts only apply-0105 or steady-0105.",
    );
  }

  // Make an approved transition idempotent: if a previous run already reached
  // exact 0105, validate and return without consulting an aging backup record.
  try {
    await verifySteadyState();
    return;
  } catch (error) {
    if (
      !(error instanceof ExternalSchemaPreflightError) ||
      error.code !== "APPLIED_COUNT_MISMATCH"
    ) {
      throw error;
    }
  }

  const inventory = await runExternalSchemaInventory(
    readExternalSchemaInventoryEnvironment(),
  );
  if (inventory.decision === "ALREADY_0105") {
    await verifySteadyState();
    return;
  }
  if (inventory.decision !== "READY_0104") {
    throw new ExternalSchemaPreflightError(
      "BASELINE_0104_REQUIRED",
      `Staging is ${inventory.missingToPredecessor} migration(s) behind exact 0104; transition refused.`,
    );
  }

  const pre = readExternalSchemaPreflightEnvironment({
    ...process.env,
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "pre",
  });
  await runExternalSchemaPreflight(pre);
  await runMigrator();
  const post = readExternalSchemaPreflightEnvironment({
    ...process.env,
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "post",
  });
  const summary = await runExternalSchemaPreflight(post);
  process.stdout.write(
    `[external-schema-gate] APPLIED ${JSON.stringify(summary)}\n`,
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
    `[external-schema-gate] FAIL ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
