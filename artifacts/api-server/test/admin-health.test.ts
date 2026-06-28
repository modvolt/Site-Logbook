import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable } from "@workspace/db";
import app from "../src/app";

/**
 * Tests for GET /api/admin/health
 *
 * Verifies:
 * 1. Unauthenticated request → 401
 * 2. Guest role → 403
 * 3. Admin role → 200 with migrationParity field present
 * 4. Response never contains secrets (apiKey, password, connection strings)
 *
 * Runs against the dev database. Rate limiter skips localhost.
 */

const TAG = `test-health-${Date.now()}`;
const PASSWORD = "test-pw-health-123";

let adminUserId: number;
let guestUserId: number;

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Health Test Admin",
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;

  const [guest] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-guest`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Health Test Guest",
      role: "guest",
      isActive: true,
    })
    .returning();
  guestUserId = guest.id;
});

afterAll(async () => {
  if (adminUserId || guestUserId) {
    await db
      .delete(usersTable)
      .where(
        inArray(
          usersTable.id,
          [adminUserId, guestUserId].filter(Boolean),
        ),
      );
  }
});

async function loginAs(username: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("GET /api/admin/health – authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/admin/health");
    expect(res.status).toBe(401);
  });

  it("returns 403 for guest role", async () => {
    const agent = await loginAs(`${TAG}-guest`);
    const res = await agent.get("/api/admin/health");
    expect(res.status).toBe(403);
  });

  it("returns 200 for admin role", async () => {
    const agent = await loginAs(`${TAG}-admin`);
    const res = await agent.get("/api/admin/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/health – response shape", () => {
  let agent: Agent;
  let body: Record<string, unknown>;

  beforeAll(async () => {
    agent = await loginAs(`${TAG}-admin`);
    const res = await agent.get("/api/admin/health");
    expect(res.status).toBe(200);
    body = res.body as Record<string, unknown>;
  });

  it("includes required top-level fields", () => {
    expect(body).toHaveProperty("apiVersion");
    expect(body).toHaveProperty("migrationParity");
    expect(body).toHaveProperty("dbStatus");
    expect(body).toHaveProperty("storageStatus");
    expect(body).toHaveProperty("smtpStatus");
    expect(body).toHaveProperty("aiStatus");
    expect(body).toHaveProperty("frontendErrorCount24h");
    expect(body).toHaveProperty("backendErrorCount24h");
  });

  it("migrationParity is a boolean", () => {
    expect(typeof body["migrationParity"]).toBe("boolean");
  });

  it("error counts are non-negative integers", () => {
    const fe = body["frontendErrorCount24h"];
    const be = body["backendErrorCount24h"];
    expect(typeof fe).toBe("number");
    expect(typeof be).toBe("number");
    expect(fe as number).toBeGreaterThanOrEqual(0);
    expect(be as number).toBeGreaterThanOrEqual(0);
  });

  it("does not expose secrets", () => {
    const raw = JSON.stringify(body);
    // No connection strings
    expect(raw).not.toMatch(/postgres:\/\//i);
    // No apiKey field
    expect(body).not.toHaveProperty("apiKey");
    // No password field
    expect(body).not.toHaveProperty("password");
    // smtpHost may be present but must not contain credentials
    const smtpHost = body["smtpHost"] as string | null;
    if (smtpHost) {
      expect(smtpHost).not.toMatch(/:/); // no "host:port" with embedded password
    }
  });
});

describe("GET /api/admin/health – migration parity", () => {
  it("reports migrationParity false and lists missing tags when journal cannot be read", async () => {
    // We cannot easily manipulate the DB migrations table in a test without risk.
    // Instead we exercise the journal-unreadable code path by temporarily
    // pointing MIGRATIONS_DIR at a non-existent path.
    const original = process.env.MIGRATIONS_DIR;
    process.env.MIGRATIONS_DIR = "/tmp/__nonexistent_migrations_dir__";

    const agent = await loginAs(`${TAG}-admin`);
    const res = await agent.get("/api/admin/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["migrationParity"]).toBe(false);
    expect(Array.isArray(body["missingMigrationTags"])).toBe(true);
    expect((body["missingMigrationTags"] as string[]).length).toBeGreaterThan(0);

    // Restore
    if (original === undefined) delete process.env.MIGRATIONS_DIR;
    else process.env.MIGRATIONS_DIR = original;
  });
});
