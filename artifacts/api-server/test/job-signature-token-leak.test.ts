import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, jobsTable } from "@workspace/db";
import app from "../src/app";

/**
 * Regression test: the secret `signatureToken` (a bearer credential for the
 * public /sign flow) must NEVER appear in any API response. A past leak
 * happened via GET /api/dashboard/today, which enriched jobs by spreading the
 * full DB row. enrichJobs() now strips the column; this suite locks that in
 * for both endpoints that serialize job rows in bulk:
 *
 *  1. GET /api/jobs — no `signatureToken` key anywhere in the payload, and
 *     the raw token value never appears in the response body.
 *  2. GET /api/dashboard/today — same guarantees (fixture job dated today).
 *  3. The non-secret signature metadata (signatureTokenExpiresAt,
 *     signatureRequestedAt) is still returned — the fix must not over-strip.
 *
 * Runs against the dev DB (DATABASE_URL); rate limiter skips localhost.
 */

const TAG = `test-sigleak-${Date.now()}`;
const PASSWORD = "test-password-123";
// Unique, high-entropy-looking value so a raw-body substring search is meaningful.
const SECRET_TOKEN = `secret-sig-token-${TAG}`;

const todayIso = new Date().toISOString().slice(0, 10);

let adminUserId: number;
const jobIds: number[] = [];
let todayJobId: number;

let adminAgent: Agent;

/** Recursively collect all object keys present anywhere in a JSON value. */
function collectKeys(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

beforeAll(async () => {
  const [adminUser] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Test Admin",
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = adminUser.id;

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const requestedAt = new Date();

  // Job dated today → shows up in both /api/jobs and /api/dashboard/today.
  const [todayJob] = await db
    .insert(jobsTable)
    .values({
      title: `Job today ${TAG}`,
      type: "planned_work",
      date: todayIso,
      status: "planned",
      signatureToken: SECRET_TOKEN,
      signatureTokenExpiresAt: expiresAt,
      signatureRequestedAt: requestedAt,
    })
    .returning();
  todayJobId = todayJob.id;
  jobIds.push(todayJob.id);

  // A second job with a token on another date, to exercise the /api/jobs list.
  const [otherJob] = await db
    .insert(jobsTable)
    .values({
      title: `Job other ${TAG}`,
      type: "planned_work",
      date: "2025-08-01",
      status: "planned",
      signatureToken: `${SECRET_TOKEN}-other`,
      signatureTokenExpiresAt: expiresAt,
      signatureRequestedAt: requestedAt,
    })
    .returning();
  jobIds.push(otherJob.id);

  adminAgent = request.agent(app);
  const login = await adminAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  if (jobIds.length) await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
});

describe("GET /api/jobs — signatureToken never leaks", () => {
  it("returns the fixture jobs without any signatureToken key or token value", async () => {
    const res = await adminAgent.get("/api/jobs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const fixtureJobs = (res.body as Array<Record<string, unknown>>).filter((j) =>
      jobIds.includes(j.id as number),
    );
    expect(fixtureJobs.length).toBe(jobIds.length);

    const keys = collectKeys(res.body, new Set());
    expect(keys.has("signatureToken")).toBe(false);
    expect(res.text).not.toContain(SECRET_TOKEN);
  });

  it("still returns the non-secret signature metadata", async () => {
    const res = await adminAgent.get("/api/jobs");
    expect(res.status).toBe(200);
    const job = (res.body as Array<Record<string, unknown>>).find((j) => j.id === todayJobId);
    expect(job).toBeDefined();
    expect(job!.signatureTokenExpiresAt).toBeTruthy();
    expect(job!.signatureRequestedAt).toBeTruthy();
  });
});

describe("GET /api/dashboard/today — signatureToken never leaks (regression)", () => {
  it("returns today's fixture job without any signatureToken key or token value", async () => {
    const res = await adminAgent.get("/api/dashboard/today");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const job = (res.body as Array<Record<string, unknown>>).find((j) => j.id === todayJobId);
    expect(job, "today's fixture job missing from /api/dashboard/today").toBeDefined();

    const keys = collectKeys(res.body, new Set());
    expect(keys.has("signatureToken")).toBe(false);
    expect(res.text).not.toContain(SECRET_TOKEN);

    // Non-secret metadata still present.
    expect(job!.signatureTokenExpiresAt).toBeTruthy();
  });
});
