import { Router, type IRouter } from "express";
import { eq, and, asc, lte, gte, ne, sql } from "drizzle-orm";
import { db, jobVisitsTable, jobsTable, peopleTable, employeeLeavesTable } from "@workspace/db";
import {
  ListJobVisitsParams,
  CreateJobVisitParams,
  CreateJobVisitBody,
  UpdateJobVisitParams,
  UpdateJobVisitBody,
  DeleteJobVisitParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function hasInvalidVisitTimes(startTime?: string | null, endTime?: string | null): boolean {
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  return Boolean(
    (startTime && !timePattern.test(startTime))
    || (endTime && !timePattern.test(endTime))
    || (startTime && endTime && startTime >= endTime),
  );
}

function visitLockKey(
  jobId: number,
  date: string,
  personId: number | null,
  startTime: string | null,
  endTime: string | null,
) {
  return `job-visit:${jobId}:${date}:${personId ?? "none"}:${startTime ?? "job"}:${endTime ?? "job"}`;
}

async function checkVisitLeaveConflict(
  personId: number,
  date: string,
): Promise<{ conflict: true; leaveId: number; personName: string } | { conflict: false }> {
  const [person] = await db
    .select({ name: peopleTable.name })
    .from(peopleTable)
    .where(eq(peopleTable.id, personId));

  const [leave] = await db
    .select({ id: employeeLeavesTable.id })
    .from(employeeLeavesTable)
    .where(and(
      eq(employeeLeavesTable.personId, personId),
      lte(employeeLeavesTable.startDate, date),
      gte(employeeLeavesTable.endDate, date),
    ))
    .limit(1);

  if (leave) {
    return { conflict: true, leaveId: leave.id, personName: person?.name ?? "" };
  }
  return { conflict: false };
}

async function serializeVisit(v: typeof jobVisitsTable.$inferSelect) {
  let personName: string | null = null;
  if (v.personId) {
    const [person] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, v.personId));
    personName = person?.name ?? null;
  }
  return {
    ...v,
    personName,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

router.get("/jobs/:jobId/visits", async (req, res): Promise<void> => {
  const params = ListJobVisitsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const visits = await db
    .select()
    .from(jobVisitsTable)
    .where(eq(jobVisitsTable.jobId, params.data.jobId))
    .orderBy(asc(jobVisitsTable.date), asc(jobVisitsTable.id));

  res.json(await Promise.all(visits.map(serializeVisit)));
});

router.post("/jobs/:jobId/visits", async (req, res): Promise<void> => {
  const params = CreateJobVisitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateJobVisitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (hasInvalidVisitTimes(parsed.data.startTime, parsed.data.endTime)) {
    res.status(400).json({ error: "Cas vyjezdu musi byt ve formatu HH:MM a konec musi byt po zacatku." });
    return;
  }

  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (parsed.data.personId) {
    const conflict = await checkVisitLeaveConflict(parsed.data.personId, parsed.data.date);
    if (conflict.conflict) {
      res.status(409).json({
        error: `Pracovnik ${conflict.personName} ma v tento den dovolenou (${parsed.data.date}).`,
        leaveId: conflict.leaveId,
        personName: conflict.personName,
      });
      return;
    }
  }

  const personId = parsed.data.personId ?? null;
  const startTime = parsed.data.startTime ?? null;
  const endTime = parsed.data.endTime ?? null;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${visitLockKey(
      params.data.jobId,
      parsed.data.date,
      personId,
      startTime,
      endTime,
    )}))`);
    const [duplicate] = await tx
      .select({ id: jobVisitsTable.id })
      .from(jobVisitsTable)
      .where(and(
        eq(jobVisitsTable.jobId, params.data.jobId),
        eq(jobVisitsTable.date, parsed.data.date),
        sql`${jobVisitsTable.personId} is not distinct from ${personId}`,
        sql`${jobVisitsTable.startTime} is not distinct from ${startTime}`,
        sql`${jobVisitsTable.endTime} is not distinct from ${endTime}`,
        ne(jobVisitsTable.status, "cancelled"),
      ))
      .limit(1);
    if (duplicate) return { duplicateId: duplicate.id, visit: null };

    const [visit] = await tx
      .insert(jobVisitsTable)
      .values({ ...parsed.data, personId, startTime, endTime, jobId: params.data.jobId })
      .returning();
    return { duplicateId: null, visit };
  });

  if (result.duplicateId) {
    res.status(409).json({ error: "Stejny vyjezd je u zakazky jiz naplanovan.", visitId: result.duplicateId });
    return;
  }
  res.status(201).json(await serializeVisit(result.visit!));
});

router.patch("/jobs/:jobId/visits/:visitId", async (req, res): Promise<void> => {
  const params = UpdateJobVisitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateJobVisitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(jobVisitsTable)
    .where(and(
      eq(jobVisitsTable.id, params.data.visitId),
      eq(jobVisitsTable.jobId, params.data.jobId),
    ));
  if (!existing) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  const personId = Object.hasOwn(parsed.data, "personId") ? parsed.data.personId ?? null : existing.personId;
  const date = parsed.data.date ?? existing.date;
  const startTime = Object.hasOwn(parsed.data, "startTime") ? parsed.data.startTime ?? null : existing.startTime;
  const endTime = Object.hasOwn(parsed.data, "endTime") ? parsed.data.endTime ?? null : existing.endTime;
  if (hasInvalidVisitTimes(startTime, endTime)) {
    res.status(400).json({ error: "Cas vyjezdu musi byt ve formatu HH:MM a konec musi byt po zacatku." });
    return;
  }
  if (personId) {
    const conflict = await checkVisitLeaveConflict(personId, date);
    if (conflict.conflict) {
      res.status(409).json({
        error: `Pracovnik ${conflict.personName} ma v tento den dovolenou (${date}).`,
        leaveId: conflict.leaveId,
        personName: conflict.personName,
      });
      return;
    }
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${visitLockKey(
      params.data.jobId,
      date,
      personId,
      startTime,
      endTime,
    )}))`);
    const [duplicate] = await tx
      .select({ id: jobVisitsTable.id })
      .from(jobVisitsTable)
      .where(and(
        eq(jobVisitsTable.jobId, params.data.jobId),
        ne(jobVisitsTable.id, params.data.visitId),
        eq(jobVisitsTable.date, date),
        sql`${jobVisitsTable.personId} is not distinct from ${personId}`,
        sql`${jobVisitsTable.startTime} is not distinct from ${startTime}`,
        sql`${jobVisitsTable.endTime} is not distinct from ${endTime}`,
        ne(jobVisitsTable.status, "cancelled"),
      ))
      .limit(1);
    if (duplicate) return { duplicateId: duplicate.id, visit: null };

    const [visit] = await tx
      .update(jobVisitsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(
        eq(jobVisitsTable.id, params.data.visitId),
        eq(jobVisitsTable.jobId, params.data.jobId),
      ))
      .returning();
    return { duplicateId: null, visit };
  });

  if (result.duplicateId) {
    res.status(409).json({ error: "Stejny vyjezd je u zakazky jiz naplanovan.", visitId: result.duplicateId });
    return;
  }
  res.json(await serializeVisit(result.visit!));
});

router.delete("/jobs/:jobId/visits/:visitId", async (req, res): Promise<void> => {
  const params = DeleteJobVisitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const cancelled = await db
    .update(jobVisitsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(jobVisitsTable.id, params.data.visitId),
      eq(jobVisitsTable.jobId, params.data.jobId),
    ))
    .returning({ id: jobVisitsTable.id });
  if (cancelled.length === 0) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
