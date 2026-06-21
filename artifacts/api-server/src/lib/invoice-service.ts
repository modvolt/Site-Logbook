import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
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
  customersTable,
  auditLogTable,
  type BillingSettings,
  type MaterialMarkupRule,
  type Invoice,
  type InvoiceLine,
} from "@workspace/db";
import {
  computeLine,
  deriveJobSourceLinks,
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
import { resolveIban, buildSpayd, generatePaymentQrDataUrl } from "./invoice-qr";
import { ObjectStorageService } from "./objectStorage";
import { parseBankStatement, type StatementFormat } from "./bank-statement-parser";
import {
  markLinesInvoiced,
  releaseInvoicedLines,
  markMaterialsInvoiced,
  releaseInvoicedMaterials,
} from "./cost-document-service";

const objectStorage = new ObjectStorageService();

const SETTINGS_ID = 1;

export type AppError = Error & { statusCode: number };
function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

export interface Actor {
  userId: number;
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
export function daysOverdue(dueDateIso: string, todayIsoStr = todayIso()): number {
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
    numberPrefix: row.numberPrefix,
    numberFormat: row.numberFormat,
    numberYear: row.numberYear,
    numberNextSeq: row.numberNextSeq,
    reminderEnabled: row.reminderEnabled,
    reminderDays: row.reminderDays,
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
  numberPrefix?: string;
  numberFormat?: string;
  numberYear?: number | null;
  numberNextSeq?: number;
  reminderEnabled?: boolean;
  reminderDays?: string;
}

export async function updateBillingSettings(
  input: BillingSettingsInput,
): Promise<BillingSettings> {
  await ensureBillingSettings();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const assign = <K extends keyof BillingSettingsInput>(key: K, col: string) => {
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
    if (!Number.isFinite(input.materialMarkupPercent) || input.materialMarkupPercent < 0) {
      throw appError(400, "Přirážka na materiál nesmí být záporná.");
    }
    set.materialMarkupPercent = String(round2(input.materialMarkupPercent));
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
      .where(sql`lower(${materialMarkupRulesTable.category}) = lower(${category})`)
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
// Unbilled jobs (status "done", not linked to a non-cancelled invoice)
// ---------------------------------------------------------------------------

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

interface UnbilledJobRow {
  job: typeof jobsTable.$inferSelect;
  customer: typeof customersTable.$inferSelect | null;
}

async function getUnbilledDoneJobs(customerId?: number): Promise<UnbilledJobRow[]> {
  const billedIds = await getBilledJobIds();
  const conditions = [eq(jobsTable.status, "done")];
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

function jobOrientationalTotal(job: typeof jobsTable.$inferSelect): number {
  return round2(num(job.price) + num(job.transportCost) + num(job.parking));
}

export async function getBillingSummary() {
  const unbilled = await getUnbilledDoneJobs();
  const unbilledTotal = round2(
    unbilled.reduce((acc, r) => acc + jobOrientationalTotal(r.job), 0),
  );

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
      (acc, i) => acc + (i.paidAmount != null ? num(i.paidAmount) : num(i.totalWithVat)),
      0,
    ),
  );

  return {
    unbilledDoneJobs: unbilled.length,
    draftInvoices: draftCount,
    issuedInvoices: issuedCount,
    totalToInvoiceWithoutVat: unbilledTotal,
    issuedThisMonthWithVat,
    paidThisMonthCount: paidThisMonthInvoices.length,
    paidThisMonthWithVat,
    unpaidCount: unpaidInvoices.length,
    unpaidTotalWithVat,
    overdueCount: overdueInvoices.length,
    overdueTotalWithVat,
  };
}

export async function listUnbilledCustomers() {
  const rows = await getUnbilledDoneJobs();
  const byCustomer = new Map<
    number,
    {
      customerId: number;
      companyName: string;
      jobCount: number;
      totalPrice: number;
      totalTransportCost: number;
      totalParking: number;
      totalFines: number;
      orientationalTotal: number;
    }
  >();
  for (const { job, customer } of rows) {
    if (job.customerId == null || !customer) continue;
    const entry =
      byCustomer.get(job.customerId) ??
      {
        customerId: job.customerId,
        companyName: customer.companyName,
        jobCount: 0,
        totalPrice: 0,
        totalTransportCost: 0,
        totalParking: 0,
        totalFines: 0,
        orientationalTotal: 0,
      };
    entry.jobCount += 1;
    entry.totalPrice += num(job.price);
    entry.totalTransportCost += num(job.transportCost);
    entry.totalParking += num(job.parking);
    entry.totalFines += num(job.fines);
    entry.orientationalTotal += jobOrientationalTotal(job);
    byCustomer.set(job.customerId, entry);
  }
  return Array.from(byCustomer.values())
    .map((e) => ({
      customerId: e.customerId,
      companyName: e.companyName,
      jobCount: e.jobCount,
      totalPrice: round2(e.totalPrice),
      totalTransportCost: round2(e.totalTransportCost),
      totalParking: round2(e.totalParking),
      totalFines: round2(e.totalFines),
      orientationalTotal: round2(e.orientationalTotal),
    }))
    .sort((a, b) => b.orientationalTotal - a.orientationalTotal);
}

export async function getUnbilledCustomerDetail(customerId: number) {
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) throw appError(404, "Zákazník nenalezen.");

  const rows = await getUnbilledDoneJobs(customerId);
  const jobIds = rows.map((r) => r.job.id);
  const materials = jobIds.length
    ? await db.select().from(materialsTable).where(inArray(materialsTable.jobId, jobIds))
    : [];
  const materialsByJob = new Map<number, typeof materialsTable.$inferSelect[]>();
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
  const categoryMarkupByName = await getCategoryMarkupByName(billableMaterialNames);

  const jobs = rows.map(({ job }) => ({
    id: job.id,
    title: job.title,
    date: job.date,
    type: job.type,
    status: job.status,
    price: round2(num(job.price)),
    transportKm: round2(num(job.transportKm)),
    transportCost: round2(num(job.transportCost)),
    parking: round2(num(job.parking)),
    fines: round2(num(job.fines)),
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

  return {
    customerId: customer.id,
    companyName: customer.companyName,
    ic: customer.ic,
    dic: customer.dic,
    address: customer.address,
    email: customer.email,
    jobs,
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
    discountPercent: row.discountPercent == null ? null : num(row.discountPercent),
    vatRate: row.vatRate == null ? null : num(row.vatRate),
    vatMode: row.vatMode,
    totalWithoutVat: num(row.totalWithoutVat),
    totalVat: num(row.totalVat),
    totalWithVat: num(row.totalWithVat),
    sortOrder: row.sortOrder,
  };
}

export async function getInvoiceDetail(id: number) {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) return null;
  const lines = await db
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, id))
    .orderBy(invoiceLinesTable.sortOrder, invoiceLinesTable.id);
  const links = await db
    .select({ jobId: invoiceSourceLinksTable.jobId })
    .from(invoiceSourceLinksTable)
    .where(eq(invoiceSourceLinksTable.invoiceId, id));
  return {
    ...serializeInvoice(invoice),
    lines: lines.map(serializeLine),
    sourceJobIds: links.map((l) => l.jobId).filter((x): x is number => x != null),
  };
}

export async function listInvoices(filter: { status?: string; customerId?: number }) {
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
  return rows.map(serializeInvoice);
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
    .where(inArray(jobsTable.id, jobIds));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const materials = await exec
    .select()
    .from(materialsTable)
    .where(inArray(materialsTable.jobId, jobIds));
  const materialsByJob = new Map<number, typeof materialsTable.$inferSelect[]>();
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

    const jobLines: RawLine[] = [];
    if (num(job.price) > 0) {
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
    if (num(job.transportCost) > 0) {
      const km = num(job.transportKm);
      jobLines.push({
        sourceType: "transport",
        jobId,
        description: km > 0 ? `Doprava (${km} km)` : "Doprava",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: round2(num(job.transportCost)),
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
        unitPriceWithoutVat: applyMaterialMarkup(num(m.pricePerUnit), effectiveMarkup),
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
      discountPercent: c.discountPercent == null ? null : String(c.discountPercent),
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
    .filter((l) => l.sourceType === "billing_document_line" && l.sourceId != null)
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
  billFineJobIds?: number[];
  materialMarkupPercent?: number;
  /** Per-material markup overrides keyed by material id (highest priority). */
  materialMarkupOverrides?: Array<{ materialId: number; markupPercent: number }>;
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

export async function createDraft(input: InvoiceCreateInput, actor: Actor) {
  const settings = await ensureBillingSettings();
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, input.customerId));
  if (!customer) throw appError(400, "Zákazník nenalezen.");

  const vatModeDefault: VatMode =
    input.vatModeDefault ?? (settings.vatModeDefault as VatMode);
  const jobIds = input.jobIds ?? [];
  const billFineJobIds = input.billFineJobIds ?? [];
  // Material markup: explicit per-invoice value wins, otherwise the saved
  // default from billing settings. Negative/invalid values fall back to 0.
  const materialMarkupPercent = resolveMaterialMarkup(
    input.materialMarkupPercent,
    settings.materialMarkupPercent,
  );
  // Per-line overrides keyed by material id (last write wins on duplicates).
  const lineMarkupOverrides = new Map<number, number>();
  for (const o of input.materialMarkupOverrides ?? []) {
    if (
      Number.isInteger(o.materialId) &&
      Number.isFinite(o.markupPercent) &&
      o.markupPercent >= 0
    ) {
      lineMarkupOverrides.set(o.materialId, round2(o.markupPercent));
    }
  }

  const id = await db.transaction(async (tx) => {
    const categoryMarkupForName = await buildCategoryMarkupResolver(tx);
    const { lines: proposed, jobAmounts } = await buildProposedLines(
      tx,
      jobIds,
      billFineJobIds,
      input.customerId,
      vatModeDefault,
      materialMarkupPercent,
      { lineMarkupOverrides, categoryMarkupForName },
    );

    const manual: RawLine[] = (input.lines ?? []).map((l) => ({
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

    const allLines = [...proposed, ...manual];

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
        constantSymbol: input.constantSymbol ?? null,
        specificSymbol: input.specificSymbol ?? null,
        vatModeDefault,
        notes: input.notes ?? null,
        createdByUserId: actor.userId,
      })
      .returning();

    const computed = await persistLines(tx, invoice.id, allLines, vatModeDefault);
    await writeTotals(tx, invoice.id, computed);

    // Reserve any re-billed cost-document lines so they aren't offered twice.
    await markLinesInvoiced(tx, invoice.id, billingDocLineIds(allLines));
    // Reserve billed job materials (provenance only — never touches stock).
    await markMaterialsInvoiced(tx, invoice.id, materialIds(allLines));

    // Source links — one per job, with the billed amount (without VAT).
    if (jobAmounts.size) {
      await tx.insert(invoiceSourceLinksTable).values(
        Array.from(jobAmounts.entries()).map(([jobId, amount]) => ({
          invoiceId: invoice.id,
          jobId,
          amountWithoutVat: String(amount),
        })),
      );
    }

    return invoice.id;
  });

  return getInvoiceDetail(id);
}

export interface InvoiceUpdateInput {
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

    const set: Record<string, unknown> = { updatedAt: new Date(), vatModeDefault };
    if (input.issueDate !== undefined) set.issueDate = input.issueDate;
    if (input.taxableSupplyDate !== undefined) set.taxableSupplyDate = input.taxableSupplyDate;
    if (input.dueDate !== undefined) set.dueDate = input.dueDate;
    if (input.paymentMethod !== undefined) set.paymentMethod = input.paymentMethod;
    if (input.variableSymbol !== undefined) set.variableSymbol = input.variableSymbol;
    if (input.constantSymbol !== undefined) set.constantSymbol = input.constantSymbol;
    if (input.specificSymbol !== undefined) set.specificSymbol = input.specificSymbol;
    if (input.notes !== undefined) set.notes = input.notes;
    await tx.update(invoicesTable).set(set).where(eq(invoicesTable.id, id));

    if (input.lines !== undefined) {
      // Manual edit replaces ALL lines. Lines keep their `jobId` so job billing
      // tracks the lines that actually remain: removing every line of a job drops
      // its source link, returning the job to the unbilled pool (instead of being
      // silently marked "vyfakturováno" with nothing on the invoice for it).
      await tx.delete(invoiceLinesTable).where(eq(invoiceLinesTable.invoiceId, id));
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

      // Recompute source links from the surviving lines' jobIds so that billing
      // provenance stays in sync with the edited line set.
      await tx
        .delete(invoiceSourceLinksTable)
        .where(eq(invoiceSourceLinksTable.invoiceId, id));
      const sourceLinks = deriveJobSourceLinks(lines, computed);
      if (sourceLinks.length) {
        await tx.insert(invoiceSourceLinksTable).values(
          sourceLinks.map((l) => ({
            invoiceId: id,
            jobId: l.jobId,
            amountWithoutVat: String(l.amountWithoutVat),
          })),
        );
      }
      await markLinesInvoiced(tx, id, billingDocLineIds(lines));
      await markMaterialsInvoiced(tx, id, materialIds(lines));
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
        discountPercent: line.discountPercent == null ? null : num(line.discountPercent),
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
        discountPercent: c.discountPercent == null ? null : String(c.discountPercent),
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
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) throw appError(404, "Faktura nenalezena.");
  if (invoice.status !== "draft") {
    throw appError(409, "Přepočítat lze pouze koncept faktury.");
  }
  await recalcWithin(db, id, invoice.vatModeDefault as VatMode);
  return getInvoiceDetail(id);
}

export async function deleteDraft(id: number) {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) throw appError(404, "Faktura nenalezena.");
  if (invoice.status !== "draft") {
    throw appError(409, "Smazat lze pouze koncept faktury.");
  }
  await db.transaction(async (tx) => {
    // Free any reserved cost-document lines + job materials before removal.
    await releaseInvoicedLines(tx, id);
    await releaseInvoicedMaterials(tx, id);
    await tx.delete(invoicesTable).where(eq(invoicesTable.id, id));
  });
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
  if (invoice.paymentMethod === "cash" || invoice.paymentMethod === "card") return null;
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
    lines: lines.map((l) => ({
      description: l.description,
      unit: l.unit,
      quantity: num(l.quantity),
      unitPriceWithoutVat: num(l.unitPriceWithoutVat),
      discountPercent: l.discountPercent == null ? null : num(l.discountPercent),
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

    // Verify every linked job is still "done" (could have been reopened / billed
    // by a competing draft since this draft was built).
    const links = await tx
      .select({ jobId: invoiceSourceLinksTable.jobId })
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.invoiceId, id));
    const jobIds = links.map((l) => l.jobId).filter((x): x is number => x != null);
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
    const dueDate = invoice.dueDate ?? addDaysIso(issueDate, settings.defaultDueDays);
    const variableSymbol = invoice.variableSymbol ?? invoiceNumber.replace(/\D/g, "");

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

    // Generate + store the PDF. If the upload throws, the whole transaction
    // rolls back (number increment included) — no half-issued invoice, no gap.
    const pdfData = await buildPdfData(updated, lines, settings);
    const pdfBuffer = generateInvoicePdf(pdfData);
    const objectPath = `/objects/invoices/${invoiceNumber}.pdf`;
    await objectStorage.putPrivateObject(objectPath, pdfBuffer, "application/pdf");
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

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "issue",
      entityType: "invoices",
      entityId: id,
      summary: `Faktura ${invoiceNumber} vystavena${
        jobIds.length ? ` (zakázky: ${jobIds.join(", ")})` : ""
      }`,
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

export async function cancelInvoice(
  id: number,
  returnJobsToDone: boolean,
  actor: Actor,
) {
  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
      .for("update");
    if (!invoice) throw appError(404, "Faktura nenalezena.");
    if (invoice.status === "cancelled") {
      throw appError(409, "Faktura je již stornována.");
    }

    await tx
      .update(invoicesTable)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(invoicesTable.id, id));

    // Storno frees any re-billed cost-document lines + job materials for re-billing.
    await releaseInvoicedLines(tx, id);
    await releaseInvoicedMaterials(tx, id);

    const links = await tx
      .select({ jobId: invoiceSourceLinksTable.jobId })
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.invoiceId, id));
    const jobIds = links.map((l) => l.jobId).filter((x): x is number => x != null);

    if (returnJobsToDone && jobIds.length) {
      // Only revert jobs we actually flipped (still "vyfakturováno").
      await tx
        .update(jobsTable)
        .set({ status: "done" })
        .where(
          and(inArray(jobsTable.id, jobIds), eq(jobsTable.status, "vyfakturovano")),
        );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "cancel",
      entityType: "invoices",
      entityId: id,
      summary: `Faktura ${invoice.invoiceNumber ?? `#${id}`} stornována${
        returnJobsToDone && jobIds.length ? ` (zakázky vráceny: ${jobIds.join(", ")})` : ""
      }`,
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
  return {
    paidDate: input.paidDate ?? invoice.paidDate ?? todayIso(),
    paidAmount: String(round2(amount)),
  };
}

export async function updateInvoiceStatus(id: number, input: InvoiceStatusInput) {
  const { status } = input;
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!invoice) throw appError(404, "Faktura nenalezena.");
  if (invoice.status === "draft" || invoice.status === "cancelled") {
    throw appError(409, "Stav koncept/storno nelze takto měnit.");
  }
  const allowed: Record<string, string[]> = {
    sent: ["issued", "sent", "paid"],
    paid: ["issued", "sent", "paid"],
  };
  if (!allowed[status].includes(invoice.status)) {
    throw appError(409, `Přechod ${invoice.status} → ${status} není povolen.`);
  }
  const set: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === "paid") {
    // Default to today and the full invoice total when not explicitly supplied.
    Object.assign(set, paidTransitionFields(invoice, input));
  } else {
    // Reverting a paid invoice back to "sent" clears the recorded payment.
    set.paidDate = null;
    set.paidAmount = null;
  }
  await db.update(invoicesTable).set(set).where(eq(invoicesTable.id, id));
  return getInvoiceDetail(id);
}

// ---------------------------------------------------------------------------
// PDF fetch (for download / email)
// ---------------------------------------------------------------------------

export async function getInvoiceForPdf(id: number): Promise<Invoice | null> {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
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
  const unique = payments.filter((p) => {
    if (seen.has(p.invoiceId)) return false;
    seen.add(p.invoiceId);
    return true;
  });

  const skipped: { invoiceId: number; reason: string }[] = [];
  let paidCount = 0;

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
        skipped.push({ invoiceId: p.invoiceId, reason: "Faktura je již zaplacená." });
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
      await tx
        .update(invoicesTable)
        .set({ status: "paid", updatedAt: new Date(), ...paid })
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
