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
  [
    process.execPath,
    [
      "--test",
      "scripts/test/assert-safe-test-env.test.mjs",
      "scripts/test/recovery-ceremony.test.mjs",
      "scripts/test/staging-release-guard.test.mjs",
      "scripts/test/staging-release-evidence.test.mjs",
      "scripts/test/r14-full-stack-contract.test.mjs",
      "scripts/test/production-host-evidence.test.mjs",
      "scripts/test/production-api-image-provenance.test.mjs",
      "scripts/test/production-host-operator-packaging.test.mjs",
      "scripts/test/production-pinned-key-contract.test.mjs",
      "scripts/test/production-signing-custody.test.mjs",
      "scripts/test/production-exact-0096-backup-contract.test.mjs",
      "scripts/test/production-exact-0096-backup-host-adapter.test.mjs",
      "scripts/test/production-exact-0096-backup-signature.test.mjs",
      "scripts/test/production-exact-0096-host-runner.test.mjs",
      "scripts/test/production-exact-0096-disposable-restore-lifecycle.test.mjs",
      "scripts/test/production-exact-0096-disposable-restore-rehearsal.test.mjs",
      "scripts/test/production-migration-control-plane.test.mjs",
      "scripts/test/production-migration-adapter.test.mjs",
      "scripts/test/production-migration-runner.test.mjs",
      "scripts/test/production-migration-runtime-authority.test.mjs",
      "scripts/test/production-migration-role-authority.test.mjs",
      "scripts/test/production-invoice-0108-runner.test.mjs",
      "scripts/test/production-exact-0107-backup-authority.test.mjs",
      "scripts/test/production-role-separation-0108-contract.test.mjs",
      "scripts/test/production-migration-adapter.pg16.test.mjs",
      "scripts/test/production-coolify-observer.test.mjs",
      "scripts/test/production-image-publication-contract.test.mjs",
    ],
  ],
  [
    process.execPath,
    [
      "--import",
      "./lib/db/node_modules/tsx/dist/loader.mjs",
      "--test",
      "scripts/test/production-activation-0108-contract.test.mjs",
      "scripts/test/production-activation-0108-bundle.test.mjs",
      "scripts/test/production-activation-bundle.test.mjs",
      "scripts/test/production-invoice-0108-cli.test.mjs",
      "scripts/test/production-invoice-0108-activation-evidence.test.mjs",
      "scripts/test/production-host-postgres-observer.pg16.test.ts",
      "scripts/test/production-invoice-0108.pg.test.mjs",
      "scripts/test/production-migration-role-bootstrap.pg16.test.ts",
    ],
  ],
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
  const executable = isWindowsPnpm
    ? (process.env.ComSpec ?? "cmd.exe")
    : command;
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
