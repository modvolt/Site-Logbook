import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  billingSettingsTable,
  materialMarkupRulesTable,
  billingDocumentLinesTable,
  warehouseItemsTable,
  invoicesTable,
  invoiceLinesTable,
  invoiceSourceLinksTable,
  invoiceSourceAllocationsTable,
  jobsTable,
  materialsTable,
  activitiesTable,
  activityMaterialsTable,
  activityExtraWorksTable,
  customersTable,
  auditLogTable,
  workSessionsTable,
  workSessionBillingLinksTable,
  peopleTable,
  quotesTable,
  quoteItemsTable,
  quoteInvoiceLinksTable,
  jobGroupsTable,
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingLifecycleEventsTable,
  accountingPaymentEventsTable,
  type BillingSettings,
  type MaterialMarkupRule,
  type Invoice,
  type InvoiceLine,
  type InvoiceSourceAllocation,
  type UserRole,
} from "@workspace/db";
import {
  computeLine,
  applyMaterialMarkup,
  resolveMaterialMarkup,
  resolveLineMaterialMarkup,
  num,
  round2,
  sumTotals,
  type ComputedLine,
  type VatMode,
} from "./invoice-calc";
import { normalizeItemName } from "./reference-extractor";
import { generateInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import {
  INVOICE_CONSTANT_SYMBOL,
  invoiceVariableSymbol,
  resolveIban,
  buildSpayd,
  generatePaymentQrDataUrl,
} from "./invoice-qr";
import { ObjectStorageService } from "./objectStorage";
import {
  parseBankStatement,
  type StatementFormat,
} from "./bank-statement-parser";
import {
  markLinesInvoiced,
  releaseInvoicedLines,
  markMaterialsInvoiced,
  releaseInvoicedMaterials,
} from "./cost-document-service";
import {
  encodeInvoicePresentation,
  getStoredInvoicePresentationGroups,
  normalizeMaterialDisplayMode,
  presentInvoiceLines,
  type InvoicePresentationGroup,
  type InvoicePresentationMode,
  type MaterialDisplayMode,
} from "./invoice-line-presentation";
import {
  buildIssuedInvoiceAccountingEvidence,
  isAccountingIssueInvoiceDualWriteEnabled,
} from "./accounting-invoice-issue-evidence";
import {
  buildInvoiceCancellationAccountingEvidence,
  invoiceCancellationObjectPath,
  isAccountingCancelInvoiceDualWriteEnabled,
} from "./accounting-invoice-cancellation-evidence";
import {
  appendAccountingCorrectionBundleInTransaction,
  appendAccountingLifecycleEventInTransaction,
  appendAccountingPaymentEventInTransaction,
  appendInitialAccountingVersionInTransaction,
} from "./accounting-persistence-contract";
import {
  accountingPaymentEventFromRow,
  createAccountingPersistenceDbAdapter,
} from "./accounting-persistence-db-adapter";
import {
  verifyCanonicalAccountingDocumentVersionJsonBytes,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  buildInvoicePaymentAccountingEvidence,
  buildInvoiceSentAccountingEvidence,
  isAccountingBankPaymentDualWriteEnabled,
  isAccountingInvoiceStatusDualWriteEnabled,
} from "./accounting-invoice-status-evidence";
import {
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
  type AccountingLifecycleEventV1,
} from "./accounting-lifecycle-event-contract";
import {
  finalAllocationStatus,
  isIdempotentIssueRetryStatus,
  prepareCommercialLines,
  settlementMethodForCommercialSource,
  type CommercialPlanningLine,
  type PreparedCommercialLines,
  type SettlementMethod,
} from "./invoice-source-planning";

const objectStorage = new ObjectStorageService();

const SETTINGS_ID = 1;

export type AppError = Error & { statusCode: number };
function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

export interface Actor {
  userId: number | null;
  name: string;
  role?: UserRole;
}

// ---------------------------------------------------------------------------
// Date helpers (calendar days stored as ISO "YYYY-MM-DD" text, like jobs.date)
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days `iso` is past `today` (positive only when overdue). */
export function daysOverdue(
  dueDateIso: string,
  todayIsoStr = todayIso(),
): number {
  const due = new Date(`${dueDateIso}T00:00:00Z`).getTime();
  const today = new Date(`${todayIsoStr}T00:00:00Z`).getTime();
  if (Number.isNaN(due) || Number.isNaN(today)) return 0;
  return Math.floor((today - due) / 86_400_000);
}

/**
 * Parse a comma-separated reminder-day config into a sorted, de-duplicated list
 * of positive integers, e.g. "30, 3,14,3" → [3, 14, 30].
 */
export function parseReminderDays(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Canonical string form of a reminder-day config (sorted, de-duplicated). */
export function normalizeReminderDays(raw: string | null | undefined): string {
  return parseReminderDays(raw).join(",");
}

// ---------------------------------------------------------------------------
// Billing settings (singleton)
// ---------------------------------------------------------------------------

export async function ensureBillingSettings(): Promise<BillingSettings> {
  const [existing] = await db
    .select()
    .from(billingSettingsTable)
    .where(eq(billingSettingsTable.id, SETTINGS_ID));
  if (existing) return existing;
  const [created] = await db
    .insert(billingSettingsTable)
    .values({ id: SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
    .select()
    .from(billingSettingsTable)
    .where(eq(billingSettingsTable.id, SETTINGS_ID));
  return row;
}

export function serializeSettings(row: BillingSettings) {
  return {
    id: row.id,
    supplierName: row.supplierName,
    supplierIc: row.supplierIc,
    supplierDic: row.supplierDic,
    supplierAddress: row.supplierAddress,
    supplierEmail: row.supplierEmail,
    supplierPhone: row.supplierPhone,
    bankAccount: row.bankAccount,
    iban: row.iban,
    bic: row.bic,
    defaultDueDays: row.defaultDueDays,
    defaultPaymentMethod: row.defaultPaymentMethod,
    vatPayer: row.vatPayer,
    vatModeDefault: row.vatModeDefault as VatMode,
    invoiceFooterNote: row.invoiceFooterNote,
    materialMarkupPercent: num(row.materialMarkupPercent),
    transportRatePerKm: num(row.transportRatePerKm),
    marginAlertThresholdPercent: num(row.marginAlertThresholdPercent),
    numberPrefix: row.numberPrefix,
    numberFormat: row.numberFormat,
    numberYear: row.numberYear,
    numberNextSeq: row.numberNextSeq,
    advanceNumberPrefix: row.advanceNumberPrefix,
    advanceNumberFormat: row.advanceNumberFormat,
    advanceNumberYear: row.advanceNumberYear,
    advanceNumberNextSeq: row.advanceNumberNextSeq,
    reminderEnabled: row.reminderEnabled,
    reminderDays: row.reminderDays,
    quoteNumberPrefix: row.quoteNumberPrefix,
    quoteNumberNextSeq: row.quoteNumberNextSeq,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface BillingSettingsInput {
  supplierName?: string;
  supplierIc?: string | null;
  supplierDic?: string | null;
  supplierAddress?: string | null;
  supplierEmail?: string | null;
  supplierPhone?: string | null;
  bankAccount?: string | null;
  iban?: string | null;
  bic?: string | null;
  defaultDueDays?: number;
  defaultPaymentMethod?: string;
  vatPayer?: boolean;
  vatModeDefault?: VatMode;
  invoiceFooterNote?: string | null;
  materialMarkupPercent?: number;
  transportRatePerKm?: number;
  marginAlertThresholdPercent?: number;
  numberPrefix?: string;
  numberFormat?: string;
  numberYear?: number | null;
  numberNextSeq?: number;
  advanceNumberPrefix?: string;
  advanceNumberFormat?: string;
  advanceNumberYear?: number | null;
  advanceNumberNextSeq?: number;
  reminderEnabled?: boolean;
  reminderDays?: string;
  quoteNumberPrefix?: string;
  quoteNumberNextSeq?: number;
}

export async function updateBillingSettings(
  input: BillingSettingsInput,
): Promise<BillingSettings> {
  await ensureBillingSettings();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const assign = <K extends keyof BillingSettingsInput>(
    key: K,
    col: string,
  ) => {
    if (input[key] !== undefined) set[col] = input[key];
  };
  assign("supplierName", "supplierName");
  assign("supplierIc", "supplierIc");
  assign("supplierDic", "supplierDic");
  assign("supplierAddress", "supplierAddress");
  assign("supplierEmail", "supplierEmail");
  assign("supplierPhone", "supplierPhone");
  assign("bankAccount", "bankAccount");
  assign("iban", "iban");
  assign("bic", "bic");
  assign("defaultDueDays", "defaultDueDays");
  assign("defaultPaymentMethod", "defaultPaymentMethod");
  assign("vatPayer", "vatPayer");
  assign("vatModeDefault", "vatModeDefault");
  assign("invoiceFooterNote", "invoiceFooterNote");
  if (input.materialMarkupPercent !== undefined) {
    if (
      !Number.isFinite(input.materialMarkupPercent) ||
      input.materialMarkupPercent < 0
    ) {
      throw appError(400, "Přirážka na materiál nesmí být záporná.");
    }
    set.materialMarkupPercent = String(round2(input.materialMarkupPercent));
  }
  if (input.transportRatePerKm !== undefined) {
    if (
      !Number.isFinite(input.transportRatePerKm) ||
      input.transportRatePerKm < 0
    ) {
      throw appError(400, "Cena dopravy za kilometr nesmí být záporná.");
    }
    set.transportRatePerKm = String(round2(input.transportRatePerKm));
  }
  if (input.marginAlertThresholdPercent !== undefined) {
    if (!Number.isFinite(input.marginAlertThresholdPercent)) {
      throw appError(400, "Prahová hodnota marže musí být číslo.");
    }
    set.marginAlertThresholdPercent = String(
      round2(input.marginAlertThresholdPercent),
    );
  }
  assign("numberPrefix", "numberPrefix");
  assign("numberFormat", "numberFormat");
  if (input.numberNextSeq !== undefined && input.numberNextSeq < 1) {
    throw appError(400, "Další číslo v řadě musí být alespoň 1.");
  }
  assign("numberYear", "numberYear");
  assign("numberNextSeq", "numberNextSeq");
  assign("advanceNumberPrefix", "advanceNumberPrefix");
  assign("advanceNumberFormat", "advanceNumberFormat");
  if (
    input.advanceNumberNextSeq !== undefined &&
    input.advanceNumberNextSeq < 1
  ) {
    throw appError(400, "Další číslo zálohové faktury musí být alespoň 1.");
  }
  assign("advanceNumberYear", "advanceNumberYear");
  assign("advanceNumberNextSeq", "advanceNumberNextSeq");
  assign("reminderEnabled", "reminderEnabled");
  if (input.reminderDays !== undefined) {
    set.reminderDays = normalizeReminderDays(input.reminderDays);
  }
  assign("quoteNumberPrefix", "quoteNumberPrefix");
  if (input.quoteNumberNextSeq !== undefined && input.quoteNumberNextSeq < 1) {
    throw appError(400, "Další číslo nabídky musí být alespoň 1.");
  }
  assign("quoteNumberNextSeq", "quoteNumberNextSeq");
  const [row] = await db
    .update(billingSettingsTable)
    .set(set)
    .where(eq(billingSettingsTable.id, SETTINGS_ID))
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Per-category material markup rules
// ---------------------------------------------------------------------------

export function serializeMarkupRule(row: MaterialMarkupRule) {
  return {
    id: row.id,
    category: row.category,
    markupPercent: num(row.markupPercent),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMaterialMarkupRules() {
  const rows = await db
    .select()
    .from(materialMarkupRulesTable)
    .orderBy(asc(materialMarkupRulesTable.category));
  return rows.map(serializeMarkupRule);
}

export interface MaterialMarkupRuleInput {
  category: string;
  markupPercent: number;
}

/** Insert-or-update the markup rule for a category (matched case-insensitively). */
export async function upsertMaterialMarkupRule(input: MaterialMarkupRuleInput) {
  const category = input.category.trim();
  if (!category) throw appError(400, "Kategorie nesmí být prázdná.");
  if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0) {
    throw appError(400, "Přirážka nesmí být záporná.");
  }
  const markup = String(round2(input.markupPercent));
  // Category uniqueness is case-insensitive (functional unique index on
  // lower(category)). Resolve any existing rule the same way, then update in
  // place or insert, within one transaction to avoid a race.
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialMarkupRulesTable)
      .where(
        sql`lower(${materialMarkupRulesTable.category}) = lower(${category})`,
      )
      .limit(1);
    if (existing) {
      const [updated] = await tx
        .update(materialMarkupRulesTable)
        .set({ category, markupPercent: markup, updatedAt: new Date() })
        .where(eq(materialMarkupRulesTable.id, existing.id))
        .returning();
      return updated;
    }
    const [inserted] = await tx
      .insert(materialMarkupRulesTable)
      .values({ category, markupPercent: markup })
      .returning();
    return inserted;
  });
  return serializeMarkupRule(row);
}

export async function deleteMaterialMarkupRule(id: number): Promise<boolean> {
  const deleted = await db
    .delete(materialMarkupRulesTable)
    .where(eq(materialMarkupRulesTable.id, id))
    .returning({ id: materialMarkupRulesTable.id });
  return deleted.length > 0;
}

/**
 * Build a resolver that maps a job-material NAME to its category-default markup
 * percent (or null when no rule applies). A material's "type" is taken from the
 * warehouse-catalogue item it matches by normalized name; that item's category
 * is then looked up in the markup rules. Categories are matched
 * case-insensitively. Returns `() => null` when no rules exist (fast path).
 */
async function buildCategoryMarkupResolver(
  exec: DbOrTx,
): Promise<(name: string | null | undefined) => number | null> {
  const rules = await exec.select().from(materialMarkupRulesTable);
  if (!rules.length) return () => null;
  // category (lower-cased) → markup percent
  const markupByCategory = new Map<string, number>();
  for (const r of rules) {
    markupByCategory.set(r.category.trim().toLowerCase(), num(r.markupPercent));
  }

  const items = await exec
    .select({
      name: warehouseItemsTable.name,
      normalizedName: warehouseItemsTable.normalizedName,
      category: warehouseItemsTable.category,
    })
    .from(warehouseItemsTable)
    .where(isNotNull(warehouseItemsTable.category));

  // normalized material name → category-default markup percent
  const markupByNormName = new Map<string, number>();
  for (const it of items) {
    if (!it.category) continue;
    const markup = markupByCategory.get(it.category.trim().toLowerCase());
    if (markup == null) continue;
    const key = it.normalizedName?.trim() || normalizeItemName(it.name);
    if (key) markupByNormName.set(key, markup);
  }
  if (!markupByNormName.size) return () => null;

  return (name) => {
    const key = normalizeItemName(name);
    if (!key) return null;
    const hit = markupByNormName.get(key);
    return hit == null ? null : hit;
  };
}

/**
 * Resolve the category-default markup for a job material by name, exposed for
 * the unbilled-detail endpoint so the create UI can display effective markups.
 */
async function getCategoryMarkupByName(
  names: string[],
): Promise<Map<string, number | null>> {
  const resolver = await buildCategoryMarkupResolver(db);
  const out = new Map<string, number | null>();
  for (const n of names) out.set(n, resolver(n));
  return out;
}

// ---------------------------------------------------------------------------
// Unbilled jobs (done, explicitly billable, not reserved by another draft)
// ---------------------------------------------------------------------------

async function getBilledJobIds(): Promise<number[]> {
  const rows = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.documentType, "standard"),
        isNotNull(invoiceSourceLinksTable.jobId),
      ),
    );
  return rows.map((r) => r.jobId).filter((x): x is number => x != null);
}

interface UnbilledJobRow {
  job: typeof jobsTable.$inferSelect;
  customer: typeof customersTable.$inferSelect | null;
}

async function getUnbilledDoneJobs(
  customerId?: number,
): Promise<UnbilledJobRow[]> {
  const billedIds = await getBilledJobIds();
  const conditions = [
    eq(jobsTable.status, "done"),
    eq(jobsTable.billingIntent, "billable"),
    isNull(jobsTable.archivedAt),
  ];
  if (customerId != null) conditions.push(eq(jobsTable.customerId, customerId));
  if (billedIds.length) conditions.push(notInArray(jobsTable.id, billedIds));
  const rows = await db
    .select({ job: jobsTable, customer: customersTable })
    .from(jobsTable)
    .leftJoin(customersTable, eq(jobsTable.customerId, customersTable.id))
    .where(and(...conditions))
    .orderBy(desc(jobsTable.date));
  return rows;
}

interface JobAutomaticBillingAggregate {
  materialTotal: number;
  recordedWorkAmount: number;
  recordedSessionCount: number;
}

async function getJobAutomaticBillingAggregates(
  jobIds: number[],
): Promise<Map<number, JobAutomaticBillingAggregate>> {
  const out = new Map<number, JobAutomaticBillingAggregate>();
  for (const jobId of jobIds) {
    out.set(jobId, {
      materialTotal: 0,
      recordedWorkAmount: 0,
      recordedSessionCount: 0,
    });
  }
  if (!jobIds.length) return out;

  const [materialRows, workRows] = await Promise.all([
    db
      .select({
        jobId: materialsTable.jobId,
        total:
          sql<number>`coalesce(sum(coalesce(${materialsTable.quantity}, 1) * ${materialsTable.pricePerUnit}), 0)`.mapWith(
            Number,
          ),
      })
      .from(materialsTable)
      .where(
        and(
          inArray(materialsTable.jobId, jobIds),
          eq(materialsTable.done, true),
          isNotNull(materialsTable.pricePerUnit),
          isNull(materialsTable.invoicedInvoiceId),
        ),
      )
      .groupBy(materialsTable.jobId),
    db
      .select({
        jobId: workSessionsTable.jobId,
        durationSeconds: workSessionsTable.durationSeconds,
        saleRateSnapshot: workSessionsTable.saleRateSnapshot,
      })
      .from(workSessionsTable)
      .where(
        and(
          inArray(workSessionsTable.jobId, jobIds),
          eq(workSessionsTable.status, "completed"),
          eq(workSessionsTable.billingStatus, "unbilled"),
        ),
      ),
  ]);

  for (const row of materialRows) {
    const aggregate = out.get(row.jobId);
    if (aggregate) aggregate.materialTotal = round2(num(row.total));
  }
  for (const row of workRows) {
    if (row.jobId == null) continue;
    const hours = round2((row.durationSeconds ?? 0) / 3600);
    if (hours === 0) continue;
    const aggregate = out.get(row.jobId);
    if (!aggregate) continue;
    aggregate.recordedSessionCount += 1;
    if (row.saleRateSnapshot != null) {
      aggregate.recordedWorkAmount = round2(
        aggregate.recordedWorkAmount + hours * num(row.saleRateSnapshot),
      );
    }
  }
  return out;
}

function automaticJobLabourTotal(
  job: typeof jobsTable.$inferSelect,
  aggregate: JobAutomaticBillingAggregate,
): number {
  if (job.pricingMode === "fixed_price") {
    return round2(num(job.contractPrice ?? job.price));
  }
  if (aggregate.recordedSessionCount > 0) {
    return round2(aggregate.recordedWorkAmount);
  }
  return round2(num(job.price));
}

function effectiveTransportCost(
  job: Pick<typeof jobsTable.$inferSelect, "transportCost" | "transportKm">,
  transportRatePerKm: number,
): number {
  const explicitCost = num(job.transportCost);
  if (explicitCost > 0) return round2(explicitCost);
  return round2(
    Math.max(0, num(job.transportKm)) * Math.max(0, transportRatePerKm),
  );
}

function jobOrientationalTotal(
  job: typeof jobsTable.$inferSelect,
  aggregate: JobAutomaticBillingAggregate,
  transportRatePerKm: number,
): number {
  const materialTotal =
    job.pricingMode === "fixed_price" ? 0 : aggregate.materialTotal;
  return round2(
    automaticJobLabourTotal(job, aggregate) +
      materialTotal +
      effectiveTransportCost(job, transportRatePerKm) +
      num(job.parking),
  );
}

// ---------------------------------------------------------------------------
// Unbilled activities (dlouhodobé akce: completed, not fully billed and not
// reserved by another draft). Issued partial invoices deliberately do not hide
// the whole activity; raw-source allocations prevent duplicate billing.
// ---------------------------------------------------------------------------

async function getBilledActivityIds(): Promise<number[]> {
  const rows = await db
    .select({ activityId: invoiceSourceLinksTable.activityId })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.documentType, "standard"),
        isNotNull(invoiceSourceLinksTable.activityId),
      ),
    );
  return rows.map((r) => r.activityId).filter((x): x is number => x != null);
}

interface UnbilledActivityRow {
  activity: typeof activitiesTable.$inferSelect;
  customer: typeof customersTable.$inferSelect | null;
}

async function getUnbilledDoneActivities(
  customerId?: number,
): Promise<UnbilledActivityRow[]> {
  const billedIds = await getBilledActivityIds();
  const conditions = [
    isNotNull(activitiesTable.completedAt),
    eq(activitiesTable.isArchived, false),
    or(
      isNull(activitiesTable.billingStatus),
      ne(activitiesTable.billingStatus, "billed"),
    )!,
  ];
  if (customerId != null)
    conditions.push(eq(activitiesTable.customerId, customerId));
  if (billedIds.length)
    conditions.push(notInArray(activitiesTable.id, billedIds));
  const rows = await db
    .select({ activity: activitiesTable, customer: customersTable })
    .from(activitiesTable)
    .leftJoin(customersTable, eq(activitiesTable.customerId, customersTable.id))
    .where(and(...conditions))
    .orderBy(desc(activitiesTable.completedAt));
  return rows;
}

interface ActivityBillingAggregate {
  materialsTotal: number;
  extraWorksTotal: number;
  recordedWorkAmount: number;
}

/** Per-activity billable totals: material purchase price + extra-work amounts. */
async function getActivityBillingAggregates(
  activityIds: number[],
): Promise<Map<number, ActivityBillingAggregate>> {
  const out = new Map<number, ActivityBillingAggregate>();
  for (const id of activityIds)
    out.set(id, {
      materialsTotal: 0,
      extraWorksTotal: 0,
      recordedWorkAmount: 0,
    });
  if (!activityIds.length) return out;

  const mats = await db
    .select({
      activityId: activityMaterialsTable.activityId,
      total:
        sql<number>`coalesce(sum(${activityMaterialsTable.quantity} * ${activityMaterialsTable.pricePerUnit}), 0)`.mapWith(
          Number,
        ),
    })
    .from(activityMaterialsTable)
    .where(inArray(activityMaterialsTable.activityId, activityIds))
    .groupBy(activityMaterialsTable.activityId);
  for (const m of mats) {
    const entry = out.get(m.activityId);
    if (entry) entry.materialsTotal = round2(num(m.total));
  }

  const works = await db
    .select({
      activityId: activityExtraWorksTable.activityId,
      total:
        sql<number>`coalesce(sum(${activityExtraWorksTable.amount}), 0)`.mapWith(
          Number,
        ),
    })
    .from(activityExtraWorksTable)
    .where(inArray(activityExtraWorksTable.activityId, activityIds))
    .groupBy(activityExtraWorksTable.activityId);
  for (const w of works) {
    const entry = out.get(w.activityId);
    if (entry) entry.extraWorksTotal = round2(num(w.total));
  }

  const workSessions = await db
    .select({
      activityId: workSessionsTable.activityId,
      durationSeconds: workSessionsTable.durationSeconds,
      saleRateSnapshot: workSessionsTable.saleRateSnapshot,
    })
    .from(workSessionsTable)
    .where(
      and(
        inArray(workSessionsTable.activityId, activityIds),
        eq(workSessionsTable.status, "completed"),
        eq(workSessionsTable.billingStatus, "unbilled"),
      ),
    );
  for (const session of workSessions) {
    if (session.activityId == null || session.saleRateSnapshot == null)
      continue;
    const hours = round2((session.durationSeconds ?? 0) / 3600);
    if (hours === 0) continue;
    const entry = out.get(session.activityId);
    if (entry) {
      entry.recordedWorkAmount = round2(
        entry.recordedWorkAmount + hours * num(session.saleRateSnapshot),
      );
    }
  }

  return out;
}

function activityOrientationalTotal(agg: ActivityBillingAggregate): number {
  return round2(
    agg.materialsTotal + agg.extraWorksTotal + agg.recordedWorkAmount,
  );
}

export interface ReadyToBillSummary {
  jobsCount: number;
  activitiesCount: number;
  count: number;
  jobsWithoutVat: number;
  activitiesWithoutVat: number;
  totalWithoutVat: number;
  oldestDoneAt: string | null;
  oldestDays: number | null;
  overdueCustomers: number;
}

async function computeReadyToBillSummary(): Promise<ReadyToBillSummary> {
  const [unbilledJobs, settings, activityRows] = await Promise.all([
    getUnbilledDoneJobs(),
    ensureBillingSettings(),
    getUnbilledDoneActivities(),
  ]);
  const unbilledActivities = activityRows.filter(
    (row) => row.activity.customerId != null && row.customer,
  );
  const transportRatePerKm = num(settings.transportRatePerKm);
  const [jobAggregates, activityAggregates] = await Promise.all([
    getJobAutomaticBillingAggregates(unbilledJobs.map((row) => row.job.id)),
    getActivityBillingAggregates(
      unbilledActivities.map((row) => row.activity.id),
    ),
  ]);
  const jobsTotal = unbilledJobs.reduce(
    (acc, row) =>
      acc +
      jobOrientationalTotal(
        row.job,
        jobAggregates.get(row.job.id) ?? {
          materialTotal: 0,
          recordedWorkAmount: 0,
          recordedSessionCount: 0,
        },
        transportRatePerKm,
      ),
    0,
  );
  const activitiesTotal = unbilledActivities.reduce((acc, row) => {
    const aggregate = activityAggregates.get(row.activity.id);
    return acc + (aggregate ? activityOrientationalTotal(aggregate) : 0);
  }, 0);
  const oldestDoneAt = unbilledJobs.reduce<string | null>(
    (oldest, row) =>
      row.job.date != null && (oldest == null || row.job.date < oldest)
        ? row.job.date
        : oldest,
    null,
  );
  const currentDate = todayIso();
  const overdueThreshold = addDaysIso(currentDate, -7);
  const overdueCustomers = new Set(
    unbilledJobs
      .filter(
        (row) =>
          row.job.customerId != null &&
          row.job.date != null &&
          row.job.date < overdueThreshold,
      )
      .map((row) => row.job.customerId),
  ).size;

  return {
    jobsCount: unbilledJobs.length,
    activitiesCount: unbilledActivities.length,
    count: unbilledJobs.length + unbilledActivities.length,
    jobsWithoutVat: round2(jobsTotal),
    activitiesWithoutVat: round2(activitiesTotal),
    totalWithoutVat: round2(jobsTotal + activitiesTotal),
    oldestDoneAt,
    oldestDays:
      oldestDoneAt == null
        ? null
        : Math.max(0, daysOverdue(oldestDoneAt, currentDate)),
    overdueCustomers,
  };
}

let readyToBillSummaryInFlight: Promise<ReadyToBillSummary> | null = null;

export function getReadyToBillSummary(): Promise<ReadyToBillSummary> {
  if (readyToBillSummaryInFlight) return readyToBillSummaryInFlight;
  readyToBillSummaryInFlight = computeReadyToBillSummary().finally(() => {
    readyToBillSummaryInFlight = null;
  });
  return readyToBillSummaryInFlight;
}

export async function getBillingSummary() {
  const readyToBill = await getReadyToBillSummary();

  // Existing invoice lifecycle metrics.
  const allInvoices = await db
    .select({
      status: invoicesTable.status,
      totalWithVat: invoicesTable.totalWithVat,
      issueDate: invoicesTable.issueDate,
      dueDate: invoicesTable.dueDate,
      paidDate: invoicesTable.paidDate,
      paidAmount: invoicesTable.paidAmount,
    })
    .from(invoicesTable);

  const draftCount = allInvoices.filter((i) => i.status === "draft").length;
  const issuedCount = allInvoices.filter((i) =>
    ["issued", "sent", "paid"].includes(i.status),
  ).length;

  const month = todayIso().slice(0, 7);
  const issuedThisMonthWithVat = round2(
    allInvoices
      .filter(
        (i) =>
          i.status !== "cancelled" &&
          typeof i.issueDate === "string" &&
          i.issueDate.startsWith(month),
      )
      .reduce((acc, i) => acc + num(i.totalWithVat), 0),
  );

  // Outstanding receivables: invoices handed to the customer (issued/sent) that
  // are neither paid nor cancelled. Drafts are not yet real receivables.
  const today = todayIso();
  const unpaidInvoices = allInvoices.filter(
    (i) => i.status === "issued" || i.status === "sent",
  );
  const unpaidTotalWithVat = round2(
    unpaidInvoices.reduce((acc, i) => acc + num(i.totalWithVat), 0),
  );
  // ISO "YYYY-MM-DD" strings compare lexicographically by calendar date.
  const overdueInvoices = unpaidInvoices.filter(
    (i) => typeof i.dueDate === "string" && i.dueDate < today,
  );
  const overdueTotalWithVat = round2(
    overdueInvoices.reduce((acc, i) => acc + num(i.totalWithVat), 0),
  );

  // Cash actually received this calendar month, by payment date (paidDate) —
  // not by issue date. Uses paidAmount when recorded, else the invoice total.
  const paidThisMonthInvoices = allInvoices.filter(
    (i) =>
      i.status !== "cancelled" &&
      typeof i.paidDate === "string" &&
      i.paidDate.startsWith(month),
  );
  const paidThisMonthWithVat = round2(
    paidThisMonthInvoices.reduce(
      (acc, i) =>
        acc + (i.paidAmount != null ? num(i.paidAmount) : num(i.totalWithVat)),
      0,
    ),
  );

  return {
    unbilledDoneJobs: readyToBill.jobsCount,
    unbilledActivities: readyToBill.activitiesCount,
    draftInvoices: draftCount,
    issuedInvoices: issuedCount,
    totalToInvoiceWithoutVat: readyToBill.totalWithoutVat,
    issuedThisMonthWithVat,
    paidThisMonthCount: paidThisMonthInvoices.length,
    paidThisMonthWithVat,
    unpaidCount: unpaidInvoices.length,
    unpaidTotalWithVat,
    overdueCount: overdueInvoices.length,
    overdueTotalWithVat,
    overdueUnbilledCustomers: readyToBill.overdueCustomers,
  };
}

export async function getCustomerUnbilledValueSummary(
  customerId: number,
): Promise<{
  unbilledJobsValue: number;
  unbilledJobCount: number;
}> {
  const [rows, settings] = await Promise.all([
    getUnbilledDoneJobs(customerId),
    ensureBillingSettings(),
  ]);
  const transportRatePerKm = num(settings.transportRatePerKm);
  const jobAggregates = await getJobAutomaticBillingAggregates(
    rows.map((row) => row.job.id),
  );
  return {
    unbilledJobsValue: round2(
      rows.reduce((acc, { job }) => {
        const aggregate = jobAggregates.get(job.id) ?? {
          materialTotal: 0,
          recordedWorkAmount: 0,
          recordedSessionCount: 0,
        };
        return acc + jobOrientationalTotal(job, aggregate, transportRatePerKm);
      }, 0),
    ),
    unbilledJobCount: rows.length,
  };
}

export async function listUnbilledCustomers() {
  const [rows, settings] = await Promise.all([
    getUnbilledDoneJobs(),
    ensureBillingSettings(),
  ]);
  const transportRatePerKm = num(settings.transportRatePerKm);
  const jobAggregates = await getJobAutomaticBillingAggregates(
    rows.map((row) => row.job.id),
  );
  const byCustomer = new Map<
    number,
    {
      customerId: number;
      companyName: string;
      jobCount: number;
      activityCount: number;
      totalPrice: number;
      totalTransportCost: number;
      totalParking: number;
      totalFines: number;
      orientationalTotal: number;
      oldestJobDate: string | null;
    }
  >();
  const emptyEntry = (customerId: number, companyName: string) => ({
    customerId,
    companyName,
    jobCount: 0,
    activityCount: 0,
    totalPrice: 0,
    totalTransportCost: 0,
    totalParking: 0,
    totalFines: 0,
    orientationalTotal: 0,
    oldestJobDate: null as string | null,
  });
  for (const { job, customer } of rows) {
    if (job.customerId == null || !customer) continue;
    const jobAggregate = jobAggregates.get(job.id) ?? {
      materialTotal: 0,
      recordedWorkAmount: 0,
      recordedSessionCount: 0,
    };
    const entry =
      byCustomer.get(job.customerId) ??
      emptyEntry(job.customerId, customer.companyName);
    entry.jobCount += 1;
    entry.totalPrice += automaticJobLabourTotal(job, jobAggregate);
    entry.totalTransportCost += effectiveTransportCost(job, transportRatePerKm);
    entry.totalParking += num(job.parking);
    entry.totalFines += num(job.fines);
    entry.orientationalTotal += jobOrientationalTotal(
      job,
      jobAggregate,
      transportRatePerKm,
    );
    if (job.date != null) {
      if (entry.oldestJobDate == null || job.date < entry.oldestJobDate) {
        entry.oldestJobDate = job.date;
      }
    }
    byCustomer.set(job.customerId, entry);
  }

  // Fold completed actions into the same per-customer rollup; customers with
  // only activities (no unbilled jobs) appear too.
  const activityRows = await getUnbilledDoneActivities();
  const activityAggregates = await getActivityBillingAggregates(
    activityRows.map((r) => r.activity.id),
  );
  for (const { activity, customer } of activityRows) {
    if (activity.customerId == null || !customer) continue;
    const entry =
      byCustomer.get(activity.customerId) ??
      emptyEntry(activity.customerId, customer.companyName);
    const agg = activityAggregates.get(activity.id);
    entry.activityCount += 1;
    entry.orientationalTotal += agg ? activityOrientationalTotal(agg) : 0;
    byCustomer.set(activity.customerId, entry);
  }

  const todayStr = todayIso();
  return Array.from(byCustomer.values())
    .map((e) => {
      const daysUnbilled =
        e.oldestJobDate != null
          ? Math.max(0, daysOverdue(e.oldestJobDate, todayStr))
          : null;
      return {
        customerId: e.customerId,
        companyName: e.companyName,
        jobCount: e.jobCount,
        activityCount: e.activityCount,
        totalPrice: round2(e.totalPrice),
        totalTransportCost: round2(e.totalTransportCost),
        totalParking: round2(e.totalParking),
        totalFines: round2(e.totalFines),
        orientationalTotal: round2(e.orientationalTotal),
        oldestDoneAt: e.oldestJobDate ?? null,
        daysUnbilled,
      };
    })
    .sort((a, b) => b.orientationalTotal - a.orientationalTotal);
}

export async function getUnbilledCustomerDetail(customerId: number) {
  const [[customer], settings] = await Promise.all([
    db.select().from(customersTable).where(eq(customersTable.id, customerId)),
    ensureBillingSettings(),
  ]);
  if (!customer) throw appError(404, "Zákazník nenalezen.");
  const transportRatePerKm = num(settings.transportRatePerKm);

  const rows = await getUnbilledDoneJobs(customerId);
  const jobIds = rows.map((r) => r.job.id);
  const materials = jobIds.length
    ? await db
        .select()
        .from(materialsTable)
        .where(
          and(
            inArray(materialsTable.jobId, jobIds),
            eq(materialsTable.done, true),
          ),
        )
    : [];
  const materialsByJob = new Map<
    number,
    (typeof materialsTable.$inferSelect)[]
  >();
  for (const m of materials) {
    const list = materialsByJob.get(m.jobId) ?? [];
    list.push(m);
    materialsByJob.set(m.jobId, list);
  }

  // Resolve each billable material's category-default markup once so the create
  // UI can show effective markups (override → category → invoice/settings).
  const billableMaterialNames = materials
    .filter((m) => m.pricePerUnit != null && m.invoicedInvoiceId == null)
    .map((m) => m.name);
  const categoryMarkupByName = await getCategoryMarkupByName(
    billableMaterialNames,
  );

  const detailTodayStr = todayIso();
  const jobs = rows.map(({ job }) => ({
    id: job.id,
    jobNumber: job.jobNumber,
    title: job.title,
    date: job.date,
    type: job.type,
    status: job.status,
    price: round2(num(job.price)),
    pricingMode:
      job.pricingMode === "fixed_price" ? "fixed_price" : "time_material",
    contractPrice:
      job.contractPrice == null ? null : round2(num(job.contractPrice)),
    transportKm: round2(num(job.transportKm)),
    transportCost: effectiveTransportCost(job, transportRatePerKm),
    transportCostCalculated:
      num(job.transportCost) <= 0 &&
      num(job.transportKm) > 0 &&
      transportRatePerKm > 0,
    transportRatePerKm: round2(transportRatePerKm),
    parking: round2(num(job.parking)),
    fines: round2(num(job.fines)),
    daysUnbilled:
      job.date != null
        ? Math.max(0, daysOverdue(job.date, detailTodayStr))
        : null,
    materials: (materialsByJob.get(job.id) ?? [])
      .filter((m) => m.pricePerUnit != null && m.invoicedInvoiceId == null)
      .map((m) => ({
        id: m.id,
        name: m.name,
        quantity: round2(num(m.quantity ?? 1)),
        unit: m.unit,
        pricePerUnit: round2(num(m.pricePerUnit)),
        // Category-default markup (%) resolved from the matching catalogue
        // item, or null when no category rule applies (falls back to default).
        categoryMarkupPercent: categoryMarkupByName.get(m.name) ?? null,
      })),
  }));

  // Completed actions (dlouhodobé akce) for this customer, with their billable
  // materials and extra works so the create UI can render and select them.
  const activityRows = await getUnbilledDoneActivities(customerId);
  const activityIds = activityRows.map((r) => r.activity.id);
  const activityMaterials = activityIds.length
    ? await db
        .select()
        .from(activityMaterialsTable)
        .where(inArray(activityMaterialsTable.activityId, activityIds))
    : [];
  const activityExtraWorks = activityIds.length
    ? await db
        .select()
        .from(activityExtraWorksTable)
        .where(inArray(activityExtraWorksTable.activityId, activityIds))
    : [];
  const matsByActivity = new Map<
    number,
    (typeof activityMaterialsTable.$inferSelect)[]
  >();
  for (const m of activityMaterials) {
    const list = matsByActivity.get(m.activityId) ?? [];
    list.push(m);
    matsByActivity.set(m.activityId, list);
  }
  const worksByActivity = new Map<
    number,
    (typeof activityExtraWorksTable.$inferSelect)[]
  >();
  for (const w of activityExtraWorks) {
    const list = worksByActivity.get(w.activityId) ?? [];
    list.push(w);
    worksByActivity.set(w.activityId, list);
  }
  const activityMaterialNames = activityMaterials
    .filter((m) => m.pricePerUnit != null)
    .map((m) => m.name);
  const activityCategoryMarkup = await getCategoryMarkupByName(
    activityMaterialNames,
  );

  const activities = activityRows.map(({ activity }) => ({
    id: activity.id,
    name: activity.name,
    completedAt: activity.completedAt
      ? activity.completedAt.toISOString()
      : null,
    materials: (matsByActivity.get(activity.id) ?? [])
      .filter((m) => m.pricePerUnit != null)
      .map((m) => ({
        id: m.id,
        name: m.name,
        quantity: round2(num(m.quantity ?? 1)),
        unit: m.unit,
        pricePerUnit: round2(num(m.pricePerUnit)),
        categoryMarkupPercent: activityCategoryMarkup.get(m.name) ?? null,
      })),
    extraWorks: (worksByActivity.get(activity.id) ?? []).map((w) => ({
      id: w.id,
      description: w.description,
      amount: round2(num(w.amount)),
    })),
  }));

  const parentFilters = [];
  if (jobIds.length)
    parentFilters.push(inArray(workSessionsTable.jobId, jobIds));
  if (activityIds.length)
    parentFilters.push(inArray(workSessionsTable.activityId, activityIds));
  const workRows = parentFilters.length
    ? await db
        .select({ session: workSessionsTable, personName: peopleTable.name })
        .from(workSessionsTable)
        .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
        .where(
          and(
            or(...parentFilters),
            eq(workSessionsTable.status, "completed"),
            eq(workSessionsTable.billingStatus, "unbilled"),
          ),
        )
    : [];
  type Preview = {
    sessionCount: number;
    hours: number;
    amount: number;
    missingRateCount: number;
    needsReviewCount: number;
    workers: Set<string>;
  };
  const previews = new Map<string, Preview>();
  for (const { session, personName } of workRows) {
    const key =
      session.jobId != null
        ? `job:${session.jobId}`
        : `activity:${session.activityId}`;
    const preview = previews.get(key) ?? {
      sessionCount: 0,
      hours: 0,
      amount: 0,
      missingRateCount: 0,
      needsReviewCount: 0,
      workers: new Set<string>(),
    };
    const seconds = session.durationSeconds ?? 0;
    const billableHours = round2(seconds / 3600);
    if (billableHours === 0) continue;
    preview.sessionCount += 1;
    preview.hours += billableHours;
    if (session.saleRateSnapshot == null) preview.missingRateCount += 1;
    else preview.amount += billableHours * num(session.saleRateSnapshot);
    if (session.reviewStatus === "needs_review") preview.needsReviewCount += 1;
    preview.workers.add(personName);
    previews.set(key, preview);
  }
  const serializePreview = (key: string) => {
    const preview = previews.get(key);
    return preview
      ? {
          sessionCount: preview.sessionCount,
          hours: round2(preview.hours),
          amount: round2(preview.amount),
          missingRateCount: preview.missingRateCount,
          needsReviewCount: preview.needsReviewCount,
          workers: [...preview.workers].sort(),
        }
      : {
          sessionCount: 0,
          hours: 0,
          amount: 0,
          missingRateCount: 0,
          needsReviewCount: 0,
          workers: [],
        };
  };

  return {
    customerId: customer.id,
    companyName: customer.companyName,
    ic: customer.ic,
    dic: customer.dic,
    address: customer.address,
    email: customer.email,
    jobs: jobs.map((job) => ({
      ...job,
      recordedWork: serializePreview(`job:${job.id}`),
    })),
    activities: activities.map((activity) => ({
      ...activity,
      recordedWork: serializePreview(`activity:${activity.id}`),
    })),
  };
}

// ---------------------------------------------------------------------------
// Invoice serialization
// ---------------------------------------------------------------------------

export function serializeInvoice(row: Invoice) {
  return {
    id: row.id,
    documentType: row.documentType as "standard" | "advance",
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    customerId: row.customerId,
    customerName: row.customerName,
    customerIc: row.customerIc,
    customerDic: row.customerDic,
    customerAddress: row.customerAddress,
    customerDeliveryAddress: row.customerDeliveryAddress,
    customerEmail: row.customerEmail,
    issueDate: row.issueDate,
    taxableSupplyDate: row.taxableSupplyDate,
    dueDate: row.dueDate,
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    bankAccount: row.bankAccount,
    iban: row.iban,
    bic: row.bic,
    variableSymbol: row.variableSymbol,
    constantSymbol: row.constantSymbol,
    specificSymbol: row.specificSymbol,
    vatModeDefault: row.vatModeDefault,
    materialDisplayMode: normalizeMaterialDisplayMode(row.materialDisplayMode),
    subtotalWithoutVat: num(row.subtotalWithoutVat),
    totalVat: num(row.totalVat),
    totalWithVat: num(row.totalWithVat),
    notes: row.notes,
    paidDate: row.paidDate,
    paidAmount: row.paidAmount == null ? null : num(row.paidAmount),
    pdfObjectPath: row.pdfObjectPath,
    isdocObjectPath: row.isdocObjectPath,
    createdByUserId: row.createdByUserId,
    issuedByUserId: row.issuedByUserId,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    recurringTemplateId: row.recurringTemplateId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeLine(row: InvoiceLine) {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    jobId: row.jobId,
    activityId: row.activityId,
    rowType: row.rowType as "item" | "section",
    description: row.description,
    quantity: num(row.quantity),
    unit: row.unit,
    unitPriceWithoutVat: num(row.unitPriceWithoutVat),
    discountPercent:
      row.discountPercent == null ? null : num(row.discountPercent),
    vatRate: row.vatRate == null ? null : num(row.vatRate),
    vatMode: row.vatMode,
    totalWithoutVat: num(row.totalWithoutVat),
    totalVat: num(row.totalVat),
    totalWithVat: num(row.totalWithVat),
    sortOrder: row.sortOrder,
  };
}

export function serializeSourceAllocation(row: InvoiceSourceAllocation) {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceIdSnapshot: row.invoiceIdSnapshot,
    invoiceLineId: row.invoiceLineId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    jobId: row.jobId,
    activityId: row.activityId,
    sourceDescription: row.sourceDescription,
    sourceUnit: row.sourceUnit,
    originalQuantity: num(row.originalQuantity),
    allocatedQuantity: num(row.allocatedQuantity),
    sourceAmountWithoutVat: num(row.sourceAmountWithoutVat),
    status: row.status,
    settlementMethod: row.settlementMethod,
    legacyIncomplete: row.legacyIncomplete,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
  };
}

export async function getInvoiceDetail(id: number) {
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  if (!invoice) return null;
  const lines = await db
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, id))
    .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);
  const links = await db
    .select({
      jobId: invoiceSourceLinksTable.jobId,
      activityId: invoiceSourceLinksTable.activityId,
    })
    .from(invoiceSourceLinksTable)
    .where(eq(invoiceSourceLinksTable.invoiceId, id));
  const allocations = await db
    .select()
    .from(invoiceSourceAllocationsTable)
    .where(eq(invoiceSourceAllocationsTable.invoiceId, id))
    .orderBy(
      invoiceSourceAllocationsTable.jobId,
      invoiceSourceAllocationsTable.activityId,
      invoiceSourceAllocationsTable.id,
    );

  const linkedJobIds = links
    .map((l) => l.jobId)
    .filter((x): x is number => x != null);
  const linkedActivityIds = links
    .map((l) => l.activityId)
    .filter((x): x is number => x != null);

  const sourceJobs = linkedJobIds.length
    ? await db
        .select({
          id: jobsTable.id,
          jobNumber: jobsTable.jobNumber,
          title: jobsTable.title,
          date: jobsTable.date,
        })
        .from(jobsTable)
        .where(inArray(jobsTable.id, linkedJobIds))
    : [];
  const sourceActivities = linkedActivityIds.length
    ? await db
        .select({ id: activitiesTable.id, name: activitiesTable.name })
        .from(activitiesTable)
        .where(inArray(activitiesTable.id, linkedActivityIds))
    : [];

  const jobsWithOperationalLumpSources = new Set(
    allocations
      .filter(
        (allocation) =>
          allocation.jobId != null &&
          allocation.settlementMethod === "included_in_lump_sum" &&
          ["work_session", "material"].includes(allocation.sourceType),
      )
      .map((allocation) => allocation.jobId as number),
  );
  const sourceTotalWithoutVat = round2(
    allocations.reduce((total, allocation) => {
      if (
        ["deferred", "not_charged"].includes(allocation.settlementMethod) ||
        (allocation.sourceType === "job" &&
          allocation.jobId != null &&
          jobsWithOperationalLumpSources.has(allocation.jobId))
      ) {
        return total;
      }
      return total + num(allocation.sourceAmountWithoutVat);
    }, 0),
  );
  const countBy = (predicate: (row: InvoiceSourceAllocation) => boolean) =>
    allocations.filter(predicate).length;
  const allocationsByJob = new Map<number, InvoiceSourceAllocation[]>();
  for (const allocation of allocations) {
    if (allocation.jobId == null) continue;
    const rows = allocationsByJob.get(allocation.jobId) ?? [];
    rows.push(allocation);
    allocationsByJob.set(allocation.jobId, rows);
  }
  const sourceJobsWithBillingState = sourceJobs.map((job) => {
    const rows = allocationsByJob.get(job.id) ?? [];
    const hasDeferred = rows.some(
      (row) => row.settlementMethod === "deferred" || row.status === "deferred",
    );
    const hasFinal = rows.some((row) =>
      ["billed", "included_in_lump_sum", "not_charged"].includes(row.status),
    );
    const hasReserved = rows.some((row) => row.status === "reserved");
    return {
      ...job,
      billingState: hasReserved
        ? "draft"
        : hasDeferred && hasFinal
          ? "partial"
          : hasDeferred
            ? "ready"
            : hasFinal
              ? "billed"
              : "linked",
    };
  });

  return {
    ...serializeInvoice(invoice),
    lines: lines.map(serializeLine),
    presentationLines: presentInvoiceLines(
      lines,
      invoice.materialDisplayMode,
    ).map(serializeLine),
    presentationGroups: getStoredInvoicePresentationGroups(
      invoice.materialDisplayMode,
    ),
    sourceAllocations: allocations.map(serializeSourceAllocation),
    sourceSummary: {
      count: allocations.length,
      workCount: countBy((row) => row.sourceType === "work_session"),
      materialCount: countBy((row) => row.sourceType.includes("material")),
      otherCount: countBy(
        (row) =>
          row.sourceType !== "work_session" &&
          !row.sourceType.includes("material"),
      ),
      unresolvedCount: countBy(
        (row) =>
          row.status === "reserved" &&
          ![
            "direct",
            "included_in_lump_sum",
            "not_charged",
            "deferred",
          ].includes(row.settlementMethod),
      ),
      deferredCount: countBy(
        (row) =>
          row.settlementMethod === "deferred" || row.status === "deferred",
      ),
      sourceTotalWithoutVat,
      invoiceTotalWithoutVat: num(invoice.subtotalWithoutVat),
      differenceWithoutVat: round2(
        num(invoice.subtotalWithoutVat) - sourceTotalWithoutVat,
      ),
    },
    sourceJobIds: linkedJobIds,
    sourceActivityIds: linkedActivityIds,
    sourceJobs: sourceJobsWithBillingState,
    sourceActivities,
  };
}

export async function listInvoices(filter: {
  status?: string;
  customerId?: number;
}) {
  const conditions = [];
  if (filter.status) conditions.push(eq(invoicesTable.status, filter.status));
  if (filter.customerId != null) {
    conditions.push(eq(invoicesTable.customerId, filter.customerId));
  }
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoicesTable.createdAt));

  const invoiceIds = rows.map((r) => r.id);
  const sourceJobRows = invoiceIds.length
    ? await db
        .select({
          invoiceId: invoiceSourceLinksTable.invoiceId,
          id: jobsTable.id,
          jobNumber: jobsTable.jobNumber,
          title: jobsTable.title,
          date: jobsTable.date,
        })
        .from(invoiceSourceLinksTable)
        .innerJoin(jobsTable, eq(invoiceSourceLinksTable.jobId, jobsTable.id))
        .where(inArray(invoiceSourceLinksTable.invoiceId, invoiceIds))
    : [];

  const sourceJobsByInvoice = new Map<
    number,
    { id: number; jobNumber: number | null; title: string; date: string }[]
  >();
  for (const row of sourceJobRows) {
    const list = sourceJobsByInvoice.get(row.invoiceId) ?? [];
    list.push({
      id: row.id,
      jobNumber: row.jobNumber,
      title: row.title,
      date: row.date,
    });
    sourceJobsByInvoice.set(row.invoiceId, list);
  }

  return rows.map((r) => ({
    ...serializeInvoice(r),
    sourceJobs: sourceJobsByInvoice.get(r.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Line building / persistence
// ---------------------------------------------------------------------------

interface RawLine extends CommercialPlanningLine {
  /** Existing commercial row retained during draft edits. */
  existingId?: number | null;
  /** Internal-only key used to attach raw sources to an aggregated row. */
  allocationKey?: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

interface BuildProposedLinesOpts {
  /** Per-material markup overrides keyed by material id (highest priority). */
  lineMarkupOverrides?: Map<number, number>;
  /** Resolver for a material's category-default markup (second priority). */
  categoryMarkupForName?: (name: string | null | undefined) => number | null;
  includeJobPrice?: boolean;
  /** Optional per-job override used by automatic labour selection. */
  includeJobPriceIds?: Set<number>;
  /** Default transport rate used when a job has no explicit transport cost. */
  transportRatePerKm?: number;
}

/** Build the proposed lines + per-job billed amounts from a set of done jobs. */
async function buildProposedLines(
  exec: DbOrTx,
  jobIds: number[],
  billFineJobIds: number[],
  customerId: number,
  invoiceVatMode: VatMode,
  materialMarkupPercent = 0,
  opts: BuildProposedLinesOpts = {},
): Promise<{ lines: RawLine[]; jobAmounts: Map<number, number> }> {
  const lines: RawLine[] = [];
  const jobAmounts = new Map<number, number>();
  if (!jobIds.length) return { lines, jobAmounts };

  const jobs = await exec
    .select()
    .from(jobsTable)
    .where(inArray(jobsTable.id, jobIds))
    .for("update");
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // A concurrent draft owns the parent while it is being edited. Once a partial
  // invoice is issued, the parent becomes selectable again and the allocation
  // ledger below excludes only the raw sources already settled.
  const alreadyBilled = await exec
    .select({
      jobId: invoiceSourceLinksTable.jobId,
      invoiceNumber: invoicesTable.invoiceNumber,
      invoiceStatus: invoicesTable.status,
    })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        inArray(invoiceSourceLinksTable.jobId, jobIds),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.documentType, "standard"),
      ),
    );
  if (alreadyBilled.length) {
    const conflict = alreadyBilled[0];
    const job =
      conflict.jobId != null ? jobById.get(conflict.jobId) : undefined;
    const jobLabel = job ? `„${job.title}"` : `#${conflict.jobId}`;
    const invoiceLabel = conflict.invoiceNumber
      ? `faktuře ${conflict.invoiceNumber}`
      : conflict.invoiceStatus === "draft"
        ? "rozpracované faktuře"
        : "jiné faktuře";
    throw appError(400, `Zakázka ${jobLabel} už je na ${invoiceLabel}.`);
  }

  const activeAllocations = await exec
    .select({
      sourceType: invoiceSourceAllocationsTable.sourceType,
      sourceId: invoiceSourceAllocationsTable.sourceId,
    })
    .from(invoiceSourceAllocationsTable)
    .where(
      and(
        inArray(invoiceSourceAllocationsTable.jobId, jobIds),
        inArray(invoiceSourceAllocationsTable.status, [
          "reserved",
          "billed",
          "included_in_lump_sum",
          "not_charged",
        ]),
      ),
    );
  const activeSourceKeys = new Set(
    activeAllocations.map((row) => `${row.sourceType}:${row.sourceId}`),
  );

  const materials = await exec
    .select()
    .from(materialsTable)
    .where(
      and(inArray(materialsTable.jobId, jobIds), eq(materialsTable.done, true)),
    );
  const materialsByJob = new Map<
    number,
    (typeof materialsTable.$inferSelect)[]
  >();
  for (const m of materials) {
    const list = materialsByJob.get(m.jobId) ?? [];
    list.push(m);
    materialsByJob.set(m.jobId, list);
  }

  const fineSet = new Set(billFineJobIds);

  for (const jobId of jobIds) {
    const job = jobById.get(jobId);
    if (!job) throw appError(400, `Zakázka #${jobId} nenalezena.`);
    if (job.customerId !== customerId) {
      throw appError(400, `Zakázka #${jobId} nepatří zvolenému zákazníkovi.`);
    }
    if (job.status !== "done") {
      throw appError(400, `Zakázka „${job.title}" není ve stavu „hotová".`);
    }
    if (job.billingIntent !== "billable") {
      throw appError(
        409,
        `Zakázka „${job.title}" je označena jako nefakturovaná${
          job.billingExclusionReason ? ` (${job.billingExclusionReason})` : ""
        }.`,
      );
    }

    const jobLines: RawLine[] = [];
    const isFixedPrice = (job as any).pricingMode === "fixed_price";
    const includeJobPrice =
      opts.includeJobPrice !== false &&
      (opts.includeJobPriceIds == null || opts.includeJobPriceIds.has(jobId));

    if (
      isFixedPrice &&
      includeJobPrice &&
      !activeSourceKeys.has(`job:${jobId}`)
    ) {
      // Fixed-price mode: one single line at the agreed contract price.
      // Materials, hours (no hour lines exist currently) are internal only.
      // Transport, parking and fines are still billed separately.
      const contractPriceRaw = (job as any).contractPrice;
      if (contractPriceRaw == null || num(contractPriceRaw) <= 0) {
        throw appError(
          400,
          `Zakázka „${job.title}" má způsob fakturace „Smluvní cena", ale smluvní cena nebyla zadána. Před fakturací ji doplňte v Souhrnu práce.`,
        );
      }
      const contractPrice = round2(num(contractPriceRaw));
      jobLines.push({
        sourceType: "job",
        jobId,
        sourceId: jobId,
        description: `${job.title} — smluvní cena`,
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: contractPrice,
        vatMode: invoiceVatMode,
      });
    } else {
      // time_material mode (default): bill job price + materials individually.
      if (
        includeJobPrice &&
        num(job.price) > 0 &&
        !activeSourceKeys.has(`job:${jobId}`)
      ) {
        jobLines.push({
          sourceType: "job",
          jobId,
          sourceId: jobId,
          description: job.title,
          quantity: 1,
          unit: "ks",
          unitPriceWithoutVat: round2(num(job.price)),
          vatMode: invoiceVatMode,
        });
      }
      for (const m of materialsByJob.get(jobId) ?? []) {
        if (m.pricePerUnit == null) continue;
        // Skip materials already reserved on another invoice (no double-billing).
        if (m.invoicedInvoiceId != null) continue;
        // Material lines (and only these) carry the optional percent markup,
        // resolved per line: per-line override → category default → invoice/
        // settings default (the passed-in materialMarkupPercent).
        const effectiveMarkup = resolveLineMaterialMarkup(
          opts.lineMarkupOverrides?.get(m.id),
          opts.categoryMarkupForName?.(m.name),
          materialMarkupPercent,
        );
        jobLines.push({
          sourceType: "material",
          jobId,
          sourceId: m.id,
          description: m.name,
          quantity: round2(num(m.quantity ?? 1)),
          unit: m.unit ?? "ks",
          unitPriceWithoutVat: applyMaterialMarkup(
            num(m.pricePerUnit),
            effectiveMarkup,
          ),
          vatMode: invoiceVatMode,
        });
      }
    }
    const transportCost = effectiveTransportCost(
      job,
      opts.transportRatePerKm ?? 0,
    );
    if (transportCost > 0 && !activeSourceKeys.has(`transport:${jobId}`)) {
      const km = num(job.transportKm);
      jobLines.push({
        sourceType: "transport",
        sourceId: jobId,
        jobId,
        description: km > 0 ? `Doprava (${km} km)` : "Doprava",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: transportCost,
        vatMode: invoiceVatMode,
      });
    }
    if (num(job.parking) > 0 && !activeSourceKeys.has(`parking:${jobId}`)) {
      jobLines.push({
        sourceType: "parking",
        sourceId: jobId,
        jobId,
        description: "Parkovné",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: round2(num(job.parking)),
        vatMode: invoiceVatMode,
      });
    }
    // Fines are opt-in per job — only billed when explicitly selected.
    if (
      fineSet.has(jobId) &&
      num(job.fines) > 0 &&
      !activeSourceKeys.has(`fine:${jobId}`)
    ) {
      jobLines.push({
        sourceType: "fine",
        sourceId: jobId,
        jobId,
        description: "Pokuta / penále",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: round2(num(job.fines)),
        vatMode: invoiceVatMode,
      });
    }

    let jobAmount = 0;
    for (const rl of jobLines) {
      const c = computeLine(rl, invoiceVatMode);
      jobAmount += c.totalWithoutVat;
    }
    jobAmounts.set(jobId, round2(jobAmount));
    lines.push(...jobLines);
  }

  return { lines, jobAmounts };
}

/**
 * Build proposed lines + per-activity billed amounts from a set of completed
 * actions (dlouhodobé akce). An activity contributes one line per extra-work
 * row (description + amount) and one line per priced material. Activities have
 * no price/transport/parking/fines and no per-material invoice reservation —
 * the activity-level source link prevents re-billing.
 */
async function buildProposedActivityLines(
  exec: DbOrTx,
  activityIds: number[],
  customerId: number,
  invoiceVatMode: VatMode,
  materialMarkupPercent = 0,
  opts: BuildProposedLinesOpts = {},
): Promise<{ lines: RawLine[]; activityAmounts: Map<number, number> }> {
  const lines: RawLine[] = [];
  const activityAmounts = new Map<number, number>();
  if (!activityIds.length) return { lines, activityAmounts };

  const activities = await exec
    .select()
    .from(activitiesTable)
    .where(inArray(activitiesTable.id, activityIds));
  const activityById = new Map(activities.map((a) => [a.id, a]));

  // A draft temporarily owns the parent. Issued partial invoices do not: the
  // allocation ledger below filters each already-settled raw source instead.
  const alreadyBilled = await exec
    .select({ activityId: invoiceSourceLinksTable.activityId })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        inArray(invoiceSourceLinksTable.activityId, activityIds),
        eq(invoicesTable.status, "draft"),
        eq(invoicesTable.documentType, "standard"),
      ),
    );
  if (alreadyBilled.length) {
    const conflictId = alreadyBilled[0].activityId;
    const name =
      conflictId != null ? activityById.get(conflictId)?.name : undefined;
    throw appError(
      400,
      `Akce „${name ?? `#${conflictId}`}" už je na jiné faktuře.`,
    );
  }

  const activeAllocations = await exec
    .select({
      sourceType: invoiceSourceAllocationsTable.sourceType,
      sourceId: invoiceSourceAllocationsTable.sourceId,
    })
    .from(invoiceSourceAllocationsTable)
    .where(
      and(
        inArray(invoiceSourceAllocationsTable.activityId, activityIds),
        inArray(invoiceSourceAllocationsTable.status, [
          "reserved",
          "billed",
          "included_in_lump_sum",
          "not_charged",
        ]),
      ),
    );
  const activeSourceKeys = new Set(
    activeAllocations.map((row) => `${row.sourceType}:${row.sourceId}`),
  );

  const materials = await exec
    .select()
    .from(activityMaterialsTable)
    .where(inArray(activityMaterialsTable.activityId, activityIds));
  const materialsByActivity = new Map<
    number,
    (typeof activityMaterialsTable.$inferSelect)[]
  >();
  for (const m of materials) {
    const list = materialsByActivity.get(m.activityId) ?? [];
    list.push(m);
    materialsByActivity.set(m.activityId, list);
  }

  const works = await exec
    .select()
    .from(activityExtraWorksTable)
    .where(inArray(activityExtraWorksTable.activityId, activityIds));
  const worksByActivity = new Map<
    number,
    (typeof activityExtraWorksTable.$inferSelect)[]
  >();
  for (const w of works) {
    const list = worksByActivity.get(w.activityId) ?? [];
    list.push(w);
    worksByActivity.set(w.activityId, list);
  }

  for (const activityId of activityIds) {
    const activity = activityById.get(activityId);
    if (!activity) throw appError(400, `Akce #${activityId} nenalezena.`);
    if (activity.customerId !== customerId) {
      throw appError(400, `Akce #${activityId} nepatří zvolenému zákazníkovi.`);
    }
    if (activity.completedAt == null) {
      throw appError(400, `Akce „${activity.name}" není dokončená.`);
    }

    const activityLines: RawLine[] = [];
    for (const w of worksByActivity.get(activityId) ?? []) {
      if (num(w.amount) <= 0) continue;
      if (activeSourceKeys.has(`activity_work:${w.id}`)) continue;
      activityLines.push({
        sourceType: "activity_work",
        activityId,
        sourceId: w.id,
        description: w.description,
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: round2(num(w.amount)),
        vatMode: invoiceVatMode,
      });
    }
    for (const m of materialsByActivity.get(activityId) ?? []) {
      if (m.pricePerUnit == null) continue;
      if (activeSourceKeys.has(`activity_material:${m.id}`)) continue;
      const effectiveMarkup = resolveLineMaterialMarkup(
        opts.lineMarkupOverrides?.get(m.id),
        opts.categoryMarkupForName?.(m.name),
        materialMarkupPercent,
      );
      activityLines.push({
        sourceType: "activity_material",
        activityId,
        sourceId: m.id,
        description: m.name,
        quantity: round2(num(m.quantity ?? 1)),
        unit: m.unit ?? "ks",
        unitPriceWithoutVat: applyMaterialMarkup(
          num(m.pricePerUnit),
          effectiveMarkup,
        ),
        vatMode: invoiceVatMode,
      });
    }

    let activityAmount = 0;
    for (const rl of activityLines) {
      const c = computeLine(rl, invoiceVatMode);
      activityAmount += c.totalWithoutVat;
    }
    activityAmounts.set(activityId, round2(activityAmount));
    lines.push(...activityLines);
  }

  return { lines, activityAmounts };
}

async function persistLines(
  exec: DbOrTx,
  invoiceId: number,
  rawLines: RawLine[],
  invoiceVatMode: VatMode,
): Promise<{ computed: ComputedLine[]; lines: InvoiceLine[] }> {
  if (!rawLines.length) return { computed: [], lines: [] };
  const computed: ComputedLine[] = [];
  const values = rawLines.map((rl, idx) => {
    const description = rl.description.trim();
    if (!description) throw appError(400, `Položka ${idx + 1} nemá popis.`);
    if (
      rl.rowType !== "section" &&
      (!Number.isFinite(num(rl.quantity ?? 1)) || num(rl.quantity ?? 1) === 0)
    ) {
      throw appError(400, `Položka ${idx + 1} musí mít nenulové množství.`);
    }
    if (
      rl.discountPercent != null &&
      (num(rl.discountPercent) < 0 || num(rl.discountPercent) > 100)
    ) {
      throw appError(400, `Sleva u položky ${idx + 1} musí být 0–100 %.`);
    }
    if (rl.vatRate != null && (num(rl.vatRate) < 0 || num(rl.vatRate) > 100)) {
      throw appError(400, `DPH u položky ${idx + 1} musí být 0–100 %.`);
    }
    const c = computeLine(rl, invoiceVatMode);
    computed.push(c);
    return {
      invoiceId,
      sourceType: rl.sourceType,
      sourceId: rl.sourceId ?? null,
      jobId: rl.jobId ?? null,
      activityId: rl.activityId ?? null,
      rowType: rl.rowType ?? "item",
      description,
      quantity: String(c.quantity),
      unit: rl.unit ?? null,
      unitPriceWithoutVat: String(c.unitPriceWithoutVat),
      discountPercent:
        c.discountPercent == null ? null : String(c.discountPercent),
      vatRate: c.vatRate == null ? null : String(c.vatRate),
      vatMode: c.vatMode,
      totalWithoutVat: String(c.totalWithoutVat),
      totalVat: String(c.totalVat),
      totalWithVat: String(c.totalWithVat),
      sortOrder: idx,
    };
  });
  const inserted = await exec
    .insert(invoiceLinesTable)
    .values(values)
    .returning();
  return {
    computed,
    lines: inserted.sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/**
 * Replace the editable commercial shape without replacing rows that still
 * exist. Stable row ids keep optional allocation pointers intact while text,
 * quantity, price, VAT and ordering remain fully editable.
 */
async function syncDraftLines(
  tx: Tx,
  invoiceId: number,
  rawLines: RawLine[],
  invoiceVatMode: VatMode,
): Promise<{
  computed: ComputedLine[];
  lines: InvoiceLine[];
  removedLineIds: number[];
}> {
  const existing = await tx
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, invoiceId))
    .for("update");
  const existingById = new Map(existing.map((line) => [line.id, line]));
  const retainedIds = new Set<number>();
  const computed: ComputedLine[] = [];
  const persisted: InvoiceLine[] = [];

  for (const [idx, rawLine] of rawLines.entries()) {
    const description = rawLine.description.trim();
    if (!description) throw appError(400, `Položka ${idx + 1} nemá popis.`);
    if (
      rawLine.rowType !== "section" &&
      (!Number.isFinite(num(rawLine.quantity ?? 1)) ||
        num(rawLine.quantity ?? 1) === 0)
    ) {
      throw appError(400, `Položka ${idx + 1} musí mít nenulové množství.`);
    }
    if (
      rawLine.discountPercent != null &&
      (num(rawLine.discountPercent) < 0 || num(rawLine.discountPercent) > 100)
    ) {
      throw appError(400, `Sleva u položky ${idx + 1} musí být 0–100 %.`);
    }
    if (
      rawLine.vatRate != null &&
      (num(rawLine.vatRate) < 0 || num(rawLine.vatRate) > 100)
    ) {
      throw appError(400, `DPH u položky ${idx + 1} musí být 0–100 %.`);
    }

    const lineComputed = computeLine(rawLine, invoiceVatMode);
    computed.push(lineComputed);
    const values = {
      invoiceId,
      sourceType: rawLine.sourceType,
      sourceId: rawLine.sourceId ?? null,
      jobId: rawLine.jobId ?? null,
      activityId: rawLine.activityId ?? null,
      rowType: rawLine.rowType ?? "item",
      description,
      quantity: String(lineComputed.quantity),
      unit: rawLine.unit ?? null,
      unitPriceWithoutVat: String(lineComputed.unitPriceWithoutVat),
      discountPercent:
        lineComputed.discountPercent == null
          ? null
          : String(lineComputed.discountPercent),
      vatRate:
        lineComputed.vatRate == null ? null : String(lineComputed.vatRate),
      vatMode: lineComputed.vatMode,
      totalWithoutVat: String(lineComputed.totalWithoutVat),
      totalVat: String(lineComputed.totalVat),
      totalWithVat: String(lineComputed.totalWithVat),
      sortOrder: idx,
      updatedAt: new Date(),
    };

    if (rawLine.existingId != null) {
      if (!existingById.has(rawLine.existingId)) {
        throw appError(
          400,
          `Položka #${rawLine.existingId} nepatří této faktuře.`,
        );
      }
      if (retainedIds.has(rawLine.existingId)) {
        throw appError(
          400,
          `Položka #${rawLine.existingId} je uvedena dvakrát.`,
        );
      }
      retainedIds.add(rawLine.existingId);
      const [updated] = await tx
        .update(invoiceLinesTable)
        .set(values)
        .where(
          and(
            eq(invoiceLinesTable.id, rawLine.existingId),
            eq(invoiceLinesTable.invoiceId, invoiceId),
          ),
        )
        .returning();
      persisted.push(updated);
      continue;
    }

    const [inserted] = await tx
      .insert(invoiceLinesTable)
      .values(values)
      .returning();
    persisted.push(inserted);
  }

  const removedLineIds = existing
    .map((line) => line.id)
    .filter((lineId) => !retainedIds.has(lineId));
  if (removedLineIds.length) {
    await tx
      .delete(invoiceLinesTable)
      .where(
        and(
          eq(invoiceLinesTable.invoiceId, invoiceId),
          inArray(invoiceLinesTable.id, removedLineIds),
        ),
      );
  }

  return { computed, lines: persisted, removedLineIds };
}

async function createSourceAllocations(
  tx: Tx,
  invoiceId: number,
  rawLines: RawLine[],
  prepared: PreparedCommercialLines<RawLine>,
  persistedLines: InvoiceLine[],
  recordedWork: ReservedWork[],
  settlementOnlySources: SettlementOnlySource[],
  invoiceVatMode: VatMode,
  actor: Actor,
): Promise<void> {
  const values: Array<typeof invoiceSourceAllocationsTable.$inferInsert> = [];
  const seen = new Set<string>();

  rawLines.forEach((line, rawIndex) => {
    if (
      line.rowType === "section" ||
      line.sourceType === "manual" ||
      line.sourceType === "work_session" ||
      line.sourceId == null
    ) {
      return;
    }
    const key = `${line.sourceType}:${line.sourceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const commercialIndex = prepared.commercialIndexByRawIndex[rawIndex];
    const persisted = persistedLines[commercialIndex];
    const computed = computeLine(line, invoiceVatMode);
    const grouped =
      (prepared.sourceCountByCommercialIndex[commercialIndex] ?? 1) > 1;
    const sourceQuantity = Math.abs(num(line.quantity ?? 1));
    values.push({
      invoiceId,
      invoiceIdSnapshot: invoiceId,
      invoiceLineId: persisted?.id ?? null,
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      jobId: line.jobId ?? null,
      activityId: line.activityId ?? null,
      sourceDescription: line.description,
      sourceUnit: line.unit ?? null,
      originalQuantity: String(sourceQuantity),
      allocatedQuantity: String(sourceQuantity),
      sourceAmountWithoutVat: String(computed.totalWithoutVat),
      status: "reserved",
      settlementMethod: settlementMethodForCommercialSource(grouped ? 2 : 1),
      createdByUserId: actor.userId,
      updatedByUserId: actor.userId,
    });
  });

  for (const reservation of recordedWork) {
    const key = `work_session:${reservation.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawIndex = rawLines.findIndex(
      (line) =>
        line.sourceType === "work_session" &&
        line.allocationKey === reservation.allocationKey,
    );
    const commercialIndex =
      rawIndex < 0 ? -1 : prepared.commercialIndexByRawIndex[rawIndex];
    const persisted =
      commercialIndex < 0 ? undefined : persistedLines[commercialIndex];
    const grouped =
      commercialIndex >= 0 &&
      (prepared.sourceCountByCommercialIndex[commercialIndex] ?? 1) > 1;
    const sourceHours = round2(Math.abs(reservation.durationSeconds) / 3600);
    values.push({
      invoiceId,
      invoiceIdSnapshot: invoiceId,
      invoiceLineId: persisted?.id ?? null,
      sourceType: "work_session",
      sourceId: reservation.sessionId,
      jobId: reservation.jobId,
      activityId: reservation.activityId,
      sourceDescription:
        reservation.sourceDescription ??
        persisted?.description ??
        "Odpracované práce",
      sourceUnit: "h",
      originalQuantity: String(sourceHours),
      allocatedQuantity: String(sourceHours),
      sourceAmountWithoutVat: String(reservation.amountWithoutVat),
      status: "reserved",
      settlementMethod: settlementMethodForCommercialSource(
        grouped ? 2 : 1,
        reservation.settlementMethod,
      ),
      createdByUserId: actor.userId,
      updatedByUserId: actor.userId,
    });
  }

  for (const source of settlementOnlySources) {
    const key = `${source.sourceType}:${source.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      invoiceId,
      invoiceIdSnapshot: invoiceId,
      invoiceLineId: null,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      jobId: source.jobId,
      activityId: source.activityId,
      sourceDescription: source.sourceDescription,
      sourceUnit: source.sourceUnit,
      originalQuantity: String(source.originalQuantity),
      allocatedQuantity: String(source.originalQuantity),
      sourceAmountWithoutVat: String(source.sourceAmountWithoutVat),
      status: "reserved",
      settlementMethod: source.settlementMethod,
      createdByUserId: actor.userId,
      updatedByUserId: actor.userId,
    });
  }

  if (values.length) {
    try {
      await tx.insert(invoiceSourceAllocationsTable).values(values);
    } catch (error) {
      const allocationConflict = [
        error,
        (error as { cause?: unknown } | null)?.cause,
      ].some(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { code?: unknown }).code === "23505" &&
          (candidate as { constraint?: unknown }).constraint ===
            "invoice_source_allocations_active_source_uq",
      );
      if (allocationConflict) {
        throw appError(
          409,
          "Některý zdroj mezitím rezervoval jiný koncept. Obnovte výběr a zkuste to znovu.",
        );
      }
      throw error;
    }
  }
}

async function writeTotals(
  exec: DbOrTx,
  invoiceId: number,
  computed: ComputedLine[],
): Promise<void> {
  const totals = sumTotals(computed);
  await exec
    .update(invoicesTable)
    .set({
      subtotalWithoutVat: String(totals.subtotalWithoutVat),
      totalVat: String(totals.totalVat),
      totalWithVat: String(totals.totalWithVat),
      updatedAt: new Date(),
    })
    .where(eq(invoicesTable.id, invoiceId));
}

// ---------------------------------------------------------------------------
// Draft create / update / recalc / delete
// ---------------------------------------------------------------------------

export interface InvoiceLineInput {
  id?: number | null;
  rowType?: "item" | "section" | null;
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  vatRate?: number | null;
  vatMode?: VatMode | null;
  sourceType?: string | null;
  sourceId?: number | null;
  jobId?: number | null;
  activityId?: number | null;
}

/** Cost-document line ids referenced by a set of invoice line inputs. */
function billingDocLineIds(lines: RawLine[]): number[] {
  return lines
    .filter(
      (l) => l.sourceType === "billing_document_line" && l.sourceId != null,
    )
    .map((l) => l.sourceId as number);
}

/** Job-material ids referenced by a set of invoice line inputs. */
function materialIds(lines: RawLine[]): number[] {
  return lines
    .filter((l) => l.sourceType === "material" && l.sourceId != null)
    .map((l) => l.sourceId as number);
}

export interface InvoiceCreateInput {
  documentType?: "standard" | "advance";
  customerId: number;
  customerName?: string | null;
  customerIc?: string | null;
  customerDic?: string | null;
  customerAddress?: string | null;
  customerDeliveryAddress?: string | null;
  customerEmail?: string | null;
  jobIds?: number[];
  activityIds?: number[];
  labourBillingMode?: "automatic" | "job_price" | "recorded_time" | "none";
  workGrouping?: "summary" | "worker";
  sourceGrouping?: "by_job" | "combined";
  billFineJobIds?: number[];
  materialMarkupPercent?: number;
  /**
   * Per-material markup overrides keyed by material id (highest priority).
   * `sourceType` disambiguates job materials ("material") from activity
   * materials ("activity_material"); omitted = job material (back-compat).
   */
  materialMarkupOverrides?: Array<{
    materialId: number;
    markupPercent: number;
    sourceType?: "material" | "activity_material";
  }>;
  materialDisplayMode?: MaterialDisplayMode;
  vatModeDefault?: VatMode;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  bankAccount?: string | null;
  iban?: string | null;
  bic?: string | null;
  currency?: string | null;
  variableSymbol?: string | null;
  constantSymbol?: string | null;
  specificSymbol?: string | null;
  notes?: string | null;
  lines?: InvoiceLineInput[];
}

export interface QuoteJobGroupInvoiceDraftInput {
  extraJobIds?: number[];
  labourBillingMode?: "job_price" | "recorded_time" | "none";
  workGrouping?: "summary" | "worker";
  billFineJobIds?: number[];
  materialMarkupPercent?: number;
  materialMarkupOverrides?: InvoiceCreateInput["materialMarkupOverrides"];
  materialDisplayMode?: MaterialDisplayMode;
  vatModeDefault?: VatMode;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
}

type ReservedWork = {
  sessionId: number;
  allocationKey: string;
  jobId: number | null;
  activityId: number | null;
  durationSeconds: number;
  saleRate: number;
  amountWithoutVat: number;
  settlementMethod?: SettlementMethod;
  sourceDescription?: string;
};

type SettlementOnlySource = {
  sourceType: string;
  sourceId: number;
  jobId: number | null;
  activityId: number | null;
  sourceDescription: string;
  sourceUnit: string | null;
  originalQuantity: number;
  sourceAmountWithoutVat: number;
  settlementMethod: SettlementMethod;
};

async function resolveAutomaticLabourParents(
  tx: Tx,
  jobIds: number[],
  activityIds: number[],
): Promise<{
  jobPriceIds: Set<number>;
  recordedJobIds: number[];
  recordedActivityIds: number[];
}> {
  const jobs = jobIds.length
    ? await tx
        .select({
          id: jobsTable.id,
          pricingMode: jobsTable.pricingMode,
        })
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds))
    : [];

  const parentFilters = [];
  if (jobIds.length)
    parentFilters.push(inArray(workSessionsTable.jobId, jobIds));
  if (activityIds.length)
    parentFilters.push(inArray(workSessionsTable.activityId, activityIds));
  const workRows = parentFilters.length
    ? await tx
        .select({
          jobId: workSessionsTable.jobId,
          activityId: workSessionsTable.activityId,
          durationSeconds: workSessionsTable.durationSeconds,
        })
        .from(workSessionsTable)
        .where(
          and(
            or(...parentFilters),
            eq(workSessionsTable.status, "completed"),
            eq(workSessionsTable.billingStatus, "unbilled"),
          ),
        )
    : [];

  const jobsWithWork = new Set<number>();
  const activitiesWithWork = new Set<number>();
  for (const row of workRows) {
    if (round2((row.durationSeconds ?? 0) / 3600) === 0) continue;
    if (row.jobId != null) jobsWithWork.add(row.jobId);
    if (row.activityId != null) activitiesWithWork.add(row.activityId);
  }

  const jobPriceIds = new Set<number>();
  const recordedJobIds: number[] = [];
  for (const job of jobs) {
    if (job.pricingMode === "fixed_price" || !jobsWithWork.has(job.id)) {
      jobPriceIds.add(job.id);
    } else {
      recordedJobIds.push(job.id);
    }
  }

  return {
    jobPriceIds,
    recordedJobIds,
    recordedActivityIds: activityIds.filter((id) => activitiesWithWork.has(id)),
  };
}

async function billingDocumentLinesRepresentedBySelection(
  tx: Tx,
  jobIds: number[],
  activityIds: number[],
  lineIds: number[],
): Promise<Set<number>> {
  const represented = new Set<number>();
  if (!lineIds.length) return represented;

  if (jobIds.length) {
    const rows = await tx
      .select({ sourceId: materialsTable.sourceId })
      .from(materialsTable)
      .where(
        and(
          inArray(materialsTable.jobId, jobIds),
          eq(materialsTable.sourceType, "billing_document_line"),
          inArray(materialsTable.sourceId, lineIds),
        ),
      );
    for (const row of rows) {
      if (row.sourceId != null) represented.add(row.sourceId);
    }
  }

  if (activityIds.length) {
    const rows = await tx
      .select({ sourceId: activityMaterialsTable.sourceId })
      .from(activityMaterialsTable)
      .where(
        and(
          inArray(activityMaterialsTable.activityId, activityIds),
          eq(activityMaterialsTable.sourceType, "billing_document_line"),
          inArray(activityMaterialsTable.sourceId, lineIds),
        ),
      );
    for (const row of rows) {
      if (row.sourceId != null) represented.add(row.sourceId);
    }
  }

  return represented;
}

async function buildRecordedWorkLines(
  tx: Tx,
  jobIds: number[],
  activityIds: number[],
  vatMode: VatMode,
  grouping: "summary" | "worker",
): Promise<{
  lines: RawLine[];
  reservations: ReservedWork[];
  jobAmounts: Map<number, number>;
  activityAmounts: Map<number, number>;
}> {
  if (!jobIds.length && !activityIds.length)
    return {
      lines: [],
      reservations: [],
      jobAmounts: new Map(),
      activityAmounts: new Map(),
    };
  const parentFilters = [];
  if (jobIds.length)
    parentFilters.push(inArray(workSessionsTable.jobId, jobIds));
  if (activityIds.length)
    parentFilters.push(inArray(workSessionsTable.activityId, activityIds));
  const rows = await tx
    .select({ session: workSessionsTable, personName: peopleTable.name })
    .from(workSessionsTable)
    .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
    .where(
      and(
        or(...parentFilters),
        eq(workSessionsTable.status, "completed"),
        eq(workSessionsTable.billingStatus, "unbilled"),
      ),
    )
    .for("update");
  const billable = rows.filter(
    ({ session }) => round2((session.durationSeconds ?? 0) / 3600) !== 0,
  );
  const missingRate = billable.find(
    ({ session }) => session.saleRateSnapshot == null,
  );
  if (missingRate) {
    throw appError(
      409,
      `Časová session #${missingRate.session.id} nemá historickou prodejní sazbu. Doplňte ji ručně před fakturací.`,
    );
  }
  const needsReview = billable.find(
    ({ session }) => session.reviewStatus === "needs_review",
  );
  if (needsReview) {
    throw appError(
      409,
      `Časová session #${needsReview.session.id} čeká na kontrolu a nelze ji zatím fakturovat.`,
    );
  }

  const groups = new Map<
    string,
    {
      description: string;
      jobId: number | null;
      activityId: number | null;
      rate: number;
      hours: number;
    }
  >();
  const reservations: ReservedWork[] = [];
  const jobAmounts = new Map<number, number>();
  const activityAmounts = new Map<number, number>();
  for (const { session, personName } of billable) {
    const rate = num(session.saleRateSnapshot);
    const seconds = session.durationSeconds ?? 0;
    const billableHours = round2(seconds / 3600);
    if (billableHours === 0) continue;
    const parentKey =
      session.jobId != null
        ? `job:${session.jobId}`
        : `activity:${session.activityId}`;
    const key = `${parentKey}:rate:${rate}${grouping === "worker" ? `:person:${session.personId}` : ""}`;
    const description =
      grouping === "worker" ? `Práce – ${personName}` : "Odpracované práce";
    const group = groups.get(key) ?? {
      description,
      jobId: session.jobId,
      activityId: session.activityId,
      rate,
      hours: 0,
    };
    group.hours = round2(group.hours + billableHours);
    groups.set(key, group);
    reservations.push({
      sessionId: session.id,
      allocationKey: key,
      jobId: session.jobId,
      activityId: session.activityId,
      durationSeconds: seconds,
      saleRate: rate,
      amountWithoutVat: round2(billableHours * rate),
    });
    const amount = round2(billableHours * rate);
    if (session.jobId != null)
      jobAmounts.set(
        session.jobId,
        round2((jobAmounts.get(session.jobId) ?? 0) + amount),
      );
    if (session.activityId != null)
      activityAmounts.set(
        session.activityId,
        round2((activityAmounts.get(session.activityId) ?? 0) + amount),
      );
  }
  return {
    lines: [...groups.entries()]
      .filter(([, group]) => group.hours !== 0)
      .map(([allocationKey, group]) => ({
        allocationKey,
        sourceType: "work_session",
        sourceId: null,
        jobId: group.jobId,
        activityId: group.activityId,
        description: group.description,
        quantity: group.hours,
        unit: "h",
        unitPriceWithoutVat: group.rate,
        vatMode,
      })),
    reservations,
    jobAmounts,
    activityAmounts,
  };
}

/**
 * Preserve operational sources that deliberately have no customer-facing row.
 *
 * Fixed-price jobs still need every consumed material and completed work
 * session in the settlement ledger, even though the customer sees one contract
 * line. Likewise, choosing "job price" covers recorded job work with that
 * lump-sum line, while choosing "none" reserves the work in the draft and
 * explicitly defers it on issue. These records are never persisted as invoice
 * lines and therefore cannot leak internal detail into the PDF.
 */
async function buildSettlementOnlySources(
  tx: Tx,
  jobIds: number[],
  activityIds: number[],
  labourBillingMode: InvoiceCreateInput["labourBillingMode"],
  representedLines: RawLine[],
  representedWork: ReservedWork[],
): Promise<{
  sources: SettlementOnlySource[];
  workReservations: ReservedWork[];
}> {
  if (!jobIds.length && !activityIds.length) {
    return { sources: [], workReservations: [] };
  }

  const represented = new Set(
    representedLines
      .filter((line) => line.sourceId != null)
      .map((line) => `${line.sourceType}:${line.sourceId}`),
  );
  for (const work of representedWork) {
    represented.add(`work_session:${work.sessionId}`);
  }

  const parentFilters = [];
  if (jobIds.length)
    parentFilters.push(inArray(workSessionsTable.jobId, jobIds));
  if (activityIds.length)
    parentFilters.push(inArray(workSessionsTable.activityId, activityIds));

  const jobs = jobIds.length
    ? await tx
        .select({
          id: jobsTable.id,
          pricingMode: jobsTable.pricingMode,
        })
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds))
    : [];
  const activeAllocations = await tx
    .select({
      sourceType: invoiceSourceAllocationsTable.sourceType,
      sourceId: invoiceSourceAllocationsTable.sourceId,
    })
    .from(invoiceSourceAllocationsTable)
    .where(
      and(
        or(
          jobIds.length
            ? inArray(invoiceSourceAllocationsTable.jobId, jobIds)
            : undefined,
          activityIds.length
            ? inArray(invoiceSourceAllocationsTable.activityId, activityIds)
            : undefined,
        ),
        inArray(invoiceSourceAllocationsTable.status, [
          "reserved",
          "billed",
          "included_in_lump_sum",
          "not_charged",
        ]),
      ),
    );
  const workRows = parentFilters.length
    ? await tx
        .select({
          id: workSessionsTable.id,
          jobId: workSessionsTable.jobId,
          activityId: workSessionsTable.activityId,
          durationSeconds: workSessionsTable.durationSeconds,
          saleRateSnapshot: workSessionsTable.saleRateSnapshot,
        })
        .from(workSessionsTable)
        .where(
          and(
            or(...parentFilters),
            eq(workSessionsTable.status, "completed"),
            eq(workSessionsTable.billingStatus, "unbilled"),
          ),
        )
        .for("update")
    : [];
  const fixedPriceMaterials = jobIds.length
    ? await tx
        .select({
          id: materialsTable.id,
          jobId: materialsTable.jobId,
          name: materialsTable.name,
          quantity: materialsTable.quantity,
          unit: materialsTable.unit,
          pricePerUnit: materialsTable.pricePerUnit,
          invoicedInvoiceId: materialsTable.invoicedInvoiceId,
        })
        .from(materialsTable)
        .where(
          and(
            inArray(materialsTable.jobId, jobIds),
            eq(materialsTable.done, true),
            isNotNull(materialsTable.pricePerUnit),
          ),
        )
        .for("update")
    : [];

  const active = new Set(
    activeAllocations.map((row) => `${row.sourceType}:${row.sourceId}`),
  );
  const fixedPriceJobIds = new Set(
    jobs
      .filter((job) => job.pricingMode === "fixed_price")
      .map((job) => job.id),
  );
  const sources: SettlementOnlySource[] = [];

  for (const material of fixedPriceMaterials) {
    const key = `material:${material.id}`;
    if (
      !fixedPriceJobIds.has(material.jobId) ||
      material.invoicedInvoiceId != null ||
      represented.has(key) ||
      active.has(key)
    ) {
      continue;
    }
    const quantity = Math.abs(num(material.quantity ?? 1));
    sources.push({
      sourceType: "material",
      sourceId: material.id,
      jobId: material.jobId,
      activityId: null,
      sourceDescription: material.name,
      sourceUnit: material.unit ?? "ks",
      originalQuantity: quantity,
      sourceAmountWithoutVat: round2(quantity * num(material.pricePerUnit)),
      settlementMethod: "included_in_lump_sum",
    });
  }

  const workReservations: ReservedWork[] = [];
  for (const session of workRows) {
    const key = `work_session:${session.id}`;
    if (represented.has(key) || active.has(key)) continue;
    const hours = round2(Math.abs(session.durationSeconds ?? 0) / 3600);
    if (hours === 0) continue;

    let settlementMethod: SettlementMethod | null = null;
    if (session.jobId != null && fixedPriceJobIds.has(session.jobId)) {
      settlementMethod = "included_in_lump_sum";
    } else if (session.jobId != null && labourBillingMode === "job_price") {
      settlementMethod = "included_in_lump_sum";
    } else if (
      labourBillingMode === "none" ||
      (session.activityId != null && labourBillingMode === "job_price")
    ) {
      settlementMethod = "deferred";
    }
    if (settlementMethod == null) continue;

    const saleRate = num(session.saleRateSnapshot);
    workReservations.push({
      sessionId: session.id,
      allocationKey: `settlement-only:${session.id}`,
      jobId: session.jobId,
      activityId: session.activityId,
      durationSeconds: session.durationSeconds ?? 0,
      saleRate,
      amountWithoutVat: round2(hours * saleRate),
      settlementMethod,
      sourceDescription:
        settlementMethod === "deferred"
          ? "Odpracovaný čas – odloženo na další fakturu"
          : "Odpracovaný čas – zahrnuto v ceně zakázky",
    });
  }

  return { sources, workReservations };
}

export async function createDraft(
  input: InvoiceCreateInput,
  actor: Actor,
  outerTx?: Tx,
) {
  const exec: DbOrTx = outerTx ?? db;
  const settings = await ensureBillingSettings();
  const [customer] = await exec
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, input.customerId));
  if (!customer) throw appError(400, "Zákazník nenalezen.");

  const documentType = input.documentType ?? "standard";
  const sourceGrouping = input.sourceGrouping ?? "by_job";
  const currency = (input.currency ?? "CZK").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw appError(400, "Měna musí být třípísmenný kód, např. CZK.");
  }
  const vatModeDefault: VatMode =
    input.vatModeDefault ?? (settings.vatModeDefault as VatMode);
  const jobIds = input.jobIds ?? [];
  const activityIds = input.activityIds ?? [];
  const labourBillingMode = input.labourBillingMode ?? "automatic";
  const workGrouping = input.workGrouping ?? "summary";
  const billFineJobIds = input.billFineJobIds ?? [];
  // Material markup: explicit per-invoice value wins, otherwise the saved
  // default from billing settings. Negative/invalid values fall back to 0.
  const materialMarkupPercent = resolveMaterialMarkup(
    input.materialMarkupPercent,
    settings.materialMarkupPercent,
  );
  // Per-line overrides keyed by material id (last write wins on duplicates).
  // Job materials (`materials`) and activity materials (`activity_materials`)
  // are separate tables with independent id sequences, so their ids collide;
  // overrides are namespaced by `sourceType` into two maps so a job override can
  // never bleed onto an activity line (or vice versa). Missing sourceType is
  // treated as a job material for backwards compatibility.
  const jobLineMarkupOverrides = new Map<number, number>();
  const activityLineMarkupOverrides = new Map<number, number>();
  for (const o of input.materialMarkupOverrides ?? []) {
    if (
      Number.isInteger(o.materialId) &&
      Number.isFinite(o.markupPercent) &&
      o.markupPercent >= 0
    ) {
      const target =
        o.sourceType === "activity_material"
          ? activityLineMarkupOverrides
          : jobLineMarkupOverrides;
      target.set(o.materialId, round2(o.markupPercent));
    }
  }

  const doCreate = async (tx: Tx) => {
    const categoryMarkupForName = await buildCategoryMarkupResolver(tx);
    const automaticLabour =
      labourBillingMode === "automatic"
        ? await resolveAutomaticLabourParents(tx, jobIds, activityIds)
        : null;
    const { lines: proposed, jobAmounts } = await buildProposedLines(
      tx,
      jobIds,
      billFineJobIds,
      input.customerId,
      vatModeDefault,
      materialMarkupPercent,
      {
        lineMarkupOverrides: jobLineMarkupOverrides,
        categoryMarkupForName,
        includeJobPrice:
          labourBillingMode === "job_price" ||
          labourBillingMode === "automatic",
        includeJobPriceIds: automaticLabour?.jobPriceIds,
        transportRatePerKm: num(settings.transportRatePerKm),
      },
    );
    const { lines: proposedActivity, activityAmounts } =
      await buildProposedActivityLines(
        tx,
        activityIds,
        input.customerId,
        vatModeDefault,
        materialMarkupPercent,
        {
          lineMarkupOverrides: activityLineMarkupOverrides,
          categoryMarkupForName,
        },
      );

    const recordedJobIds =
      labourBillingMode === "automatic"
        ? (automaticLabour?.recordedJobIds ?? [])
        : jobIds;
    const recordedActivityIds =
      labourBillingMode === "automatic"
        ? (automaticLabour?.recordedActivityIds ?? [])
        : activityIds;
    const recordedWork =
      labourBillingMode === "recorded_time" || labourBillingMode === "automatic"
        ? await buildRecordedWorkLines(
            tx,
            recordedJobIds,
            recordedActivityIds,
            vatModeDefault,
            workGrouping,
          )
        : {
            lines: [] as RawLine[],
            reservations: [] as ReservedWork[],
            jobAmounts: new Map<number, number>(),
            activityAmounts: new Map<number, number>(),
          };

    const rawManual: RawLine[] = (input.lines ?? []).map((l) => ({
      rowType: l.rowType ?? "item",
      sourceType: l.sourceType ?? "manual",
      sourceId: l.sourceId ?? null,
      jobId: l.jobId ?? null,
      activityId: l.activityId ?? null,
      description: l.description,
      quantity: l.quantity ?? 1,
      unit: l.unit ?? null,
      unitPriceWithoutVat: l.unitPriceWithoutVat ?? 0,
      discountPercent: l.discountPercent ?? null,
      vatRate: l.vatRate ?? null,
      vatMode: l.vatMode ?? vatModeDefault,
    }));
    const manualBillingLineIds = billingDocLineIds(rawManual);
    const representedBillingLineIds =
      await billingDocumentLinesRepresentedBySelection(
        tx,
        jobIds,
        activityIds,
        manualBillingLineIds,
      );
    const seenBillingLineIds = new Set<number>();
    const manual = rawManual.filter((line) => {
      if (
        line.sourceType !== "billing_document_line" ||
        line.sourceId == null
      ) {
        return true;
      }
      if (
        representedBillingLineIds.has(line.sourceId) ||
        seenBillingLineIds.has(line.sourceId)
      ) {
        return false;
      }
      seenBillingLineIds.add(line.sourceId);
      return true;
    });

    const allRawLines = [
      ...proposed,
      ...proposedActivity,
      ...recordedWork.lines,
      ...manual,
    ];
    const settlementOnly =
      documentType === "standard"
        ? await buildSettlementOnlySources(
            tx,
            jobIds,
            activityIds,
            labourBillingMode,
            allRawLines,
            recordedWork.reservations,
          )
        : { sources: [], workReservations: [] };
    const allWorkReservations = [
      ...recordedWork.reservations,
      ...settlementOnly.workReservations,
    ];
    const prepared = prepareCommercialLines(allRawLines, sourceGrouping);
    for (const [jobId, amount] of recordedWork.jobAmounts) {
      jobAmounts.set(jobId, round2((jobAmounts.get(jobId) ?? 0) + amount));
    }
    for (const [activityId, amount] of recordedWork.activityAmounts) {
      activityAmounts.set(
        activityId,
        round2((activityAmounts.get(activityId) ?? 0) + amount),
      );
    }

    const [invoice] = await tx
      .insert(invoicesTable)
      .values({
        status: "draft",
        documentType,
        customerId: customer.id,
        customerName:
          input.customerName !== undefined
            ? input.customerName
            : customer.companyName,
        customerIc:
          input.customerIc !== undefined ? input.customerIc : customer.ic,
        customerDic:
          input.customerDic !== undefined ? input.customerDic : customer.dic,
        customerAddress:
          input.customerAddress !== undefined
            ? input.customerAddress
            : customer.address,
        customerDeliveryAddress: input.customerDeliveryAddress ?? null,
        customerEmail:
          input.customerEmail !== undefined
            ? input.customerEmail
            : customer.email,
        issueDate: input.issueDate ?? null,
        taxableSupplyDate: input.taxableSupplyDate ?? null,
        dueDate: input.dueDate ?? null,
        paymentMethod: input.paymentMethod ?? settings.defaultPaymentMethod,
        bankAccount:
          input.bankAccount !== undefined
            ? input.bankAccount
            : settings.bankAccount,
        iban: input.iban !== undefined ? input.iban : settings.iban,
        bic: input.bic !== undefined ? input.bic : settings.bic,
        currency,
        variableSymbol: input.variableSymbol ?? null,
        constantSymbol: input.constantSymbol ?? INVOICE_CONSTANT_SYMBOL,
        specificSymbol: input.specificSymbol ?? null,
        vatModeDefault,
        materialDisplayMode: normalizeMaterialDisplayMode(
          input.materialDisplayMode,
        ),
        notes: input.notes ?? null,
        createdByUserId: actor.userId,
      })
      .returning();

    const persisted = await persistLines(
      tx,
      invoice.id,
      prepared.lines,
      vatModeDefault,
    );
    await writeTotals(tx, invoice.id, persisted.computed);

    if (documentType === "standard") {
      // Reserve re-billed cost lines and materials. This is customer-billing
      // provenance only and never creates another warehouse movement.
      await markLinesInvoiced(tx, invoice.id, billingDocLineIds(allRawLines));
      await markMaterialsInvoiced(tx, invoice.id, [
        ...materialIds(allRawLines),
        ...settlementOnly.sources
          .filter((source) => source.sourceType === "material")
          .map((source) => source.sourceId),
      ]);
      await createSourceAllocations(
        tx,
        invoice.id,
        allRawLines,
        prepared,
        persisted.lines,
        allWorkReservations,
        settlementOnly.sources,
        vatModeDefault,
        actor,
      );
    }

    // Source links — one per job/activity, with the billed amount (no VAT).
    const sourceLinkValues = [
      ...Array.from(jobAmounts.entries()).map(([jobId, amount]) => ({
        invoiceId: invoice.id,
        jobId,
        activityId: null as number | null,
        amountWithoutVat: String(amount),
      })),
      ...Array.from(activityAmounts.entries()).map(([activityId, amount]) => ({
        invoiceId: invoice.id,
        jobId: null as number | null,
        activityId,
        amountWithoutVat: String(amount),
      })),
    ];
    if (sourceLinkValues.length) {
      await tx.insert(invoiceSourceLinksTable).values(sourceLinkValues);
    }

    if (documentType === "standard" && allWorkReservations.length) {
      await tx.insert(workSessionBillingLinksTable).values(
        allWorkReservations.map((item) => ({
          sessionId: item.sessionId,
          invoiceId: invoice.id,
          invoiceIdSnapshot: invoice.id,
          status: "reserved",
          durationSecondsSnapshot: item.durationSeconds,
          saleRateSnapshot: String(item.saleRate),
          amountWithoutVatSnapshot: String(item.amountWithoutVat),
          createdByUserId: actor.userId,
        })),
      );
      await tx
        .update(workSessionsTable)
        .set({ billingStatus: "ready", updatedAt: new Date() })
        .where(
          inArray(
            workSessionsTable.id,
            allWorkReservations.map((item) => item.sessionId),
          ),
        );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "invoice_draft_created",
      entityType: "invoices",
      entityId: invoice.id,
      summary: `${documentType === "advance" ? "Zálohový" : "Běžný"} koncept vytvořen; zakázky: ${jobIds.join(", ") || "bez zakázky"}; akce: ${activityIds.join(", ") || "žádné"}`,
      method: "POST",
      path: "/billing/invoices",
    });

    return invoice.id;
  };

  if (outerTx) {
    // The invoice is inserted but not yet committed; getInvoiceDetail runs on a
    // separate connection and would see nothing. Return a minimal stub — callers
    // that pass outerTx only need the invoice id.
    const id = await doCreate(outerTx);
    return { id } as NonNullable<Awaited<ReturnType<typeof getInvoiceDetail>>>;
  }
  const id = await db.transaction(doCreate);
  return getInvoiceDetail(id);
}

async function ensureQuoteGroupSourceLinks(
  tx: Tx,
  invoiceId: number,
  jobGroupId: number,
): Promise<void> {
  const groupJobs = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.groupId, jobGroupId),
        eq(jobsTable.status, "done"),
        eq(jobsTable.billingIntent, "billable"),
        isNull(jobsTable.archivedAt),
      ),
    );
  if (!groupJobs.length) return;

  const existing = await tx
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .where(eq(invoiceSourceLinksTable.invoiceId, invoiceId));
  const linked = new Set(
    existing.map((row) => row.jobId).filter((id): id is number => id != null),
  );
  const missing = groupJobs.filter((job) => !linked.has(job.id));
  if (missing.length) {
    await tx.insert(invoiceSourceLinksTable).values(
      missing.map((job) => ({
        invoiceId,
        jobId: job.id,
        activityId: null,
        amountWithoutVat: "0",
      })),
    );
  }
}

/**
 * Creates one invoice draft for the whole quote-origin job group.
 *
 * Accepted quote items are copied as immutable invoice-line values. Actual job
 * costs are added only for explicitly selected follow-up jobs, so internal
 * consumption can never silently increase an agreed quote.
 */
export async function createQuoteJobGroupInvoiceDraft(
  jobGroupId: number,
  input: QuoteJobGroupInvoiceDraftInput,
  actor: Actor,
) {
  const invoiceId = await db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(jobGroupsTable)
      .where(eq(jobGroupsTable.id, jobGroupId))
      .for("update");
    if (!group) throw appError(404, "Akce zakázek nebyla nalezena.");
    if (group.customerId == null) {
      throw appError(409, "Akce nemá zákazníka a nelze ji fakturovat.");
    }

    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.convertedToJobGroupId, jobGroupId))
      .for("update");
    if (!quote) {
      throw appError(409, "Akce nevznikla z cenové nabídky.");
    }
    if (quote.status !== "accepted") {
      throw appError(409, "Fakturovat lze pouze přijatou nabídku.");
    }
    if (quote.customerId !== group.customerId) {
      throw appError(409, "Zákazník nabídky a akce se neshoduje.");
    }
    if (quote.convertedToInvoiceId != null) {
      throw appError(
        409,
        `Nabídka už je navázána na fakturu #${quote.convertedToInvoiceId}.`,
      );
    }

    const activeLinks = await tx
      .select({ invoiceIdSnapshot: quoteInvoiceLinksTable.invoiceIdSnapshot })
      .from(quoteInvoiceLinksTable)
      .where(
        and(
          eq(quoteInvoiceLinksTable.quoteId, quote.id),
          inArray(quoteInvoiceLinksTable.status, ["reserved", "billed"]),
        ),
      )
      .for("update");
    if (activeLinks.length) {
      throw appError(
        409,
        `Nabídka už je rezervována na faktuře #${activeLinks[0].invoiceIdSnapshot}.`,
      );
    }

    const jobs = await tx
      .select()
      .from(jobsTable)
      .where(
        and(eq(jobsTable.groupId, jobGroupId), isNull(jobsTable.archivedAt)),
      )
      .for("update");
    if (!jobs.length) {
      throw appError(409, "Akce neobsahuje žádnou zakázku.");
    }
    const unfinished = jobs.find(
      (job) => !["done", "cancelled"].includes(job.status),
    );
    if (unfinished) {
      throw appError(
        409,
        `Zakázka „${unfinished.title}“ ještě není dokončená ani zrušená.`,
      );
    }

    const extraJobIds = Array.from(new Set(input.extraJobIds ?? []));
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const primaryJob =
      quote.convertedToJobId == null
        ? null
        : jobById.get(quote.convertedToJobId);
    if (!primaryJob) {
      throw appError(409, "První zakázka přijaté nabídky v akci chybí.");
    }
    if (primaryJob.billingIntent !== "billable") {
      throw appError(
        409,
        `Zakázka „${primaryJob.title}" je označena jako nefakturovaná${
          primaryJob.billingExclusionReason
            ? ` (${primaryJob.billingExclusionReason})`
            : ""
        }.`,
      );
    }
    for (const extraJobId of extraJobIds) {
      const job = jobById.get(extraJobId);
      if (!job) {
        throw appError(400, `Vícepráce #${extraJobId} nepatří do této akce.`);
      }
      if (job.id === quote.convertedToJobId) {
        throw appError(
          409,
          "První zakázka představuje přijatou nabídku a nelze ji přidat podruhé jako vícepráci.",
        );
      }
      if (job.status !== "done") {
        throw appError(409, `Vícepráce „${job.title}“ není dokončená.`);
      }
      if (job.billingIntent !== "billable") {
        throw appError(
          409,
          `Vícepráce „${job.title}" je označena jako nefakturovaná.`,
        );
      }
    }
    const fineSet = new Set(input.billFineJobIds ?? []);
    if ([...fineSet].some((jobId) => !extraJobIds.includes(jobId))) {
      throw appError(400, "Pokutu lze zahrnout pouze u vybrané vícepráce.");
    }

    const quoteItems = await tx
      .select()
      .from(quoteItemsTable)
      .where(eq(quoteItemsTable.quoteId, quote.id))
      .orderBy(asc(quoteItemsTable.position), asc(quoteItemsTable.id));
    if (!quoteItems.length) {
      throw appError(409, "Přijatá nabídka nemá žádné položky.");
    }

    const created = await createDraft(
      {
        customerId: group.customerId,
        jobIds: extraJobIds,
        labourBillingMode: input.labourBillingMode ?? "job_price",
        workGrouping: input.workGrouping ?? "summary",
        billFineJobIds: input.billFineJobIds,
        materialMarkupPercent: input.materialMarkupPercent,
        materialMarkupOverrides: input.materialMarkupOverrides,
        materialDisplayMode: input.materialDisplayMode,
        vatModeDefault: input.vatModeDefault,
        issueDate: input.issueDate,
        taxableSupplyDate: input.taxableSupplyDate,
        dueDate: input.dueDate,
        paymentMethod: input.paymentMethod,
        notes: input.notes,
        lines: quoteItems.map((item) => ({
          sourceType: "quote_item",
          sourceId: item.id,
          description: item.description,
          quantity: num(item.quantity),
          unit: item.unit,
          unitPriceWithoutVat: num(item.unitPrice),
          vatRate: item.vatRate == null ? null : num(item.vatRate),
        })),
      },
      actor,
      tx,
    );
    if (!created) {
      throw appError(500, "Vytvořený koncept faktury se nepodařilo načíst.");
    }

    await ensureQuoteGroupSourceLinks(tx, created.id, group.id);
    await tx.insert(quoteInvoiceLinksTable).values({
      quoteId: quote.id,
      jobGroupId: group.id,
      invoiceId: created.id,
      invoiceIdSnapshot: created.id,
      status: "reserved",
      createdByUserId: actor.userId,
    });
    await tx
      .update(quotesTable)
      .set({ convertedToInvoiceId: created.id, updatedAt: new Date() })
      .where(eq(quotesTable.id, quote.id));
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "quote_job_group_invoice_draft_created",
      entityType: "invoices",
      entityId: created.id,
      summary: `Koncept faktury z nabídky ${quote.quoteNumber ?? `#${quote.id}`} a akce #${group.id}; vícepráce: ${extraJobIds.join(", ") || "žádné"}`,
      method: "POST",
      path: `/billing/job-groups/${group.id}/invoice-draft`,
    });
    return created.id;
  });

  return getInvoiceDetail(invoiceId);
}

export interface InvoiceUpdateInput {
  customerId?: number | null;
  allowCustomerMismatch?: boolean;
  customerName?: string | null;
  customerIc?: string | null;
  customerDic?: string | null;
  customerAddress?: string | null;
  customerDeliveryAddress?: string | null;
  customerEmail?: string | null;
  bankAccount?: string | null;
  iban?: string | null;
  bic?: string | null;
  currency?: string | null;
  vatModeDefault?: VatMode;
  materialDisplayMode?: InvoicePresentationMode;
  presentationGroups?: InvoicePresentationGroup[];
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  variableSymbol?: string | null;
  constantSymbol?: string | null;
  specificSymbol?: string | null;
  notes?: string | null;
  lines?: InvoiceLineInput[];
  sourceAllocations?: Array<{
    id: number;
    settlementMethod:
      | "direct"
      | "included_in_lump_sum"
      | "not_charged"
      | "deferred";
    invoiceLineId?: number | null;
  }>;
}

export async function updateDraft(
  id: number,
  input: InvoiceUpdateInput,
  actor: Actor = { userId: null, name: "Systém" },
) {
  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status !== "draft") {
      throw appError(409, "Upravovat lze pouze koncept faktury.");
    }

    const vatModeDefault: VatMode =
      input.vatModeDefault ?? (invoice.vatModeDefault as VatMode);
    const forcedSettlementAllocationIds = new Set<number>();
    const settlementChanges: string[] = [];

    const set: Record<string, unknown> = {
      updatedAt: new Date(),
      vatModeDefault,
    };
    let customerMismatchOverrideSummary: string | null = null;
    if (input.customerId !== undefined) {
      if (input.customerId == null) {
        throw appError(400, "Faktura musí mít odběratele.");
      }
      const [selectedCustomer] = await tx
        .select()
        .from(customersTable)
        .where(eq(customersTable.id, input.customerId));
      if (!selectedCustomer) throw appError(400, "Odběratel nebyl nalezen.");
      if (selectedCustomer.id !== invoice.customerId) {
        const sourceParents = await tx
          .select({
            jobId: invoiceSourceLinksTable.jobId,
            jobCustomerId: jobsTable.customerId,
            activityId: invoiceSourceLinksTable.activityId,
            activityCustomerId: activitiesTable.customerId,
          })
          .from(invoiceSourceLinksTable)
          .leftJoin(jobsTable, eq(invoiceSourceLinksTable.jobId, jobsTable.id))
          .leftJoin(
            activitiesTable,
            eq(invoiceSourceLinksTable.activityId, activitiesTable.id),
          )
          .where(eq(invoiceSourceLinksTable.invoiceId, id));
        const mismatchedParents = sourceParents.filter((parent) => {
          const sourceCustomerId =
            parent.jobCustomerId ?? parent.activityCustomerId;
          return (
            sourceCustomerId != null && sourceCustomerId !== selectedCustomer.id
          );
        });
        if (mismatchedParents.length) {
          if (!input.allowCustomerMismatch) {
            throw appError(
              409,
              "Zvolený odběratel se liší od odběratele zdrojových zakázek. Změnu musí správce výslovně potvrdit.",
            );
          }
          if (actor.role !== "admin" && actor.role !== "master") {
            throw appError(
              403,
              "Výjimku pro jiného odběratele může potvrdit pouze správce.",
            );
          }
          const parentLabels = mismatchedParents.map((parent) =>
            parent.jobId != null
              ? `zakázka #${parent.jobId}`
              : `akce #${parent.activityId}`,
          );
          customerMismatchOverrideSummary =
            `Explicitní výjimka odběratele: ${invoice.customerId ?? "bez odběratele"} -> ${selectedCustomer.id}; ` +
            `zdroje: ${parentLabels.join(", ")}`;
        }
      }
      set.customerId = selectedCustomer.id;
      if (input.customerName === undefined)
        set.customerName = selectedCustomer.companyName;
      if (input.customerIc === undefined) set.customerIc = selectedCustomer.ic;
      if (input.customerDic === undefined)
        set.customerDic = selectedCustomer.dic;
      if (input.customerAddress === undefined)
        set.customerAddress = selectedCustomer.address;
      if (input.customerEmail === undefined)
        set.customerEmail = selectedCustomer.email;
    }
    if (input.customerName !== undefined) set.customerName = input.customerName;
    if (input.customerIc !== undefined) set.customerIc = input.customerIc;
    if (input.customerDic !== undefined) set.customerDic = input.customerDic;
    if (input.customerAddress !== undefined)
      set.customerAddress = input.customerAddress;
    if (input.customerDeliveryAddress !== undefined)
      set.customerDeliveryAddress = input.customerDeliveryAddress;
    if (input.customerEmail !== undefined)
      set.customerEmail = input.customerEmail;
    if (input.bankAccount !== undefined) set.bankAccount = input.bankAccount;
    if (input.iban !== undefined) set.iban = input.iban;
    if (input.bic !== undefined) set.bic = input.bic;
    if (input.currency !== undefined) {
      const currency = (input.currency ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw appError(400, "Měna musí být třípísmenný kód, např. CZK.");
      }
      set.currency = currency;
    }
    if (input.issueDate !== undefined) set.issueDate = input.issueDate;
    if (input.taxableSupplyDate !== undefined)
      set.taxableSupplyDate = input.taxableSupplyDate;
    if (input.dueDate !== undefined) set.dueDate = input.dueDate;
    if (input.paymentMethod !== undefined)
      set.paymentMethod = input.paymentMethod;
    if (input.variableSymbol !== undefined)
      set.variableSymbol = input.variableSymbol;
    if (input.constantSymbol !== undefined)
      set.constantSymbol = input.constantSymbol;
    if (input.specificSymbol !== undefined)
      set.specificSymbol = input.specificSymbol;
    if (input.notes !== undefined) set.notes = input.notes;
    await tx.update(invoicesTable).set(set).where(eq(invoicesTable.id, id));

    if (input.lines !== undefined) {
      // Commercial rows are editable in place. Only explicitly removed rows
      // are deleted; the raw source records and invoice→job links remain intact.
      const lines: RawLine[] = input.lines.map((l) => ({
        existingId: l.id ?? null,
        rowType: l.rowType ?? "item",
        sourceType: l.sourceType ?? "manual",
        sourceId: l.sourceId ?? null,
        jobId: l.jobId ?? null,
        activityId: l.activityId ?? null,
        description: l.description,
        quantity: l.quantity ?? 1,
        unit: l.unit ?? null,
        unitPriceWithoutVat: l.unitPriceWithoutVat ?? 0,
        discountPercent: l.discountPercent ?? null,
        vatRate: l.vatRate ?? null,
        vatMode: l.vatMode ?? vatModeDefault,
      }));
      const allocations = await tx
        .select()
        .from(invoiceSourceAllocationsTable)
        .where(eq(invoiceSourceAllocationsTable.invoiceId, id))
        .for("update");
      const persisted = await syncDraftLines(tx, id, lines, vatModeDefault);
      await writeTotals(tx, id, persisted.computed);

      const newLineBySource = new Map<string, number>();
      lines.forEach((line, index) => {
        if (line.sourceId == null) return;
        const persistedId = persisted.lines[index]?.id;
        if (persistedId != null) {
          newLineBySource.set(
            `${line.sourceType}:${line.sourceId}`,
            persistedId,
          );
        }
      });
      const retainedLineIds = new Set(persisted.lines.map((line) => line.id));
      const removedLineIds = new Set(persisted.removedLineIds);
      const hasCommercialItem = lines.some(
        (line) => line.rowType !== "section",
      );
      for (const allocation of allocations) {
        const matchingLineId = newLineBySource.get(
          `${allocation.sourceType}:${allocation.sourceId}`,
        );
        const retainedLineId =
          allocation.invoiceLineId != null &&
          retainedLineIds.has(allocation.invoiceLineId)
            ? allocation.invoiceLineId
            : null;
        const targetLineId = retainedLineId ?? matchingLineId ?? null;
        const lostDirectLine =
          targetLineId == null &&
          allocation.invoiceLineId != null &&
          removedLineIds.has(allocation.invoiceLineId) &&
          allocation.settlementMethod === "direct";
        const nextMethod = lostDirectLine
          ? hasCommercialItem
            ? "included_in_lump_sum"
            : "deferred"
          : allocation.settlementMethod;
        if (lostDirectLine) {
          forcedSettlementAllocationIds.add(allocation.id);
          settlementChanges.push(
            `#${allocation.id}: ${allocation.settlementMethod} -> ${nextMethod}`,
          );
        }
        await tx
          .update(invoiceSourceAllocationsTable)
          .set({
            invoiceLineId: targetLineId,
            settlementMethod: nextMethod,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(invoiceSourceAllocationsTable.id, allocation.id));
      }

      if (
        normalizeMaterialDisplayMode(invoice.materialDisplayMode) ===
          "custom" &&
        input.materialDisplayMode === undefined &&
        input.presentationGroups === undefined
      ) {
        await tx
          .update(invoicesTable)
          .set({ materialDisplayMode: "detailed", updatedAt: new Date() })
          .where(eq(invoicesTable.id, id));
      }
    } else if (
      input.vatModeDefault !== undefined &&
      input.vatModeDefault !== invoice.vatModeDefault
    ) {
      // VAT mode changed — recompute existing lines under the new mode.
      await recalcWithin(tx, id, vatModeDefault);
    }

    if (input.sourceAllocations !== undefined) {
      const currentAllocations = await tx
        .select()
        .from(invoiceSourceAllocationsTable)
        .where(eq(invoiceSourceAllocationsTable.invoiceId, id))
        .for("update");
      const byId = new Map(currentAllocations.map((row) => [row.id, row]));
      const currentLineIds = new Set(
        (
          await tx
            .select({ id: invoiceLinesTable.id })
            .from(invoiceLinesTable)
            .where(eq(invoiceLinesTable.invoiceId, id))
        ).map((line) => line.id),
      );
      for (const requested of input.sourceAllocations) {
        const current = byId.get(requested.id);
        if (!current) {
          throw appError(
            400,
            `Zdrojové vypořádání #${requested.id} nepatří této faktuře.`,
          );
        }
        if (
          requested.invoiceLineId != null &&
          !currentLineIds.has(requested.invoiceLineId)
        ) {
          throw appError(
            400,
            `Položka #${requested.invoiceLineId} nepatří této faktuře.`,
          );
        }
        if (
          forcedSettlementAllocationIds.has(current.id) &&
          requested.settlementMethod === "direct"
        ) {
          throw appError(
            400,
            `Zdroj #${current.id} přišel o svou položku. Zvolte paušál, neúčtovat nebo další fakturu.`,
          );
        }
        if (
          current.settlementMethod !== requested.settlementMethod ||
          (requested.invoiceLineId !== undefined &&
            current.invoiceLineId !== requested.invoiceLineId)
        ) {
          settlementChanges.push(
            `#${current.id}: ${current.settlementMethod} -> ${requested.settlementMethod}`,
          );
        }
        await tx
          .update(invoiceSourceAllocationsTable)
          .set({
            settlementMethod: requested.settlementMethod,
            invoiceLineId:
              requested.invoiceLineId === undefined
                ? current.invoiceLineId
                : requested.invoiceLineId,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(invoiceSourceAllocationsTable.id, current.id));
      }
    }

    if (settlementChanges.length) {
      await tx.insert(auditLogTable).values({
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "invoice_source_settlement_changed",
        entityType: "invoices",
        entityId: id,
        summary: `Změna vypořádání zdrojů: ${settlementChanges.join("; ")}`,
        method: "PATCH",
        path: `/billing/invoices/${id}`,
      });
    }

    if (
      input.materialDisplayMode !== undefined ||
      input.presentationGroups !== undefined
    ) {
      const requestedMode =
        input.materialDisplayMode ??
        (input.presentationGroups !== undefined ? "custom" : undefined);
      if (!requestedMode) {
        throw appError(400, "Chybí způsob zobrazení faktury.");
      }
      if (
        requestedMode !== "custom" &&
        input.presentationGroups !== undefined
      ) {
        throw appError(
          400,
          "Vlastní skupiny lze uložit pouze v režimu vlastních textů.",
        );
      }

      if (requestedMode === "custom") {
        const finalLines = await tx
          .select()
          .from(invoiceLinesTable)
          .where(eq(invoiceLinesTable.invoiceId, id))
          .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);
        const groups =
          input.presentationGroups ??
          (normalizeMaterialDisplayMode(invoice.materialDisplayMode) ===
          "custom"
            ? getStoredInvoicePresentationGroups(invoice.materialDisplayMode)
            : finalLines.map((line, index) => ({
                description: line.description,
                lineIndexes: [index],
              })));
        let storedPresentation: string;
        try {
          storedPresentation = encodeInvoicePresentation(groups, finalLines);
        } catch (error) {
          throw appError(
            400,
            error instanceof Error
              ? error.message
              : "Vlastní podobu faktury nelze uložit.",
          );
        }
        await tx
          .update(invoicesTable)
          .set({
            materialDisplayMode: storedPresentation,
            updatedAt: new Date(),
          })
          .where(eq(invoicesTable.id, id));
      } else {
        await tx
          .update(invoicesTable)
          .set({ materialDisplayMode: requestedMode, updatedAt: new Date() })
          .where(eq(invoicesTable.id, id));
      }
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "invoice_draft_updated",
      entityType: "invoices",
      entityId: id,
      summary: `Koncept upraven${input.lines !== undefined ? `; obchodních řádků: ${input.lines.length}` : ""}${input.customerId !== undefined ? "; změněn odběratel" : ""}`,
      method: "PATCH",
      path: `/billing/invoices/${id}`,
    });
    if (customerMismatchOverrideSummary) {
      await tx.insert(auditLogTable).values({
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "invoice_customer_mismatch_override",
        entityType: "invoices",
        entityId: id,
        summary: customerMismatchOverrideSummary,
        method: "PATCH",
        path: `/billing/invoices/${id}`,
      });
    }
  });
  return getInvoiceDetail(id);
}

async function recalcWithin(exec: DbOrTx, id: number, vatModeDefault: VatMode) {
  const existing = await exec
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, id))
    .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);
  const computed: ComputedLine[] = [];
  for (const line of existing) {
    const c = computeLine(
      {
        rowType: line.rowType as "item" | "section",
        quantity: num(line.quantity),
        unitPriceWithoutVat: num(line.unitPriceWithoutVat),
        discountPercent:
          line.discountPercent == null ? null : num(line.discountPercent),
        vatRate: line.vatRate == null ? null : num(line.vatRate),
        vatMode: line.vatMode as VatMode,
      },
      vatModeDefault,
    );
    computed.push(c);
    await exec
      .update(invoiceLinesTable)
      .set({
        quantity: String(c.quantity),
        unitPriceWithoutVat: String(c.unitPriceWithoutVat),
        discountPercent:
          c.discountPercent == null ? null : String(c.discountPercent),
        vatRate: c.vatRate == null ? null : String(c.vatRate),
        vatMode: c.vatMode,
        totalWithoutVat: String(c.totalWithoutVat),
        totalVat: String(c.totalVat),
        totalWithVat: String(c.totalWithVat),
        updatedAt: new Date(),
      })
      .where(eq(invoiceLinesTable.id, line.id));
  }
  await writeTotals(exec, id, computed);
}

export async function recalcDraft(id: number) {
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  if (!invoice) throw appError(404, "Faktura nenalezena.");
  if (invoice.status !== "draft") {
    throw appError(409, "Přepočítat lze pouze koncept faktury.");
  }
  await recalcWithin(db, id, invoice.vatModeDefault as VatMode);
  return getInvoiceDetail(id);
}

export async function deleteDraft(
  id: number,
  actor: Actor = { userId: null, name: "Systém" },
) {
  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status !== "draft") {
      throw appError(409, "Smazat lze pouze koncept faktury.");
    }
    // Free any reserved cost-document lines + job materials before removal.
    await releaseInvoicedLines(tx, id);
    await releaseInvoicedMaterials(tx, id);
    await releaseWorkSessionBilling(tx, id, actor.userId, "draft_deleted");
    await releaseQuoteInvoiceBilling(tx, id, actor.userId, "draft_deleted");
    await tx
      .update(invoiceSourceAllocationsTable)
      .set({
        status: "released",
        invoiceLineId: null,
        updatedByUserId: actor.userId,
        updatedAt: new Date(),
        releasedAt: new Date(),
      })
      .where(eq(invoiceSourceAllocationsTable.invoiceId, id));
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "invoice_draft_deleted",
      entityType: "invoices",
      entityId: id,
      summary: `${invoice.documentType === "advance" ? "Zálohový" : "Běžný"} koncept #${id} smazán; rezervace uvolněny`,
      method: "DELETE",
      path: `/billing/invoices/${id}`,
    });
    await tx.delete(invoicesTable).where(eq(invoicesTable.id, id));
  });
}

async function releaseWorkSessionBilling(
  tx: Tx,
  invoiceId: number,
  actorUserId: number | null,
  reason: string,
) {
  const links = await tx
    .select({ sessionId: workSessionBillingLinksTable.sessionId })
    .from(workSessionBillingLinksTable)
    .where(
      and(
        eq(workSessionBillingLinksTable.invoiceId, invoiceId),
        inArray(workSessionBillingLinksTable.status, ["reserved", "billed"]),
      ),
    );
  if (!links.length) return;
  const now = new Date();
  await tx
    .update(workSessionBillingLinksTable)
    .set({
      status: "released",
      releasedAt: now,
      releasedByUserId: actorUserId,
      releaseReason: reason,
    })
    .where(
      and(
        eq(workSessionBillingLinksTable.invoiceId, invoiceId),
        inArray(workSessionBillingLinksTable.status, ["reserved", "billed"]),
      ),
    );
  await tx
    .update(workSessionsTable)
    .set({ billingStatus: "unbilled", updatedAt: now })
    .where(
      inArray(
        workSessionsTable.id,
        links.map((link) => link.sessionId),
      ),
    );
}

async function releaseQuoteInvoiceBilling(
  tx: Tx,
  invoiceId: number,
  actorUserId: number | null,
  reason: string,
) {
  const links = await tx
    .select({ quoteId: quoteInvoiceLinksTable.quoteId })
    .from(quoteInvoiceLinksTable)
    .where(
      and(
        eq(quoteInvoiceLinksTable.invoiceId, invoiceId),
        inArray(quoteInvoiceLinksTable.status, ["reserved", "billed"]),
      ),
    );
  if (!links.length) return;
  const now = new Date();
  await tx
    .update(quoteInvoiceLinksTable)
    .set({
      status: "released",
      releasedAt: now,
      releasedByUserId: actorUserId,
      releaseReason: reason,
    })
    .where(
      and(
        eq(quoteInvoiceLinksTable.invoiceId, invoiceId),
        inArray(quoteInvoiceLinksTable.status, ["reserved", "billed"]),
      ),
    );
  await tx
    .update(quotesTable)
    .set({ convertedToInvoiceId: null, updatedAt: now })
    .where(
      and(
        inArray(
          quotesTable.id,
          links.map((link) => link.quoteId),
        ),
        eq(quotesTable.convertedToInvoiceId, invoiceId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Number generation
// ---------------------------------------------------------------------------

function buildInvoiceNumber(
  prefix: string,
  format: string,
  year: number,
  seq: number,
): string {
  return format
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{SEQ4\}/g, String(seq).padStart(4, "0"))
    .replace(/\{SEQ\}/g, String(seq));
}

// ---------------------------------------------------------------------------
// Issue (one transaction)
// ---------------------------------------------------------------------------

/**
 * Build the Czech "QR Platba" payment-code data URL for an invoice, or null when
 * no usable IBAN / positive amount is available, or the payment method isn't a
 * bank transfer (cash/card invoices get no transfer QR).
 */
async function buildPaymentQrDataUrl(
  invoice: Invoice,
  settings: BillingSettings,
): Promise<string | null> {
  if (invoice.paymentMethod === "cash" || invoice.paymentMethod === "card")
    return null;
  const iban = resolveIban(
    invoice.iban ?? settings.iban,
    invoice.bankAccount ?? settings.bankAccount,
  );
  if (!iban) return null;
  const amount = num(invoice.totalWithVat);
  if (!(amount > 0)) return null;

  const payload = buildSpayd({
    iban,
    bic: invoice.bic ?? settings.bic,
    amount,
    currency: invoice.currency || "CZK",
    variableSymbol: invoice.variableSymbol,
    message: invoice.invoiceNumber
      ? `${invoice.documentType === "advance" ? "Záloha" : "Faktura"} ${invoice.invoiceNumber}`
      : null,
    dueDateIso: invoice.dueDate,
  });
  try {
    return await generatePaymentQrDataUrl(payload);
  } catch {
    return null;
  }
}

async function buildPdfData(
  invoice: Invoice,
  lines: InvoiceLine[],
  settings: BillingSettings,
): Promise<InvoicePdfData> {
  const paymentQrDataUrl = await buildPaymentQrDataUrl(invoice, settings);
  const presentationLines = presentInvoiceLines(
    lines,
    invoice.materialDisplayMode,
  );
  return {
    documentType: invoice.documentType as "standard" | "advance",
    invoiceNumber: invoice.invoiceNumber ?? "—",
    status: invoice.status,
    customerName: invoice.customerName,
    customerIc: invoice.customerIc,
    customerDic: invoice.customerDic,
    customerAddress: invoice.customerAddress,
    customerDeliveryAddress: invoice.customerDeliveryAddress,
    customerEmail: invoice.customerEmail,
    issueDate: invoice.issueDate,
    taxableSupplyDate: invoice.taxableSupplyDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    paymentMethod: invoice.paymentMethod,
    variableSymbol: invoice.variableSymbol,
    constantSymbol: invoice.constantSymbol,
    specificSymbol: invoice.specificSymbol,
    vatModeDefault: invoice.vatModeDefault as VatMode,
    notes: invoice.notes,
    subtotalWithoutVat: num(invoice.subtotalWithoutVat),
    totalVat: num(invoice.totalVat),
    totalWithVat: num(invoice.totalWithVat),
    lines: presentationLines.map((l) => ({
      rowType: l.rowType as "item" | "section",
      description: l.description,
      unit: l.unit,
      quantity: num(l.quantity),
      unitPriceWithoutVat: num(l.unitPriceWithoutVat),
      discountPercent:
        l.discountPercent == null ? null : num(l.discountPercent),
      vatMode: l.vatMode as VatMode,
      vatRate: l.vatRate == null ? null : num(l.vatRate),
      totalWithoutVat: num(l.totalWithoutVat),
      totalVat: num(l.totalVat),
      totalWithVat: num(l.totalWithVat),
    })),
    supplier: {
      name: settings.supplierName,
      ic: settings.supplierIc,
      dic: settings.supplierDic,
      address: settings.supplierAddress,
      email: settings.supplierEmail,
      phone: settings.supplierPhone,
      bankAccount: invoice.bankAccount ?? settings.bankAccount,
      iban: invoice.iban ?? settings.iban,
      bic: invoice.bic ?? settings.bic,
      footerNote: settings.invoiceFooterNote,
      vatPayer: settings.vatPayer,
    },
    paymentQrDataUrl,
  };
}

export async function issueInvoice(id: number, actor: Actor) {
  await ensureBillingSettings();
  const accountingDualWriteEnabled = isAccountingIssueInvoiceDualWriteEnabled();

  const pdfPath = await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status !== "draft") {
      if (isIdempotentIssueRetryStatus(invoice.status)) {
        // Invoice id is the idempotency key for finalisation. A retry returns
        // the already-issued snapshot and never consumes another number.
        return invoice.pdfObjectPath;
      }
      throw appError(409, "Vystavit lze pouze koncept faktury.");
    }
    const isAdvance = invoice.documentType === "advance";
    if (!invoice.customerName?.trim()) {
      throw appError(400, "Před vystavením doplňte název odběratele.");
    }

    // Recompute every line + the invoice totals from the current line inputs
    // inside this same transaction, so the issued (immutable) document and its
    // PDF can never capture stale or tampered totals.
    await recalcWithin(tx, id, invoice.vatModeDefault as VatMode);
    const issueLines = await tx
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, id))
      .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);
    if (!issueLines.some((line) => line.rowType === "item")) {
      throw appError(400, "Faktura musí obsahovat alespoň jednu položku.");
    }
    const allocations = isAdvance
      ? []
      : await tx
          .select()
          .from(invoiceSourceAllocationsTable)
          .where(eq(invoiceSourceAllocationsTable.invoiceId, id))
          .for("update");
    const invalidAllocation = allocations.find(
      (allocation) => allocation.status !== "reserved",
    );
    if (invalidAllocation) {
      throw appError(
        409,
        `Zdroj #${invalidAllocation.id} už není rezervován tímto konceptem.`,
      );
    }

    const [quoteBilling] = await tx
      .select({
        quoteId: quoteInvoiceLinksTable.quoteId,
        jobGroupId: quoteInvoiceLinksTable.jobGroupId,
      })
      .from(quoteInvoiceLinksTable)
      .where(
        and(
          eq(quoteInvoiceLinksTable.invoiceId, id),
          inArray(quoteInvoiceLinksTable.status, ["reserved", "billed"]),
        ),
      )
      .for("update")
      .limit(1);
    if (!isAdvance && quoteBilling?.jobGroupId != null) {
      const [sourceQuote] = await tx
        .select({
          status: quotesTable.status,
          convertedToInvoiceId: quotesTable.convertedToInvoiceId,
          convertedToJobId: quotesTable.convertedToJobId,
        })
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteBilling.quoteId))
        .for("update");
      if (
        !sourceQuote ||
        sourceQuote.status !== "accepted" ||
        sourceQuote.convertedToInvoiceId !== id
      ) {
        throw appError(
          409,
          "Vazba faktury na přijatou nabídku už není platná.",
        );
      }
      const currentGroupJobs = await tx
        .select({
          id: jobsTable.id,
          title: jobsTable.title,
          status: jobsTable.status,
          billingIntent: jobsTable.billingIntent,
        })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.groupId, quoteBilling.jobGroupId),
            isNull(jobsTable.archivedAt),
          ),
        )
        .for("update");
      const unfinished = currentGroupJobs.find(
        (job) => !["done", "cancelled"].includes(job.status),
      );
      if (unfinished) {
        throw appError(
          409,
          `Zakázka „${unfinished.title}“ v akci už není dokončená; fakturu nelze vystavit.`,
        );
      }
      const primaryJob = currentGroupJobs.find(
        (job) => job.id === sourceQuote.convertedToJobId,
      );
      if (!primaryJob || primaryJob.billingIntent !== "billable") {
        throw appError(
          409,
          "Hlavní zakázka přijaté nabídky už není určená k fakturaci.",
        );
      }
      await ensureQuoteGroupSourceLinks(tx, id, quoteBilling.jobGroupId);
    }

    // Verify every linked job is still "done" (could have been reopened / billed
    // by a competing draft since this draft was built).
    const links = await tx
      .select({
        jobId: invoiceSourceLinksTable.jobId,
        activityId: invoiceSourceLinksTable.activityId,
        amountWithoutVat: invoiceSourceLinksTable.amountWithoutVat,
      })
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.invoiceId, id));
    const jobIds = links
      .map((l) => l.jobId)
      .filter((x): x is number => x != null);
    const activityIds = links
      .map((l) => l.activityId)
      .filter((x): x is number => x != null);
    if (!isAdvance && jobIds.length) {
      const jobs = await tx
        .select()
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds))
        .for("update");
      for (const job of jobs) {
        if (job.status !== "done") {
          throw appError(
            409,
            `Zakázku „${job.title}" už nelze fakturovat (stav: ${job.status}).`,
          );
        }
        if (job.billingIntent !== "billable") {
          throw appError(
            409,
            `Zakázku „${job.title}" už nelze fakturovat, protože je označena jako nefakturovaná.`,
          );
        }
      }
    }
    // Verify linked activities are still completed (could have been reopened)
    // AND are not already billed by another non-cancelled invoice. Unlike jobs,
    // activities have no status transition to block re-billing, so the source
    // link is the only guard against a competing draft double-billing them.
    if (!isAdvance && activityIds.length) {
      const acts = await tx
        .select()
        .from(activitiesTable)
        .where(inArray(activitiesTable.id, activityIds))
        .for("update");
      const actById = new Map(acts.map((a) => [a.id, a]));
      for (const act of acts) {
        if (act.completedAt == null) {
          throw appError(
            409,
            `Akci „${act.name}" už nelze fakturovat (není dokončená).`,
          );
        }
      }
      const alreadyBilled = await tx
        .select({ activityId: invoiceSourceLinksTable.activityId })
        .from(invoiceSourceLinksTable)
        .innerJoin(
          invoicesTable,
          eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
        )
        .where(
          and(
            inArray(invoiceSourceLinksTable.activityId, activityIds),
            ne(invoiceSourceLinksTable.invoiceId, id),
            eq(invoicesTable.status, "draft"),
            eq(invoicesTable.documentType, "standard"),
          ),
        );
      if (alreadyBilled.length) {
        const conflictId = alreadyBilled[0].activityId;
        const name =
          conflictId != null ? actById.get(conflictId)?.name : undefined;
        throw appError(
          409,
          `Akci „${name ?? `#${conflictId}`}" už nelze fakturovat (je na jiné faktuře).`,
        );
      }
    }

    // Lock settings + assign number transactionally (year rollover resets seq).
    const [settings] = await tx
      .select()
      .from(billingSettingsTable)
      .where(eq(billingSettingsTable.id, SETTINGS_ID))
      .for("update");
    const year = new Date().getFullYear();
    const seq = isAdvance
      ? settings.advanceNumberYear === year
        ? settings.advanceNumberNextSeq
        : 1
      : settings.numberYear === year
        ? settings.numberNextSeq
        : 1;
    const invoiceNumber = buildInvoiceNumber(
      isAdvance ? settings.advanceNumberPrefix : settings.numberPrefix,
      isAdvance ? settings.advanceNumberFormat : settings.numberFormat,
      year,
      seq,
    );
    await tx
      .update(billingSettingsTable)
      .set(
        isAdvance
          ? {
              advanceNumberYear: year,
              advanceNumberNextSeq: seq + 1,
              updatedAt: new Date(),
            }
          : {
              numberYear: year,
              numberNextSeq: seq + 1,
              updatedAt: new Date(),
            },
      )
      .where(eq(billingSettingsTable.id, SETTINGS_ID));

    const issueDate = invoice.issueDate ?? todayIso();
    const taxableSupplyDate = isAdvance
      ? invoice.taxableSupplyDate
      : (invoice.taxableSupplyDate ?? issueDate);
    const dueDate =
      invoice.dueDate ?? addDaysIso(issueDate, settings.defaultDueDays);
    const variableSymbol =
      invoice.variableSymbol || invoiceVariableSymbol(invoiceNumber);

    const [updated] = await tx
      .update(invoicesTable)
      .set({
        status: "issued",
        invoiceNumber,
        issueDate,
        taxableSupplyDate,
        dueDate,
        variableSymbol,
        constantSymbol: invoice.constantSymbol ?? INVOICE_CONSTANT_SYMBOL,
        issuedByUserId: actor.userId,
        issuedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invoicesTable.id, id))
      .returning();

    const lines = await tx
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, id))
      .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);

    const workLinks = await tx
      .select({
        sessionId: workSessionBillingLinksTable.sessionId,
        amountWithoutVatSnapshot:
          workSessionBillingLinksTable.amountWithoutVatSnapshot,
      })
      .from(workSessionBillingLinksTable)
      .where(
        and(
          eq(workSessionBillingLinksTable.invoiceId, id),
          eq(workSessionBillingLinksTable.status, "reserved"),
        ),
      );

    // Generate + store the PDF. If the upload throws, the whole transaction
    // rolls back (number increment included) — no half-issued invoice, no gap.
    const pdfData = await buildPdfData(updated, lines, settings);
    const pdfBuffer = generateInvoicePdf(pdfData);
    const objectPath = `/objects/invoices/${invoiceNumber}.pdf`;
    if (accountingDualWriteEnabled) {
      const evidence = buildIssuedInvoiceAccountingEvidence({
        invoice: updated,
        lines,
        invoiceSourceLinks: links,
        workSessionLinks: workLinks,
        settings,
        actor,
        pdfBuffer,
        objectPath,
      });
      await appendInitialAccountingVersionInTransaction(
        createAccountingPersistenceDbAdapter(tx),
        evidence.version,
        evidence.event,
      );
    }
    await objectStorage.putPrivateObject(
      objectPath,
      pdfBuffer,
      "application/pdf",
    );
    await tx
      .update(invoicesTable)
      .set({ pdfObjectPath: objectPath, updatedAt: new Date() })
      .where(eq(invoicesTable.id, id));

    const deferredJobIds = new Set(
      allocations
        .filter((row) => row.settlementMethod === "deferred")
        .map((row) => row.jobId)
        .filter((jobId): jobId is number => jobId != null),
    );
    const fullySettledJobIds = jobIds.filter(
      (jobId) => !deferredJobIds.has(jobId),
    );
    // Advance payment requests never settle a job. A standard invoice marks a
    // job fully billed only when none of its selected sources was deferred.
    if (!isAdvance && fullySettledJobIds.length) {
      await tx
        .update(jobsTable)
        .set({ status: "vyfakturovano" })
        .where(inArray(jobsTable.id, fullySettledJobIds));
    }
    // Mark billed activities (cosmetic flag; the source link is the source of
    // truth for unbilled selection — see getBilledActivityIds).
    const deferredActivityIds = new Set(
      allocations
        .filter((row) => row.settlementMethod === "deferred")
        .map((row) => row.activityId)
        .filter((activityId): activityId is number => activityId != null),
    );
    const fullySettledActivityIds = activityIds.filter(
      (activityId) => !deferredActivityIds.has(activityId),
    );
    if (!isAdvance && fullySettledActivityIds.length) {
      await tx
        .update(activitiesTable)
        .set({ billingStatus: "billed", updatedAt: new Date() })
        .where(inArray(activitiesTable.id, fullySettledActivityIds));
    }

    const workAllocationBySession = new Map(
      allocations
        .filter((row) => row.sourceType === "work_session")
        .map((row) => [row.sourceId, row]),
    );
    const billedWorkIds = workLinks
      .map((link) => link.sessionId)
      .filter((sessionId) => {
        const allocation = workAllocationBySession.get(sessionId);
        return allocation == null || allocation.settlementMethod !== "deferred";
      });
    const deferredWorkIds = workLinks
      .map((link) => link.sessionId)
      .filter(
        (sessionId) =>
          workAllocationBySession.get(sessionId)?.settlementMethod ===
          "deferred",
      );
    if (!isAdvance && billedWorkIds.length) {
      await tx
        .update(workSessionBillingLinksTable)
        .set({ status: "billed", billedAt: new Date() })
        .where(
          and(
            eq(workSessionBillingLinksTable.invoiceId, id),
            eq(workSessionBillingLinksTable.status, "reserved"),
            inArray(workSessionBillingLinksTable.sessionId, billedWorkIds),
          ),
        );
      await tx
        .update(workSessionsTable)
        .set({ billingStatus: "billed", updatedAt: new Date() })
        .where(inArray(workSessionsTable.id, billedWorkIds));
    }
    if (!isAdvance && deferredWorkIds.length) {
      await tx
        .update(workSessionBillingLinksTable)
        .set({
          status: "released",
          releasedAt: new Date(),
          releasedByUserId: actor.userId,
          releaseReason: "deferred_to_later_invoice",
        })
        .where(
          and(
            eq(workSessionBillingLinksTable.invoiceId, id),
            eq(workSessionBillingLinksTable.status, "reserved"),
            inArray(workSessionBillingLinksTable.sessionId, deferredWorkIds),
          ),
        );
      await tx
        .update(workSessionsTable)
        .set({ billingStatus: "unbilled", updatedAt: new Date() })
        .where(inArray(workSessionsTable.id, deferredWorkIds));
    }

    if (!isAdvance) {
      const deferredMaterialIds = allocations
        .filter(
          (row) =>
            row.sourceType === "material" &&
            row.settlementMethod === "deferred",
        )
        .map((row) => row.sourceId);
      if (deferredMaterialIds.length) {
        await tx
          .update(materialsTable)
          .set({ invoicedInvoiceId: null, invoicedAt: null })
          .where(
            and(
              inArray(materialsTable.id, deferredMaterialIds),
              eq(materialsTable.invoicedInvoiceId, id),
            ),
          );
      }
      const deferredCostLineIds = allocations
        .filter(
          (row) =>
            row.sourceType === "billing_document_line" &&
            row.settlementMethod === "deferred",
        )
        .map((row) => row.sourceId);
      if (deferredCostLineIds.length) {
        await tx
          .update(billingDocumentLinesTable)
          .set({ invoicedInvoiceId: null, updatedAt: new Date() })
          .where(
            and(
              inArray(billingDocumentLinesTable.id, deferredCostLineIds),
              eq(billingDocumentLinesTable.invoicedInvoiceId, id),
            ),
          );
      }

      for (const allocation of allocations) {
        const finalStatus = finalAllocationStatus(
          allocation.settlementMethod as SettlementMethod,
        );
        await tx
          .update(invoiceSourceAllocationsTable)
          .set({
            status: finalStatus,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
            settledAt: new Date(),
          })
          .where(eq(invoiceSourceAllocationsTable.id, allocation.id));
      }

      await tx
        .update(quoteInvoiceLinksTable)
        .set({ status: "billed", billedAt: new Date() })
        .where(
          and(
            eq(quoteInvoiceLinksTable.invoiceId, id),
            eq(quoteInvoiceLinksTable.status, "reserved"),
          ),
        );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "issue",
      entityType: "invoices",
      entityId: id,
      summary: `${isAdvance ? "Zálohová faktura" : "Faktura"} ${invoiceNumber} vystavena${
        jobIds.length ? ` (zakázky: ${jobIds.join(", ")})` : ""
      }${activityIds.length ? ` (akce: ${activityIds.join(", ")})` : ""}`,
      method: "POST",
      path: `/billing/invoices/${id}/issue`,
    });

    return objectPath;
  });

  void pdfPath;
  return getInvoiceDetail(id);
}

// ---------------------------------------------------------------------------
// Cancel (storno) + status transitions
// ---------------------------------------------------------------------------

export const INVOICE_CANCELLATION_REASON_CODES = [
  "customer_complaint",
  "incorrect_job",
  "billing_error",
  "duplicate_invoice",
  "order_cancelled",
] as const;

export type InvoiceCancellationReasonCode =
  (typeof INVOICE_CANCELLATION_REASON_CODES)[number];

export interface CancelInvoiceInput {
  returnJobsToDone: boolean;
  reasonCode: InvoiceCancellationReasonCode;
}

export async function cancelInvoice(
  id: number,
  input: CancelInvoiceInput,
  actor: Actor,
) {
  if (!INVOICE_CANCELLATION_REASON_CODES.includes(input.reasonCode)) {
    throw appError(400, "Důvod storna není podporován.");
  }
  const accountingDualWriteEnabled =
    isAccountingCancelInvoiceDualWriteEnabled();
  await db.transaction(async (tx) => {
    const { reasonCode, returnJobsToDone } = input;
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status === "cancelled") {
      throw appError(409, "Faktura je již stornována.");
    }
    if (
      invoice.status === "paid" ||
      invoice.paidDate !== null ||
      invoice.paidAmount !== null
    ) {
      throw appError(
        409,
        "Fakturu s platebním důkazem nelze přímo stornovat. Použijte navázanou opravu platby a účetní storno.",
      );
    }

    const cancelledAt = new Date();
    if (accountingDualWriteEnabled) {
      if (!new Set(["issued", "sent"]).has(invoice.status)) {
        throw appError(
          409,
          "Účetní storno lze vytvořit pouze k vystavené nebo odeslané faktuře.",
        );
      }
      const [head] = await tx
        .select({
          versionHeadId: accountingAggregateHeadsTable.versionHeadId,
          lifecycleHeadSequence:
            accountingAggregateHeadsTable.lifecycleHeadSequence,
          lifecycleHeadSha256:
            accountingAggregateHeadsTable.lifecycleHeadSha256,
        })
        .from(accountingAggregateHeadsTable)
        .where(eq(accountingAggregateHeadsTable.invoiceId, id))
        .limit(1);
      if (
        !head?.versionHeadId ||
        head.lifecycleHeadSequence === null ||
        !head.lifecycleHeadSha256
      ) {
        throw appError(
          409,
          "Vystavená faktura nemá úplnou nativní účetní hlavu. Nejdříve ji zařaďte do řízeného legacy backfillu.",
        );
      }
      const [targetRow] = await tx
        .select({
          canonicalJson: accountingDocumentVersionsTable.canonicalJson,
        })
        .from(accountingDocumentVersionsTable)
        .where(eq(accountingDocumentVersionsTable.id, head.versionHeadId))
        .limit(1);
      if (!targetRow) {
        throw appError(409, "Účetní hlava odkazuje na chybějící verzi.");
      }
      const targetVersion = verifyCanonicalAccountingDocumentVersionJsonBytes(
        targetRow.canonicalJson,
      );
      if (
        targetVersion.aggregate.kind !== "outgoing-invoice" ||
        targetVersion.aggregate.id !== String(id)
      ) {
        throw appError(
          409,
          "Účetní hlava faktury neodpovídá zamčenému dokladu.",
        );
      }
      const nextVersion = BigInt(targetVersion.version) + 1n;
      const objectPath = invoiceCancellationObjectPath({
        invoiceNumber: invoice.invoiceNumber ?? String(id),
        nextVersion,
        targetVersionId: targetVersion.versionId,
        reasonCode,
        recordedAt: cancelledAt,
      });
      let evidence;
      try {
        evidence = buildInvoiceCancellationAccountingEvidence({
          targetVersion,
          actor,
          reasonCode,
          recordedAt: cancelledAt,
          nextLifecycleSequence: head.lifecycleHeadSequence + 1n,
          previousLifecycleEventSha256: head.lifecycleHeadSha256,
          objectPath,
        });
      } catch (error) {
        throw appError(
          409,
          `Účetní storno nelze bezpečně vytvořit: ${error instanceof Error ? error.message : "neznámá chyba"}`,
        );
      }
      await appendAccountingCorrectionBundleInTransaction(
        createAccountingPersistenceDbAdapter(tx),
        {
          sourceVersion: evidence.cancellationVersion,
          targetVersion: evidence.targetVersion,
          relation: evidence.relation,
          lifecycleEvent: evidence.event,
        },
      );
      await objectStorage.putPrivateObject(
        objectPath,
        evidence.pdfBuffer,
        "application/pdf",
      );
    }

    await tx
      .update(invoicesTable)
      .set({
        status: "cancelled",
        cancelledAt,
        updatedAt: cancelledAt,
      })
      .where(eq(invoicesTable.id, id));

    const allocations = await tx
      .select()
      .from(invoiceSourceAllocationsTable)
      .where(eq(invoiceSourceAllocationsTable.invoiceId, id))
      .for("update");
    const reservedAllocationIds = allocations
      .filter((row) => row.status === "reserved")
      .map((row) => row.id);
    const finalAllocationIds = allocations
      .filter((row) =>
        ["billed", "included_in_lump_sum", "not_charged", "deferred"].includes(
          row.status,
        ),
      )
      .map((row) => row.id);
    if (reservedAllocationIds.length) {
      await tx
        .update(invoiceSourceAllocationsTable)
        .set({
          status: "released",
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
          releasedAt: new Date(),
        })
        .where(
          inArray(invoiceSourceAllocationsTable.id, reservedAllocationIds),
        );
    }
    if (finalAllocationIds.length) {
      await tx
        .update(invoiceSourceAllocationsTable)
        .set({
          status: "reversed",
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
          reversedAt: new Date(),
        })
        .where(inArray(invoiceSourceAllocationsTable.id, finalAllocationIds));
    }

    // A payment request has no operational settlement to undo. A standard
    // invoice releases customer-billing provenance only; stock consumption has
    // already happened on the work/material event and is never moved here.
    if (invoice.documentType === "standard") {
      await releaseInvoicedLines(tx, id);
      await releaseInvoicedMaterials(tx, id);
      await releaseWorkSessionBilling(
        tx,
        id,
        actor.userId,
        "invoice_cancelled",
      );
      await releaseQuoteInvoiceBilling(
        tx,
        id,
        actor.userId,
        "invoice_cancelled",
      );
    }

    const links = await tx
      .select({
        jobId: invoiceSourceLinksTable.jobId,
        activityId: invoiceSourceLinksTable.activityId,
      })
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.invoiceId, id));
    const jobIds = links
      .map((l) => l.jobId)
      .filter((x): x is number => x != null);
    const activityIds = links
      .map((l) => l.activityId)
      .filter((x): x is number => x != null);

    if (
      invoice.documentType === "standard" &&
      returnJobsToDone &&
      jobIds.length
    ) {
      // Only revert jobs we actually flipped (still "vyfakturováno").
      await tx
        .update(jobsTable)
        .set({ status: "done" })
        .where(
          and(
            inArray(jobsTable.id, jobIds),
            eq(jobsTable.status, "vyfakturovano"),
          ),
        );
    }
    // Clear the cosmetic billed flag on the activities this invoice marked. The
    // storno already removes them from the billed set (cancelled invoices are
    // excluded), so they return to the unbilled pool regardless.
    if (invoice.documentType === "standard" && activityIds.length) {
      await tx
        .update(activitiesTable)
        .set({ billingStatus: null, updatedAt: new Date() })
        .where(
          and(
            inArray(activitiesTable.id, activityIds),
            eq(activitiesTable.billingStatus, "billed"),
          ),
        );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "cancel",
      entityType: "invoices",
      entityId: id,
      summary: `${invoice.documentType === "advance" ? "Zálohová faktura" : "Faktura"} ${invoice.invoiceNumber ?? `#${id}`} stornována${
        invoice.documentType === "standard" && returnJobsToDone && jobIds.length
          ? ` (zakázky vráceny: ${jobIds.join(", ")})`
          : ""
      }${activityIds.length ? ` (akce uvolněny: ${activityIds.join(", ")})` : ""} (důvod: ${reasonCode})`,
      method: "POST",
      path: `/billing/invoices/${id}/cancel`,
    });
  });
  return getInvoiceDetail(id);
}

export interface InvoiceStatusInput {
  status: "sent" | "paid";
  paidDate?: string | null;
  paidAmount?: number | null;
}

/**
 * Compute the `paidDate` / `paidAmount` columns for a "paid" transition. Shared
 * by the manual status update and the bank-statement confirm flow so both record
 * payment metadata identically: explicit input wins, then any value already on
 * the invoice, then sensible defaults (today / full invoice total).
 */
export function paidTransitionFields(
  invoice: typeof invoicesTable.$inferSelect,
  input: { paidDate?: string | null; paidAmount?: number | null },
): { paidDate: string; paidAmount: string } {
  const amount =
    input.paidAmount != null
      ? input.paidAmount
      : invoice.paidAmount != null
        ? num(invoice.paidAmount)
        : num(invoice.totalWithVat);
  if (!Number.isFinite(amount) || amount < 0) {
    throw appError(400, "Zaplacená částka musí být konečné nezáporné číslo.");
  }
  const paidDate = input.paidDate ?? invoice.paidDate ?? todayIso();
  const parsedPaidDate = /^\d{4}-\d{2}-\d{2}$/.test(paidDate)
    ? new Date(`${paidDate}T00:00:00.000Z`)
    : null;
  if (
    !parsedPaidDate ||
    Number.isNaN(parsedPaidDate.getTime()) ||
    parsedPaidDate.toISOString().slice(0, 10) !== paidDate
  ) {
    throw appError(
      400,
      "Datum platby musí být platné datum ve formátu YYYY-MM-DD.",
    );
  }
  return {
    paidDate,
    paidAmount: String(round2(amount)),
  };
}

type NativeInvoiceAccountingContext = {
  version: AccountingDocumentVersionV1;
  lifecycleEvent: AccountingLifecycleEventV1;
  lifecycleSequence: bigint;
  lifecycleSha256: string;
  paymentSequence: bigint | null;
  paymentSha256: string | null;
};

async function loadNativeInvoiceAccountingContext(
  tx: Tx,
  invoiceId: number,
): Promise<NativeInvoiceAccountingContext | null> {
  const [head] = await tx
    .select({
      versionHeadId: accountingAggregateHeadsTable.versionHeadId,
      lifecycleHeadSequence:
        accountingAggregateHeadsTable.lifecycleHeadSequence,
      lifecycleHeadId: accountingAggregateHeadsTable.lifecycleHeadId,
      lifecycleHeadSha256: accountingAggregateHeadsTable.lifecycleHeadSha256,
      paymentHeadSequence: accountingAggregateHeadsTable.paymentHeadSequence,
      paymentHeadId: accountingAggregateHeadsTable.paymentHeadId,
      paymentHeadSha256: accountingAggregateHeadsTable.paymentHeadSha256,
    })
    .from(accountingAggregateHeadsTable)
    .where(eq(accountingAggregateHeadsTable.invoiceId, invoiceId))
    .limit(1);
  if (!head) return null;
  if (
    !head.versionHeadId ||
    head.lifecycleHeadSequence === null ||
    !head.lifecycleHeadId ||
    !head.lifecycleHeadSha256
  ) {
    throw appError(409, "Účetní hlava faktury je neúplná.");
  }
  const paymentHeadParts = [
    head.paymentHeadSequence,
    head.paymentHeadId,
    head.paymentHeadSha256,
  ];
  if (
    paymentHeadParts.some((value) => value !== null) &&
    paymentHeadParts.some((value) => value === null)
  ) {
    throw appError(409, "Platební účetní hlava faktury je neúplná.");
  }

  const [versionRow] = await tx
    .select({ canonicalJson: accountingDocumentVersionsTable.canonicalJson })
    .from(accountingDocumentVersionsTable)
    .where(eq(accountingDocumentVersionsTable.id, head.versionHeadId))
    .limit(1);
  if (!versionRow) {
    throw appError(409, "Účetní hlava odkazuje na chybějící verzi.");
  }
  const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
    versionRow.canonicalJson,
  );
  if (
    version.aggregate.kind !== "outgoing-invoice" ||
    version.aggregate.id !== String(invoiceId) ||
    !new Set(["issued", "correction"]).has(version.purpose)
  ) {
    throw appError(
      409,
      "Aktuální účetní verze neodpovídá aktivní vydané faktuře.",
    );
  }

  const [lifecycleRow] = await tx
    .select({
      id: accountingLifecycleEventsTable.id,
      entrySha256: accountingLifecycleEventsTable.entrySha256,
      canonicalJson: accountingLifecycleEventsTable.canonicalJson,
    })
    .from(accountingLifecycleEventsTable)
    .where(eq(accountingLifecycleEventsTable.id, head.lifecycleHeadId))
    .limit(1);
  if (!lifecycleRow) {
    throw appError(
      409,
      "Účetní hlava odkazuje na chybějící lifecycle událost.",
    );
  }
  const lifecycleValue = verifyCanonicalAccountingLifecycleEntryJsonBytes(
    lifecycleRow.canonicalJson,
  );
  if (!("eventId" in lifecycleValue)) {
    throw appError(409, "Účetní lifecycle hlava odkazuje na jiný typ důkazu.");
  }
  const lifecycleEvent = lifecycleValue as AccountingLifecycleEventV1;
  if (
    lifecycleEvent.eventId !== lifecycleRow.id ||
    lifecycleEvent.integrity.entrySha256 !== lifecycleRow.entrySha256 ||
    lifecycleEvent.integrity.entrySha256 !== head.lifecycleHeadSha256 ||
    lifecycleEvent.sequence !== head.lifecycleHeadSequence.toString() ||
    lifecycleEvent.aggregate.kind !== "outgoing-invoice" ||
    lifecycleEvent.aggregate.id !== String(invoiceId) ||
    lifecycleEvent.aggregate.versionId !== version.versionId
  ) {
    throw appError(409, "Účetní lifecycle hlava faktury je nekonzistentní.");
  }

  if (head.paymentHeadId !== null) {
    const [paymentRow] = await tx
      .select()
      .from(accountingPaymentEventsTable)
      .where(eq(accountingPaymentEventsTable.id, head.paymentHeadId))
      .limit(1);
    if (!paymentRow) {
      throw appError(
        409,
        "Platební účetní hlava odkazuje na chybějící událost.",
      );
    }
    const paymentEvent = accountingPaymentEventFromRow(paymentRow);
    if (
      paymentEvent.invoiceId !== String(invoiceId) ||
      paymentEvent.paymentEventId !== head.paymentHeadId ||
      paymentEvent.sequence !== head.paymentHeadSequence!.toString() ||
      paymentEvent.integrity.entrySha256 !== head.paymentHeadSha256
    ) {
      throw appError(409, "Platební účetní hlava faktury je nekonzistentní.");
    }
  }

  return {
    version,
    lifecycleEvent,
    lifecycleSequence: head.lifecycleHeadSequence,
    lifecycleSha256: head.lifecycleHeadSha256,
    paymentSequence: head.paymentHeadSequence,
    paymentSha256: head.paymentHeadSha256,
  };
}

function requireNativeInvoiceAccountingContext(
  context: NativeInvoiceAccountingContext | null,
): NativeInvoiceAccountingContext {
  if (!context) {
    throw appError(
      409,
      "Faktura nemá nativní účetní evidenci. Nejdříve ji zařaďte do řízeného legacy backfillu.",
    );
  }
  return context;
}

function assertLifecycleMatchesInvoiceProjection(
  invoiceStatus: string,
  context: NativeInvoiceAccountingContext,
): void {
  if (invoiceStatus === "sent" && context.lifecycleEvent.eventType !== "sent") {
    throw appError(
      409,
      "Stav odeslané faktury nemá odpovídající append-only událost.",
    );
  }
  if (
    invoiceStatus === "issued" &&
    !new Set(["issued", "correction_linked"]).has(
      context.lifecycleEvent.eventType,
    )
  ) {
    throw appError(
      409,
      "Stav vystavené faktury neodpovídá účetní lifecycle hlavě.",
    );
  }
}

export async function updateInvoiceStatus(
  id: number,
  input: InvoiceStatusInput,
  actor: Actor,
) {
  const accountingDualWriteEnabled =
    isAccountingInvoiceStatusDualWriteEnabled();
  await db.transaction(async (tx) => {
    const { status } = input;
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status === "draft" || invoice.status === "cancelled") {
      throw appError(409, "Stav koncept/storno nelze takto měnit.");
    }
    if (
      status === "sent" &&
      (input.paidDate != null || input.paidAmount != null)
    ) {
      throw appError(
        400,
        "Platební údaje lze zadat pouze při označení faktury jako zaplacené.",
      );
    }

    if (invoice.status === "paid") {
      if (status !== "paid") {
        throw appError(
          409,
          "Zapsanou platbu nelze odstranit změnou stavu. Použijte navázanou opravu nebo storno.",
        );
      }
      const repeated = paidTransitionFields(invoice, input);
      if (
        repeated.paidDate !== invoice.paidDate ||
        Number(repeated.paidAmount) !== Number(invoice.paidAmount)
      ) {
        throw appError(
          409,
          "Zapsané platební údaje nelze přepsat. Použijte navázanou opravu platby.",
        );
      }
      if (accountingDualWriteEnabled) {
        const context = requireNativeInvoiceAccountingContext(
          await loadNativeInvoiceAccountingContext(tx, id),
        );
        if (
          context.paymentSequence === null ||
          context.paymentSha256 === null
        ) {
          throw appError(
            409,
            "Zaplacená faktura nemá odpovídající append-only platební událost.",
          );
        }
      }
      return;
    }

    if (status === "sent" && invoice.status === "sent") {
      if (accountingDualWriteEnabled) {
        const context = requireNativeInvoiceAccountingContext(
          await loadNativeInvoiceAccountingContext(tx, id),
        );
        assertLifecycleMatchesInvoiceProjection(invoice.status, context);
      }
      return;
    }
    if (invoice.status !== "issued" && invoice.status !== "sent") {
      throw appError(
        409,
        `Přechod ${invoice.status} → ${status} není povolen.`,
      );
    }

    const now = new Date();
    const set: Record<string, unknown> = { status, updatedAt: now };
    const reason =
      status === "paid"
        ? "manual_payment_confirmation"
        : "manual_delivery_confirmation";
    const paid =
      status === "paid" ? paidTransitionFields(invoice, input) : null;
    if (paid) {
      // Default to today and the full invoice total when not explicitly supplied.
      Object.assign(set, paid);
    }
    if (accountingDualWriteEnabled) {
      const context = requireNativeInvoiceAccountingContext(
        await loadNativeInvoiceAccountingContext(tx, id),
      );
      assertLifecycleMatchesInvoiceProjection(invoice.status, context);
      const adapter = createAccountingPersistenceDbAdapter(tx);
      if (status === "sent") {
        const evidence = buildInvoiceSentAccountingEvidence({
          version: context.version,
          actor,
          recordedAt: now,
          nextLifecycleSequence: context.lifecycleSequence + 1n,
          previousLifecycleEventSha256: context.lifecycleSha256,
        });
        await appendAccountingLifecycleEventInTransaction(
          adapter,
          evidence.event,
          context.version,
        );
      } else {
        if (!paid) throw new Error("Paid transition fields were not built.");
        if (
          context.paymentSequence !== null ||
          context.paymentSha256 !== null
        ) {
          throw appError(
            409,
            "Faktura už má platební účetní hlavu; další platba vyžaduje samostatný append-only přechod.",
          );
        }
        const evidence = buildInvoicePaymentAccountingEvidence({
          version: context.version,
          actor,
          recordedAt: now,
          occurredOn: paid.paidDate,
          amount: paid.paidAmount,
          currency: invoice.currency,
          source: "manual",
          bankSourceReference: null,
          nextPaymentSequence: 0n,
          previousPaymentEventSha256: null,
        });
        await appendAccountingPaymentEventInTransaction(
          adapter,
          evidence.event,
          context.version,
        );
      }
    }
    await tx.update(invoicesTable).set(set).where(eq(invoicesTable.id, id));
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "update",
      entityType: "invoices",
      entityId: id,
      summary: `Stav faktury ${invoice.invoiceNumber ?? `#${id}`} změněn ${invoice.status} → ${status} (${reason})`,
      method: "PATCH",
      path: `/billing/invoices/${id}/status`,
    });
  });
  return getInvoiceDetail(id);
}

// ---------------------------------------------------------------------------
// PDF fetch (for download / email)
// ---------------------------------------------------------------------------

export async function getInvoiceForPdf(id: number): Promise<Invoice | null> {
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  return invoice ?? null;
}

// ---------------------------------------------------------------------------
// Bank statement payment matching (Komerční banka GPC / CAMT.053)
//
// Matching is decoupled from the file format: the parser turns raw bytes into
// normalized credit transactions, and this layer pairs them with issued/sent
// invoices by variable symbol (+ amount, with a haléř tolerance). A future live
// bank-API feed can reuse confirmBankPayments() by producing the same shape.
// ---------------------------------------------------------------------------

/** CZK tolerance when comparing a payment to an invoice total (haléř rounding). */
const PAYMENT_AMOUNT_TOLERANCE = 0.5;

/** Strip leading zeros / whitespace so "0001234" and "1234" compare equal. */
function normVs(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}

export type BankMatchStatus =
  | "matched"
  | "amount_mismatch"
  | "ambiguous"
  | "already_paid"
  | "unmatched";

export interface BankMatchCandidate {
  invoiceId: number;
  invoiceNumber: string | null;
  customerName: string | null;
  totalWithVat: number;
  status: string;
  amountMatches: boolean;
}

export interface BankMatchTransaction {
  amount: number;
  currency: string;
  variableSymbol: string | null;
  constantSymbol: string | null;
  specificSymbol: string | null;
  counterparty: string | null;
  counterpartyAccount: string | null;
  message: string | null;
  date: string | null;
  matchStatus: BankMatchStatus;
  recommendedInvoiceId: number | null;
  candidates: BankMatchCandidate[];
}

export interface BankStatementPreview {
  format: StatementFormat;
  account: string | null;
  statementDate: string | null;
  creditCount: number;
  matchedCount: number;
  transactions: BankMatchTransaction[];
}

/**
 * Parse a bank statement and build a matching proposal. Read-only: it never
 * changes any invoice. Only incoming (credit) transactions are returned — those
 * are the ones that can settle a receivable.
 */
export async function previewBankStatementMatches(
  buf: Buffer,
): Promise<BankStatementPreview> {
  const parsed = parseBankStatement(buf);
  const credits = parsed.transactions.filter((t) => t.direction === "credit");

  const invoices = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerName: invoicesTable.customerName,
      totalWithVat: invoicesTable.totalWithVat,
      status: invoicesTable.status,
      variableSymbol: invoicesTable.variableSymbol,
    })
    .from(invoicesTable)
    .where(isNotNull(invoicesTable.variableSymbol));

  type Row = (typeof invoices)[number];
  const byVs = new Map<string, Row[]>();
  for (const inv of invoices) {
    const vs = normVs(inv.variableSymbol);
    if (!vs) continue;
    const arr = byVs.get(vs);
    if (arr) arr.push(inv);
    else byVs.set(vs, [inv]);
  }

  let matchedCount = 0;
  const transactions: BankMatchTransaction[] = credits.map((t) => {
    const vs = normVs(t.variableSymbol);
    const all = vs ? (byVs.get(vs) ?? []) : [];
    const payable = all.filter(
      (i) => i.status === "issued" || i.status === "sent",
    );
    const paid = all.filter((i) => i.status === "paid");

    const toCandidate = (i: Row): BankMatchCandidate => ({
      invoiceId: i.id,
      invoiceNumber: i.invoiceNumber,
      customerName: i.customerName,
      totalWithVat: num(i.totalWithVat),
      status: i.status,
      amountMatches:
        Math.abs(num(i.totalWithVat) - t.amount) <= PAYMENT_AMOUNT_TOLERANCE,
    });

    let matchStatus: BankMatchStatus;
    let recommendedInvoiceId: number | null = null;
    let candidates: BankMatchCandidate[] = [];

    if (!vs || all.length === 0) {
      matchStatus = "unmatched";
    } else if (payable.length === 0) {
      matchStatus = paid.length > 0 ? "already_paid" : "unmatched";
      candidates = paid.map(toCandidate);
    } else {
      candidates = payable.map(toCandidate);
      const amountHits = candidates.filter((c) => c.amountMatches);
      if (payable.length === 1) {
        recommendedInvoiceId = payable[0].id;
        matchStatus = amountHits.length === 1 ? "matched" : "amount_mismatch";
      } else if (amountHits.length === 1) {
        recommendedInvoiceId = amountHits[0].invoiceId;
        matchStatus = "matched";
      } else {
        matchStatus = "ambiguous";
      }
    }
    if (matchStatus === "matched") matchedCount += 1;

    return {
      amount: t.amount,
      currency: t.currency,
      variableSymbol: t.variableSymbol,
      constantSymbol: t.constantSymbol,
      specificSymbol: t.specificSymbol,
      counterparty: t.counterparty,
      counterpartyAccount: t.counterpartyAccount,
      message: t.message,
      date: t.date,
      matchStatus,
      recommendedInvoiceId,
      candidates,
    };
  });

  return {
    format: parsed.format,
    account: parsed.account,
    statementDate: parsed.statementDate,
    creditCount: credits.length,
    matchedCount,
    transactions,
  };
}

export interface BankPaymentConfirmInput {
  invoiceId: number;
  amount?: number | null;
  variableSymbol?: string | null;
  counterparty?: string | null;
  paymentDate?: string | null;
}

export interface BankPaymentConfirmResult {
  paidCount: number;
  skipped: { invoiceId: number; reason: string }[];
}

/**
 * Mark the confirmed invoices as paid. Each row is locked FOR UPDATE and only
 * issued/sent invoices transition (same rule as updateInvoiceStatus); anything
 * else is reported in `skipped` instead of failing the whole batch. Each paid
 * invoice gets its own audit entry recording the bank-statement origin.
 */
export async function confirmBankPayments(
  payments: BankPaymentConfirmInput[],
  actor: Actor,
): Promise<BankPaymentConfirmResult> {
  // Dedupe by invoiceId (a statement could list two credits to one invoice).
  const seen = new Set<number>();
  const unique = payments
    .filter((p) => {
      if (seen.has(p.invoiceId)) return false;
      seen.add(p.invoiceId);
      return true;
    })
    .sort((left, right) => left.invoiceId - right.invoiceId);

  const skipped: { invoiceId: number; reason: string }[] = [];
  let paidCount = 0;
  const accountingDualWriteEnabled = isAccountingBankPaymentDualWriteEnabled();

  await db.transaction(async (tx) => {
    for (const p of unique) {
      const [invoice] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, p.invoiceId))
        .for("update");
      if (!invoice) {
        skipped.push({ invoiceId: p.invoiceId, reason: "Faktura nenalezena." });
        continue;
      }
      if (invoice.status === "paid") {
        skipped.push({
          invoiceId: p.invoiceId,
          reason: "Faktura je již zaplacená.",
        });
        continue;
      }
      if (invoice.status !== "issued" && invoice.status !== "sent") {
        skipped.push({
          invoiceId: p.invoiceId,
          reason: `Stav „${invoice.status}" nelze označit jako zaplaceno.`,
        });
        continue;
      }

      // Reuse the same transition fields as updateInvoiceStatus so a
      // bank-confirmed payment records paidDate/paidAmount identically to a
      // manual status change. The bank transaction's actual amount/date win,
      // falling back to today / the invoice total.
      const paid = paidTransitionFields(invoice, {
        paidDate: p.paymentDate ?? null,
        paidAmount: p.amount ?? null,
      });
      const now = new Date();
      if (accountingDualWriteEnabled) {
        const context = await loadNativeInvoiceAccountingContext(
          tx,
          p.invoiceId,
        );
        if (!context) {
          skipped.push({
            invoiceId: p.invoiceId,
            reason:
              "Faktura nemá nativní účetní evidenci; vyžaduje řízený legacy backfill.",
          });
          continue;
        }
        assertLifecycleMatchesInvoiceProjection(invoice.status, context);
        if (
          context.paymentSequence !== null ||
          context.paymentSha256 !== null
        ) {
          throw appError(
            409,
            "Aktivní faktura už má platební účetní hlavu; další platba vyžaduje samostatný append-only přechod.",
          );
        }
        const evidence = buildInvoicePaymentAccountingEvidence({
          version: context.version,
          actor,
          recordedAt: now,
          occurredOn: paid.paidDate,
          amount: paid.paidAmount,
          currency: invoice.currency,
          source: "bank_import",
          bankSourceReference: {
            amount: paid.paidAmount,
            currency: invoice.currency,
            occurredOn: paid.paidDate,
            variableSymbol: p.variableSymbol?.trim() || null,
            counterparty: p.counterparty?.trim() || null,
          },
          nextPaymentSequence: 0n,
          previousPaymentEventSha256: null,
        });
        await appendAccountingPaymentEventInTransaction(
          createAccountingPersistenceDbAdapter(tx),
          evidence.event,
          context.version,
        );
      }
      await tx
        .update(invoicesTable)
        .set({ status: "paid", updatedAt: now, ...paid })
        .where(eq(invoicesTable.id, p.invoiceId));

      const parts: string[] = [];
      if (p.amount != null && Number.isFinite(p.amount)) {
        parts.push(`částka ${p.amount.toFixed(2)} Kč`);
      }
      if (p.variableSymbol) parts.push(`VS ${p.variableSymbol}`);
      if (p.counterparty) parts.push(p.counterparty);
      if (p.paymentDate) parts.push(p.paymentDate);
      const detail = parts.length ? ` (${parts.join(", ")})` : "";

      await tx.insert(auditLogTable).values({
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "update",
        entityType: "invoices",
        entityId: p.invoiceId,
        summary: `Faktura ${
          invoice.invoiceNumber ?? `#${p.invoiceId}`
        } označena jako zaplacená – párování z bankovního výpisu${detail}`,
        method: "POST",
        path: "/billing/bank-statements/confirm",
      });
      paidCount += 1;
    }
  });

  return { paidCount, skipped };
}
