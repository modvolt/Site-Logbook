import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  loadStagingOperationalAlertDrillConfig,
  runStagingOperationalAlertDrill,
  StagingOperationalAlertDrillError,
} from "../staging-operational-alert-drill.mjs";

const SHA = "a".repeat(40);
const TOKEN = "B".repeat(43);
const temporaryPaths = [];
const WORKFLOW_URL = new URL(
  "../../.github/workflows/staging-smoke.yml",
  import.meta.url,
);

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function config(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "modvolt-alert-drill-"));
  temporaryPaths.push(directory);
  return loadStagingOperationalAlertDrillConfig({
    STAGING_ALERT_DRILL_CONFIRM_ISOLATED: "true",
    STAGING_ALERT_DRILL_SOURCE_SHA: SHA,
    STAGING_ALERT_DRILL_RUN_ID: "nightly-alert-drill",
    STAGING_ALERT_APP_HEALTH_URL:
      "https://site-logbook-staging.example.com/api/healthz",
    STAGING_ALERT_RECEIVER_URL:
      "https://alerts-staging.example.com/v1/operational-alerts",
    STAGING_ALERT_RECEIVER_BEARER_TOKEN: TOKEN,
    STAGING_ALERT_DRILL_EVIDENCE_FILE: join(directory, "evidence.json"),
    ...overrides,
  });
}

test("configuration fails closed at production, shared-host and secret boundaries", async () => {
  await assert.rejects(
    () => config({ STAGING_ALERT_DRILL_CONFIRM_ISOLATED: "false" }),
    (error) =>
      error instanceof StagingOperationalAlertDrillError &&
      error.code === "STAGING_ALERT_DRILL_NOT_CONFIRMED",
  );
  await assert.rejects(
    () =>
      config({
        STAGING_ALERT_APP_HEALTH_URL: "https://modvoltapp.cz/api/healthz",
      }),
    /STAGING_ALERT_DRILL_URL_FORBIDDEN/,
  );
  await assert.rejects(
    () =>
      config({
        STAGING_ALERT_RECEIVER_URL:
          "https://site-logbook-staging.example.com/v1/operational-alerts",
      }),
    /STAGING_ALERT_DRILL_BOUNDARY_COLLAPSED/,
  );
  await assert.rejects(
    () => config({ STAGING_ALERT_RECEIVER_BEARER_TOKEN: "weak" }),
    /STAGING_ALERT_DRILL_TOKEN_INVALID/,
  );
});

test("proves exact SHA health and persistent receiver idempotency without leaking the token", async () => {
  const drillConfig = await config();
  const calls = [];
  const responses = [
    new Response(
      JSON.stringify({ status: "ok", version: SHA, migrationParity: true }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        ok: true,
        service: "operational-alert-receiver",
        buildSha: SHA,
      }),
      { status: 200 },
    ),
    new Response(JSON.stringify({ accepted: true, duplicate: false }), {
      status: 202,
    }),
    new Response(JSON.stringify({ accepted: true, duplicate: true }), {
      status: 200,
    }),
  ];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responses.shift();
  };
  const timestamps = [
    new Date("2026-08-05T00:00:00.000Z"),
    new Date("2026-08-05T00:00:01.000Z"),
  ];
  const evidence = await runStagingOperationalAlertDrill(drillConfig, {
    fetch,
    now: () => timestamps.shift(),
  });
  assert.equal(evidence.decision, "PASS");
  assert.equal(evidence.receiver.persistentIdempotencyAcknowledged, true);
  assert.equal(calls.length, 4);
  const deliveryCalls = calls.slice(2);
  assert.equal(
    deliveryCalls[0].init.headers["idempotency-key"],
    deliveryCalls[1].init.headers["idempotency-key"],
  );
  const serialized = await readFile(drillConfig.evidencePath, "utf8");
  assert.doesNotMatch(serialized, new RegExp(TOKEN));
  assert.doesNotMatch(serialized, /https:\/\//);
  assert.match(serialized, /"decision": "PASS"/);
});

test("rejects a stale receiver image before sending a synthetic event", async () => {
  const drillConfig = await config();
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(
        JSON.stringify({ status: "ok", version: SHA, migrationParity: true }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        service: "operational-alert-receiver",
        buildSha: "f".repeat(40),
      }),
      { status: 200 },
    );
  };
  await assert.rejects(
    () => runStagingOperationalAlertDrill(drillConfig, { fetch }),
    /STAGING_ALERT_DRILL_RECEIVER_NOT_READY/,
  );
  assert.equal(requests, 2);
});

test("manual staging smoke wires the guarded receiver drill and secret-free evidence", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  assert.match(workflow, /confirm_operational_alert_drill:/);
  assert.match(
    workflow,
    /STAGING_ALERT_RECEIVER_URL: \$\{\{ vars\.STAGING_ALERT_RECEIVER_URL \}\}/,
  );
  assert.match(
    workflow,
    /STAGING_ALERT_RECEIVER_BEARER_TOKEN: \$\{\{ secrets\.STAGING_ALERT_RECEIVER_BEARER_TOKEN \}\}/,
  );
  assert.match(workflow, /run: pnpm drill:staging-operational-alert/);
  assert.match(
    workflow,
    /path: \$\{\{ runner\.temp \}\}\/staging-operational-alert-evidence\.json/,
  );
  assert.doesNotMatch(
    workflow,
    /STAGING_ALERT_RECEIVER_BEARER_TOKEN:\s+[A-Za-z0-9_-]{43}/,
  );
});
