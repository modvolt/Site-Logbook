import { spawnSync } from "node:child_process";
import { assertSafeLocalTestDatabase, SENSITIVE_TEST_ENV_PATTERNS } from "./assert-safe-test-env.mjs";

const testDatabaseUrl = assertSafeLocalTestDatabase(process.env);
const childEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!SENSITIVE_TEST_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
    childEnv[key] = value;
  }
}
childEnv.NODE_ENV = "test";
childEnv.DATABASE_URL = testDatabaseUrl;
childEnv.SESSION_SECRET = "isolated-test-session-secret-not-for-production";

const all = process.argv.includes("--all");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = ["exec", "vitest", "run", "--config", all ? "vitest.config.ts" : "vitest.db.config.ts"];
const isWindows = process.platform === "win32";
const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : pnpm;
const executableArgs = isWindows ? ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`] : args;
const result = spawnSync(executable, executableArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
