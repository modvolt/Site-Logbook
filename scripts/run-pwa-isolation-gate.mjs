import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.PWA_ISOLATION_PORT ?? 4192);
const sourceSha = process.env.R14_SOURCE_SHA?.trim() ?? "";

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("R14_SOURCE_SHA must be the exact 40-character lowercase Git HEAD SHA.");
}

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`Invalid PWA_ISOLATION_PORT: ${process.env.PWA_ISOLATION_PORT ?? ""}`);
}

function childEnvironment(extra = {}) {
  const names = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "PNPM_HOME",
    "CI",
  ];
  const env = {};
  for (const name of names) {
    if (process.env[name] != null) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: childEnvironment(extraEnv),
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

async function verifySourceProvenance() {
  const head = await capture("git", ["rev-parse", "HEAD"]);
  if (head !== sourceSha) {
    throw new Error(`R14_SOURCE_SHA ${sourceSha} does not match Git HEAD ${head}.`);
  }
  const relevantStatus = await capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "artifacts/api-server",
    "artifacts/stavba",
    "e2e/playwright.pwa-isolation.config.ts",
    "e2e/pwa-isolation",
    "e2e/tsconfig.pwa-isolation.json",
    "scripts/run-pwa-isolation-gate.mjs",
    "package.json",
  ]);
  if (relevantStatus) {
    throw new Error(`R14 implementation tree must be clean before exact-SHA proof:\n${relevantStatus}`);
  }
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function recordServerCleanup() {
  const manifestPath = path.join(
    repoRoot,
    "e2e",
    "test-results",
    "pwa-isolation",
    "evidence.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.cleanup = {
    ...manifest.cleanup,
    serverClosed: !(await portIsOpen()),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!manifest.cleanup.serverClosed) {
    throw new Error(`PWA isolation server still listens on 127.0.0.1:${port}`);
  }
  if (manifest.sourceSha !== sourceSha) {
    throw new Error("Evidence sourceSha does not match the tested Git HEAD.");
  }
  for (const scenario of [
    "twoTabLease",
    "postCommitLoss",
    "identityAndUpdate",
    "automaticSessionTransition",
    "rollingCompatibility",
  ]) {
    if (!manifest.scenarios?.[scenario]) throw new Error(`Evidence is missing scenario ${scenario}.`);
  }
  const viewportNames = new Set((manifest.viewports ?? []).map((viewport) => viewport.name));
  for (const viewport of ["desktop", "mobile-portrait", "mobile-landscape"]) {
    if (!viewportNames.has(viewport)) throw new Error(`Evidence is missing viewport ${viewport}.`);
  }
  if (!Array.isArray(manifest.diagnostics) || manifest.diagnostics.length === 0) {
    throw new Error("Evidence diagnostics are missing.");
  }
  for (const diagnostics of manifest.diagnostics) {
    for (const field of ["consoleProblems", "pageErrors", "unexpectedFailures", "nonLoopbackRequests"]) {
      if (!Array.isArray(diagnostics[field]) || diagnostics[field].length !== 0) {
        throw new Error(`Evidence diagnostics are not clean: ${diagnostics.label}.${field}`);
      }
    }
  }
  if (!manifest.cleanup?.browserOriginCleared || !manifest.cleanup?.serverClosed) {
    throw new Error("Evidence cleanup flags are incomplete.");
  }
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("Run this gate through the package script so the pinned pnpm CLI is known.");
}
const tscCli = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");

await verifySourceProvenance();
await run(process.execPath, [pnpmCli, "--filter", "@workspace/stavba", "build"], {
  BASE_PATH: "/",
  VITE_BUILD_SHA: sourceSha,
});
await run(process.execPath, [tscCli, "-p", "e2e/tsconfig.pwa-isolation.json"]);

let testError;
try {
  await run(process.execPath, [playwrightCli, "test", "--config=e2e/playwright.pwa-isolation.config.ts"], {
    PWA_ISOLATION_PORT: String(port),
    R14_SOURCE_SHA: sourceSha,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  });
} catch (error) {
  testError = error;
}

await recordServerCleanup();
if (testError) throw testError;
