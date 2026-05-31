import { Router, type IRouter } from "express";
import { gte, lte, and, eq, isNotNull, sql, count } from "drizzle-orm";
import {
  db,
  jobsTable,
  materialsTable,
  peopleTable,
  timeEntriesTable,
  warehouseItemsTable,
} from "@workspace/db";
import { GetStatsOverviewQueryParams } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.use("/stats", requireRole("admin"));

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

router.get("/stats/overview", async (req, res): Promise<void> => {
  const parsed = GetStatsOverviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const { from, to } = parsed.data;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(from) || !isoDate.test(to) || from > to) {
    res.status(400).json({ error: "Invalid date range" });
    return;
  }
  const inPeriod = and(gte(jobsTable.date, from), lte(jobsTable.date, to));

  // --- Jobs: counts by status and aggregate sums ---
  const [jobAgg] = await db
    .select({
      total: count(),
      planned: sql<number>`sum(case when ${jobsTable.status} = 'planned' then 1 else 0 end)`.mapWith(Number),
      inProgress: sql<number>`sum(case when ${jobsTable.status} = 'in_progress' then 1 else 0 end)`.mapWith(Number),
      done: sql<number>`sum(case when ${jobsTable.status} = 'done' then 1 else 0 end)`.mapWith(Number),
      cancelled: sql<number>`sum(case when ${jobsTable.status} = 'cancelled' then 1 else 0 end)`.mapWith(Number),
      hours: sql<number>`coalesce(sum(coalesce(${jobsTable.hoursSpent}, coalesce(${jobsTable.hoursVasek}, 0) + coalesce(${jobsTable.hoursJonas}, 0))), 0)`.mapWith(Number),
      price: sql<number>`coalesce(sum(${jobsTable.price}), 0)`.mapWith(Number),
      parking: sql<number>`coalesce(sum(${jobsTable.parking}), 0)`.mapWith(Number),
      fines: sql<number>`coalesce(sum(${jobsTable.fines}), 0)`.mapWith(Number),
      transport: sql<number>`coalesce(sum(${jobsTable.transportCost}), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(inPeriod);

  const byTypeRows = await db
    .select({ type: jobsTable.type, c: count() })
    .from(jobsTable)
    .where(inPeriod)
    .groupBy(jobsTable.type)
    .orderBy(sql`count(*) desc`);

  // --- Employees: jobs assigned + hours worked (from time entries on jobs in period) ---
  const assignedRows = await db
    .select({ personId: jobsTable.assignedPersonId, c: count() })
    .from(jobsTable)
    .where(and(inPeriod, isNotNull(jobsTable.assignedPersonId)))
    .groupBy(jobsTable.assignedPersonId);

  const hoursRows = await db
    .select({
      personId: timeEntriesTable.personId,
      hours: sql<number>`coalesce(sum(${timeEntriesTable.hours}), 0)`.mapWith(Number),
    })
    .from(timeEntriesTable)
    .innerJoin(jobsTable, eq(timeEntriesTable.jobId, jobsTable.id))
    .where(inPeriod)
    .groupBy(timeEntriesTable.personId);

  const people = await db
    .select({ id: peopleTable.id, name: peopleTable.name })
    .from(peopleTable);

  const assignedMap = new Map<number, number>();
  for (const r of assignedRows) {
    if (r.personId != null) assignedMap.set(r.personId, r.c);
  }
  const hoursMap = new Map<number, number>();
  for (const r of hoursRows) hoursMap.set(r.personId, num(r.hours));

  const employees = people
    .map((p) => ({
      personId: p.id,
      name: p.name,
      jobs: assignedMap.get(p.id) ?? 0,
      hours: hoursMap.get(p.id) ?? 0,
    }))
    .filter((e) => e.jobs > 0 || e.hours > 0)
    .sort((a, b) => b.hours - a.hours || b.jobs - a.jobs);

  // --- Materials: total cost + top items (materials on jobs in period) ---
  const [materialAgg] = await db
    .select({
      totalCost: sql<number>`coalesce(sum(${materialsTable.quantity} * ${materialsTable.pricePerUnit}), 0)`.mapWith(Number),
    })
    .from(materialsTable)
    .innerJoin(jobsTable, eq(materialsTable.jobId, jobsTable.id))
    .where(inPeriod);

  const topMaterials = await db
    .select({
      name: materialsTable.name,
      cost: sql<number>`coalesce(sum(${materialsTable.quantity} * ${materialsTable.pricePerUnit}), 0)`.mapWith(Number),
      quantity: sql<number>`coalesce(sum(${materialsTable.quantity}), 0)`.mapWith(Number),
    })
    .from(materialsTable)
    .innerJoin(jobsTable, eq(materialsTable.jobId, jobsTable.id))
    .where(inPeriod)
    .groupBy(materialsTable.name)
    .orderBy(sql`sum(${materialsTable.quantity} * ${materialsTable.pricePerUnit}) desc nulls last`)
    .limit(10);

  // --- Warehouse: current snapshot (not period-bound) ---
  const [warehouseAgg] = await db
    .select({
      itemCount: count(),
      stockValue: sql<number>`coalesce(sum(${warehouseItemsTable.quantity} * ${warehouseItemsTable.purchasePrice}), 0)`.mapWith(Number),
      lowStockCount: sql<number>`sum(case when ${warehouseItemsTable.minQuantity} is not null and ${warehouseItemsTable.quantity} < ${warehouseItemsTable.minQuantity} then 1 else 0 end)`.mapWith(Number),
    })
    .from(warehouseItemsTable);

  const work = num(jobAgg?.price) + num(jobAgg?.parking) + num(jobAgg?.fines) + num(jobAgg?.transport);
  const material = num(materialAgg?.totalCost);

  res.json({
    from,
    to,
    jobs: {
      total: jobAgg?.total ?? 0,
      planned: num(jobAgg?.planned),
      inProgress: num(jobAgg?.inProgress),
      done: num(jobAgg?.done),
      cancelled: num(jobAgg?.cancelled),
      totalHours: num(jobAgg?.hours),
      byType: byTypeRows.map((r) => ({ type: r.type, count: r.c })),
    },
    revenue: {
      work,
      material,
      total: work + material,
      parking: num(jobAgg?.parking),
      fines: num(jobAgg?.fines),
      transport: num(jobAgg?.transport),
    },
    employees,
    materials: {
      totalCost: material,
      top: topMaterials.map((m) => ({
        name: m.name,
        cost: num(m.cost),
        quantity: num(m.quantity),
      })),
    },
    warehouse: {
      itemCount: warehouseAgg?.itemCount ?? 0,
      stockValue: num(warehouseAgg?.stockValue),
      lowStockCount: num(warehouseAgg?.lowStockCount),
    },
  });
});

export default router;
