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
  warehouseItemsTable,
  invoicesTable,
  invoiceLinesTable,
  invoiceSourceLinksTable,
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
} from "@workspace/db";
import {
  computeLine,
  deriveSourceLinks,
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
  normalizeMaterialDisplayMode,
  presentInvoiceLines,
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
// Unbilled jobs (done, explicitly billable, not linked to a live invoice)
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
        ne(invoicesTable.status, "cancelled"),
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
// Unbilled activities (dlouhodobé akce: completed, not linked to a non-cancelled
// invoice). Mirrors the unbilled-jobs flow — billing provenance lives in
// invoice_source_links.activityId, so a completed action drops from the pool
// once it is linked to any non-cancelled invoice (draft included).
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
        ne(invoicesTable.status, "cancelled"),
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
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    customerId: row.customerId,
    customerName: row.customerName,
    customerIc: row.customerIc,
    customerDic: row.customerDic,
    customerAddress: row.customerAddress,
    customerEmail: row.customerEmail,
    issueDate: row.issueDate,
    taxableSupplyDate: row.taxableSupplyDate,
    dueDate: row.dueDate,
    currency: row.currency,
    paymentMethod: row.paymentMethod,
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

  return {
    ...serializeInvoice(invoice),
    lines: lines.map(serializeLine),
    presentationLines: presentInvoiceLines(
      lines,
      normalizeMaterialDisplayMode(invoice.materialDisplayMode),
    ).map(serializeLine),
    sourceJobIds: linkedJobIds,
    sourceActivityIds: linkedActivityIds,
    sourceJobs,
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

interface RawLine {
  sourceType: string;
  sourceId?: number | null;
  jobId?: number | null;
  activityId?: number | null;
  description: string;
  unit?: string | null;
  quantity?: number | null;
  unitPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  vatRate?: number | null;
  vatMode?: VatMode | null;
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

  // Reject jobs already linked to a non-cancelled invoice up front, so a draft
  // can never be built (and later issued) for a job another operator is already
  // billing. Mirrors the activity guard in buildProposedActivityLines.
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
        ne(invoicesTable.status, "cancelled"),
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

    if (isFixedPrice && includeJobPrice) {
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
      if (includeJobPrice && num(job.price) > 0) {
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
    if (transportCost > 0) {
      const km = num(job.transportKm);
      jobLines.push({
        sourceType: "transport",
        jobId,
        description: km > 0 ? `Doprava (${km} km)` : "Doprava",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: transportCost,
        vatMode: invoiceVatMode,
      });
    }
    if (num(job.parking) > 0) {
      jobLines.push({
        sourceType: "parking",
        jobId,
        description: "Parkovné",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: round2(num(job.parking)),
        vatMode: invoiceVatMode,
      });
    }
    // Fines are opt-in per job — only billed when explicitly selected.
    if (fineSet.has(jobId) && num(job.fines) > 0) {
      jobLines.push({
        sourceType: "fine",
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

  // Reject activities already linked to a non-cancelled invoice up front, so a
  // draft can never be built (and later issued) for an already-billed activity.
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
        ne(invoicesTable.status, "cancelled"),
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
): Promise<ComputedLine[]> {
  if (!rawLines.length) return [];
  const computed: ComputedLine[] = [];
  const values = rawLines.map((rl, idx) => {
    const c = computeLine(rl, invoiceVatMode);
    computed.push(c);
    return {
      invoiceId,
      sourceType: rl.sourceType,
      sourceId: rl.sourceId ?? null,
      jobId: rl.jobId ?? null,
      activityId: rl.activityId ?? null,
      description: rl.description,
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
  await exec.insert(invoiceLinesTable).values(values);
  return computed;
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
  customerId: number;
  jobIds?: number[];
  activityIds?: number[];
  labourBillingMode?: "automatic" | "job_price" | "recorded_time" | "none";
  workGrouping?: "summary" | "worker";
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
  durationSeconds: number;
  saleRate: number;
  amountWithoutVat: number;
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
    lines: [...groups.values()]
      .filter((group) => group.hours !== 0)
      .map((group) => ({
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
      sourceType: l.sourceType ?? "manual",
      sourceId: l.sourceId ?? null,
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

    const allLines = [
      ...proposed,
      ...proposedActivity,
      ...recordedWork.lines,
      ...manual,
    ];
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
        customerId: customer.id,
        customerName: customer.companyName,
        customerIc: customer.ic,
        customerDic: customer.dic,
        customerAddress: customer.address,
        customerEmail: customer.email,
        issueDate: input.issueDate ?? null,
        taxableSupplyDate: input.taxableSupplyDate ?? null,
        dueDate: input.dueDate ?? null,
        paymentMethod: input.paymentMethod ?? settings.defaultPaymentMethod,
        variableSymbol: input.variableSymbol ?? null,
        constantSymbol: INVOICE_CONSTANT_SYMBOL,
        specificSymbol: input.specificSymbol ?? null,
        vatModeDefault,
        materialDisplayMode: normalizeMaterialDisplayMode(
          input.materialDisplayMode,
        ),
        notes: input.notes ?? null,
        createdByUserId: actor.userId,
      })
      .returning();

    const computed = await persistLines(
      tx,
      invoice.id,
      allLines,
      vatModeDefault,
    );
    await writeTotals(tx, invoice.id, computed);

    // Reserve any re-billed cost-document lines so they aren't offered twice.
    await markLinesInvoiced(tx, invoice.id, billingDocLineIds(allLines));
    // Reserve billed job materials (provenance only — never touches stock).
    await markMaterialsInvoiced(tx, invoice.id, materialIds(allLines));

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

    if (recordedWork.reservations.length) {
      await tx.insert(workSessionBillingLinksTable).values(
        recordedWork.reservations.map((item) => ({
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
            recordedWork.reservations.map((item) => item.sessionId),
          ),
        );
    }

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
  vatModeDefault?: VatMode;
  materialDisplayMode?: MaterialDisplayMode;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  variableSymbol?: string | null;
  constantSymbol?: string | null;
  specificSymbol?: string | null;
  notes?: string | null;
  lines?: InvoiceLineInput[];
}

export async function updateDraft(id: number, input: InvoiceUpdateInput) {
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

    const set: Record<string, unknown> = {
      updatedAt: new Date(),
      vatModeDefault,
    };
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
    if (input.materialDisplayMode !== undefined) {
      set.materialDisplayMode = normalizeMaterialDisplayMode(
        input.materialDisplayMode,
      );
    }
    await tx.update(invoicesTable).set(set).where(eq(invoicesTable.id, id));

    if (input.lines !== undefined) {
      const activeWorkLinks = await tx
        .select({ id: workSessionBillingLinksTable.id })
        .from(workSessionBillingLinksTable)
        .where(
          and(
            eq(workSessionBillingLinksTable.invoiceId, id),
            inArray(workSessionBillingLinksTable.status, [
              "reserved",
              "billed",
            ]),
          ),
        );
      if (activeWorkLinks.length) {
        const currentWorkLines = await tx
          .select()
          .from(invoiceLinesTable)
          .where(
            and(
              eq(invoiceLinesTable.invoiceId, id),
              eq(invoiceLinesTable.sourceType, "work_session"),
            ),
          );
        const signature = (line: {
          description: string;
          quantity?: unknown;
          unitPriceWithoutVat?: unknown;
          jobId?: number | null;
          activityId?: number | null;
        }) =>
          JSON.stringify([
            line.description,
            round2(num(line.quantity)),
            round2(num(line.unitPriceWithoutVat)),
            line.jobId ?? null,
            line.activityId ?? null,
          ]);
        const before = currentWorkLines.map(signature).sort();
        const after = input.lines
          .filter((line) => line.sourceType === "work_session")
          .map(signature)
          .sort();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw appError(
            409,
            "Položky skutečně odpracovaného času jsou svázané s konkrétními session a nelze je ručně měnit nebo odstranit.",
          );
        }
      }
      // Manual edit replaces ALL lines. Lines keep their `jobId` so job billing
      // tracks the lines that actually remain: removing every line of a job drops
      // its source link, returning the job to the unbilled pool (instead of being
      // silently marked "vyfakturováno" with nothing on the invoice for it).
      await tx
        .delete(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, id));
      // Release previously-reserved cost-document lines + job materials; re-reserve
      // below from the new line set, so removing a line frees it for re-billing.
      await releaseInvoicedLines(tx, id);
      await releaseInvoicedMaterials(tx, id);
      const lines: RawLine[] = input.lines.map((l) => ({
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
      const computed = await persistLines(tx, id, lines, vatModeDefault);
      await writeTotals(tx, id, computed);

      // Recompute source links from the surviving lines' job/activity ids so
      // billing provenance stays in sync with the edited line set.
      await tx
        .delete(invoiceSourceLinksTable)
        .where(eq(invoiceSourceLinksTable.invoiceId, id));
      const sourceLinks = deriveSourceLinks(lines, computed);
      if (sourceLinks.length) {
        await tx.insert(invoiceSourceLinksTable).values(
          sourceLinks.map((l) => ({
            invoiceId: id,
            jobId: l.jobId,
            activityId: l.activityId,
            amountWithoutVat: String(l.amountWithoutVat),
          })),
        );
      }
      await markLinesInvoiced(tx, id, billingDocLineIds(lines));
      await markMaterialsInvoiced(tx, id, materialIds(lines));
      const [quoteLink] = await tx
        .select({ jobGroupId: quoteInvoiceLinksTable.jobGroupId })
        .from(quoteInvoiceLinksTable)
        .where(
          and(
            eq(quoteInvoiceLinksTable.invoiceId, id),
            inArray(quoteInvoiceLinksTable.status, ["reserved", "billed"]),
          ),
        )
        .limit(1);
      if (quoteLink?.jobGroupId != null) {
        await ensureQuoteGroupSourceLinks(tx, id, quoteLink.jobGroupId);
      }
    } else {
      // VAT mode may have changed — recompute existing lines under the new mode.
      await recalcWithin(tx, id, vatModeDefault);
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
    await releaseWorkSessionBilling(tx, id, null, "draft_deleted");
    await releaseQuoteInvoiceBilling(tx, id, actor.userId, "draft_deleted");
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
  const iban = resolveIban(settings.iban, settings.bankAccount);
  if (!iban) return null;
  const amount = num(invoice.totalWithVat);
  if (!(amount > 0)) return null;

  const payload = buildSpayd({
    iban,
    bic: settings.bic,
    amount,
    currency: invoice.currency || "CZK",
    variableSymbol: invoice.variableSymbol,
    message: invoice.invoiceNumber ? `Faktura ${invoice.invoiceNumber}` : null,
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
    normalizeMaterialDisplayMode(invoice.materialDisplayMode),
  );
  return {
    invoiceNumber: invoice.invoiceNumber ?? "—",
    status: invoice.status,
    customerName: invoice.customerName,
    customerIc: invoice.customerIc,
    customerDic: invoice.customerDic,
    customerAddress: invoice.customerAddress,
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
      bankAccount: settings.bankAccount,
      iban: settings.iban,
      bic: settings.bic,
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
      throw appError(409, "Vystavit lze pouze koncept faktury.");
    }

    // Recompute every line + the invoice totals from the current line inputs
    // inside this same transaction, so the issued (immutable) document and its
    // PDF can never capture stale or tampered totals.
    await recalcWithin(tx, id, invoice.vatModeDefault as VatMode);

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
    if (quoteBilling?.jobGroupId != null) {
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
    if (jobIds.length) {
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
    if (activityIds.length) {
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
            ne(invoicesTable.status, "cancelled"),
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
    const seq = settings.numberYear === year ? settings.numberNextSeq : 1;
    const invoiceNumber = buildInvoiceNumber(
      settings.numberPrefix,
      settings.numberFormat,
      year,
      seq,
    );
    await tx
      .update(billingSettingsTable)
      .set({ numberYear: year, numberNextSeq: seq + 1, updatedAt: new Date() })
      .where(eq(billingSettingsTable.id, SETTINGS_ID));

    // Re-snapshot customer identity (legal immutability) if still linked.
    let snapshot: Partial<Invoice> = {};
    if (invoice.customerId != null) {
      const [customer] = await tx
        .select()
        .from(customersTable)
        .where(eq(customersTable.id, invoice.customerId));
      if (customer) {
        snapshot = {
          customerName: customer.companyName,
          customerIc: customer.ic,
          customerDic: customer.dic,
          customerAddress: customer.address,
          customerEmail: customer.email,
        };
      }
    }

    const issueDate = invoice.issueDate ?? todayIso();
    const taxableSupplyDate = invoice.taxableSupplyDate ?? issueDate;
    const dueDate =
      invoice.dueDate ?? addDaysIso(issueDate, settings.defaultDueDays);
    const variableSymbol = invoiceVariableSymbol(invoiceNumber);

    const [updated] = await tx
      .update(invoicesTable)
      .set({
        ...snapshot,
        status: "issued",
        invoiceNumber,
        issueDate,
        taxableSupplyDate,
        dueDate,
        variableSymbol,
        constantSymbol: INVOICE_CONSTANT_SYMBOL,
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

    // Flip billed jobs → "vyfakturováno".
    if (jobIds.length) {
      await tx
        .update(jobsTable)
        .set({ status: "vyfakturovano" })
        .where(inArray(jobsTable.id, jobIds));
    }
    // Mark billed activities (cosmetic flag; the source link is the source of
    // truth for unbilled selection — see getBilledActivityIds).
    if (activityIds.length) {
      await tx
        .update(activitiesTable)
        .set({ billingStatus: "billed", updatedAt: new Date() })
        .where(inArray(activitiesTable.id, activityIds));
    }

    if (workLinks.length) {
      await tx
        .update(workSessionBillingLinksTable)
        .set({ status: "billed", billedAt: new Date() })
        .where(
          and(
            eq(workSessionBillingLinksTable.invoiceId, id),
            eq(workSessionBillingLinksTable.status, "reserved"),
          ),
        );
      await tx
        .update(workSessionsTable)
        .set({ billingStatus: "billed", updatedAt: new Date() })
        .where(
          inArray(
            workSessionsTable.id,
            workLinks.map((link) => link.sessionId),
          ),
        );
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

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "issue",
      entityType: "invoices",
      entityId: id,
      summary: `Faktura ${invoiceNumber} vystavena${
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

    // Storno frees any re-billed cost-document lines + job materials for re-billing.
    await releaseInvoicedLines(tx, id);
    await releaseInvoicedMaterials(tx, id);
    await releaseWorkSessionBilling(tx, id, actor.userId, "invoice_cancelled");
    await releaseQuoteInvoiceBilling(tx, id, actor.userId, "invoice_cancelled");

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

    if (returnJobsToDone && jobIds.length) {
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
    if (activityIds.length) {
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
      summary: `Faktura ${invoice.invoiceNumber ?? `#${id}`} stornována${
        returnJobsToDone && jobIds.length
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
