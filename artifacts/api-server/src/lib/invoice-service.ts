import { and, desc, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import {
  db,
  billingSettingsTable,
  invoicesTable,
  invoiceLinesTable,
  invoiceSourceLinksTable,
  jobsTable,
  materialsTable,
  customersTable,
  auditLogTable,
  type BillingSettings,
  type Invoice,
  type InvoiceLine,
} from "@workspace/db";
import {
  computeLine,
  num,
  round2,
  sumTotals,
  type ComputedLine,
  type VatMode,
} from "./invoice-calc";
import { generateInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { ObjectStorageService } from "./objectStorage";

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
    numberPrefix: row.numberPrefix,
    numberFormat: row.numberFormat,
    numberYear: row.numberYear,
    numberNextSeq: row.numberNextSeq,
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
  numberPrefix?: string;
  numberFormat?: string;
  numberYear?: number | null;
  numberNextSeq?: number;
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
  assign("numberPrefix", "numberPrefix");
  assign("numberFormat", "numberFormat");
  if (input.numberNextSeq !== undefined && input.numberNextSeq < 1) {
    throw appError(400, "Další číslo v řadě musí být alespoň 1.");
  }
  assign("numberYear", "numberYear");
  assign("numberNextSeq", "numberNextSeq");
  const [row] = await db
    .update(billingSettingsTable)
    .set(set)
    .where(eq(billingSettingsTable.id, SETTINGS_ID))
    .returning();
  return row;
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

  return {
    unbilledDoneJobs: unbilled.length,
    draftInvoices: draftCount,
    issuedInvoices: issuedCount,
    totalToInvoiceWithoutVat: unbilledTotal,
    issuedThisMonthWithVat,
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
      .filter((m) => m.pricePerUnit != null)
      .map((m) => ({
        id: m.id,
        name: m.name,
        quantity: round2(num(m.quantity ?? 1)),
        unit: m.unit,
        pricePerUnit: round2(num(m.pricePerUnit)),
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

/** Build the proposed lines + per-job billed amounts from a set of done jobs. */
async function buildProposedLines(
  exec: DbOrTx,
  jobIds: number[],
  billFineJobIds: number[],
  customerId: number,
  invoiceVatMode: VatMode,
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
      jobLines.push({
        sourceType: "material",
        jobId,
        sourceId: m.id,
        description: m.name,
        quantity: round2(num(m.quantity ?? 1)),
        unit: m.unit ?? "ks",
        unitPriceWithoutVat: round2(num(m.pricePerUnit)),
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
}

export interface InvoiceCreateInput {
  customerId: number;
  jobIds?: number[];
  billFineJobIds?: number[];
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

  const id = await db.transaction(async (tx) => {
    const { lines: proposed, jobAmounts } = await buildProposedLines(
      tx,
      jobIds,
      billFineJobIds,
      input.customerId,
      vatModeDefault,
    );

    const manual: RawLine[] = (input.lines ?? []).map((l) => ({
      sourceType: l.sourceType ?? "manual",
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
      // Manual edit replaces ALL lines; source links are preserved (job billing
      // is decided at draft creation, not re-derived from manual line edits).
      await tx.delete(invoiceLinesTable).where(eq(invoiceLinesTable.invoiceId, id));
      const manual: RawLine[] = input.lines.map((l) => ({
        sourceType: l.sourceType ?? "manual",
        description: l.description,
        quantity: l.quantity ?? 1,
        unit: l.unit ?? null,
        unitPriceWithoutVat: l.unitPriceWithoutVat ?? 0,
        discountPercent: l.discountPercent ?? null,
        vatRate: l.vatRate ?? null,
        vatMode: l.vatMode ?? vatModeDefault,
      }));
      const computed = await persistLines(tx, id, manual, vatModeDefault);
      await writeTotals(tx, id, computed);
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
  await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
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

async function buildPdfData(
  invoice: Invoice,
  lines: InvoiceLine[],
  settings: BillingSettings,
): Promise<InvoicePdfData> {
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

export async function updateInvoiceStatus(id: number, status: "sent" | "paid") {
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
  await db
    .update(invoicesTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(invoicesTable.id, id));
  return getInvoiceDetail(id);
}

// ---------------------------------------------------------------------------
// PDF fetch (for download / email)
// ---------------------------------------------------------------------------

export async function getInvoiceForPdf(id: number): Promise<Invoice | null> {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return invoice ?? null;
}
