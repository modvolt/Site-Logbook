import { Router, type IRouter } from "express";
import { gte, lte, and, eq, sql } from "drizzle-orm";
import { db, jobsTable, tasksTable, attachmentsTable, peopleTable } from "@workspace/db";
import { count } from "drizzle-orm";

const router: IRouter = Router();

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

function today() {
  return new Date().toISOString().slice(0, 10);
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

  res.json({
    todayCount: todayCount?.c ?? 0,
    weekCount: weekCount?.c ?? 0,
    plannedCount: plannedCount?.c ?? 0,
    inProgressCount: inProgressCount?.c ?? 0,
    doneCount: doneCount?.c ?? 0,
    totalHoursThisWeek,
    totalRevenueThisWeek,
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
