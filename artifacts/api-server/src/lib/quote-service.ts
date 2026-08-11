import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  db,
  billingSettingsTable,
  quotesTable,
  quoteItemsTable,
  customersTable,
  jobGroupsTable,
  jobsTable,
  auditLogTable,
  type Quote,
  type QuoteItem,
} from "@workspace/db";
import { generateQuotePdf, type QuotePdfData } from "./quote-pdf";
import { sendEmailWithPdf } from "./email";
import { ObjectStorageService } from "./objectStorage";
import { randomUUID } from "node:crypto";
import { publicAppGrantUrl, publicAppOrigin } from "./public-origin";
import {
  consumePublicAccessToken,
  isPlausiblePublicAccessToken,
  publicTokenExpiry,
  resolvePublicAccessToken,
  revokePublicAccessTokens,
} from "./public-access-token";
import {
  createQuoteVersionAndToken,
  latestQuoteVersion,
  publicQuoteVersion,
  recordAdminQuoteDecision,
  recordPublicQuoteDecision,
} from "./quote-version-service";
import { quoteDecisionExpiresAt, QuoteValidityError } from "./quote-validity";
import {
  computeQuoteItemTotals,
  computeQuoteTotals,
  normalizeQuoteRowType,
  type QuoteRowType,
} from "./quote-calculations";

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
  rowType?: QuoteRowType | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  purchaseUnitPrice?: number | null;
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

export interface QuoteConversionInput {
  plannedDate?: string | null;
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
  const [row] = await db
    .insert(billingSettingsTable)
    .values({ id: SETTINGS_ID })
    .returning();
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
    rowType: normalizeQuoteRowType(item.rowType),
    quantity: parseNum(item.quantity, 1),
    unitPrice: parseNum(item.unitPrice, 0),
    purchaseUnitPrice:
      item.purchaseUnitPrice != null ? parseNum(item.purchaseUnitPrice) : null,
    vatRate: item.vatRate != null ? parseNum(item.vatRate) : null,
  };
}

export function serializeQuote(quote: Quote) {
  const { shareToken: _secretShareToken, ...safeQuote } = quote;
  return {
    ...safeQuote,
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
  if (opts?.customerId != null)
    conditions.push(eq(quotesTable.customerId, opts.customerId));
  if (opts?.status != null && opts.status !== "all")
    conditions.push(eq(quotesTable.status, opts.status));

  const quotes = await db
    .select()
    .from(quotesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(quotesTable.createdAt));

  const customerIds = [
    ...new Set(
      quotes.map((q) => q.customerId).filter((id): id is number => id != null),
    ),
  ];
  const customersMap = new Map<
    number,
    { companyName: string | null; email: string | null }
  >();
  if (customerIds.length > 0) {
    const customers = await db
      .select({
        id: customersTable.id,
        companyName: customersTable.companyName,
        email: customersTable.email,
      })
      .from(customersTable)
      .where(inArray(customersTable.id, customerIds));
    for (const c of customers)
      customersMap.set(c.id, { companyName: c.companyName, email: c.email });
  }

  return Promise.all(
    quotes.map(async (q) => {
      const items = await db
        .select()
        .from(quoteItemsTable)
        .where(eq(quoteItemsTable.quoteId, q.id))
        .orderBy(asc(quoteItemsTable.position));
      const itemData = items.map(serializeItem);
      const totals = computeQuoteTotals(itemData, true);
      const customerInfo =
        q.customerId != null ? (customersMap.get(q.customerId) ?? null) : null;
      return {
        ...serializeQuote(q),
        customerCompanyName: customerInfo?.companyName ?? null,
        customerEmail: customerInfo?.email ?? null,
        itemCount: totals.financialItemCount,
        totalWithVat: totals.totalWithVat,
      };
    }),
  );
}

export async function getQuoteDetail(id: number) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, id))
    .limit(1);
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

  const itemData = items.map(serializeItem);
  const margin = computeQuoteTotals(itemData, true);

  return {
    ...serializeQuote(quote),
    customerCompanyName,
    customerEmail,
    customerIc,
    customerDic,
    customerAddress,
    items: itemData,
    totalPurchaseCost: margin.totalPurchaseCost,
    marginAmount: margin.marginAmount,
    marginPercent: margin.marginPercent,
    financialItemCount: margin.financialItemCount,
    costedItemCount: margin.costedItemCount,
    marginComplete: margin.marginComplete,
  };
}

// ---------------------------------------------------------------------------
// Public share-token lookup (no auth — gated by token)
// ---------------------------------------------------------------------------

export function isValidToken(token: string): boolean {
  return isPlausiblePublicAccessToken(token);
}

export async function getQuoteByShareToken(token: string) {
  const tokenRecord = await resolvePublicAccessToken("quote_decision", token);
  const { version, status } = await publicQuoteVersion(tokenRecord);
  const snapshot = version.dataSnapshot;

  return {
    quoteNumber: snapshot.quote.quoteNumber,
    quoteVersion: version.version,
    snapshotSha256: version.snapshotSha256,
    pdfSha256: version.pdfSha256,
    confirmationText: snapshot.confirmationText,
    title: snapshot.quote.title,
    status,
    validUntil: snapshot.quote.validUntil,
    notes: snapshot.quote.notes,
    customerCompanyName: snapshot.customer.companyName,
    supplierName: snapshot.supplier.name,
    supplierAddress: snapshot.supplier.address,
    supplierEmail: snapshot.supplier.email,
    supplierPhone: snapshot.supplier.phone,
    items: snapshot.items.map((item) => ({ ...item, id: item.lineId })),
    subtotalWithoutVat: snapshot.totals.subtotalWithoutVat,
    totalVat: snapshot.totals.totalVat,
    totalWithVat: snapshot.totals.totalWithVat,
    vatPayer: snapshot.supplier.vatPayer,
    createdAt: snapshot.quote.createdAt,
  };
}

export async function acceptQuoteByToken(
  token: string,
  evidence: { respondentName: string; userAgent?: string },
) {
  return consumePublicAccessToken({
    purpose: "quote_decision",
    token,
    action: "accepted",
    transition: (tx, record) =>
      recordPublicQuoteDecision(tx, {
        record,
        action: "accepted",
        respondentName: evidence.respondentName,
        userAgent: evidence.userAgent,
      }),
  });
}

export async function rejectQuoteByToken(
  token: string,
  evidence: { respondentName: string; userAgent?: string },
) {
  return consumePublicAccessToken({
    purpose: "quote_decision",
    token,
    action: "rejected",
    transition: (tx, record) =>
      recordPublicQuoteDecision(tx, {
        record,
        action: "rejected",
        respondentName: evidence.respondentName,
        userAgent: evidence.userAgent,
      }),
  });
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

async function upsertItems(
  tx: DbOrTx,
  quoteId: number,
  items: QuoteItemInput[],
) {
  await tx.delete(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quoteId));
  if (items.length === 0) return;

  const normalizedItems = items.map((item, idx) => {
    const rowType = normalizeQuoteRowType(item.rowType);
    const description = item.description.trim();
    if (rowType !== "spacer" && description.length === 0) {
      throw appError(
        400,
        rowType === "section"
          ? "Nadpis sekce nesmí být prázdný."
          : "Popis položky nesmí být prázdný.",
      );
    }
    if (rowType !== "item") {
      return {
        quoteId,
        position: item.position ?? idx,
        rowType,
        description: rowType === "spacer" ? "" : description,
        quantity: "0",
        unit: null,
        unitPrice: "0",
        purchaseUnitPrice: null,
        vatRate: null,
      };
    }

    const quantity = item.quantity ?? 1;
    const unitPrice = item.unitPrice ?? 0;
    const purchaseUnitPrice = item.purchaseUnitPrice ?? null;
    const vatRate = item.vatRate ?? null;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw appError(
        400,
        `Množství položky „${description}“ musí být větší než nula.`,
      );
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw appError(
        400,
        `Prodejní cena položky „${description}“ nesmí být záporná.`,
      );
    }
    if (
      purchaseUnitPrice != null &&
      (!Number.isFinite(purchaseUnitPrice) || purchaseUnitPrice < 0)
    ) {
      throw appError(
        400,
        `Nákupní cena položky „${description}“ nesmí být záporná.`,
      );
    }
    if (
      vatRate != null &&
      (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100)
    ) {
      throw appError(
        400,
        `Sazba DPH položky „${description}“ je mimo povolený rozsah.`,
      );
    }

    return {
      quoteId,
      position: item.position ?? idx,
      rowType,
      description,
      quantity: String(quantity),
      unit: item.unit?.trim() || null,
      unitPrice: String(unitPrice),
      purchaseUnitPrice:
        purchaseUnitPrice != null ? String(purchaseUnitPrice) : null,
      vatRate: vatRate != null ? String(vatRate) : null,
    };
  });

  await tx.insert(quoteItemsTable).values(normalizedItems);
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
  const [existing] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, id))
    .limit(1);
  if (!existing) throw appError(404, "Nabídka nenalezena.");
  if (existing.status !== "draft")
    throw appError(409, "Upravovat lze pouze nabídky ve stavu Koncept.");

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
  const [existing] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, id))
    .limit(1);
  if (!existing) throw appError(404, "Nabídka nenalezena.");
  if (existing.status !== "draft")
    throw appError(
      409,
      "Smazat lze pouze koncept, který ještě nemá důkazní verzi.",
    );
  if (await latestQuoteVersion(db, id)) {
    throw appError(
      409,
      "Koncept navazuje na dříve odeslanou verzi a musí zůstat zachován.",
    );
  }
  await db.delete(quotesTable).where(eq(quotesTable.id, id));
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function buildPdfData(
  quote: NonNullable<Awaited<ReturnType<typeof getQuoteDetail>>>,
) {
  const settings = await ensureSettings();
  const vatPayer = settings.vatPayer;

  const pdfItems = quote.items.map((item) => {
    const totals = computeQuoteItemTotals(item, vatPayer);
    return {
      description: item.description,
      rowType: item.rowType,
      quantity: item.quantity,
      unit: item.unit ?? null,
      unitPrice: item.unitPrice,
      vatRate: item.vatRate,
      ...totals,
    };
  });

  const totals = computeQuoteTotals(pdfItems, vatPayer);

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
    subtotalWithoutVat: totals.totalWithoutVat,
    totalVat: totals.totalVat,
    totalWithVat: totals.totalWithVat,
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
    createdByUserId: number;
  },
) {
  // Validate the canonical external origin before generating or storing a PDF.
  // Request Host headers are never accepted as link input.
  publicAppOrigin();
  const quote = await getQuoteDetail(id);
  if (!quote) throw appError(404, "Nabídka nenalezena.");
  if (!["draft", "sent"].includes(quote.status))
    throw appError(409, "Nabídku v tomto stavu nelze odeslat.");

  const to = (opts.to ?? quote.customerEmail ?? "").trim();
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to))
    throw appError(400, "Chybí platná e-mailová adresa příjemce.");

  await ensureSettings();
  let expiresAt: Date;
  try {
    expiresAt = quoteDecisionExpiresAt(
      publicTokenExpiry("QUOTE_SHARE_EXPIRY_DAYS", 30),
      quote.validUntil,
    );
  } catch (error) {
    if (error instanceof QuoteValidityError) {
      throw appError(
        409,
        "Platnost nabídky již skončila. Upravte datum platnosti před odesláním.",
      );
    }
    throw error;
  }
  const {
    buffer,
    version,
    token: shareToken,
  } = await createQuoteVersionAndToken({
    quoteId: id,
    expiresAt,
    createdByUserId: opts.createdByUserId,
  });

  const number = quote.quoteNumber ?? `#${id}`;
  const subject = (opts.subject ?? "").trim() || `Cenová nabídka ${number}`;

  // Build share link line
  const shareLine =
    `\n\nPro zobrazení a potvrzení nabídky online klikněte zde:\n` +
    publicAppGrantUrl("/quote-share", shareToken);

  const message =
    (opts.message ?? "").trim() ||
    `Dobrý den,\n\nv příloze zasíláme cenovou nabídku ${number}.${shareLine}\n\nS pozdravem`;

  try {
    await sendEmailWithPdf({
      to,
      subject,
      text: message,
      pdfBase64: buffer.toString("base64"),
      filename: `nabidka-${number.replace(/[^\w.-]+/g, "-")}.pdf`,
    });
  } catch (error) {
    await revokePublicAccessTokens({
      purpose: "quote_decision",
      resourceId: id,
      reason: "delivery_failed",
    }).catch(() => undefined);
    throw error;
  }

  await db
    .update(quotesTable)
    .set({
      status: "sent",
      pdfObjectPath: version.pdfObjectPath,
      shareToken: null,
      updatedAt: new Date(),
    })
    .where(eq(quotesTable.id, id));

  return {
    sent: true,
    to,
    expiresAt: expiresAt.toISOString(),
    quoteVersion: version.version,
    snapshotSha256: version.snapshotSha256,
    pdfSha256: version.pdfSha256,
  };
}

export async function acceptQuote(id: number, actor: Actor) {
  await db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.id, id))
      .for("update")
      .limit(1);
    if (!quote) throw appError(404, "Nabídka nenalezena.");
    if (quote.status !== "sent")
      throw appError(
        409,
        "Přijmout lze pouze odeslanou neměnnou verzi nabídky.",
      );
    await recordAdminQuoteDecision(tx, {
      quoteId: id,
      action: "accepted",
      actor,
    });
    await tx
      .update(quotesTable)
      .set({ status: "accepted", shareToken: null, updatedAt: new Date() })
      .where(eq(quotesTable.id, id));
    await revokePublicAccessTokens(
      {
        purpose: "quote_decision",
        resourceId: id,
        reason: "admin_accepted",
      },
      tx,
    );
  });
  return getQuoteDetail(id);
}

export async function rejectQuote(id: number, actor: Actor) {
  await db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.id, id))
      .for("update")
      .limit(1);
    if (!quote) throw appError(404, "Nabídka nenalezena.");
    if (quote.status !== "sent")
      throw appError(
        409,
        "Odmítnout lze pouze odeslanou neměnnou verzi nabídky.",
      );
    await recordAdminQuoteDecision(tx, {
      quoteId: id,
      action: "rejected",
      actor,
    });
    await tx
      .update(quotesTable)
      .set({ status: "rejected", shareToken: null, updatedAt: new Date() })
      .where(eq(quotesTable.id, id));
    await revokePublicAccessTokens(
      {
        purpose: "quote_decision",
        resourceId: id,
        reason: "admin_rejected",
      },
      tx,
    );
  });
  return getQuoteDetail(id);
}

export async function expireQuote(id: number, actor: Actor) {
  await db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.id, id))
      .for("update")
      .limit(1);
    if (!quote) throw appError(404, "Nabídka nenalezena.");
    if (quote.status !== "sent")
      throw appError(
        409,
        "Expirovat lze pouze odeslanou neměnnou verzi nabídky.",
      );
    await recordAdminQuoteDecision(tx, {
      quoteId: id,
      action: "expired",
      actor,
    });
    await tx
      .update(quotesTable)
      .set({ status: "expired", shareToken: null, updatedAt: new Date() })
      .where(eq(quotesTable.id, id));
    await revokePublicAccessTokens(
      {
        purpose: "quote_decision",
        resourceId: id,
        reason: "admin_expired",
      },
      tx,
    );
  });
  return getQuoteDetail(id);
}

export async function convertQuoteToJob(
  id: number,
  input: QuoteConversionInput = {},
  actor?: Actor,
) {
  const plannedDate = input.plannedDate?.trim() || todayIso();
  const parsedDate = new Date(`${plannedDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== plannedDate
  ) {
    throw appError(400, "Plánovaný termín musí být platné datum.");
  }

  return db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.id, id))
      .for("update")
      .limit(1);

    if (!quote) throw appError(404, "Nabídka nenalezena.");
    if (quote.status !== "accepted")
      throw appError(409, "Převést na zakázku lze pouze přijatou nabídku.");
    if (quote.convertedToJobId != null || quote.convertedToJobGroupId != null)
      throw appError(409, "Nabídka již byla převedena na akci zakázek.");

    const noteLines = [
      `Vytvořeno z nabídky ${quote.quoteNumber ?? `#${id}`}: ${quote.title}`,
    ];
    if (quote.notes) noteLines.push(quote.notes);

    const [group] = await tx
      .insert(jobGroupsTable)
      .values({
        name: quote.title,
        customerId: quote.customerId ?? null,
        notes: `Vytvořeno z nabídky ${quote.quoteNumber ?? `#${id}`}.`,
        status: "open",
        dateFrom: plannedDate,
        dateTo: plannedDate,
      })
      .returning();

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`jobs-sort:${plannedDate}`}))`,
    );
    const [order] = await tx
      .select({ maxSort: max(jobsTable.sortOrder) })
      .from(jobsTable)
      .where(eq(jobsTable.date, plannedDate));

    const [job] = await tx
      .insert(jobsTable)
      .values({
        date: plannedDate,
        title: quote.title,
        customerId: quote.customerId ?? null,
        groupId: group.id,
        notes: noteLines.join("\n"),
        status: "planned",
        sortOrder: (order?.maxSort ?? -1) + 1,
      })
      .returning();

    await tx
      .update(quotesTable)
      .set({
        convertedToJobId: job.id,
        convertedToJobGroupId: group.id,
        updatedAt: new Date(),
      })
      .where(eq(quotesTable.id, id));

    await tx.insert(auditLogTable).values({
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? "Systém",
      action: "quote_converted_to_job_group",
      entityType: "quote",
      entityId: quote.id,
      summary: `Nabídka ${quote.quoteNumber ?? `#${quote.id}`} převedena na akci #${group.id} a zakázku #${job.id} s termínem ${plannedDate}.`,
      method: "POST",
      path: `/quotes/${quote.id}/convert-to-job`,
    });

    return { jobId: job.id, jobGroupId: group.id };
  });
}
