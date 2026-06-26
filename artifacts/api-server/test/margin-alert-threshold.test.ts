import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { db, billingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureBillingSettings } from "../src/lib/invoice-service";
import billingRouter from "../src/routes/billing";
import warehouseRouter from "../src/routes/warehouse-items";

/**
 * Operator-configurable margin warning threshold (DB-backed, real HTTP).
 *
 * Covers the persistence + read-back contract that the job-detail low-margin
 * alert relies on:
 *
 *  - PUT /billing/settings persists `marginAlertThresholdPercent`, GET returns
 *    it, and — unlike `materialMarkupPercent` — a NEGATIVE value is allowed
 *    (a deep-loss floor). A regression that clamps it to >= 0 or reverts the
 *    field to the old hardcoded 0% behaviour would fail here.
 *  - GET /warehouse-movements/job-margin-trend echoes `alertThresholdPercent`
 *    reflecting whatever was last saved (the client compares it to the latest
 *    cumulative margin to decide whether to show the alert).
 *
 * The routers are mounted on a bare Express app (no central auth gate) and
 * driven over real HTTP via fetch, so the actual route handlers, Zod body
 * validation and `serializeSettings` mapping run end to end.
 *
 * billing_settings is a global singleton (id=1); the original threshold is
 * captured up-front and restored afterwards so the dev DB is left untouched.
 * Requires the `margin_alert_threshold_percent` column to exist (migration /
 * direct ALTER; see .agents/memory/test-db-schema-drift.md).
 */

let server: Server;
let baseUrl: string;
let originalThreshold: string | null = null;

beforeAll(async () => {
  const existing = await ensureBillingSettings();
  originalThreshold = existing.marginAlertThresholdPercent;

  const app = express();
  app.use(express.json());
  // Both routers gate writes behind requireRole/requireAuth (req.auth). The
  // central session/auth layer lives in app.ts; here we inject an admin actor
  // directly so the route handlers under test run.
  app.use((req, _res, next) => {
    req.auth = {
      userId: 1,
      username: "test-admin",
      role: "admin",
      name: "Test Admin",
    };
    next();
  });
  app.use(billingRouter);
  app.use(warehouseRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  // Restore the singleton to its pre-test value.
  await db
    .update(billingSettingsTable)
    .set({ marginAlertThresholdPercent: originalThreshold ?? "0" })
    .where(eq(billingSettingsTable.id, 1));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function putThreshold(value: number): Promise<Response> {
  return fetch(`${baseUrl}/billing/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marginAlertThresholdPercent: value }),
  });
}

async function getSettings(): Promise<{ marginAlertThresholdPercent: number }> {
  const res = await fetch(`${baseUrl}/billing/settings`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("PUT/GET /billing/settings marginAlertThresholdPercent", () => {
  it("persists a positive threshold and returns it on GET", async () => {
    const put = await putThreshold(7.5);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.marginAlertThresholdPercent).toBe(7.5);

    const get = await getSettings();
    expect(get.marginAlertThresholdPercent).toBe(7.5);
  });

  it("persists a NEGATIVE threshold (deep-loss floor is allowed)", async () => {
    const put = await putThreshold(-10);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.marginAlertThresholdPercent).toBe(-10);

    const get = await getSettings();
    expect(get.marginAlertThresholdPercent).toBe(-10);
  });

  it("rounds to two decimals on persist", async () => {
    const put = await putThreshold(3.456);
    expect(put.status).toBe(200);
    const get = await getSettings();
    expect(get.marginAlertThresholdPercent).toBe(3.46);
  });

  it("leaves the value unchanged when omitted (null = leave unchanged)", async () => {
    await putThreshold(5);
    const res = await fetch(`${baseUrl}/billing/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marginAlertThresholdPercent: null }),
    });
    expect(res.status).toBe(200);
    const get = await getSettings();
    expect(get.marginAlertThresholdPercent).toBe(5);
  });
});

describe("GET /warehouse-movements/job-margin-trend alertThresholdPercent", () => {
  it("echoes the saved threshold (positive)", async () => {
    await putThreshold(12.25);
    const res = await fetch(
      `${baseUrl}/warehouse-movements/job-margin-trend?jobId=999999`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alertThresholdPercent).toBe(12.25);
    expect(Array.isArray(body.points)).toBe(true);
  });

  it("echoes the saved threshold (negative)", async () => {
    await putThreshold(-3);
    const res = await fetch(
      `${baseUrl}/warehouse-movements/job-margin-trend?jobId=999999`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alertThresholdPercent).toBe(-3);
  });
});
