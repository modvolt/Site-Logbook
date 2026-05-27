import { Router, type IRouter } from "express";
import { and, gte, lte, eq, sql, desc } from "drizzle-orm";
import { db, activitiesTable, jobsTable, customersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymd(monday), to: ymd(sunday) };
}

function getMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last) };
}

router.get("/me/stats", requireAuth, async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const week = getWeekRange();
  const month = getMonthRange();

  const [activitiesAll] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(eq(activitiesTable.createdByUserId, userId));

  const [activitiesWeek] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        gte(activitiesTable.updatedAt, new Date(week.from)),
      ),
    );

  const [activitiesMonth] = await db
    .select({
      total: sql<number>`coalesce(sum(${activitiesTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        gte(activitiesTable.updatedAt, new Date(month.from)),
      ),
    );

  const [activeCount] = await db
    .select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.createdByUserId, userId),
        eq(activitiesTable.isArchived, false),
      ),
    );

  // Jobs (team-wide, no per-user attribution yet)
  const [jobsAll] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
      done: sql<number>`sum(case when ${jobsTable.status} = 'done' then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobsTable);

  const [jobsWeek] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(and(gte(jobsTable.date, week.from), lte(jobsTable.date, week.to)));

  const [jobsMonth] = await db
    .select({
      total: sql<number>`coalesce(sum(${jobsTable.hoursSpent}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(and(gte(jobsTable.date, month.from), lte(jobsTable.date, month.to)));

  res.json({
    activityHoursWeek: Number(activitiesWeek?.total ?? 0),
    activityHoursMonth: Number(activitiesMonth?.total ?? 0),
    activityHoursAll: Number(activitiesAll?.total ?? 0),
    activitiesActiveCount: Number(activeCount?.c ?? 0),
    jobHoursWeek: Number(jobsWeek?.total ?? 0),
    jobHoursMonth: Number(jobsMonth?.total ?? 0),
    jobHoursAll: Number(jobsAll?.total ?? 0),
    jobsDoneCount: Number(jobsAll?.done ?? 0),
  });
});

router.get("/me/jobs", requireAuth, async (req, res): Promise<void> => {
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;

  const rows = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      date: jobsTable.date,
      clientSite: jobsTable.clientSite,
      hoursSpent: jobsTable.hoursSpent,
      status: jobsTable.status,
      customerName: customersTable.companyName,
    })
    .from(jobsTable)
    .leftJoin(customersTable, eq(jobsTable.customerId, customersTable.id))
    .where(eq(jobsTable.status, "done"))
    .orderBy(desc(jobsTable.date))
    .limit(limit);

  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      clientSite: r.clientSite ?? r.customerName ?? null,
      hoursSpent: r.hoursSpent != null ? Number(r.hoursSpent) : null,
      status: r.status,
    })),
  );
});

export default router;
