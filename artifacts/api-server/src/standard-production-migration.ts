import { runStandardMigrationCli } from "./lib/standard-production-migration";

declare const __SITE_LOGBOOK_BUILD_SHA__: string;
const sourceSha = typeof __SITE_LOGBOOK_BUILD_SHA__ === "string"
  ? __SITE_LOGBOOK_BUILD_SHA__ : process.env.BUILD_SHA ?? "";

process.exitCode = await runStandardMigrationCli(process.argv.slice(2), sourceSha, process.env);
