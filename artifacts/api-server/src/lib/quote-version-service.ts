import { asc, desc, eq, max } from "drizzle-orm";
import {
  billingSettingsTable,
  customersTable,
  db,
  quoteDecisionEventsTable,
  quoteItemsTable,
  quotesTable,
  quoteVersionsTable,
  type PublicAccessToken,
  type QuoteVersionSnapshot,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import { evidenceSha256, normalizedUserAgentSha256, sha256Hex } from "./evidence-hash";
import { ObjectStorageService } from "./objectStorage";
import { generateQuotePdf, type QuotePdfData } from "./quote-pdf";
import { issuePublicAccessToken, revokePublicAccessTokens } from "./public-access-token";
import {
  assertQuoteDecisionStillValid,
  QuoteValidityError,
} from "./quote-validity";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | DbTransaction;

const objectStorage = new ObjectStorageService();
const SETTINGS_ID = 1;
export const QUOTE_RENDERER_VERSION = "quote-pdf-v1";
export const QUOTE_DECISION_CONFIRMATION_TEXT =
  "Potvrzuji, že jsem se seznámil/a s touto konkrétní verzí nabídky a uvedené rozhodnutí se vztahuje k jejímu obsahu a ceně.";

export class QuoteVersionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "QuoteVersionError";
  }
}

function assertVersionDecisionValidity(validUntil: string | null): void {
  try {
    assertQuoteDecisionStillValid(validUntil);
  } catch (error) {
    if (error instanceof QuoteValidityError) {
      throw new QuoteVersionError(
        410,
        error.code,
        "Platnost této verze nabídky již skončila.",
      );
    }
    throw error;
  }
}

function numberValue(value: string | number | null | undefined, fallback = 0): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function itemTotals(unitPrice: number, quantity: number, vatRate: number | null, vatPayer: boolean) {
  const totalWithoutVat = round2(unitPrice * quantity);
  const totalVat = vatPayer && vatRate != null
    ? round2(totalWithoutVat * vatRate / 100)
    : 0;
  return {
    totalWithoutVat,
    totalVat,
    totalWithVat: round2(totalWithoutVat + totalVat),
  };
}

async function loadSnapshot(
  client: DbClient,
  quoteId: number,
  lock: boolean,
): Promise<QuoteVersionSnapshot> {
  const quoteRows = lock
    ? await client.select().from(quotesTable).where(eq(quotesTable.id, quoteId)).limit(1).for("update")
    : await client.select().from(quotesTable).where(eq(quotesTable.id, quoteId)).limit(1);
  const quote = quoteRows[0];
  if (!quote) throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");

  const settingsRows = lock
    ? await client.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, SETTINGS_ID)).limit(1).for("share")
    : await client.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, SETTINGS_ID)).limit(1);
  const settings = settingsRows[0];
  if (!settings) throw new QuoteVersionError(500, "billing_settings_missing", "Nastavení fakturace nenalezeno.");

  const itemRows = lock
    ? await client.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(asc(quoteItemsTable.position)).for("share")
    : await client.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(asc(quoteItemsTable.position));

  let customer = null;
  if (quote.customerId) {
    const customerRows = lock
      ? await client.select().from(customersTable).where(eq(customersTable.id, quote.customerId)).limit(1).for("share")
      : await client.select().from(customersTable).where(eq(customersTable.id, quote.customerId)).limit(1);
    customer = customerRows[0] ?? null;
  }

  const items = itemRows.map((item) => {
    const quantity = numberValue(item.quantity, 1);
    const unitPrice = numberValue(item.unitPrice);
    const vatRate = item.vatRate == null ? null : numberValue(item.vatRate);
    return {
      lineId: item.id,
      position: item.position,
      description: item.description,
      quantity,
      unit: item.unit,
      unitPrice,
      vatRate,
      ...itemTotals(unitPrice, quantity, vatRate, settings.vatPayer),
    };
  });
  return {
    schemaVersion: 1,
    quote: {
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      title: quote.title,
      validUntil: quote.validUntil,
      notes: quote.notes,
      createdAt: quote.createdAt.toISOString(),
    },
    customer: {
      companyName: customer?.companyName ?? null,
      ic: customer?.ic ?? null,
      dic: customer?.dic ?? null,
      address: customer?.address ?? null,
      email: customer?.email ?? null,
    },
    supplier: {
      name: settings.supplierName,
      ic: settings.supplierIc,
      dic: settings.supplierDic,
      address: settings.supplierAddress,
      email: settings.supplierEmail,
      phone: settings.supplierPhone,
      footerNote: settings.invoiceFooterNote,
      vatPayer: settings.vatPayer,
    },
    items,
    totals: {
      subtotalWithoutVat: round2(items.reduce((sum, item) => sum + item.totalWithoutVat, 0)),
      totalVat: round2(items.reduce((sum, item) => sum + item.totalVat, 0)),
      totalWithVat: round2(items.reduce((sum, item) => sum + item.totalWithVat, 0)),
      currency: "Kč",
    },
    confirmationText: QUOTE_DECISION_CONFIRMATION_TEXT,
  };
}

function pdfData(snapshot: QuoteVersionSnapshot): QuotePdfData {
  return {
    quoteNumber: snapshot.quote.quoteNumber ?? `#${snapshot.quote.id}`,
    customerName: snapshot.customer.companyName,
    customerIc: snapshot.customer.ic,
    customerDic: snapshot.customer.dic,
    customerAddress: snapshot.customer.address,
    customerEmail: snapshot.customer.email,
    validUntil: snapshot.quote.validUntil,
    notes: snapshot.quote.notes,
    items: snapshot.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      vatRate: item.vatRate,
      totalWithoutVat: item.totalWithoutVat,
      totalVat: item.totalVat,
      totalWithVat: item.totalWithVat,
    })),
    subtotalWithoutVat: snapshot.totals.subtotalWithoutVat,
    totalVat: snapshot.totals.totalVat,
    totalWithVat: snapshot.totals.totalWithVat,
    supplier: snapshot.supplier,
    currency: snapshot.totals.currency,
  };
}

export async function createQuoteVersionAndToken(input: {
  quoteId: number;
  expiresAt: Date;
  createdByUserId: number;
}) {
  const snapshot = await loadSnapshot(db, input.quoteId, false);
  const snapshotSha256 = evidenceSha256(snapshot);
  const buffer = generateQuotePdf(pdfData(snapshot));
  const pdfSha256 = sha256Hex(buffer);
  const objectPath = `/objects/quotes/${input.quoteId}-${randomUUID()}.pdf`;
  await objectStorage.putPrivateObject(objectPath, buffer, "application/pdf");

  try {
    const result = await db.transaction(async (tx) => {
      const currentSnapshot = await loadSnapshot(tx, input.quoteId, true);
      if (evidenceSha256(currentSnapshot) !== snapshotSha256) {
        throw new QuoteVersionError(
          409,
          "quote_changed_during_generation",
          "Nabídka se během generování změnila. Načtěte ji znovu a opakujte odeslání.",
        );
      }
      const [current] = await tx
        .select({ status: quotesTable.status })
        .from(quotesTable)
        .where(eq(quotesTable.id, input.quoteId));
      if (!current || !["draft", "sent"].includes(current.status)) {
        throw new QuoteVersionError(409, "quote_not_sendable", "Nabídku v tomto stavu nelze odeslat.");
      }
      const [{ value: latestVersion }] = await tx
        .select({ value: max(quoteVersionsTable.version) })
        .from(quoteVersionsTable)
        .where(eq(quoteVersionsTable.quoteId, input.quoteId));
      const [previous] = await tx
        .select({ id: quoteVersionsTable.id })
        .from(quoteVersionsTable)
        .where(eq(quoteVersionsTable.quoteId, input.quoteId))
        .orderBy(desc(quoteVersionsTable.version))
        .limit(1);
      const [version] = await tx
        .insert(quoteVersionsTable)
        .values({
          quoteId: input.quoteId,
          version: Number(latestVersion ?? 0) + 1,
          supersedesVersionId: previous?.id ?? null,
          dataSnapshot: snapshot,
          snapshotSha256,
          pdfObjectPath: objectPath,
          pdfSha256,
          rendererVersion: QUOTE_RENDERER_VERSION,
          createdByUserId: input.createdByUserId,
        })
        .returning();
      if (!version) throw new Error("Quote version insert returned no row.");
      if (previous && current.status === "sent") {
        await tx.insert(quoteDecisionEventsTable).values({
          quoteId: input.quoteId,
          quoteVersionId: previous.id,
          action: "superseded",
          actorType: "system",
          reason: "quote_reissued",
        });
      }
      const issued = await issuePublicAccessToken(
        {
          purpose: "quote_decision",
          resourceId: input.quoteId,
          quoteVersionId: version.id,
          expiresAt: input.expiresAt,
          createdByUserId: input.createdByUserId,
          onIssue: async (inner) => {
            await inner
              .update(quotesTable)
              .set({ shareToken: null, pdfObjectPath: objectPath, updatedAt: new Date() })
              .where(eq(quotesTable.id, input.quoteId));
          },
        },
        tx,
      );
      return { ...issued, version };
    });
    return { ...result, buffer, snapshot };
  } catch (error) {
    await objectStorage.deletePrivateObject(objectPath).catch(() => false);
    throw error;
  }
}

export async function publicQuoteVersion(record: PublicAccessToken) {
  if (
    record.purpose !== "quote_decision" ||
    record.artifactBindingStatus !== "bound" ||
    !record.quoteVersionId
  ) {
    throw new QuoteVersionError(410, "quote_version_unbound", "Odkaz není svázán s neměnnou verzí nabídky.");
  }
  const [version] = await db
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.id, record.quoteVersionId));
  if (!version || version.quoteId !== record.resourceId) {
    throw new QuoteVersionError(404, "quote_version_not_found", "Verze nabídky nebyla nalezena.");
  }
  assertVersionDecisionValidity(version.dataSnapshot.quote.validUntil);
  const [quote] = await db
    .select({ status: quotesTable.status })
    .from(quotesTable)
    .where(eq(quotesTable.id, version.quoteId));
  if (!quote) throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");
  return { version, status: quote.status };
}

export async function recordPublicQuoteDecision(
  tx: DbTransaction,
  input: {
    record: PublicAccessToken;
    action: "accepted" | "rejected";
    respondentName: string;
    userAgent?: string;
  },
) {
  if (!input.record.quoteVersionId) {
    throw new QuoteVersionError(410, "quote_version_unbound", "Odkaz není svázán s verzí nabídky.");
  }
  const [version] = await tx
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.id, input.record.quoteVersionId))
    .for("share");
  if (!version || version.quoteId !== input.record.resourceId) {
    throw new QuoteVersionError(404, "quote_version_not_found", "Verze nabídky nebyla nalezena.");
  }
  assertVersionDecisionValidity(version.dataSnapshot.quote.validUntil);
  const [quote] = await tx
    .select({ id: quotesTable.id, status: quotesTable.status })
    .from(quotesTable)
    .where(eq(quotesTable.id, version.quoteId))
    .for("update");
  if (!quote) throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");
  if (quote.status !== "sent") {
    throw new QuoteVersionError(409, "quote_not_decidable", "Rozhodnout lze pouze o odeslané nabídce.");
  }
  await tx
    .update(quotesTable)
    .set({ status: input.action, shareToken: null, updatedAt: new Date() })
    .where(eq(quotesTable.id, quote.id));
  await tx.insert(quoteDecisionEventsTable).values({
    quoteId: quote.id,
    quoteVersionId: version.id,
    action: input.action,
    actorType: "public_recipient",
    actorName: input.respondentName,
    identityAssurance: "self_declared_name",
    confirmationText: version.dataSnapshot.confirmationText,
    userAgentSha256: normalizedUserAgentSha256(input.userAgent),
  });
  return {
    [input.action === "accepted" ? "accepted" : "rejected"]: true,
    quoteVersion: version.version,
    snapshotSha256: version.snapshotSha256,
  };
}

export async function latestQuoteVersion(
  client: DbClient,
  quoteId: number,
  lock = false,
) {
  const rows = lock
    ? await client.select().from(quoteVersionsTable).where(eq(quoteVersionsTable.quoteId, quoteId)).orderBy(desc(quoteVersionsTable.version)).limit(1).for("share")
    : await client.select().from(quoteVersionsTable).where(eq(quoteVersionsTable.quoteId, quoteId)).orderBy(desc(quoteVersionsTable.version)).limit(1);
  return rows[0] ?? null;
}

export async function recordAdminQuoteDecision(
  tx: DbTransaction,
  input: {
    quoteId: number;
    action: "accepted" | "rejected" | "expired";
    actor: { userId: number; name: string };
    reason?: string | null;
  },
) {
  const version = await latestQuoteVersion(tx, input.quoteId, true);
  if (!version) {
    throw new QuoteVersionError(409, "quote_version_missing", "Nabídku je nutné nejprve odeslat jako neměnnou verzi.");
  }
  await tx.insert(quoteDecisionEventsTable).values({
    quoteId: input.quoteId,
    quoteVersionId: version.id,
    action: input.action,
    actorType: "admin",
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    identityAssurance: "authenticated_user",
    confirmationText: input.action === "accepted" || input.action === "rejected"
      ? version.dataSnapshot.confirmationText
      : null,
    reason: input.reason ?? null,
  });
  return version;
}

export async function reopenQuoteRevision(input: {
  quoteId: number;
  reason: string;
  actor: { userId: number; name: string };
}) {
  return db.transaction(async (tx) => {
    const [quote] = await tx
      .select({
        id: quotesTable.id,
        status: quotesTable.status,
        convertedToJobId: quotesTable.convertedToJobId,
        convertedToJobGroupId: quotesTable.convertedToJobGroupId,
        convertedToInvoiceId: quotesTable.convertedToInvoiceId,
      })
      .from(quotesTable)
      .where(eq(quotesTable.id, input.quoteId))
      .for("update");
    if (!quote) throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");
    if (quote.status === "draft") {
      throw new QuoteVersionError(409, "quote_already_draft", "Nabídka je již koncept.");
    }
    if (quote.convertedToJobId || quote.convertedToJobGroupId || quote.convertedToInvoiceId) {
      throw new QuoteVersionError(
        409,
        "quote_already_converted",
        "Converted quote cannot be reopened without cancelling its downstream document.",
      );
    }
    const version = await latestQuoteVersion(tx, quote.id, true);
    if (!version) throw new QuoteVersionError(409, "quote_version_missing", "Nabídka nemá zachovanou verzi.");
    await tx.insert(quoteDecisionEventsTable).values({
      quoteId: quote.id,
      quoteVersionId: version.id,
      action: "superseded",
      actorType: "admin",
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      identityAssurance: "authenticated_user",
      reason: input.reason,
    });
    await tx
      .update(quotesTable)
      .set({ status: "draft", pdfObjectPath: null, shareToken: null, updatedAt: new Date() })
      .where(eq(quotesTable.id, quote.id));
    await revokePublicAccessTokens(
      {
        purpose: "quote_decision",
        resourceId: quote.id,
        revokedByUserId: input.actor.userId,
        reason: "quote_revision",
      },
      tx,
    );
    return version;
  });
}

export async function listQuoteEvidence(quoteId: number) {
  const versions = await db
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.quoteId, quoteId))
    .orderBy(desc(quoteVersionsTable.version));
  const events = await db
    .select()
    .from(quoteDecisionEventsTable)
    .where(eq(quoteDecisionEventsTable.quoteId, quoteId))
    .orderBy(desc(quoteDecisionEventsTable.createdAt));
  return { versions, events };
}
