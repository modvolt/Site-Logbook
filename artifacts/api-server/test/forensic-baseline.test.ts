import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  peopleTable,
  timeEntriesTable,
  usersTable,
  userPermissionOverridesTable,
} from "@workspace/db";
import app from "../src/app";

/**
 * Forensic baseline for the staged permissions/time-accounting rebuild.
 *
 * These tests freeze only behavior that is safe and intentional today. Known
 * security and lifecycle gaps are listed as todo tests, so later stages can
 * implement them without first having to delete assertions that bless a bug.
 */

const TAG = `test-forensic-baseline-${Date.now()}`;
const PASSWORD = "test-forensic-password-123";

const userIds: number[] = [];
const userIdByRole = new Map<string, number>();
const personIds: number[] = [];
const jobIds: number[] = [];

let admin: Agent;
let master: Agent;
let guest: Agent;

async function createUser(role: "guest" | "master" | "admin"): Promise<Agent> {
  const username = `${TAG}-${role}`;
  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `Forensic ${role}`,
      role,
      isActive: true,
    })
    .returning();
  userIds.push(user.id);
  userIdByRole.set(role, user.id);

  const agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username, password: PASSWORD });
  expect(login.status).toBe(200);
  return agent;
}

async function createPerson(label: string): Promise<number> {
  const [person] = await db
    .insert(peopleTable)
    .values({ name: `${label} ${TAG}` })
    .returning();
  personIds.push(person.id);
  return person.id;
}

async function createJob(label: string): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({ title: `${label} ${TAG}`, date: "2041-01-15" })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

beforeAll(async () => {
  admin = await createUser("admin");
  master = await createUser("master");
  guest = await createUser("guest");
});

afterAll(async () => {
  if (personIds.length) {
    await db.delete(timeEntriesTable).where(inArray(timeEntriesTable.personId, personIds));
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  if (personIds.length) {
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  }
  if (userIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
});

describe("forensic baseline - role boundaries", () => {
  it("requires authentication for billing data", async () => {
    const response = await request(app).get("/api/billing/summary");
    expect(response.status).toBe(401);
  });

  it("keeps billing data admin-only on the backend", async () => {
    expect((await guest.get("/api/billing/summary")).status).toBe(403);
    expect((await master.get("/api/billing/summary")).status).toBe(403);
    expect((await admin.get("/api/billing/summary")).status).toBe(200);
  });

  it("allows guest reads but rejects guest writes in operational modules", async () => {
    expect((await guest.get("/api/jobs")).status).toBe(200);
    expect(
      (
        await guest.post("/api/jobs").send({
          title: `${TAG}-forbidden-job`,
          date: "2041-01-15",
        })
      ).status,
    ).toBe(403);
  });
});

describe("forensic baseline - person-hour aggregation", () => {
  it("counts two people working three hours concurrently as six person-hours", async () => {
    const jobId = await createJob("Concurrent work");
    const personA = await createPerson("Worker A");
    const personB = await createPerson("Worker B");

    expect(
      (await admin.post(`/api/jobs/${jobId}/time-entries`).send({ personId: personA })).status,
    ).toBe(201);
    expect(
      (await admin.post(`/api/jobs/${jobId}/time-entries`).send({ personId: personB })).status,
    ).toBe(201);

    expect(
      (
        await admin
          .patch(`/api/jobs/${jobId}/time-entries/${personA}`)
          .send({ hours: 3, reason: "Kontrolní součet člověkohodin" })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin
          .patch(`/api/jobs/${jobId}/time-entries/${personB}`)
          .send({ hours: 3, reason: "Kontrolní součet člověkohodin" })
      ).status,
    ).toBe(200);

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(Number(job.hoursSpent)).toBe(6);

    const entries = await admin.get(`/api/jobs/${jobId}/time-entries`);
    expect(entries.status).toBe(200);
    expect(entries.body).toHaveLength(2);
    expect(
      entries.body.reduce(
        (sum: number, entry: { hours: number }) => sum + entry.hours,
        0,
      ),
    ).toBe(6);
  });

  it("does not reset an already-running timer on a repeated Start", async () => {
    const jobId = await createJob("Repeated start");
    const personId = await createPerson("Worker Start");

    const first = await admin.post(`/api/jobs/${jobId}/time-entries/${personId}/start`);
    expect(first.status).toBe(200);
    expect(first.body.timerStartedAt).toEqual(expect.any(String));

    const second = await admin.post(`/api/jobs/${jobId}/time-entries/${personId}/start`);
    expect(second.status).toBe(200);
    expect(second.body.timerStartedAt).toBe(first.body.timerStartedAt);
  });
});

describe("staged acceptance tests not implemented in phase 1", () => {
  it("applies permission allow and deny overrides to already active sessions", async () => {
    const masterId = userIdByRole.get("master")!;
    const adminId = userIdByRole.get("admin")!;

    expect((await master.get("/api/stats/overview")).status).toBe(403);
    expect(
      (
        await admin.put(`/api/users/${masterId}/permissions`).send({
          overrides: [{ permission: "statistics.view", effect: "allow" }],
        })
      ).status,
    ).toBe(200);
    expect((await master.get("/api/stats/overview")).status).not.toBe(403);

    expect(
      (
        await admin.put(`/api/users/${adminId}/permissions`).send({
          overrides: [{ permission: "billing.view", effect: "deny" }],
        })
      ).status,
    ).toBe(200);
    expect((await admin.get("/api/billing/summary")).status).toBe(403);

    await db
      .delete(userPermissionOverridesTable)
      .where(inArray(userPermissionOverridesTable.userId, [masterId, adminId]));
  });

  it("allows an individual guest to manage jobs without changing the role", async () => {
    const guestId = userIdByRole.get("guest")!;
    expect(
      (
        await admin.put(`/api/users/${guestId}/permissions`).send({
          overrides: [{ permission: "jobs.manage", effect: "allow" }],
        })
      ).status,
    ).toBe(200);
    const created = await guest.post("/api/jobs").send({ title: `${TAG}-guest-job`, date: "2041-01-15" });
    expect(created.status).toBe(201);
    jobIds.push(created.body.id);
  });

  it("prevents a permission administrator from denying their own management access", async () => {
    const adminId = userIdByRole.get("admin")!;
    const response = await admin.put(`/api/users/${adminId}/permissions`).send({
      overrides: [{ permission: "users.manage", effect: "deny" }],
    });
    expect(response.status).toBe(400);
  });

  it.todo("prevents the last permission administrator from being removed or disabled");
  it.todo("stores each work interval and correction as immutable audited history");
  it.todo("hides cost and sale rates from API callers without financial permissions");
  it.todo("serves cost-document objects only after an entity permission check");
});
