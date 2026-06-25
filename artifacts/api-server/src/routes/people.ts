import { Router, type IRouter } from "express";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, peopleTable, jobsTable, timeEntriesTable, machinesTable } from "@workspace/db";
import {
  CreatePersonBody,
  UpdatePersonParams,
  UpdatePersonBody,
  DeletePersonParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializePerson(p: typeof peopleTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
  };
}

router.get("/people", async (_req, res): Promise<void> => {
  const people = await db.select().from(peopleTable).orderBy(peopleTable.name);
  res.json(people.map(serializePerson));
});

router.get("/people/stats", async (_req, res): Promise<void> => {
  const allPeople = await db.select().from(peopleTable).orderBy(peopleTable.name);

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Monday of current ISO week
  const weekStart = new Date(today);
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
  weekStart.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  weekStart.setHours(0, 0, 0, 0);

  const [todayJobs, weekHoursRows, machineRows, activeTimerRows] = await Promise.all([
    db
      .select({ personId: jobsTable.assignedPersonId })
      .from(jobsTable)
      .where(and(sql`${jobsTable.date}::date = ${todayStr}::date`, isNotNull(jobsTable.assignedPersonId))),
    db
      .select({
        personId: timeEntriesTable.personId,
        hours: sql<number>`coalesce(sum(${timeEntriesTable.hours}), 0)`.mapWith(Number),
      })
      .from(timeEntriesTable)
      .where(gte(timeEntriesTable.updatedAt, weekStart))
      .groupBy(timeEntriesTable.personId),
    db
      .select({ personId: machinesTable.assignedPersonId })
      .from(machinesTable)
      .where(isNotNull(machinesTable.assignedPersonId)),
    db
      .select({ personId: timeEntriesTable.personId })
      .from(timeEntriesTable)
      .where(isNotNull(timeEntriesTable.timerStartedAt)),
  ]);

  const todayJobsMap = new Map<number, number>();
  for (const r of todayJobs) {
    if (r.personId) todayJobsMap.set(r.personId, (todayJobsMap.get(r.personId) ?? 0) + 1);
  }

  const weekHoursMap = new Map<number, number>();
  for (const r of weekHoursRows) {
    weekHoursMap.set(r.personId, r.hours);
  }

  const machinesMap = new Map<number, number>();
  for (const r of machineRows) {
    if (r.personId) machinesMap.set(r.personId, (machinesMap.get(r.personId) ?? 0) + 1);
  }

  const activeTimerSet = new Set(activeTimerRows.map((r) => r.personId));

  res.json(
    allPeople.map((p) => ({
      personId: p.id,
      personName: p.name,
      todayJobsCount: todayJobsMap.get(p.id) ?? 0,
      weekHours: weekHoursMap.get(p.id) ?? 0,
      assignedMachinesCount: machinesMap.get(p.id) ?? 0,
      hasActiveTimer: activeTimerSet.has(p.id),
    })),
  );
});

router.post("/people", async (req, res): Promise<void> => {
  const parsed = CreatePersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [person] = await db.insert(peopleTable).values(parsed.data).returning();
  res.status(201).json(serializePerson(person));
});

router.patch("/people/:id", async (req, res): Promise<void> => {
  const params = UpdatePersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [person] = await db
    .update(peopleTable)
    .set(parsed.data)
    .where(eq(peopleTable.id, params.data.id))
    .returning();

  if (!person) {
    res.status(404).json({ error: "Person not found" });
    return;
  }

  res.json(serializePerson(person));
});

router.delete("/people/:id", async (req, res): Promise<void> => {
  const params = DeletePersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [person] = await db
    .delete(peopleTable)
    .where(eq(peopleTable.id, params.data.id))
    .returning();

  if (!person) {
    res.status(404).json({ error: "Person not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
