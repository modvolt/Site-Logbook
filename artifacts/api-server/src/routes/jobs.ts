import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, count } from "drizzle-orm";
import { db, jobsTable, tasksTable, attachmentsTable, materialsTable, peopleTable, customersTable } from "@workspace/db";
import {
  ListJobsQueryParams,
  CreateJobBody,
  GetJobParams,
  UpdateJobParams,
  UpdateJobBody,
  DeleteJobParams,
  UpdateJobStatusParams,
  UpdateJobStatusBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

function numericJobFields(data: Record<string, unknown>) {
  const fields = ["hoursSpent", "hoursVasek", "hoursJonas", "price", "transportKm", "transportCost", "fines", "parking"] as const;
  const out: Record<string, unknown> = { ...data };
  for (const f of fields) {
    if (f in data) out[f] = toStr(data[f] as number | null | undefined);
  }
  // Drizzle timestamp columns require Date objects, not ISO strings
  if ("timerStartedAt" in out && out.timerStartedAt != null) {
    out.timerStartedAt = new Date(out.timerStartedAt as string);
  }
  return out;
}

async function enrichJob(job: typeof jobsTable.$inferSelect) {
  const [taskCounts] = await db
    .select({
      total: count(),
      done: sql<number>`sum(case when ${tasksTable.done} then 1 else 0 end)`.mapWith(Number),
    })
    .from(tasksTable)
    .where(eq(tasksTable.jobId, job.id));

  const [attachmentCount] = await db
    .select({ total: count() })
    .from(attachmentsTable)
    .where(eq(attachmentsTable.jobId, job.id));

  const [materialCount] = await db
    .select({ total: count() })
    .from(materialsTable)
    .where(eq(materialsTable.jobId, job.id));

  let assignedPersonName: string | null = null;
  if (job.assignedPersonId) {
    const [person] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, job.assignedPersonId));
    assignedPersonName = person?.name ?? null;
  }

  let customerCompanyName: string | null = null;
  let customerPhone: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({ companyName: customersTable.companyName, phone: customersTable.phone })
      .from(customersTable)
      .where(eq(customersTable.id, job.customerId));
    customerCompanyName = customer?.companyName ?? null;
    customerPhone = customer?.phone ?? null;
  }

  return {
    ...job,
    hoursSpent: job.hoursSpent != null ? Number(job.hoursSpent) : null,
    hoursVasek: job.hoursVasek != null ? Number(job.hoursVasek) : null,
    hoursJonas: job.hoursJonas != null ? Number(job.hoursJonas) : null,
    price: job.price != null ? Number(job.price) : null,
    transportKm: job.transportKm != null ? Number(job.transportKm) : null,
    transportCost: job.transportCost != null ? Number(job.transportCost) : null,
    fines: job.fines != null ? Number(job.fines) : null,
    parking: job.parking != null ? Number(job.parking) : null,
    taskCount: taskCounts?.total ?? 0,
    taskDoneCount: taskCounts?.done ?? 0,
    attachmentCount: attachmentCount?.total ?? 0,
    materialCount: materialCount?.total ?? 0,
    assignedPersonName,
    customerCompanyName,
    customerPhone,
    timerStartedAt: job.timerStartedAt ? job.timerStartedAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

router.get("/jobs", async (req, res): Promise<void> => {
  const parsed = ListJobsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { from, to, status, assignedPersonId } = parsed.data;
  const conditions = [];

  if (from) conditions.push(gte(jobsTable.date, from));
  if (to) conditions.push(lte(jobsTable.date, to));
  if (status) conditions.push(eq(jobsTable.status, status));
  if (assignedPersonId != null) conditions.push(eq(jobsTable.assignedPersonId, assignedPersonId));

  const jobs = await db
    .select()
    .from(jobsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(jobsTable.date, jobsTable.startTime);

  const enriched = await Promise.all(jobs.map(enrichJob));
  res.json(enriched);
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db.insert(jobsTable).values(numericJobFields(parsed.data) as any).returning();
  res.status(201).json(await enrichJob(job));
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(await enrichJob(job));
});

router.patch("/jobs/:id", async (req, res): Promise<void> => {
  const params = UpdateJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set(numericJobFields(parsed.data) as any)
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(await enrichJob(job));
});

router.delete("/jobs/:id", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.delete(jobsTable).where(eq(jobsTable.id, params.data.id)).returning();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.sendStatus(204);
});

router.patch("/jobs/:id/status", async (req, res): Promise<void> => {
  const params = UpdateJobStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateJobStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set({ status: parsed.data.status })
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(await enrichJob(job));
});

export default router;
