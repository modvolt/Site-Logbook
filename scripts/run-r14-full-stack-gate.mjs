import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const composeFile = path.join(
  repoRoot,
  "deploy",
  "test",
  "r14",
  "docker-compose.yml",
);
const resultsDir = path.join(repoRoot, "e2e", "test-results", "r14-full-stack");
const browserEvidenceFile = path.join(resultsDir, "browser-evidence.json");
const evidenceFile = path.join(resultsDir, "evidence.json");
const sourceSha = process.env.R14_SOURCE_SHA?.trim() ?? "";
const webPort = Number(process.env.R14_WEB_PORT ?? "4194");
const minioPort = Number(process.env.R14_MINIO_PORT ?? "19014");
const providerPort = Number(process.env.R14_PROVIDER_PORT ?? "14010");
const windowsDocker = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Docker",
  "Docker",
  "resources",
  "bin",
  "docker.exe",
);
const dockerCommand =
  process.platform === "win32" && existsSync(windowsDocker)
    ? windowsDocker
    : "docker";

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error(
    "R14_SOURCE_SHA must be the exact lowercase 40-character Git HEAD SHA.",
  );
}
for (const [name, value] of Object.entries({
  webPort,
  minioPort,
  providerPort,
})) {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`Invalid R14 ${name}: ${value}`);
  }
}
if (new Set([webPort, minioPort, providerPort]).size !== 3) {
  throw new Error("R14 loopback ports must be distinct.");
}

const project = `site-logbook-r14-${sourceSha.slice(0, 12)}`;
const apiImage = `site-logbook-api:r14-${sourceSha}`;
const webImage = `site-logbook-web:r14-${sourceSha}`;
const baseURL = `http://127.0.0.1:${webPort}`;
const providerURL = `http://127.0.0.1:${providerPort}`;
const controlToken = `r14-control-${sourceSha}-${randomUUID()}`;
const adminUsername = `r14-admin-${sourceSha.slice(0, 8)}`;
const adminPassword = `R14-admin-${sourceSha.slice(0, 12)}-synthetic!`;
const guestUsername = `r14-guest-${sourceSha.slice(0, 8)}`;
const guestPassword = `R14-guest-${sourceSha.slice(0, 12)}-synthetic!`;
const evidence = {
  sourceSha,
  composeProject: project,
  startedAt: new Date().toISOString(),
  isolation: {
    loopbackPorts: [webPort, minioPort, providerPort],
    syntheticCredentialsOnly: true,
    persistentVolumes: false,
    runtimeEgressDisabled: true,
  },
  scenarios: {},
  cleanup: {},
};

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
    "HOME",
    "PNPM_HOME",
    "CI",
  ];
  const env = {};
  for (const name of names)
    if (process.env[name] != null) env[name] = process.env[name];
  return { ...env, ...extra };
}

function spawnResult(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: childEnvironment(options.env),
      stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    if (options.input) child.stdin?.end(options.input);
    else if (options.capture) child.stdin?.end();
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (code === 0 || options.allowFailure) resolve(result);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown"}` +
              (result.stderr.length
                ? `\n${result.stderr.toString("utf8").trim()}`
                : ""),
          ),
        );
    });
  });
}

async function captureText(command, args, env) {
  const result = await spawnResult(command, args, { capture: true, env });
  return result.stdout.toString("utf8").trim();
}

const composeEnv = {
  R14_COMPOSE_PROJECT_NAME: project,
  R14_SOURCE_SHA: sourceSha,
  R14_API_IMAGE: apiImage,
  R14_WEB_IMAGE: webImage,
  R14_WEB_PORT: String(webPort),
  R14_MINIO_PORT: String(minioPort),
  R14_PROVIDER_PORT: String(providerPort),
  R14_PROVIDER_CONTROL_TOKEN: controlToken,
};
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--file",
  composeFile,
];
const compose = (args, options = {}) =>
  spawnResult(dockerCommand, [...composeArgs, ...args], {
    ...options,
    env: composeEnv,
  });

async function portIsOpen(port) {
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

async function waitForHttp(url, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      });
      const body = await response.text();
      last = `HTTP ${response.status}: ${body.slice(0, 240)}`;
      if (await predicate(response, body)) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}; last result: ${last}`);
}

async function verifySourceProvenance() {
  const head = await captureText("git", ["rev-parse", "HEAD"]);
  if (head !== sourceSha)
    throw new Error(
      `R14_SOURCE_SHA ${sourceSha} does not match Git HEAD ${head}.`,
    );
  const status = await captureText("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status)
    throw new Error(`R14 exact-SHA gate requires a clean worktree:\n${status}`);
}

async function dockerBuilds() {
  await spawnResult(dockerCommand, [
    "build",
    "--file",
    "artifacts/api-server/Dockerfile",
    "--build-arg",
    `BUILD_SHA=${sourceSha}`,
    "--tag",
    apiImage,
    ".",
  ]);
  await spawnResult(dockerCommand, [
    "build",
    "--file",
    "artifacts/stavba/Dockerfile",
    "--build-arg",
    "BASE_PATH=/",
    "--build-arg",
    `VITE_BUILD_SHA=${sourceSha}`,
    "--tag",
    webImage,
    ".",
  ]);
}

async function runBrowserAcceptance() {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli)
    throw new Error(
      "Run R14 through pnpm so the pinned package manager is known.",
    );
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const playwright = path.join(
    repoRoot,
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  const testEnv = {
    ...composeEnv,
    R14_BASE_URL: baseURL,
    R14_PROVIDER_URL: providerURL,
    R14_ADMIN_USERNAME: adminUsername,
    R14_ADMIN_PASSWORD: adminPassword,
    R14_GUEST_USERNAME: guestUsername,
    R14_GUEST_PASSWORD: guestPassword,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "",
  };
  await spawnResult(
    process.execPath,
    [tsc, "-p", "e2e/tsconfig.r14-full-stack.json"],
    { env: testEnv },
  );
  await spawnResult(
    process.execPath,
    [playwright, "test", "--config=e2e/playwright.r14-full-stack.config.ts"],
    { env: testEnv },
  );
  const browserEvidence = JSON.parse(
    await readFile(browserEvidenceFile, "utf8"),
  );
  if (browserEvidence.sourceSha !== sourceSha)
    throw new Error("Browser evidence SHA mismatch.");
  evidence.scenarios.browserAcceptance = browserEvidence;
  return browserEvidence;
}

async function proveDatabaseRestore(browserEvidence) {
  const markerJobId = Number(
    browserEvidence.scenarios?.postgresAndS3DataPath?.markerJobId,
  );
  const expectedMigrations = Number(
    browserEvidence.scenarios?.exactShaAndDeepHealth?.migrations,
  );
  if (
    !Number.isInteger(markerJobId) ||
    markerJobId < 1 ||
    !Number.isInteger(expectedMigrations)
  ) {
    throw new Error("Browser evidence lacks restore markers.");
  }
  const dump = await compose(
    [
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "--username=site_logbook_r14",
      "--dbname=site_logbook_r14",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
    { capture: true },
  );
  await compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username=site_logbook_r14",
    "--dbname=postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP DATABASE IF EXISTS site_logbook_r14_restore;",
    "-c",
    "CREATE DATABASE site_logbook_r14_restore;",
  ]);
  await compose(
    [
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--username=site_logbook_r14",
      "--dbname=site_logbook_r14_restore",
      "--no-owner",
      "--no-privileges",
      "-",
    ],
    { input: dump.stdout },
  );
  const migrationCount = Number(
    await captureText(
      dockerCommand,
      [
        ...composeArgs,
        "exec",
        "-T",
        "postgres",
        "psql",
        "--username=site_logbook_r14",
        "--dbname=site_logbook_r14_restore",
        "-Atc",
        "SELECT count(*) FROM drizzle.__drizzle_migrations;",
      ],
      composeEnv,
    ),
  );
  const markerCount = Number(
    await captureText(
      dockerCommand,
      [
        ...composeArgs,
        "exec",
        "-T",
        "postgres",
        "psql",
        "--username=site_logbook_r14",
        "--dbname=site_logbook_r14_restore",
        "-Atc",
        `SELECT count(*) FROM jobs WHERE id = ${markerJobId} AND title LIKE 'R14 full-stack marker %';`,
      ],
      composeEnv,
    ),
  );
  await compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username=site_logbook_r14",
    "--dbname=postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP DATABASE site_logbook_r14_restore;",
  ]);
  if (migrationCount !== expectedMigrations || markerCount !== 1) {
    throw new Error(
      `Restore proof failed: migrations ${migrationCount}/${expectedMigrations}, marker ${markerCount}.`,
    );
  }
  evidence.scenarios.databaseDumpRestore = {
    passed: true,
    dumpBytes: dump.stdout.length,
    dumpSha256: createHash("sha256").update(dump.stdout).digest("hex"),
    migrations: migrationCount,
    markerJobId,
  };
}

async function sessionEnvelope() {
  const storage = JSON.parse(
    await readFile(path.join(resultsDir, "admin-storage-state.json"), "utf8"),
  );
  const cookie = (storage.cookies ?? [])
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  if (!cookie)
    throw new Error("R14 admin storage state has no session cookie.");
  const me = await fetch(`${baseURL}/api/auth/me`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  const body = await me.json();
  if (me.status !== 200 || !/^[0-9a-f]{64}$/.test(body.offlineScope)) {
    throw new Error(
      "Cannot recover the R14 admin offline scope for fault injection.",
    );
  }
  return { cookie, scope: body.offlineScope };
}

async function scopedFetch(urlPath, session, init = {}, timeoutMs = 35_000) {
  return fetch(`${baseURL}${urlPath}`, {
    ...init,
    headers: {
      Cookie: session.cookie,
      "X-Stavba-Offline-Scope": session.scope,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function injectStorageAndDatabaseFaults() {
  const session = await sessionEnvelope();
  await compose(["stop", "--timeout", "5", "minio"]);
  const degradedStorage = await scopedFetch("/api/admin/health", session);
  const degradedStorageBody = await degradedStorage.json();
  if (
    degradedStorage.status !== 200 ||
    degradedStorageBody.storageStatus !== "error"
  ) {
    throw new Error(
      `S3 outage was not visible in deep health: HTTP ${degradedStorage.status}.`,
    );
  }
  const failedBytes = Buffer.from("R14 storage outage must not succeed\n");
  const failedUpload = await scopedFetch(
    "/api/storage/uploads?name=r14-failed.txt&contentType=text%2Fplain",
    session,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Idempotency-Key": `r14:${randomUUID()}`,
        "X-Stavba-Content-Sha256": createHash("sha256")
          .update(failedBytes)
          .digest("hex"),
      },
      body: failedBytes,
    },
  );
  const failedUploadBody = await failedUpload.json();
  if (
    failedUpload.status !== 500 ||
    failedUploadBody.code !== "storage_upload_failed"
  ) {
    throw new Error(
      `S3 outage upload produced a false or unexpected result: HTTP ${failedUpload.status}.`,
    );
  }
  await compose(["start", "minio"]);
  await waitForHttp(
    `http://127.0.0.1:${minioPort}/minio/health/ready`,
    (response) => response.status === 200,
  );
  await waitForHttp(
    `${baseURL}/api/healthz`,
    (response, body) =>
      response.status === 200 && JSON.parse(body).status === "ok",
  );
  const recoveredStorage = await scopedFetch("/api/admin/health", session);
  if (
    recoveredStorage.status !== 200 ||
    (await recoveredStorage.json()).storageStatus !== "ok"
  ) {
    throw new Error(
      "S3 health did not recover after restarting the disposable provider.",
    );
  }
  evidence.scenarios.storageFault = {
    passed: true,
    degradedStatus: "error",
    uploadStatus: 500,
    recovered: true,
  };

  await compose(["stop", "--timeout", "5", "postgres"]);
  const degradedDb = await fetch(`${baseURL}/api/healthz`, {
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const degradedDbBody = await degradedDb.json();
  if (degradedDb.status !== 503 || degradedDbBody.status !== "degraded") {
    throw new Error(
      `PostgreSQL outage was not reported as degraded readiness: HTTP ${degradedDb.status}.`,
    );
  }
  await compose(["start", "postgres"]);
  await waitForHttp(
    `${baseURL}/api/healthz`,
    (response, body) =>
      response.status === 200 && JSON.parse(body).status === "ok",
    120_000,
  );
  evidence.scenarios.databaseFault = {
    passed: true,
    readinessStatus: 503,
    recovered: true,
  };
}

let dockerAvailable = false;
let composeAvailable = false;

async function cleanup() {
  const cleanupErrors = [];
  if (composeAvailable) {
    const logs = await compose(["logs", "--no-color", "--tail", "300"], {
      capture: true,
      allowFailure: true,
    });
    if (logs.stdout.length)
      await writeFile(path.join(resultsDir, "compose.log"), logs.stdout);
    const down = await compose(
      ["down", "--volumes", "--remove-orphans", "--timeout", "10"],
      { capture: true, allowFailure: true },
    );
    if (down.code !== 0)
      cleanupErrors.push(`docker compose down exited ${down.code}`);
  }
  const containers = dockerAvailable
    ? await captureText(dockerCommand, [
        "container",
        "ls",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    : "";
  const networks = dockerAvailable
    ? await captureText(dockerCommand, [
        "network",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    : "";
  const volumes = dockerAvailable
    ? await captureText(dockerCommand, [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    : "";
  const openPorts = [];
  for (const port of [webPort, minioPort, providerPort])
    if (await portIsOpen(port)) openPorts.push(port);
  if (containers) cleanupErrors.push("project containers remain");
  if (networks) cleanupErrors.push("project networks remain");
  if (volumes) cleanupErrors.push("project volumes remain");
  if (openPorts.length)
    cleanupErrors.push(`loopback ports remain open: ${openPorts.join(", ")}`);
  evidence.cleanup = {
    containersRemoved: !containers,
    networksRemoved: !networks,
    volumesRemoved: !volumes,
    loopbackPortsClosed: openPorts.length === 0,
  };
  if (cleanupErrors.length)
    throw new Error(`R14 cleanup failed: ${cleanupErrors.join("; ")}`);
}

await mkdir(resultsDir, { recursive: true });
let primaryError;
let cleanupError;
try {
  await verifySourceProvenance();
  await spawnResult(dockerCommand, ["version"]);
  dockerAvailable = true;
  await spawnResult(dockerCommand, ["compose", "version"]);
  composeAvailable = true;
  for (const port of [webPort, minioPort, providerPort]) {
    if (await portIsOpen(port))
      throw new Error(`R14 requires free loopback port ${port}.`);
  }
  await dockerBuilds();
  await compose(["up", "--detach", "--remove-orphans"]);
  await waitForHttp(
    `${providerURL}/healthz`,
    (response) => response.status === 200,
  );
  await waitForHttp(
    `${baseURL}/api/healthz`,
    (response, body) =>
      response.status === 200 && JSON.parse(body).version === sourceSha,
    180_000,
  );
  const browserEvidence = await runBrowserAcceptance();
  await proveDatabaseRestore(browserEvidence);
  await injectStorageAndDatabaseFaults();
  evidence.completedAt = new Date().toISOString();
} catch (error) {
  primaryError = error;
  evidence.failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  await writeFile(
    evidenceFile,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
}

if (primaryError && cleanupError) {
  throw new AggregateError(
    [primaryError, cleanupError],
    "R14 gate and cleanup both failed.",
  );
}
if (cleanupError) throw cleanupError;
if (primaryError) throw primaryError;
