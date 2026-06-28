import { Router, type IRouter } from "express";
import { gte, lte, lt, and, eq, sql, isNull, or, ne, notInArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  tasksTable,
  attachmentsTable,
  peopleTable,
  invoiceSourceLinksTable,
  invoicesTable,
} from "@workspace/db";
import { count } from "drizzle-orm";

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

  let assignedPersonName: string | null = null;
  if (job.assignedPersonId) {
    const [person] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, job.assignedPersonId));
    assignedPersonName = person?.name ?? null;
  }

  return {
    ...job,
    hoursSpent: job.hoursSpent != null ? Number(job.hoursSpent) : null,
    price: job.price != null ? Number(job.price) : null,
    transportKm: job.transportKm != null ? Number(job.transportKm) : null,
    transportCost: job.transportCost != null ? Number(job.transportCost) : null,
    fines: job.fines != null ? Number(job.fines) : null,
    parking: job.parking != null ? Number(job.parking) : null,
    taskCount: taskCounts?.total ?? 0,
    taskDoneCount: taskCounts?.done ?? 0,
    attachmentCount: attachmentCount?.total ?? 0,
    assignedPersonName,
    createdAt: job.createdAt.toISOString(),
  };
}

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const t = today();
  const { from, to } = getWeekRange();
  const { from: monthFrom, to: monthTo } = getMonthRange();
  const staleThreshold = subtractDaysIso(t, DEFAULT_STALE_DAYS);

  const [todayCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(eq(jobsTable.date, t));

  const [weekCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(and(gte(jobsTable.date, from), lte(jobsTable.date, to)));

  const [plannedCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(eq(jobsTable.status, "planned"));

  const [inProgressCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(eq(jobsTable.status, "in_progress"));

  const [doneCount] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(eq(jobsTable.status, "done"));

  const weekJobs = await db
    .select({ hoursSpent: jobsTable.hoursSpent, price: jobsTable.price })
    .from(jobsTable)
    .where(and(gte(jobsTable.date, from), lte(jobsTable.date, to)));

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
    .where(and(gte(jobsTable.date, monthFrom), lte(jobsTable.date, monthTo)));

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
      .where(unbilledWhere),

    db
      .select({ oldest: sql<string | null>`MIN(${jobsTable.date})` })
      .from(jobsTable)
      .where(unbilledWhere),

    db
      .select({
        c: sql<number>`COUNT(DISTINCT ${jobsTable.customerId})`.mapWith(Number),
      })
      .from(jobsTable)
      .where(
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
  ]);

  // --- Problematic jobs: active with no customer, no price, or stale ---
  const [problematicAgg] = await db
    .select({ c: count() })
    .from(jobsTable)
    .where(
      and(
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

  res.json({
    todayCount: todayCount?.c ?? 0,
    weekCount: weekCount?.c ?? 0,
    plannedCount: plannedCount?.c ?? 0,
    inProgressCount: inProgressCount?.c ?? 0,
    doneCount: doneCount?.c ?? 0,
    totalHoursThisWeek,
    totalRevenueThisWeek,
    hoursThisMonth: monthHoursAgg?.total ?? 0,
    unbilledValue: unbilledAgg[0]?.total ?? 0,
    unbilledOldestDays,
    overdueUnbilledCustomers: overdueUnbilledCustomersRow[0]?.c ?? 0,
    problematicJobsCount: problematicAgg?.c ?? 0,
  });
});

router.get("/dashboard/today", async (_req, res): Promise<void> => {
  const t = today();
  const jobs = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.date, t))
    .orderBy(jobsTable.sortOrder, jobsTable.startTime);

  const enriched = await Promise.all(jobs.map(enrichJob));
  res.json(enriched);
});

export default router;
