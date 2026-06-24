/**
 * Service layer for received cost documents (přijaté nákladové doklady).
 *
 * Covers: creating documents from uploaded files / job attachments, duplicate
 * detection, machine-side ISDOC parsing, the review lifecycle, line matching /
 * splitting across jobs, and surfacing approved lines to the outgoing-invoice
 * builder. No AI — every value is either read from an ISDOC document or entered
 * by an admin during review. Matching is only ever a suggestion.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  billingDocumentReferencesTable,
  billingDocumentFilesTable,
  supplierParserProfilesTable,
  extractionJobsTable,
  attachmentsTable,
  jobsTable,
  materialsTable,
  warehouseItemsTable,
  warehousePriceHistoryTable,
  auditLogTable,
  type BillingDocument,
  type BillingDocumentLine,
  type BillingDocumentReference,
} from "@workspace/db";
import { computeLine, num, round2, type VatMode } from "./invoice-calc";
import { parseIsdocBuffer, isParsableIsdoc, type ParsedDocument } from "./isdoc-parser";
import { ObjectStorageService } from "./objectStorage";
import { classifyFee, normalizeUnit, computeDiscountPercent } from "./fee-classifier";
import {
  recognizeSupplier,
  type SupplierProfile,
  type ParserType,
} from "./supplier-profiles";
import {
  scoreDeliveryNoteToInvoice,
  rankJobsForReference,
  scoreLineMatch,
  type MatchableDocument,
  type MatchableLine,
} from "./document-matching";
import { normalizeItemName } from "./reference-extractor";
import { resolveDocumentLinkingConfig } from "./document-linking-config";
import {
  reconcileDocumentStockMovements,
  reconcileSourceMovements,
  reconcileMaterialStockMovement,
} from "./warehouse-service";

const objectStorage = new ObjectStorageService();

export type AppError = Error & { statusCode: number };
function appError(statusCode: number, message: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

export interface Actor {
  // Nullable so automated importers (e.g. the e-mail poller) can act without a
  // human user; the FK columns it writes to are nullable.
  userId: number | null;
  name: string;
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const SYSTEM_ACTOR: Actor = { userId: null, name: "Systém" };
const REBILL_ALLOC = "rebill";
const VALID_ALLOC = new Set(["rebill", "internal", "stock", "not_rebilled"]);
const VALID_LINE_TYPE = new Set(["material", "work", "transport", "other"]);
const VALID_DOC_TYPE = new Set(["receipt", "delivery_note", "invoice", "credit_note"]);

// ---------------------------------------------------------------------------
// Hashing + duplicate detection
// ---------------------------------------------------------------------------

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export interface DuplicateMatch {
  id: number;
  reason: string;
  documentNumber: string | null;
  supplierName: string | null;
  totalWithVat: string | null;
  status: string;
  createdAt: string;
}

export interface DuplicateProbe {
  sha256?: string | null;
  supplierIc?: string | null;
  supplierName?: string | null;
  documentNumber?: string | null;
  variableSymbol?: string | null;
  issueDate?: string | null;
  totalWithVat?: number | null;
  excludeId?: number;
}

/**
 * Find documents that look like duplicates of the probe, using progressively
 * weaker signals. Returns a de-duplicated list with the (strongest) reason each
 * was flagged. Callers warn the admin and let them import anyway.
 */
export async function findDuplicates(probe: DuplicateProbe): Promise<DuplicateMatch[]> {
  const found = new Map<number, DuplicateMatch>();
  const totalStr =
    probe.totalWithVat != null ? String(round2(num(probe.totalWithVat))) : null;

  const add = (rows: BillingDocument[], reason: string) => {
    for (const r of rows) {
      if (probe.excludeId && r.id === probe.excludeId) continue;
      if (!found.has(r.id)) {
        found.set(r.id, {
          id: r.id,
          reason,
          documentNumber: r.documentNumber,
          supplierName: r.supplierName,
          totalWithVat: r.totalWithVat,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        });
      }
    }
  };

  // 1. Exact content hash — the strongest signal (same file bytes).
  if (probe.sha256) {
    add(
      await db
        .select()
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.sha256, probe.sha256)),
      "Stejný soubor (shodný obsah)",
    );
  }
  // 2. Same supplier IČO + document number.
  if (probe.supplierIc && probe.documentNumber) {
    add(
      await db
        .select()
        .from(billingDocumentsTable)
        .where(
          and(
            eq(billingDocumentsTable.supplierIc, probe.supplierIc),
            eq(billingDocumentsTable.documentNumber, probe.documentNumber),
          ),
        ),
      "Stejné IČO dodavatele a číslo dokladu",
    );
  }
  // 3. Same supplier name + document number + total.
  if (probe.supplierName && probe.documentNumber && totalStr) {
    add(
      await db
        .select()
        .from(billingDocumentsTable)
        .where(
          and(
            eq(billingDocumentsTable.supplierName, probe.supplierName),
            eq(billingDocumentsTable.documentNumber, probe.documentNumber),
            eq(billingDocumentsTable.totalWithVat, totalStr),
          ),
        ),
      "Stejný dodavatel, číslo dokladu a částka",
    );
  }
  // 4. Same variable symbol + total.
  if (probe.variableSymbol && totalStr) {
    add(
      await db
        .select()
        .from(billingDocumentsTable)
        .where(
          and(
            eq(billingDocumentsTable.variableSymbol, probe.variableSymbol),
            eq(billingDocumentsTable.totalWithVat, totalStr),
          ),
        ),
      "Stejný variabilní symbol a částka",
    );
  }
  // 5. Same issue date + total + supplier name.
  if (probe.issueDate && totalStr && probe.supplierName) {
    add(
      await db
        .select()
        .from(billingDocumentsTable)
        .where(
          and(
            eq(billingDocumentsTable.issueDate, probe.issueDate),
            eq(billingDocumentsTable.totalWithVat, totalStr),
            eq(billingDocumentsTable.supplierName, probe.supplierName),
          ),
        ),
      "Stejné datum vystavení, částka a dodavatel",
    );
  }

  return Array.from(found.values());
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeDocument(row: BillingDocument) {
  return {
    id: row.id,
    status: row.status,
    docType: row.docType,
    source: row.source,
    sourceRef: row.sourceRef,
    objectPath: row.objectPath,
    fileName: row.fileName,
    contentType: row.contentType,
    fileSize: row.fileSize,
    supplierName: row.supplierName,
    supplierIc: row.supplierIc,
    supplierDic: row.supplierDic,
    supplierAddress: row.supplierAddress,
    documentNumber: row.documentNumber,
    variableSymbol: row.variableSymbol,
    issueDate: row.issueDate,
    taxableSupplyDate: row.taxableSupplyDate,
    dueDate: row.dueDate,
    currency: row.currency,
    subtotalWithoutVat: row.subtotalWithoutVat == null ? null : num(row.subtotalWithoutVat),
    totalVat: row.totalVat == null ? null : num(row.totalVat),
    totalWithVat: row.totalWithVat == null ? null : num(row.totalWithVat),
    customerId: row.customerId,
    jobId: row.jobId,
    deliveryNoteNumber: row.deliveryNoteNumber,
    summaryDeliveryNoteNumber: row.summaryDeliveryNoteNumber,
    deliveryNumber: row.deliveryNumber,
    orderNumber: row.orderNumber,
    supplierOrderNumber: row.supplierOrderNumber,
    constantSymbol: row.constantSymbol,
    specificSymbol: row.specificSymbol,
    bankAccount: row.bankAccount,
    iban: row.iban,
    bic: row.bic,
    isdocUuid: row.isdocUuid,
    mergeGroupId: row.mergeGroupId,
    primaryDocumentId: row.primaryDocumentId,
    sourcePriority: row.sourcePriority,
    parsedBy: row.parsedBy,
    notes: row.notes,
    warnings: row.warnings,
    aiConfidence: row.aiConfidence == null ? null : num(row.aiConfidence),
    aiModel: row.aiModel,
    aiExtractedAt: row.aiExtractedAt ? row.aiExtractedAt.toISOString() : null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeLine(row: BillingDocumentLine) {
  return {
    id: row.id,
    documentId: row.documentId,
    parentLineId: row.parentLineId,
    lineType: row.lineType,
    description: row.description,
    quantity: num(row.quantity),
    unit: row.unit,
    unitPriceWithoutVat: num(row.unitPriceWithoutVat),
    vatRate: row.vatRate == null ? null : num(row.vatRate),
    vatMode: row.vatMode,
    totalWithoutVat: num(row.totalWithoutVat),
    totalVat: num(row.totalVat),
    totalWithVat: num(row.totalWithVat),
    jobId: row.jobId,
    allocationType: row.allocationType,
    matchConfidence: row.matchConfidence == null ? null : num(row.matchConfidence),
    matchConfirmed: row.matchConfirmed === 1,
    approved: row.approved === 1,
    invoicedInvoiceId: row.invoicedInvoiceId,
    originalUnit: row.originalUnit,
    supplierSku: row.supplierSku,
    ean: row.ean,
    manufacturer: row.manufacturer,
    sourceLineNumber: row.sourceLineNumber,
    listPriceWithoutVat: row.listPriceWithoutVat == null ? null : num(row.listPriceWithoutVat),
    discountPercent: row.discountPercent == null ? null : num(row.discountPercent),
    priceBaseQuantity: row.priceBaseQuantity == null ? null : num(row.priceBaseQuantity),
    priceBaseUnit: row.priceBaseUnit,
    feeType: row.feeType,
    isEnvironmentalFee: row.isEnvironmentalFee === 1,
    environmentalFee: row.environmentalFee == null ? null : num(row.environmentalFee),
    recyclingFee: row.recyclingFee == null ? null : num(row.recyclingFee),
    deliveryNoteNumber: row.deliveryNoteNumber,
    orderNumber: row.orderNumber,
    supplierOrderNumber: row.supplierOrderNumber,
    warehouseState: row.warehouseState,
    confidence: row.confidence == null ? null : num(row.confidence),
    sortOrder: row.sortOrder,
  };
}

function serializeReference(row: BillingDocumentReference) {
  return {
    id: row.id,
    documentId: row.documentId,
    referenceType: row.referenceType,
    referenceNumber: row.referenceNumber,
    source: row.source,
    confidence: row.confidence == null ? null : num(row.confidence),
    matchedJobId: row.matchedJobId,
    matchedDocumentId: row.matchedDocumentId,
    matchedAttachmentId: row.matchedAttachmentId,
    matchConfidence: row.matchConfidence == null ? null : num(row.matchConfidence),
    matchConfirmed: row.matchConfirmed === 1,
    rejected: row.rejected === 1,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SerializedDocument = ReturnType<typeof serializeDocument>;
export type SerializedLine = ReturnType<typeof serializeLine>;

// ---------------------------------------------------------------------------
// Line totals
// ---------------------------------------------------------------------------

interface ParsedLineInput {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitPriceWithoutVat?: number | null;
  vatRate?: number | null;
  lineType?: string;
  // Enriched fields (ISDOC / supplier-profile aware), all optional.
  ean?: string | null;
  supplierSku?: string | null;
  manufacturer?: string | null;
  sourceLineNumber?: string | null;
  listPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  priceBaseQuantity?: number | null;
  priceBaseUnit?: string | null;
  feeType?: string | null;
  deliveryNoteNumber?: string | null;
  orderNumber?: string | null;
  supplierOrderNumber?: string | null;
  confidence?: number | null;
}

function lineValues(
  documentId: number,
  parsed: ParsedLineInput,
  sortOrder: number,
) {
  const vatMode: VatMode = parsed.vatRate != null && parsed.vatRate > 0 ? "standard" : "zero";
  const c = computeLine(
    {
      quantity: parsed.quantity ?? 1,
      unitPriceWithoutVat: parsed.unitPriceWithoutVat ?? 0,
      vatRate: parsed.vatRate ?? null,
      vatMode,
    },
    vatMode,
  );

  // Classify fees and normalize the unit. The fee type can be supplied
  // explicitly (e.g. from AI/profile) but otherwise we infer it from the text.
  const fee = classifyFee(parsed.description);
  const feeType = parsed.feeType ?? fee.feeType;
  const isEnvironmentalFee =
    feeType === "recycling" || feeType === "environmental" ? 1 : 0;
  const originalUnit = parsed.unit ?? null;
  const normalizedUnit = normalizeUnit(parsed.unit) ?? null;

  const discountPercent =
    parsed.discountPercent ??
    computeDiscountPercent(parsed.listPriceWithoutVat, parsed.unitPriceWithoutVat);

  // When the line itself IS an eco/recycling fee, record its amount in the
  // matching column so totals can be audited per fee type.
  const lineTotal = num(c.totalWithoutVat);
  const recyclingFee = feeType === "recycling" ? String(lineTotal) : null;
  const environmentalFee = feeType === "environmental" ? String(lineTotal) : null;

  return {
    documentId,
    lineType: parsed.lineType && VALID_LINE_TYPE.has(parsed.lineType) ? parsed.lineType : "material",
    description: parsed.description,
    quantity: String(c.quantity),
    unit: normalizedUnit ?? originalUnit,
    originalUnit,
    unitPriceWithoutVat: String(c.unitPriceWithoutVat),
    vatRate: c.vatRate == null ? null : String(c.vatRate),
    vatMode: c.vatMode,
    totalWithoutVat: String(c.totalWithoutVat),
    totalVat: String(c.totalVat),
    totalWithVat: String(c.totalWithVat),
    ean: parsed.ean ?? null,
    supplierSku: parsed.supplierSku ?? null,
    manufacturer: parsed.manufacturer ?? null,
    sourceLineNumber: parsed.sourceLineNumber ?? null,
    listPriceWithoutVat:
      parsed.listPriceWithoutVat != null ? String(round2(parsed.listPriceWithoutVat)) : null,
    discountPercent: discountPercent != null ? String(discountPercent) : null,
    priceBaseQuantity:
      parsed.priceBaseQuantity != null ? String(round2(parsed.priceBaseQuantity)) : null,
    priceBaseUnit: parsed.priceBaseUnit ?? null,
    feeType: feeType ?? null,
    isEnvironmentalFee,
    recyclingFee,
    environmentalFee,
    deliveryNoteNumber: parsed.deliveryNoteNumber ?? null,
    orderNumber: parsed.orderNumber ?? null,
    supplierOrderNumber: parsed.supplierOrderNumber ?? null,
    confidence: parsed.confidence != null ? String(round2(parsed.confidence)) : null,
    sortOrder,
  };
}

// ---------------------------------------------------------------------------
// Merge of the same logical invoice arriving as both PDF and ISDOC
// ---------------------------------------------------------------------------

function isPdfLike(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("pdf");
}

/**
 * Load active supplier parser profiles from the DB and shape them for
 * `recognizeSupplier`. DB profiles take precedence over the in-code seeds, so an
 * admin can refine a supplier's rules without a code change.
 */
async function loadSupplierProfiles(): Promise<SupplierProfile[]> {
  const rows = await db
    .select()
    .from(supplierParserProfilesTable)
    .where(eq(supplierParserProfilesTable.isActive, 1));
  return rows.map((r) => {
    let parsedRules: Partial<SupplierProfile["rules"]> = {};
    try {
      parsedRules = r.rulesJson ? JSON.parse(r.rulesJson) : {};
    } catch {
      parsedRules = {};
    }
    return {
      supplierName: r.supplierName ?? "",
      supplierNamePattern: r.supplierNamePattern ?? "",
      ico: r.ico,
      parserType: (r.parserType as ParserType) ?? "generic",
      rules: {
        preferIsdoc: true,
        defaultVatRate: null,
        pricePerBaseQuantity: false,
        usesDeliveryNotes: true,
        feeKeywords: [],
        ...parsedRules,
      },
    } satisfies SupplierProfile;
  });
}

// isdoc > pdf > ai > manual (higher rank wins for header/lines).
const SOURCE_PRIORITY_RANK: Record<string, number> = {
  isdoc: 4,
  pdf: 3,
  ai: 2,
  manual: 1,
};
function priorityRank(sourcePriority: string | null): number {
  return SOURCE_PRIORITY_RANK[sourcePriority ?? "manual"] ?? 1;
}

/**
 * Detect a sibling document that is the SAME logical invoice as `doc` (a PDF and
 * its ISDOC, or two scans), and merge them into one group. The higher-priority
 * source (ISDOC > PDF) becomes the primary; the other is re-pointed at it, its
 * files are moved under the primary, and it is marked status="duplicate" so it
 * drops out of the review queue. Identity is by ISDOC UUID, else supplier
 * IČO + document number.
 */
async function mergeRelatedDocumentsTx(
  tx: DbOrTx,
  doc: BillingDocument,
  parsed: ParsedDocument | null,
): Promise<void> {
  const identityConds = [];
  if (doc.isdocUuid) {
    identityConds.push(eq(billingDocumentsTable.isdocUuid, doc.isdocUuid));
  }
  if (doc.supplierIc && doc.documentNumber) {
    identityConds.push(
      and(
        eq(billingDocumentsTable.supplierIc, doc.supplierIc),
        eq(billingDocumentsTable.documentNumber, doc.documentNumber),
      ),
    );
  }
  if (!identityConds.length) return;

  const candidates = await tx
    .select()
    .from(billingDocumentsTable)
    .where(
      and(
        ne(billingDocumentsTable.id, doc.id),
        isNull(billingDocumentsTable.primaryDocumentId),
        or(...identityConds),
      ),
    );
  // Prefer a candidate that differs in format (ISDOC vs PDF) — that's the pair
  // we want to merge. Fall back to the first candidate otherwise.
  const other =
    candidates.find((c) => priorityRank(c.sourcePriority) !== priorityRank(doc.sourcePriority)) ??
    candidates[0];
  if (!other) return;

  const primary = priorityRank(other.sourcePriority) >= priorityRank(doc.sourcePriority) ? other : doc;
  const secondary = primary.id === doc.id ? other : doc;
  const groupId = other.mergeGroupId ?? doc.mergeGroupId ?? randomUUID();

  // Move the secondary's files under the primary so all files live in one place.
  await tx
    .update(billingDocumentFilesTable)
    .set({ documentId: primary.id })
    .where(eq(billingDocumentFilesTable.documentId, secondary.id));

  await tx
    .update(billingDocumentsTable)
    .set({ mergeGroupId: groupId, updatedAt: new Date() })
    .where(eq(billingDocumentsTable.id, primary.id));

  const secWarn = [
    secondary.warnings,
    `Sloučeno s dokladem #${primary.id} (stejná faktura ve formátu ${
      priorityRank(primary.sourcePriority) >= 4 ? "ISDOC" : "PDF"
    }).`,
  ]
    .filter(Boolean)
    .join("\n");
  await tx
    .update(billingDocumentsTable)
    .set({
      mergeGroupId: groupId,
      primaryDocumentId: primary.id,
      status: "duplicate",
      warnings: secWarn,
      updatedAt: new Date(),
    })
    .where(eq(billingDocumentsTable.id, secondary.id));

  void parsed;
}

// ---------------------------------------------------------------------------
// Create from upload
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  objectPath: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  sha256: string;
  source: string;
  sourceRef?: string | null;
  docType?: string;
  jobId?: number | null;
  customerId?: number | null;
}

/**
 * Persist a new document (and any ISDOC-parsed header/lines), then enqueue an
 * extraction job. ISDOC parsing happens inline because it is fast and
 * deterministic; everything else is left to the queue worker / manual review.
 */
export async function createDocument(
  input: CreateDocumentInput,
  buffer: Buffer | null,
  actor: Actor,
): Promise<SerializedDocument> {
  let parsed: ParsedDocument | null = null;
  const warnLines: string[] = [];
  const isIsdoc = buffer != null && isParsableIsdoc(input.contentType, input.fileName);
  if (buffer && isIsdoc) {
    try {
      parsed = parseIsdocBuffer(buffer, input.fileName);
      warnLines.push(
        "Hlavička a položky předvyplněny z ISDOC. Zkontrolujte před schválením.",
      );
    } catch (err) {
      warnLines.push(
        `Automatické zpracování ISDOC selhalo: ${
          err instanceof Error ? err.message : "neznámá chyba"
        }`,
      );
    }
  }

  const docType =
    input.docType && VALID_DOC_TYPE.has(input.docType) ? input.docType : "invoice";

  // Provenance: ISDOC wins over a visual PDF wins over AI wins over manual.
  const parsedBy = parsed ? "isdoc" : null;
  const sourcePriority = parsed ? "isdoc" : isPdfLike(input.contentType) ? "pdf" : "manual";

  // A delivery note (`delivery_note`) is not a payment document: monetary totals
  // are normally absent, so payment-oriented reconciliation/warnings would only
  // add noise. Keep this consistent with the AI path and the frontend's
  // `isPaymentDocument` helper.
  const isPaymentDoc = docType !== "delivery_note";

  // Sum-of-lines vs. document total reconciliation (warn → stays needs_review).
  // Skipped for delivery notes where a document total mismatch is expected.
  if (isPaymentDoc && parsed && parsed.lines.length && parsed.subtotalWithoutVat != null) {
    const linesSum = round2(
      parsed.lines.reduce((a, l) => a + (l.totalWithoutVat ?? 0), 0),
    );
    if (Math.abs(linesSum - round2(parsed.subtotalWithoutVat)) > 0.5) {
      warnLines.push(
        `Součet položek (${linesSum}) se liší od základu daně dokladu (${round2(
          parsed.subtotalWithoutVat,
        )}). Zkontrolujte položky.`,
      );
    }
  }

  // Recognize the supplier (DB profiles override the in-code seeds) so its rules
  // — e.g. a default VAT rate — can fill gaps the raw document left blank.
  const supplierProfiles = await loadSupplierProfiles();
  const profile = recognizeSupplier(
    parsed?.supplierName ?? null,
    parsed?.supplierIc ?? null,
    supplierProfiles,
  );
  const defaultVatRate = profile.rules.defaultVatRate;

  const id = await db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(billingDocumentsTable)
      .values({
        status: "needs_review",
        docType,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        objectPath: input.objectPath,
        fileName: input.fileName,
        contentType: input.contentType,
        fileSize: input.fileSize,
        sha256: input.sha256,
        supplierName: parsed?.supplierName ?? null,
        supplierIc: parsed?.supplierIc ?? null,
        supplierDic: parsed?.supplierDic ?? null,
        supplierAddress: parsed?.supplierAddress ?? null,
        documentNumber: parsed?.documentNumber ?? null,
        variableSymbol: parsed?.variableSymbol ?? null,
        issueDate: parsed?.issueDate ?? null,
        taxableSupplyDate: parsed?.taxableSupplyDate ?? null,
        dueDate: parsed?.dueDate ?? null,
        currency: parsed?.currency ?? "CZK",
        subtotalWithoutVat:
          parsed?.subtotalWithoutVat != null ? String(parsed.subtotalWithoutVat) : null,
        totalVat: parsed?.totalVat != null ? String(parsed.totalVat) : null,
        totalWithVat: parsed?.totalWithVat != null ? String(parsed.totalWithVat) : null,
        deliveryNoteNumber: parsed?.deliveryNoteNumber ?? null,
        orderNumber: parsed?.orderNumber ?? null,
        constantSymbol: parsed?.constantSymbol ?? null,
        specificSymbol: parsed?.specificSymbol ?? null,
        bankAccount: parsed?.bankAccount ?? null,
        iban: parsed?.iban ?? null,
        bic: parsed?.bic ?? null,
        isdocUuid: parsed?.isdocUuid ?? null,
        sourcePriority,
        parsedBy,
        jobId: input.jobId ?? null,
        customerId: input.customerId ?? null,
        warnings: warnLines.length ? warnLines.join("\n") : null,
        createdByUserId: actor.userId,
      })
      .returning();

    if (parsed && parsed.lines.length) {
      await tx.insert(billingDocumentLinesTable).values(
        parsed.lines.map((l, idx) =>
          lineValues(
            doc.id,
            {
              description: l.description,
              quantity: l.quantity,
              unit: l.unit,
              unitPriceWithoutVat: l.unitPriceWithoutVat,
              vatRate: l.vatRate ?? defaultVatRate,
              ean: l.ean,
              supplierSku: l.supplierSku,
              sourceLineNumber: l.sourceLineNumber,
            },
            idx,
          ),
        ),
      );
    }

    // Record the original file in the per-document files table (object path only).
    await tx.insert(billingDocumentFilesTable).values({
      documentId: doc.id,
      role: parsed ? "structured_isdoc" : "visual_pdf",
      originalFileName: input.fileName,
      mimeType: input.contentType,
      objectPath: input.objectPath,
      sha256Hash: input.sha256,
      sizeBytes: input.fileSize,
    });

    // Persist references parsed from the ISDOC header (suggestions only).
    const refRows: (typeof billingDocumentReferencesTable.$inferInsert)[] = [];
    if (parsed?.deliveryNoteNumber) {
      refRows.push({
        documentId: doc.id,
        referenceType: "delivery_note",
        referenceNumber: parsed.deliveryNoteNumber,
        source: "isdoc",
        confidence: "1.00",
      });
    }
    if (parsed?.orderNumber) {
      refRows.push({
        documentId: doc.id,
        referenceType: "order",
        referenceNumber: parsed.orderNumber,
        source: "isdoc",
        confidence: "1.00",
      });
    }
    if (refRows.length) await tx.insert(billingDocumentReferencesTable).values(refRows);

    // Merge a matching ISDOC↔PDF pair into one logical document.
    await mergeRelatedDocumentsTx(tx, doc, parsed);

    await tx.insert(extractionJobsTable).values({ documentId: doc.id });

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "create",
      entityType: "billing_documents",
      entityId: doc.id,
      summary: `Nákladový doklad nahrán: ${input.fileName}`,
      method: "POST",
      path: "/billing/documents",
    });

    return doc.id;
  });

  const detail = await getDocument(id);
  if (!detail) throw appError(500, "Doklad se nepodařilo načíst.");
  return detail.document;
}

// ---------------------------------------------------------------------------
// Ingest a raw file buffer (shared by the upload route and the e-mail importer)
// ---------------------------------------------------------------------------

export interface IngestFileInput {
  fileName: string;
  contentType: string;
  source: string;
  sourceRef?: string | null;
  docType?: string;
  jobId?: number | null;
  customerId?: number | null;
}

export type IngestFileResult =
  | { status: "created"; document: SerializedDocument }
  | { status: "duplicate"; duplicates: DuplicateMatch[] };

/**
 * Store a file buffer in object storage and create a cost document from it,
 * skipping when its exact content hash already exists (unless `force`). Centralises
 * the dedup → store → createDocument flow so the manual upload route and the
 * automated e-mail importer behave identically (same dedup, same extraction queue).
 */
export async function ingestFile(
  buffer: Buffer,
  input: IngestFileInput,
  actor: Actor,
  force = false,
): Promise<IngestFileResult> {
  const hash = sha256Of(buffer);

  if (!force) {
    const duplicates = await findDuplicates({ sha256: hash });
    if (duplicates.length) {
      return { status: "duplicate", duplicates };
    }
  }

  const objectPath = `/objects/cost-documents/${randomUUID()}`;
  await objectStorage.putPrivateObject(objectPath, buffer, input.contentType);

  const document = await createDocument(
    {
      objectPath,
      fileName: input.fileName,
      contentType: input.contentType,
      fileSize: buffer.length,
      sha256: hash,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      docType: input.docType,
      jobId: input.jobId ?? null,
      customerId: input.customerId ?? null,
    },
    buffer,
    actor,
  );
  return { status: "created", document };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface DocumentFilters {
  status?: string;
  supplierIc?: string;
  jobId?: number;
  customerId?: number;
  /** Restrict to documents that were prefilled by AI extraction. */
  aiOnly?: boolean;
  /** `confidence_asc` = lowest AI confidence first (review-queue order). */
  sort?: string;
}

export async function listDocuments(filters: DocumentFilters) {
  const conds = [];
  if (filters.status) conds.push(eq(billingDocumentsTable.status, filters.status));
  if (filters.supplierIc)
    conds.push(eq(billingDocumentsTable.supplierIc, filters.supplierIc));
  if (filters.jobId != null) conds.push(eq(billingDocumentsTable.jobId, filters.jobId));
  if (filters.customerId != null)
    conds.push(eq(billingDocumentsTable.customerId, filters.customerId));
  if (filters.aiOnly) conds.push(isNotNull(billingDocumentsTable.aiExtractedAt));

  // confidence_asc surfaces the riskiest (lowest-confidence) suggestions first;
  // Postgres ASC places NULL confidence last, then ties broken by newest first.
  const orderBy =
    filters.sort === "confidence_asc"
      ? [asc(billingDocumentsTable.aiConfidence), desc(billingDocumentsTable.createdAt)]
      : [desc(billingDocumentsTable.createdAt)];

  const rows = await db
    .select()
    .from(billingDocumentsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...orderBy);
  return rows.map(serializeDocument);
}

export async function getDocument(id: number) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) return null;
  const lines = await db
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, id))
    .orderBy(billingDocumentLinesTable.sortOrder, billingDocumentLinesTable.id);

  const duplicates = await findDuplicates({
    sha256: doc.sha256,
    supplierIc: doc.supplierIc,
    supplierName: doc.supplierName,
    documentNumber: doc.documentNumber,
    variableSymbol: doc.variableSymbol,
    issueDate: doc.issueDate,
    totalWithVat: doc.totalWithVat == null ? null : num(doc.totalWithVat),
    excludeId: doc.id,
  });

  const references = await db
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, id))
    .orderBy(billingDocumentReferencesTable.id);

  const files = await db
    .select()
    .from(billingDocumentFilesTable)
    .where(eq(billingDocumentFilesTable.documentId, id))
    .orderBy(billingDocumentFilesTable.id);

  // Job materials whose price was propagated from this document (auto-links).
  const linkedMaterials = await db
    .select({
      id: materialsTable.id,
      jobId: materialsTable.jobId,
      name: materialsTable.name,
      quantity: materialsTable.quantity,
      unit: materialsTable.unit,
      pricePerUnit: materialsTable.pricePerUnit,
      priceSource: materialsTable.priceSource,
      priceConfidence: materialsTable.priceConfidence,
      priceSourceLineId: materialsTable.priceSourceLineId,
      invoicedInvoiceId: materialsTable.invoicedInvoiceId,
    })
    .from(materialsTable)
    .where(eq(materialsTable.priceSourceDocumentId, id))
    .orderBy(materialsTable.id);

  return {
    document: serializeDocument(doc),
    lines: lines.map(serializeLine),
    duplicates,
    references: references.map(serializeReference),
    linkedMaterials: linkedMaterials.map((m) => ({
      id: m.id,
      jobId: m.jobId,
      name: m.name,
      quantity: m.quantity != null ? Number(m.quantity) : null,
      unit: m.unit,
      pricePerUnit: m.pricePerUnit != null ? Number(m.pricePerUnit) : null,
      priceSource: m.priceSource,
      priceConfidence: m.priceConfidence != null ? Number(m.priceConfidence) : null,
      priceSourceLineId: m.priceSourceLineId,
      invoicedInvoiceId: m.invoicedInvoiceId,
    })),
    files: files.map((f) => ({
      id: f.id,
      documentId: f.documentId,
      role: f.role,
      originalFileName: f.originalFileName,
      mimeType: f.mimeType,
      objectPath: f.objectPath,
      sizeBytes: f.sizeBytes,
      createdAt: f.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// References: list / add / match / confirm / change / reject
// ---------------------------------------------------------------------------

const VALID_REFERENCE_TYPE = new Set([
  "delivery_note",
  "summary_delivery_note",
  "delivery",
  "order",
  "supplier_order",
  "project",
  "invoice",
  "credit_note",
  "other",
]);

export interface AddReferenceInput {
  referenceType: string;
  referenceNumber: string;
  source?: string;
  confidence?: number | null;
}

export async function addReference(documentId: number, input: AddReferenceInput) {
  const [doc] = await db
    .select({ id: billingDocumentsTable.id })
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  const referenceType = VALID_REFERENCE_TYPE.has(input.referenceType)
    ? input.referenceType
    : "other";
  const refNum = input.referenceNumber.trim();
  if (!refNum) throw appError(400, "Číslo reference je povinné.");
  await db.insert(billingDocumentReferencesTable).values({
    documentId,
    referenceType,
    referenceNumber: refNum,
    source: input.source ?? "manual",
    confidence: input.confidence != null ? String(round2(input.confidence)) : null,
  });
  return getDocument(documentId);
}

export interface ReferenceUpdateInput {
  referenceType?: string | null;
  referenceNumber?: string | null;
  matchedJobId?: number | null;
  matchedDocumentId?: number | null;
  matchedAttachmentId?: number | null;
  matchConfirmed?: boolean | null;
  rejected?: boolean | null;
  notes?: string | null;
}

/** Confirm / change / reject a reference link (admin action; never automatic). */
export async function updateReference(
  documentId: number,
  referenceId: number,
  input: ReferenceUpdateInput,
) {
  const [ref] = await db
    .select()
    .from(billingDocumentReferencesTable)
    .where(
      and(
        eq(billingDocumentReferencesTable.id, referenceId),
        eq(billingDocumentReferencesTable.documentId, documentId),
      ),
    );
  if (!ref) throw appError(404, "Reference nenalezena.");

  const patch: Partial<typeof billingDocumentReferencesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (
    input.referenceType !== undefined &&
    input.referenceType &&
    VALID_REFERENCE_TYPE.has(input.referenceType)
  )
    patch.referenceType = input.referenceType;
  if (input.referenceNumber !== undefined && input.referenceNumber)
    patch.referenceNumber = input.referenceNumber.trim();
  if (input.matchedJobId !== undefined) patch.matchedJobId = input.matchedJobId;
  if (input.matchedDocumentId !== undefined)
    patch.matchedDocumentId = input.matchedDocumentId;
  if (input.matchedAttachmentId !== undefined)
    patch.matchedAttachmentId = input.matchedAttachmentId;
  if (input.matchConfirmed !== undefined && input.matchConfirmed != null)
    patch.matchConfirmed = input.matchConfirmed ? 1 : 0;
  if (input.rejected !== undefined && input.rejected != null)
    patch.rejected = input.rejected ? 1 : 0;
  if (input.notes !== undefined) patch.notes = input.notes;

  await db
    .update(billingDocumentReferencesTable)
    .set(patch)
    .where(eq(billingDocumentReferencesTable.id, referenceId));
  return getDocument(documentId);
}

export async function deleteReference(documentId: number, referenceId: number) {
  const [ref] = await db
    .select({ id: billingDocumentReferencesTable.id })
    .from(billingDocumentReferencesTable)
    .where(
      and(
        eq(billingDocumentReferencesTable.id, referenceId),
        eq(billingDocumentReferencesTable.documentId, documentId),
      ),
    );
  if (!ref) throw appError(404, "Reference nenalezena.");
  await db
    .delete(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.id, referenceId));
  return getDocument(documentId);
}

/**
 * Score every reference of a document against open jobs and sibling cost
 * documents, writing the best job suggestion onto each reference (suggestion
 * only — `matchConfirmed` stays 0). Returns the refreshed document. Also returns
 * ranked candidates so the UI can offer alternatives.
 */
export async function matchDocumentReferences(documentId: number) {
  const cfg = await resolveDocumentLinkingConfig();
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");

  const refs = await db
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, documentId));

  const jobs = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      notes: jobsTable.notes,
      address: jobsTable.address,
      clientSite: jobsTable.clientSite,
      customerId: jobsTable.customerId,
    })
    .from(jobsTable);

  const candidatesByRef: Record<
    number,
    { jobId: number; jobTitle: string | null; score: number; strength: string; reasons: string[] }[]
  > = {};

  for (const ref of refs) {
    if (ref.matchConfirmed === 1 || ref.rejected === 1) continue;
    const ranked = rankJobsForReference(ref.referenceNumber, jobs, {
      documentCustomerId: doc.customerId,
    });
    candidatesByRef[ref.id] = ranked.map((r) => ({
      jobId: r.job.id,
      jobTitle: r.job.title ?? null,
      score: r.match.score,
      strength: r.match.strength,
      reasons: r.match.reasons,
    }));
    const best = ranked[0];
    if (best && best.match.score > 0) {
      // Only attach a job suggestion when auto-linking is on and the score
      // clears the link threshold; only auto-confirm when explicitly enabled
      // and the score clears the (higher) confirm threshold. Otherwise the
      // suggestion is recorded as confidence only, leaving the link for an
      // admin to confirm.
      const linkable = cfg.autoLinkEnabled && best.match.score >= cfg.autoLinkMinScore;
      const confirmable =
        linkable &&
        cfg.autoConfirmEnabled &&
        best.match.score >= cfg.autoConfirmMinScore;
      await db
        .update(billingDocumentReferencesTable)
        .set({
          matchedJobId: linkable ? best.job.id : null,
          matchConfidence: String(best.match.score),
          ...(confirmable ? { matchConfirmed: 1 } : {}),
          updatedAt: new Date(),
        })
        .where(eq(billingDocumentReferencesTable.id, ref.id));
    }
  }

  const detail = await getDocument(documentId);
  return { ...detail, candidatesByRef };
}

/**
 * Find sibling cost documents (delivery notes ↔ invoices) that score as a
 * likely match for this document. Suggestion only — surfaced in the UI so an
 * admin can link them. Never writes.
 */
export async function suggestDocumentMatches(documentId: number) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");

  const refs = await db
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, documentId));

  const others = await db
    .select()
    .from(billingDocumentsTable)
    .where(
      and(
        ne(billingDocumentsTable.id, documentId),
        isNull(billingDocumentsTable.primaryDocumentId),
      ),
    );

  const toMatchable = (
    d: BillingDocument,
    docRefs: BillingDocumentReference[],
  ): MatchableDocument => ({
    id: d.id,
    supplierIc: d.supplierIc,
    documentNumber: d.documentNumber,
    deliveryNoteNumber: d.deliveryNoteNumber,
    orderNumber: d.orderNumber,
    totalWithoutVat: d.subtotalWithoutVat == null ? null : num(d.subtotalWithoutVat),
    totalWithVat: d.totalWithVat == null ? null : num(d.totalWithVat),
    issueDate: d.issueDate,
    references: docRefs.map((r) => ({
      referenceType: r.referenceType,
      referenceNumber: r.referenceNumber,
    })),
  });

  const self = toMatchable(doc, refs);
  const isInvoice = doc.docType === "invoice" || doc.docType === "credit_note";

  const results: {
    documentId: number;
    documentNumber: string | null;
    docType: string;
    score: number;
    strength: string;
    reasons: string[];
  }[] = [];

  for (const other of others) {
    const otherRefs = await db
      .select()
      .from(billingDocumentReferencesTable)
      .where(eq(billingDocumentReferencesTable.documentId, other.id));
    const otherM = toMatchable(other, otherRefs);
    // Score delivery-note → invoice in the correct direction.
    const scored = isInvoice
      ? scoreDeliveryNoteToInvoice(otherM, self)
      : scoreDeliveryNoteToInvoice(self, otherM);
    if (scored.score > 0) {
      results.push({
        documentId: other.id,
        documentNumber: other.documentNumber,
        docType: other.docType,
        score: scored.score,
        strength: scored.strength,
        reasons: scored.reasons,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Update header
// ---------------------------------------------------------------------------

export interface UpdateDocumentInput {
  docType?: string | null;
  supplierName?: string | null;
  supplierIc?: string | null;
  supplierDic?: string | null;
  supplierAddress?: string | null;
  documentNumber?: string | null;
  variableSymbol?: string | null;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  subtotalWithoutVat?: number | null;
  totalVat?: number | null;
  totalWithVat?: number | null;
  customerId?: number | null;
  jobId?: number | null;
  notes?: string | null;
}

export async function updateDocument(id: number, input: UpdateDocumentInput) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (doc.status === "approved") {
    throw appError(409, "Schválený doklad nelze upravovat. Nejprve zrušte schválení.");
  }

  const patch: Partial<typeof billingDocumentsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.docType !== undefined && input.docType && VALID_DOC_TYPE.has(input.docType))
    patch.docType = input.docType;
  if (input.supplierName !== undefined) patch.supplierName = input.supplierName;
  if (input.supplierIc !== undefined) patch.supplierIc = input.supplierIc;
  if (input.supplierDic !== undefined) patch.supplierDic = input.supplierDic;
  if (input.supplierAddress !== undefined) patch.supplierAddress = input.supplierAddress;
  if (input.documentNumber !== undefined) patch.documentNumber = input.documentNumber;
  if (input.variableSymbol !== undefined) patch.variableSymbol = input.variableSymbol;
  if (input.issueDate !== undefined) patch.issueDate = input.issueDate;
  if (input.taxableSupplyDate !== undefined)
    patch.taxableSupplyDate = input.taxableSupplyDate;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.currency !== undefined && input.currency) patch.currency = input.currency;
  if (input.subtotalWithoutVat !== undefined)
    patch.subtotalWithoutVat =
      input.subtotalWithoutVat == null ? null : String(round2(input.subtotalWithoutVat));
  if (input.totalVat !== undefined)
    patch.totalVat = input.totalVat == null ? null : String(round2(input.totalVat));
  if (input.totalWithVat !== undefined)
    patch.totalWithVat =
      input.totalWithVat == null ? null : String(round2(input.totalWithVat));
  if (input.customerId !== undefined) patch.customerId = input.customerId;
  if (input.jobId !== undefined) patch.jobId = input.jobId;
  if (input.notes !== undefined) patch.notes = input.notes;

  await db.update(billingDocumentsTable).set(patch).where(eq(billingDocumentsTable.id, id));
  return getDocument(id);
}

// ---------------------------------------------------------------------------
// Line operations (matching / splitting)
// ---------------------------------------------------------------------------

export interface LineUpdateInput {
  lineType?: string | null;
  description?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPriceWithoutVat?: number | null;
  vatRate?: number | null;
  jobId?: number | null;
  allocationType?: string | null;
  matchConfirmed?: boolean | null;
  approved?: boolean | null;
}

async function recomputeLineTotals(
  tx: DbOrTx,
  line: BillingDocumentLine,
): Promise<void> {
  const vals = lineValues(
    line.documentId,
    {
      description: line.description,
      quantity: num(line.quantity),
      unit: line.unit,
      unitPriceWithoutVat: num(line.unitPriceWithoutVat),
      vatRate: line.vatRate == null ? null : num(line.vatRate),
      lineType: line.lineType,
    },
    line.sortOrder,
  );
  await tx
    .update(billingDocumentLinesTable)
    .set({
      totalWithoutVat: vals.totalWithoutVat,
      totalVat: vals.totalVat,
      totalWithVat: vals.totalWithVat,
      vatMode: vals.vatMode,
      vatRate: vals.vatRate,
      updatedAt: new Date(),
    })
    .where(eq(billingDocumentLinesTable.id, line.id));
}

export async function updateLine(
  documentId: number,
  lineId: number,
  input: LineUpdateInput,
  actor: Actor = SYSTEM_ACTOR,
) {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(billingDocumentLinesTable)
      .where(
        and(
          eq(billingDocumentLinesTable.id, lineId),
          eq(billingDocumentLinesTable.documentId, documentId),
        ),
      );
    if (!line) throw appError(404, "Položka nenalezena.");
    if (line.invoicedInvoiceId != null) {
      throw appError(409, "Položka je již na faktuře a nelze ji měnit.");
    }

    const patch: Partial<typeof billingDocumentLinesTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    let recompute = false;
    if (input.lineType !== undefined && input.lineType && VALID_LINE_TYPE.has(input.lineType))
      patch.lineType = input.lineType;
    if (input.description !== undefined && input.description)
      patch.description = input.description;
    if (input.quantity !== undefined) {
      patch.quantity = String(round2(num(input.quantity)));
      recompute = true;
    }
    if (input.unit !== undefined) patch.unit = input.unit;
    if (input.unitPriceWithoutVat !== undefined) {
      patch.unitPriceWithoutVat = String(round2(num(input.unitPriceWithoutVat)));
      recompute = true;
    }
    if (input.vatRate !== undefined) {
      patch.vatRate = input.vatRate == null ? null : String(round2(num(input.vatRate)));
      recompute = true;
    }
    if (input.jobId !== undefined) patch.jobId = input.jobId;
    if (input.allocationType !== undefined && input.allocationType && VALID_ALLOC.has(input.allocationType))
      patch.allocationType = input.allocationType;
    if (input.matchConfirmed !== undefined && input.matchConfirmed != null)
      patch.matchConfirmed = input.matchConfirmed ? 1 : 0;
    if (input.approved !== undefined && input.approved != null)
      patch.approved = input.approved ? 1 : 0;

    await tx
      .update(billingDocumentLinesTable)
      .set(patch)
      .where(eq(billingDocumentLinesTable.id, lineId));

    if (recompute) {
      const [updated] = await tx
        .select()
        .from(billingDocumentLinesTable)
        .where(eq(billingDocumentLinesTable.id, lineId));
      await recomputeLineTotals(tx, updated);
    }
    // Keep the job's materials in sync when editing a line of an approved doc.
    await syncJobMaterialsForDocument(tx, documentId, actor);
    // The line id persists across an edit, so re-reconciling the document's stock
    // receipts updates this line's movement (quantity / allocation change, or
    // reverses it if it stopped being a stock line).
    await reconcileDocumentStockMovements(tx, documentId, actor);
    return undefined;
  }).then(() => getDocument(documentId));
}

export interface SplitPart {
  quantity: number;
  jobId?: number | null;
  allocationType?: string | null;
}

/**
 * Split a line into N sibling lines by quantity. The original line is removed
 * and replaced by the parts (independent sibling lines, each with its own
 * quantity / job assignment). The parts' quantities must sum to the original
 * quantity (within a haléř) so no value is invented or lost.
 *
 * The parts deliberately carry `parentLineId = null`: the original line is
 * deleted in this same transaction, so referencing its id would violate the
 * `parent_line_id` FK. (Provenance to a deleted row is impossible anyway.)
 */
export async function splitLine(
  documentId: number,
  lineId: number,
  parts: SplitPart[],
  actor: Actor = SYSTEM_ACTOR,
) {
  if (parts.length < 2) throw appError(400, "Rozdělení vyžaduje alespoň dvě části.");
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(billingDocumentLinesTable)
      .where(
        and(
          eq(billingDocumentLinesTable.id, lineId),
          eq(billingDocumentLinesTable.documentId, documentId),
        ),
      );
    if (!line) throw appError(404, "Položka nenalezena.");
    if (line.invoicedInvoiceId != null) {
      throw appError(409, "Položka je již na faktuře a nelze ji rozdělit.");
    }
    if (line.parentLineId != null) {
      throw appError(409, "Rozdělenou položku nelze dále dělit.");
    }

    const origQty = num(line.quantity);
    const sumParts = round2(parts.reduce((a, p) => a + num(p.quantity), 0));
    if (Math.abs(sumParts - round2(origQty)) > 0.01) {
      throw appError(
        400,
        `Součet množství částí (${sumParts}) se musí rovnat původnímu množství (${round2(origQty)}).`,
      );
    }

    const unitPrice = num(line.unitPriceWithoutVat);
    const vatRate = line.vatRate == null ? null : num(line.vatRate);
    const baseSort = line.sortOrder;

    // The original line id is about to disappear, so the reconciles below (which
    // key off the document's *current* line ids) can no longer see this line's
    // movements. Reverse them explicitly first, or they orphan permanently:
    //  - the line's own stock receipt (billing_document_line), and
    //  - any propagated job material's stock issue (material) before its row is
    //    deleted.
    await reconcileSourceMovements(tx, "billing_document_line", lineId, null, actor);
    const orphanMaterials = await tx
      .select({ id: materialsTable.id })
      .from(materialsTable)
      .where(
        and(
          eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
          eq(materialsTable.sourceId, lineId),
        ),
      );
    for (const m of orphanMaterials) {
      await reconcileSourceMovements(tx, "material", m.id, null, actor);
    }

    // Delete the original, insert the parts in its place.
    await tx
      .delete(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.id, lineId));
    await tx.delete(materialsTable).where(
      and(
        eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
        eq(materialsTable.sourceId, lineId),
      ),
    );

    const values = parts.map((p, idx) => {
      const vals = lineValues(
        documentId,
        {
          description: line.description,
          quantity: num(p.quantity),
          unit: line.unit,
          unitPriceWithoutVat: unitPrice,
          vatRate,
          lineType: line.lineType,
        },
        baseSort,
      );
      return {
        ...vals,
        parentLineId: null,
        jobId: p.jobId ?? line.jobId ?? null,
        allocationType:
          p.allocationType && VALID_ALLOC.has(p.allocationType)
            ? p.allocationType
            : line.allocationType,
        sortOrder: baseSort + idx,
      };
    });
    await tx.insert(billingDocumentLinesTable).values(values);
    // The original line was replaced; re-sync sourced materials for the doc and
    // reconcile the document's stock receipts so the new part lines naskladní
    // (the old line's movements were already reversed above).
    await syncJobMaterialsForDocument(tx, documentId, actor);
    await reconcileDocumentStockMovements(tx, documentId, actor);
    return undefined;
  }).then(() => getDocument(documentId));
}

// ---------------------------------------------------------------------------
// Approved document → job materials propagation
// ---------------------------------------------------------------------------

const MATERIAL_SOURCE_TYPE = "billing_document_line";

/**
 * Mirror an APPROVED cost document's material lines into the linked jobs'
 * `materials` lists (quantity + purchase price bez DPH), so účtenky / dodací
 * listy automatically populate the job detail for later invoicing.
 *
 * Idempotent: each propagated material row is keyed back to its source
 * `billing_document_line` via (sourceType, sourceId), so re-running updates the
 * same row in place instead of duplicating (preserving its `done`/`sortOrder`).
 * The set is reconciled every call: lines that are no longer eligible (line
 * removed, lost its job, became a fee, allocated to stock, or the whole
 * document left "approved") have their sourced material removed.
 *
 * Skipped: fee lines, non-material line types, and stock-allocated lines (those
 * go to the warehouse, not a job). A line's job is its own `jobId`, falling back
 * to the document's header `jobId`, and finally — when the document has no header
 * job — to a SINGLE confirmed reference's `matchedJobId` (a confirmed reference
 * is a real link, so the document's own lines that match no existing material are
 * still auto-created on that job). Ambiguous links (several distinct
 * confirmed-reference jobs) get no fallback, mirroring the target set of
 * {@link propagateInvoicePricesToJobMaterials}. Must run inside the caller's
 * transaction.
 */
export async function syncJobMaterialsForDocument(
  tx: DbOrTx,
  documentId: number,
  actor: Actor = SYSTEM_ACTOR,
  opts: { excludeSourceLineIds?: Set<number> } = {},
): Promise<void> {
  const exclude = opts.excludeSourceLineIds ?? new Set<number>();
  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) return;
  // An invoice/credit note prices its own lines authoritatively; a delivery note
  // (or other) only provisionally — with no price it is "awaiting invoice".
  const isInvoiceDoc = doc.docType === "invoice" || doc.docType === "credit_note";

  // Fallback job for lines that carry no own `jobId` and a document with no
  // header `jobId`: a SINGLE confirmed reference (matchConfirmed=1) is the link,
  // so the document's own unmatched lines are still created on that job. Several
  // distinct confirmed-reference jobs are ambiguous → no fallback (skip), which
  // matches the target-job set used by propagateInvoicePricesToJobMaterials.
  let fallbackJobId: number | null = doc.jobId ?? null;
  if (fallbackJobId == null) {
    const refs = await tx
      .select()
      .from(billingDocumentReferencesTable)
      .where(eq(billingDocumentReferencesTable.documentId, documentId));
    const refJobIds = new Set<number>();
    for (const ref of refs) {
      if (ref.matchConfirmed === 1 && ref.matchedJobId != null) {
        refJobIds.add(ref.matchedJobId);
      }
    }
    if (refJobIds.size === 1) {
      fallbackJobId = refJobIds.values().next().value ?? null;
    }
  }

  const lines = await tx
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, documentId));
  const lineIds = lines.map((l) => l.id);

  const existing = lineIds.length
    ? await tx
        .select()
        .from(materialsTable)
        .where(
          and(
            eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
            inArray(materialsTable.sourceId, lineIds),
          ),
        )
    : [];
  const desired = new Set<number>();
  const affectedMaterialIds = new Set<number>();

  // Only an approved document propagates; otherwise the loop is skipped and any
  // previously-sourced materials below are reconciled away.
  if (doc.status === "approved") {
    for (const line of lines) {
      if (line.feeType) continue;
      if (line.lineType !== "material") continue;
      if (line.allocationType === "stock") continue;
      // Skip lines whose price was already propagated onto a pre-existing
      // (delivery-note) material — creating a second material here would
      // duplicate the item and double-issue stock.
      if (exclude.has(line.id)) continue;
      const jobId = line.jobId ?? fallbackJobId;
      if (jobId == null) continue;

      desired.add(line.id);
      // `unit_price_without_vat` is NOT NULL (default 0), so a delivery note
      // with no price arrives as 0 — treat 0 as "no price yet". An invoice
      // prices authoritatively (even a genuine 0).
      const priceNum =
        line.unitPriceWithoutVat == null ? 0 : num(line.unitPriceWithoutVat);
      const hasPrice = priceNum > 0;
      const priceSource = isInvoiceDoc
        ? "invoice"
        : hasPrice
          ? "delivery_note"
          : "awaiting_invoice";
      const values = {
        jobId,
        name: line.description,
        quantity:
          line.quantity == null ? null : String(round2(num(line.quantity))),
        unit: line.unit ?? null,
        pricePerUnit:
          isInvoiceDoc || hasPrice ? String(round2(priceNum)) : null,
        priceSource,
        priceSourceDocumentId: documentId,
        priceSourceLineId: line.id,
        priceSourceSupplierName: doc.supplierName ?? null,
        priceSourceDate: doc.issueDate ? new Date(doc.issueDate) : null,
        priceConfidence: isInvoiceDoc ? "1.00" : null,
      };
      // Atomic upsert keyed on the partial unique index
      // (source_type, source_id) WHERE source_type IS NOT NULL, so concurrent
      // approvals/edits of the same line converge instead of one failing the
      // unique constraint with a 500.
      const [upserted] = await tx
        .insert(materialsTable)
        .values({
          ...values,
          sourceType: MATERIAL_SOURCE_TYPE,
          sourceId: line.id,
        })
        .onConflictDoUpdate({
          target: [materialsTable.sourceType, materialsTable.sourceId],
          targetWhere: isNotNull(materialsTable.sourceType),
          set: values,
        })
        .returning({ id: materialsTable.id });
      if (upserted) affectedMaterialIds.add(upserted.id);
    }
  }

  const toDelete = existing
    .filter((m) => m.sourceId == null || !desired.has(m.sourceId))
    .map((m) => m.id);
  if (toDelete.length) {
    // Reverse the stock issue of each propagated material before removing it,
    // then drop the material rows.
    for (const materialId of toDelete) {
      await reconcileSourceMovements(tx, "material", materialId, null, actor);
    }
    await tx.delete(materialsTable).where(inArray(materialsTable.id, toDelete));
  }

  // Reconcile the stock issue (výdej) for every propagated material that still
  // exists — a job material that matches a warehouse item draws it down.
  for (const materialId of affectedMaterialIds) {
    const [m] = await tx
      .select()
      .from(materialsTable)
      .where(eq(materialsTable.id, materialId));
    await reconcileMaterialStockMovement(tx, m ?? null, actor);
  }
}

// ---------------------------------------------------------------------------
// Approved invoice → fill price on pre-existing (delivery-note) job materials
// ---------------------------------------------------------------------------

export interface PricePropagationResult {
  /** Invoice line IDs that filled an existing material (must be skipped by sync
   * so they don't also create a duplicate material). */
  consumedLineIds: Set<number>;
  /** How many existing materials had their price filled/refreshed. */
  filled: number;
}

/**
 * When an APPROVED invoice / credit note is *confirmed-linked* to a job, fill
 * the purchase price onto the job's already-existing materials (typically
 * created earlier from a delivery note with no price — "čeká na fakturu").
 *
 * Matching: each invoice material line is matched against the existing
 * materials of the confirmed job(s) using `scoreLineMatch` on the material's
 * own source document line (so EAN/SKU carry through), requiring at least the
 * configured auto-link score. A mere partial name similarity scores below that
 * threshold and is therefore NEVER applied — it stays a suggestion.
 *
 * Only updates (never inserts) and is idempotent: re-running writes the same
 * values; an existing material already priced from a *different* invoice line is
 * left untouched. Returns the set of invoice line IDs that were consumed so the
 * caller can exclude them from `syncJobMaterialsForDocument` (avoiding a
 * duplicate invoice-sourced material + double stock issue).
 *
 * Never creates a stock movement directly — only the reconcile* helpers do, and
 * the filled material's quantity is unchanged so its existing issue still holds.
 */
export async function propagateInvoicePricesToJobMaterials(
  tx: DbOrTx,
  documentId: number,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PricePropagationResult> {
  const empty: PricePropagationResult = {
    consumedLineIds: new Set<number>(),
    filled: 0,
  };
  // NOTE: `autoLinkEnabled` only governs unsolicited link *suggestions*. Price
  // propagation runs against CONFIRMED targets (explicit doc.jobId or a
  // matchConfirmed reference), so it must work even when suggestions are off —
  // gating it here would silently break manual-confirmed propagation.
  const cfg = await resolveDocumentLinkingConfig();

  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) return empty;
  if (doc.status !== "approved") return empty;
  if (doc.docType !== "invoice" && doc.docType !== "credit_note") return empty;

  // Confirmed target jobs: an explicit document→job link, plus any reference
  // whose match has been confirmed. Without a confirmed link we do nothing.
  const targetJobIds = new Set<number>();
  if (doc.jobId != null) targetJobIds.add(doc.jobId);
  const refs = await tx
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, documentId));
  for (const ref of refs) {
    if (ref.matchConfirmed === 1 && ref.matchedJobId != null) {
      targetJobIds.add(ref.matchedJobId);
    }
  }
  if (targetJobIds.size === 0) return empty;

  // Invoice material lines that can carry a price.
  const invoiceLines = (
    await tx
      .select()
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, documentId))
  ).filter(
    (l) =>
      !l.feeType &&
      l.lineType === "material" &&
      l.allocationType !== "stock" &&
      l.unitPriceWithoutVat != null &&
      num(l.unitPriceWithoutVat) > 0,
  );
  if (invoiceLines.length === 0) return empty;

  // Existing materials of the target jobs that came from a DIFFERENT document
  // (i.e. the earlier delivery note), so we fill them rather than duplicate.
  const jobMaterials = (
    await tx
      .select()
      .from(materialsTable)
      .where(inArray(materialsTable.jobId, Array.from(targetJobIds)))
  ).filter((m) => m.sourceType === MATERIAL_SOURCE_TYPE && m.sourceId != null);
  if (jobMaterials.length === 0) return empty;

  // Load each material's own source line to recover EAN/SKU for matching
  // (materials themselves only store a free-text name).
  const sourceLineIds = jobMaterials
    .map((m) => m.sourceId)
    .filter((id): id is number => id != null);
  const sourceLines = sourceLineIds.length
    ? await tx
        .select()
        .from(billingDocumentLinesTable)
        .where(inArray(billingDocumentLinesTable.id, sourceLineIds))
    : [];
  const sourceLineById = new Map(sourceLines.map((l) => [l.id, l]));

  // A material is a fill candidate only when its OWN source line belongs to a
  // DIFFERENT document (the earlier delivery note). Keying off the source
  // document (not the mutable priceSourceDocumentId) keeps re-approve
  // idempotent: an already-filled material is still recognised as the same
  // delivery-note material on the second run, so it is re-consumed rather than
  // duplicated by sync. Materials whose source line is THIS invoice are skipped.
  const candidateMaterials = jobMaterials.filter((m) => {
    const src = m.sourceId != null ? sourceLineById.get(m.sourceId) : undefined;
    return src != null && src.documentId !== documentId;
  });
  if (candidateMaterials.length === 0) return empty;

  const materialMatchable = (m: (typeof candidateMaterials)[number]): MatchableLine => {
    const src = m.sourceId != null ? sourceLineById.get(m.sourceId) : undefined;
    return {
      ean: src?.ean ?? null,
      supplierSku: src?.supplierSku ?? null,
      description: m.name,
      quantity: m.quantity == null ? null : num(m.quantity),
    };
  };

  const consumedLineIds = new Set<number>();
  const usedMaterialIds = new Set<number>();
  let filled = 0;

  for (const line of invoiceLines) {
    const lineMatchable: MatchableLine = {
      ean: line.ean,
      supplierSku: line.supplierSku,
      description: line.description,
      quantity: line.quantity == null ? null : num(line.quantity),
    };

    let best: { material: (typeof candidateMaterials)[number]; score: number } | null =
      null;
    for (const m of candidateMaterials) {
      if (usedMaterialIds.has(m.id)) continue;
      const score = scoreLineMatch(lineMatchable, materialMatchable(m)).score;
      if (score >= cfg.autoLinkMinScore && (!best || score > best.score)) {
        best = { material: m, score };
      }
    }
    if (!best) continue;

    const m = best.material;
    // Leave a material already priced from another invoice line untouched
    // (stable + idempotent). Re-running with the same line refreshes in place.
    if (
      m.priceSource === "invoice" &&
      m.priceSourceLineId != null &&
      m.priceSourceLineId !== line.id
    ) {
      continue;
    }

    usedMaterialIds.add(m.id);
    consumedLineIds.add(line.id);
    await tx
      .update(materialsTable)
      .set({
        pricePerUnit: String(round2(num(line.unitPriceWithoutVat))),
        priceSource: "invoice",
        priceSourceDocumentId: documentId,
        priceSourceLineId: line.id,
        priceSourceSupplierName: doc.supplierName ?? null,
        priceSourceDate: doc.issueDate ? new Date(doc.issueDate) : null,
        priceConfidence: best.score.toFixed(2),
      })
      .where(eq(materialsTable.id, m.id));
    filled++;

    // Quantity is unchanged, so the material's stock issue is already correct;
    // reconcile defensively in case it now matches a warehouse item by name.
    const [refreshed] = await tx
      .select()
      .from(materialsTable)
      .where(eq(materialsTable.id, m.id));
    await reconcileMaterialStockMovement(tx, refreshed ?? null, actor);
  }

  return { consumedLineIds, filled };
}

/**
 * Reverse {@link propagateInvoicePricesToJobMaterials}: when an invoice / credit
 * note leaves "approved" (un-approve, ignore, mark duplicate, delete), the
 * prices it had filled onto OTHER documents' materials (typically the earlier
 * delivery note's "čeká na fakturu" materials) must be rolled back so the system
 * never offers/bills a price sourced from a now-unapproved document.
 *
 * Only materials whose `priceSourceDocumentId === documentId` are affected, and
 * only when their OWN `sourceId` line belongs to a DIFFERENT document (i.e. the
 * fill targets — never a material that this invoice itself created via sync,
 * which `syncJobMaterialsForDocument` already removes). The price reverts to the
 * pre-fill "awaiting invoice" state (price 0, source `awaiting_invoice`) and all
 * provenance fields are cleared. Quantity is untouched, so the existing stock
 * issue still holds; we reconcile defensively. Never creates a stock movement
 * directly. Idempotent: a second run finds nothing to revert.
 */
export async function revertInvoicePricePropagation(
  tx: DbOrTx,
  documentId: number,
  actor: Actor = SYSTEM_ACTOR,
): Promise<{ reverted: number }> {
  // Materials this document had priced, that are NOT invoiced to a customer
  // (a customer-invoiced material keeps its captured price) and whose own
  // source line belongs to a different document.
  const priced = await tx
    .select()
    .from(materialsTable)
    .where(
      and(
        eq(materialsTable.priceSourceDocumentId, documentId),
        isNull(materialsTable.invoicedInvoiceId),
      ),
    );
  if (priced.length === 0) return { reverted: 0 };

  const sourceLineIds = priced
    .map((m) => m.sourceId)
    .filter((id): id is number => id != null);
  const sourceLines = sourceLineIds.length
    ? await tx
        .select()
        .from(billingDocumentLinesTable)
        .where(inArray(billingDocumentLinesTable.id, sourceLineIds))
    : [];
  const sourceLineById = new Map(sourceLines.map((l) => [l.id, l]));

  let reverted = 0;
  for (const m of priced) {
    const src = m.sourceId != null ? sourceLineById.get(m.sourceId) : undefined;
    // Skip materials this very document created (sync handles those); only roll
    // back fills onto a different document's material.
    if (src != null && src.documentId === documentId) continue;
    await tx
      .update(materialsTable)
      .set({
        pricePerUnit: null,
        priceSource: "awaiting_invoice",
        priceSourceDocumentId: null,
        priceSourceLineId: null,
        priceSourceSupplierName: null,
        priceSourceDate: null,
        priceConfidence: null,
      })
      .where(eq(materialsTable.id, m.id));
    reverted++;

    const [refreshed] = await tx
      .select()
      .from(materialsTable)
      .where(eq(materialsTable.id, m.id));
    await reconcileMaterialStockMovement(tx, refreshed ?? null, actor);
  }
  return { reverted };
}

// ---------------------------------------------------------------------------
// Lifecycle: approve / ignore / set status / requeue / delete
// ---------------------------------------------------------------------------

export async function approveDocument(id: number, actor: Actor) {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, id));
    if (!doc) throw appError(404, "Doklad nenalezen.");
    await tx
      .update(billingDocumentsTable)
      .set({
        status: "approved",
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentsTable.id, id));
    // Mark re-billable lines approved; internal/stock/not-rebilled stay out.
    await tx
      .update(billingDocumentLinesTable)
      .set({ approved: 1, updatedAt: new Date() })
      .where(
        and(
          eq(billingDocumentLinesTable.documentId, id),
          eq(billingDocumentLinesTable.allocationType, REBILL_ALLOC),
        ),
      );
    // Fill prices onto pre-existing (delivery-note) materials when this is a
    // confirmed-linked invoice; capture which lines were consumed so sync does
    // not also create a duplicate invoice-sourced material for them.
    const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(
      tx,
      id,
      actor,
    );
    // Propagate the approved material lines into their jobs' materials lists.
    await syncJobMaterialsForDocument(tx, id, actor, {
      excludeSourceLineIds: consumedLineIds,
    });
    // Receive every stock-allocated line into the warehouse (příjem).
    await reconcileDocumentStockMovements(tx, id, actor);
    // Update warehouse catalogue fields + purchase price + append price history.
    await applyWarehouseCatalogAndPriceHistory(tx, id, actor);
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "update",
      entityType: "billing_documents",
      entityId: id,
      summary: `Nákladový doklad schválen${doc.documentNumber ? ` (${doc.documentNumber})` : ""}`,
      method: "POST",
      path: `/billing/documents/${id}/approve`,
    });
  });
  return getDocument(id);
}

// ---------------------------------------------------------------------------
// Approval → warehouse purchase-price update (explicit admin action)
// ---------------------------------------------------------------------------

export interface WarehousePriceUpdate {
  lineId: number;
  warehouseItemId: number;
  itemName: string;
  oldPrice: number | null;
  newPrice: number;
  matchedBy: "code" | "name";
}

/**
 * Shared core (transaction-aware): push the purchase prices from an APPROVED
 * document's product lines onto the matching warehouse items, enrich the item's
 * catalogue fields (EAN / supplier SKU / supplier / manufacturer / normalized
 * name) when they are still empty, and append a row to the warehouse purchase-
 * price history. Each line is matched by code (supplier SKU / EAN) first, then
 * by case-insensitive name. Fee/discount/non-material lines are skipped.
 *
 * Idempotent: the item price is overwritten with the latest, catalogue fields
 * are only filled when empty (never clobbered), and the price-history row is
 * keyed by `billingDocumentLineId` (partial unique) so re-running ON CONFLICT
 * DO UPDATE refreshes the same row instead of duplicating. Creates NO stock
 * movement — only item metadata + history.
 */
async function applyWarehouseCatalogAndPriceHistory(
  tx: DbOrTx,
  documentId: number,
  actor: Actor,
): Promise<{ updated: WarehousePriceUpdate[]; skipped: number }> {
  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  const updated: WarehousePriceUpdate[] = [];
  let skipped = 0;
  if (!doc || doc.status !== "approved") return { updated, skipped };

  const lines = await tx
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, documentId));

  const items = await tx.select().from(warehouseItemsTable);
  const byCode = new Map<string, (typeof items)[number]>();
  const byName = new Map<string, (typeof items)[number]>();
  for (const it of items) {
    if (it.code) byCode.set(it.code.trim().toLowerCase(), it);
    if (it.ean) byCode.set(it.ean.trim().toLowerCase(), it);
    if (it.supplierSku) byCode.set(it.supplierSku.trim().toLowerCase(), it);
    byName.set(it.name.trim().toLowerCase(), it);
  }

  for (const line of lines) {
    // Skip fees, discounts and non-material lines — they are not stock items.
    if (line.feeType || line.lineType !== "material") {
      skipped++;
      continue;
    }
    const codeKeys = [line.supplierSku, line.ean]
      .filter((c): c is string => !!c)
      .map((c) => c.trim().toLowerCase());
    let item = codeKeys.map((k) => byCode.get(k)).find(Boolean);
    let matchedBy: "code" | "name" = "code";
    if (!item) {
      item = byName.get(line.description.trim().toLowerCase());
      matchedBy = "name";
    }
    if (!item) {
      skipped++;
      continue;
    }
    const newPrice = round2(num(line.unitPriceWithoutVat));
    const oldPrice = item.purchasePrice == null ? null : num(item.purchasePrice);
    // Fill catalogue fields only when empty (never clobber operator data).
    const catalogue: Record<string, string> = {};
    if (!item.ean && line.ean) catalogue.ean = line.ean;
    if (!item.supplierSku && line.supplierSku)
      catalogue.supplierSku = line.supplierSku;
    if (!item.supplierName && doc.supplierName)
      catalogue.supplierName = doc.supplierName;
    if (!item.supplierIc && doc.supplierIc) catalogue.supplierIc = doc.supplierIc;
    if (!item.manufacturer && line.manufacturer)
      catalogue.manufacturer = line.manufacturer;
    if (!item.normalizedName)
      catalogue.normalizedName = normalizeItemName(item.name);
    await tx
      .update(warehouseItemsTable)
      .set({ purchasePrice: String(newPrice), ...catalogue })
      .where(eq(warehouseItemsTable.id, item.id));
    // Mark the line as having flowed to stock for audit.
    await tx
      .update(billingDocumentLinesTable)
      .set({ warehouseState: "assigned_to_stock", updatedAt: new Date() })
      .where(eq(billingDocumentLinesTable.id, line.id));
    // Append (idempotently) to the purchase-price history.
    const historyValues = {
      warehouseItemId: item.id,
      billingDocumentId: documentId,
      billingDocumentLineId: line.id,
      purchasePrice: String(newPrice),
      currency: doc.currency ?? "CZK",
      supplierName: doc.supplierName ?? null,
      supplierIc: doc.supplierIc ?? null,
      ean: line.ean ?? null,
      supplierSku: line.supplierSku ?? null,
      documentNumber: doc.documentNumber ?? null,
      documentDate: doc.issueDate ? new Date(doc.issueDate) : null,
      createdByUserId: actor.userId ?? null,
      createdByName: actor.name ?? null,
    };
    await tx
      .insert(warehousePriceHistoryTable)
      .values(historyValues)
      .onConflictDoUpdate({
        target: warehousePriceHistoryTable.billingDocumentLineId,
        targetWhere: isNotNull(warehousePriceHistoryTable.billingDocumentLineId),
        set: {
          warehouseItemId: historyValues.warehouseItemId,
          billingDocumentId: historyValues.billingDocumentId,
          purchasePrice: historyValues.purchasePrice,
          currency: historyValues.currency,
          supplierName: historyValues.supplierName,
          supplierIc: historyValues.supplierIc,
          ean: historyValues.ean,
          supplierSku: historyValues.supplierSku,
          documentNumber: historyValues.documentNumber,
          documentDate: historyValues.documentDate,
        },
      });
    updated.push({
      lineId: line.id,
      warehouseItemId: item.id,
      itemName: item.name,
      oldPrice,
      newPrice,
      matchedBy,
    });
  }

  if (updated.length) {
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "update",
      entityType: "warehouse_items",
      entityId: documentId,
      summary: `Nákupní ceny aktualizovány z dokladu${
        doc.documentNumber ? ` ${doc.documentNumber}` : ""
      }: ${updated.length} položek`,
      method: "POST",
      path: `/billing/documents/${documentId}/apply-warehouse-prices`,
    });
  }

  return { updated, skipped };
}

/**
 * Explicit admin action: push purchase prices + catalogue + price history from
 * an approved document to the warehouse. Wraps the shared core in a transaction
 * and enforces the approved-status precondition (the automatic call on approve
 * runs the same core inside the approve transaction).
 */
export async function updateWarehousePricesFromDocument(
  documentId: number,
  actor: Actor,
): Promise<{ updated: WarehousePriceUpdate[]; skipped: number }> {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (doc.status !== "approved") {
    throw appError(409, "Ceny do skladu lze přenést až po schválení dokladu.");
  }
  return db.transaction((tx) =>
    applyWarehouseCatalogAndPriceHistory(tx, documentId, actor),
  );
}

export async function setDocumentStatus(
  id: number,
  status: "needs_review" | "reviewed" | "ignored" | "duplicate",
  actor: Actor,
) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  await db.transaction(async (tx) => {
    await tx
      .update(billingDocumentsTable)
      .set({
        status,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentsTable.id, id));
    // Leaving "approved" → un-approve its lines so they stop being offered.
    if (doc.status === "approved") {
      await tx
        .update(billingDocumentLinesTable)
        .set({ approved: 0, updatedAt: new Date() })
        .where(
          and(
            eq(billingDocumentLinesTable.documentId, id),
            isNull(billingDocumentLinesTable.invoicedInvoiceId),
          ),
        );
    }
    // Roll back any prices this invoice had filled onto OTHER documents'
    // materials (delivery-note "čeká na fakturu") before they're re-offered.
    if (doc.status === "approved") {
      await revertInvoicePricePropagation(tx, id, actor);
    }
    // Reconcile job materials (removes them when leaving "approved").
    await syncJobMaterialsForDocument(tx, id, actor);
    // Reverse warehouse receipts when leaving "approved" (storno of příjem).
    await reconcileDocumentStockMovements(tx, id, actor);
  });
  return getDocument(id);
}

export async function requeueExtraction(id: number) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  await db.insert(extractionJobsTable).values({ documentId: id });
  return getDocument(id);
}

export async function deleteDocument(id: number, actor: Actor) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  const [invoiced] = await db
    .select({ id: billingDocumentLinesTable.id })
    .from(billingDocumentLinesTable)
    .where(
      and(
        eq(billingDocumentLinesTable.documentId, id),
        ne(billingDocumentLinesTable.invoicedInvoiceId, 0),
      ),
    )
    .limit(1);
  if (invoiced) {
    throw appError(409, "Doklad má položky na faktuře a nelze jej smazat.");
  }
  // Atomic: remove propagated job materials, delete the document (cascading its
  // lines), and audit — all or nothing. Materials must go first while the lines
  // still exist (materials reference lines by id, not via FK).
  await db.transaction(async (tx) => {
    const lines = await tx
      .select({ id: billingDocumentLinesTable.id })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, id));
    const lineIds = lines.map((l) => l.id);
    // Reverse the warehouse receipts of this document's stock lines (storno
    // příjmu) — append reversing movements, never delete ledger history.
    for (const lineId of lineIds) {
      await reconcileSourceMovements(tx, "billing_document_line", lineId, null, actor);
    }
    // Reverse + remove the propagated job materials (and their stock issues).
    const propagated = lineIds.length
      ? await tx
          .select({ id: materialsTable.id })
          .from(materialsTable)
          .where(
            and(
              eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
              inArray(materialsTable.sourceId, lineIds),
            ),
          )
      : [];
    for (const m of propagated) {
      await reconcileSourceMovements(tx, "material", m.id, null, actor);
    }
    if (propagated.length) {
      await tx
        .delete(materialsTable)
        .where(inArray(materialsTable.id, propagated.map((m) => m.id)));
    }
    // Roll back any prices this document filled onto OTHER documents' materials
    // (delivery-note fills) so a deleted invoice never leaves a stale price.
    await revertInvoicePricePropagation(tx, id, actor);
    await tx.delete(billingDocumentsTable).where(eq(billingDocumentsTable.id, id));
    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "delete",
      entityType: "billing_documents",
      entityId: id,
      summary: `Nákladový doklad smazán${doc.documentNumber ? ` (${doc.documentNumber})` : ""}`,
      method: "DELETE",
      path: `/billing/documents/${id}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Analyze a job's attachments → cost documents
// ---------------------------------------------------------------------------

const DOKLAD_TYPES = new Set(["invoice", "receipt", "delivery_note"]);

/**
 * Create cost documents from a job's "doklady" attachments (účtenky / dodací
 * listy / faktury) that have not already been imported. The attachment bytes
 * are fetched from storage, hashed for dedup, ISDOC-parsed when applicable, and
 * queued. Returns the documents created (skipping ones already imported).
 */
export async function analyzeJobDocuments(jobId: number, actor: Actor) {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) throw appError(404, "Zakázka nenalezena.");

  const attachments = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.jobId, jobId));
  const doklady = attachments.filter(
    (a) => DOKLAD_TYPES.has(a.type) && a.url && a.url.startsWith("/objects/"),
  );

  const created: SerializedDocument[] = [];
  let skipped = 0;
  for (const att of doklady) {
    let buffer: Buffer;
    try {
      buffer = await objectStorage.getPrivateObjectBuffer(att.url!);
    } catch {
      skipped++;
      continue;
    }
    const hash = sha256Of(buffer);
    const [existing] = await db
      .select({ id: billingDocumentsTable.id })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash))
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }
    const docType =
      att.type === "receipt"
        ? "receipt"
        : att.type === "delivery_note"
          ? "delivery_note"
          : "invoice";
    const doc = await createDocument(
      {
        objectPath: att.url!,
        fileName: att.fileName ?? "doklad",
        contentType: guessContentType(att.fileName ?? ""),
        fileSize: buffer.length,
        sha256: hash,
        source: "job_attachment",
        docType,
        jobId,
        customerId: job.customerId ?? null,
      },
      buffer,
      actor,
    );
    created.push(doc);
  }
  return { created, createdCount: created.length, skipped };
}

function guessContentType(fileName: string): string {
  const fn = fileName.toLowerCase();
  if (fn.endsWith(".pdf")) return "application/pdf";
  if (fn.endsWith(".png")) return "image/png";
  if (fn.endsWith(".jpg") || fn.endsWith(".jpeg")) return "image/jpeg";
  if (fn.endsWith(".xml") || fn.endsWith(".isdoc")) return "application/xml";
  if (fn.endsWith(".isdocx")) return "application/zip";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Approved lines → outgoing invoice builder
// ---------------------------------------------------------------------------

/**
 * Approved, re-billable cost-document lines that belong to the given customer
 * (via the document's customer link or the line's matched job) and have not yet
 * been pulled onto an invoice. These are offered as extra invoice lines.
 */
export async function getApprovedLinesForCustomer(customerId: number) {
  const rows = await db
    .select({
      line: billingDocumentLinesTable,
      docNumber: billingDocumentsTable.documentNumber,
      supplierName: billingDocumentsTable.supplierName,
    })
    .from(billingDocumentLinesTable)
    .innerJoin(
      billingDocumentsTable,
      eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id),
    )
    .leftJoin(jobsTable, eq(billingDocumentLinesTable.jobId, jobsTable.id))
    .where(
      and(
        eq(billingDocumentsTable.status, "approved"),
        eq(billingDocumentLinesTable.approved, 1),
        eq(billingDocumentLinesTable.allocationType, REBILL_ALLOC),
        isNull(billingDocumentLinesTable.invoicedInvoiceId),
        or(
          eq(billingDocumentsTable.customerId, customerId),
          eq(jobsTable.customerId, customerId),
        ),
      ),
    )
    .orderBy(billingDocumentLinesTable.id);

  return rows.map((r) => ({
    id: r.line.id,
    documentId: r.line.documentId,
    documentNumber: r.docNumber,
    supplierName: r.supplierName,
    jobId: r.line.jobId,
    description: r.line.description,
    quantity: num(r.line.quantity),
    unit: r.line.unit,
    unitPriceWithoutVat: num(r.line.unitPriceWithoutVat),
    vatRate: r.line.vatRate == null ? null : num(r.line.vatRate),
    totalWithoutVat: num(r.line.totalWithoutVat),
  }));
}

/** Mark cost-document lines as pulled onto an invoice (called by invoice-service). */
export async function markLinesInvoiced(
  tx: DbOrTx,
  invoiceId: number,
  lineIds: number[],
): Promise<void> {
  if (!lineIds.length) return;
  await tx
    .update(billingDocumentLinesTable)
    .set({ invoicedInvoiceId: invoiceId, updatedAt: new Date() })
    .where(inArray(billingDocumentLinesTable.id, lineIds));
}

/** Release any cost-document lines tied to an invoice (storno / draft delete). */
export async function releaseInvoicedLines(
  tx: DbOrTx,
  invoiceId: number,
): Promise<void> {
  await tx
    .update(billingDocumentLinesTable)
    .set({ invoicedInvoiceId: null, updatedAt: new Date() })
    .where(eq(billingDocumentLinesTable.invoicedInvoiceId, invoiceId));
}

/**
 * Reserve job materials onto a customer invoice so they aren't offered or billed
 * twice. Purely a provenance flag — it NEVER touches warehouse stock (the stock
 * issue happened when the material was created/reconciled).
 */
export async function markMaterialsInvoiced(
  tx: DbOrTx,
  invoiceId: number,
  materialIds: number[],
): Promise<void> {
  if (!materialIds.length) return;
  await tx
    .update(materialsTable)
    .set({ invoicedInvoiceId: invoiceId, invoicedAt: new Date() })
    .where(inArray(materialsTable.id, materialIds));
}

/**
 * Release any job materials tied to an invoice (storno / draft delete).
 *
 * On release a material becomes offerable again, so its price provenance must be
 * re-validated: if it was priced from a cost document that has since been deleted
 * or left "approved" (the un-approve/delete revert deliberately skipped it while
 * it was reserved on the customer invoice), roll its price back to
 * "awaiting_invoice" here so a stale price from a non-approved source is never
 * re-offered. Quantity is unchanged, so the existing stock issue still holds.
 */
export async function releaseInvoicedMaterials(
  tx: DbOrTx,
  invoiceId: number,
): Promise<void> {
  const released = await tx
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.invoicedInvoiceId, invoiceId));

  await tx
    .update(materialsTable)
    .set({ invoicedInvoiceId: null, invoicedAt: null })
    .where(eq(materialsTable.invoicedInvoiceId, invoiceId));

  for (const m of released) {
    if (m.priceSource !== "invoice") continue;
    // A null priceSourceDocumentId on an invoice-sourced price means the source
    // doc was deleted (FK ON DELETE SET NULL) → invalid provenance, must revert.
    if (m.priceSourceDocumentId != null) {
      const [src] = await tx
        .select({ status: billingDocumentsTable.status })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, m.priceSourceDocumentId));
      // Source still approved → price is legitimately captured, leave it.
      if (src && src.status === "approved") continue;
    }
    await tx
      .update(materialsTable)
      .set({
        pricePerUnit: null,
        priceSource: "awaiting_invoice",
        priceSourceDocumentId: null,
        priceSourceLineId: null,
        priceSourceSupplierName: null,
        priceSourceDate: null,
        priceConfidence: null,
      })
      .where(eq(materialsTable.id, m.id));
    const [refreshed] = await tx
      .select()
      .from(materialsTable)
      .where(eq(materialsTable.id, m.id));
    await reconcileMaterialStockMovement(tx, refreshed ?? null, SYSTEM_ACTOR);
  }
}

// ---------------------------------------------------------------------------
// AI extraction suggestion (OpenAI)
// ---------------------------------------------------------------------------

export interface AiSuggestionLine {
  description: string;
  lineType?: string;
  quantity?: number | null;
  unit?: string | null;
  unitPriceWithoutVat?: number | null;
  vatRate?: number | null;
  // Richer supplier-catalogue fields the AI may now return.
  supplierSku?: string | null;
  ean?: string | null;
  manufacturer?: string | null;
  discountPercent?: number | null;
  listPrice?: number | null;
  environmentalFee?: number | null;
  isEnvironmentalFee?: boolean;
}

export interface AiSuggestionReference {
  referenceType: string;
  referenceNumber: string;
}

export interface AiSuggestionInput {
  docType?: string | null;
  supplierName?: string | null;
  supplierIc?: string | null;
  supplierDic?: string | null;
  supplierAddress?: string | null;
  documentNumber?: string | null;
  variableSymbol?: string | null;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  subtotalWithoutVat?: number | null;
  totalVat?: number | null;
  totalWithVat?: number | null;
  lines: AiSuggestionLine[];
  relatedDocuments?: AiSuggestionReference[];
  confidence: number;
  warnings: string[];
  model: string;
  rawJson: string;
}

/** Only fill a header field from AI when the document doesn't already have one. */
function fillIfEmpty<T>(current: T | null, suggestion: T | null | undefined): T | null {
  if (current != null && current !== ("" as unknown as T)) return current;
  return suggestion ?? null;
}

/**
 * Persist an AI extraction as a `needs_review` SUGGESTION. AI output is never
 * auto-approved: the document is left for an admin to confirm. Header fields are
 * only prefilled where empty (so a human edit / ISDOC value is never clobbered);
 * suggested lines are appended only when the document has none yet. The raw model
 * response, confidence and model name are stored for audit, and any warnings
 * (incl. the low-confidence flag) are merged into the document's warnings.
 */
export async function applyAiSuggestion(
  documentId: number,
  suggestion: AiSuggestionInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId));
    if (!doc) throw appError(404, "Doklad nenalezen.");

    const existingLines = await tx
      .select({ id: billingDocumentLinesTable.id })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, documentId));

    const warnings = [
      "Hlavička a položky předvyplněny pomocí AI (OpenAI). Před schválením pečlivě zkontrolujte.",
      ...suggestion.warnings,
    ].join("\n");

    const docType =
      suggestion.docType && VALID_DOC_TYPE.has(suggestion.docType)
        ? suggestion.docType
        : doc.docType;

    await tx
      .update(billingDocumentsTable)
      .set({
        // Never override a value a human / ISDOC already set.
        docType,
        supplierName: fillIfEmpty(doc.supplierName, suggestion.supplierName),
        supplierIc: fillIfEmpty(doc.supplierIc, suggestion.supplierIc),
        supplierDic: fillIfEmpty(doc.supplierDic, suggestion.supplierDic),
        supplierAddress: fillIfEmpty(doc.supplierAddress, suggestion.supplierAddress),
        documentNumber: fillIfEmpty(doc.documentNumber, suggestion.documentNumber),
        variableSymbol: fillIfEmpty(doc.variableSymbol, suggestion.variableSymbol),
        issueDate: fillIfEmpty(doc.issueDate, suggestion.issueDate),
        taxableSupplyDate: fillIfEmpty(doc.taxableSupplyDate, suggestion.taxableSupplyDate),
        dueDate: fillIfEmpty(doc.dueDate, suggestion.dueDate),
        currency: doc.currency || suggestion.currency || "CZK",
        subtotalWithoutVat:
          doc.subtotalWithoutVat ??
          (suggestion.subtotalWithoutVat != null
            ? String(round2(suggestion.subtotalWithoutVat))
            : null),
        totalVat:
          doc.totalVat ??
          (suggestion.totalVat != null ? String(round2(suggestion.totalVat)) : null),
        totalWithVat:
          doc.totalWithVat ??
          (suggestion.totalWithVat != null
            ? String(round2(suggestion.totalWithVat))
            : null),
        warnings,
        aiRawJson: suggestion.rawJson,
        aiConfidence: String(round2(suggestion.confidence)),
        aiModel: suggestion.model,
        aiExtractedAt: new Date(),
        // AI output is a suggestion — always leave it for human review.
        status: "needs_review",
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentsTable.id, documentId));

    if (!existingLines.length && suggestion.lines.length) {
      await tx.insert(billingDocumentLinesTable).values(
        suggestion.lines.map((l, idx) =>
          lineValues(
            documentId,
            {
              description: l.description,
              quantity: l.quantity,
              unit: l.unit,
              unitPriceWithoutVat: l.unitPriceWithoutVat,
              vatRate: l.vatRate,
              lineType: l.lineType,
              supplierSku: l.supplierSku,
              ean: l.ean,
              manufacturer: l.manufacturer,
              discountPercent: l.discountPercent,
              listPriceWithoutVat: l.listPrice,
              // The AI may flag a line as a pure eco/recycling fee; map it onto
              // the fee classifier so totals/columns line up.
              feeType: l.isEnvironmentalFee ? "environmental" : undefined,
            },
            idx,
          ),
        ),
      );
    }

    // Persist AI-suggested document references (deduped against existing ones).
    if (suggestion.relatedDocuments?.length) {
      const existingRefs = await tx
        .select({
          referenceType: billingDocumentReferencesTable.referenceType,
          referenceNumber: billingDocumentReferencesTable.referenceNumber,
        })
        .from(billingDocumentReferencesTable)
        .where(eq(billingDocumentReferencesTable.documentId, documentId));
      const seen = new Set(
        existingRefs.map(
          (r) => `${r.referenceType}::${r.referenceNumber.toLowerCase()}`,
        ),
      );
      const toInsert = suggestion.relatedDocuments
        .filter((r) => r.referenceNumber.trim())
        .map((r) => ({
          referenceType: VALID_REFERENCE_TYPE.has(r.referenceType)
            ? r.referenceType
            : "other",
          referenceNumber: r.referenceNumber.trim(),
        }))
        .filter((r) => {
          const key = `${r.referenceType}::${r.referenceNumber.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      if (toInsert.length) {
        await tx.insert(billingDocumentReferencesTable).values(
          toInsert.map((r) => ({
            documentId,
            referenceType: r.referenceType,
            referenceNumber: r.referenceNumber,
            source: "ai",
          })),
        );
      }
    }
  });
}

/** Fetch a document's stored file bytes (or null when it has no object). */
export async function getDocumentFileBuffer(
  documentId: number,
): Promise<{ buffer: Buffer; contentType: string | null; fileName: string | null } | null> {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc || !doc.objectPath) return null;
  const buffer = await objectStorage.getPrivateObjectBuffer(doc.objectPath);
  return { buffer, contentType: doc.contentType, fileName: doc.fileName };
}

void sql;
