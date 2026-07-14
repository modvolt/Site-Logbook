import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, isNull, max, min, ne } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  jobGroupsTable,
  jobsTable,
  jobVisitsTable,
  materialsTable,
  tasksTable,
  customersTable,
  quotesTable,
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
  sourceQuote: {
    id: number | null;
    quoteNumber: string | null;
    title: string | null;
    invoiceId: number | null;
    primaryJobId: number | null;
  } = {
    id: null,
    quoteNumber: null,
    title: null,
    invoiceId: null,
    primaryJobId: null,
  },
  scheduleRange?: { dateFrom: string | null; dateTo: string | null },
) {
  const totalHours = jobs.reduce(
    (sum, job) => sum + (num(job.hoursSpent) ?? 0),
    0,
  );
  return {
    ...group,
    customerCompanyName,
    jobsCount: jobs.length,
    totalHours,
    materialTotalCost,
    jobNumbers: jobs.map((job) => job.jobNumber ?? job.id),
    sourceQuoteId: sourceQuote.id,
    sourceQuoteNumber: sourceQuote.quoteNumber,
    sourceQuoteTitle: sourceQuote.title,
    sourceInvoiceId: sourceQuote.invoiceId,
    sourceQuoteJobId: sourceQuote.primaryJobId,
    ...(scheduleRange ? scheduleRange : {}),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

function serializeJob(
  job: typeof jobsTable.$inferSelect,
  personalTimerStarts = new Map<number, Date>(),
) {
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
    signatureRequestedAt: job.signatureRequestedAt
      ? job.signatureRequestedAt.toISOString()
      : null,
    signatureTokenExpiresAt: job.signatureTokenExpiresAt
      ? job.signatureTokenExpiresAt.toISOString()
      : null,
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
    priceSourceDate: material.priceSourceDate
      ? material.priceSourceDate.toISOString()
      : null,
    invoicedAt: material.invoicedAt ? material.invoicedAt.toISOString() : null,
    consumedAt: material.consumedAt ? material.consumedAt.toISOString() : null,
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
      sourceQuoteId: quotesTable.id,
      sourceQuoteNumber: quotesTable.quoteNumber,
      sourceQuoteTitle: quotesTable.title,
      sourceInvoiceId: quotesTable.convertedToInvoiceId,
      sourceQuoteJobId: quotesTable.convertedToJobId,
    })
    .from(jobGroupsTable)
    .leftJoin(customersTable, eq(jobGroupsTable.customerId, customersTable.id))
    .leftJoin(
      quotesTable,
      eq(quotesTable.convertedToJobGroupId, jobGroupsTable.id),
    )
    .where(eq(jobGroupsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function loadJobs(groupId: number) {
  return db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.groupId, groupId), isNull(jobsTable.archivedAt)))
    .orderBy(asc(jobsTable.date), asc(jobsTable.startTime), asc(jobsTable.id));
}

async function materialTotalForJobs(jobIds: number[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const rows = await db
    .select()
    .from(materialsTable)
    .where(
      and(inArray(materialsTable.jobId, jobIds), eq(materialsTable.done, true)),
    );
  return rows.reduce((sum, material) => {
    const quantity = num(material.quantity) ?? 0;
    const pricePerUnit = num(material.pricePerUnit) ?? 0;
    return sum + quantity * pricePerUnit;
  }, 0);
}

async function scheduleRangeForJobs(
  jobs: Array<typeof jobsTable.$inferSelect>,
) {
  if (jobs.length === 0) return { dateFrom: null, dateTo: null };
  const dates = jobs.map((job) => job.date).filter(Boolean);
  const visits = await db
    .select({ date: jobVisitsTable.date })
    .from(jobVisitsTable)
    .where(
      and(
        inArray(
          jobVisitsTable.jobId,
          jobs.map((job) => job.id),
        ),
        ne(jobVisitsTable.status, "cancelled"),
      ),
    );
  dates.push(...visits.map((visit) => visit.date).filter(Boolean));
  dates.sort();
  return { dateFrom: dates[0] ?? null, dateTo: dates.at(-1) ?? null };
}

router.get("/job-groups", async (_req, res): Promise<void> => {
  const groups = await db
    .select({
      group: jobGroupsTable,
      customerCompanyName: customersTable.companyName,
      sourceQuoteId: quotesTable.id,
      sourceQuoteNumber: quotesTable.quoteNumber,
      sourceQuoteTitle: quotesTable.title,
      sourceInvoiceId: quotesTable.convertedToInvoiceId,
      sourceQuoteJobId: quotesTable.convertedToJobId,
    })
    .from(jobGroupsTable)
    .leftJoin(customersTable, eq(jobGroupsTable.customerId, customersTable.id))
    .leftJoin(
      quotesTable,
      eq(quotesTable.convertedToJobGroupId, jobGroupsTable.id),
    )
    .orderBy(
      asc(jobGroupsTable.status),
      asc(jobGroupsTable.dateFrom),
      asc(jobGroupsTable.name),
    );

  const result = [];
  for (const row of groups) {
    const jobs = await loadJobs(row.group.id);
    const materialTotalCost = await materialTotalForJobs(
      jobs.map((job) => job.id),
    );
    const scheduleRange = await scheduleRangeForJobs(jobs);
    result.push(
      serializeGroup(
        row.group,
        row.customerCompanyName ?? null,
        jobs,
        materialTotalCost,
        {
          id: row.sourceQuoteId ?? null,
          quoteNumber: row.sourceQuoteNumber ?? null,
          title: row.sourceQuoteTitle ?? null,
          invoiceId: row.sourceInvoiceId ?? null,
          primaryJobId: row.sourceQuoteJobId ?? null,
        },
        scheduleRange,
      ),
    );
  }
  res.json(result);
});

router.post("/job-groups", async (req, res): Promise<void> => {
  const parsed = groupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ message: "Neplatna data akce.", issues: parsed.error.issues });
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
  const scheduleRange = await scheduleRangeForJobs(jobs);
  const jobIds = jobs.map((job) => job.id);
  const personalTimerStarts = await activeWorkSessionStarts(
    "job",
    jobIds,
    req.auth!.personId,
  );
  const materials =
    jobIds.length > 0
      ? await db
          .select()
          .from(materialsTable)
          .where(inArray(materialsTable.jobId, jobIds))
          .orderBy(
            asc(materialsTable.jobId),
            asc(materialsTable.sortOrder),
            asc(materialsTable.id),
          )
      : [];
  const tasks =
    jobIds.length > 0
      ? await db
          .select()
          .from(tasksTable)
          .where(inArray(tasksTable.jobId, jobIds))
          .orderBy(asc(tasksTable.jobId), asc(tasksTable.id))
      : [];

  const materialsByJob = new Map<
    number,
    ReturnType<typeof serializeMaterial>[]
  >();
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

  const materialTotalCost = materials
    .filter((material) => material.done)
    .reduce((sum, material) => {
      const quantity = num(material.quantity) ?? 0;
      const pricePerUnit = num(material.pricePerUnit) ?? 0;
      return sum + quantity * pricePerUnit;
    }, 0);

  res.json({
    ...serializeGroup(
      row.group,
      row.customerCompanyName ?? null,
      jobs,
      materialTotalCost,
      {
        id: row.sourceQuoteId ?? null,
        quoteNumber: row.sourceQuoteNumber ?? null,
        title: row.sourceQuoteTitle ?? null,
        invoiceId: row.sourceInvoiceId ?? null,
        primaryJobId: row.sourceQuoteJobId ?? null,
      },
      scheduleRange,
    ),
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
      ...(data.address !== undefined
        ? { address: cleanText(data.address) }
        : {}),
      ...(data.notes !== undefined ? { notes: cleanText(data.notes) } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.dateFrom !== undefined
        ? { dateFrom: cleanText(data.dateFrom) }
        : {}),
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
  const materialTotalCost = await materialTotalForJobs(
    jobs.map((job) => job.id),
  );
  const scheduleRange = await scheduleRangeForJobs(jobs);
  const source = await loadGroup(group.id);
  res.json(
    serializeGroup(
      group,
      source?.customerCompanyName ?? null,
      jobs,
      materialTotalCost,
      {
        id: source?.sourceQuoteId ?? null,
        quoteNumber: source?.sourceQuoteNumber ?? null,
        title: source?.sourceQuoteTitle ?? null,
        invoiceId: source?.sourceInvoiceId ?? null,
        primaryJobId: source?.sourceQuoteJobId ?? null,
      },
      scheduleRange,
    ),
  );
});

router.delete("/job-groups/:id", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Neplatne ID akce." });
    return;
  }
  const [sourceQuote] = await db
    .select({ id: quotesTable.id })
    .from(quotesTable)
    .where(eq(quotesTable.convertedToJobGroupId, parsedParams.data.id))
    .limit(1);
  if (sourceQuote) {
    res
      .status(409)
      .json({
        message:
          "Akci vytvořenou z nabídky nelze smazat. Nabídka musí zůstat dohledatelná.",
      });
    return;
  }
  await db
    .delete(jobGroupsTable)
    .where(eq(jobGroupsTable.id, parsedParams.data.id));
  res.status(204).end();
});

router.post("/job-groups/:id/jobs", async (req, res): Promise<void> => {
  const parsedParams = paramsSchema.safeParse(req.params);
  const parsedBody = assignJobsSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ message: "Neplatny seznam zakazek." });
    return;
  }
  const jobIds = Array.from(new Set(parsedBody.data.jobIds));
  const assigned = await db
    .transaction(async (tx) => {
      const [group] = await tx
        .select({
          id: jobGroupsTable.id,
          customerId: jobGroupsTable.customerId,
        })
        .from(jobGroupsTable)
        .where(eq(jobGroupsTable.id, parsedParams.data.id))
        .for("update")
        .limit(1);
      if (!group) throw new Error("GROUP_NOT_FOUND");

      const [sourceQuote] = await tx
        .select({ convertedToInvoiceId: quotesTable.convertedToInvoiceId })
        .from(quotesTable)
        .where(eq(quotesTable.convertedToJobGroupId, group.id))
        .for("update")
        .limit(1);
      if (sourceQuote?.convertedToInvoiceId != null) {
        throw new Error("GROUP_BILLING_LOCKED");
      }

      const selectedJobs = await tx
        .select({
          id: jobsTable.id,
          customerId: jobsTable.customerId,
          groupId: jobsTable.groupId,
          archivedAt: jobsTable.archivedAt,
        })
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds))
        .for("update");
      if (
        selectedJobs.length !== jobIds.length ||
        selectedJobs.some((job) => job.archivedAt != null)
      ) {
        throw new Error("JOB_NOT_FOUND");
      }
      if (
        selectedJobs.some(
          (job) => job.groupId != null && job.groupId !== group.id,
        )
      ) {
        throw new Error("JOB_IN_OTHER_GROUP");
      }
      if (
        group.customerId != null &&
        selectedJobs.some((job) => job.customerId !== group.customerId)
      ) {
        throw new Error("CUSTOMER_MISMATCH");
      }

      const rows = await tx
        .update(jobsTable)
        .set({ groupId: group.id })
        .where(inArray(jobsTable.id, jobIds))
        .returning({ id: jobsTable.id });
      const [range] = await tx
        .select({ dateFrom: min(jobsTable.date), dateTo: max(jobsTable.date) })
        .from(jobsTable)
        .where(
          and(eq(jobsTable.groupId, group.id), isNull(jobsTable.archivedAt)),
        );
      await tx
        .update(jobGroupsTable)
        .set({
          dateFrom: range?.dateFrom ?? null,
          dateTo: range?.dateTo ?? null,
          updatedAt: new Date(),
        })
        .where(eq(jobGroupsTable.id, group.id));
      return rows;
    })
    .catch((error: unknown) => {
      const code = error instanceof Error ? error.message : "";
      if (code === "GROUP_NOT_FOUND") return null;
      if (code === "JOB_NOT_FOUND") return "job_not_found" as const;
      if (code === "JOB_IN_OTHER_GROUP") return "job_in_other_group" as const;
      if (code === "CUSTOMER_MISMATCH") return "customer_mismatch" as const;
      if (code === "GROUP_BILLING_LOCKED")
        return "group_billing_locked" as const;
      throw error;
    });
  if (assigned === null) {
    res.status(404).json({ message: "Akce nenalezena." });
    return;
  }
  if (assigned === "job_not_found") {
    res
      .status(400)
      .json({
        message: "Jedna nebo více zakázek neexistuje nebo je archivovaná.",
      });
    return;
  }
  if (assigned === "job_in_other_group") {
    res
      .status(409)
      .json({
        message:
          "Zakázka už patří do jiné akce. Nejprve ji z původní akce odeberte.",
      });
    return;
  }
  if (assigned === "customer_mismatch") {
    res
      .status(409)
      .json({
        message: "Všechny zakázky v akci musí patřit stejnému zákazníkovi.",
      });
    return;
  }
  if (assigned === "group_billing_locked") {
    res
      .status(409)
      .json({
        message:
          "Složení akce nelze změnit, dokud je navázaná na koncept nebo vystavenou fakturu.",
      });
    return;
  }
  res.json({ assigned: assigned.length });
});

router.delete(
  "/job-groups/:id/jobs/:jobId",
  async (req, res): Promise<void> => {
    const parsedParams = jobParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ message: "Neplatne ID zakazky." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [group] = await tx
        .select({ id: jobGroupsTable.id })
        .from(jobGroupsTable)
        .where(eq(jobGroupsTable.id, parsedParams.data.id))
        .for("update")
        .limit(1);
      if (!group) return "not_found" as const;
      const [sourceQuote] = await tx
        .select({
          convertedToJobId: quotesTable.convertedToJobId,
          convertedToInvoiceId: quotesTable.convertedToInvoiceId,
        })
        .from(quotesTable)
        .where(eq(quotesTable.convertedToJobGroupId, parsedParams.data.id))
        .for("update")
        .limit(1);
      if (sourceQuote?.convertedToInvoiceId != null) {
        return "group_billing_locked" as const;
      }

      const [job] = await tx
        .select({ id: jobsTable.id, groupId: jobsTable.groupId })
        .from(jobsTable)
        .where(eq(jobsTable.id, parsedParams.data.jobId))
        .for("update")
        .limit(1);
      if (!job || job.groupId !== parsedParams.data.id)
        return "not_found" as const;
      if (sourceQuote?.convertedToJobId === job.id)
        return "primary_quote_job" as const;

      await tx
        .update(jobsTable)
        .set({ groupId: null })
        .where(eq(jobsTable.id, job.id));
      const [range] = await tx
        .select({ dateFrom: min(jobsTable.date), dateTo: max(jobsTable.date) })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.groupId, parsedParams.data.id),
            isNull(jobsTable.archivedAt),
          ),
        );
      await tx
        .update(jobGroupsTable)
        .set({
          dateFrom: range?.dateFrom ?? null,
          dateTo: range?.dateTo ?? null,
          updatedAt: new Date(),
        })
        .where(eq(jobGroupsTable.id, parsedParams.data.id));
      return "removed" as const;
    });
    if (result === "not_found") {
      res.status(404).json({ message: "Zakázka v této akci nebyla nalezena." });
      return;
    }
    if (result === "primary_quote_job") {
      res
        .status(409)
        .json({
          message:
            "První zakázku vytvořenou z nabídky nelze z její akce odebrat.",
        });
      return;
    }
    if (result === "group_billing_locked") {
      res
        .status(409)
        .json({
          message:
            "Zakázku nelze z akce odebrat, dokud je akce navázaná na fakturu.",
        });
      return;
    }
    res.status(204).end();
  },
);

export default router;
