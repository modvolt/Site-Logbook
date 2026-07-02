import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  peopleTable,
  activitiesTable,
  jobsTable,
} from "@workspace/db";
import {
  ListActivityTimeEntriesParams,
  CreateActivityTimeEntryParams,
  CreateActivityTimeEntryBody,
  StartActivityTimeEntryParams,
  StopActivityTimeEntryParams,
  UpdateActivityTimeEntryParams,
  UpdateActivityTimeEntryBody,
  DeleteActivityTimeEntryParams,
  ListJobTimeEntriesParams,
  CreateJobTimeEntryParams,
  CreateJobTimeEntryBody,
  StartJobTimeEntryParams,
  StopJobTimeEntryParams,
  UpdateJobTimeEntryParams,
  UpdateJobTimeEntryBody,
  DeleteJobTimeEntryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

type EntryRow = typeof timeEntriesTable.$inferSelect;

function serialize(e: EntryRow, personName: string) {
  return {
    id: e.id,
    personId: e.personId,
    personName,
    jobId: e.jobId,
    activityId: e.activityId,
    hours: e.hours != null ? Number(e.hours) : 0,
    timerStartedAt: e.timerStartedAt ? e.timerStartedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
}

async function serializeWithPerson(e: EntryRow) {
  const [p] = await db
    .select({ name: peopleTable.name })
    .from(peopleTable)
    .where(eq(peopleTable.id, e.personId));
  return serialize(e, p?.name ?? "—");
}

type Kind = "activity" | "job";

function parentCol(kind: Kind) {
  return kind === "activity" ? timeEntriesTable.activityId : timeEntriesTable.jobId;
}

const conflictTarget = (kind: Kind) =>
  kind === "activity"
    ? [timeEntriesTable.personId, timeEntriesTable.activityId]
    : [timeEntriesTable.personId, timeEntriesTable.jobId];

async function parentExists(kind: Kind, parentId: number): Promise<boolean> {
  if (kind === "activity") {
    const [a] = await db.select({ id: activitiesTable.id }).from(activitiesTable).where(eq(activitiesTable.id, parentId));
    return !!a;
  }
  const [j] = await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, parentId));
  return !!j;
}

const baseValues = (kind: Kind, parentId: number, personId: number) =>
  kind === "activity"
    ? { personId, activityId: parentId }
    : { personId, jobId: parentId };

// LIST
async function list(kind: Kind, parentId: number) {
  const rows = await db
    .select({ entry: timeEntriesTable, name: peopleTable.name })
    .from(timeEntriesTable)
    .innerJoin(peopleTable, eq(timeEntriesTable.personId, peopleTable.id))
    .where(eq(parentCol(kind), parentId))
    .orderBy(peopleTable.name);
  return rows.map((r) => serialize(r.entry, r.name));
}

// CREATE (add person to tracking; optional manual hours)
async function create(kind: Kind, parentId: number, personId: number, hours: number | null | undefined) {
  const [entry] = await db
    .insert(timeEntriesTable)
    .values({ ...baseValues(kind, parentId, personId), hours: hours != null ? String(hours) : "0" })
    .onConflictDoUpdate({
      target: conflictTarget(kind),
      set: hours != null ? { hours: String(hours), updatedAt: new Date() } : { updatedAt: new Date() },
    })
    .returning();
  return serializeWithPerson(entry);
}

// START a person's timer
async function start(kind: Kind, parentId: number, personId: number) {
  const [entry] = await db
    .insert(timeEntriesTable)
    .values({ ...baseValues(kind, parentId, personId), timerStartedAt: new Date() })
    .onConflictDoUpdate({
      target: conflictTarget(kind),
      // Keep existing running timer if any (don't reset accumulated session).
      set: { timerStartedAt: sql`coalesce(${timeEntriesTable.timerStartedAt}, now())`, updatedAt: new Date() },
    })
    .returning();
  return serializeWithPerson(entry);
}

// STOP a person's timer and accumulate hours
async function stop(kind: Kind, parentId: number, personId: number) {
  const [entry] = await db
    .update(timeEntriesTable)
    .set({
      hours: sql`round(
        (coalesce(${timeEntriesTable.hours}, 0)
          + case when ${timeEntriesTable.timerStartedAt} is not null
                 then extract(epoch from (now() - ${timeEntriesTable.timerStartedAt})) / 3600.0
                 else 0 end)::numeric, 2)`,
      timerStartedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(parentCol(kind), parentId), eq(timeEntriesTable.personId, personId)))
    .returning();
  if (!entry) return null;
  return serializeWithPerson(entry);
}

// SET hours manually. If a timer is currently running, rebase it to now() so the
// new manual value becomes the base and the in-flight session is not double-counted
// on the next stop.
async function setHours(kind: Kind, parentId: number, personId: number, hours: number) {
  const [entry] = await db
    .update(timeEntriesTable)
    .set({
      hours: String(hours),
      timerStartedAt: sql`case when ${timeEntriesTable.timerStartedAt} is not null then now() else ${timeEntriesTable.timerStartedAt} end`,
      updatedAt: new Date(),
    })
    .where(and(eq(parentCol(kind), parentId), eq(timeEntriesTable.personId, personId)))
    .returning();
  if (!entry) return null;
  return serializeWithPerson(entry);
}

async function remove(kind: Kind, parentId: number, personId: number) {
  const [entry] = await db
    .delete(timeEntriesTable)
    .where(and(eq(parentCol(kind), parentId), eq(timeEntriesTable.personId, personId)))
    .returning();
  return !!entry;
}

/**
 * After any job time-entry mutation, recompute hours_vasek / hours_jonas /
 * hours_spent on the job from the current time_entries rows and update jobs in
 * one atomic UPDATE. This is the single source of truth — the work-summary
 * fields always reflect the actual recorded hours of every tracked person.
 *
 * Name matching (case-insensitive, handles diacritics variants):
 *   hours_vasek  — person name contains "vašek" or "vasek"
 *   hours_jonas  — person name contains "jonáš" or "jonas"
 *   hours_spent  — sum across all persons
 */
export async function syncJobHoursFromEntries(jobId: number): Promise<void> {
  const rows = await db
    .select({ name: peopleTable.name, hours: timeEntriesTable.hours })
    .from(timeEntriesTable)
    .innerJoin(peopleTable, eq(timeEntriesTable.personId, peopleTable.id))
    .where(eq(timeEntriesTable.jobId, jobId));

  let hoursVasek = 0;
  let hoursJonas = 0;
  let hoursSpent = 0;

  for (const row of rows) {
    const h = Math.round(Number(row.hours) * 100) / 100;
    if (!h) continue;
    hoursSpent += h;
    const nameLower = row.name.toLowerCase();
    if (nameLower.includes("vašek") || nameLower.includes("vasek")) hoursVasek += h;
    if (nameLower.includes("jonáš") || nameLower.includes("jonas")) hoursJonas += h;
  }

  const round2 = (n: number) => String(Math.round(n * 100) / 100);

  await db
    .update(jobsTable)
    .set({
      hoursVasek: hoursVasek > 0 ? round2(hoursVasek) : null,
      hoursJonas: hoursJonas > 0 ? round2(hoursJonas) : null,
      hoursSpent: hoursSpent > 0 ? round2(hoursSpent) : null,
    })
    .where(eq(jobsTable.id, jobId));
}

// ---- Activity routes ----
router.get("/activities/:activityId/time-entries", async (req, res): Promise<void> => {
  const params = ListActivityTimeEntriesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  res.json(await list("activity", params.data.activityId));
});

router.post("/activities/:activityId/time-entries", async (req, res): Promise<void> => {
  const params = CreateActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = CreateActivityTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!(await parentExists("activity", params.data.activityId))) { res.status(404).json({ error: "Activity not found" }); return; }
  res.status(201).json(await create("activity", params.data.activityId, body.data.personId, body.data.hours));
});

router.post("/activities/:activityId/time-entries/:personId/start", async (req, res): Promise<void> => {
  const params = StartActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!(await parentExists("activity", params.data.activityId))) { res.status(404).json({ error: "Activity not found" }); return; }
  res.json(await start("activity", params.data.activityId, params.data.personId));
});

router.post("/activities/:activityId/time-entries/:personId/stop", async (req, res): Promise<void> => {
  const params = StopActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await stop("activity", params.data.activityId, params.data.personId);
  if (!result) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.json(result);
});

router.patch("/activities/:activityId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = UpdateActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateActivityTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await setHours("activity", params.data.activityId, params.data.personId, body.data.hours);
  if (!result) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.json(result);
});

router.delete("/activities/:activityId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = DeleteActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ok = await remove("activity", params.data.activityId, params.data.personId);
  if (!ok) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.sendStatus(204);
});

// ---- Job routes ----
router.get("/jobs/:jobId/time-entries", async (req, res): Promise<void> => {
  const params = ListJobTimeEntriesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  res.json(await list("job", params.data.jobId));
});

router.post("/jobs/:jobId/time-entries", async (req, res): Promise<void> => {
  const params = CreateJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = CreateJobTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!(await parentExists("job", params.data.jobId))) { res.status(404).json({ error: "Job not found" }); return; }
  res.status(201).json(await create("job", params.data.jobId, body.data.personId, body.data.hours));
});

router.post("/jobs/:jobId/time-entries/:personId/start", async (req, res): Promise<void> => {
  const params = StartJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!(await parentExists("job", params.data.jobId))) { res.status(404).json({ error: "Job not found" }); return; }
  const result = await start("job", params.data.jobId, params.data.personId);
  await syncJobHoursFromEntries(params.data.jobId);
  res.json(result);
});

router.post("/jobs/:jobId/time-entries/:personId/stop", async (req, res): Promise<void> => {
  const params = StopJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await stop("job", params.data.jobId, params.data.personId);
  if (!result) { res.status(404).json({ error: "Time entry not found" }); return; }
  await syncJobHoursFromEntries(params.data.jobId);
  res.json(result);
});

router.patch("/jobs/:jobId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = UpdateJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateJobTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await setHours("job", params.data.jobId, params.data.personId, body.data.hours);
  if (!result) { res.status(404).json({ error: "Time entry not found" }); return; }
  await syncJobHoursFromEntries(params.data.jobId);
  res.json(result);
});

router.delete("/jobs/:jobId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = DeleteJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ok = await remove("job", params.data.jobId, params.data.personId);
  if (!ok) { res.status(404).json({ error: "Time entry not found" }); return; }
  await syncJobHoursFromEntries(params.data.jobId);
  res.sendStatus(204);
});

export default router;
