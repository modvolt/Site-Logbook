import { spawnSync } from "node:child_process";
import { SENSITIVE_TEST_ENV_PATTERNS } from "./assert-safe-test-env.mjs";

const childEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!SENSITIVE_TEST_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
    childEnv[key] = value;
  }
}
childEnv.NODE_ENV = "test";
childEnv.CI = "true";
childEnv.BASE_PATH = "/";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const testsOnly = process.argv.includes("--tests-only");
const commands = [
  [process.execPath, ["--test", "scripts/test/assert-safe-test-env.test.mjs"]],
  [pnpm, ["--filter", "@workspace/stavba", "test"]],
  [pnpm, ["--filter", "@workspace/live-events", "test"]],
  [pnpm, ["--filter", "@workspace/api-server", "test:unit"]],
];

if (!testsOnly) {
  commands.unshift([pnpm, ["run", "typecheck"]]);
  commands.push(
    [pnpm, ["--filter", "@workspace/api-server", "build"]],
    [pnpm, ["--filter", "@workspace/stavba", "build"]],
  );
}

for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const isWindowsPnpm = process.platform === "win32" && command === pnpm;
  const executable = isWindowsPnpm ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = isWindowsPnpm
    ? ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
