import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  billingSettingsTable,
  quotesTable,
  quoteItemsTable,
  customersTable,
  jobsTable,
  type Quote,
  type QuoteItem,
} from "@workspace/db";
import { generateQuotePdf, type QuotePdfData } from "./quote-pdf";
import { sendEmailWithPdf } from "./email";
import { ObjectStorageService } from "./objectStorage";
import { randomUUID } from "node:crypto";

const objectStorage = new ObjectStorageService();
const SETTINGS_ID = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppError = Error & { statusCode: number };
export function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

export interface Actor {
  userId: number;
  name: string;
}

export interface QuoteItemInput {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  vatRate?: number | null;
  position?: number | null;
}

export interface QuoteCreateInput {
  customerId?: number | null;
  title: string;
  validUntil?: string | null;
  notes?: string | null;
  items?: QuoteItemInput[];
}

export interface QuoteUpdateInput {
  customerId?: number | null;
  title?: string | null;
  validUntil?: string | null;
  notes?: string | null;
  items?: QuoteItemInput[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseNum(v: string | number | null | undefined, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeItemTotals(
  unitPrice: number,
  quantity: number,
  vatRate: number | null,
  vatPayer: boolean,
): { totalWithoutVat: number; totalVat: number; totalWithVat: number } {
  const base = round2(unitPrice * quantity);
  if (!vatPayer || vatRate == null) {
    return { totalWithoutVat: base, totalVat: 0, totalWithVat: base };
  }
  const vat = round2(base * (vatRate / 100));
  return { totalWithoutVat: base, totalVat: vat, totalWithVat: round2(base + vat) };
}

// ---------------------------------------------------------------------------
// Settings (quote number series)
// ---------------------------------------------------------------------------

async function ensureSettings() {
  const existing = await db
    .select()
    .from(billingSettingsTable)
    .where(eq(billingSettingsTable.id, SETTINGS_ID))
    .limit(1);
  if (existing.length > 0) return existing[0];
  const [row] = await db.insert(billingSettingsTable).values({ id: SETTINGS_ID }).returning();
  return row;
}

async function assignQuoteNumber(): Promise<string> {
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({
        prefix: billingSettingsTable.quoteNumberPrefix,
        nextSeq: billingSettingsTable.quoteNumberNextSeq,
      })
      .from(billingSettingsTable)
      .where(eq(billingSettingsTable.id, SETTINGS_ID))
      .for("update");
    if (!settings) throw appError(500, "Nastavení fakturace nenalezeno.");
    const seq = settings.nextSeq ?? 1;
    const number = `${settings.prefix ?? "NAB"}${String(seq).padStart(4, "0")}`;
    await tx
      .update(billingSettingsTable)
      .set({ quoteNumberNextSeq: seq + 1 })
      .where(eq(billingSettingsTable.id, SETTINGS_ID));
    return number;
  });
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeItem(item: QuoteItem) {
  return {
    ...item,
    quantity: parseNum(item.quantity, 1),
    unitPrice: parseNum(item.unitPrice, 0),
    vatRate: item.vatRate != null ? parseNum(item.vatRate) : null,
  };
}

export function serializeQuote(quote: Quote) {
  return {
    ...quote,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listQuotes(opts?: {
  customerId?: number;
  status?: string;
}) {
  const conditions = [];
  if (opts?.customerId != null) conditions.push(eq(quotesTable.customerId, opts.customerId));
  if (opts?.status != null && opts.status !== "all")
    conditions.push(eq(quotesTable.status, opts.status));

  const quotes = await db
    .select()
    .from(quotesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(quotesTable.createdAt));

  const customerIds = [...new Set(quotes.map((q) => q.customerId).filter((id): id is number => id != null))];
  const customersMap = new Map<number, { companyName: string | null; email: string | null }>();
  if (customerIds.length > 0) {
    const customers = await db
      .select({ id: customersTable.id, companyName: customersTable.companyName, email: customersTable.email })
      .from(customersTable)
      .where(inArray(customersTable.id, customerIds));
    for (const c of customers) customersMap.set(c.id, { companyName: c.companyName, email: c.email });
  }

  return Promise.all(
    quotes.map(async (q) => {
      const items = await db
        .select()
        .from(quoteItemsTable)
        .where(eq(quoteItemsTable.quoteId, q.id))
        .orderBy(asc(quoteItemsTable.position));
      const itemData = items.map(serializeItem);
      const totalWithVat = round2(itemData.reduce((s, i) => {
        const tot = computeItemTotals(i.unitPrice, i.quantity, i.vatRate, true);
        return s + tot.totalWithVat;
      }, 0));
      const customerInfo = q.customerId != null ? (customersMap.get(q.customerId) ?? null) : null;
      return {
        ...serializeQuote(q),
        customerCompanyName: customerInfo?.companyName ?? null,
        customerEmail: customerInfo?.email ?? null,
        itemCount: items.length,
        totalWithVat,
      };
    }),
  );
}

export async function getQuoteDetail(id: number) {
  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!quote) return null;

  const items = await db
    .select()
    .from(quoteItemsTable)
    .where(eq(quoteItemsTable.quoteId, id))
    .orderBy(asc(quoteItemsTable.position));

  let customerCompanyName: string | null = null;
  let customerEmail: string | null = null;
  let customerIc: string | null = null;
  let customerDic: string | null = null;
  let customerAddress: string | null = null;
  if (quote.customerId != null) {
    const [c] = await db
      .select({
        companyName: customersTable.companyName,
        email: customersTable.email,
        ic: customersTable.ic,
        dic: customersTable.dic,
        address: customersTable.address,
      })
      .from(customersTable)
      .where(eq(customersTable.id, quote.customerId))
      .limit(1);
    customerCompanyName = c?.companyName ?? null;
    customerEmail = c?.email ?? null;
    customerIc = c?.ic ?? null;
    customerDic = c?.dic ?? null;
    customerAddress = c?.address ?? null;
  }

  return {
    ...serializeQuote(quote),
    customerCompanyName,
    customerEmail,
    customerIc,
    customerDic,
    customerAddress,
    items: items.map(serializeItem),
  };
}

// ---------------------------------------------------------------------------
// Public share-token lookup (no auth — gated by token)
// ---------------------------------------------------------------------------

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function getQuoteByShareToken(token: string) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, token))
    .limit(1);
  if (!quote) return null;

  const settings = await ensureSettings();
  const vatPayer = settings.vatPayer;

  const items = await db
    .select()
    .from(quoteItemsTable)
    .where(eq(quoteItemsTable.quoteId, quote.id))
    .orderBy(asc(quoteItemsTable.position));

  const itemData = items.map((item) => {
    const qty = parseNum(item.quantity, 1);
    const unitPrice = parseNum(item.unitPrice, 0);
    const vatRate = item.vatRate != null ? parseNum(item.vatRate) : null;
    const totals = computeItemTotals(unitPrice, qty, vatRate, vatPayer);
    return {
      id: item.id,
      position: item.position,
      description: item.description,
      quantity: qty,
      unit: item.unit ?? null,
      unitPrice,
      vatRate,
      ...totals,
    };
  });

  const subtotalWithoutVat = round2(itemData.reduce((s, i) => s + i.totalWithoutVat, 0));
  const totalVat = round2(itemData.reduce((s, i) => s + i.totalVat, 0));
  const totalWithVat = round2(itemData.reduce((s, i) => s + i.totalWithVat, 0));

  let customerCompanyName: string | null = null;
  if (quote.customerId != null) {
    const [c] = await db
      .select({ companyName: customersTable.companyName })
      .from(customersTable)
      .where(eq(customersTable.id, quote.customerId))
      .limit(1);
    customerCompanyName = c?.companyName ?? null;
  }

  return {
    quoteNumber: quote.quoteNumber,
    title: quote.title,
    status: quote.status,
    validUntil: quote.validUntil ?? null,
    notes: quote.notes ?? null,
    customerCompanyName,
    supplierName: settings.supplierName ?? null,
    supplierAddress: settings.supplierAddress ?? null,
    supplierEmail: settings.supplierEmail ?? null,
    supplierPhone: settings.supplierPhone ?? null,
    items: itemData,
    subtotalWithoutVat,
    totalVat,
    totalWithVat,
    vatPayer,
    createdAt: quote.createdAt.toISOString(),
  };
}

export async function acceptQuoteByToken(token: string) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, token))
    .limit(1);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["sent", "draft"].includes(quote.status))
    throw appError(409, "Tuto nabídku již nelze přijmout.");
  await db
    .update(quotesTable)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(eq(quotesTable.shareToken, token));
  return { accepted: true };
}

export async function rejectQuoteByToken(token: string) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, token))
    .limit(1);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["sent", "draft"].includes(quote.status))
    throw appError(409, "Tuto nabídku již nelze odmítnout.");
  await db
    .update(quotesTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(quotesTable.shareToken, token));
  return { rejected: true };
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

async function upsertItems(tx: DbOrTx, quoteId: number, items: QuoteItemInput[]) {
  await tx.delete(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quoteId));
  if (items.length === 0) return;
  await tx.insert(quoteItemsTable).values(
    items.map((item, idx) => ({
      quoteId,
      position: item.position ?? idx,
      description: item.description,
      quantity: String(item.quantity ?? 1),
      unit: item.unit ?? null,
      unitPrice: String(item.unitPrice ?? 0),
      vatRate: item.vatRate != null ? String(item.vatRate) : null,
    })),
  );
}

export async function createQuote(input: QuoteCreateInput) {
  const quoteNumber = await assignQuoteNumber();
  const result = await db.transaction(async (tx) => {
    const [quote] = await tx
      .insert(quotesTable)
      .values({
        quoteNumber,
        customerId: input.customerId ?? null,
        title: input.title,
        validUntil: input.validUntil ?? null,
        notes: input.notes ?? null,
        status: "draft",
      })
      .returning();
    await upsertItems(tx, quote.id, input.items ?? []);
    return quote;
  });
  return getQuoteDetail(result.id);
}

export async function updateQuote(id: number, input: QuoteUpdateInput) {
  const [existing] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!existing) throw appError(404, "Nabídka nenalezena.");
  if (existing.status !== "draft") throw appError(409, "Upravovat lze pouze nabídky ve stavu Koncept.");

  await db.transaction(async (tx) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if ("customerId" in input) set.customerId = input.customerId ?? null;
    if (input.title != null) set.title = input.title;
    if ("validUntil" in input) set.validUntil = input.validUntil ?? null;
    if ("notes" in input) set.notes = input.notes ?? null;
    await tx.update(quotesTable).set(set).where(eq(quotesTable.id, id));
    if (input.items !== undefined) {
      await upsertItems(tx, id, input.items);
    }
  });
  return getQuoteDetail(id);
}

export async function deleteQuote(id: number) {
  const [existing] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!existing) throw appError(404, "Nabídka nenalezena.");
  if (!["draft", "rejected", "expired"].includes(existing.status))
    throw appError(409, "Smazat lze pouze nabídky ve stavu Koncept, Odmítnuta nebo Expirována.");
  await db.delete(quotesTable).where(eq(quotesTable.id, id));
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function buildPdfData(quote: NonNullable<Awaited<ReturnType<typeof getQuoteDetail>>>) {
  const settings = await ensureSettings();
  const vatPayer = settings.vatPayer;

  const pdfItems = quote.items.map((item) => {
    const totals = computeItemTotals(item.unitPrice, item.quantity, item.vatRate, vatPayer);
    return {
      description: item.description,
      quantity: item.quantity,
      unit: item.unit ?? null,
      unitPrice: item.unitPrice,
      vatRate: item.vatRate,
      ...totals,
    };
  });

  const subtotalWithoutVat = round2(pdfItems.reduce((s, i) => s + i.totalWithoutVat, 0));
  const totalVat = round2(pdfItems.reduce((s, i) => s + i.totalVat, 0));
  const totalWithVat = round2(pdfItems.reduce((s, i) => s + i.totalWithVat, 0));

  const pdfData: QuotePdfData = {
    quoteNumber: quote.quoteNumber ?? `#${quote.id}`,
    customerName: quote.customerCompanyName,
    customerIc: quote.customerIc,
    customerDic: quote.customerDic,
    customerAddress: quote.customerAddress,
    customerEmail: quote.customerEmail,
    validUntil: quote.validUntil,
    notes: quote.notes,
    items: pdfItems,
    subtotalWithoutVat,
    totalVat,
    totalWithVat,
    supplier: {
      name: settings.supplierName,
      ic: settings.supplierIc,
      dic: settings.supplierDic,
      address: settings.supplierAddress,
      email: settings.supplierEmail,
      phone: settings.supplierPhone,
      footerNote: settings.invoiceFooterNote,
      vatPayer,
    },
    currency: "Kč",
  };
  return pdfData;
}

export async function generateAndStorePdf(id: number) {
  const quote = await getQuoteDetail(id);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  const pdfData = await buildPdfData(quote);
  const buffer = generateQuotePdf(pdfData);
  const objectPath = `/objects/quotes/${randomUUID()}`;
  await objectStorage.putPrivateObject(objectPath, buffer, "application/pdf");
  await db
    .update(quotesTable)
    .set({ pdfObjectPath: objectPath, updatedAt: new Date() })
    .where(eq(quotesTable.id, id));
  return { objectPath, buffer };
}

export async function sendQuote(
  id: number,
  opts: {
    to?: string | null;
    subject?: string | null;
    message?: string | null;
    shareBaseUrl?: string | null;
  },
) {
  const quote = await getQuoteDetail(id);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["draft", "sent"].includes(quote.status))
    throw appError(409, "Nabídku v tomto stavu nelze odeslat.");

  const { buffer, objectPath } = await generateAndStorePdf(id);

  const to = (opts.to ?? quote.customerEmail ?? "").trim();
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) throw appError(400, "Chybí platná e-mailová adresa příjemce.");

  // Generate or reuse share token
  const [existing] = await db
    .select({ shareToken: quotesTable.shareToken })
    .from(quotesTable)
    .where(eq(quotesTable.id, id))
    .limit(1);
  const shareToken = existing?.shareToken ?? randomUUID();
  if (!existing?.shareToken) {
    await db
      .update(quotesTable)
      .set({ shareToken })
      .where(eq(quotesTable.id, id));
  }

  const number = quote.quoteNumber ?? `#${id}`;
  const subject = (opts.subject ?? "").trim() || `Cenová nabídka ${number}`;

  // Build share link line
  const shareLine = opts.shareBaseUrl
    ? `\n\nPro zobrazení a potvrzení nabídky online klikněte zde:\n${opts.shareBaseUrl}/quote-share/${shareToken}`
    : "";

  const message =
    (opts.message ?? "").trim() ||
    `Dobrý den,\n\nv příloze zasíláme cenovou nabídku ${number}.${shareLine}\n\nS pozdravem`;

  await sendEmailWithPdf({
    to,
    subject,
    text: message,
    pdfBase64: buffer.toString("base64"),
    filename: `nabidka-${number.replace(/[^\w.-]+/g, "-")}.pdf`,
  });

  await db
    .update(quotesTable)
    .set({ status: "sent", pdfObjectPath: objectPath, shareToken, updatedAt: new Date() })
    .where(eq(quotesTable.id, id));

  return { sent: true, to, shareToken };
}

export async function acceptQuote(id: number) {
  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["sent", "draft"].includes(quote.status))
    throw appError(409, "Přijmout lze pouze odeslané nebo konceptové nabídky.");
  await db
    .update(quotesTable)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(eq(quotesTable.id, id));
  return getQuoteDetail(id);
}

export async function rejectQuote(id: number) {
  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["sent", "draft"].includes(quote.status))
    throw appError(409, "Odmítnout lze pouze odeslané nebo konceptové nabídky.");
  await db
    .update(quotesTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(quotesTable.id, id));
  return getQuoteDetail(id);
}

export async function expireQuote(id: number) {
  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, id)).limit(1);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["sent", "draft"].includes(quote.status))
    throw appError(409, "Expirovat lze pouze odeslané nebo konceptové nabídky.");
  await db
    .update(quotesTable)
    .set({ status: "expired", updatedAt: new Date() })
    .where(eq(quotesTable.id, id));
  return getQuoteDetail(id);
}

export async function convertQuoteToJob(id: number) {
  const jobId = await db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.id, id))
      .for("update")
      .limit(1);

    if (!quote) throw appError(404, "Nabídka nenalezena.");
    if (quote.status !== "accepted")
      throw appError(409, "Převést na zakázku lze pouze přijatou nabídku.");
    if (quote.convertedToJobId != null)
      throw appError(409, "Nabídka již byla převedena na zakázku – zakázka existuje.");

    const today = todayIso();
    const noteLines = [`Vytvořeno z nabídky ${quote.quoteNumber ?? `#${id}`}: ${quote.title}`];
    if (quote.notes) noteLines.push(quote.notes);

    const [job] = await tx
      .insert(jobsTable)
      .values({
        date: today,
        title: quote.title,
        customerId: quote.customerId ?? null,
        notes: noteLines.join("\n"),
        status: "planned",
        sortOrder: 0,
      })
      .returning();

    await tx
      .update(quotesTable)
      .set({ convertedToJobId: job.id, updatedAt: new Date() })
      .where(eq(quotesTable.id, id));

    return job.id;
  });

  return { jobId };
}
