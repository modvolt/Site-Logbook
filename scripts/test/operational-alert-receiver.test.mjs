import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createReceiverServer,
  DeadManMonitor,
  loadReceiverConfig,
  validateEnvelope,
} from "../../deploy/operational-alert-receiver/receiver.mjs";

const TOKEN = "A".repeat(43);
const KEY = "b".repeat(64);
const temporaryPaths = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function envelope(extra = {}) {
  return {
    schemaVersion: 1,
    event: "operational_alert_transitions",
    transitions: [
      {
        kind: "triggered",
        observedAt: "2026-08-04T12:00:00.000Z",
        fingerprint: "queue.extraction.stale",
        code: "queue.extraction.stale",
        severity: "warning",
        owner: "Backend",
        runbook: "docs/runbooks/operational-alerts.md",
        metric: "oldest_ready_age_seconds",
        observed: 1_000,
        threshold: 900,
        ...extra,
      },
    ],
  };
}

test("receiver config fails closed at the network and secret boundary", () => {
  assert.throws(() => loadReceiverConfig({}), /RECEIVER_BEARER_TOKEN/);
  assert.throws(
    () =>
      loadReceiverConfig({
        RECEIVER_BEARER_TOKEN: TOKEN,
        RECEIVER_STATE_DIR: join(tmpdir(), "receiver"),
        RECEIVER_BIND_HOST: "0.0.0.0",
        DEAD_MAN_TARGET_URL: "https://staging.example.com/healthz",
      }),
    /TRUSTED_TLS_PROXY/,
  );
});

test("receiver rejects non-allowlisted payload fields", () => {
  assert.equal(validateEnvelope(envelope()), true);
  assert.equal(validateEnvelope(envelope({ summary: "must not cross boundary" })), false);
});

test("receiver persists and acknowledges the same idempotency key only once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "modvolt-alert-receiver-"));
  temporaryPaths.push(stateDir);
  const logs = [];
  const config = {
    bearerToken: TOKEN,
    stateDir,
    bindHost: "127.0.0.1",
    port: 0,
    targetUrl: "https://staging.example.com/healthz",
    probeIntervalMs: 60_000,
    probeTimeoutMs: 1_000,
    failureThreshold: 2,
  };
  const server = createReceiverServer(config, { log: (entry) => logs.push(entry) });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/v1/operational-alerts`;
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": KEY,
      },
      body: JSON.stringify(envelope()),
    });
  const first = await send();
  const duplicate = await send();
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(logs.map((entry) => entry.event), ["alert_received", "alert_duplicate_acknowledged"]);
});

test("dead-man emits one threshold alert and one recovery", async () => {
  const logs = [];
  const statuses = [503, 503, 503, 204];
  const monitor = new DeadManMonitor(
    {
      targetUrl: "https://staging.example.com/healthz",
      probeTimeoutMs: 1_000,
      failureThreshold: 2,
    },
    {
      fetch: async () => ({ status: statuses.shift(), body: null }),
      log: (entry) => logs.push(entry),
    },
  );
  assert.equal(await monitor.probeOnce(), false);
  assert.equal(await monitor.probeOnce(), false);
  assert.equal(await monitor.probeOnce(), false);
  assert.equal(await monitor.probeOnce(), true);
  assert.deepEqual(logs.map((entry) => entry.event), ["dead_man_triggered", "dead_man_recovered"]);
});
