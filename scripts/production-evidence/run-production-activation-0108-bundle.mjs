import { pathToFileURL } from "node:url";

import {
  PRODUCTION_ACTIVATION_0108_BUNDLE_CONFIRMATION,
  ProductionActivationBundleError,
  mainProductionActivation0108Bundle,
} from "./run-production-activation-bundle.mjs";

function usage() {
  return [
    "Usage:",
    `  pnpm production:activation-0108-bundle -- publish --challenge ABSOLUTE_FILE --evidence ABSOLUTE_FILE --publisher-public-key ABSOLUTE_FILE --host-public-key ABSOLUTE_FILE --vault ABSOLUTE_DIRECTORY --output ABSOLUTE_FILE --confirm ${PRODUCTION_ACTIVATION_0108_BUNDLE_CONFIRMATION}`,
    "",
    "The output basename must be activation-bundle-v3.json and must not already exist.",
    "The command signs only through the attended custody helper and verifies both the exact v3 transport and semantic 0108 contract before publication.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  mainProductionActivation0108Bundle().catch((error) => {
    const code =
      error instanceof ProductionActivationBundleError
        ? error.code
        : "PRODUCTION_ACTIVATION_0108_BUNDLE_FAILED";
    process.stderr.write(`${code}: publication failed.\n${usage()}\n`);
    process.exitCode = 1;
  });
}
