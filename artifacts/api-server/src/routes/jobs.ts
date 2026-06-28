import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, count, inArray, max, isNull, isNotNull, ne, or } from "drizzle-orm";
import { db, jobsTable, jobVisitsTable, tasksTable, attachmentsTable, materialsTable, peopleTable, customersTable, invoicesTable, invoiceSourceLinksTable, employeeLeavesTable } from "@workspace/db";
import {
  ListJobsQueryParams,
  CreateJobBody,
  GetJobParams,
  UpdateJobParams,
  UpdateJobBody,
  DeleteJobParams,
  UpdateJobStatusParams,
  UpdateJobStatusBody,
  ReorderJobsBody,
  SendJobEmailParams,
  SendJobEmailBody,
  SaveJobSheetParams,
  SaveJobSheetBody,
  BulkUpdateJobStatusBody,
} from "@workspace/api-zod";
import { sendEmailWithPdf } from "../lib/email";
import { ObjectStorageService } from "../lib/objectStorage";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

/**
 * Persist a (signed) job-sheet PDF to object storage and record it as an
 * attachment of the job (type "job_sheet"). Shared by the explicit save
 * endpoint and the email-send flow so the sheet is archived even when the
 * email cannot be delivered.
 */
async function saveJobSheetPdf(
  jobId: number,
  pdfBase64: string,
  signed?: boolean | null,
) {
  const buffer = Buffer.from(pdfBase64, "base64");
  if (buffer.length === 0 || buffer.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error("Neplatná data PDF zakázkového listu.");
  }
  const objectPath = `/objects/job-sheets/${randomUUID()}`;
  await objectStorageService.putPrivateObject(objectPath, buffer, "application/pdf");
  const [att] = await db
    .insert(attachmentsTable)
    .values({
      jobId,
      type: "job_sheet",
      fileName: `zakazkovy-list-${jobId}.pdf`,
      url: objectPath,
      description: signed ? "Podepsaný zakázkový list" : "Zakázkový list",
    })
    .returning();
  return att;
}

function serializeAttachment(att: typeof attachmentsTable.$inferSelect) {
  return {
    ...att,
    amount: att.amount != null ? Number(att.amount) : null,
    createdAt: att.createdAt.toISOString(),
  };
}

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function numericJobFields(data: Record<string, unknown>) {
  const fields = ["hoursSpent", "hoursBeforePlan", "hoursVasek", "hoursJonas", "price", "transportKm", "transportCost", "fines", "parking", "contractPrice"] as const;
  const out: Record<string, unknown> = { ...data };
  for (const f of fields) {
    if (f in data) out[f] = toStr(data[f] as number | null | undefined);
  }
  // Drizzle timestamp columns require Date objects, not ISO strings
  if ("timerStartedAt" in out && out.timerStartedAt != null) {
    out.timerStartedAt = new Date(out.timerStartedAt as string);
  }
  // When switching to fixed_price mode, keep jobs.price in sync with contractPrice
  // so that unbilledValue in the dashboard and customer balance work correctly.
  if (out.pricingMode === "fixed_price" && out.contractPrice !== undefined) {
    out.price = out.contractPrice;
  }
  if (out.pricingMode === "time_material") {
    // Clear contractPrice when reverting to time_material mode.
    if (!("contractPrice" in data) || out.contractPrice == null) {
      out.contractPrice = null;
    }
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

  const [materialAgg] = await db
    .select({
      total: count(),
      totalCost: sql<string | null>`sum(case when ${materialsTable.pricePerUnit} is not null and ${materialsTable.pricePerUnit} != '0' then coalesce(${materialsTable.quantity}, 1) * ${materialsTable.pricePerUnit}::numeric else null end)`,
    })
    .from(materialsTable)
    .where(eq(materialsTable.jobId, job.id));

  const [billingLink] = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .innerJoin(invoicesTable, eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoiceSourceLinksTable.jobId, job.id),
        isNotNull(invoiceSourceLinksTable.jobId),
        ne(invoicesTable.status, "cancelled"),
      ),
    )
    .limit(1);

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
  let customerEmail: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({ companyName: customersTable.companyName, phone: customersTable.phone, email: customersTable.email })
      .from(customersTable)
      .where(eq(customersTable.id, job.customerId));
    customerCompanyName = customer?.companyName ?? null;
    customerPhone = customer?.phone ?? null;
    customerEmail = customer?.email ?? null;
  }

  const rawCost = materialAgg?.totalCost;
  const materialTotalCost = rawCost != null ? Number(rawCost) : null;

  return {
    ...job,
    hoursSpent: job.hoursSpent != null ? Number(job.hoursSpent) : null,
    hoursBeforePlan: job.hoursBeforePlan != null ? Number(job.hoursBeforePlan) : null,
    hoursVasek: job.hoursVasek != null ? Number(job.hoursVasek) : null,
    hoursJonas: job.hoursJonas != null ? Number(job.hoursJonas) : null,
    price: job.price != null ? Number(job.price) : null,
    transportKm: job.transportKm != null ? Number(job.transportKm) : null,
    transportCost: job.transportCost != null ? Number(job.transportCost) : null,
    fines: job.fines != null ? Number(job.fines) : null,
    parking: job.parking != null ? Number(job.parking) : null,
    contractPrice: job.contractPrice != null ? Number(job.contractPrice) : null,
    taskCount: taskCounts?.total ?? 0,
    taskDoneCount: taskCounts?.done ?? 0,
    attachmentCount: attachmentCount?.total ?? 0,
    materialCount: materialAgg?.total ?? 0,
    materialTotalCost,
    billingLinked: billingLink != null,
    assignedPersonName,
    customerCompanyName,
    customerPhone,
    customerEmail,
    timerStartedAt: job.timerStartedAt ? job.timerStartedAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

async function checkLeaveConflict(
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
    .where(
      and(
        eq(employeeLeavesTable.personId, personId),
        lte(employeeLeavesTable.startDate, date),
        gte(employeeLeavesTable.endDate, date),
      ),
    )
    .limit(1);

  if (leave) {
    return { conflict: true, leaveId: leave.id, personName: person?.name ?? "" };
  }
  return { conflict: false };
}

const DEFAULT_STALE_DAYS = 14;

async function getBilledJobIdSet(): Promise<Set<number>> {
  const rows = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .innerJoin(invoicesTable, eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id))
    .where(
      and(
        ne(invoicesTable.status, "cancelled"),
        isNotNull(invoiceSourceLinksTable.jobId),
      ),
    );
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.jobId != null) ids.add(r.jobId);
  }
  return ids;
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

router.get("/jobs", async (req, res): Promise<void> => {
  const parsed = ListJobsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { from, to, status, assignedPersonId } = parsed.data;
  const segmentRaw = typeof req.query.segment === "string" ? req.query.segment : undefined;
  const staleDaysRaw = Number(req.query.staleDays);
  const staleDays =
    Number.isInteger(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : DEFAULT_STALE_DAYS;

  const conditions = [];

  if (from) conditions.push(gte(jobsTable.date, from));
  if (to) conditions.push(lte(jobsTable.date, to));
  if (assignedPersonId != null) conditions.push(eq(jobsTable.assignedPersonId, assignedPersonId));

  let jobs: (typeof jobsTable.$inferSelect)[];

  if (segmentRaw) {
    const today = new Date().toISOString().slice(0, 10);

    switch (segmentRaw) {
      case "in_progress": {
        conditions.push(eq(jobsTable.status, "in_progress"));
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      case "ready_to_bill": {
        const billedIds = await getBilledJobIdSet();
        conditions.push(eq(jobsTable.status, "done"));
        if (billedIds.size > 0) {
          const billedArr = Array.from(billedIds);
          conditions.push(
            sql`${jobsTable.id} not in (${sql.join(billedArr.map((id) => sql`${id}`), sql`, `)})`,
          );
        }
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      case "problematic": {
        const staleThreshold = subtractDaysIso(today, staleDays);
        conditions.push(
          or(
            eq(jobsTable.status, "planned"),
            eq(jobsTable.status, "in_progress"),
          ),
        );
        conditions.push(
          or(
            isNull(jobsTable.customerId),
            isNull(jobsTable.price),
            and(
              eq(jobsTable.status, "in_progress"),
              lte(jobsTable.date, staleThreshold),
            ),
          ),
        );
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      case "without_customer": {
        conditions.push(
          or(eq(jobsTable.status, "planned"), eq(jobsTable.status, "in_progress")),
        );
        conditions.push(isNull(jobsTable.customerId));
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      case "without_price": {
        // Jobs (active) that have at least one material without a unit price.
        // Consistent with the materialsWithoutPrice risk metric.
        const unpricedJobIds = await db
          .selectDistinct({ jobId: materialsTable.jobId })
          .from(materialsTable)
          .where(
            or(isNull(materialsTable.pricePerUnit), eq(materialsTable.pricePerUnit, "0")),
          );
        const jobIdList = unpricedJobIds.map((r) => r.jobId).filter((x): x is number => x != null);
        if (jobIdList.length === 0) {
          jobs = [];
          break;
        }
        conditions.push(
          or(eq(jobsTable.status, "planned"), eq(jobsTable.status, "in_progress")),
        );
        conditions.push(inArray(jobsTable.id, jobIdList));
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      case "cancelled": {
        conditions.push(eq(jobsTable.status, "cancelled"));
        jobs = await db
          .select()
          .from(jobsTable)
          .where(and(...conditions))
          .orderBy(jobsTable.date, jobsTable.startTime);
        break;
      }
      default: {
        res.status(400).json({ error: `Unknown segment: ${segmentRaw}` });
        return;
      }
    }
  } else {
    if (status) conditions.push(eq(jobsTable.status, status));
    jobs = await db
      .select()
      .from(jobsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(jobsTable.date, jobsTable.startTime);
  }

  const enriched = await Promise.all(jobs.map(enrichJob));
  res.json(enriched);
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { assignedPersonId, date } = parsed.data as any;
  if (assignedPersonId && date) {
    const chk = await checkLeaveConflict(assignedPersonId, date as string);
    if (chk.conflict) {
      res.status(409).json({
        error: `Pracovník ${chk.personName} je v době dovolené (${date}).`,
        leaveId: chk.leaveId,
        personName: chk.personName,
      });
      return;
    }
  }

  const values = numericJobFields(parsed.data) as Record<string, unknown>;
  if (values.pricingMode === "fixed_price" && (values.contractPrice == null || Number(values.contractPrice) <= 0)) {
    res.status(400).json({ error: `Při způsobu fakturace „Smluvní cena“ je smluvní cena povinná a musí být větší než 0.` });
    return;
  }
  if (values.date) {
    const [agg] = await db
      .select({ maxSort: max(jobsTable.sortOrder) })
      .from(jobsTable)
      .where(eq(jobsTable.date, values.date as string));
    values.sortOrder = (agg?.maxSort ?? -1) + 1;
  }

  const [job] = await db.insert(jobsTable).values(values as any).returning();
  res.status(201).json(await enrichJob(job));
});

router.patch("/jobs/status", async (req, res): Promise<void> => {
  const parsed = BulkUpdateJobStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ids, status } = parsed.data;

  if (ids.length === 0) {
    res.status(400).json({ error: "ids must not be empty" });
    return;
  }

  const validStatuses = ["planned", "in_progress", "done", "cancelled"];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const result = await db
    .update(jobsTable)
    .set({ status: status as "planned" | "in_progress" | "done" | "cancelled" })
    .where(inArray(jobsTable.id, ids))
    .returning({ id: jobsTable.id });

  res.json({ updated: result.length });
});

router.patch("/jobs/reorder", async (req, res): Promise<void> => {
  const parsed = ReorderJobsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ids } = parsed.data;
  if (ids.length === 0) {
    res.status(400).json({ error: "ids must not be empty" });
    return;
  }
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "ids must be unique" });
    return;
  }

  const existing = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(inArray(jobsTable.id, ids));
  if (existing.length !== ids.length) {
    res.status(400).json({ error: "one or more ids do not exist" });
    return;
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.update(jobsTable).set({ sortOrder: i }).where(eq(jobsTable.id, ids[i]));
    }
  });

  res.sendStatus(204);
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

  const data = parsed.data as any;
  // Resolve effective person + date: payload values take priority, fall back to existing row.
  if (data.assignedPersonId || data.date) {
    const [existing] = await db
      .select({ assignedPersonId: jobsTable.assignedPersonId, date: jobsTable.date })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));
    if (existing) {
      const effectivePerson = data.assignedPersonId ?? existing.assignedPersonId;
      const effectiveDate = (data.date as string | undefined) ?? existing.date;
      if (effectivePerson && effectiveDate) {
        const chk = await checkLeaveConflict(effectivePerson, effectiveDate);
        if (chk.conflict) {
          res.status(409).json({
            error: `Pracovník ${chk.personName} je v době dovolené (${effectiveDate}).`,
            leaveId: chk.leaveId,
            personName: chk.personName,
          });
          return;
        }
      }
    }
  }

  const updateValues = numericJobFields(parsed.data);
  if (updateValues.pricingMode === "fixed_price" && (updateValues.contractPrice == null || Number(updateValues.contractPrice) <= 0)) {
    res.status(400).json({ error: `Při způsobu fakturace „Smluvní cena“ je smluvní cena povinná a musí být větší než 0.` });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set(updateValues as any)
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

  const force = req.query.force === "true";
  if (!force) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(jobVisitsTable)
      .where(eq(jobVisitsTable.jobId, params.data.id));
    const visitCount = countRow?.count ?? 0;
    if (visitCount > 0) {
      res.status(409).json({
        error: `Zakázka má ${visitCount} výjezd${visitCount === 1 ? "" : visitCount < 5 ? "y" : "ů"}. Smažte je nejprve, nebo potvrďte smazání včetně výjezdů.`,
        visitCount,
      });
      return;
    }
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

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (parsed.data.status === "done" && existing.customerId == null) {
    res.status(422).json({
      error: "Zakázku nelze označit jako hotovou bez přiřazeného zákazníka. Zákazníka přidejte v detailu zakázky.",
    });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set({ status: parsed.data.status })
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  // For recurring service calls, auto-create the next occurrence when this one
  // transitions to "done" (only on the actual transition, to avoid duplicates).
  if (
    parsed.data.status === "done" &&
    existing.status !== "done" &&
    job.type === "service_call" &&
    job.recurrenceIntervalDays != null &&
    job.recurrenceIntervalDays > 0
  ) {
    const nextDate = addDaysIso(job.date, job.recurrenceIntervalDays);
    // Guard against creating duplicate occurrences (e.g. when a job is reopened
    // and marked done again): skip if a matching next occurrence already exists.
    const [duplicate] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.type, "service_call"),
          eq(jobsTable.date, nextDate),
          eq(jobsTable.title, job.title),
          job.customerId == null
            ? isNull(jobsTable.customerId)
            : eq(jobsTable.customerId, job.customerId),
        ),
      )
      .limit(1);
    if (duplicate) {
      res.json(await enrichJob(job));
      return;
    }
    const [agg] = await db
      .select({ maxSort: max(jobsTable.sortOrder) })
      .from(jobsTable)
      .where(eq(jobsTable.date, nextDate));
    await db.insert(jobsTable).values({
      title: job.title,
      type: job.type,
      clientSite: job.clientSite,
      date: nextDate,
      startTime: job.startTime,
      endTime: job.endTime,
      status: "planned",
      assignedPersonId: job.assignedPersonId,
      customerId: job.customerId,
      notes: job.notes,
      address: job.address,
      recurrenceIntervalDays: job.recurrenceIntervalDays,
      sortOrder: (agg?.maxSort ?? -1) + 1,
    });
  }

  res.json(await enrichJob(job));
});

router.post("/jobs/:id/send-email", async (req, res): Promise<void> => {
  const params = SendJobEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SendJobEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  let customerEmail: string | null = null;
  let customerCompanyName: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({ companyName: customersTable.companyName, email: customersTable.email })
      .from(customersTable)
      .where(eq(customersTable.id, job.customerId));
    customerEmail = customer?.email ?? null;
    customerCompanyName = customer?.companyName ?? null;
  }

  const to = (parsed.data.to ?? customerEmail ?? "").trim();
  if (!to) {
    res.status(400).json({ error: "Zákazník nemá uložený e-mail." });
    return;
  }

  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) {
    res.status(400).json({ error: "Neplatná e-mailová adresa příjemce." });
    return;
  }

  const jobLabel = job.title ?? `Zakázka #${job.id}`;
  const subject = parsed.data.subject?.trim() || `Zakázkový list – ${jobLabel}`;
  const message =
    parsed.data.message?.trim() ||
    `Dobrý den${customerCompanyName ? `, ${customerCompanyName}` : ""},\n\n` +
      `v příloze zasíláme zakázkový list k zakázce "${jobLabel}".\n\n` +
      `S pozdravem,\nModvolt s.r.o.`;

  const filename = `zakazkovy-list-${job.id}.pdf`;

  // Archive the signed sheet to the job first, so it is stored even if the
  // email delivery fails. A storage failure must not block sending the email.
  try {
    await saveJobSheetPdf(job.id, parsed.data.pdfBase64, true);
  } catch (err) {
    req.log.error({ err }, "Failed to archive job sheet during email send");
  }

  try {
    await sendEmailWithPdf({
      to,
      subject,
      text: message,
      pdfBase64: parsed.data.pdfBase64,
      filename,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send job email");
    res.status(502).json({ error: err instanceof Error ? err.message : "Odeslání e-mailu selhalo." });
    return;
  }

  res.json({ sent: true, to });
});

router.post("/jobs/:id/job-sheet", async (req, res): Promise<void> => {
  const params = SaveJobSheetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SaveJobSheetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  try {
    const att = await saveJobSheetPdf(job.id, parsed.data.pdfBase64, parsed.data.signed);
    res.status(201).json(serializeAttachment(att));
  } catch (err) {
    req.log.error({ err }, "Failed to save job sheet");
    res.status(500).json({ error: err instanceof Error ? err.message : "Uložení zakázkového listu selhalo." });
  }
});

export default router;
