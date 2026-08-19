import { pathToFileURL } from "node:url";

import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";
import * as postgresObserver from "./production-host-postgres-observer";

// @ts-ignore -- the host-only CLI is bundled from the repository evidence tree.
import { main as runHostEvidence } from "../../../scripts/production-evidence/run-production-host-evidence.mjs";
// @ts-ignore -- the packaging boundary is a source-reviewed ESM script.
import {
  productionHostOperatorUsage,
  runProductionHostOperator,
} from "../../../scripts/production-evidence/production-host-operator-packaging.mjs";

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const sourceSha = requireEmbeddedProductionBuildSha();
  return runProductionHostOperator([...argv], {
    sourceSha,
    runHostEvidence: (hostArgv: string[]) =>
      runHostEvidence(hostArgv, {
        expectedSourceSha: sourceSha,
        postgresObserver,
      }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n${productionHostOperatorUsage()}\n`);
    process.exitCode = 1;
  });
}
