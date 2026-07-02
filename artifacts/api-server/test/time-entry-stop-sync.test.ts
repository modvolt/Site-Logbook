import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  usersTable,
  peopleTable,
  jobsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../src/app";

/**
 * Guards the three-hop sync chain from stopping a job timer to the job's
 * "Souhrn práce" (work-summary) fields:
 *
 *   1. POST /jobs/:jobId/time-entries/:personId/stop accumulates hours and
 *      clears timer_started_at on the time_entries row.
 *   2. syncJobHoursFromEntries recomputes hours_vasek / hours_jonas /
 *      hours_spent on the job from ALL current time_entries rows.
 *   3. The stop response reflects the just-stopped entry (client refetches
 *      the job to see the aggregated summary).
 *
 * Covers: name matching for Vašek/Jonáš (diacritics + ascii variants,
 * case-insensitive), multi-person totalling, and the entries-all-removed
 * case where the summary fields must reset to null (not 0 or stale values).
 */

const TAG = `test-tes-${Date.now()}`;
const PASSWORD = "test-password-123";

let userId: number;
let vasekId: number;
let jonasId: number;
let otherId: number;
let agent: Agent;

async function makePerson(name: string): Promise<number> {
  const [p] = await db.insert(peopleTable).values({ name }).returning();
  return p.id;
}

async function makeJob(): Promise<number> {
  const [j] = await db
    .insert(jobsTable)
    .values({ title: `Job ${TAG}`, date: "2026-07-02" })
    .returning();
  return j.id;
}

async function getJob(jobId: number) {
  const [j] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  return j;
}

/** Start a timer directly in the DB, backdated so stop() accumulates a known duration. */
async function startBackdated(jobId: number, personId: number, hoursAgo: number, baseHours = 0) {
  const startedAt = new Date(Date.now() - hoursAgo * 3600 * 1000);
  await db
    .insert(timeEntriesTable)
    .values({ personId, jobId, hours: String(baseHours), timerStartedAt: startedAt })
    .onConflictDoUpdate({
      target: [timeEntriesTable.personId, timeEntriesTable.jobId],
      set: { hours: String(baseHours), timerStartedAt: startedAt, updatedAt: new Date() },
    });
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Test Runner Timer Sync",
      role: "admin",
      isActive: true,
    })
    .returning();
  userId = user.id;

  vasekId = await makePerson(`Vašek ${TAG}`);
  jonasId = await makePerson(`Jonáš ${TAG}`);
  otherId = await makePerson(`Petr ${TAG}`);

  agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TAG}-user`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  const ids = [vasekId, jonasId, otherId].filter(Boolean);
  for (const id of ids) {
    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.personId, id));
  }
  await db.delete(peopleTable).where(eq(peopleTable.id, vasekId));
  await db.delete(peopleTable).where(eq(peopleTable.id, jonasId));
  await db.delete(peopleTable).where(eq(peopleTable.id, otherId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("stop timer -> Souhrn práce sync", () => {
  it("stopping Vašek's timer updates hours_vasek and hours_spent on the job", async () => {
    const jobId = await makeJob();
    await startBackdated(jobId, vasekId, 2); // ~2h running

    const res = await agent.post(`/api/jobs/${jobId}/time-entries/${vasekId}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.timerStartedAt).toBeNull();
    expect(res.body.hours).toBeCloseTo(2, 1);

    const job = await getJob(jobId);
    expect(Number(job.hoursVasek)).toBeCloseTo(2, 1);
    expect(job.hoursJonas).toBeNull();
    expect(Number(job.hoursSpent)).toBeCloseTo(2, 1);

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.jobId, jobId));
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });

  it("matches ascii 'Jonas' (no diacritics) into hours_jonas", async () => {
    const jobId = await makeJob();
    const asciiJonasId = await makePerson(`Jonas Novak ${TAG}`);
    await startBackdated(jobId, asciiJonasId, 1);

    const res = await agent.post(`/api/jobs/${jobId}/time-entries/${asciiJonasId}/stop`);
    expect(res.status).toBe(200);

    const job = await getJob(jobId);
    expect(Number(job.hoursJonas)).toBeCloseTo(1, 1);
    expect(job.hoursVasek).toBeNull();

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.jobId, jobId));
    await db.delete(peopleTable).where(eq(peopleTable.id, asciiJonasId));
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });

  it("totals hours across multiple people into hours_spent", async () => {
    const jobId = await makeJob();
    await startBackdated(jobId, vasekId, 1.5);
    await startBackdated(jobId, jonasId, 0.5);
    await startBackdated(jobId, otherId, 1);

    await agent.post(`/api/jobs/${jobId}/time-entries/${vasekId}/stop`);
    await agent.post(`/api/jobs/${jobId}/time-entries/${jonasId}/stop`);
    const stopOther = await agent.post(`/api/jobs/${jobId}/time-entries/${otherId}/stop`);
    expect(stopOther.status).toBe(200);

    const job = await getJob(jobId);
    expect(Number(job.hoursVasek)).toBeCloseTo(1.5, 1);
    expect(Number(job.hoursJonas)).toBeCloseTo(0.5, 1);
    expect(Number(job.hoursSpent)).toBeCloseTo(3, 1);

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.jobId, jobId));
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });

  it("resets hours_vasek/hours_jonas/hours_spent to null when all entries are removed", async () => {
    const jobId = await makeJob();
    await startBackdated(jobId, vasekId, 1);
    const stopRes = await agent.post(`/api/jobs/${jobId}/time-entries/${vasekId}/stop`);
    expect(stopRes.status).toBe(200);

    let job = await getJob(jobId);
    expect(Number(job.hoursVasek)).toBeCloseTo(1, 1);

    const delRes = await agent.delete(`/api/jobs/${jobId}/time-entries/${vasekId}`);
    expect(delRes.status).toBe(204);

    job = await getJob(jobId);
    expect(job.hoursVasek).toBeNull();
    expect(job.hoursJonas).toBeNull();
    expect(job.hoursSpent).toBeNull();

    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });

  it("returns 404 (and never touches summary fields) when stopping an entry that doesn't exist", async () => {
    const jobId = await makeJob();
    const res = await agent.post(`/api/jobs/${jobId}/time-entries/${otherId}/stop`);
    expect(res.status).toBe(404);

    const job = await getJob(jobId);
    expect(job.hoursSpent).toBeNull();

    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });

  it("keeps a person's still-running timer out of the summary until it is stopped", async () => {
    const jobId = await makeJob();
    // Start (not stop) — an in-progress timer has hours=0 accumulated so far.
    await agent.post(`/api/jobs/${jobId}/time-entries/${vasekId}/start`);

    const job = await getJob(jobId);
    expect(job.hoursVasek).toBeNull();
    expect(job.hoursSpent).toBeNull();

    await db.delete(timeEntriesTable).where(and(eq(timeEntriesTable.jobId, jobId), eq(timeEntriesTable.personId, vasekId)));
    await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  });
});
