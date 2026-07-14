import { Router, type IRouter, type Response } from "express";
import {
  eq,
  and,
  gte,
  lte,
  sql,
  count,
  inArray,
  max,
  min,
  isNull,
  isNotNull,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import {
  db,
  jobsTable,
  jobGroupsTable,
  jobAssigneesTable,
  tasksTable,
  attachmentsTable,
  materialsTable,
  peopleTable,
  customersTable,
  quotesTable,
  invoicesTable,
  invoiceSourceLinksTable,
  employeeLeavesTable,
  workSessionsTable,
  warehouseItemsTable,
} from "@workspace/db";
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
  UpdateJobAssigneesParams,
  UpdateJobAssigneesBody,
} from "@workspace/api-zod";
import { sendEmailWithPdf, sendPlainEmail } from "../lib/email";
import { ObjectStorageService } from "../lib/objectStorage";
import { randomUUID } from "node:crypto";
import {
  ActiveWorkSessionConflict,
  activeWorkSessionStarts,
  startWorkSession,
  stopWorkSession,
} from "../lib/work-session-service";
import {
  reconcileMaterialStockMovement,
  resolveWarehouseItemIdByName,
} from "../lib/warehouse-service";
import {
  getJobCompletionReadiness,
  JobStatusTransitionError,
  transitionJobStatus,
  transitionJobStatuses,
} from "../lib/job-status-service";
import { listJobScheduleOccurrences } from "../lib/job-schedule-service";
import {
  isRestrictedFieldWorker,
  listAssignedJobIds,
  requireAssignedJobView,
} from "../middlewares/job-work-access";
import { requirePermission } from "../middlewares/permissions";

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
  if (
    buffer.length === 0 ||
    buffer.subarray(0, 4).toString("latin1") !== "%PDF"
  ) {
    throw new Error("Neplatná data PDF zakázkového listu.");
  }
  const objectPath = `/objects/job-sheets/${randomUUID()}`;
  await objectStorageService.putPrivateObject(
    objectPath,
    buffer,
    "application/pdf",
  );
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
  v != null ? String(v) : (v as null | undefined);

function respondStatusTransitionError(res: Response, error: unknown): boolean {
  if (!(error instanceof JobStatusTransitionError)) return false;
  res.status(error.code === "job_not_found" ? 404 : 409).json({
    error: error.message,
    code: error.code,
    jobId: error.jobId,
    readiness: error.readiness,
  });
  return true;
}

function numericJobFields(data: Record<string, unknown>) {
  const fields = [
    "hoursSpent",
    "hoursBeforePlan",
    "hoursVasek",
    "hoursJonas",
    "price",
    "transportKm",
    "transportCost",
    "fines",
    "parking",
    "contractPrice",
  ] as const;
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

function containsFinancialJobFields(data: Record<string, unknown>): boolean {
  return [
    "price",
    "transportCost",
    "fines",
    "parking",
    "contractPrice",
    "pricingMode",
  ].some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

// Batch enrichment: a fixed number of grouped queries regardless of how many
// jobs are passed in. Replaces the old per-job version that issued ~6 queries
// per job (N+1 — the jobs list with hundreds of jobs fired thousands of queries).
export async function enrichJobs(
  jobList: (typeof jobsTable.$inferSelect)[],
  canViewFinancial = false,
  timerPersonId?: number | null,
) {
  if (jobList.length === 0) return [];
  const jobIds = jobList.map((j) => j.id);
  const customerIds = [
    ...new Set(
      jobList.map((j) => j.customerId).filter((x): x is number => x != null),
    ),
  ];
  const assignedPersonIds = [
    ...new Set(
      jobList
        .map((j) => j.assignedPersonId)
        .filter((x): x is number => x != null),
    ),
  ];

  const [
    taskCountRows,
    attachmentCountRows,
    materialAggRows,
    billingLinkRows,
    assigneeRows,
    customerRows,
    personRows,
    personalTimerStarts,
  ] = await Promise.all([
    db
      .select({
        jobId: tasksTable.jobId,
        total: count(),
        done: sql<number>`sum(case when ${tasksTable.done} then 1 else 0 end)`.mapWith(
          Number,
        ),
      })
      .from(tasksTable)
      .where(inArray(tasksTable.jobId, jobIds))
      .groupBy(tasksTable.jobId),
    db
      .select({ jobId: attachmentsTable.jobId, total: count() })
      .from(attachmentsTable)
      .where(inArray(attachmentsTable.jobId, jobIds))
      .groupBy(attachmentsTable.jobId),
    db
      .select({
        jobId: materialsTable.jobId,
        total: count(),
        consumed:
          sql<number>`sum(case when ${materialsTable.done} then 1 else 0 end)`.mapWith(
            Number,
          ),
        planned:
          sql<number>`sum(case when ${materialsTable.done} then 0 else 1 end)`.mapWith(
            Number,
          ),
        totalCost: sql<
          string | null
        >`sum(case when ${materialsTable.done} and ${materialsTable.pricePerUnit} is not null and ${materialsTable.pricePerUnit} != '0' then coalesce(${materialsTable.quantity}, 1) * ${materialsTable.pricePerUnit}::numeric else null end)`,
      })
      .from(materialsTable)
      .where(inArray(materialsTable.jobId, jobIds))
      .groupBy(materialsTable.jobId),
    db
      .selectDistinct({ jobId: invoiceSourceLinksTable.jobId })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(
        and(
          inArray(invoiceSourceLinksTable.jobId, jobIds),
          isNotNull(invoiceSourceLinksTable.jobId),
          ne(invoicesTable.status, "cancelled"),
        ),
      ),
    db
      .select({
        jobId: jobAssigneesTable.jobId,
        id: peopleTable.id,
        name: peopleTable.name,
      })
      .from(jobAssigneesTable)
      .innerJoin(peopleTable, eq(jobAssigneesTable.personId, peopleTable.id))
      .where(inArray(jobAssigneesTable.jobId, jobIds))
      .orderBy(peopleTable.name),
    customerIds.length
      ? db
          .select({
            id: customersTable.id,
            companyName: customersTable.companyName,
            phone: customersTable.phone,
            email: customersTable.email,
          })
          .from(customersTable)
          .where(inArray(customersTable.id, customerIds))
      : Promise.resolve([]),
    assignedPersonIds.length
      ? db
          .select({ id: peopleTable.id, name: peopleTable.name })
          .from(peopleTable)
          .where(inArray(peopleTable.id, assignedPersonIds))
      : Promise.resolve([]),
    activeWorkSessionStarts("job", jobIds, timerPersonId),
  ]);

  const taskCountsByJob = new Map(taskCountRows.map((r) => [r.jobId, r]));
  const attachmentCountByJob = new Map(
    attachmentCountRows.map((r) => [r.jobId, r.total]),
  );
  const materialAggByJob = new Map(materialAggRows.map((r) => [r.jobId, r]));
  const billedJobIds = new Set(billingLinkRows.map((r) => r.jobId));
  const assigneesByJob = new Map<number, { id: number; name: string }[]>();
  for (const r of assigneeRows) {
    const list = assigneesByJob.get(r.jobId);
    if (list) list.push({ id: r.id, name: r.name });
    else assigneesByJob.set(r.jobId, [{ id: r.id, name: r.name }]);
  }
  const customersById = new Map(customerRows.map((r) => [r.id, r]));
  const peopleById = new Map(personRows.map((r) => [r.id, r.name]));

  return jobList.map((job) => {
    const taskCounts = taskCountsByJob.get(job.id);
    const materialAgg = materialAggByJob.get(job.id);
    const assignees = assigneesByJob.get(job.id) ?? [];
    const customer =
      job.customerId != null ? customersById.get(job.customerId) : undefined;
    const rawCost = materialAgg?.totalCost;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { signatureToken: _st, ...jobWithoutSecret } = job;
    return {
      ...jobWithoutSecret,
      hoursSpent: job.hoursSpent != null ? Number(job.hoursSpent) : null,
      hoursBeforePlan:
        job.hoursBeforePlan != null ? Number(job.hoursBeforePlan) : null,
      hoursVasek: job.hoursVasek != null ? Number(job.hoursVasek) : null,
      hoursJonas: job.hoursJonas != null ? Number(job.hoursJonas) : null,
      price: canViewFinancial && job.price != null ? Number(job.price) : null,
      transportKm: job.transportKm != null ? Number(job.transportKm) : null,
      transportCost:
        canViewFinancial && job.transportCost != null
          ? Number(job.transportCost)
          : null,
      fines: canViewFinancial && job.fines != null ? Number(job.fines) : null,
      parking:
        canViewFinancial && job.parking != null ? Number(job.parking) : null,
      contractPrice:
        canViewFinancial && job.contractPrice != null
          ? Number(job.contractPrice)
          : null,
      taskCount: taskCounts?.total ?? 0,
      taskDoneCount: taskCounts?.done ?? 0,
      attachmentCount: attachmentCountByJob.get(job.id) ?? 0,
      materialCount: materialAgg?.total ?? 0,
      consumedMaterialCount: materialAgg?.consumed ?? 0,
      plannedMaterialCount: materialAgg?.planned ?? 0,
      materialTotalCost:
        canViewFinancial && rawCost != null ? Number(rawCost) : null,
      billingLinked: billedJobIds.has(job.id),
      assignedPersonName:
        job.assignedPersonId != null
          ? (peopleById.get(job.assignedPersonId) ?? null)
          : null,
      assigneeIds: assignees.map((a) => a.id),
      assigneeNames: assignees.map((a) => a.name),
      customerCompanyName: customer?.companyName ?? null,
      customerPhone: customer?.phone ?? null,
      customerEmail: customer?.email ?? null,
      timerStartedAt: personalTimerStarts.get(job.id)?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      archivedAt: job.archivedAt?.toISOString() ?? null,
      signatureRequestedAt: job.signatureRequestedAt
        ? job.signatureRequestedAt.toISOString()
        : null,
      signatureTokenExpiresAt: job.signatureTokenExpiresAt
        ? job.signatureTokenExpiresAt.toISOString()
        : null,
      signedAt: job.signedAt ? job.signedAt.toISOString() : null,
      signatureObjectPath: job.signatureObjectPath,
      // signatureToken intentionally omitted — it is a secret bearer credential
    };
  });
}

async function enrichJob(
  job: typeof jobsTable.$inferSelect,
  canViewFinancial = false,
  timerPersonId?: number | null,
) {
  const [enriched] = await enrichJobs([job], canViewFinancial, timerPersonId);
  return enriched;
}

async function checkLeaveConflict(
  personId: number,
  date: string,
): Promise<
  { conflict: true; leaveId: number; personName: string } | { conflict: false }
> {
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
    return {
      conflict: true,
      leaveId: leave.id,
      personName: person?.name ?? "",
    };
  }
  return { conflict: false };
}

const DEFAULT_STALE_DAYS = 14;

async function getBilledJobIdSet(): Promise<Set<number>> {
  const rows = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
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
  const segmentRaw =
    typeof req.query.segment === "string" ? req.query.segment : undefined;
  const staleDaysRaw = Number(req.query.staleDays);
  const staleDays =
    Number.isInteger(staleDaysRaw) && staleDaysRaw > 0
      ? staleDaysRaw
      : DEFAULT_STALE_DAYS;

  const includeArchived = req.query.includeArchived === "true";
  if (includeArchived && !req.auth!.permissions.includes("jobs.manage")) {
    res
      .status(403)
      .json({ error: "Forbidden", requiredPermission: "jobs.manage" });
    return;
  }

  const conditions: Array<SQL<unknown> | undefined> = includeArchived
    ? []
    : [isNull(jobsTable.archivedAt)];

  if (isRestrictedFieldWorker(req.auth!.permissions)) {
    if (req.auth!.personId == null) {
      res.json([]);
      return;
    }
    const assignedJobIds = await listAssignedJobIds(req.auth!.personId);
    if (assignedJobIds.length === 0) {
      res.json([]);
      return;
    }
    conditions.push(inArray(jobsTable.id, assignedJobIds));
  }

  if (from) conditions.push(gte(jobsTable.date, from));
  if (to) conditions.push(lte(jobsTable.date, to));
  if (assignedPersonId != null)
    conditions.push(eq(jobsTable.assignedPersonId, assignedPersonId));

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
            sql`${jobsTable.id} not in (${sql.join(
              billedArr.map((id) => sql`${id}`),
              sql`, `,
            )})`,
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
          or(
            eq(jobsTable.status, "planned"),
            eq(jobsTable.status, "in_progress"),
          ),
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
            or(
              isNull(materialsTable.pricePerUnit),
              eq(materialsTable.pricePerUnit, "0"),
            ),
          );
        const jobIdList = unpricedJobIds
          .map((r) => r.jobId)
          .filter((x): x is number => x != null);
        if (jobIdList.length === 0) {
          jobs = [];
          break;
        }
        conditions.push(
          or(
            eq(jobsTable.status, "planned"),
            eq(jobsTable.status, "in_progress"),
          ),
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

  const enriched = await enrichJobs(
    jobs,
    req.auth!.permissions.includes("billing.view"),
    req.auth!.personId,
  );
  res.json(enriched);
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (
    containsFinancialJobFields(parsed.data as Record<string, unknown>) &&
    !req.auth!.permissions.includes("billing.manage")
  ) {
    res
      .status(403)
      .json({ error: "Forbidden", requiredPermission: "billing.manage" });
    return;
  }

  const {
    assigneeIds: requestedAssigneeIds = [],
    tasks: initialTasks = [],
    materials: initialMaterials = [],
    ...jobInput
  } = parsed.data;
  const assignedPersonId = jobInput.assignedPersonId ?? null;
  const date = jobInput.date;
  const assigneeIds = Array.from(new Set(requestedAssigneeIds)).filter(
    (id) => id !== assignedPersonId,
  );
  const allPersonIds = Array.from(
    new Set([
      ...(assignedPersonId != null ? [assignedPersonId] : []),
      ...assigneeIds,
    ]),
  );

  if (allPersonIds.length > 0) {
    const existingPeople = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(inArray(peopleTable.id, allPersonIds));
    if (existingPeople.length !== allPersonIds.length) {
      res
        .status(400)
        .json({ error: "Jeden nebo více vybraných pracovníků neexistuje." });
      return;
    }
  }
  for (const personId of allPersonIds) {
    const chk = await checkLeaveConflict(personId, date);
    if (chk.conflict) {
      res.status(409).json({
        error: `Pracovník ${chk.personName} je v době dovolené (${date}).`,
        leaveId: chk.leaveId,
        personName: chk.personName,
      });
      return;
    }
  }

  if (jobInput.customerId != null) {
    const [customer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.id, jobInput.customerId));
    if (!customer) {
      res.status(400).json({ error: "Vybraný zákazník neexistuje." });
      return;
    }
  }

  if (jobInput.groupId != null) {
    const [group] = await db
      .select({ id: jobGroupsTable.id, customerId: jobGroupsTable.customerId })
      .from(jobGroupsTable)
      .where(eq(jobGroupsTable.id, jobInput.groupId));
    if (!group) {
      res.status(400).json({ error: "Vybraná akce zakázek neexistuje." });
      return;
    }
    if (group.customerId != null && jobInput.customerId !== group.customerId) {
      res
        .status(400)
        .json({
          error: "Zakázka musí mít stejného zákazníka jako akce zakázek.",
        });
      return;
    }
  }

  const explicitWarehouseItemIds = Array.from(
    new Set(
      initialMaterials
        .map((material) => material.warehouseItemId)
        .filter((id): id is number => id != null),
    ),
  );
  if (explicitWarehouseItemIds.length > 0) {
    const existingItems = await db
      .select({ id: warehouseItemsTable.id })
      .from(warehouseItemsTable)
      .where(inArray(warehouseItemsTable.id, explicitWarehouseItemIds));
    if (existingItems.length !== explicitWarehouseItemIds.length) {
      res
        .status(400)
        .json({
          error: "Jedna nebo více vybraných skladových položek neexistuje.",
        });
      return;
    }
  }

  const values = numericJobFields(jobInput) as Record<string, unknown>;
  if (
    values.pricingMode === "fixed_price" &&
    (values.contractPrice == null || Number(values.contractPrice) <= 0)
  ) {
    res
      .status(400)
      .json({
        error: `Při způsobu fakturace „Smluvní cena“ je smluvní cena povinná a musí být větší než 0.`,
      });
    return;
  }

  const actor = { userId: req.auth!.userId, name: req.auth!.name };
  const jobResult = await db
    .transaction(async (tx) => {
      if (jobInput.groupId != null) {
        const [lockedGroup] = await tx
          .select({ id: jobGroupsTable.id })
          .from(jobGroupsTable)
          .where(eq(jobGroupsTable.id, jobInput.groupId))
          .for("update")
          .limit(1);
        if (!lockedGroup) throw new Error("GROUP_NOT_FOUND");
        const [sourceQuote] = await tx
          .select({ convertedToInvoiceId: quotesTable.convertedToInvoiceId })
          .from(quotesTable)
          .where(eq(quotesTable.convertedToJobGroupId, lockedGroup.id))
          .for("update")
          .limit(1);
        if (sourceQuote?.convertedToInvoiceId != null) {
          throw new Error("GROUP_BILLING_LOCKED");
        }
      }

      // Serialize ordering for one day. Without this lock two simultaneous
      // creates can both observe the same MAX(sort_order).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`jobs-sort:${date}`}))`,
      );
      const [agg] = await tx
        .select({ maxSort: max(jobsTable.sortOrder) })
        .from(jobsTable)
        .where(eq(jobsTable.date, date));
      const jobValues = { ...values, sortOrder: (agg?.maxSort ?? -1) + 1 };

      const [createdJob] = await tx
        .insert(jobsTable)
        .values(jobValues as any)
        .returning();

      if (assigneeIds.length > 0) {
        await tx
          .insert(jobAssigneesTable)
          .values(
            assigneeIds.map((personId) => ({ jobId: createdJob.id, personId })),
          );
      }
      if (initialTasks.length > 0) {
        await tx.insert(tasksTable).values(
          initialTasks.map((task) => ({
            jobId: createdJob.id,
            title: task.title,
            description: task.description ?? null,
            isChangeRequest: task.isChangeRequest ?? false,
          })),
        );
      }
      for (const [sortOrder, material] of initialMaterials.entries()) {
        const {
          quantity,
          pricePerUnit,
          warehouseItemId: requestedWarehouseItemId,
          ...rest
        } = material;
        const warehouseItemId =
          requestedWarehouseItemId !== undefined
            ? requestedWarehouseItemId
            : await resolveWarehouseItemIdByName(tx, rest.name);
        const [createdMaterial] = await tx
          .insert(materialsTable)
          .values({
            jobId: createdJob.id,
            ...rest,
            quantity: toStr(quantity),
            pricePerUnit: toStr(pricePerUnit),
            warehouseItemId,
            sortOrder,
            done: false,
          })
          .returning();
        await reconcileMaterialStockMovement(tx, createdMaterial, actor);
      }

      if (createdJob.groupId != null) {
        const [range] = await tx
          .select({
            dateFrom: min(jobsTable.date),
            dateTo: max(jobsTable.date),
          })
          .from(jobsTable)
          .where(
            and(
              eq(jobsTable.groupId, createdJob.groupId),
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
          .where(eq(jobGroupsTable.id, createdJob.groupId));
      }

      return createdJob;
    })
    .catch((error: unknown) => {
      const code = error instanceof Error ? error.message : "";
      if (code === "GROUP_NOT_FOUND") return "group_not_found" as const;
      if (code === "GROUP_BILLING_LOCKED")
        return "group_billing_locked" as const;
      throw error;
    });
  if (jobResult === "group_not_found") {
    res.status(400).json({ error: "Vybraná akce zakázek už neexistuje." });
    return;
  }
  if (jobResult === "group_billing_locked") {
    res
      .status(409)
      .json({
        error: "Do akce nelze přidat zakázku, dokud je navázaná na fakturu.",
      });
    return;
  }
  const job = jobResult;

  res
    .status(201)
    .json(
      await enrichJob(
        job,
        req.auth!.permissions.includes("billing.view"),
        req.auth!.personId,
      ),
    );
});

router.patch("/jobs/status", async (req, res): Promise<void> => {
  const parsed = BulkUpdateJobStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ids, status, acknowledgeWarnings } = parsed.data;

  if (ids.length === 0) {
    res.status(400).json({ error: "ids must not be empty" });
    return;
  }

  const validStatuses = ["planned", "in_progress", "done", "cancelled"];
  if (!validStatuses.includes(status)) {
    res
      .status(400)
      .json({
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    return;
  }

  try {
    const result = await transitionJobStatuses(
      ids,
      status,
      { userId: req.auth!.userId, name: req.auth!.name },
      { acknowledgeWarnings },
    );
    res.json({ updated: result.length });
  } catch (error) {
    if (!respondStatusTransitionError(res, error)) throw error;
  }
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
      await tx
        .update(jobsTable)
        .set({ sortOrder: i })
        .where(eq(jobsTable.id, ids[i]));
    }
  });

  res.sendStatus(204);
});

router.get("/jobs/calendar", async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  if (!from || !to) {
    res
      .status(400)
      .json({
        error: "Query params 'from' and 'to' are required (YYYY-MM-DD).",
      });
    return;
  }

  let occurrences = await listJobScheduleOccurrences(from, to);
  if (isRestrictedFieldWorker(req.auth!.permissions)) {
    if (req.auth!.personId == null) {
      res.json([]);
      return;
    }
    const assignedJobIds = new Set(
      await listAssignedJobIds(req.auth!.personId),
    );
    occurrences = occurrences.filter((occurrence) =>
      assignedJobIds.has(occurrence.jobId),
    );
  }
  const jobIds = Array.from(
    new Set(occurrences.map((occurrence) => occurrence.jobId)),
  );
  if (jobIds.length === 0) {
    res.json([]);
    return;
  }

  const rows = await db
    .select({
      id: jobsTable.id,
      jobNumber: jobsTable.jobNumber,
      title: jobsTable.title,
      type: jobsTable.type,
      status: jobsTable.status,
      date: jobsTable.date,
    })
    .from(jobsTable)
    .where(inArray(jobsTable.id, jobIds));

  const personIds = Array.from(
    new Set(
      occurrences
        .map((occurrence) => occurrence.personId)
        .filter((personId): personId is number => personId != null),
    ),
  );
  const people =
    personIds.length > 0
      ? await db
          .select({ id: peopleTable.id, name: peopleTable.name })
          .from(peopleTable)
          .where(inArray(peopleTable.id, personIds))
      : [];
  const jobsById = new Map(rows.map((row) => [row.id, row]));
  const peopleById = new Map(people.map((person) => [person.id, person.name]));

  const result = occurrences.flatMap((occurrence) => {
    const job = jobsById.get(occurrence.jobId);
    if (!job) return [];
    return [
      {
        ...job,
        occurrenceKey: occurrence.occurrenceKey,
        occurrenceType: occurrence.occurrenceType,
        visitId: occurrence.visitId,
        visitStatus: occurrence.visitStatus,
        visitNote: occurrence.visitNote,
        date: occurrence.date,
        startTime: occurrence.startTime,
        endTime: occurrence.endTime,
        assignedPersonId: occurrence.personId,
        assignedPersonName:
          occurrence.personId == null
            ? null
            : (peopleById.get(occurrence.personId) ?? null),
      },
    ];
  });

  res.json(result);
});

router.get(
  "/jobs/:id",
  requireAssignedJobView,
  async (req, res): Promise<void> => {
    const params = GetJobParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.json(
      await enrichJob(
        job,
        req.auth!.permissions.includes("billing.view"),
        req.auth!.personId,
      ),
    );
  },
);

router.get(
  "/jobs/:id/completion-readiness",
  requirePermission("jobs.manage"),
  requireAssignedJobView,
  async (req, res): Promise<void> => {
    const params = GetJobParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const readiness = await getJobCompletionReadiness(params.data.id);
    if (!readiness) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(readiness);
  },
);

router.put("/jobs/:id/assignees", async (req, res): Promise<void> => {
  const params = UpdateJobAssigneesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateJobAssigneesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select({
      id: jobsTable.id,
      date: jobsTable.date,
      assignedPersonId: jobsTable.assignedPersonId,
    })
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Dedupe and drop the primary assignee — the additional-assignees set is
  // conceptually distinct from the calendar-scheduling assignedPersonId.
  const personIds = Array.from(new Set(parsed.data.personIds)).filter(
    (id) => id !== existing.assignedPersonId,
  );

  if (personIds.length > 0) {
    const people = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(inArray(peopleTable.id, personIds));
    if (people.length !== personIds.length) {
      res
        .status(400)
        .json({ error: "Jeden nebo více vybraných pracovníků neexistuje." });
      return;
    }

    for (const personId of personIds) {
      const chk = await checkLeaveConflict(personId, existing.date);
      if (chk.conflict) {
        res.status(409).json({
          error: `Pracovník ${chk.personName} je v době dovolené (${existing.date}).`,
          leaveId: chk.leaveId,
          personName: chk.personName,
        });
        return;
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(jobAssigneesTable)
      .where(eq(jobAssigneesTable.jobId, params.data.id));
    if (personIds.length > 0) {
      await tx
        .insert(jobAssigneesTable)
        .values(
          personIds.map((personId) => ({ jobId: params.data.id, personId })),
        );
    }
  });

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  res.json(
    await enrichJob(
      job,
      req.auth!.permissions.includes("billing.view"),
      req.auth!.personId,
    ),
  );
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
  if (
    containsFinancialJobFields(parsed.data as Record<string, unknown>) &&
    !req.auth!.permissions.includes("billing.manage")
  ) {
    res
      .status(403)
      .json({ error: "Forbidden", requiredPermission: "billing.manage" });
    return;
  }

  const data = parsed.data as any;
  // Resolve effective person + date: payload values take priority, fall back to existing row.
  if (data.assignedPersonId || data.date) {
    const [existing] = await db
      .select({
        assignedPersonId: jobsTable.assignedPersonId,
        date: jobsTable.date,
      })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));
    if (existing) {
      const effectivePerson =
        data.assignedPersonId ?? existing.assignedPersonId;
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
  if (
    updateValues.pricingMode === "fixed_price" &&
    (updateValues.contractPrice == null ||
      Number(updateValues.contractPrice) <= 0)
  ) {
    res
      .status(400)
      .json({
        error: `Při způsobu fakturace „Smluvní cena“ je smluvní cena povinná a musí být větší než 0.`,
      });
    return;
  }
  const timerRequested = Object.prototype.hasOwnProperty.call(
    parsed.data,
    "timerStartedAt",
  );
  if (parsed.data.status !== undefined && !timerRequested) {
    res.status(409).json({
      error:
        "Stav zakázky měňte přes stavovou operaci, která před dokončením ověří čas, úkoly a materiál.",
      code: "use_status_endpoint",
    });
    return;
  }
  if (
    timerRequested &&
    parsed.data.status !== undefined &&
    parsed.data.status !== "in_progress"
  ) {
    res.status(409).json({
      error:
        "Při spuštění časovače lze zakázku pouze převést do stavu Probíhá.",
      code: "invalid_timer_status",
    });
    return;
  }
  if (timerRequested) {
    const personId = req.auth!.personId;
    if (!personId) {
      res.status(409).json({
        error:
          "Uživatelský účet není propojen se zaměstnancem. Propojení nastavte ve správě uživatelů.",
        code: "time_person_unlinked",
      });
      return;
    }
    const [existingJob] = await db
      .select({ id: jobsTable.id, status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));
    if (!existingJob) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (
      parsed.data.timerStartedAt != null &&
      ["done", "cancelled", "vyfakturovano"].includes(existingJob.status)
    ) {
      res.status(409).json({
        error:
          "Na dokončené, zrušené nebo vyfakturované zakázce nelze spustit čas. Nejprve ji bezpečně znovu otevřete.",
        code: "finished_job_timer_locked",
      });
      return;
    }
    try {
      if (parsed.data.timerStartedAt != null) {
        await startWorkSession(
          "job",
          params.data.id,
          personId,
          req.auth!.userId,
        );
      } else {
        await stopWorkSession(
          "job",
          params.data.id,
          personId,
          req.auth!.userId,
        );
      }
    } catch (error) {
      if (error instanceof ActiveWorkSessionConflict) {
        res
          .status(409)
          .json({ error: error.message, activeSession: error.active });
        return;
      }
      throw error;
    }
    delete updateValues.timerStartedAt;
    // Legacy clients calculate a shared total locally. The immutable sessions
    // are authoritative, so never let that stale projection overwrite them.
    delete updateValues.hoursSpent;
    delete updateValues.hoursFromPlan;
    delete updateValues.hoursBeforePlan;
  }
  const job = await db.transaction(async (tx) => {
    const [updated] =
      Object.keys(updateValues).length > 0
        ? await tx
            .update(jobsTable)
            .set(updateValues as any)
            .where(eq(jobsTable.id, params.data.id))
            .returning()
        : await tx
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, params.data.id));
    if (updated?.groupId != null && parsed.data.date !== undefined) {
      const [range] = await tx
        .select({ dateFrom: min(jobsTable.date), dateTo: max(jobsTable.date) })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.groupId, updated.groupId),
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
        .where(eq(jobGroupsTable.id, updated.groupId));
    }
    return updated;
  });

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(
    await enrichJob(
      job,
      req.auth!.permissions.includes("billing.view"),
      req.auth!.personId,
    ),
  );
});

router.delete("/jobs/:id", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [sourceQuote] = await db
    .select({ id: quotesTable.id })
    .from(quotesTable)
    .where(eq(quotesTable.convertedToJobId, params.data.id))
    .limit(1);
  if (sourceQuote) {
    res
      .status(409)
      .json({
        error:
          "První zakázku realizace nabídky nelze archivovat. Zakázku lze zrušit, obchodní vazba ale musí zůstat zachovaná.",
      });
    return;
  }

  const [[activeSession], [invoiceLink]] = await Promise.all([
    db
      .select({ id: workSessionsTable.id })
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.jobId, params.data.id),
          eq(workSessionsTable.status, "active"),
        ),
      )
      .limit(1),
    db
      .select({ id: invoiceSourceLinksTable.id })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(
        and(
          eq(invoiceSourceLinksTable.jobId, params.data.id),
          ne(invoicesTable.status, "cancelled"),
        ),
      )
      .limit(1),
  ]);
  if (activeSession) {
    res
      .status(409)
      .json({
        error: "Zakázku nelze archivovat, dokud na ní běží měření času.",
      });
    return;
  }
  if (invoiceLink) {
    res
      .status(409)
      .json({
        error:
          "Zakázku nelze archivovat, protože je navázaná na platnou fakturu.",
      });
    return;
  }

  const job = await db.transaction(async (tx) => {
    const [archived] = await tx
      .update(jobsTable)
      .set({
        archivedAt: new Date(),
        archivedByUserId: req.auth!.userId,
        statusBeforeArchive: sql`coalesce(${jobsTable.statusBeforeArchive}, ${jobsTable.status})`,
        status: "cancelled",
        timerStartedAt: null,
      })
      .where(
        and(eq(jobsTable.id, params.data.id), isNull(jobsTable.archivedAt)),
      )
      .returning();
    if (archived?.groupId != null) {
      const [range] = await tx
        .select({ dateFrom: min(jobsTable.date), dateTo: max(jobsTable.date) })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.groupId, archived.groupId),
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
        .where(eq(jobGroupsTable.id, archived.groupId));
    }
    return archived;
  });
  if (!job) {
    const [existing] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));
    res
      .status(existing ? 409 : 404)
      .json({
        error: existing ? "Zakázka už je archivovaná." : "Job not found",
      });
    return;
  }

  res.sendStatus(204);
});

router.post("/jobs/:id/restore", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!existing.archivedAt) {
    res.status(409).json({ error: "Zakázka není archivovaná." });
    return;
  }

  const restorableStatuses = new Set([
    "planned",
    "in_progress",
    "done",
    "cancelled",
    "vyfakturovano",
  ]);
  const restoredStatus =
    existing.statusBeforeArchive &&
    restorableStatuses.has(existing.statusBeforeArchive)
      ? existing.statusBeforeArchive
      : "planned";
  const job = await db.transaction(async (tx) => {
    const [restored] = await tx
      .update(jobsTable)
      .set({
        archivedAt: null,
        archivedByUserId: null,
        statusBeforeArchive: null,
        status: restoredStatus,
      })
      .where(eq(jobsTable.id, params.data.id))
      .returning();
    if (restored?.groupId != null) {
      const [range] = await tx
        .select({ dateFrom: min(jobsTable.date), dateTo: max(jobsTable.date) })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.groupId, restored.groupId),
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
        .where(eq(jobGroupsTable.id, restored.groupId));
    }
    return restored;
  });

  res.json(
    await enrichJob(
      job,
      req.auth!.permissions.includes("billing.view"),
      req.auth!.personId,
    ),
  );
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

  try {
    const job = await transitionJobStatus(
      params.data.id,
      parsed.data.status,
      { userId: req.auth!.userId, name: req.auth!.name },
      { acknowledgeWarnings: parsed.data.acknowledgeWarnings },
    );
    res.json(
      await enrichJob(
        job,
        req.auth!.permissions.includes("billing.view"),
        req.auth!.personId,
      ),
    );
  } catch (error) {
    if (!respondStatusTransitionError(res, error)) throw error;
  }
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

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  let customerEmail: string | null = null;
  let customerCompanyName: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({
        companyName: customersTable.companyName,
        email: customersTable.email,
      })
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
    res
      .status(502)
      .json({
        error: err instanceof Error ? err.message : "Odeslání e-mailu selhalo.",
      });
    return;
  }

  res.json({ sent: true, to });
});

/**
 * Generate (or renew) a signature token for a job and return the sign URL
 * WITHOUT sending an email. Useful for sharing the link manually and in
 * automated tests where SMTP delivery is not configured.
 *
 * In non-production environments an optional body field `expiredForTesting`
 * (boolean) can be passed to create an already-expired token for testing the
 * expired-state UI path.
 */
router.post("/jobs/:id/signature-token", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Neplatné ID zakázky" });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!job) {
    res.status(404).json({ error: "Zakázka nenalezena" });
    return;
  }

  const isDev = process.env.NODE_ENV !== "production";
  const expiredForTesting =
    isDev && (req.body as Record<string, unknown>)?.expiredForTesting === true;

  const token = randomUUID();
  const expiresAt = expiredForTesting
    ? new Date(Date.now() - 1000)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const requestedAt = new Date();

  await db
    .update(jobsTable)
    .set({
      signatureToken: token,
      signatureTokenExpiresAt: expiresAt,
      signatureRequestedAt: requestedAt,
    })
    .where(eq(jobsTable.id, id));

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const signUrl = `${baseUrl}/sign/${token}`;

  res.json({ token, signUrl, expiresAt: expiresAt.toISOString() });
});

router.post("/jobs/:id/request-signature", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Neplatné ID zakázky" });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!job) {
    res.status(404).json({ error: "Zakázka nenalezena" });
    return;
  }

  let customerEmail: string | null = null;
  let customerCompanyName: string | null = null;
  if (job.customerId) {
    const [customer] = await db
      .select({
        email: customersTable.email,
        companyName: customersTable.companyName,
      })
      .from(customersTable)
      .where(eq(customersTable.id, job.customerId));
    customerEmail = customer?.email ?? null;
    customerCompanyName = customer?.companyName ?? null;
  }

  const to =
    ((req.body as Record<string, unknown>)?.to as string | undefined)?.trim() ||
    customerEmail?.trim() ||
    "";
  if (!to) {
    res
      .status(400)
      .json({
        error:
          "Zákazník nemá uložený e-mail. Doplňte e-mailovou adresu zákazníka nebo ji zadejte ručně.",
      });
    return;
  }
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) {
    res.status(400).json({ error: "Neplatná e-mailová adresa příjemce." });
    return;
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const requestedAt = new Date();

  await db
    .update(jobsTable)
    .set({
      signatureToken: token,
      signatureTokenExpiresAt: expiresAt,
      signatureRequestedAt: requestedAt,
    })
    .where(eq(jobsTable.id, id));

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const signUrl = `${baseUrl}/sign/${token}`;
  const jobLabel = job.title ?? `Zakázka #${job.id}`;

  const emailText =
    `Dobrý den${customerCompanyName ? `, ${customerCompanyName}` : ""},\n\n` +
    `zasíláme Vám odkaz k digitálnímu podpisu předávacího protokolu zakázky „${jobLabel}".\n\n` +
    `Odkaz je platný 7 dní. Kliknutím níže si prohlédnete shrnutí zakázky a podepíšete protokol prstem nebo myší:\n\n` +
    `${signUrl}\n\n` +
    `S pozdravem,\nModvolt s.r.o.`;

  try {
    await sendPlainEmail({
      to,
      subject: `Podpis předávacího protokolu – ${jobLabel}`,
      text: emailText,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send signature request email");
    res
      .status(502)
      .json({
        error: err instanceof Error ? err.message : "Odeslání e-mailu selhalo.",
      });
    return;
  }

  res.json({ sent: true, to, signUrl });
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

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  try {
    const att = await saveJobSheetPdf(
      job.id,
      parsed.data.pdfBase64,
      parsed.data.signed,
    );
    res.status(201).json(serializeAttachment(att));
  } catch (err) {
    req.log.error({ err }, "Failed to save job sheet");
    res
      .status(500)
      .json({
        error:
          err instanceof Error
            ? err.message
            : "Uložení zakázkového listu selhalo.",
      });
  }
});

export default router;
