import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PRODUCTION_ACTIVATION_ENV_MISSING: ${key} is required.`);
  }
  return value;
}

async function main(): Promise<void> {
  const sourceSha = requireEmbeddedProductionBuildSha();
  if (
    required(process.env, "SITE_LOGBOOK_RUNTIME_ENVIRONMENT") !== "production"
  ) {
    throw new Error(
      "PRODUCTION_RUNTIME_ENVIRONMENT_INVALID: the API entrypoint is production-only.",
    );
  }
  if (required(process.env, "BUILD_SHA").toLowerCase() !== sourceSha) {
    throw new Error(
      "PRODUCTION_RUNTIME_SOURCE_MISMATCH: runtime BUILD_SHA differs from the embedded immutable source.",
    );
  }
  const rawPort = required(process.env, "PORT");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PRODUCTION_RUNTIME_PORT_INVALID: ${rawPort}`);
  }
  process.stdout.write(
    `[api-startup] live preflight buildSha=${sourceSha} port=${port}\n`,
  );
  const runtimeEntry = new URL("./index.mjs", import.meta.url);
  const runtimeModule = (await import(
    runtimeEntry.href
  )) as typeof import("./index");
  await runtimeModule.startProductionApplicationRuntime();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[api-startup] FAIL ${message}\n`);
  process.exit(1);
});
