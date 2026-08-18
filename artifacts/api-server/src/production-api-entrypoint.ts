import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";
import {
  readContainerId,
  startProductionActivationHold,
  type ProductionActivationHoldController,
} from "./lib/production-activation-hold";
import type { ProductionReleaseSummary } from "./lib/production-startup-evidence";
import { PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256 } from "./lib/production-host-evidence-pinned-keys.mjs";
import { PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256 } from "./lib/production-publisher-provenance-pinned-keys.mjs";

const EVIDENCE_FILE =
  "/run/site-logbook-production-evidence/activation-bundle-v2.json";
const PUBLISHER_PUBLIC_KEY_FILE =
  "/run/site-logbook-production-evidence/activation-publisher-ed25519-public.pem";
const HOST_PUBLIC_KEY_FILE =
  "/run/site-logbook-production-evidence/activation-host-ed25519-public.pem";
const SHUTDOWN_TIMEOUT_MS = 5_000;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PRODUCTION_ACTIVATION_ENV_MISSING: ${key} is required.`);
  }
  return value;
}

function requiredExactSourceTrustPin(
  env: NodeJS.ProcessEnv,
  key: string,
  expected: string | null,
): string {
  if (expected === null || required(env, key) !== expected) {
    throw new Error(
      `PRODUCTION_ACTIVATION_TRUST_PIN_MISMATCH: ${key} must equal the immutable source-pinned identity.`,
    );
  }
  return expected;
}

async function main(): Promise<void> {
  const sourceSha = requireEmbeddedProductionBuildSha();
  if (
    required(process.env, "SITE_LOGBOOK_RUNTIME_ENVIRONMENT") !== "production"
  ) {
    throw new Error(
      "PRODUCTION_ACTIVATION_ENVIRONMENT_INVALID: the HOLD entrypoint is production-only.",
    );
  }
  if (required(process.env, "BUILD_SHA").toLowerCase() !== sourceSha) {
    throw new Error(
      "PRODUCTION_ACTIVATION_SOURCE_MISMATCH: runtime BUILD_SHA differs from the embedded immutable source.",
    );
  }
  const rawPort = required(process.env, "PORT");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PRODUCTION_ACTIVATION_PORT_INVALID: ${rawPort}`);
  }

  let controller: ProductionActivationHoldController | null = null;
  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const hardStop = setTimeout(() => {
      process.stderr.write(
        `[production-activation] FAIL ${signal} cleanup timed out\n`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS + 250);
    hardStop.unref();
    try {
      await controller?.stop(SHUTDOWN_TIMEOUT_MS);
      clearTimeout(hardStop);
      process.exit(0);
    } catch (error) {
      clearTimeout(hardStop);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[production-activation] FAIL ${message}\n`);
      process.exit(1);
    }
  };
  const onSigterm = (): void => void shutdown("SIGTERM");
  const onSigint = (): void => void shutdown("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  const containerId = await readContainerId();
  controller = await startProductionActivationHold<ProductionReleaseSummary>({
    port,
    evidenceFile: EVIDENCE_FILE,
    publisherPublicKeyFile: PUBLISHER_PUBLIC_KEY_FILE,
    publisherPublicKeySha256: requiredExactSourceTrustPin(
      process.env,
      "PRODUCTION_ACTIVATION_PUBLISHER_PUBLIC_KEY_SHA256",
      PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
    ),
    hostPublicKeyFile: HOST_PUBLIC_KEY_FILE,
    hostPublicKeySha256: requiredExactSourceTrustPin(
      process.env,
      "PRODUCTION_ACTIVATION_HOST_PUBLIC_KEY_SHA256",
      PINNED_PRODUCTION_HOST_EVIDENCE_KEY_SHA256,
    ),
    expected: {
      sourceSha,
      apiImage: required(process.env, "PRODUCTION_API_IMAGE").toLowerCase(),
      desiredConfigSha256: required(
        process.env,
        "PRODUCTION_EXPECTED_DESIRED_CONFIG_SHA256",
      ).toLowerCase(),
      deployedConfigSha256: required(
        process.env,
        "PRODUCTION_EXPECTED_DEPLOYED_CONFIG_SHA256",
      ).toLowerCase(),
      resolvedComposeSha256: required(
        process.env,
        "PRODUCTION_EXPECTED_RESOLVED_COMPOSE_SHA256",
      ).toLowerCase(),
      containerId,
    },
    loadSemanticVerifier: async () => {
      const contract = await import("./lib/production-activation-contract");
      return contract.verifyProductionActivationContractV2;
    },
    startRuntime: async (release) => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      // Keep the application and every worker out of the module graph while
      // HOLD is active. The runtime bundle is loaded only after full v2
      // semantic verification and after the HOLD listener has closed.
      const runtimeEntry = new URL("./index.mjs", import.meta.url);
      const runtimeModule = (await import(
        runtimeEntry.href
      )) as typeof import("./index");
      await runtimeModule.startProductionApplicationRuntime(release);
    },
    onFatal: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[production-activation] FAIL ${message}\n`);
      process.exit(1);
    },
    onEvent: (event) => {
      process.stdout.write(
        `[production-activation] ${JSON.stringify(event)}\n`,
      );
    },
  });

  process.stdout.write(
    `[production-activation] HOLD ${JSON.stringify(controller.challenge)}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[production-activation] FAIL ${message}\n`);
  process.exit(1);
});
