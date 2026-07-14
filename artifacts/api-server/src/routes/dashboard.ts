import { Router, type IRouter } from "express";
import { gte, lte, lt, and, eq, sql, isNull, or, ne, notInArray, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  jobAssigneesTable,
  tasksTable,
  attachmentsTable,
  peopleTable,
  invoiceSourceLinksTable,
  invoicesTable,
} from "@workspace/db";
import { count } from "drizzle-orm";
import { enrichJobs } from "./jobs";
import { listJobScheduleOccurrences, listScheduledJobIds } from "../lib/job-schedule-service";
import { isRestrictedFieldWorker } from "../middlewares/job-work-access";

const router: IRouter = Router();

const DEFAULT_STALE_DAYS = 14;

function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to: sunday.toISOString().slice(0, 10),
  };
}

function getMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function subtractDaysIso(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const t = today();
  const { from, to } = getWeekRange();
  const { from: monthFrom, to: monthTo } = getMonthRange();
  const staleThreshold = subtractDaysIso(t, DEFAULT_STALE_DAYS);

  const [todayJobIds, weekJobIds] = await Promise.all([
    listScheduledJobIds(t, t),
    listScheduledJobIds(from, to),
  ]);

  const [plannedCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), eq(jobsTable.status, "planned")));

  const [inProgressCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), eq(jobsTable.status, "in_progress")));

  const [doneCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), eq(jobsTable.status, "done")));

  const weekJobs = await db
    .select({ hoursSpent: jobsTable.hoursSpent, price: jobsTable.price })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), gte(jobsTable.date, from), lte(jobsTable.date, to)));

  const totalHoursThisWeek = weekJobs.reduce(
    (sum, j) => sum + (j.hoursSpent != null ? Number(j.hoursSpent) : 0),
    0
  );
  const totalRevenueThisWeek = weekJobs.reduce(
    (sum, j) => sum + (j.price != null ? Number(j.price) : 0),
    0
  );

  // --- Hours this month ---
  const [monthHoursAgg] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), gte(jobsTable.date, monthFrom), lte(jobsTable.date, monthTo)));

  // --- Unbilled value: done jobs not linked to any non-cancelled invoice ---
  const billedRows = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .innerJoin(invoicesTable, eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id))
    .where(ne(invoicesTable.status, "cancelled"));

  const billedIds = billedRows
    .map((r) => r.jobId)
    .filter((x): x is number => x != null);

  const unbilledWhere =
    billedIds.length > 0
      ? and(eq(jobsTable.status, "done"), notInArray(jobsTable.id, billedIds))
      : eq(jobsTable.status, "done");

  const OVERDUE_UNBILLED_DAYS = 7;
  const overdueThreshold = subtractDaysIso(t, OVERDUE_UNBILLED_DAYS);

  const [unbilledAgg, unbilledOldestRow, overdueUnbilledCustomersRow] = await Promise.all([
    db
      .select({
        total: sql<number>`coalesce(sum(${jobsTable.price}), 0)`.mapWith(Number),
      })
      .from(jobsTable)
      .where(and(isNull(jobsTable.archivedAt), unbilledWhere)),

    db
      .select({ oldest: sql<string | null>`MIN(${jobsTable.date})` })
      .from(jobsTable)
      .where(and(isNull(jobsTable.archivedAt), unbilledWhere)),

    db
      .select({
        c: sql<number>`COUNT(DISTINCT ${jobsTable.customerId})`.mapWith(Number),
      })
      .from(jobsTable)
      .where(
        and(
          isNull(jobsTable.archivedAt),
          billedIds.length > 0
          ? and(
              eq(jobsTable.status, "done"),
              sql`${jobsTable.customerId} IS NOT NULL`,
              lt(jobsTable.date, overdueThreshold),
              notInArray(jobsTable.id, billedIds),
            )
          : and(
              eq(jobsTable.status, "done"),
              sql`${jobsTable.customerId} IS NOT NULL`,
              lt(jobsTable.date, overdueThreshold),
            ),
        ),
      ),
  ]);

  // --- Problematic jobs: active with no customer, no price, or stale ---
  const [problematicAgg] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(
      and(
        isNull(jobsTable.archivedAt),
        or(eq(jobsTable.status, "planned"), eq(jobsTable.status, "in_progress")),
        or(
          isNull(jobsTable.customerId),
          isNull(jobsTable.price),
          and(eq(jobsTable.status, "in_progress"), lte(jobsTable.date, staleThreshold))
        )
      )
    );

  const unbilledOldest = unbilledOldestRow[0]?.oldest ?? null;
  let unbilledOldestDays: number | null = null;
  if (unbilledOldest != null) {
    const msPerDay = 86_400_000;
    const due = new Date(`${unbilledOldest}T00:00:00Z`).getTime();
    const now = new Date(`${t}T00:00:00Z`).getTime();
    unbilledOldestDays = Math.max(0, Math.floor((now - due) / msPerDay));
  }

  const canViewBilling = req.auth!.permissions.includes("billing.view");
  res.json({
    todayCount: todayJobIds.length,
    weekCount: weekJobIds.length,
    plannedCount: plannedCount?.c ?? 0,
    inProgressCount: inProgressCount?.c ?? 0,
    doneCount: doneCount?.c ?? 0,
    totalHoursThisWeek,
    totalRevenueThisWeek: canViewBilling ? totalRevenueThisWeek : null,
    hoursThisMonth: monthHoursAgg?.total ?? 0,
    unbilledValue: canViewBilling ? (unbilledAgg[0]?.total ?? 0) : null,
    unbilledOldestDays: canViewBilling ? unbilledOldestDays : null,
    overdueUnbilledCustomers: canViewBilling ? (overdueUnbilledCustomersRow[0]?.c ?? 0) : null,
    problematicJobsCount: problematicAgg?.c ?? 0,
  });
});

router.get("/dashboard/today", async (req, res): Promise<void> => {
  const t = today();
  let occurrences = await listJobScheduleOccurrences(t, t);
  if (isRestrictedFieldWorker(req.auth!.permissions)) {
    if (req.auth!.personId == null) {
      res.json([]);
      return;
    }
    const additionalAssignments = await db
      .select({ jobId: jobAssigneesTable.jobId })
      .from(jobAssigneesTable)
      .where(eq(jobAssigneesTable.personId, req.auth!.personId));
    const additionalJobIds = new Set(additionalAssignments.map((assignment) => assignment.jobId));
    occurrences = occurrences.filter((occurrence) =>
      occurrence.personId === req.auth!.personId || additionalJobIds.has(occurrence.jobId),
    );
  }
  const jobIds = Array.from(new Set(occurrences.map((occurrence) => occurrence.jobId)));
  if (jobIds.length === 0) {
    res.json([]);
    return;
  }
  const jobs = await db
    .select()
    .from(jobsTable)
    .where(and(isNull(jobsTable.archivedAt), inArray(jobsTable.id, jobIds)))
    .orderBy(jobsTable.sortOrder, jobsTable.startTime);

  const enriched = await enrichJobs(jobs, req.auth!.permissions.includes("billing.view"), req.auth!.personId);
  const personIds = Array.from(new Set(
    occurrences
      .map((occurrence) => occurrence.personId)
      .filter((personId): personId is number => personId != null),
  ));
  const people = personIds.length > 0
    ? await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds))
    : [];
  const peopleById = new Map(people.map((person) => [person.id, person.name]));
  const occurrencesByJob = new Map<number, typeof occurrences>();
  for (const occurrence of occurrences) {
    const list = occurrencesByJob.get(occurrence.jobId) ?? [];
    list.push(occurrence);
    occurrencesByJob.set(occurrence.jobId, list);
  }
  const jobsById = new Map(enriched.map((job) => [job.id, job]));
  const orderedIds = Array.from(new Set(occurrences.map((occurrence) => occurrence.jobId)));

  res.json(orderedIds.flatMap((jobId) => {
    const job = jobsById.get(jobId);
    if (!job) return [];
    const scheduleOccurrences = occurrencesByJob.get(jobId) ?? [];
    const primaryOccurrence = scheduleOccurrences[0];
    const schedulePersonNames = Array.from(new Set(scheduleOccurrences.flatMap((occurrence) =>
      occurrence.personId == null ? [] : [peopleById.get(occurrence.personId) ?? `#${occurrence.personId}`],
    )));
    return [{
      ...job,
      date: t,
      startTime: primaryOccurrence?.startTime ?? null,
      endTime: primaryOccurrence?.endTime ?? null,
      assignedPersonId: primaryOccurrence?.personId ?? null,
      assignedPersonName: schedulePersonNames.join(", ") || null,
      scheduledByVisit: scheduleOccurrences.some((occurrence) => occurrence.occurrenceType === "visit"),
      scheduleOccurrenceKeys: scheduleOccurrences.map((occurrence) => occurrence.occurrenceKey),
      schedulePersonNames,
      scheduleVisitIds: scheduleOccurrences.flatMap((occurrence) => occurrence.visitId == null ? [] : [occurrence.visitId]),
    }];
  }));
});

export default router;
