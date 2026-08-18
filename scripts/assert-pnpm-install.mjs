import { rmSync } from "node:fs";
import { resolve } from "node:path";

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  rmSync(resolve(process.cwd(), lockfile), { force: true });
}

const userAgent = process.env.npm_config_user_agent ?? "";
if (!userAgent.startsWith("pnpm/")) {
  process.stderr.write("Use pnpm instead\n");
  process.exitCode = 1;
}
