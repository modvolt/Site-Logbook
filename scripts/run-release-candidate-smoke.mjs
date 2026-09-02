import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositories = Object.freeze({
  api: "ghcr.io/modvolt/site-logbook-production-api",
  web: "ghcr.io/modvolt/site-logbook-production-web",
  controlPlane: "ghcr.io/modvolt/site-logbook-control-plane",
});
const imageVariables = Object.freeze({
  api: "RELEASE_SMOKE_API_IMAGE",
  web: "RELEASE_SMOKE_WEB_IMAGE",
  controlPlane: "RELEASE_SMOKE_CONTROL_PLANE_IMAGE",
});
const wiringRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(wiringRoot, "deploy/test/release-candidate/docker-compose.yml");
const defaultCommand = ["node", "--enable-source-maps", "/app/dist/production-api-entrypoint.mjs"];
const defaultEntrypoint = ["docker-entrypoint.sh"];
const profileLabel = "io.modvolt.site-logbook.image-profile";

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

export function validateInputs(env) {
  const sourceSha = env.RELEASE_SMOKE_SOURCE_SHA;
  requireCondition(typeof sourceSha === "string" && sourceSha.length === 40 && /^[0-9a-f]{40}$/.test(sourceSha), "INVALID_SOURCE_SHA");
  const images = {};
  for (const [key, repository] of Object.entries(repositories)) {
    const value = env[imageVariables[key]];
    // Exact equality with the allowlisted prefix excludes tags, whitespace,
    // URL credentials, alternate registries and every shell metacharacter.
    requireCondition(typeof value === "string" && value.startsWith(`${repository}@sha256:`), "INVALID_IMAGE_REPOSITORY");
    const digest = value.slice(repository.length + 1);
    requireCondition(digest.length === 71 && /^sha256:[0-9a-f]{64}$/.test(digest), "INVALID_IMAGE_DIGEST");
    images[key] = value;
  }
  return { sourceSha, images };
}

export function validateImageMetadata(key, image, input) {
  requireCondition(image?.Os === "linux" && image.Architecture === "amd64", "IMAGE_PLATFORM_MISMATCH");
  requireCondition(image.RepoDigests?.includes(input.images[key]), "IMAGE_DIGEST_MISMATCH");
  const labels = image.Config?.Labels ?? {};
  requireCondition(labels["org.opencontainers.image.revision"] === input.sourceSha, "IMAGE_REVISION_MISMATCH");
  const expectedProfile = { api: "production", controlPlane: "control-plane", web: undefined }[key];
  requireCondition(labels[profileLabel] === expectedProfile, "IMAGE_PROFILE_MISMATCH");
  if (key === "api") {
    requireCondition(JSON.stringify(image.Config.Cmd) === JSON.stringify(defaultCommand), "API_DEFAULT_COMMAND_MISMATCH");
    requireCondition(JSON.stringify(image.Config.Entrypoint) === JSON.stringify(defaultEntrypoint), "API_DEFAULT_ENTRYPOINT_MISMATCH");
  }
  return labels["org.opencontainers.image.revision"];
}

function rejectAmbientInfrastructure(env) {
  const forbidden = /^(DATABASE_URL|BACKUP_DATABASE_URL|TEST_DATABASE_URL|SESSION_SECRET|PRODUCTION_.+|S3_.+|AWS_.+|HETZNER_.+|COOLIFY_.+|MODVOLT_RELEASE_.+|SMTP_.+|IMAP_.+|OPENAI_.+|SECRET_ENCRYPTION_.+|BACKUP_ENCRYPTION_.+)$/i;
  requireCondition(!Object.entries(env).some(([key, value]) => value && forbidden.test(key)), "AMBIENT_INFRASTRUCTURE_FORBIDDEN");
  requireCondition(!env.DOCKER_HOST && (!env.DOCKER_CONTEXT || env.DOCKER_CONTEXT === "default"), "REMOTE_DOCKER_FORBIDDEN");
}

// Child processes inherit only local tool discovery and Docker's standard
// short-lived GHCR login location. Application credentials are generated below.
function toolEnvironment() {
  return Object.fromEntries(
    ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "DOCKER_CONFIG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
}

async function run(command, args, { env, cwd, signal, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, signal, timeout, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    // Neither command stderr nor container/application logs enter the summary:
    // they can contain generated connection strings or login material.
    child.stderr.resume();
    child.on("error", () => reject(new Error("CHILD_PROCESS_FAILED")));
    child.on("close", (code) => {
      if (code !== 0 || bytes > 4 * 1024 * 1024) reject(new Error("CHILD_PROCESS_FAILED"));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export async function verifyCandidateSource(sourceSha, sourceRoot, signal) {
  requireCondition(/^[0-9a-f]{40}$/.test(sourceSha), "SOURCE_SHA_INVALID");
  const env = toolEnvironment();
  const toolingOptions = { cwd: wiringRoot, env, signal };
  // Full history belongs to the tooling checkout; candidate files never replace it.
  await run("git", ["cat-file", "-e", `${sourceSha}^{commit}`], toolingOptions);
  await run("git", ["merge-base", "--is-ancestor", sourceSha, "HEAD"], toolingOptions);
  const toolingSha = await run("git", ["rev-parse", "HEAD"], toolingOptions);
  const candidateSha = await run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, env, signal });
  requireCondition(candidateSha === sourceSha, "SOURCE_CHECKOUT_MISMATCH");
  return toolingSha;
}

async function initializeDatabase(sourceRoot, host, credentials, runSource, signal) {
  // This IP comes from a label-checked container on this run's internal bridge.
  // On the Linux Docker host it is reachable without any published DB port.
  requireCondition(isIP(host) === 4, "DISPOSABLE_DATABASE_ADDRESS_INVALID");
  const sourceRequire = createRequire(path.join(sourceRoot, "scripts/package.json"));
  const { Client } = sourceRequire("pg");
  const connectionString = `postgresql://release_smoke_admin:${credentials.admin}@${host}:5432/release_smoke_test`;
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  try {
    await client.connect();
    const identity = (await client.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num')::integer AS version")).rows[0];
    requireCondition(identity.db === "release_smoke_test" && identity.usr === "release_smoke_admin" && Math.floor(identity.version / 10_000) === 16, "DISPOSABLE_DATABASE_IDENTITY_MISMATCH");
    const fresh = (await client.query("SELECT to_regclass('public.users') AS users")).rows[0];
    requireCondition(fresh.users === null, "DISPOSABLE_DATABASE_NOT_FRESH");
    const journal = JSON.parse(await readFile(path.join(sourceRoot, "lib/db/migrations/meta/_journal.json"), "utf8"));
    requireCondition(journal.entries.at(-1)?.tag.startsWith("0108_"), "SOURCE_SCHEMA_NOT_0108");
    await client.query(`
      CREATE ROLE site_logbook_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      ALTER DATABASE release_smoke_test OWNER TO site_logbook_migrator;
      ALTER SCHEMA public OWNER TO site_logbook_migrator;
    `);
    // The synthetic admin delegates only this migration session. The runtime
    // role is never a member of the migrator and never owns schema objects.
    const migrationUrl = new URL(connectionString);
    migrationUrl.searchParams.set("options", "-c role=site_logbook_migrator");

    // Reuse the migration CLI used by run-safe-test-db.mjs. No copied SQL
    // migrations, restore, custom migration loop or control-plane container.
    await runSource([
      path.join(sourceRoot, "scripts/node_modules/tsx/dist/cli.mjs"),
      path.join(sourceRoot, "lib/db/src/migrate-cli.ts"),
    ], { NODE_ENV: "test", DATABASE_URL: migrationUrl.href, MIGRATIONS_DIR: path.join(sourceRoot, "lib/db/migrations") });
    requireCondition(!signal.aborted, "SMOKE_ABORTED");
    const applied = (await client.query("SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows;
    requireCondition(JSON.stringify(applied.map((row) => row.created_at).sort()) === JSON.stringify(journal.entries.map((entry) => String(entry.when)).sort()), "FIXTURE_MIGRATION_PARITY_FAILED");

    // Disposable role model from the PG16 fixtures; the SELECT-only backup
    // grants follow database-assurance-backup-role.pg16.test.ts. All secrets
    // below are internally generated lowercase hex, never workflow inputs.
    await client.query(`
      CREATE ROLE site_logbook_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${credentials.runtime}';
      CREATE ROLE site_logbook_backup LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${credentials.backup}';
      REVOKE ALL ON DATABASE release_smoke_test FROM PUBLIC;
      GRANT CONNECT ON DATABASE release_smoke_test TO site_logbook_runtime, site_logbook_backup;
      REVOKE ALL ON SCHEMA public, drizzle FROM PUBLIC;
      GRANT USAGE ON SCHEMA public, drizzle TO site_logbook_runtime, site_logbook_backup;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO site_logbook_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO site_logbook_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO site_logbook_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO site_logbook_backup;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO site_logbook_backup;
      ALTER DEFAULT PRIVILEGES FOR ROLE site_logbook_migrator IN SCHEMA public, drizzle GRANT SELECT ON TABLES TO site_logbook_backup;
      ALTER DEFAULT PRIVILEGES FOR ROLE site_logbook_migrator IN SCHEMA public, drizzle GRANT SELECT ON SEQUENCES TO site_logbook_backup;
    `);
    const privileges = (await client.query(`SELECT
      has_database_privilege('site_logbook_runtime', 'release_smoke_test', 'CREATE') AS create_db,
      has_database_privilege('site_logbook_runtime', 'release_smoke_test', 'TEMP') AS temp,
      has_schema_privilege('site_logbook_runtime', 'public', 'CREATE') AS create_public,
      has_schema_privilege('site_logbook_runtime', 'drizzle', 'CREATE') AS create_drizzle,
      pg_has_role('site_logbook_runtime', 'site_logbook_migrator', 'MEMBER') AS migrator_member,
      pg_has_role('site_logbook_runtime', 'site_logbook_backup', 'MEMBER') AS backup_member
    `)).rows[0];
    requireCondition(Object.values(privileges).every((value) => value === false), "RUNTIME_ROLE_ISOLATION_FAILED");
  } finally {
    await client.end();
  }
}

async function exerciseApi(baseUrl, sourceSha, summary, signal) {
  const request = async (route, status, options = {}) => {
    requireCondition(route.startsWith("/") && !route.startsWith("//"), "INVALID_SMOKE_ROUTE");
    const response = await fetch(`${baseUrl}${route}`, {
      ...options, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    requireCondition(response.status === status, "SMOKE_HTTP_STATUS_MISMATCH");
    return response;
  };
  await (await request("/", 200)).arrayBuffer();
  summary["web health"] = "passed";
  const health = await (await request("/api/healthz", 200)).json();
  requireCondition(health.status === "ok" && health.buildSha === sourceSha && health.schema === "0108" && health.database === "ok" && health.storageStatus === "ok", "API_HEALTH_MISMATCH");
  if (Object.hasOwn(health, "migrationParity")) requireCondition(health.migrationParity === true, "API_MIGRATION_PARITY_FAILED");
  summary.schema = health.schema;
  summary["API health"] = "passed";
  summary.proxy = "passed";

  // Same first-admin bootstrap and job shape as e2e/r14-full-stack; the
  // credential and session stay in process memory and disappear with the DB.
  const before = await (await request("/api/auth/me", 200)).json();
  requireCondition(before.authenticated === false && before.needsSetup === true, "SYNTHETIC_ACCOUNT_NOT_FRESH");
  const username = "release_smoke_admin";
  const password = `Smoke-${randomBytes(24).toString("hex")}!`;
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await (await request("/api/auth/setup", 201, json({ username, password, name: "Disposable smoke account", email: "smoke@release-smoke.invalid" }))).arrayBuffer();
  const login = await request("/api/auth/login", 200, json({ username, password }));
  const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("stavba.sid="));
  requireCondition(Boolean(cookie), "SYNTHETIC_SESSION_COOKIE_MISSING");
  await login.arrayBuffer();
  summary["synthetic login"] = "passed";
  const me = await (await request("/api/auth/me", 200, { headers: { Cookie: cookie } })).json();
  requireCondition(me.authenticated === true && me.user?.username === username && /^[a-f0-9]{64}$/.test(me.offlineScope), "SYNTHETIC_IDENTITY_MISMATCH");
  summary["/api/auth/me"] = "passed";
  const headers = { Cookie: cookie, "X-Stavba-Offline-Scope": me.offlineScope };
  const title = `Release smoke ${sourceSha}`;
  const job = await (await request("/api/jobs", 201, {
    ...json({ title, type: "planned_work", date: "2042-01-14", status: "planned" }),
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": `release-smoke:${randomUUID()}` },
  })).json();
  requireCondition(Number.isSafeInteger(job.id) && job.id > 0, "SYNTHETIC_JOB_ID_INVALID");
  const read = await (await request(`/api/jobs/${job.id}`, 200, { headers })).json();
  requireCondition(read.id === job.id && read.title === title, "SYNTHETIC_JOB_READ_FAILED");
  summary["synthetic read/write"] = "passed";

  // production health storageStatus is static; prove the disposable storage
  // data path separately using the same small text upload/read as R14.
  const payload = Buffer.from(`Release smoke ${sourceSha}\n`);
  const upload = await (await request("/api/storage/uploads?name=release-smoke.txt&contentType=text%2Fplain", 200, {
    method: "POST", body: payload,
    headers: { ...headers, "Content-Type": "text/plain", "Idempotency-Key": `release-smoke:${randomUUID()}`, "X-Stavba-Content-Sha256": createHash("sha256").update(payload).digest("hex") },
  })).json();
  requireCondition(/^\/objects\/uploads\/v2\/[0-9a-f-]+$/.test(upload.objectPath), "SYNTHETIC_OBJECT_PATH_INVALID");
  await (await request(`/api/jobs/${job.id}/attachments`, 201, {
    ...json({ type: "manual_item", fileName: "release-smoke.txt", url: upload.objectPath, description: "Disposable smoke text" }),
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": `release-smoke:${randomUUID()}` },
  })).arrayBuffer();
  const download = await request(`/api/storage${upload.objectPath}`, 200, { headers });
  requireCondition(Buffer.from(await download.arrayBuffer()).equals(payload), "SYNTHETIC_STORAGE_READ_FAILED");
  summary["synthetic storage read/write"] = "passed";
}

async function main() {
  const input = validateInputs(process.env);
  rejectAmbientInfrastructure(process.env);
  requireCondition(process.argv.slice(2).every((arg) => arg === "--validate-only"), "UNKNOWN_ARGUMENT");
  if (process.argv.includes("--validate-only")) {
    await verifyCandidateSource(input.sourceSha, process.cwd());
    console.log("Exact inputs and candidate ancestry in tooling history: passed. No Docker operation performed.");
    return;
  }
  requireCondition(process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "GITHUB_HOSTED_LINUX_RUNNER_REQUIRED");
  const sourceRoot = process.cwd();
  const env = toolEnvironment();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  // Leave ten minutes within the job deadline for finally cleanup and the
  // standard login-action post-job logout, even after a stuck child process.
  const deadline = setTimeout(abort, 20 * 60 * 1000);
  const project = `release-smoke-${input.sourceSha.slice(0, 12)}-${randomBytes(8).toString("hex")}`;
  const credentials = Object.fromEntries(["admin", "runtime", "backup", "session", "s3"].map((key) => [key, randomBytes(32).toString("hex")]));
  const composeEnv = {
    ...env,
    ...Object.fromEntries(Object.entries(imageVariables).map(([key, variable]) => [variable, input.images[key]])),
    RELEASE_SMOKE_SOURCE_SHA: input.sourceSha,
    RELEASE_SMOKE_PROJECT: project,
    RELEASE_SMOKE_DB_PASSWORD: credentials.admin,
    RELEASE_SMOKE_RUNTIME_PASSWORD: credentials.runtime,
    RELEASE_SMOKE_BACKUP_PASSWORD: credentials.backup,
    RELEASE_SMOKE_SESSION_SECRET: credentials.session,
    RELEASE_SMOKE_S3_PASSWORD: credentials.s3,
    RELEASE_SMOKE_KEYRING: JSON.stringify({ "release-smoke": randomBytes(32).toString("base64") }),
    // Replaced with the inspected internal subnet before creating the API.
    RELEASE_SMOKE_PROXY_CIDR: "127.0.0.1/32",
    COMPOSE_DISABLE_ENV_FILE: "1",
  };
  const docker = (args, cleanup = false) => run("docker", ["--context", "default", ...args], {
    env: composeEnv, cwd: sourceRoot, signal: cleanup ? undefined : controller.signal,
    timeout: cleanup ? 60_000 : 180_000,
  });
  const compose = (args, cleanup = false) => docker(["compose", "--env-file", "/dev/null", "--project-name", project, "--file", composeFile, ...args], cleanup);
  const inspect = async (service) => {
    const id = await compose(["ps", "--all", "--quiet", service]);
    requireCondition(/^[a-f0-9]{64}$/.test(id), "CONTAINER_ID_INVALID");
    const [container] = JSON.parse(await docker(["container", "inspect", id]));
    requireCondition(container.Config.Labels["com.docker.compose.project"] === project && container.Config.Labels["com.docker.compose.service"] === service, "CONTAINER_PROJECT_MISMATCH");
    return container;
  };
  const summary = {
    "source SHA": input.sourceSha,
    "tooling SHA": "not checked",
    "API image": input.images.api, "web image": input.images.web, "control-plane image (inspection only)": input.images.controlPlane,
    "API OCI revision": "not checked", "web OCI revision": "not checked",
    "execution mode": "default-production-entrypoint", schema: "not checked",
    "API health": "not run", "web health": "not run", proxy: "not run",
    "synthetic login": "not run", "/api/auth/me": "not run", "synthetic read/write": "not run",
    "synthetic storage read/write": "not run", cleanup: "not run", result: "failed", stage: "source validation",
  };
  let resourcesPossible = false;
  let failure;
  try {
    summary["tooling SHA"] = await verifyCandidateSource(input.sourceSha, sourceRoot, controller.signal);
    const dirty = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, env, signal: controller.signal });
    requireCondition(dirty === "", "SOURCE_CHECKOUT_DIRTY");
    summary.stage = "image identity";
    for (const key of Object.keys(repositories)) {
      await docker(["pull", "--platform", "linux/amd64", input.images[key]]);
      const [image] = JSON.parse(await docker(["image", "inspect", input.images[key]]));
      const revision = validateImageMetadata(key, image, input);
      if (key === "api") summary["API OCI revision"] = revision;
      if (key === "web") summary["web OCI revision"] = revision;
    }
    const existing = await docker(["container", "ls", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]);
    requireCondition(existing === "", "PROJECT_ALREADY_EXISTS");
    resourcesPossible = true;
    summary.stage = "disposable services";
    await compose(["up", "--detach", "--wait", "--wait-timeout", "120", "postgres", "minio"]);
    const database = await inspect("postgres");
    const networkName = `${project}_smoke_internal`;
    const [network] = JSON.parse(await docker(["network", "inspect", networkName]));
    requireCondition(network.Internal === true && network.Labels["com.docker.compose.project"] === project, "DISPOSABLE_NETWORK_MISMATCH");
    const subnet = network.IPAM.Config[0]?.Subnet;
    requireCondition(typeof subnet === "string" && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet), "DISPOSABLE_SUBNET_INVALID");
    composeEnv.RELEASE_SMOKE_PROXY_CIDR = subnet;
    requireCondition(Object.keys(database.NetworkSettings.Networks).length === 1, "DATABASE_NETWORK_MISMATCH");
    requireCondition(Object.values(database.NetworkSettings.Ports).every((binding) => binding === null), "DATABASE_HOST_PORT_FORBIDDEN");
    summary.stage = "source-side schema and roles";
    await initializeDatabase(sourceRoot, database.NetworkSettings.Networks[networkName]?.IPAddress, credentials,
      (args, fixtureEnv) => run(process.execPath, args, { cwd: sourceRoot, env: { ...env, ...fixtureEnv }, signal: controller.signal }), controller.signal);
    summary.schema = "0108";
    summary.stage = "default API and web startup";
    await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "api", "web"]);
    const web = await inspect("web");
    const bindings = web.NetworkSettings.Ports["80/tcp"];
    requireCondition(bindings?.length === 1 && bindings[0].HostIp === "127.0.0.1" && /^\d+$/.test(bindings[0].HostPort), "WEB_LOOPBACK_BINDING_INVALID");
    summary.stage = "HTTP and synthetic data path";
    await exerciseApi(`http://127.0.0.1:${bindings[0].HostPort}`, input.sourceSha, summary, controller.signal);
    for (const service of ["api", "web"]) {
      const container = await inspect(service);
      requireCondition(container.State.Health?.Status === "healthy" && container.RestartCount === 0, "CONTAINER_HEALTH_OR_RESTART_FAILED");
      requireCondition(container.Config.Image === input.images[service], "RUNNING_IMAGE_MISMATCH");
      if (service === "api") {
        requireCondition(JSON.stringify(container.Config.Cmd) === JSON.stringify(defaultCommand) && JSON.stringify(container.Config.Entrypoint) === JSON.stringify(defaultEntrypoint), "RUNNING_API_COMMAND_MISMATCH");
      }
    }
    summary.result = "passed";
    summary.stage = "complete";
  } catch (error) {
    const code = error?.code ?? error?.message;
    summary["failure code"] = typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code) ? code : "SMOKE_OPERATION_FAILED";
    failure = new Error("EXACT_IMAGE_SMOKE_FAILED");
  } finally {
    clearTimeout(deadline);
    let cleaned = true;
    if (resourcesPossible) {
      try { await compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], true); }
      catch { cleaned = false; }
      for (const kind of ["container", "network", "volume"]) {
        try {
          const args = [kind, "ls", ...(kind === "container" ? ["--all"] : []), "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
          requireCondition(await docker(args, true) === "", "CLEANUP_RESOURCES_REMAIN");
          const names = await docker([kind, "ls", ...(kind === "container" ? ["--all"] : []), "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"], true);
          requireCondition(!names.split("\n").some((name) => name.startsWith(`${project}_`) || name.startsWith(`${project}-`)), "CLEANUP_PREFIX_REMAINS");
        } catch { cleaned = false; }
      }
    }
    summary.cleanup = cleaned ? "passed; no temporary credential files created" : "failed";
    if (!cleaned) { summary.result = "failed"; failure = new Error("SMOKE_CLEANUP_FAILED"); }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## Release candidate image smoke\n\n${Object.entries(summary).map(([key, value]) => `- ${key}: ${value}`).join("\n")}\n\nStorage health is a static production projection; the synthetic storage read/write above tests the disposable MinIO data path. Control-plane was inspected only. Standard GHCR login is removed by login-action post-job logout.\n`);
    }
  }
  if (failure) throw failure;
  console.log("Exact image smoke and disposable cleanup passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Release candidate smoke failed. Consult the non-secret job summary; no credentials or container logs are printed.");
    process.exitCode = 1;
  });
}
