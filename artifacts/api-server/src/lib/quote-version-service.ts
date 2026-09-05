import { and, asc, desc, eq, max } from "drizzle-orm";
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
import { logger } from "./logger";
import {
  evidenceSha256,
  normalizedUserAgentSha256,
  sha256Hex,
} from "./evidence-hash";
import { ObjectStorageService } from "./objectStorage";
import { generateQuotePdf, type QuotePdfData } from "./quote-pdf";
import {
  issuePublicAccessToken,
  lockAndAssertActiveOwner,
  revokePublicAccessTokens,
} from "./public-access-token";
import {
  computeQuoteItemTotals,
  normalizeQuoteRowType,
} from "./quote-calculations";
import {
  assertQuoteDecisionStillValid,
  QuoteValidityError,
} from "./quote-validity";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | DbTransaction;

const objectStorage = new ObjectStorageService();
const SETTINGS_ID = 1;
export const QUOTE_RENDERER_VERSION = "quote-pdf-v3";
export const QUOTE_DECISION_CONFIRMATION_TEXT =
  "Potvrzuji, že jsem se seznámil/a s touto konkrétní verzí nabídky a uvedené rozhodnutí se vztahuje k jejímu obsahu a ceně.";

export class QuoteVersionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
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

function numberValue(
  value: string | number | null | undefined,
  fallback = 0,
): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadSnapshot(
  client: DbClient,
  quoteId: number,
  lock: boolean,
): Promise<QuoteVersionSnapshot> {
  const quoteRows = lock
    ? await client
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteId))
        .limit(1)
        .for("update")
    : await client
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteId))
        .limit(1);
  const quote = quoteRows[0];
  if (!quote)
    throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");

  const settingsRows = lock
    ? await client
        .select()
        .from(billingSettingsTable)
        .where(eq(billingSettingsTable.id, SETTINGS_ID))
        .limit(1)
        .for("share")
    : await client
        .select()
        .from(billingSettingsTable)
        .where(eq(billingSettingsTable.id, SETTINGS_ID))
        .limit(1);
  const settings = settingsRows[0];
  if (!settings)
    throw new QuoteVersionError(
      500,
      "billing_settings_missing",
      "Nastavení fakturace nenalezeno.",
    );

  // All item INSERT/DELETE/reorder writers lock the parent first. No UPDATE
  // privilege is needed on items. Both snapshot reads use REPEATABLE READ.
  const itemRows = await client
    .select()
    .from(quoteItemsTable)
    .where(eq(quoteItemsTable.quoteId, quote.id))
    .orderBy(asc(quoteItemsTable.position), asc(quoteItemsTable.id));

  let customer = null;
  if (quote.customerId) {
    const customerRows = lock
      ? await client
          .select()
          .from(customersTable)
          .where(eq(customersTable.id, quote.customerId))
          .limit(1)
          .for("share")
      : await client
          .select()
          .from(customersTable)
          .where(eq(customersTable.id, quote.customerId))
          .limit(1);
    customer = customerRows[0] ?? null;
  }

  const items = itemRows.map((item) => {
    const rowType = normalizeQuoteRowType(item.rowType);
    const quantity = rowType === "item" ? numberValue(item.quantity, 1) : 0;
    const unitPrice = rowType === "item" ? numberValue(item.unitPrice) : 0;
    const vatRate =
      rowType === "item" && item.vatRate != null
        ? numberValue(item.vatRate)
        : null;
    return {
      lineId: item.id,
      position: item.position,
      rowType,
      description: item.description,
      quantity,
      unit: item.unit,
      unitPrice,
      vatRate,
      ...computeQuoteItemTotals(
        { rowType, quantity, unitPrice, vatRate },
        settings.vatPayer,
      ),
    };
  });
  return {
    schemaVersion: 2,
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
      subtotalWithoutVat: round2(
        items.reduce((sum, item) => sum + item.totalWithoutVat, 0),
      ),
      totalVat: round2(items.reduce((sum, item) => sum + item.totalVat, 0)),
      totalWithVat: round2(
        items.reduce((sum, item) => sum + item.totalWithVat, 0),
      ),
      currency: "Kč",
    },
    confirmationText: QUOTE_DECISION_CONFIRMATION_TEXT,
  };
}

export function quoteSnapshotPdfData(
  snapshot: QuoteVersionSnapshot,
): QuotePdfData {
  return {
    title: snapshot.quote.title,
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
      rowType: item.rowType,
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
  const snapshot = await readQuoteSnapshot(input.quoteId);
  const snapshotSha256 = evidenceSha256(snapshot);
  const buffer = generateQuotePdf(quoteSnapshotPdfData(snapshot));
  const pdfSha256 = sha256Hex(buffer);
  const objectPath = `/objects/quotes/${input.quoteId}-${randomUUID()}.pdf`;
  try {
    await objectStorage.putPrivateObject(objectPath, buffer, "application/pdf");
    const result = await db.transaction(
      async (tx) => {
        const currentSnapshot = await loadSnapshot(tx, input.quoteId, true);
        if (evidenceSha256(currentSnapshot) !== snapshotSha256) {
          throw new QuoteVersionError(
            409,
            "quote_changed_during_generation",
            "Nabídka se během generování změnila. Načtěte ji znovu a opakujte odeslání.",
          );
        }
        const [current] = await tx
          .select({
            status: quotesTable.status,
            updatedAt: quotesTable.updatedAt,
          })
          .from(quotesTable)
          .where(eq(quotesTable.id, input.quoteId));
        if (!current || !["draft", "sent"].includes(current.status)) {
          throw new QuoteVersionError(
            409,
            "quote_not_sendable",
            "Nabídku v tomto stavu nelze odeslat.",
          );
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
        // Lock the issuer before the version FK acquires KEY SHARE on users.
        // Otherwise two quotes by one issuer can deadlock upgrading that lock
        // during token issuance (FK -> owner advisory lock -> FOR UPDATE).
        await lockAndAssertActiveOwner(tx, input.createdByUserId, "quote_decision");
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
        const issued = await issuePublicAccessToken(
          {
            purpose: "quote_decision",
            resourceId: input.quoteId,
            quoteVersionId: version.id,
            expiresAt: input.expiresAt,
            createdByUserId: input.createdByUserId,
            deferQuoteReplacement: true,
          },
          tx,
        );
        return { ...issued, version, expectedUpdatedAt: current.updatedAt };
      },
      { isolationLevel: "repeatable read" },
    );
    return { ...result, buffer, snapshot };
  } catch (error) {
    // A COMMIT acknowledgement can be lost. Never remove a retained version's PDF.
    try {
      const [retained] = await db
        .select({ id: quoteVersionsTable.id })
        .from(quoteVersionsTable)
        .where(eq(quoteVersionsTable.pdfObjectPath, objectPath));
      if (!retained && !(await objectStorage.deletePrivateObject(objectPath))) {
        logger.error(
          { quoteId: input.quoteId, objectPath },
          "Quote PDF cleanup did not remove object",
        );
      }
    } catch {
      logger.error(
        { quoteId: input.quoteId, objectPath },
        "Quote PDF cleanup failed; object retained",
      );
    }
    const cause = error as { code?: string; cause?: { code?: string } };
    if ([cause.code, cause.cause?.code].includes("40001")) {
      throw new QuoteVersionError(
        409,
        "quote_changed_during_generation",
        "Nabídka se během generování změnila. Načtěte ji znovu.",
      );
    }
    throw error;
  }
}

export async function publicQuoteVersion(record: PublicAccessToken) {
  if (
    record.purpose !== "quote_decision" ||
    record.artifactBindingStatus !== "bound" ||
    !record.quoteVersionId
  ) {
    throw new QuoteVersionError(
      410,
      "quote_version_unbound",
      "Odkaz není svázán s neměnnou verzí nabídky.",
    );
  }
  const [version] = await db
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.id, record.quoteVersionId));
  if (!version || version.quoteId !== record.resourceId) {
    throw new QuoteVersionError(
      404,
      "quote_version_not_found",
      "Verze nabídky nebyla nalezena.",
    );
  }
  assertVersionDecisionValidity(version.dataSnapshot.quote.validUntil);
  const [quote] = await db
    .select({ status: quotesTable.status })
    .from(quotesTable)
    .where(eq(quotesTable.id, version.quoteId));
  if (!quote)
    throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");
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
    throw new QuoteVersionError(
      410,
      "quote_version_unbound",
      "Odkaz není svázán s verzí nabídky.",
    );
  }
  const [version] = await tx
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.id, input.record.quoteVersionId));
  if (!version || version.quoteId !== input.record.resourceId) {
    throw new QuoteVersionError(
      404,
      "quote_version_not_found",
      "Verze nabídky nebyla nalezena.",
    );
  }
  assertVersionDecisionValidity(version.dataSnapshot.quote.validUntil);
  const [quote] = await tx
    .select({
      id: quotesTable.id,
      status: quotesTable.status,
      pdfObjectPath: quotesTable.pdfObjectPath,
    })
    .from(quotesTable)
    .where(eq(quotesTable.id, version.quoteId))
    .for("update");
  if (!quote)
    throw new QuoteVersionError(404, "quote_not_found", "Nabídka nenalezena.");
  if (
    quote.status !== "sent" ||
    quote.pdfObjectPath !== version.pdfObjectPath
  ) {
    throw new QuoteVersionError(
      409,
      "quote_not_decidable",
      "Rozhodnout lze pouze o odeslané nabídce.",
    );
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
  // Versions are protected by immutable triggers; callers serialize decisions on quotes.
  void lock;
  const rows = await client
    .select()
    .from(quoteVersionsTable)
    .where(eq(quoteVersionsTable.quoteId, quoteId))
    .orderBy(desc(quoteVersionsTable.version))
    .limit(1);
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
  const version = await issuedQuoteVersion(tx, input.quoteId);
  if (!version) {
    throw new QuoteVersionError(
      409,
      "quote_version_missing",
      "Nabídku je nutné nejprve odeslat jako neměnnou verzi.",
    );
  }
  await tx.insert(quoteDecisionEventsTable).values({
    quoteId: input.quoteId,
    quoteVersionId: version.id,
    action: input.action,
    actorType: "admin",
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    identityAssurance: "authenticated_user",
    confirmationText:
      input.action === "accepted" || input.action === "rejected"
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
    if (!quote)
      throw new QuoteVersionError(
        404,
        "quote_not_found",
        "Nabídka nenalezena.",
      );
    if (quote.status === "draft") {
      throw new QuoteVersionError(
        409,
        "quote_already_draft",
        "Nabídka je již koncept.",
      );
    }
    if (
      quote.convertedToJobId ||
      quote.convertedToJobGroupId ||
      quote.convertedToInvoiceId
    ) {
      throw new QuoteVersionError(
        409,
        "quote_already_converted",
        "Converted quote cannot be reopened without cancelling its downstream document.",
      );
    }
    const version = await issuedQuoteVersion(tx, quote.id);
    if (!version)
      throw new QuoteVersionError(
        409,
        "quote_version_missing",
        "Nabídka nemá zachovanou verzi.",
      );
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
      .set({
        status: "draft",
        pdfObjectPath: null,
        shareToken: null,
        updatedAt: new Date(),
      })
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

/** One MVCC snapshot covers quote, customer, supplier and all item rows. No writes. */
export async function readQuoteSnapshot(quoteId: number) {
  return db.transaction((tx) => loadSnapshot(tx, quoteId, false), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function issuedQuoteVersion(client: DbClient, quoteId: number) {
  const [quote] = await client
    .select({ path: quotesTable.pdfObjectPath })
    .from(quotesTable)
    .where(eq(quotesTable.id, quoteId));
  if (!quote?.path) return null;
  const [version] = await client
    .select()
    .from(quoteVersionsTable)
    .where(
      and(
        eq(quoteVersionsTable.quoteId, quoteId),
        eq(quoteVersionsTable.pdfObjectPath, quote.path),
      ),
    );
  return version ?? null;
}

export async function exportQuotePdf(quoteId: number, versionNumber?: number) {
  // Status and archive selection must also belong to the same MVCC snapshot.
  const selected = await db.transaction(
    async (tx) => {
      const [quote] = await tx
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteId));
      if (!quote)
        throw new QuoteVersionError(
          404,
          "quote_not_found",
          "Nabídka nenalezena.",
        );
      if (versionNumber != null) {
        const [version] = await tx
          .select()
          .from(quoteVersionsTable)
          .where(
            and(
              eq(quoteVersionsTable.quoteId, quoteId),
              eq(quoteVersionsTable.version, versionNumber),
            ),
          );
        if (!version)
          throw new QuoteVersionError(
            404,
            "quote_version_not_found",
            "Verze nabídky nenalezena.",
          );
        return {
          number: quote.quoteNumber,
          version,
          path: version.pdfObjectPath,
          snapshot: null,
        };
      }
      if (quote.status === "draft")
        return {
          number: quote.quoteNumber,
          snapshot: await loadSnapshot(tx, quoteId, false),
          path: null,
          version: null,
        };
      if (!quote.pdfObjectPath)
        throw new QuoteVersionError(
          404,
          "quote_pdf_missing",
          "Původní PDF nabídky není dostupné.",
        );
      return {
        number: quote.quoteNumber,
        path: quote.pdfObjectPath,
        version: await issuedQuoteVersion(tx, quoteId),
        snapshot: null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const buffer = selected.snapshot
    ? generateQuotePdf(quoteSnapshotPdfData(selected.snapshot))
    : await objectStorage.getPrivateObjectBuffer(selected.path!, {
        maxBytes: 25 * 1024 * 1024,
      });
  if (selected.version && sha256Hex(buffer) !== selected.version.pdfSha256)
    throw new QuoteVersionError(
      500,
      "quote_pdf_integrity",
      "Archivní PDF neodpovídá uložené verzi.",
    );
  if (buffer.subarray(0, 5).toString() !== "%PDF-")
    throw new QuoteVersionError(
      500,
      "quote_pdf_invalid",
      "Archivní soubor není platné PDF.",
    );
  const number = (selected.number ?? String(quoteId)).replace(
    /[^a-zA-Z0-9_.-]+/g,
    "-",
  );
  return {
    buffer,
    filename: `nabidka-${number}${selected.version ? `-v${selected.version.version}` : ""}.pdf`,
  };
}
