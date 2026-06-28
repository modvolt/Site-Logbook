import { Router, type IRouter } from "express";
import { gte, lte, and, eq, isNotNull, sql, count, inArray, isNull, lt } from "drizzle-orm";
import {
  db,
  jobsTable,
  materialsTable,
  peopleTable,
  timeEntriesTable,
  warehouseItemsTable,
  warehouseMovementsTable,
  invoicesTable,
  ppeAssignmentsTable,
  activitiesTable,
  activityMaterialsTable,
  activityExtraWorksTable,
} from "@workspace/db";
import { GetStatsOverviewQueryParams } from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { round2 } from "../lib/invoice-calc";

const router: IRouter = Router();

router.use("/stats", requireRole("admin"));

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Shift a YYYY-MM-DD string back by `days` days */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Number of calendar days in [from, to] inclusive */
function periodDays(from: string, to: string): number {
  const f = new Date(`${from}T12:00:00Z`);
  const t = new Date(`${to}T12:00:00Z`);
  return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
}

/** Generate last N month labels (YYYY-MM) ending at month of `to` */
function last6Months(to: string): string[] {
  const [y, m] = to.split("-").map(Number);
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    let mo = m - i;
    let yr = y;
    while (mo < 1) { mo += 12; yr--; }
    months.push(`${yr}-${String(mo).padStart(2, "0")}`);
  }
  return months;
}

const BILLABLE_STATUSES = ["issued", "sent", "paid"] as const;

export interface TrendRow {
  month: string;
  issuedWithVat: number;
  paid: number;
  doneJobsCount: number;
  byType: Array<{ type: string; count: number }>;
}

/**
 * Query the 6-month trend series (issued invoices, paid invoices, done jobs)
 * with optional filters by customer and/or job type.
 *
 * Exported for unit testing; the route handler delegates to this function.
 */
export async function queryTrend(
  months: string[],
  to: string,
  trendCustomerId?: number | null,
  trendJobType?: string | null,
): Promise<TrendRow[]> {
  const trendInvoiceExtra = trendCustomerId != null ? eq(invoicesTable.customerId, trendCustomerId) : undefined;
  const trendJobExtra = and(
    trendCustomerId != null ? eq(jobsTable.customerId, trendCustomerId) : undefined,
    trendJobType != null ? eq(jobsTable.type, trendJobType) : undefined,
  );

  const [trendIssued, trendPaid, trendJobs, trendJobsByType] = await Promise.all([
    db
      .select({
        month: sql<string>`to_char(${invoicesTable.issueDate}::date, 'YYYY-MM')`,
        issuedWithVat: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
      })
      .from(invoicesTable)
      .where(and(
        gte(invoicesTable.issueDate, months[0] + "-01"),
        lte(invoicesTable.issueDate, to),
        inArray(invoicesTable.status, [...BILLABLE_STATUSES]),
        trendInvoiceExtra,
      ))
      .groupBy(sql`to_char(${invoicesTable.issueDate}::date, 'YYYY-MM')`),

    db
      .select({
        month: sql<string>`to_char(${invoicesTable.paidDate}::date, 'YYYY-MM')`,
        paidAmount: sql<number>`coalesce(sum(coalesce(${invoicesTable.paidAmount}, ${invoicesTable.totalWithVat})), 0)`.mapWith(Number),
      })
      .from(invoicesTable)
      .where(and(
        gte(invoicesTable.paidDate, months[0] + "-01"),
        lte(invoicesTable.paidDate, to),
        eq(invoicesTable.status, "paid"),
        trendInvoiceExtra,
      ))
      .groupBy(sql`to_char(${invoicesTable.paidDate}::date, 'YYYY-MM')`),

    db
      .select({
        month: sql<string>`to_char(${jobsTable.date}::date, 'YYYY-MM')`,
        doneCount: sql<number>`sum(case when ${jobsTable.status} = 'done' then 1 else 0 end)`.mapWith(Number),
      })
      .from(jobsTable)
      .where(and(
        gte(jobsTable.date, months[0] + "-01"),
        lte(jobsTable.date, to),
        trendJobExtra,
      ))
      .groupBy(sql`to_char(${jobsTable.date}::date, 'YYYY-MM')`),

    // By-type breakdown: customer filter applies, job-type filter does NOT (we always want all types stacked)
    db
      .select({
        month: sql<string>`to_char(${jobsTable.date}::date, 'YYYY-MM')`,
        type: jobsTable.type,
        doneCount: sql<number>`count(*)`.mapWith(Number),
      })
      .from(jobsTable)
      .where(and(
        gte(jobsTable.date, months[0] + "-01"),
        lte(jobsTable.date, to),
        eq(jobsTable.status, "done"),
        trendCustomerId != null ? eq(jobsTable.customerId, trendCustomerId) : undefined,
      ))
      .groupBy(sql`to_char(${jobsTable.date}::date, 'YYYY-MM')`, jobsTable.type),
  ]);

  const issuedByMonth = new Map(trendIssued.map((r) => [r.month, num(r.issuedWithVat)]));
  const paidByMonth = new Map(trendPaid.map((r) => [r.month, num(r.paidAmount)]));
  const doneByMonth = new Map(trendJobs.map((r) => [r.month, num(r.doneCount)]));

  // Build month→type→count lookup
  const doneByMonthByType = new Map<string, Map<string, number>>();
  for (const r of trendJobsByType) {
    if (!doneByMonthByType.has(r.month)) doneByMonthByType.set(r.month, new Map());
    doneByMonthByType.get(r.month)!.set(r.type ?? "other", num(r.doneCount));
  }

  return months.map((m) => ({
    month: m,
    issuedWithVat: issuedByMonth.get(m) ?? 0,
    paid: paidByMonth.get(m) ?? 0,
    doneJobsCount: doneByMonth.get(m) ?? 0,
    byType: Array.from(doneByMonthByType.get(m)?.entries() ?? []).map(([type, count]) => ({ type, count })),
  }));
}

router.get("/stats/overview", async (req, res): Promise<void> => {
  const parsed = GetStatsOverviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const { from, to, trendCustomerId, trendJobType } = parsed.data;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(from) || !isoDate.test(to) || from > to) {
    res.status(400).json({ error: "Invalid date range" });
    return;
  }

  // Previous period (same length, immediately preceding)
  const days = periodDays(from, to);
  const prevTo = shiftDate(from, 1);
  const prevFrom = shiftDate(prevTo, days - 1);

  const inPeriod = and(gte(jobsTable.date, from), lte(jobsTable.date, to));
  const inPrevPeriod = and(gte(jobsTable.date, prevFrom), lte(jobsTable.date, prevTo));

  // ─── Jobs: counts by status and aggregate sums ───────────────────────────
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

  // ─── Jobs: previous period revenue for comparison ────────────────────────
  const [prevJobAgg] = await db
    .select({
      price: sql<number>`coalesce(sum(${jobsTable.price}), 0)`.mapWith(Number),
      parking: sql<number>`coalesce(sum(${jobsTable.parking}), 0)`.mapWith(Number),
      fines: sql<number>`coalesce(sum(${jobsTable.fines}), 0)`.mapWith(Number),
      transport: sql<number>`coalesce(sum(${jobsTable.transportCost}), 0)`.mapWith(Number),
      done: sql<number>`sum(case when ${jobsTable.status} = 'done' then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(inPrevPeriod);

  // ─── Employees ────────────────────────────────────────────────────────────
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

  // ─── Previous period materials for comparison ─────────────────────────────
  const [prevMaterialAgg] = await db
    .select({
      totalCost: sql<number>`coalesce(sum(${materialsTable.quantity} * ${materialsTable.pricePerUnit}), 0)`.mapWith(Number),
    })
    .from(materialsTable)
    .innerJoin(jobsTable, eq(materialsTable.jobId, jobsTable.id))
    .where(inPrevPeriod);

  // ─── Materials ────────────────────────────────────────────────────────────
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

  // ─── Warehouse snapshot ───────────────────────────────────────────────────
  const [warehouseAgg] = await db
    .select({
      itemCount: count(),
      stockValue: sql<number>`coalesce(sum(${warehouseItemsTable.quantity} * ${warehouseItemsTable.purchasePrice}), 0)`.mapWith(Number),
      lowStockCount: sql<number>`sum(case when ${warehouseItemsTable.minQuantity} is not null and ${warehouseItemsTable.quantity} < ${warehouseItemsTable.minQuantity} then 1 else 0 end)`.mapWith(Number),
    })
    .from(warehouseItemsTable);

  // ─── Warehouse profit in period ───────────────────────────────────────────
  const periodOutFilter = and(
    eq(warehouseMovementsTable.direction, "out"),
    gte(warehouseMovementsTable.createdAt, new Date(`${from}T00:00:00`)),
    lte(warehouseMovementsTable.createdAt, new Date(`${to}T23:59:59.999`)),
  );
  const [warehouseProfitAgg] = await db
    .select({
      saleRevenue: sql<number>`coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.unitPrice} else 0 end), 0)`.mapWith(Number),
      purchaseCost: sql<number>`coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.costPriceAtTime} else 0 end), 0)`.mapWith(Number),
      movementsWithCost: sql<number>`count(case when ${warehouseMovementsTable.costPriceAtTime} is not null then 1 end)`.mapWith(Number),
      movementsTotal: sql<number>`count(*)`.mapWith(Number),
    })
    .from(warehouseMovementsTable)
    .where(periodOutFilter);

  const topProfitItemsRaw = await db
    .select({
      name: warehouseItemsTable.name,
      quantityIssued: sql<number>`coalesce(sum(${warehouseMovementsTable.quantity}), 0)`.mapWith(Number),
      saleRevenue: sql<number>`coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.unitPrice} else 0 end), 0)`.mapWith(Number),
      purchaseCost: sql<number>`coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.costPriceAtTime} else 0 end), 0)`.mapWith(Number),
    })
    .from(warehouseMovementsTable)
    .innerJoin(warehouseItemsTable, eq(warehouseMovementsTable.warehouseItemId, warehouseItemsTable.id))
    .where(periodOutFilter)
    .groupBy(warehouseItemsTable.id, warehouseItemsTable.name)
    .orderBy(
      sql`coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.unitPrice} else 0 end), 0) - coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.quantity} * ${warehouseMovementsTable.costPriceAtTime} else 0 end), 0) desc nulls last`,
    )
    .limit(20);

  const topProfitItems = topProfitItemsRaw.map((r) => ({
    name: r.name,
    quantityIssued: num(r.quantityIssued),
    saleRevenue: num(r.saleRevenue),
    purchaseCost: num(r.purchaseCost),
    grossProfit: num(r.saleRevenue) - num(r.purchaseCost),
  }));

  const materialSaleRevenue = num(warehouseProfitAgg?.saleRevenue);
  const materialPurchaseCost = num(warehouseProfitAgg?.purchaseCost);
  const materialGrossProfit = materialSaleRevenue - materialPurchaseCost;
  const movementsTotal = num(warehouseProfitAgg?.movementsTotal);
  const movementsWithCost = num(warehouseProfitAgg?.movementsWithCost);
  const incompleteMovements = movementsTotal - movementsWithCost;
  const incompleteMovementsShare = movementsTotal > 0 ? incompleteMovements / movementsTotal : 0;
  const hasPartialCosts = incompleteMovements > 0;

  const work = num(jobAgg?.price) + num(jobAgg?.parking) + num(jobAgg?.fines) + num(jobAgg?.transport);
  const material = num(materialAgg?.totalCost);
  const prevWork = num(prevJobAgg?.price) + num(prevJobAgg?.parking) + num(prevJobAgg?.fines) + num(prevJobAgg?.transport);

  // ─── Billing (invoices) ───────────────────────────────────────────────────
  // Vystaveno: invoices whose issueDate falls in period with a billing status
  const [billingPeriodAgg] = await db
    .select({
      issuedCount: sql<number>`count(*)`.mapWith(Number),
      issuedWithVat: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.issueDate, from),
      lte(invoicesTable.issueDate, to),
      inArray(invoicesTable.status, [...BILLABLE_STATUSES]),
    ));

  // Zaplaceno: paid invoices where paidDate is in period
  const [paidPeriodAgg] = await db
    .select({
      paidCount: sql<number>`count(*)`.mapWith(Number),
      paidAmount: sql<number>`coalesce(sum(coalesce(${invoicesTable.paidAmount}, ${invoicesTable.totalWithVat})), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.paidDate, from),
      lte(invoicesTable.paidDate, to),
      eq(invoicesTable.status, "paid"),
    ));

  // K inkasu: issued/sent, current snapshot (not period-bound)
  const [toCollectAgg] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      amount: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(inArray(invoicesTable.status, ["issued", "sent"]));

  // Po splatnosti: issued/sent AND dueDate < today
  const today = new Date().toISOString().slice(0, 10);
  const [overdueAgg] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      amount: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      inArray(invoicesTable.status, ["issued", "sent"]),
      isNotNull(invoicesTable.dueDate),
      lt(invoicesTable.dueDate, today),
    ));

  // Previous period billing for comparison – issued uses issueDate, paid uses paidDate (like-for-like)
  const [prevIssuedAgg] = await db
    .select({
      issuedWithVat: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.issueDate, prevFrom),
      lte(invoicesTable.issueDate, prevTo),
      inArray(invoicesTable.status, [...BILLABLE_STATUSES]),
    ));

  const [prevPaidAgg] = await db
    .select({
      paidAmount: sql<number>`coalesce(sum(coalesce(${invoicesTable.paidAmount}, ${invoicesTable.totalWithVat})), 0)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.paidDate, prevFrom),
      lte(invoicesTable.paidDate, prevTo),
      eq(invoicesTable.status, "paid"),
    ));

  // ─── Top customers by invoiced amount (in period) ─────────────────────────
  const topCustomersRaw = await db
    .select({
      customerId: invoicesTable.customerId,
      customerName: invoicesTable.customerName,
      totalWithVat: sql<number>`coalesce(sum(${invoicesTable.totalWithVat}), 0)`.mapWith(Number),
      invoiceCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.issueDate, from),
      lte(invoicesTable.issueDate, to),
      inArray(invoicesTable.status, [...BILLABLE_STATUSES]),
    ))
    .groupBy(invoicesTable.customerId, invoicesTable.customerName)
    .orderBy(sql`sum(${invoicesTable.totalWithVat}) desc nulls last`)
    .limit(10);

  const topCustomers = topCustomersRaw.map((r) => ({
    customerId: r.customerId,
    customerName: r.customerName ?? "—",
    totalWithVat: num(r.totalWithVat),
    invoiceCount: num(r.invoiceCount),
  }));

  // ─── 6-month trend ────────────────────────────────────────────────────────
  const months = last6Months(to);
  const trend = await queryTrend(months, to, trendCustomerId, trendJobType);

  // ─── Activities: billable (ready-to-bill) snapshot ───────────────────────
  // Run all three activity queries in parallel
  const [activitiesCountAgg, activityMaterialsValueAgg, activityExtraWorksValueAgg] = await Promise.all([
    // Count billable completed activities
    db
      .select({ readyToBillCount: sql<number>`count(*)`.mapWith(Number) })
      .from(activitiesTable)
      .where(and(
        eq(activitiesTable.billingStatus, "billable"),
        isNotNull(activitiesTable.completedAt),
      ))
      .then(([r]) => r),

    // Value: sum of materials (quantity * pricePerUnit) for billable completed activities
    db
      .select({
        totalValue: sql<number>`coalesce(sum(
          coalesce(${activityMaterialsTable.quantity}::numeric, 0) *
          coalesce(${activityMaterialsTable.pricePerUnit}::numeric, 0)
        ), 0)`.mapWith(Number),
      })
      .from(activityMaterialsTable)
      .innerJoin(activitiesTable, eq(activityMaterialsTable.activityId, activitiesTable.id))
      .where(and(
        eq(activitiesTable.billingStatus, "billable"),
        isNotNull(activitiesTable.completedAt),
      ))
      .then(([r]) => r),

    // Value: sum of extra works amounts for billable completed activities
    db
      .select({
        totalValue: sql<number>`coalesce(sum(coalesce(${activityExtraWorksTable.amount}::numeric, 0)), 0)`.mapWith(Number),
      })
      .from(activityExtraWorksTable)
      .innerJoin(activitiesTable, eq(activityExtraWorksTable.activityId, activitiesTable.id))
      .where(and(
        eq(activitiesTable.billingStatus, "billable"),
        isNotNull(activitiesTable.completedAt),
      ))
      .then(([r]) => r),
  ]);

  // ─── Done jobs ready to bill (status='done', not yet vyfakturovano) ───────
  // Used for combined readyToBill KPI (jobs + activities)
  const [readyToBillJobsAgg] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      amount: sql<number>`coalesce(sum(
        coalesce(${jobsTable.price}::numeric, 0) +
        coalesce(${jobsTable.transportCost}::numeric, 0) +
        coalesce(${jobsTable.parking}::numeric, 0)
      ), 0)`.mapWith(Number),
    })
    .from(jobsTable)
    .where(eq(jobsTable.status, "done"));

  // ─── PPE snapshot ─────────────────────────────────────────────────────────
  const [ppeAgg] = await db
    .select({
      issued: sql<number>`count(*)`.mapWith(Number),
      signed: sql<number>`sum(case when ${ppeAssignmentsTable.employeeConfirmedAt} is not null then 1 else 0 end)`.mapWith(Number),
      unsigned: sql<number>`sum(case when ${ppeAssignmentsTable.employeeConfirmedAt} is null then 1 else 0 end)`.mapWith(Number),
      overdue: sql<number>`sum(case when ${ppeAssignmentsTable.replaceBy} is not null and ${ppeAssignmentsTable.replaceBy} < ${today} then 1 else 0 end)`.mapWith(Number),
    })
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.status, "issued"));

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
      materialSaleRevenue,
      materialPurchaseCost,
      materialGrossProfit,
      hasPartialCosts,
      topProfitItems,
      incompleteMovements,
      incompleteMovementsShare,
    },
    billing: {
      issuedCount: num(billingPeriodAgg?.issuedCount),
      issuedWithVat: num(billingPeriodAgg?.issuedWithVat),
      paidCount: num(paidPeriodAgg?.paidCount),
      paidAmount: num(paidPeriodAgg?.paidAmount),
      toCollectCount: num(toCollectAgg?.count),
      toCollectAmount: num(toCollectAgg?.amount),
      overdueCount: num(overdueAgg?.count),
      overdueAmount: num(overdueAgg?.amount),
    },
    activities: {
      readyToBillCount: num(activitiesCountAgg?.readyToBillCount),
      readyToBillAmount: round2(
        num(activityMaterialsValueAgg?.totalValue) + num(activityExtraWorksValueAgg?.totalValue),
      ),
    },
    readyToBill: {
      jobsCount: num(readyToBillJobsAgg?.count),
      activitiesCount: num(activitiesCountAgg?.readyToBillCount),
      count: num(readyToBillJobsAgg?.count) + num(activitiesCountAgg?.readyToBillCount),
      amount: round2(
        num(readyToBillJobsAgg?.amount) +
        num(activityMaterialsValueAgg?.totalValue) +
        num(activityExtraWorksValueAgg?.totalValue),
      ),
    },
    comparison: {
      prevFrom,
      prevTo,
      revenueTotal: prevWork + num(prevMaterialAgg?.totalCost),
      issuedWithVat: num(prevIssuedAgg?.issuedWithVat),
      paid: num(prevPaidAgg?.paidAmount),
      doneJobsCount: num(prevJobAgg?.done),
    },
    trend,
    topCustomers,
    ppe: {
      issued: num(ppeAgg?.issued),
      signed: num(ppeAgg?.signed),
      unsigned: num(ppeAgg?.unsigned),
      overdue: num(ppeAgg?.overdue),
    },
  });
});

export default router;
