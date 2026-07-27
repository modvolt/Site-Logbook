import { Router, type IRouter } from "express";
import { and, count, eq, isNull, lt, lte, gte, isNotNull, or, sql, notInArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  materialsTable,
  billingDocumentsTable,
  billingDocumentReferencesTable,
  warehouseItemsTable,
  machinesTable,
  customerSiteAttachmentsTable,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { getReadyToBillSummary } from "../lib/invoice-service";

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

router.get("/risks/summary", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const staleDaysRaw = Number(req.query.staleDays);
  const staleDays =
    Number.isInteger(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : DEFAULT_STALE_DAYS;

  const today = todayIso();
  const staleThreshold = subtractDaysIso(today, staleDays);
  const inspectionSoonThreshold = addDaysIso(today, INSPECTION_SOON_DAYS);

  const [
    readyToBill,
    docForReviewRows,
    warehouseBelowMinRows,
    jobsWithoutCustomerRows,
    materialsWithoutPriceRows,
    longInProgressRows,
    machinesExpiredRows,
    machinesSoonRows,
    customerDocsExpiredRows,
    customerDocsExpiringSoonRows,
  ] = await Promise.all([
    getReadyToBillSummary(),
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

    db
      .select({ c: count() })
      .from(customerSiteAttachmentsTable)
      .where(
        and(
          isNull(customerSiteAttachmentsTable.archivedAt),
          isNotNull(customerSiteAttachmentsTable.validUntil),
          lt(customerSiteAttachmentsTable.validUntil, today),
        ),
      ),

    db
      .select({ c: count() })
      .from(customerSiteAttachmentsTable)
      .where(
        and(
          isNull(customerSiteAttachmentsTable.archivedAt),
          isNotNull(customerSiteAttachmentsTable.validUntil),
          gte(customerSiteAttachmentsTable.validUntil, today),
          lte(customerSiteAttachmentsTable.validUntil, inspectionSoonThreshold),
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

  const canViewBilling = req.auth!.permissions.includes("billing.view");

  res.json({
    readyToBill: metric(
      readyToBill.count,
      "billing/unbilled",
      undefined,
      canViewBilling ? readyToBill.totalWithoutVat : null,
    ),
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
      readyToBill.overdueCustomers,
      "billing/unbilled",
    ),
    customerDocumentsExpired: metric(
      customerDocsExpiredRows[0]?.c ?? 0,
      "customers",
      { validity: "expired" },
    ),
    customerDocumentsExpiringSoon: metric(
      customerDocsExpiringSoonRows[0]?.c ?? 0,
      "customers",
      { validity: "expiring" },
    ),
    staleDays,
    computedAt: new Date().toISOString(),
  });
});

export default router;
