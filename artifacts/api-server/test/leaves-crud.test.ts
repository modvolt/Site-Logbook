import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, peopleTable, employeeLeavesTable } from "@workspace/db";
import app from "../src/app";

/**
 * CRUD endpoint tests for /api/leaves.
 *
 * Locked-in invariants:
 * 1. Unauthenticated requests to write endpoints return 401.
 * 2. Guest users get 403 on POST / PUT / DELETE (requires admin/master).
 * 3. POST /api/leaves with valid data returns 201 with correct dayCount and personName.
 * 4. PUT /api/leaves/:id on a non-existent id returns 404.
 * 5. DELETE /api/leaves/:id on a non-existent id returns 404.
 *
 * Runs against the dev DB (DATABASE_URL). The rate limiter on /auth/login
 * skips localhost so supertest agents can log in freely. Fixtures use a unique
 * TAG and are torn down in afterAll.
 */

const TAG = `test-lcrud-${Date.now()}`;
const PASSWORD = "test-password-123";

let adminUserId: number;
let guestUserId: number;
let personId: number;

const createdLeaveIds: number[] = [];
const userIds: number[] = [];

let adminAgent: Agent;
let guestAgent: Agent;

beforeAll(async () => {
  // Ensure the table exists — the dev DB may have been provisioned via drizzle
  // push with an empty migration journal and may lag behind committed migrations.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "employee_leaves" (
      "id" serial PRIMARY KEY NOT NULL,
      "person_id" integer NOT NULL,
      "type" text DEFAULT 'vacation' NOT NULL,
      "start_date" text NOT NULL,
      "end_date" text NOT NULL,
      "note" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    )
  `);
  // Add FK idempotently: drop if exists, then recreate. This is safe in test
  // setup and avoids PL/pgSQL (whose dollar-quoting conflicts with drizzle's
  // sql tag parameter placeholders).
  await db.execute(
    sql`ALTER TABLE "employee_leaves" DROP CONSTRAINT IF EXISTS "employee_leaves_person_id_people_id_fk"`,
  );
  await db.execute(
    sql`ALTER TABLE "employee_leaves" ADD CONSTRAINT "employee_leaves_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action`,
  );

  // The POST/GET routes also query leave_settings for annual-cap checks.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "leave_settings" (
      "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
      "vacation_yearly_cap" integer DEFAULT 25 NOT NULL,
      "sick_yearly_cap" integer DEFAULT 60 NOT NULL,
      "other_yearly_cap" integer DEFAULT 30 NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    )
  `);

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
  userIds.push(adminUserId);

  const [guestUser] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-guest`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Test Guest",
      role: "guest",
      isActive: true,
    })
    .returning();
  guestUserId = guestUser.id;
  userIds.push(guestUserId);

  const [person] = await db
    .insert(peopleTable)
    .values({ name: `Worker ${TAG}` })
    .returning();
  personId = person.id;

  adminAgent = request.agent(app);
  const adminLogin = await adminAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(adminLogin.status).toBe(200);

  guestAgent = request.agent(app);
  const guestLogin = await guestAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-guest`, password: PASSWORD });
  expect(guestLogin.status).toBe(200);
});

afterAll(async () => {
  if (createdLeaveIds.length)
    await db.delete(employeeLeavesTable).where(inArray(employeeLeavesTable.id, createdLeaveIds));
  if (personId)
    await db.delete(peopleTable).where(eq(peopleTable.id, personId));
  if (userIds.length)
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

// ── 401: unauthenticated ──────────────────────────────────────────────────────

describe("leaves write endpoints — unauthenticated → 401", () => {
  it("POST /api/leaves returns 401 without a session", async () => {
    const res = await request(app)
      .post("/api/leaves")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(401);
  });

  it("PUT /api/leaves/1 returns 401 without a session", async () => {
    const res = await request(app)
      .put("/api/leaves/1")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/leaves/1 returns 401 without a session", async () => {
    const res = await request(app).delete("/api/leaves/1");
    expect(res.status).toBe(401);
  });
});

// ── 403: guest user ───────────────────────────────────────────────────────────

describe("leaves write endpoints — guest → 403", () => {
  it("POST /api/leaves returns 403 for a guest user", async () => {
    const res = await guestAgent
      .post("/api/leaves")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(403);
  });

  it("PUT /api/leaves/1 returns 403 for a guest user", async () => {
    const res = await guestAgent
      .put("/api/leaves/1")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/leaves/1 returns 403 for a guest user", async () => {
    const res = await guestAgent.delete("/api/leaves/1");
    expect(res.status).toBe(403);
  });
});

// ── 201: POST round-trip ──────────────────────────────────────────────────────

describe("POST /api/leaves — admin → 201 with correct days and personName", () => {
  it("creates a vacation leave and returns 201 with correct personName", async () => {
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(201);
    expect(res.body.personName).toBe(`Worker ${TAG}`);
    expect(res.body.personId).toBe(personId);
    expect(res.body.type).toBe("vacation");
    if (res.body.id) createdLeaveIds.push(res.body.id);
  });

  it("returns a positive day count for a weekday range", async () => {
    // 2025-07-01 (Tue) – 2025-07-05 (Sat): Tue/Wed/Thu/Fri = 4 business days
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(201);
    expect(res.body.days).toBeGreaterThan(0);
    if (res.body.id) createdLeaveIds.push(res.body.id);
  });

  it("returns the correct business-day count (Tue–Fri = 4 days) for 2025-07-01–2025-07-04", async () => {
    // 2025-07-01 (Tue) – 2025-07-04 (Fri): 4 business days; no public holiday in that window
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId, type: "sick", startDate: "2025-07-01", endDate: "2025-07-04" });
    expect(res.status).toBe(201);
    expect(res.body.days).toBe(4);
    if (res.body.id) createdLeaveIds.push(res.body.id);
  });

  it("returns 400 when endDate is before startDate", async () => {
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId, type: "vacation", startDate: "2025-07-05", endDate: "2025-07-01" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when personId does not exist", async () => {
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId: 999999999, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(404);
  });
});

// ── 404: PUT / DELETE on non-existent id ─────────────────────────────────────

describe("PUT /api/leaves/:id — unknown id → 404", () => {
  it("returns 404 for a PUT to a non-existent leave id", async () => {
    const res = await adminAgent
      .put("/api/leaves/999999999")
      .send({ personId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/leaves/:id — unknown id → 404", () => {
  it("returns 404 for a DELETE to a non-existent leave id", async () => {
    const res = await adminAgent.delete("/api/leaves/999999999");
    expect(res.status).toBe(404);
  });
});

// ── Full round-trip: create → edit → delete ───────────────────────────────────

describe("leaves full CRUD round-trip (admin)", () => {
  let leaveId: number;

  it("creates a leave (POST → 201)", async () => {
    const res = await adminAgent
      .post("/api/leaves")
      .send({ personId, type: "other", startDate: "2025-08-04", endDate: "2025-08-06" });
    expect(res.status).toBe(201);
    leaveId = res.body.id;
    createdLeaveIds.push(leaveId);
    expect(leaveId).toBeGreaterThan(0);
  });

  it("updates the leave (PUT → 200) with new type and correct personName", async () => {
    const res = await adminAgent
      .put(`/api/leaves/${leaveId}`)
      .send({ personId, type: "sick", startDate: "2025-08-04", endDate: "2025-08-06" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("sick");
    expect(res.body.personName).toBe(`Worker ${TAG}`);
  });

  it("deletes the leave (DELETE → 204)", async () => {
    const res = await adminAgent.delete(`/api/leaves/${leaveId}`);
    expect(res.status).toBe(204);
    createdLeaveIds.splice(createdLeaveIds.indexOf(leaveId), 1);
  });

  it("DELETE of already-deleted leave returns 404", async () => {
    const res = await adminAgent.delete(`/api/leaves/${leaveId}`);
    expect(res.status).toBe(404);
  });
});
