import { Router, type IRouter } from "express";
import { and, count, eq, isNull, lt, lte, gte, ne, isNotNull, or, sql, notInArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  materialsTable,
  billingDocumentsTable,
  billingDocumentReferencesTable,
  warehouseItemsTable,
  machinesTable,
  invoicesTable,
  invoiceSourceLinksTable,
} from "@workspace/db";
import { num, round2 } from "../lib/invoice-calc";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const DEFAULT_STALE_DAYS = 14;
const INSPECTION_SOON_DAYS = 30;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function subtractDaysIso(iso: string, days: number): string {
  return addDaysIso(iso, -days);
}

function metric(
  metricCount: number,
  screen: string,
  params?: Record<string, string>,
  amount?: number | null,
) {
  return {
    count: metricCount,
    amount: amount ?? null,
    filter: { screen, ...(params ? { params } : {}) },
  };
}

async function getBilledJobIds(): Promise<number[]> {
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
  return rows.map((r) => r.jobId).filter((x): x is number => x != null);
}

router.get("/risks/summary", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const staleDaysRaw = Number(req.query.staleDays);
  const staleDays =
    Number.isInteger(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : DEFAULT_STALE_DAYS;

  const today = todayIso();
  const staleThreshold = subtractDaysIso(today, staleDays);
  const inspectionSoonThreshold = addDaysIso(today, INSPECTION_SOON_DAYS);

  const billedIds = await getBilledJobIds();

  const overdueUnbilledThreshold = subtractDaysIso(today, 7);

  const [
    docForReviewRows,
    warehouseBelowMinRows,
    jobsWithoutCustomerRows,
    materialsWithoutPriceRows,
    longInProgressRows,
    machinesExpiredRows,
    machinesSoonRows,
    unbilledDoneRows,
    overdueUnbilledCustomersRows,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.status, "needs_review")),

    db
      .select({ c: count() })
      .from(warehouseItemsTable)
      .where(
        and(
          isNotNull(warehouseItemsTable.minQuantity),
          sql`${warehouseItemsTable.quantity}::numeric < ${warehouseItemsTable.minQuantity}::numeric`,
        ),
      ),

    db
      .select({ c: count() })
      .from(jobsTable)
      .where(
        and(
          or(eq(jobsTable.status, "planned"), eq(jobsTable.status, "in_progress")),
          isNull(jobsTable.customerId),
        ),
      ),

    db
      .select({ c: count() })
      .from(materialsTable)
      .innerJoin(jobsTable, eq(materialsTable.jobId, jobsTable.id))
      .where(
        and(
          or(eq(jobsTable.status, "planned"), eq(jobsTable.status, "in_progress")),
          or(
            isNull(materialsTable.pricePerUnit),
            eq(materialsTable.pricePerUnit, "0"),
          ),
        ),
      ),

    db
      .select({ c: count() })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.status, "in_progress"),
          lte(jobsTable.date, staleThreshold),
        ),
      ),

    db
      .select({ c: count() })
      .from(machinesTable)
      .where(
        and(
          isNotNull(machinesTable.inspectionDate),
          lt(machinesTable.inspectionDate, today),
        ),
      ),

    db
      .select({ c: count() })
      .from(machinesTable)
      .where(
        and(
          isNotNull(machinesTable.inspectionDate),
          gte(machinesTable.inspectionDate, today),
          lte(machinesTable.inspectionDate, inspectionSoonThreshold),
        ),
      ),

    billedIds.length > 0
      ? db
          .select({
            price: jobsTable.price,
            transportCost: jobsTable.transportCost,
            parking: jobsTable.parking,
          })
          .from(jobsTable)
          .where(
            and(eq(jobsTable.status, "done"), notInArray(jobsTable.id, billedIds)),
          )
      : db
          .select({
            price: jobsTable.price,
            transportCost: jobsTable.transportCost,
            parking: jobsTable.parking,
          })
          .from(jobsTable)
          .where(eq(jobsTable.status, "done")),

    billedIds.length > 0
      ? db
          .select({ c: sql<number>`COUNT(DISTINCT ${jobsTable.customerId})`.mapWith(Number) })
          .from(jobsTable)
          .where(
            and(
              eq(jobsTable.status, "done"),
              sql`${jobsTable.customerId} IS NOT NULL`,
              lt(jobsTable.date, overdueUnbilledThreshold),
              notInArray(jobsTable.id, billedIds),
            ),
          )
      : db
          .select({ c: sql<number>`COUNT(DISTINCT ${jobsTable.customerId})`.mapWith(Number) })
          .from(jobsTable)
          .where(
            and(
              eq(jobsTable.status, "done"),
              sql`${jobsTable.customerId} IS NOT NULL`,
              lt(jobsTable.date, overdueUnbilledThreshold),
            ),
          ),
  ]);

  const confirmedJobLinkedDocIds = await db
    .selectDistinct({ documentId: billingDocumentReferencesTable.documentId })
    .from(billingDocumentReferencesTable)
    .where(
      and(
        isNotNull(billingDocumentReferencesTable.matchedJobId),
        eq(billingDocumentReferencesTable.matchConfirmed, 1),
      ),
    );
  const confirmedDocIds = confirmedJobLinkedDocIds.map((r) => r.documentId);

  const [documentsWithoutJobRows] = await (confirmedDocIds.length > 0
    ? db
        .select({ c: count() })
        .from(billingDocumentsTable)
        .where(
          and(
            or(
              eq(billingDocumentsTable.status, "needs_review"),
              eq(billingDocumentsTable.status, "reviewed"),
            ),
            isNull(billingDocumentsTable.jobId),
            notInArray(billingDocumentsTable.id, confirmedDocIds),
          ),
        )
    : db
        .select({ c: count() })
        .from(billingDocumentsTable)
        .where(
          and(
            or(
              eq(billingDocumentsTable.status, "needs_review"),
              eq(billingDocumentsTable.status, "reviewed"),
            ),
            isNull(billingDocumentsTable.jobId),
          ),
        ));

  const readyToBillCount = unbilledDoneRows.length;
  const readyToBillAmount = round2(
    unbilledDoneRows.reduce(
      (acc, j) => acc + num(j.price) + num(j.transportCost) + num(j.parking),
      0,
    ),
  );

  res.json({
    readyToBill: metric(readyToBillCount, "jobs", { segment: "ready_to_bill" }, readyToBillAmount),
    documentsForReview: metric(docForReviewRows[0]?.c ?? 0, "billing/documents", { status: "needs_review" }),
    warehouseBelowMin: metric(warehouseBelowMinRows[0]?.c ?? 0, "warehouse", { belowMin: "true" }),
    jobsWithoutCustomer: metric(jobsWithoutCustomerRows[0]?.c ?? 0, "jobs", { segment: "without_customer" }),
    materialsWithoutPrice: metric(materialsWithoutPriceRows[0]?.c ?? 0, "jobs", { segment: "without_price" }),
    longInProgress: metric(
      longInProgressRows[0]?.c ?? 0,
      "jobs",
      { segment: "problematic", staleDays: String(staleDays) },
    ),
    documentsWithoutJob: metric(
      documentsWithoutJobRows?.c ?? 0,
      "billing/documents",
      { withoutJob: "true" },
    ),
    machinesInspectionExpired: metric(machinesExpiredRows[0]?.c ?? 0, "machines", { inspectionExpired: "true" }),
    machinesInspectionSoon: metric(machinesSoonRows[0]?.c ?? 0, "machines", { inspectionSoon: "true" }),
    overdueUnbilledCustomers: metric(
      overdueUnbilledCustomersRows[0]?.c ?? 0,
      "billing/unbilled",
    ),
    staleDays,
    computedAt: new Date().toISOString(),
  });
});

export default router;
