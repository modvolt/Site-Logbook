import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod/v4";
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
import {
  ActiveWorkSessionConflict,
  WorkSessionOverlapError,
  WorkSessionIdempotencyConflict,
  addManualWorkSession,
  ensureWorkTracking,
  getWorkSummary,
  listWorkSessions,
  removeTimeTracking,
  setManualWorkTotal,
  startWorkSession,
  stopWorkSession,
  voidWorkSession,
  type WorkKind,
} from "../lib/work-session-service";
import { isRestrictedFieldWorker, requireAssignedJobView, requireOwnJobTimer } from "../middlewares/job-work-access";

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

type Kind = WorkKind;

function parentCol(kind: Kind) {
  return kind === "activity" ? timeEntriesTable.activityId : timeEntriesTable.jobId;
}

async function parentExists(kind: Kind, parentId: number): Promise<boolean> {
  if (kind === "activity") {
    const [a] = await db.select({ id: activitiesTable.id }).from(activitiesTable).where(eq(activitiesTable.id, parentId));
    return !!a;
  }
  const [j] = await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, parentId));
  return !!j;
}

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
async function create(kind: Kind, parentId: number, personId: number, hours: number | null | undefined, actorUserId: number) {
  const entry = hours != null
    ? await setManualWorkTotal(kind, parentId, personId, hours, actorUserId)
    : await ensureWorkTracking(kind, parentId, personId);
  return serializeWithPerson(entry);
}

// START a person's timer
async function start(kind: Kind, parentId: number, personId: number, actorUserId: number, idempotencyKey?: string) {
  const entry = await startWorkSession(kind, parentId, personId, actorUserId, idempotencyKey);
  return serializeWithPerson(entry);
}

// STOP a person's timer and accumulate hours
async function stop(kind: Kind, parentId: number, personId: number, actorUserId: number, idempotencyKey?: string) {
  const entry = await stopWorkSession(kind, parentId, personId, actorUserId, idempotencyKey);
  return serializeWithPerson(entry);
}

// SET hours manually. If a timer is currently running, rebase it to now() so the
// new manual value becomes the base and the in-flight session is not double-counted
// on the next stop.
async function setHours(kind: Kind, parentId: number, personId: number, hours: number, actorUserId: number, reason: string) {
  const entry = await setManualWorkTotal(kind, parentId, personId, hours, actorUserId, reason);
  return serializeWithPerson(entry);
}

async function remove(kind: Kind, parentId: number, personId: number, actorUserId: number) {
  return removeTimeTracking(kind, parentId, personId, actorUserId);
}

const ManualWorkSessionBody = z.object({
  personId: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  note: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

function requestIdempotencyKey(req: import("express").Request): string | undefined {
  const raw = req.header("Idempotency-Key");
  if (!raw) return undefined;
  const value = raw.trim();
  return value.length >= 8 && value.length <= 100 ? value : undefined;
}

function handleWorkSessionError(error: unknown, res: import("express").Response): boolean {
  if (error instanceof ActiveWorkSessionConflict) {
    res.status(409).json({
      error: error.message,
      activeSession: {
        id: error.active.id,
        jobId: error.active.jobId,
        activityId: error.active.activityId,
        startedAt: error.active.startedAt.toISOString(),
      },
    });
    return true;
  }
  if (error instanceof WorkSessionOverlapError || error instanceof WorkSessionIdempotencyConflict) {
    res.status(409).json({ error: error.message });
    return true;
  }
  return false;
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
  res.status(201).json(await create("activity", params.data.activityId, body.data.personId, body.data.hours, req.auth!.userId));
});

router.post("/activities/:activityId/time-entries/:personId/start", async (req, res): Promise<void> => {
  const params = StartActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!(await parentExists("activity", params.data.activityId))) { res.status(404).json({ error: "Activity not found" }); return; }
  try {
    res.json(await start("activity", params.data.activityId, params.data.personId, req.auth!.userId, requestIdempotencyKey(req)));
  } catch (error) {
    if (!handleWorkSessionError(error, res)) throw error;
  }
});

router.post("/activities/:activityId/time-entries/:personId/stop", async (req, res): Promise<void> => {
  const params = StopActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const result = await stop("activity", params.data.activityId, params.data.personId, req.auth!.userId, requestIdempotencyKey(req));
    res.json(result);
  } catch (error) {
    if (!handleWorkSessionError(error, res)) throw error;
  }
});

router.patch("/activities/:activityId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = UpdateActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateActivityTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await setHours("activity", params.data.activityId, params.data.personId, body.data.hours, req.auth!.userId, body.data.reason);
  res.json(result);
});

router.delete("/activities/:activityId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = DeleteActivityTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ok = await remove("activity", params.data.activityId, params.data.personId, req.auth!.userId);
  if (!ok) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.sendStatus(204);
});

// ---- Job routes ----
router.get("/jobs/:jobId/time-entries", requireAssignedJobView, async (req, res): Promise<void> => {
  const params = ListJobTimeEntriesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const entries = await list("job", params.data.jobId);
  res.json(isRestrictedFieldWorker(req.auth!.permissions)
    ? entries.filter((entry) => entry.personId === req.auth!.personId)
    : entries);
});

router.post("/jobs/:jobId/time-entries", async (req, res): Promise<void> => {
  const params = CreateJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = CreateJobTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!(await parentExists("job", params.data.jobId))) { res.status(404).json({ error: "Job not found" }); return; }
  res.status(201).json(await create("job", params.data.jobId, body.data.personId, body.data.hours, req.auth!.userId));
});

router.post("/jobs/:jobId/time-entries/:personId/start", requireOwnJobTimer, async (req, res): Promise<void> => {
  const params = StartJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!(await parentExists("job", params.data.jobId))) { res.status(404).json({ error: "Job not found" }); return; }
  try {
    const result = await start("job", params.data.jobId, params.data.personId, req.auth!.userId, requestIdempotencyKey(req));
    await syncJobHoursFromEntries(params.data.jobId);
    res.json(result);
  } catch (error) {
    if (!handleWorkSessionError(error, res)) throw error;
  }
});

router.post("/jobs/:jobId/time-entries/:personId/stop", requireOwnJobTimer, async (req, res): Promise<void> => {
  const params = StopJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const result = await stop("job", params.data.jobId, params.data.personId, req.auth!.userId, requestIdempotencyKey(req));
    await syncJobHoursFromEntries(params.data.jobId);
    res.json(result);
  } catch (error) {
    if (!handleWorkSessionError(error, res)) throw error;
  }
});

router.patch("/jobs/:jobId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = UpdateJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateJobTimeEntryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await setHours("job", params.data.jobId, params.data.personId, body.data.hours, req.auth!.userId, body.data.reason);
  await syncJobHoursFromEntries(params.data.jobId);
  res.json(result);
});

router.delete("/jobs/:jobId/time-entries/:personId", async (req, res): Promise<void> => {
  const params = DeleteJobTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ok = await remove("job", params.data.jobId, params.data.personId, req.auth!.userId);
  if (!ok) { res.status(404).json({ error: "Time entry not found" }); return; }
  await syncJobHoursFromEntries(params.data.jobId);
  res.sendStatus(204);
});

async function listSessionsRoute(kind: Kind, parentId: number, req: import("express").Request, res: import("express").Response) {
  const fieldPersonId = kind === "job" && isRestrictedFieldWorker(req.auth!.permissions)
    ? req.auth!.personId ?? undefined
    : undefined;
  const rawPersonId = fieldPersonId ?? (typeof req.query.personId === "string" ? Number(req.query.personId) : undefined);
  if (rawPersonId !== undefined && (!Number.isInteger(rawPersonId) || rawPersonId <= 0)) {
    res.status(400).json({ error: "Neplatné personId" });
    return;
  }
  res.json(await listWorkSessions(kind, parentId, rawPersonId));
}

async function createManualSessionRoute(kind: Kind, parentId: number, req: import("express").Request, res: import("express").Response) {
  const parsed = ManualWorkSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const startedAt = new Date(parsed.data.startedAt);
  const endedAt = new Date(parsed.data.endedAt);
  const seconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (seconds <= 0 || seconds > 7 * 24 * 60 * 60) {
    res.status(400).json({ error: "Konec musí být po začátku a interval nesmí být delší než 7 dní." });
    return;
  }
  try {
    const session = await addManualWorkSession({
      kind,
      parentId,
      personId: parsed.data.personId,
      startedAt,
      endedAt,
      note: parsed.data.note,
      actorUserId: req.auth!.userId,
      idempotencyKey: parsed.data.idempotencyKey ?? requestIdempotencyKey(req),
    });
    if (kind === "job") await syncJobHoursFromEntries(parentId);
    res.status(201).json({
      ...session,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      voidedAt: session.voidedAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    });
  } catch (error) {
    if (!handleWorkSessionError(error, res)) throw error;
  }
}

router.get("/activities/:activityId/work-sessions", async (req, res): Promise<void> => {
  const parentId = Number(req.params.activityId);
  if (!Number.isInteger(parentId) || parentId <= 0) { res.status(400).json({ error: "Neplatné ID akce" }); return; }
  await listSessionsRoute("activity", parentId, req, res);
});

router.get("/activities/:activityId/work-summary", async (req, res): Promise<void> => {
  const parentId = Number(req.params.activityId);
  if (!Number.isInteger(parentId) || parentId <= 0) { res.status(400).json({ error: "Neplatné ID akce" }); return; }
  if (!(await parentExists("activity", parentId))) { res.status(404).json({ error: "Activity not found" }); return; }
  res.json(await getWorkSummary("activity", parentId));
});

router.post("/activities/:activityId/work-sessions", async (req, res): Promise<void> => {
  const parentId = Number(req.params.activityId);
  if (!Number.isInteger(parentId) || parentId <= 0 || !(await parentExists("activity", parentId))) { res.status(404).json({ error: "Activity not found" }); return; }
  await createManualSessionRoute("activity", parentId, req, res);
});

router.delete("/activities/:activityId/work-sessions/:sessionId", async (req, res): Promise<void> => {
  const parentId = Number(req.params.activityId);
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(parentId) || !Number.isInteger(sessionId)) { res.status(400).json({ error: "Neplatné ID" }); return; }
  const ok = await voidWorkSession("activity", parentId, sessionId, req.auth!.userId);
  if (!ok) { res.status(404).json({ error: "Work session not found" }); return; }
  res.sendStatus(204);
});

router.get("/jobs/:jobId/work-sessions", requireAssignedJobView, async (req, res): Promise<void> => {
  const parentId = Number(req.params.jobId);
  if (!Number.isInteger(parentId) || parentId <= 0) { res.status(400).json({ error: "Neplatné ID zakázky" }); return; }
  await listSessionsRoute("job", parentId, req, res);
});

router.get("/jobs/:jobId/work-summary", requireAssignedJobView, async (req, res): Promise<void> => {
  const parentId = Number(req.params.jobId);
  if (!Number.isInteger(parentId) || parentId <= 0) { res.status(400).json({ error: "Neplatné ID zakázky" }); return; }
  if (!(await parentExists("job", parentId))) { res.status(404).json({ error: "Job not found" }); return; }
  const personId = isRestrictedFieldWorker(req.auth!.permissions) ? req.auth!.personId ?? undefined : undefined;
  res.json(await getWorkSummary("job", parentId, personId));
});

router.post("/jobs/:jobId/work-sessions", async (req, res): Promise<void> => {
  const parentId = Number(req.params.jobId);
  if (!Number.isInteger(parentId) || parentId <= 0 || !(await parentExists("job", parentId))) { res.status(404).json({ error: "Job not found" }); return; }
  await createManualSessionRoute("job", parentId, req, res);
});

router.delete("/jobs/:jobId/work-sessions/:sessionId", async (req, res): Promise<void> => {
  const parentId = Number(req.params.jobId);
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(parentId) || !Number.isInteger(sessionId)) { res.status(400).json({ error: "Neplatné ID" }); return; }
  const ok = await voidWorkSession("job", parentId, sessionId, req.auth!.userId);
  if (!ok) { res.status(404).json({ error: "Work session not found" }); return; }
  await syncJobHoursFromEntries(parentId);
  res.sendStatus(204);
});

export default router;
