import { Router, type IRouter } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  jobGroupsTable,
  jobsTable,
  materialsTable,
  tasksTable,
  customersTable,
} from "@workspace/db";
import { activeWorkSessionStarts } from "../lib/work-session-service";

const router: IRouter = Router();

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const jobParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  jobId: z.coerce.number().int().positive(),
});

const groupBodySchema = z.object({
  name: z.string().trim().min(1),
  customerId: z.number().int().positive().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  status: z.string().trim().min(1).optional(),
  dateFrom: z.string().trim().nullable().optional(),
  dateTo: z.string().trim().nullable().optional(),
});

const assignJobsSchema = z.object({
  jobIds: z.array(z.number().int().positive()).min(1),
});

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  return trimmed || null;
}

function serializeGroup(
  group: typeof jobGroupsTable.$inferSelect,
  customerCompanyName: string | null,
  jobs: Array<typeof jobsTable.$inferSelect>,
  materialTotalCost: number,
) {
  const totalHours = jobs.reduce((sum, job) => sum + (num(job.hoursSpent) ?? 0), 0);
  return {
    ...group,
    customerCompanyName,
    jobsCount: jobs.length,
    totalHours,
    materialTotalCost,
    jobNumbers: jobs.map((job) => job.jobNumber ?? job.id),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

function serializeJob(job: typeof jobsTable.$inferSelect, personalTimerStarts = new Map<number, Date>()) {
  return {
    ...job,
    hoursSpent: num(job.hoursSpent),
    hoursBeforePlan: num(job.hoursBeforePlan),
    hoursVasek: num(job.hoursVasek),
    hoursJonas: num(job.hoursJonas),
    price: num(job.price),
    transportKm: num(job.transportKm),
    transportCost: num(job.transportCost),
    fines: num(job.fines),
    parking: num(job.parking),
    contractPrice: num(job.contractPrice),
    timerStartedAt: personalTimerStarts.get(job.id)?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    signatureRequestedAt: job.signatureRequestedAt ? job.signatureRequestedAt.toISOString() : null,
    signatureTokenExpiresAt: job.signatureTokenExpiresAt ? job.signatureTokenExpiresAt.toISOString() : null,
    signedAt: job.signedAt ? job.signedAt.toISOString() : null,
  };
}

function serializeMaterial(material: typeof materialsTable.$inferSelect) {
  return {
    ...material,
    quantity: num(material.quantity),
    pricePerUnit: num(material.pricePerUnit),
    priceConfidence: num(material.priceConfidence),
    purchasePricePerUnit: num(material.purchasePricePerUnit),
    priceSourceDate: material.priceSourceDate ? material.priceSourceDate.toISOString() : null,
    invoicedAt: material.invoicedAt ? material.invoicedAt.toISOString() : null,
    createdAt: material.createdAt.toISOString(),
  };
}

function serializeTask(task: typeof tasksTable.$inferSelect) {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
  };
}

async function loadGroup(id: number) {
  const [row] = await db
    .select({
      group: jobGroupsTable,
      customerCompanyName: customersTable.companyName,
    })
    .from(jobGroupsTable)
    .leftJoin(customersTable, eq(jobGroupsTable.customerId, customersTable.id))
    .where(eq(jobGroupsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function loadJobs(groupId: number) {
  return db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.groupId, groupId))
    .orderBy(asc(jobsTable.date), asc(jobsTable.startTime), asc(jobsTable.id));
}

async function materialTotalForJobs(jobIds: number[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const rows = await db
    .select()
    .from(materialsTable)
    .where(inArray(materialsTable.jobId, jobIds));
  return rows.reduce((sum, material) => {
    const quantity = num(material.quantity) ?? 0;
    const pricePerUnit = num(material.pricePerUnit) ?? 0;
    return sum + quantity * pricePerUnit;
  }, 0);
}

router.get("/job-groups", async (_req, res): Promise<void> => {
  const groups = await db
    .select({
      group: jobGroupsTable,
      customerCompanyName: customersTable.companyName,
    })
    .from(jobGroupsTable)
    .leftJoin(customersTable, eq(jobGroupsTable.customerId, customersTable.id))
    .orderBy(asc(jobGroupsTable.status), asc(jobGroupsTable.dateFrom), asc(jobGroupsTable.name));

  const result = [];
  for (const row of groups) {
    const jobs = await loadJobs(row.group.id);
    const materialTotalCost = await materialTotalForJobs(jobs.map((job) => job.id));
    result.push(serializeGroup(row.group, row.customerCompanyName ?? null, jobs, materialTotalCost));
  }
  res.json(result);
});

router.post("/job-groups", async (req, res): Promise<void> => {
  const parsed = groupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Neplatna data akce.", issues: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const [group] = await db
    .insert(jobGroupsTable)
    .values({
      name: data.name,
      customerId: data.customerId ?? null,
      address: cleanText(data.address),
      notes: cleanText(data.notes),
      status: data.status ?? "open",
      dateFrom: cleanText(data.dateFrom),
      dateTo: cleanText(data.dateTo),
    })
    .returning();
  res.status(201).json(serializeGroup(group, null, [], 0));
});

router.get("/job-groups/:id", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Neplatne ID akce." });
    return;
  }
  const row = await loadGroup(parsedParams.data.id);
  if (!row) {
    res.status(404).json({ message: "Akce nenalezena." });
    return;
  }
  const jobs = await loadJobs(row.group.id);
  const jobIds = jobs.map((job) => job.id);
  const personalTimerStarts = await activeWorkSessionStarts("job", jobIds, req.auth!.personId);
  const materials = jobIds.length > 0
    ? await db.select().from(materialsTable).where(inArray(materialsTable.jobId, jobIds)).orderBy(asc(materialsTable.jobId), asc(materialsTable.sortOrder), asc(materialsTable.id))
    : [];
  const tasks = jobIds.length > 0
    ? await db.select().from(tasksTable).where(inArray(tasksTable.jobId, jobIds)).orderBy(asc(tasksTable.jobId), asc(tasksTable.id))
    : [];

  const materialsByJob = new Map<number, ReturnType<typeof serializeMaterial>[]>();
  for (const material of materials) {
    const arr = materialsByJob.get(material.jobId) ?? [];
    arr.push(serializeMaterial(material));
    materialsByJob.set(material.jobId, arr);
  }

  const tasksByJob = new Map<number, ReturnType<typeof serializeTask>[]>();
  for (const task of tasks) {
    const arr = tasksByJob.get(task.jobId) ?? [];
    arr.push(serializeTask(task));
    tasksByJob.set(task.jobId, arr);
  }

  const materialTotalCost = materials.reduce((sum, material) => {
    const quantity = num(material.quantity) ?? 0;
    const pricePerUnit = num(material.pricePerUnit) ?? 0;
    return sum + quantity * pricePerUnit;
  }, 0);

  res.json({
    ...serializeGroup(row.group, row.customerCompanyName ?? null, jobs, materialTotalCost),
    jobs: jobs.map((job) => ({
      ...serializeJob(job, personalTimerStarts),
      materials: materialsByJob.get(job.id) ?? [],
      tasks: tasksByJob.get(job.id) ?? [],
    })),
  });
});

router.patch("/job-groups/:id", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  const parsedBody = groupBodySchema.partial().safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ message: "Neplatna data akce." });
    return;
  }
  const data = parsedBody.data;
  const [group] = await db
    .update(jobGroupsTable)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
      ...(data.address !== undefined ? { address: cleanText(data.address) } : {}),
      ...(data.notes !== undefined ? { notes: cleanText(data.notes) } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.dateFrom !== undefined ? { dateFrom: cleanText(data.dateFrom) } : {}),
      ...(data.dateTo !== undefined ? { dateTo: cleanText(data.dateTo) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobGroupsTable.id, parsedParams.data.id))
    .returning();
  if (!group) {
    res.status(404).json({ message: "Akce nenalezena." });
    return;
  }
  const jobs = await loadJobs(group.id);
  const materialTotalCost = await materialTotalForJobs(jobs.map((job) => job.id));
  res.json(serializeGroup(group, null, jobs, materialTotalCost));
});

router.delete("/job-groups/:id", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Neplatne ID akce." });
    return;
  }
  await db.delete(jobGroupsTable).where(eq(jobGroupsTable.id, parsedParams.data.id));
  res.status(204).end();
});

router.post("/job-groups/:id/jobs", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  const parsedBody = assignJobsSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ message: "Neplatny seznam zakazek." });
    return;
  }
  await db
    .update(jobsTable)
    .set({ groupId: parsedParams.data.id })
    .where(inArray(jobsTable.id, parsedBody.data.jobIds));
  res.json({ assigned: parsedBody.data.jobIds.length });
});

router.delete("/job-groups/:id/jobs/:jobId", async (req, res): Promise<void> => {
  const parsedParams = jobParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Neplatne ID zakazky." });
    return;
  }
  await db
    .update(jobsTable)
    .set({ groupId: null })
    .where(eq(jobsTable.id, parsedParams.data.jobId));
  res.status(204).end();
});

export default router;
