import { Router, type IRouter } from "express";
import { and, count, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, auditLogTable, peopleTable, jobsTable, activitiesTable, timeEntriesTable, workSessionsTable, personHourlyRatesTable, machinesTable, ppeAssignmentsTable } from "@workspace/db";
import {
  CreatePersonBody,
  UpdatePersonParams,
  UpdatePersonBody,
  DeletePersonParams,
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { createHourlyRate, listHourlyRates, voidHourlyRate } from "../lib/hourly-rate-service";

const router: IRouter = Router();

function serializePerson(p: typeof peopleTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
  };
}

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const HourlyRateInput = z.object({
  validFrom: z.iso.date(),
  costRate: z.number().finite().min(0).max(10_000_000),
  saleRate: z.number().finite().min(0).max(10_000_000),
  reason: z.string().trim().min(3).max(500),
});
const VoidRateInput = z.object({ reason: z.string().trim().min(3).max(500) });

function serializeRate(rate: Awaited<ReturnType<typeof listHourlyRates>>[number], permissions: readonly string[]) {
  const canViewCost = permissions.includes("rates.cost.view");
  const canViewSale = permissions.includes("rates.sale.view");
  return {
    id: rate.id,
    personId: rate.personId,
    validFrom: rate.validFrom,
    validTo: rate.validTo,
    costRate: canViewCost ? Number(rate.costRate) : null,
    saleRate: canViewSale ? Number(rate.saleRate) : null,
    reason: rate.reason,
    createdByUserId: rate.createdByUserId,
    createdAt: rate.createdAt.toISOString(),
    voidedAt: rate.voidedAt?.toISOString() ?? null,
    voidedByUserId: rate.voidedByUserId,
    voidReason: rate.voidReason,
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

  const [todayJobs, weekHoursRows, machineRows, activeTimerRows, ppeRows, ppeOverdueRows] = await Promise.all([
    db
      .select({ personId: jobsTable.assignedPersonId })
      .from(jobsTable)
      .where(and(sql`${jobsTable.date}::date = ${todayStr}::date`, isNotNull(jobsTable.assignedPersonId))),
    db
      .select({
        personId: workSessionsTable.personId,
        hours: sql<number>`coalesce(sum(
          case
            when ${workSessionsTable.status} = 'completed' then ${workSessionsTable.durationSeconds}
            when ${workSessionsTable.status} = 'active' then greatest(0, extract(epoch from (now() - ${workSessionsTable.startedAt})))
            else 0
          end
        ), 0) / 3600.0`.mapWith(Number),
      })
      .from(workSessionsTable)
      .where(and(gte(workSessionsTable.startedAt, weekStart), ne(workSessionsTable.status, "voided")))
      .groupBy(workSessionsTable.personId),
    db
      .select({ personId: machinesTable.assignedPersonId })
      .from(machinesTable)
      .where(isNotNull(machinesTable.assignedPersonId)),
    db
      .select({ personId: workSessionsTable.personId })
      .from(workSessionsTable)
      .where(eq(workSessionsTable.status, "active")),
    // Issued (non-returned) PPE per person
    db
      .select({ personId: ppeAssignmentsTable.personId, cnt: count() })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.status, "issued"))
      .groupBy(ppeAssignmentsTable.personId),
    // Overdue: issued + (replaceBy or nextInspectionAt is past today)
    db
      .select({ personId: ppeAssignmentsTable.personId, cnt: count() })
      .from(ppeAssignmentsTable)
      .where(
        and(
          eq(ppeAssignmentsTable.status, "issued"),
          or(
            and(isNotNull(ppeAssignmentsTable.replaceBy), lte(ppeAssignmentsTable.replaceBy, todayStr)),
            and(isNotNull(ppeAssignmentsTable.nextInspectionAt), lte(ppeAssignmentsTable.nextInspectionAt, todayStr)),
          ),
        ),
      )
      .groupBy(ppeAssignmentsTable.personId),
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

  const ppeCountMap = new Map<number, number>();
  for (const r of ppeRows) {
    ppeCountMap.set(r.personId, Number(r.cnt));
  }

  const ppeOverdueMap = new Map<number, number>();
  for (const r of ppeOverdueRows) {
    ppeOverdueMap.set(r.personId, Number(r.cnt));
  }

  res.json(
    allPeople.map((p) => ({
      personId: p.id,
      personName: p.name,
      todayJobsCount: todayJobsMap.get(p.id) ?? 0,
      weekHours: weekHoursMap.get(p.id) ?? 0,
      assignedMachinesCount: machinesMap.get(p.id) ?? 0,
      hasActiveTimer: activeTimerSet.has(p.id),
      assignedPpeCount: ppeCountMap.get(p.id) ?? 0,
      ppeAttentionCount: ppeOverdueMap.get(p.id) ?? 0,
    })),
  );
});

router.get("/people/active-timers", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: workSessionsTable.id,
      personId: workSessionsTable.personId,
      personName: peopleTable.name,
      jobId: workSessionsTable.jobId,
      activityId: workSessionsTable.activityId,
      jobTitle: jobsTable.title,
      activityName: activitiesTable.name,
      timerStartedAt: workSessionsTable.startedAt,
    })
    .from(workSessionsTable)
    .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
    .leftJoin(jobsTable, eq(workSessionsTable.jobId, jobsTable.id))
    .leftJoin(activitiesTable, eq(workSessionsTable.activityId, activitiesTable.id))
    .where(eq(workSessionsTable.status, "active"))
    .orderBy(workSessionsTable.startedAt);

  res.json(
    rows.map((r) => {
      const isJob = r.jobId != null;
      return {
        id: r.id,
        personId: r.personId,
        personName: r.personName,
        kind: isJob ? "job" : "activity",
        parentId: isJob ? r.jobId : r.activityId,
        parentName: (isJob ? r.jobTitle : r.activityName) ?? "—",
        timerStartedAt: r.timerStartedAt!.toISOString(),
      };
    }),
  );
});

router.get("/people/:id", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Neplatné ID" });
    return;
  }
  const [person] = await db.select().from(peopleTable).where(eq(peopleTable.id, params.data.id));
  if (!person) {
    res.status(404).json({ error: "Pracovník nenalezen" });
    return;
  }
  res.json(serializePerson(person));
});

router.get("/people/:id/hourly-rates", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Neplatné ID" }); return; }
  const rows = await listHourlyRates(params.data.id);
  await db.insert(auditLogTable).values({
    actorUserId: req.auth!.userId,
    actorName: req.auth!.name ?? req.auth!.username,
    action: "view",
    entityType: "person_hourly_rates",
    entityId: params.data.id,
    summary: `Zobrazení hodinových sazeb (${req.auth!.permissions.includes("rates.cost.view") ? "náklad" : ""}${req.auth!.permissions.includes("rates.cost.view") && req.auth!.permissions.includes("rates.sale.view") ? "+" : ""}${req.auth!.permissions.includes("rates.sale.view") ? "prodej" : ""})`,
    method: "GET",
    path: `/people/${params.data.id}/hourly-rates`,
  });
  res.json(rows.map((row) => serializeRate(row, req.auth!.permissions)));
});

router.post("/people/:id/hourly-rates", async (req, res): Promise<void> => {
  const params = IdParamSchema.safeParse(req.params);
  const body = HourlyRateInput.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Neplatné údaje sazby" }); return; }
  const [person] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.id, params.data.id));
  if (!person) { res.status(404).json({ error: "Pracovník nenalezen" }); return; }
  try {
    const rate = await createHourlyRate({ ...body.data, personId: params.data.id, actorUserId: req.auth!.userId });
    res.status(201).json(serializeRate(rate, req.auth!.permissions));
  } catch (error) {
    if ((error as { code?: string }).code === "23505") { res.status(409).json({ error: "Pro toto datum již sazba existuje." }); return; }
    throw error;
  }
});

router.post("/people/:id/hourly-rates/:rateId/void", async (req, res): Promise<void> => {
  const personId = Number(req.params.id);
  const rateId = Number(req.params.rateId);
  const body = VoidRateInput.safeParse(req.body);
  if (!Number.isInteger(personId) || !Number.isInteger(rateId) || !body.success) { res.status(400).json({ error: "Neplatné údaje" }); return; }
  const rate = await voidHourlyRate({ personId, rateId, reason: body.data.reason, actorUserId: req.auth!.userId });
  if (!rate) { res.status(404).json({ error: "Aktivní sazba nenalezena" }); return; }
  res.json(serializeRate(rate, req.auth!.permissions));
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

  const [ppeCount] = await db
    .select({ cnt: count() })
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.personId, params.data.id));

  if (ppeCount && Number(ppeCount.cnt) > 0) {
    res.status(409).json({
      error: `Pracovník má ${ppeCount.cnt} záznam/ů BOZP výdeje a nelze jej smazat. Nejprve vraťte nebo archivujte všechny výdeje OOPP.`,
    });
    return;
  }

  const [rateCount] = await db
    .select({ cnt: count() })
    .from(personHourlyRatesTable)
    .where(eq(personHourlyRatesTable.personId, params.data.id));
  if (rateCount && Number(rateCount.cnt) > 0) {
    res.status(409).json({ error: "Pracovník má historii hodinových sazeb a kvůli finančnímu auditu jej nelze smazat." });
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
