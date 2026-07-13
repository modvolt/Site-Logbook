import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  peopleTable,
  personHourlyRatesTable,
  timeEntriesTable,
  usersTable,
  workSessionsTable,
} from "@workspace/db";
import app from "../src/app";

const TAG = `test-work-sessions-${Date.now()}`;
const PASSWORD = "test-work-session-password";
const userIds: number[] = [];
const personIds: number[] = [];
const jobIds: number[] = [];
let admin: Agent;

async function createPerson(label: string) {
  const [person] = await db.insert(peopleTable).values({ name: `${label} ${TAG}` }).returning();
  personIds.push(person.id);
  return person.id;
}

async function createJob(label: string) {
  const [job] = await db.insert(jobsTable).values({ title: `${label} ${TAG}`, date: "2042-02-03" }).returning();
  jobIds.push(job.id);
  return job.id;
}

async function createLinkedAdmin(label: string, personId: number): Promise<Agent> {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `${label} ${TAG}`,
      personId,
      role: "admin",
      isActive: true,
    })
    .returning();
  userIds.push(user.id);
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: user.username, password: PASSWORD })).status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Work session admin",
      role: "admin",
      isActive: true,
    })
    .returning();
  userIds.push(user.id);
  admin = request.agent(app);
  expect((await admin.post("/api/auth/login").send({ username: user.username, password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  if (personIds.length) {
    await db.delete(workSessionsTable).where(inArray(workSessionsTable.personId, personIds));
    await db.delete(timeEntriesTable).where(inArray(timeEntriesTable.personId, personIds));
    await db.delete(personHourlyRatesTable).where(inArray(personHourlyRatesTable.personId, personIds));
  }
  if (jobIds.length) await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  if (personIds.length) await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("work-session lifecycle", () => {
  it("keeps legacy job timer controls personal for concurrent users", async () => {
    const firstPersonId = await createPerson("Personal timer first");
    const secondPersonId = await createPerson("Personal timer second");
    const firstUser = await createLinkedAdmin("personal-first", firstPersonId);
    const secondUser = await createLinkedAdmin("personal-second", secondPersonId);
    const jobId = await createJob("Shared timer parent");

    const unlinkedStart = await admin.patch(`/api/jobs/${jobId}`).send({ timerStartedAt: new Date().toISOString() });
    expect(unlinkedStart.status).toBe(409);
    expect(unlinkedStart.body.code).toBe("time_person_unlinked");

    const firstStart = await firstUser.patch(`/api/jobs/${jobId}`).send({ timerStartedAt: new Date().toISOString() });
    const secondStart = await secondUser.patch(`/api/jobs/${jobId}`).send({ timerStartedAt: new Date().toISOString() });
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);
    expect(firstStart.body.timerStartedAt).toEqual(expect.any(String));
    expect(secondStart.body.timerStartedAt).toEqual(expect.any(String));

    const activeTogether = await db
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.jobId, jobId), eq(workSessionsTable.status, "active")));
    expect(activeTogether).toHaveLength(2);
    expect(new Set(activeTogether.map((session) => session.personId))).toEqual(new Set([firstPersonId, secondPersonId]));

    expect((await firstUser.patch(`/api/jobs/${jobId}`).send({ timerStartedAt: null })).status).toBe(200);
    expect((await firstUser.get(`/api/jobs/${jobId}`)).body.timerStartedAt).toBeNull();
    expect((await secondUser.get(`/api/jobs/${jobId}`)).body.timerStartedAt).toEqual(expect.any(String));

    const secondStillActive = await db
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.jobId, jobId), eq(workSessionsTable.status, "active")));
    expect(secondStillActive).toHaveLength(1);
    expect(secondStillActive[0].personId).toBe(secondPersonId);
    expect((await secondUser.patch(`/api/jobs/${jobId}`).send({ timerStartedAt: null })).status).toBe(200);
  });

  it("keeps repeated Start idempotent and rejects another active parent", async () => {
    const personId = await createPerson("Single active");
    const firstJob = await createJob("First parent");
    const secondJob = await createJob("Second parent");

    const first = await admin
      .post(`/api/jobs/${firstJob}/time-entries/${personId}/start`)
      .set("Idempotency-Key", `${TAG}-start-1`);
    expect(first.status).toBe(200);
    const repeated = await admin.post(`/api/jobs/${firstJob}/time-entries/${personId}/start`);
    expect(repeated.status).toBe(200);
    expect(repeated.body.timerStartedAt).toBe(first.body.timerStartedAt);

    const conflict = await admin.post(`/api/jobs/${secondJob}/time-entries/${personId}/start`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.activeSession.jobId).toBe(firstJob);

    const active = await db
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.personId, personId), eq(workSessionsTable.status, "active")));
    expect(active).toHaveLength(1);
    await admin
      .post(`/api/jobs/${firstJob}/time-entries/${personId}/stop`)
      .set("Idempotency-Key", `${TAG}-stop-1`);

    await admin
      .post(`/api/jobs/${secondJob}/time-entries/${personId}/start`)
      .set("Idempotency-Key", `${TAG}-start-other`);
    expect(
      (
        await admin
          .post(`/api/jobs/${firstJob}/time-entries/${personId}/start`)
          .set("Idempotency-Key", `${TAG}-start-1`)
      ).status,
    ).toBe(200);
    const [stillOther] = await db
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.personId, personId), eq(workSessionsTable.status, "active")));
    expect(stillOther.jobId).toBe(secondJob);
    await admin
      .post(`/api/jobs/${secondJob}/time-entries/${personId}/stop`)
      .set("Idempotency-Key", `${TAG}-stop-other`);

    await admin
      .post(`/api/jobs/${firstJob}/time-entries/${personId}/start`)
      .set("Idempotency-Key", `${TAG}-start-2`);
    await admin
      .post(`/api/jobs/${firstJob}/time-entries/${personId}/stop`)
      .set("Idempotency-Key", `${TAG}-stop-1`);
    expect(
      await db
        .select()
        .from(workSessionsTable)
        .where(and(eq(workSessionsTable.personId, personId), eq(workSessionsTable.status, "active"))),
    ).toHaveLength(1);
    await admin
      .post(`/api/jobs/${firstJob}/time-entries/${personId}/stop`)
      .set("Idempotency-Key", `${TAG}-stop-2`);
  });

  it("stores an exact completed interval and projects rounded hours", async () => {
    const personId = await createPerson("Exact interval");
    const jobId = await createJob("Three hours");
    expect((await admin.post(`/api/jobs/${jobId}/time-entries/${personId}/start`)).status).toBe(200);

    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const [session] = await db
      .update(workSessionsTable)
      .set({ startedAt })
      .where(and(eq(workSessionsTable.personId, personId), eq(workSessionsTable.status, "active")))
      .returning();
    expect(session).toBeTruthy();

    const stopped = await admin.post(`/api/jobs/${jobId}/time-entries/${personId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.hours).toBeCloseTo(3, 2);
    const [completed] = await db.select().from(workSessionsTable).where(eq(workSessionsTable.id, session.id));
    expect(completed.status).toBe("completed");
    expect(completed.durationSeconds).toBeGreaterThanOrEqual(10_799);
    expect(completed.durationSeconds).toBeLessThanOrEqual(10_801);
  });

  it("adds concurrent workers as person-hours instead of timeline duration", async () => {
    const firstPersonId = await createPerson("Concurrent first");
    const secondPersonId = await createPerson("Concurrent second");
    const jobId = await createJob("Six person hours");

    expect((await admin.post(`/api/jobs/${jobId}/time-entries/${firstPersonId}/start`)).status).toBe(200);
    expect((await admin.post(`/api/jobs/${jobId}/time-entries/${secondPersonId}/start`)).status).toBe(200);
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db
      .update(workSessionsTable)
      .set({ startedAt })
      .where(
        and(
          inArray(workSessionsTable.personId, [firstPersonId, secondPersonId]),
          eq(workSessionsTable.status, "active"),
        ),
      );

    expect((await admin.post(`/api/jobs/${jobId}/time-entries/${firstPersonId}/stop`)).status).toBe(200);
    expect((await admin.post(`/api/jobs/${jobId}/time-entries/${secondPersonId}/stop`)).status).toBe(200);

    const summary = await admin.get(`/api/jobs/${jobId}/work-summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.workerCount).toBe(2);
    expect(summary.body.totalHours).toBeCloseTo(6, 2);
    expect(summary.body.workers).toHaveLength(2);
    expect(summary.body.workers[0].totalHours).toBeCloseTo(3, 2);
    expect(summary.body.workers[1].totalHours).toBeCloseTo(3, 2);

    const [job] = await db.select({ hoursSpent: jobsTable.hoursSpent }).from(jobsTable).where(eq(jobsTable.id, jobId));
    expect(Number(job.hoursSpent)).toBeCloseTo(6, 2);
  });

  it("records manual total changes as immutable positive and negative corrections", async () => {
    const personId = await createPerson("Corrections");
    const jobId = await createJob("Correction history");
    await admin.post(`/api/jobs/${jobId}/time-entries`).send({ personId });

    expect((await admin.patch(`/api/jobs/${jobId}/time-entries/${personId}`).send({ hours: 5, reason: "Doplnění výkazu" })).status).toBe(200);
    const second = await admin.patch(`/api/jobs/${jobId}/time-entries/${personId}`).send({ hours: 2, reason: "Oprava chybného součtu" });
    expect(second.status).toBe(200);
    expect(second.body.hours).toBe(2);

    const corrections = await db
      .select()
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, personId),
          eq(workSessionsTable.jobId, jobId),
          eq(workSessionsTable.source, "correction"),
        ),
      );
    expect(corrections.sort((a, b) => a.id - b.id).map((row) => row.durationSeconds)).toEqual([18_000, -10_800]);
  });

  it("rejects overlapping manual sessions and voids history instead of deleting it", async () => {
    const personId = await createPerson("Manual history");
    const jobId = await createJob("Manual intervals");
    const first = {
      personId,
      startedAt: "2042-02-03T08:00:00.000Z",
      endedAt: "2042-02-03T11:00:00.000Z",
      note: "Ruční doplnění",
      idempotencyKey: `${TAG}-manual-1`,
    };
    const created = await admin.post(`/api/jobs/${jobId}/work-sessions`).send(first);
    expect(created.status).toBe(201);
    expect((await admin.post(`/api/jobs/${jobId}/work-sessions`).send(first)).status).toBe(201);

    const overlap = await admin.post(`/api/jobs/${jobId}/work-sessions`).send({
      personId,
      startedAt: "2042-02-03T10:00:00.000Z",
      endedAt: "2042-02-03T12:00:00.000Z",
      note: "Překrývající se interval",
    });
    expect(overlap.status).toBe(409);

    expect((await admin.delete(`/api/jobs/${jobId}/time-entries/${personId}`)).status).toBe(204);
    const [preserved] = await db.select().from(workSessionsTable).where(eq(workSessionsTable.id, created.body.id));
    expect(preserved.status).toBe("voided");
    expect(preserved.voidedAt).toBeInstanceOf(Date);
  });

  it("preserves a long session and marks it for review instead of truncating it", async () => {
    const personId = await createPerson("Long session");
    const jobId = await createJob("Review duration");
    const response = await admin.post(`/api/jobs/${jobId}/work-sessions`).send({
      personId,
      startedAt: "2042-02-04T06:00:00.000Z",
      endedAt: "2042-02-04T19:00:00.000Z",
      note: "Dlouhá směna k ověření",
    });
    expect(response.status).toBe(201);
    expect(response.body.durationSeconds).toBe(46_800);
    expect(response.body.reviewStatus).toBe("needs_review");
  });

  it("snapshots the effective rates without repricing older work", async () => {
    const personId = await createPerson("Historical rates");
    const jobId = await createJob("Rate snapshots");
    expect((await admin.post(`/api/people/${personId}/hourly-rates`).send({
      validFrom: "2042-01-01",
      costRate: 500,
      saleRate: 700,
      reason: "Výchozí sazba",
    })).status).toBe(201);
    const january = await admin.post(`/api/jobs/${jobId}/work-sessions`).send({
      personId,
      startedAt: "2042-01-15T08:00:00.000Z",
      endedAt: "2042-01-15T11:00:00.000Z",
      note: "Lednová práce",
    });
    expect(january.status).toBe(201);

    expect((await admin.post(`/api/people/${personId}/hourly-rates`).send({
      validFrom: "2042-02-01",
      costRate: 600,
      saleRate: 800,
      reason: "Zvýšení od února",
    })).status).toBe(201);
    const february = await admin.post(`/api/jobs/${jobId}/work-sessions`).send({
      personId,
      startedAt: "2042-02-15T08:00:00.000Z",
      endedAt: "2042-02-15T11:00:00.000Z",
      note: "Únorová práce",
    });
    expect(february.status).toBe(201);

    const snapshots = await db
      .select({ id: workSessionsTable.id, cost: workSessionsTable.costRateSnapshot, sale: workSessionsTable.saleRateSnapshot })
      .from(workSessionsTable)
      .where(inArray(workSessionsTable.id, [january.body.id, february.body.id]));
    const byId = new Map(snapshots.map((row) => [row.id, row]));
    expect(Number(byId.get(january.body.id)?.cost)).toBe(500);
    expect(Number(byId.get(january.body.id)?.sale)).toBe(700);
    expect(Number(byId.get(february.body.id)?.cost)).toBe(600);
    expect(Number(byId.get(february.body.id)?.sale)).toBe(800);
  });
});
