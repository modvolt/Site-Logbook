import { timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,}$/;
const ALLOWED_ROOT_KEYS = new Set(["schemaVersion", "event", "transitions"]);
const ALLOWED_TRANSITION_KEYS = new Set([
  "kind",
  "observedAt",
  "fingerprint",
  "code",
  "severity",
  "owner",
  "runbook",
  "metric",
  "observed",
  "threshold",
]);

function boundedInteger(value, fallback, min, max, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadReceiverConfig(env = process.env) {
  const bearerToken = env.RECEIVER_BEARER_TOKEN?.trim() ?? "";
  if (!TOKEN.test(bearerToken)) {
    throw new Error("RECEIVER_BEARER_TOKEN must be 32+ random base64url bytes");
  }
  const stateDir = env.RECEIVER_STATE_DIR?.trim() ?? "";
  if (!stateDir || !isAbsolute(stateDir)) {
    throw new Error("RECEIVER_STATE_DIR must be an absolute persistent path");
  }
  const bindHost = env.RECEIVER_BIND_HOST?.trim() || "127.0.0.1";
  if (
    bindHost !== "127.0.0.1" &&
    bindHost !== "::1" &&
    env.RECEIVER_TRUSTED_TLS_PROXY !== "true"
  ) {
    throw new Error("Non-loopback receiver binding requires RECEIVER_TRUSTED_TLS_PROXY=true");
  }
  const target = new URL(env.DEAD_MAN_TARGET_URL ?? "");
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("DEAD_MAN_TARGET_URL must be a credential-free HTTPS URL");
  }
  return {
    bearerToken,
    stateDir,
    bindHost,
    port: boundedInteger(env.PORT, 8080, 1, 65_535, "PORT"),
    targetUrl: target.toString(),
    probeIntervalMs:
      boundedInteger(env.DEAD_MAN_INTERVAL_SECONDS, 60, 30, 3_600, "DEAD_MAN_INTERVAL_SECONDS") *
      1_000,
    probeTimeoutMs: boundedInteger(
      env.DEAD_MAN_TIMEOUT_MS,
      5_000,
      500,
      30_000,
      "DEAD_MAN_TIMEOUT_MS",
    ),
    failureThreshold: boundedInteger(
      env.DEAD_MAN_FAILURE_THRESHOLD,
      3,
      1,
      10,
      "DEAD_MAN_FAILURE_THRESHOLD",
    ),
  };
}

function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function validateString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !ALLOWED_ROOT_KEYS.has(key))) return false;
  if (
    value.schemaVersion !== 1 ||
    value.event !== "operational_alert_transitions" ||
    !Array.isArray(value.transitions) ||
    value.transitions.length < 1 ||
    value.transitions.length > 32
  ) {
    return false;
  }
  return value.transitions.every((transition) => {
    if (!transition || typeof transition !== "object" || Array.isArray(transition)) return false;
    if (Object.keys(transition).some((key) => !ALLOWED_TRANSITION_KEYS.has(key))) return false;
    return (
      ["triggered", "escalated", "deescalated", "recovered"].includes(transition.kind) &&
      ["warning", "critical"].includes(transition.severity) &&
      validateString(transition.observedAt, 40) &&
      Number.isFinite(Date.parse(transition.observedAt)) &&
      validateString(transition.fingerprint, 256) &&
      validateString(transition.code, 128) &&
      validateString(transition.owner, 128) &&
      validateString(transition.runbook, 256) &&
      validateString(transition.metric, 128) &&
      (transition.observed === null || Number.isFinite(transition.observed)) &&
      (transition.threshold === null || Number.isFinite(transition.threshold))
    );
  });
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function createReceiverServer(config, dependencies = {}) {
  const log = dependencies.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        reply(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/operational-alerts") {
        reply(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request.headers.authorization, config.bearerToken)) {
        reply(response, 401, { error: "unauthorized" });
        return;
      }
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
        reply(response, 400, { error: "invalid_idempotency_key" });
        return;
      }
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
        reply(response, 415, { error: "unsupported_media_type" });
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(await readBody(request));
      } catch (error) {
        reply(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400, {
          error: "invalid_body",
        });
        return;
      }
      if (!validateEnvelope(envelope)) {
        reply(response, 400, { error: "invalid_envelope" });
        return;
      }

      const receipts = join(config.stateDir, "receipts");
      await mkdir(receipts, { recursive: true });
      let duplicate = false;
      try {
        await writeFile(
          join(receipts, `${key}.json`),
          JSON.stringify({ receivedAt: new Date().toISOString(), transitionCount: envelope.transitions.length }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error && typeof error === "object" && error.code === "EEXIST") duplicate = true;
        else throw error;
      }
      log({ event: duplicate ? "alert_duplicate_acknowledged" : "alert_received", key, transitionCount: envelope.transitions.length });
      reply(response, duplicate ? 200 : 202, { accepted: true, duplicate });
    } catch (error) {
      log({ event: "receiver_error", errorName: error instanceof Error ? error.name : "unknown" });
      reply(response, 500, { error: "receiver_unavailable" });
    }
  });
}

export class DeadManMonitor {
  #failures = 0;
  #alerting = false;

  constructor(config, dependencies = {}) {
    this.config = config;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.log = dependencies.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  }

  async probeOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.probeTimeoutMs);
    timer.unref?.();
    let ok = false;
    try {
      const response = await this.fetch(this.config.targetUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      await response.body?.cancel().catch(() => undefined);
      ok = response.status >= 200 && response.status < 300;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    if (ok) {
      if (this.#alerting) this.log({ event: "dead_man_recovered", target: new URL(this.config.targetUrl).host });
      this.#failures = 0;
      this.#alerting = false;
      return true;
    }
    this.#failures += 1;
    if (!this.#alerting && this.#failures >= this.config.failureThreshold) {
      this.#alerting = true;
      this.log({
        event: "dead_man_triggered",
        target: new URL(this.config.targetUrl).host,
        consecutiveFailures: this.#failures,
      });
    }
    return false;
  }
}

export async function startReceiver(env = process.env) {
  const config = loadReceiverConfig(env);
  await mkdir(config.stateDir, { recursive: true });
  const server = createReceiverServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindHost, resolve);
  });
  const monitor = new DeadManMonitor(config);
  const probe = () => void monitor.probeOnce();
  const timer = setInterval(probe, config.probeIntervalMs);
  timer.unref();
  probe();
  process.stdout.write(`${JSON.stringify({ event: "receiver_started", port: config.port })}\n`);
  return { server, timer };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startReceiver().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", errorName: error instanceof Error ? error.name : "unknown" })}\n`);
    process.exitCode = 1;
  });
}
