import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, peopleTable, jobsTable, jobAssigneesTable, employeeLeavesTable } from "@workspace/db";
import app from "../src/app";

/**
 * Tests for PUT /api/jobs/:id/assignees — assigning additional workers to a
 * job beyond the primary `assignedPersonId`.
 *
 * Locked-in invariants:
 * 1. Unauthenticated requests return 401.
 * 2. The primary assignedPersonId is silently excluded from the additional
 *    set (it is conceptually distinct — calendar scheduling vs. extra crew).
 * 3. Duplicate ids in the payload are deduped.
 * 4. A non-existent person id returns 400.
 * 5. A person on leave during the job's date returns 409.
 * 6. A full replace (delete-then-insert) correctly drops previously assigned
 *    workers that are no longer in the new list.
 * 7. A non-existent job id returns 404.
 *
 * Runs against the dev DB (DATABASE_URL). Fixtures use a unique TAG and are
 * torn down in afterAll.
 */

const TAG = `test-jassign-${Date.now()}`;
const PASSWORD = "test-password-123";

let adminUserId: number;
let personAId: number;
let personBId: number;
let personCId: number;
let jobId: number;
let jobIdNoPrimary: number;

const createdLeaveIds: number[] = [];
const userIds: number[] = [];

let adminAgent: Agent;

beforeAll(async () => {
  // Defensive: the dev DB may lag behind committed migrations (push-provisioned
  // with an empty journal). Ensure employee_leaves exists since the assignees
  // route checks for leave conflicts.
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
  await db.execute(
    sql`ALTER TABLE "employee_leaves" DROP CONSTRAINT IF EXISTS "employee_leaves_person_id_people_id_fk"`,
  );
  await db.execute(
    sql`ALTER TABLE "employee_leaves" ADD CONSTRAINT "employee_leaves_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action`,
  );

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

  const [personA, personB, personC] = await db
    .insert(peopleTable)
    .values([
      { name: `A ${TAG}` },
      { name: `B ${TAG}` },
      { name: `C ${TAG}` },
    ])
    .returning();
  personAId = personA.id;
  personBId = personB.id;
  personCId = personC.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      title: `Job ${TAG}`,
      type: "planned_work",
      date: "2025-08-01",
      status: "planned",
      assignedPersonId: personAId,
    })
    .returning();
  jobId = job.id;

  const [jobNoPrimary] = await db
    .insert(jobsTable)
    .values({
      title: `Job no-primary ${TAG}`,
      type: "planned_work",
      date: "2025-08-01",
      status: "planned",
    })
    .returning();
  jobIdNoPrimary = jobNoPrimary.id;

  // personC is on leave for the job's date — used to assert 409 conflicts.
  const [leave] = await db
    .insert(employeeLeavesTable)
    .values({ personId: personCId, type: "vacation", startDate: "2025-08-01", endDate: "2025-08-01" })
    .returning();
  createdLeaveIds.push(leave.id);

  adminAgent = request.agent(app);
  const adminLogin = await adminAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(adminLogin.status).toBe(200);
});

afterAll(async () => {
  if (jobId) await db.delete(jobAssigneesTable).where(eq(jobAssigneesTable.jobId, jobId));
  if (jobIdNoPrimary) await db.delete(jobAssigneesTable).where(eq(jobAssigneesTable.jobId, jobIdNoPrimary));
  if (jobId) await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  if (jobIdNoPrimary) await db.delete(jobsTable).where(eq(jobsTable.id, jobIdNoPrimary));
  if (createdLeaveIds.length)
    await db.delete(employeeLeavesTable).where(inArray(employeeLeavesTable.id, createdLeaveIds));
  await db.delete(peopleTable).where(inArray(peopleTable.id, [personAId, personBId, personCId]));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("PUT /api/jobs/:id/assignees — unauthenticated → 401", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).put(`/api/jobs/${jobId}/assignees`).send({ personIds: [] });
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/jobs/:id/assignees — 404 on missing job", () => {
  it("returns 404 for a non-existent job id", async () => {
    const res = await adminAgent.put("/api/jobs/999999999/assignees").send({ personIds: [] });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/jobs/:id/assignees — validation", () => {
  it("returns 400 when a person id does not exist", async () => {
    const res = await adminAgent.put(`/api/jobs/${jobId}/assignees`).send({ personIds: [999999999] });
    expect(res.status).toBe(400);
  });

  it("returns 409 when a person has a leave conflict on the job's date", async () => {
    const res = await adminAgent.put(`/api/jobs/${jobId}/assignees`).send({ personIds: [personCId] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`C ${TAG}`);
  });
});

describe("PUT /api/jobs/:id/assignees — success paths", () => {
  it("assigns additional workers and returns them enriched on the job", async () => {
    const res = await adminAgent.put(`/api/jobs/${jobId}/assignees`).send({ personIds: [personBId] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([personBId]);
    expect(res.body.assigneeNames).toEqual([`B ${TAG}`]);
  });

  it("silently excludes the primary assignedPersonId from the additional set", async () => {
    const res = await adminAgent
      .put(`/api/jobs/${jobId}/assignees`)
      .send({ personIds: [personAId, personBId] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([personBId]);
  });

  it("dedupes repeated person ids in the payload", async () => {
    const res = await adminAgent
      .put(`/api/jobs/${jobId}/assignees`)
      .send({ personIds: [personBId, personBId] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([personBId]);
  });

  it("fully replaces the assignee set, dropping workers no longer included", async () => {
    // First set B, then replace with none — B should be gone.
    let res = await adminAgent.put(`/api/jobs/${jobId}/assignees`).send({ personIds: [personBId] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([personBId]);

    res = await adminAgent.put(`/api/jobs/${jobId}/assignees`).send({ personIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([]);
    expect(res.body.assigneeNames).toEqual([]);
  });

  it("works on a job with no primary assignedPersonId", async () => {
    const res = await adminAgent
      .put(`/api/jobs/${jobIdNoPrimary}/assignees`)
      .send({ personIds: [personBId] });
    expect(res.status).toBe(200);
    expect(res.body.assigneeIds).toEqual([personBId]);
    expect(res.body.assignedPersonId).toBeNull();
  });
});
