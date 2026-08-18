import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

export class StagingOperationalAlertDrillError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingOperationalAlertDrillError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingOperationalAlertDrillError(code, message);
}

function publicHttpsUrl(raw, expectedPath, label) {
  let parsed;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    fail("STAGING_ALERT_DRILL_URL_INVALID", `${label} must be a valid URL.`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== expectedPath ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "modvoltapp.cz" ||
    hostname.endsWith(".modvoltapp.cz") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".invalid")
  ) {
    fail(
      "STAGING_ALERT_DRILL_URL_FORBIDDEN",
      `${label} must be an exact public staging HTTPS endpoint.`,
    );
  }
  return parsed;
}

function outsideRepository(path) {
  const relationship = relative(REPO_ROOT, path);
  return relationship.startsWith("..") || isAbsolute(relationship);
}

export function loadStagingOperationalAlertDrillConfig(env = process.env) {
  if (env.STAGING_ALERT_DRILL_CONFIRM_ISOLATED !== "true") {
    fail(
      "STAGING_ALERT_DRILL_NOT_CONFIRMED",
      "STAGING_ALERT_DRILL_CONFIRM_ISOLATED must equal true.",
    );
  }
  const sourceSha = env.STAGING_ALERT_DRILL_SOURCE_SHA?.trim() ?? "";
  if (!SOURCE_SHA.test(sourceSha)) {
    fail(
      "STAGING_ALERT_DRILL_SHA_INVALID",
      "STAGING_ALERT_DRILL_SOURCE_SHA must be the exact deployed commit SHA.",
    );
  }
  const runId = env.STAGING_ALERT_DRILL_RUN_ID?.trim() ?? "";
  if (!RUN_ID.test(runId)) {
    fail(
      "STAGING_ALERT_DRILL_RUN_ID_INVALID",
      "STAGING_ALERT_DRILL_RUN_ID must be a lowercase non-secret identifier.",
    );
  }
  const bearerToken = env.STAGING_ALERT_RECEIVER_BEARER_TOKEN?.trim() ?? "";
  if (!TOKEN.test(bearerToken)) {
    fail(
      "STAGING_ALERT_DRILL_TOKEN_INVALID",
      "STAGING_ALERT_RECEIVER_BEARER_TOKEN must be 32+ random base64url bytes.",
    );
  }
  const appHealthUrl = publicHttpsUrl(
    env.STAGING_ALERT_APP_HEALTH_URL,
    "/api/healthz",
    "application health URL",
  );
  const receiverUrl = publicHttpsUrl(
    env.STAGING_ALERT_RECEIVER_URL,
    "/v1/operational-alerts",
    "receiver URL",
  );
  if (appHealthUrl.hostname === receiverUrl.hostname) {
    fail(
      "STAGING_ALERT_DRILL_BOUNDARY_COLLAPSED",
      "the application and receiver must use separate public hostnames.",
    );
  }
  const evidencePath = env.STAGING_ALERT_DRILL_EVIDENCE_FILE?.trim() ?? "";
  if (
    !evidencePath ||
    !isAbsolute(evidencePath) ||
    !outsideRepository(evidencePath)
  ) {
    fail(
      "STAGING_ALERT_DRILL_EVIDENCE_PATH_INVALID",
      "evidence must use a new absolute path outside the repository.",
    );
  }
  return Object.freeze({
    sourceSha,
    runId,
    bearerToken,
    appHealthUrl: appHealthUrl.toString(),
    receiverUrl: receiverUrl.toString(),
    receiverHealthUrl: new URL("/healthz", receiverUrl).toString(),
    evidencePath,
  });
}

async function boundedJson(response, label) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail(
      "STAGING_ALERT_DRILL_RESPONSE_TOO_LARGE",
      `${label} response is too large.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(
      "STAGING_ALERT_DRILL_RESPONSE_INVALID",
      `${label} response is not JSON.`,
    );
  }
}

async function request(fetchImpl, url, init, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    fail("STAGING_ALERT_DRILL_NETWORK_FAILURE", `${label} request failed.`);
  } finally {
    clearTimeout(timeout);
  }
}

function syntheticEnvelope(sourceSha, observedAt) {
  return {
    schemaVersion: 1,
    event: "operational_alert_transitions",
    transitions: [
      {
        kind: "triggered",
        observedAt,
        fingerprint: `staging.synthetic.${sourceSha.slice(0, 12)}`,
        code: "staging.synthetic.receiver",
        severity: "warning",
        owner: "Staging operator",
        runbook: "docs/runbooks/operational-alerts.md",
        metric: "synthetic_delivery",
        observed: 1,
        threshold: 1,
      },
    ],
  };
}

export async function runStagingOperationalAlertDrill(
  config,
  dependencies = {},
) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const appResponse = await request(
    fetchImpl,
    config.appHealthUrl,
    { method: "GET", headers: { accept: "application/json" } },
    "application health",
  );
  const appHealth = await boundedJson(appResponse, "application health");
  if (
    appResponse.status !== 200 ||
    appHealth.status !== "ok" ||
    appHealth.version !== config.sourceSha ||
    appHealth.migrationParity !== true
  ) {
    fail(
      "STAGING_ALERT_DRILL_APP_NOT_READY",
      "application health does not prove the expected SHA and migration parity.",
    );
  }

  const receiverHealthResponse = await request(
    fetchImpl,
    config.receiverHealthUrl,
    { method: "GET", headers: { accept: "application/json" } },
    "receiver health",
  );
  const receiverHealth = await boundedJson(
    receiverHealthResponse,
    "receiver health",
  );
  if (
    receiverHealthResponse.status !== 200 ||
    receiverHealth.ok !== true ||
    receiverHealth.service !== "operational-alert-receiver" ||
    receiverHealth.buildSha !== config.sourceSha
  ) {
    fail(
      "STAGING_ALERT_DRILL_RECEIVER_NOT_READY",
      "receiver health does not prove the expected SHA.",
    );
  }

  const idempotencyKey = createHash("sha256")
    .update(config.sourceSha)
    .update("\0")
    .update(config.runId)
    .digest("hex");
  const body = JSON.stringify(syntheticEnvelope(config.sourceSha, startedAt));
  const send = () =>
    request(
      fetchImpl,
      config.receiverUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.bearerToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body,
      },
      "receiver delivery",
    );
  const first = await send();
  const firstBody = await boundedJson(first, "first receiver delivery");
  const duplicate = await send();
  const duplicateBody = await boundedJson(
    duplicate,
    "duplicate receiver delivery",
  );
  if (
    first.status !== 202 ||
    firstBody.accepted !== true ||
    firstBody.duplicate !== false ||
    duplicate.status !== 200 ||
    duplicateBody.accepted !== true ||
    duplicateBody.duplicate !== true
  ) {
    fail(
      "STAGING_ALERT_DRILL_IDEMPOTENCY_FAILED",
      "receiver did not prove first acceptance followed by duplicate acknowledgement.",
    );
  }

  const evidence = Object.freeze({
    schemaVersion: 1,
    decision: "PASS",
    runId: config.runId,
    sourceSha: config.sourceSha,
    startedAt,
    completedAt: now().toISOString(),
    app: { ready: true, migrationParity: true, exactSha: true },
    receiver: {
      ready: true,
      exactSha: true,
      firstStatus: first.status,
      duplicateStatus: duplicate.status,
      persistentIdempotencyAcknowledged: true,
    },
  });
  await writeFile(
    config.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
  return evidence;
}

async function main() {
  const config = loadStagingOperationalAlertDrillConfig();
  const evidence = await runStagingOperationalAlertDrill(config);
  process.stdout.write(
    `${JSON.stringify({ decision: evidence.decision, sourceSha: evidence.sourceSha, runId: evidence.runId })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "STAGING_ALERT_DRILL_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
