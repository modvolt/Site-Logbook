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
const windowsDocker = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Docker",
  "Docker",
  "resources",
  "bin",
  "docker.exe",
);
const windowsCompose = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Docker",
  "Docker",
  "resources",
  "bin",
  "docker-compose.exe",
);
const windowsBuildx = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Docker",
  "Docker",
  "resources",
  "cli-plugins",
  "docker-buildx.exe",
);
const dockerCommand =
  process.platform === "win32" && existsSync(windowsDocker)
    ? windowsDocker
    : "docker";
const composeCommand =
  process.platform === "win32" && existsSync(windowsCompose)
    ? windowsCompose
    : dockerCommand;
const composePrefix = composeCommand === dockerCommand ? ["compose"] : [];
const buildCommand =
  process.platform === "win32" && existsSync(windowsBuildx)
    ? windowsBuildx
    : dockerCommand;
const buildPrefix =
  buildCommand === dockerCommand ? ["build"] : ["build", "--load"];

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error(
    "R14_SOURCE_SHA must be the exact lowercase 40-character Git HEAD SHA.",
  );
}
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65_535) {
  throw new Error(`Invalid R14 webPort: ${webPort}`);
}

const project = `site-logbook-r14-${sourceSha.slice(0, 12)}`;
const apiImage = `site-logbook-api:r14-${sourceSha}`;
const webImage = `site-logbook-web:r14-${sourceSha}`;
const baseURL = `http://127.0.0.1:${webPort}`;
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
    loopbackPorts: [webPort],
    syntheticCredentialsOnly: true,
    persistentVolumes: false,
    applicationAndStatefulEgressDisabled: true,
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
  R14_PROVIDER_CONTROL_TOKEN: controlToken,
};
const composeArgs = [
  ...composePrefix,
  "--project-name",
  project,
  "--file",
  composeFile,
];
const compose = (args, options = {}) =>
  spawnResult(composeCommand, [...composeArgs, ...args], {
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
  await spawnResult(
    buildCommand,
    [
      ...buildPrefix,
      "--file",
      "artifacts/api-server/Dockerfile",
      "--build-arg",
      `BUILD_SHA=${sourceSha}`,
      "--tag",
      apiImage,
      ".",
    ],
    { env: { DOCKER_BUILDKIT: "1" } },
  );
  await spawnResult(
    buildCommand,
    [
      ...buildPrefix,
      "--file",
      "artifacts/stavba/Dockerfile",
      "--build-arg",
      "BASE_PATH=/",
      "--build-arg",
      `VITE_BUILD_SHA=${sourceSha}`,
      "--tag",
      webImage,
      ".",
    ],
    { env: { DOCKER_BUILDKIT: "1" } },
  );
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
    R14_SOURCE_SHA: sourceSha,
    R14_BASE_URL: baseURL,
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
    ],
    { input: dump.stdout },
  );
  const migrationCount = Number(
    await captureText(
      composeCommand,
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
      composeCommand,
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
  const login = await fetch(`${baseURL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (login.status !== 200) {
    throw new Error(
      `R14 fault-session login failed with HTTP ${login.status}.`,
    );
  }
  const setCookies = login.headers.getSetCookie();
  const cookie = setCookies
    .map((value) => value.split(";", 1)[0])
    .filter((value) => value.startsWith("stavba.sid="))
    .join("; ");
  if (!cookie)
    throw new Error("R14 fault-session login returned no session cookie.");
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

async function providerControl(route, method = "GET", body) {
  const script = `
    const [route, method, body] = process.argv.slice(1);
    const response = await fetch('http://127.0.0.1:4010' + route, {
      method,
      headers: {
        'X-R14-Control-Token': process.env.R14_PROVIDER_CONTROL_TOKEN,
        'Content-Type': 'application/json'
      },
      ...(body ? { body } : {})
    });
    const text = await response.text();
    process.stdout.write(text);
    if (!response.ok) process.exit(1);
  `;
  const result = await compose(
    [
      "exec",
      "-T",
      "provider-fakes",
      "node",
      "-e",
      script,
      route,
      method,
      body === undefined ? "" : JSON.stringify(body),
    ],
    { capture: true },
  );
  return JSON.parse(result.stdout.toString("utf8"));
}

async function setProviderModes(modes) {
  await providerControl("/__test/modes", "POST", modes);
}

async function scopedJsonMutation(urlPath, session, data) {
  return scopedFetch(urlPath, session, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `r14:${randomUUID()}`,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function waitForMinio(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await compose(
      ["exec", "-T", "minio", "mc", "ready", "local"],
      { capture: true, allowFailure: true },
    );
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for isolated MinIO health.");
}

async function injectProviderFaults() {
  const session = await sessionEnvelope();
  const initial = await providerControl("/__test/state");
  const smtp = initial.smtp ?? {};
  const imap = initial.imap ?? {};
  const ai = initial.ai ?? {};
  if (
    !Array.isArray(smtp.messages) ||
    smtp.messages.length !== 1 ||
    Number(imap.connections) < 1 ||
    Number(ai.calls) !== 1
  ) {
    throw new Error(
      "Healthy provider evidence does not match the browser/API acceptance path.",
    );
  }

  try {
    await setProviderModes({ smtp: "fail" });
    const failed = await scopedJsonMutation(
      "/api/email-settings/test",
      session,
      {
        to: "r14-recipient@site-logbook.invalid",
      },
    );
    if (failed.status !== 502)
      throw new Error(`SMTP fault returned HTTP ${failed.status}.`);
  } finally {
    await setProviderModes({ smtp: "healthy" });
  }

  try {
    await setProviderModes({ imap: "fail" });
    const failed = await scopedJsonMutation(
      "/api/email-import-settings/test",
      session,
    );
    if (failed.status !== 502)
      throw new Error(`IMAP fault returned HTTP ${failed.status}.`);
  } finally {
    await setProviderModes({ imap: "healthy" });
  }

  for (const mode of ["http500", "timeout"]) {
    try {
      await setProviderModes({ ai: mode });
      const failed = await scopedJsonMutation(
        "/api/billing/ai-extraction/test",
        session,
      );
      const result = await failed.json();
      if (failed.status !== 200 || result.ok !== false) {
        throw new Error(
          `AI ${mode} fault produced a false or unexpected success.`,
        );
      }
    } finally {
      await setProviderModes({ ai: "healthy" });
    }
  }

  const recovered = await scopedJsonMutation(
    "/api/billing/ai-extraction/test",
    session,
  );
  if (recovered.status !== 200 || (await recovered.json()).ok !== true) {
    throw new Error("AI provider did not recover after synthetic faults.");
  }
  const final = await providerControl("/__test/state");
  evidence.scenarios.providerFaults = {
    passed: true,
    faults: ["smtp-fail", "imap-fail", "ai-http500", "ai-timeout"],
    healthyEvidence: {
      smtpMessages: smtp.messages.length,
      smtpMessageSha256: smtp.messages[0]?.sha256 ?? null,
      imapConnections: imap.connections,
      aiCallsBeforeFaults: ai.calls,
      aiCallsAfterRecovery: final.ai?.calls ?? null,
    },
  };
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
  await waitForMinio();
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
  if (await portIsOpen(webPort)) openPorts.push(webPort);
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
  await spawnResult(composeCommand, [...composePrefix, "version"]);
  composeAvailable = true;
  if (await portIsOpen(webPort))
    throw new Error(`R14 requires free loopback port ${webPort}.`);
  await dockerBuilds();
  await compose(["up", "--detach", "--remove-orphans"]);
  await waitForHttp(
    `${baseURL}/api/healthz`,
    (response, body) =>
      response.status === 200 && JSON.parse(body).version === sourceSha,
    180_000,
  );
  const browserEvidence = await runBrowserAcceptance();
  await injectProviderFaults();
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
