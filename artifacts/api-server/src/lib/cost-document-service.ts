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
  activitiesTable,
  activityMaterialsTable,
  customersTable,
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
  scoreDocumentSimilarity,
  selectAutomaticDocumentMatches,
  type MatchableDocument,
  type MatchableLine,
} from "./document-matching";
import {
  normalizeItemName,
  normalizeReferenceNumber,
} from "./reference-extractor";
import { resolveDocumentLinkingConfig } from "./document-linking-config";
import {
  CONFIDENCE_REVIEW_THRESHOLD,
  isSupportedForAi,
  type ExtractionFileInput,
} from "./openai-extraction";
import { logger } from "./logger";
import {
  reconcileDocumentStockMovements,
  reconcileSourceMovements,
  reconcileMaterialStockMovement,
  reconcileActivityMaterialStockMovement,
  backfillOutMovementCostPrices,
  resolveWarehouseItemIdByName,
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
const INCOMPLETE_MULTIPAGE_WARNING_CODE = "NEUPLNY_VICESTRANKOVY_DOKLAD";
const VALID_LINE_TYPE = new Set(["material", "work", "transport", "other"]);
const VALID_DOC_TYPE = new Set(["receipt", "delivery_note", "invoice", "credit_note"]);

function looksLikeIncompleteMultipageDocument(doc: Pick<BillingDocument, "warnings" | "totalWithVat">): boolean {
  const warnings = doc.warnings ?? "";
  if (warnings.includes(INCOMPLETE_MULTIPAGE_WARNING_CODE)) return true;
  return (
    doc.totalWithVat == null &&
    /strana\s+\d+\s*\/\s*\d+/i.test(warnings) &&
    /(chyb|nekompletn|sou[cč]t|celkov)/i.test(warnings)
  );
}

async function hasExtractedMaterialLines(tx: DbOrTx, documentId: number): Promise<boolean> {
  const [line] = await tx
    .select({ id: billingDocumentLinesTable.id })
    .from(billingDocumentLinesTable)
    .where(
      and(
        eq(billingDocumentLinesTable.documentId, documentId),
        eq(billingDocumentLinesTable.lineType, "material"),
      ),
    )
    .limit(1);
  return Boolean(line);
}

async function assertCompleteBeforeTerminalAction(
  tx: DbOrTx,
  doc: BillingDocument,
  action: "approve" | "ignore" | "duplicate",
): Promise<void> {
  if (!looksLikeIncompleteMultipageDocument(doc)) return;
  if (!(await hasExtractedMaterialLines(tx, doc.id))) return;

  const actionText =
    action === "approve"
      ? "schvalovat"
      : action === "ignore"
        ? "ignorovat"
        : "označit jako duplicitu";
  throw appError(
    409,
    `Doklad vypadá jako nekompletní stránka vícestránkového dokladu a obsahuje materiálové položky. Nelze jej ${actionText}, protože by se část materiálu ztratila. Nejprve sloučte všechny strany dokladu nebo nahrajte doklad jako jeden vícestránkový soubor.`,
  );
}

async function mergeIncompleteMultipagePageTx(
  tx: DbOrTx,
  primary: BillingDocument,
  secondary: BillingDocument,
  actor: Actor,
): Promise<void> {
  const groupId = primary.mergeGroupId ?? secondary.mergeGroupId ?? randomUUID();
  const primaryLines = await tx
    .select({ sortOrder: billingDocumentLinesTable.sortOrder })
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, primary.id));
  const nextSort =
    primaryLines.reduce((max, l) => Math.max(max, l.sortOrder ?? 0), -1) + 1;
  const secondaryLines = await tx
    .select({ id: billingDocumentLinesTable.id })
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, secondary.id))
    .orderBy(billingDocumentLinesTable.sortOrder, billingDocumentLinesTable.id);

  for (const [idx, line] of secondaryLines.entries()) {
    await tx
      .update(billingDocumentLinesTable)
      .set({
        documentId: primary.id,
        sortOrder: nextSort + idx,
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentLinesTable.id, line.id));
  }

  await tx
    .update(billingDocumentReferencesTable)
    .set({ documentId: primary.id, updatedAt: new Date() })
    .where(eq(billingDocumentReferencesTable.documentId, secondary.id));
  await tx
    .update(billingDocumentFilesTable)
    .set({ documentId: primary.id })
    .where(eq(billingDocumentFilesTable.documentId, secondary.id));
  await tx
    .update(billingDocumentsTable)
    .set({ mergeGroupId: groupId, updatedAt: new Date() })
    .where(eq(billingDocumentsTable.id, primary.id));
  await tx
    .update(billingDocumentsTable)
    .set({
      mergeGroupId: groupId,
      primaryDocumentId: primary.id,
      status: "duplicate",
      warnings: [
        secondary.warnings,
        `Sloučeno do vícestránkového dokladu #${primary.id}; řádky z této stránky byly přesunuty do hlavního dokladu.`,
      ]
        .filter(Boolean)
        .join("\n"),
      updatedAt: new Date(),
    })
    .where(eq(billingDocumentsTable.id, secondary.id));

  await tx.insert(auditLogTable).values({
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "update",
    entityType: "billing_documents",
    entityId: primary.id,
    summary: `Sloučena nekompletní strana dokladu #${secondary.id} do vícestránkového dokladu #${primary.id}`,
    method: "POST",
    path: `/billing/documents/${primary.id}`,
  });
}

async function reconcileIncompleteMultipagePages(documentId: number, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId));
    if (!doc || !doc.documentNumber || doc.primaryDocumentId != null) return;

    const conds = [
      ne(billingDocumentsTable.id, doc.id),
      isNull(billingDocumentsTable.primaryDocumentId),
      eq(billingDocumentsTable.documentNumber, doc.documentNumber),
    ];
    if (doc.jobId != null) conds.push(eq(billingDocumentsTable.jobId, doc.jobId));
    if (doc.supplierIc) {
      conds.push(eq(billingDocumentsTable.supplierIc, doc.supplierIc));
    } else if (doc.supplierName) {
      conds.push(eq(billingDocumentsTable.supplierName, doc.supplierName));
    }

    const siblings = await tx
      .select()
      .from(billingDocumentsTable)
      .where(and(...conds));
    const candidates = [doc, ...siblings].filter(
      (d) => d.status !== "approved" && d.status !== "duplicate",
    );
    const primary = candidates.find(
      (d) => !looksLikeIncompleteMultipageDocument(d) && d.totalWithVat != null,
    );
    if (!primary) return;

    for (const secondary of candidates) {
      if (secondary.id === primary.id) continue;
      if (!looksLikeIncompleteMultipageDocument(secondary)) continue;
      if (!(await hasExtractedMaterialLines(tx, secondary.id))) continue;
      await mergeIncompleteMultipagePageTx(tx, primary, secondary, actor);
    }
  });
}

async function reconcileIncompleteMultipagePagesSafely(
  documentId: number,
  actor: Actor,
): Promise<void> {
  try {
    await reconcileIncompleteMultipagePages(documentId, actor);
  } catch (error) {
    logger.warn({ err: error, documentId }, "Incomplete multi-page document reconciliation failed");
  }
}

// ---------------------------------------------------------------------------
// Hashing + duplicate detection
// ---------------------------------------------------------------------------

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Returns true when a PostgreSQL error is a unique-constraint violation
 * (23505) on `billing_documents_sha256_unique_idx`. Used to catch the race
 * where two concurrent requests with identical content (double-click,
 * manual upload racing an e-mail import, a repeated "Analyzovat doklady"
 * run, …) both pass the pre-insert "does this hash exist?" check — only one
 * INSERT can win, the DB constraint rejects the other, and we turn that
 * rejection into a normal "duplicate" result instead of a 500.
 */
function isDuplicateSha256Violation(err: unknown): boolean {
  // Drizzle wraps the raw pg error (which carries .code/.constraint) in its
  // own DrizzleQueryError with the original attached as `.cause` — check both
  // so this works whether we see the raw pg error or the wrapped one.
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null || !("code" in candidate)) continue;
    if ((candidate as { code: unknown }).code !== "23505") continue;
    const constraint = (candidate as { constraint?: unknown }).constraint;
    if (constraint === "billing_documents_sha256_unique_idx") return true;
  }
  return false;
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

/**
 * Derived, document-level material state aggregated from the document's
 * **material** lines (lineType "material", excluding fee lines):
 * - "approved"  → every material line is approved ("odsouhlasen"),
 * - "assigned"  → every material line has its job assignment confirmed
 *                 (matchConfirmed) but they are not all approved yet,
 * - null        → no material lines, or a mix where neither holds for all.
 * Purely derived (no DB column); shown as a badge next to the document status.
 */
export type MaterialState = "assigned" | "approved" | null;

function deriveMaterialState(
  lines: {
    lineType: string | null;
    feeType: string | null;
    matchConfirmed: number;
    approved: number;
  }[],
): MaterialState {
  const material = lines.filter(
    (l) => l.lineType === "material" && !l.feeType,
  );
  if (material.length === 0) return null;
  if (material.every((l) => l.approved > 0)) return "approved";
  if (material.every((l) => l.matchConfirmed > 0)) return "assigned";
  return null;
}

function serializeDocument(
  row: BillingDocument,
  materialState: MaterialState = null,
) {
  return {
    id: row.id,
    status: row.status,
    materialState,
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
    activityId: row.activityId,
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

/** Conservative thresholds for the fuzzy (no matching document number) merge path. */
const FUZZY_MERGE_AUTO_THRESHOLD = 0.85;
const FUZZY_MERGE_REVIEW_THRESHOLD = 0.55;

/** Statuses a human has already acted on — never overwritten by a fuzzy-match note. */
const REVIEW_TERMINAL_STATUSES = new Set(["approved", "ignored", "reviewed"]);

async function toMatchableWithLines(
  tx: DbOrTx,
  doc: BillingDocument,
): Promise<MatchableDocument & { lines: MatchableLine[] }> {
  const lines = await tx
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.documentId, doc.id));
  return {
    id: doc.id,
    supplierIc: doc.supplierIc,
    documentNumber: doc.documentNumber,
    totalWithoutVat: doc.subtotalWithoutVat != null ? num(doc.subtotalWithoutVat) : null,
    totalWithVat: doc.totalWithVat != null ? num(doc.totalWithVat) : null,
    issueDate: doc.issueDate,
    lines: lines.map((l) => ({
      ean: l.ean,
      supplierSku: l.supplierSku,
      description: l.description,
      quantity: l.quantity != null ? num(l.quantity) : null,
    })),
  };
}

/** Merge `secondary` into `primary`: move files, mark secondary a duplicate. */
async function performMergeTx(
  tx: DbOrTx,
  primary: BillingDocument,
  secondary: BillingDocument,
  note: string,
): Promise<void> {
  const groupId = primary.mergeGroupId ?? secondary.mergeGroupId ?? randomUUID();

  await tx
    .update(billingDocumentFilesTable)
    .set({ documentId: primary.id })
    .where(eq(billingDocumentFilesTable.documentId, secondary.id));

  await tx
    .update(billingDocumentsTable)
    .set({ mergeGroupId: groupId, updatedAt: new Date() })
    .where(eq(billingDocumentsTable.id, primary.id));

  const secWarn = [secondary.warnings, note].filter(Boolean).join("\n");
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
}

/**
 * Point `secondary` at `primary` as a confirmed duplicate: move any of its
 * extra role-tagged files (see `billingDocumentFilesTable`) under the primary
 * so all files for one logical document live in one place, then mark
 * `secondary` as status="duplicate" so it drops out of the review queue. Each
 * document keeps its own top-level `objectPath`/`fileName` untouched, so a
 * duplicate's own file is always still reachable from its own row — nothing is
 * deleted. Used by both the automatic ISDOC/PDF merge and manual pairing.
 */
async function linkAsDuplicateTx(
  tx: DbOrTx,
  primary: BillingDocument,
  secondary: BillingDocument,
  warningNote: string,
): Promise<void> {
  const groupId = primary.mergeGroupId ?? secondary.mergeGroupId ?? randomUUID();

  await tx
    .update(billingDocumentFilesTable)
    .set({ documentId: primary.id })
    .where(eq(billingDocumentFilesTable.documentId, secondary.id));

  await tx
    .update(billingDocumentsTable)
    .set({ mergeGroupId: groupId, updatedAt: new Date() })
    .where(eq(billingDocumentsTable.id, primary.id));

  const secWarn = [secondary.warnings, warningNote].filter(Boolean).join("\n");
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
}

/**
 * Detect a sibling document that is the SAME logical invoice as `doc` (a PDF and
 * its ISDOC, two scans, or a multi-page photo uploaded as separate documents by
 * mistake), and merge them into one group.
 *
 * Two matching paths:
 *  1. Identity — ISDOC UUID, or supplier IČO + document number both present and
 *     equal. Confident by construction; always auto-merges.
 *  2. Fuzzy fallback (task #679) — used only when identity doesn't match/apply
 *     (e.g. the document number is missing or OCR'd differently on each scan).
 *     Scored via `scoreDocumentSimilarity` (IČO + total + date + line overlap).
 *     A high score auto-merges like an identity match; a middling score is
 *     never silently merged — both documents are flagged `needs_review` with an
 *     explanation so an admin decides; a low score does nothing.
 *
 * The higher-priority source (ISDOC > PDF > AI > manual) becomes the primary;
 * the other is re-pointed at it, its files are moved under the primary, and it
 * is marked status="duplicate" so it drops out of the review queue.
 */
async function mergeRelatedDocumentsTx(
  tx: DbOrTx,
  doc: BillingDocument,
  parsed: ParsedDocument | null,
): Promise<void> {
  void parsed;
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

  if (identityConds.length) {
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
    // Never auto-merge into (or absorb) an already-APPROVED document: approval
    // already fired price-propagation/warehouse/material side effects, so
    // flipping it to status="duplicate" here would silently orphan that state
    // with nothing left to re-run it (the new doc stays unapproved). Flag for
    // manual review instead, same as `markDocumentAsDuplicate` already does
    // for the manual pairing path (409 on an approved side).
    const approvedMatch = candidates.find((c) => c.status === "approved");
    const mergeCandidates = candidates.filter((c) => c.status !== "approved");
    // Prefer a candidate that differs in format (ISDOC vs PDF) — that's the pair
    // we want to merge. Fall back to the first candidate otherwise.
    const other =
      mergeCandidates.find(
        (c) => priorityRank(c.sourcePriority) !== priorityRank(doc.sourcePriority),
      ) ?? mergeCandidates[0];
    if (other) {
      const primary =
        priorityRank(other.sourcePriority) >= priorityRank(doc.sourcePriority) ? other : doc;
      const secondary = primary.id === doc.id ? other : doc;
      await performMergeTx(
        tx,
        primary,
        secondary,
        `Sloučeno s dokladem #${primary.id} (stejná faktura ve formátu ${
          priorityRank(primary.sourcePriority) >= 4 ? "ISDOC" : "PDF"
        }).`,
      );
      return;
    }
    if (approvedMatch) {
      const explanation = `Možná duplicita se schváleným dokladem #${approvedMatch.id} – vyžaduje kontrolu (schválený doklad nelze automaticky sloučit, spárujte ručně po případném zrušení schválení).`;
      await tx
        .update(billingDocumentsTable)
        .set({
          status: "needs_review",
          warnings: [doc.warnings, explanation].filter(Boolean).join("\n"),
          updatedAt: new Date(),
        })
        .where(eq(billingDocumentsTable.id, doc.id));
      return;
    }
  }

  // Fuzzy fallback: only when the document has a supplier IČO to anchor on, and
  // it isn't already tied into a group (e.g. a multi-page upload still in
  // progress) — the group's own pages are not candidates for this comparison.
  if (!doc.supplierIc) return;
  const siblings = await tx
    .select()
    .from(billingDocumentsTable)
    .where(
      and(
        ne(billingDocumentsTable.id, doc.id),
        isNull(billingDocumentsTable.primaryDocumentId),
        eq(billingDocumentsTable.supplierIc, doc.supplierIc),
      ),
    );
  const candidateSiblings = siblings.filter(
    (s) => !(doc.mergeGroupId && s.mergeGroupId === doc.mergeGroupId),
  );
  if (!candidateSiblings.length) return;

  const docMatchable = await toMatchableWithLines(tx, doc);
  let best: { sibling: BillingDocument; score: ReturnType<typeof scoreDocumentSimilarity> } | null =
    null;
  for (const sibling of candidateSiblings) {
    const siblingMatchable = await toMatchableWithLines(tx, sibling);
    const score = scoreDocumentSimilarity(docMatchable, siblingMatchable);
    if (!best || score.score > best.score.score) {
      best = { sibling, score };
    }
  }
  if (!best || best.score.score < FUZZY_MERGE_REVIEW_THRESHOLD) return;

  // Same approved-document guard as the identity-match path above: a fuzzy
  // match good enough to auto-merge must never absorb (or be absorbed by) an
  // already-APPROVED sibling — that would silently orphan its already-applied
  // price/warehouse effects. Flag for manual review instead.
  if (best.score.score >= FUZZY_MERGE_AUTO_THRESHOLD && best.sibling.status !== "approved") {
    const other = best.sibling;
    const primary =
      priorityRank(other.sourcePriority) >= priorityRank(doc.sourcePriority) ? other : doc;
    const secondary = primary.id === doc.id ? other : doc;
    await performMergeTx(
      tx,
      primary,
      secondary,
      `Sloučeno s dokladem #${primary.id} (${best.score.reasons.join(", ")}).`,
    );
    return;
  }
  if (best.score.score >= FUZZY_MERGE_AUTO_THRESHOLD && best.sibling.status === "approved") {
    const explanation = `Možná duplicita se schváleným dokladem #${best.sibling.id} – vyžaduje kontrolu (${best.score.reasons.join(", ")}; shoda ${Math.round(best.score.score * 100)} %). Schválený doklad nelze automaticky sloučit.`;
    await tx
      .update(billingDocumentsTable)
      .set({
        status: "needs_review",
        warnings: [doc.warnings, explanation].filter(Boolean).join("\n"),
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentsTable.id, doc.id));
    return;
  }

  // Uncertain: never silently merge or leave as a silent duplicate — flag both
  // sides for a human to decide, with the reasoning that triggered the flag.
  const explanation = `Možná duplicita s dokladem #${best.sibling.id} – vyžaduje kontrolu (${best.score.reasons.join(", ")}; shoda ${Math.round(best.score.score * 100)} %).`;
  await tx
    .update(billingDocumentsTable)
    .set({
      status: "needs_review",
      warnings: [doc.warnings, explanation].filter(Boolean).join("\n"),
      updatedAt: new Date(),
    })
    .where(eq(billingDocumentsTable.id, doc.id));

  if (!REVIEW_TERMINAL_STATUSES.has(best.sibling.status)) {
    const siblingExplanation = `Možná duplicita s dokladem #${doc.id} – vyžaduje kontrolu (${best.score.reasons.join(", ")}; shoda ${Math.round(best.score.score * 100)} %).`;
    await tx
      .update(billingDocumentsTable)
      .set({
        status: "needs_review",
        warnings: [best.sibling.warnings, siblingExplanation].filter(Boolean).join("\n"),
        updatedAt: new Date(),
      })
      .where(eq(billingDocumentsTable.id, best.sibling.id));
  }
}

/**
 * Manually pair `id` as a duplicate of `primaryDocumentId` (the "Spárovat jako
 * duplicitu" action on a heuristically-detected candidate). Unlike the
 * automatic ISDOC/PDF merge, this is admin-initiated and works for any two
 * documents the heuristics flagged as possible duplicates but didn't
 * auto-merge. Reuses `linkAsDuplicateTx` so the outcome (status, file
 * ownership, group id) is identical to an automatic merge.
 */
export async function markDocumentAsDuplicate(
  id: number,
  primaryDocumentId: number,
  actor: Actor,
) {
  if (id === primaryDocumentId) {
    throw appError(400, "Doklad nelze spárovat se sebou samým.");
  }
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  const [primary] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, primaryDocumentId));
  if (!primary) throw appError(404, "Cílový doklad nenalezen.");
  if (doc.primaryDocumentId != null) {
    throw appError(409, "Doklad je již spárován jako duplicita jiného dokladu.");
  }
  if (primary.primaryDocumentId != null) {
    throw appError(
      409,
      "Cílový doklad je sám duplicitou — spárujte na jeho primární doklad.",
    );
  }
  if (doc.status === "approved" || primary.status === "approved") {
    throw appError(
      409,
      "Schválený doklad nelze spárovat jako duplicitu — nejprve zrušte jeho schválení.",
    );
  }
  await assertCompleteBeforeTerminalAction(db, doc, "duplicate");
  await db.transaction((tx) =>
    linkAsDuplicateTx(
      tx,
      primary,
      doc,
      `Ručně spárováno jako duplicita dokladu #${primary.id}${actor.name ? ` (${actor.name})` : ""}.`,
    ),
  );
  return getDocument(id);
}

/**
 * Undo a manual (or automatic) duplicate pairing: the document returns to
 * `needs_review` and its `primaryDocumentId`/`mergeGroupId` are cleared. Files
 * already moved under the primary stay there (each document's own top-level
 * file was never touched), so nothing is lost — the admin can re-pair or
 * upload again if needed.
 */
export async function unmarkDocumentDuplicate(id: number, actor: Actor) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (doc.primaryDocumentId == null && doc.status !== "duplicate") {
    throw appError(409, "Doklad není spárován jako duplicita.");
  }
  await db
    .update(billingDocumentsTable)
    .set({
      status: "needs_review",
      primaryDocumentId: null,
      mergeGroupId: null,
      warnings: [
        doc.warnings,
        doc.primaryDocumentId == null
          ? "Doklad byl obnoven z chybneho stavu duplicity bez primarniho dokladu."
          : "Parovani duplicity bylo zruseno.",
      ]
        .filter(Boolean)
        .join("\n"),
      reviewedByUserId: actor.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(billingDocumentsTable.id, id));
  return getDocument(id);
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
  /** Tags this document as (the first page of) a multi-page group upload. */
  mergeGroupId?: string | null;
  /**
   * When true, don't enqueue the extraction job yet — more pages are coming
   * and extraction should only run once against the complete set of files.
   */
  skipExtractionQueue?: boolean;
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
        mergeGroupId: input.mergeGroupId ?? null,
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

    // Merge a matching ISDOC↔PDF pair into one logical document, and enqueue
    // extraction — both skipped while more pages of the same group upload are
    // still coming (see `ingestGroupFile`), since the group isn't a complete
    // document yet and AI should see every page in a single request.
    if (!input.skipExtractionQueue) {
      await mergeRelatedDocumentsTx(tx, doc, parsed);
      await tx.insert(extractionJobsTable).values({ documentId: doc.id });
    }

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

  await reconcileDocumentRelationshipsSafely(id, actor);
  const detail = await getDocument(id);
  if (!detail) throw appError(500, "Doklad se nepodařilo načíst.");
  return detail.document;
}

export type CreateDocumentResult =
  | { status: "created"; document: SerializedDocument }
  | { status: "duplicate"; duplicates: DuplicateMatch[] };

/**
 * `createDocument`, but safe against a concurrent duplicate insert: the
 * `sha256` unique index is the real source of truth for "does this content
 * already exist", so any caller that creates documents from raw content
 * (upload, job-attachment analysis, e-mail import, ZIP import) should go
 * through this wrapper rather than calling `createDocument` directly. A
 * pre-insert `findDuplicates` check remains useful as a fast path (skip the
 * object-storage write + parsing work), but only this wrapper is race-safe.
 */
export async function createDocumentSafe(
  input: CreateDocumentInput,
  buffer: Buffer | null,
  actor: Actor,
): Promise<CreateDocumentResult> {
  try {
    const document = await createDocument(input, buffer, actor);
    return { status: "created", document };
  } catch (err) {
    if (isDuplicateSha256Violation(err)) {
      const duplicates = await findDuplicates({ sha256: input.sha256 });
      return { status: "duplicate", duplicates };
    }
    throw err;
  }
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

export type IngestFileResult = CreateDocumentResult;

/**
 * Store a file buffer in object storage and create a cost document from it,
 * skipping when its exact content hash already exists (unless `force`). Centralises
 * the dedup → store → createDocument flow so the manual upload route and the
 * automated e-mail importer behave identically (same dedup, same extraction queue).
 *
 * The pre-insert `findDuplicates` check below is only a fast path (skip the
 * object-storage write for an obvious repeat); the actual dedup guarantee
 * comes from the DB-level unique constraint enforced by `createDocumentSafe`,
 * so two concurrent calls with identical content can never both succeed —
 * one always comes back as `{ status: "duplicate" }`, even with `force: true`.
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

  return createDocumentSafe(
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
}

export interface IngestGroupFileInput extends IngestFileInput {
  /** Client-generated token shared by every page of the same multi-page upload. */
  groupToken: string;
  /** True on the last page — triggers the (single) extraction job + merge check. */
  groupComplete: boolean;
}

/**
 * Ingest one page of a multi-page photo upload (task #679): the first call for
 * a given `groupToken` creates the `billing_documents` row (tagged with
 * `mergeGroupId = groupToken`); every subsequent call with the same token
 * attaches another file to that SAME row instead of creating a new document.
 * Extraction is enqueued, and the merge/duplicate check runs, only once —
 * on the call where `groupComplete` is true — so AI sees every page together
 * and merge-matching compares the complete document, not a half-uploaded one.
 */
export async function ingestGroupFile(
  buffer: Buffer,
  input: IngestGroupFileInput,
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

  const [existing] = await db
    .select()
    .from(billingDocumentsTable)
    .where(
      and(
        eq(billingDocumentsTable.mergeGroupId, input.groupToken),
        isNull(billingDocumentsTable.primaryDocumentId),
      ),
    );

  if (!existing) {
    // First page of the group: create the document as usual, just tagged with
    // the group token and (unless this is a single-page "group") deferred
    // extraction/merge.
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
        mergeGroupId: input.groupToken,
        skipExtractionQueue: !input.groupComplete,
      },
      buffer,
      actor,
    );
    return { status: "created", document };
  }

  // A later page of an already-started group: attach the file, don't create a
  // new billing_documents row.
  await db.transaction(async (tx) => {
    await tx.insert(billingDocumentFilesTable).values({
      documentId: existing.id,
      role: "attachment",
      originalFileName: input.fileName,
      mimeType: input.contentType,
      objectPath,
      sha256Hash: hash,
      sizeBytes: buffer.length,
    });

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "update",
      entityType: "billing_documents",
      entityId: existing.id,
      summary: `Přidána další strana dokladu: ${input.fileName}`,
      method: "POST",
      path: "/billing/documents/upload",
    });

    if (input.groupComplete) {
      await mergeRelatedDocumentsTx(tx, existing, null);
      await tx.insert(extractionJobsTable).values({ documentId: existing.id });
    }
  });

  const detail = await getDocument(existing.id);
  if (!detail) throw appError(500, "Doklad se nepodařilo načíst.");
  return { status: "created", document: detail.document };
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

async function documentIdsLinkedToJob(jobId: number): Promise<number[]> {
  const ids = new Set<number>();

  const directRows = await db
    .select({ id: billingDocumentsTable.id, primaryDocumentId: billingDocumentsTable.primaryDocumentId })
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.jobId, jobId));
  for (const row of directRows) {
    ids.add(row.id);
    if (row.primaryDocumentId != null) ids.add(row.primaryDocumentId);
  }

  const lineRows = await db
    .select({
      documentId: billingDocumentLinesTable.documentId,
      primaryDocumentId: billingDocumentsTable.primaryDocumentId,
    })
    .from(billingDocumentLinesTable)
    .innerJoin(
      billingDocumentsTable,
      eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id),
    )
    .where(eq(billingDocumentLinesTable.jobId, jobId));
  for (const row of lineRows) {
    ids.add(row.documentId);
    if (row.primaryDocumentId != null) ids.add(row.primaryDocumentId);
  }

  const materialRows = await db
    .select({
      documentId: billingDocumentLinesTable.documentId,
      primaryDocumentId: billingDocumentsTable.primaryDocumentId,
    })
    .from(materialsTable)
    .innerJoin(
      billingDocumentLinesTable,
      eq(materialsTable.sourceId, billingDocumentLinesTable.id),
    )
    .innerJoin(
      billingDocumentsTable,
      eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id),
    )
    .where(
      and(
        eq(materialsTable.jobId, jobId),
        eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
        isNotNull(materialsTable.sourceId),
      ),
    );
  for (const row of materialRows) {
    ids.add(row.documentId);
    if (row.primaryDocumentId != null) ids.add(row.primaryDocumentId);
  }

  const attachmentRows = await db
    .select({
      documentId: billingDocumentsTable.id,
      primaryDocumentId: billingDocumentsTable.primaryDocumentId,
    })
    .from(attachmentsTable)
    .innerJoin(
      billingDocumentsTable,
      or(
        eq(attachmentsTable.url, billingDocumentsTable.objectPath),
        and(
          isNotNull(attachmentsTable.fileName),
          eq(attachmentsTable.fileName, billingDocumentsTable.fileName),
        ),
      ),
    )
    .where(
      and(
        eq(attachmentsTable.jobId, jobId),
        inArray(attachmentsTable.type, Array.from(DOKLAD_TYPES)),
      ),
    );
  for (const row of attachmentRows) {
    ids.add(row.documentId);
    if (row.primaryDocumentId != null) ids.add(row.primaryDocumentId);
  }

  return Array.from(ids);
}

export async function listDocuments(filters: DocumentFilters) {
  const conds = [];
  if (filters.status) {
    conds.push(eq(billingDocumentsTable.status, filters.status));
  } else {
    // Confirmed duplicates are folded into their primary document and no
    // longer need review — keep them out of the default (unfiltered) list.
    // They're still reachable via the explicit "duplicate" status filter.
    conds.push(
      or(
        ne(billingDocumentsTable.status, "duplicate"),
        isNull(billingDocumentsTable.primaryDocumentId),
      ),
    );
  }
  if (filters.supplierIc)
    conds.push(eq(billingDocumentsTable.supplierIc, filters.supplierIc));
  if (filters.jobId != null) {
    const linkedIds = await documentIdsLinkedToJob(filters.jobId);
    if (linkedIds.length === 0) {
      return [];
    }
    conds.push(inArray(billingDocumentsTable.id, linkedIds));
  }
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

  // Aggregate the per-document material state in one extra query (the list rows
  // carry no lines). Group the relevant line columns in JS and derive the badge
  // state per document.
  const stateById = new Map<number, MaterialState>();
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const lineRows = await db
      .select({
        documentId: billingDocumentLinesTable.documentId,
        lineType: billingDocumentLinesTable.lineType,
        feeType: billingDocumentLinesTable.feeType,
        matchConfirmed: billingDocumentLinesTable.matchConfirmed,
        approved: billingDocumentLinesTable.approved,
      })
      .from(billingDocumentLinesTable)
      .where(inArray(billingDocumentLinesTable.documentId, ids));
    const grouped = new Map<number, typeof lineRows>();
    for (const lr of lineRows) {
      const arr = grouped.get(lr.documentId) ?? [];
      arr.push(lr);
      grouped.set(lr.documentId, arr);
    }
    for (const [docId, ls] of grouped)
      stateById.set(docId, deriveMaterialState(ls));
  }

  return rows.map((r) => serializeDocument(r, stateById.get(r.id) ?? null));
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

  const heuristicDuplicates = await findDuplicates({
    sha256: doc.sha256,
    supplierIc: doc.supplierIc,
    supplierName: doc.supplierName,
    documentNumber: doc.documentNumber,
    variableSymbol: doc.variableSymbol,
    issueDate: doc.issueDate,
    totalWithVat: doc.totalWithVat == null ? null : num(doc.totalWithVat),
    excludeId: doc.id,
  });

  // Documents already manually/automatically paired with this one (either
  // direction) are no longer "possible" duplicates — they're confirmed. Keep
  // the heuristic candidate list free of them so the review UI only ever
  // offers a pairing action for genuinely unresolved candidates.
  const linkedIds = await db
    .select({ id: billingDocumentsTable.id })
    .from(billingDocumentsTable)
    .where(
      or(
        eq(billingDocumentsTable.primaryDocumentId, doc.id),
        doc.primaryDocumentId != null
          ? eq(billingDocumentsTable.id, doc.primaryDocumentId)
          : sql`false`,
      ),
    );
  const linkedIdSet = new Set(linkedIds.map((l) => l.id));
  const duplicates = heuristicDuplicates.filter((d) => !linkedIdSet.has(d.id));

  // Duplicates actually paired with this document — this doc is the primary.
  const linkedDuplicateRows = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.primaryDocumentId, doc.id))
    .orderBy(billingDocumentsTable.id);

  // Files for each linked duplicate, so they can be previewed inline on the
  // primary document's page without navigating away.
  const linkedDuplicateFilesByDocId = new Map<number, (typeof billingDocumentFilesTable.$inferSelect)[]>();
  if (linkedDuplicateRows.length > 0) {
    const linkedDuplicateFileRows = await db
      .select()
      .from(billingDocumentFilesTable)
      .where(
        inArray(
          billingDocumentFilesTable.documentId,
          linkedDuplicateRows.map((d) => d.id),
        ),
      )
      .orderBy(billingDocumentFilesTable.id);
    for (const f of linkedDuplicateFileRows) {
      const list = linkedDuplicateFilesByDocId.get(f.documentId) ?? [];
      list.push(f);
      linkedDuplicateFilesByDocId.set(f.documentId, list);
    }
  }

  const linkedDuplicates = linkedDuplicateRows.map((d) => ({
    id: d.id,
    reason: "Ručně/automaticky spárováno jako duplicita",
    documentNumber: d.documentNumber,
    supplierName: d.supplierName,
    totalWithVat: d.totalWithVat,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    files: [
      ...ownFile(d),
      ...(linkedDuplicateFilesByDocId.get(d.id) ?? []).map(serializeFile),
    ],
  }));

  // If this document itself is a duplicate, surface a summary of its primary
  // so the detail page can show "this is a duplicate of #X" with a link.
  let duplicateOf: {
    id: number;
    reason: string;
    documentNumber: string | null;
    supplierName: string | null;
    totalWithVat: string | null;
    status: string;
    createdAt: string;
    files: ReturnType<typeof serializeFile>[];
  } | null = null;
  if (doc.primaryDocumentId != null) {
    const [primaryDoc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, doc.primaryDocumentId));
    if (primaryDoc) {
      const primaryFiles = await db
        .select()
        .from(billingDocumentFilesTable)
        .where(eq(billingDocumentFilesTable.documentId, primaryDoc.id))
        .orderBy(billingDocumentFilesTable.id);
      duplicateOf = {
        id: primaryDoc.id,
        reason: "Primární doklad",
        documentNumber: primaryDoc.documentNumber,
        supplierName: primaryDoc.supplierName,
        totalWithVat: primaryDoc.totalWithVat,
        status: primaryDoc.status,
        createdAt: primaryDoc.createdAt.toISOString(),
        files: [...ownFile(primaryDoc), ...primaryFiles.map(serializeFile)],
      };
    }
  }

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
    document: serializeDocument(doc, deriveMaterialState(lines)),
    lines: lines.map(serializeLine),
    duplicates,
    linkedDuplicates,
    duplicateOf,
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
    files: files.map(serializeFile),
  };
}

function serializeFile(f: typeof billingDocumentFilesTable.$inferSelect) {
  return {
    id: f.id,
    documentId: f.documentId,
    role: f.role,
    originalFileName: f.originalFileName,
    mimeType: f.mimeType,
    objectPath: f.objectPath,
    sizeBytes: f.sizeBytes,
    createdAt: f.createdAt.toISOString(),
  };
}

/**
 * Every document has its own top-level `objectPath`/`fileName` (the file it
 * was originally ingested with), untouched by duplicate-pairing (only the
 * extra role-tagged `billingDocumentFilesTable` rows get moved to the
 * primary — see `linkAsDuplicateTx`). Surface that own file alongside any
 * moved-in files so a duplicate's file is always previewable, even for a
 * plain single-file document with no `billingDocumentFilesTable` rows.
 * Returns an array (0 or 1 items) so call sites can spread it.
 */
function ownFile(d: {
  id: number;
  objectPath: string | null;
  fileName: string | null;
  contentType: string | null;
  createdAt: Date;
}): ReturnType<typeof serializeFile>[] {
  if (!d.objectPath) return [];
  return [
    {
      id: -d.id,
      documentId: d.id,
      role: "primary",
      originalFileName: d.fileName,
      mimeType: d.contentType,
      objectPath: d.objectPath,
      sizeBytes: null,
      createdAt: d.createdAt.toISOString(),
    },
  ];
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
  await reconcileDocumentRelationshipsSafely(documentId, SYSTEM_ACTOR);
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
  actor: Actor = SYSTEM_ACTOR,
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
  await reconcileDocumentRelationshipsSafely(documentId, actor);
  if (input.matchConfirmed === true) {
    await refreshApprovedDocumentPropagation(documentId, actor);
  }
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

export interface DocumentMatchSuggestion {
  documentId: number;
  documentNumber: string | null;
  docType: string;
  score: number;
  strength: string;
  reasons: string[];
  exactReferenceMatch: boolean;
}

const INVOICE_DOCUMENT_TYPES = new Set(["invoice", "credit_note"]);
const EXCLUDED_MATCH_STATUSES = new Set(["duplicate", "ignored"]);

function normalized(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeReferenceNumber(value) || null;
}

function hasExactDeliveryNoteReference(
  deliveryNote: BillingDocument,
  invoice: BillingDocument,
  invoiceRefs: BillingDocumentReference[],
): boolean {
  const deliveryNumber =
    normalized(deliveryNote.deliveryNoteNumber) ??
    normalized(deliveryNote.documentNumber);
  if (!deliveryNumber) return false;
  if (normalized(invoice.deliveryNoteNumber) === deliveryNumber) return true;
  return invoiceRefs.some(
    (ref) =>
      (ref.referenceType === "delivery_note" ||
        ref.referenceType === "summary_delivery_note" ||
        ref.referenceType === "delivery") &&
      normalized(ref.referenceNumber) === deliveryNumber,
  );
}

async function findDocumentMatchSuggestions(
  documentId: number,
  executor: DbOrTx = db,
): Promise<DocumentMatchSuggestion[]> {
  const [doc] = await executor
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (doc.primaryDocumentId != null || EXCLUDED_MATCH_STATUSES.has(doc.status)) {
    return [];
  }
  const docIsInvoice = INVOICE_DOCUMENT_TYPES.has(doc.docType);
  const docIsDeliveryNote = doc.docType === "delivery_note";
  if (!docIsInvoice && !docIsDeliveryNote) return [];

  const refs = await executor
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, documentId));
  const others = (
    await executor
      .select()
      .from(billingDocumentsTable)
      .where(
        and(
          ne(billingDocumentsTable.id, documentId),
          isNull(billingDocumentsTable.primaryDocumentId),
        ),
      )
  ).filter(
    (other) =>
      !EXCLUDED_MATCH_STATUSES.has(other.status) &&
      (docIsInvoice
        ? other.docType === "delivery_note"
        : INVOICE_DOCUMENT_TYPES.has(other.docType)),
  );

  const otherIds = others.map((other) => other.id);
  const allOtherRefs = otherIds.length
    ? await executor
        .select()
        .from(billingDocumentReferencesTable)
        .where(inArray(billingDocumentReferencesTable.documentId, otherIds))
    : [];
  const refsByDocument = new Map<number, BillingDocumentReference[]>();
  for (const ref of allOtherRefs) {
    const group = refsByDocument.get(ref.documentId) ?? [];
    group.push(ref);
    refsByDocument.set(ref.documentId, group);
  }

  const toMatchable = (
    candidate: BillingDocument,
    candidateRefs: BillingDocumentReference[],
  ): MatchableDocument => ({
    id: candidate.id,
    supplierIc: candidate.supplierIc,
    documentNumber: candidate.documentNumber,
    deliveryNoteNumber: candidate.deliveryNoteNumber,
    orderNumber: candidate.orderNumber,
    totalWithoutVat:
      candidate.subtotalWithoutVat == null ? null : num(candidate.subtotalWithoutVat),
    totalWithVat:
      candidate.totalWithVat == null ? null : num(candidate.totalWithVat),
    issueDate: candidate.issueDate,
    references: candidateRefs.map((ref) => ({
      referenceType: ref.referenceType,
      referenceNumber: ref.referenceNumber,
    })),
  });

  const self = toMatchable(doc, refs);
  const results: DocumentMatchSuggestion[] = [];
  for (const other of others) {
    const otherRefs = refsByDocument.get(other.id) ?? [];
    const scored = docIsInvoice
      ? scoreDeliveryNoteToInvoice(toMatchable(other, otherRefs), self)
      : scoreDeliveryNoteToInvoice(self, toMatchable(other, otherRefs));
    if (scored.score <= 0) continue;

    const deliveryNote = docIsInvoice ? other : doc;
    const invoice = docIsInvoice ? doc : other;
    const invoiceRefs = docIsInvoice ? refs : otherRefs;
    results.push({
      documentId: other.id,
      documentNumber: other.documentNumber,
      docType: other.docType,
      score: scored.score,
      strength: scored.strength,
      reasons: scored.reasons,
      exactReferenceMatch: hasExactDeliveryNoteReference(
        deliveryNote,
        invoice,
        invoiceRefs,
      ),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Find sibling cost documents (delivery notes ↔ invoices) that score as a
 * likely match for this document. Suggestion only — surfaced in the UI so an
 * admin can link them. Never writes.
 */
export async function suggestDocumentMatches(documentId: number) {
  return findDocumentMatchSuggestions(documentId);
}

export interface DocumentRelationshipReconciliationResult {
  documentId: number;
  suggestions: DocumentMatchSuggestion[];
  linkedDocumentIds: number[];
  confirmedDocumentIds: number[];
}

export interface DocumentRelationshipBackfillResult {
  processed: number;
  withLinks: number;
  withConfirmedLinks: number;
  failedDocumentIds: number[];
}

async function deliveryNoteJobId(
  tx: DbOrTx,
  deliveryNote: BillingDocument,
): Promise<number | null> {
  if (deliveryNote.jobId != null) return deliveryNote.jobId;
  const refs = await tx
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, deliveryNote.id));
  const jobIds = new Set<number>();
  for (const ref of refs) {
    if (ref.matchConfirmed === 1 && ref.matchedJobId != null) {
      jobIds.add(ref.matchedJobId);
    }
  }
  return jobIds.size === 1 ? (jobIds.values().next().value ?? null) : null;
}

async function persistDocumentRelationship(
  documentId: number,
  suggestion: DocumentMatchSuggestion,
  actor: Actor,
): Promise<{ linked: boolean; confirmed: boolean }> {
  const cfg = await resolveDocumentLinkingConfig();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [documentId, suggestion.documentId]));
    const current = rows.find((row) => row.id === documentId);
    const other = rows.find((row) => row.id === suggestion.documentId);
    if (!current || !other) return { linked: false, confirmed: false };

    const currentIsInvoice = INVOICE_DOCUMENT_TYPES.has(current.docType);
    const invoice = currentIsInvoice ? current : other;
    const deliveryNote = currentIsInvoice ? other : current;
    if (
      !INVOICE_DOCUMENT_TYPES.has(invoice.docType) ||
      deliveryNote.docType !== "delivery_note"
    ) {
      return { linked: false, confirmed: false };
    }

    const lockA = Math.min(invoice.id, deliveryNote.id);
    const lockB = Math.max(invoice.id, deliveryNote.id);
    await tx.execute(sql`select pg_advisory_xact_lock(${lockA}, ${lockB})`);

    const linkNumber =
      deliveryNote.deliveryNoteNumber?.trim() ??
      deliveryNote.documentNumber?.trim() ??
      null;
    if (!linkNumber) return { linked: false, confirmed: false };

    const invoiceRefs = await tx
      .select()
      .from(billingDocumentReferencesTable)
      .where(eq(billingDocumentReferencesTable.documentId, invoice.id));
    const linkKey = normalized(linkNumber);
    const relevantRefs = invoiceRefs.filter(
      (ref) =>
        ref.matchedDocumentId === deliveryNote.id ||
        normalized(ref.referenceNumber) === linkKey,
    );
    if (relevantRefs.some((ref) => ref.rejected === 1)) {
      return { linked: false, confirmed: false };
    }

    const existing =
      relevantRefs.find((ref) => ref.matchedDocumentId === deliveryNote.id) ??
      relevantRefs[0];
    if (
      existing?.matchConfirmed === 1 &&
      existing.matchedDocumentId != null &&
      existing.matchedDocumentId !== deliveryNote.id
    ) {
      return { linked: false, confirmed: false };
    }
    if (
      existing?.matchedDocumentId != null &&
      existing.matchedDocumentId !== deliveryNote.id &&
      num(existing.matchConfidence) >= suggestion.score
    ) {
      return { linked: false, confirmed: false };
    }

    const matchedJobId = await deliveryNoteJobId(tx, deliveryNote);
    const autoConfirmed =
      cfg.autoConfirmEnabled && suggestion.score >= cfg.autoConfirmMinScore;
    const confirmed = existing?.matchConfirmed === 1 || autoConfirmed;
    const nextMatchedJobId =
      existing?.matchConfirmed === 1
        ? existing.matchedJobId
        : (matchedJobId ?? existing?.matchedJobId ?? null);
    const nextConfidence = String(suggestion.score);
    if (
      existing?.matchedDocumentId === deliveryNote.id &&
      existing.matchedJobId === nextMatchedJobId &&
      num(existing.matchConfidence) === suggestion.score &&
      existing.matchConfirmed === (confirmed ? 1 : 0)
    ) {
      return { linked: true, confirmed };
    }

    if (existing) {
      await tx
        .update(billingDocumentReferencesTable)
        .set({
          matchedDocumentId: deliveryNote.id,
          matchedJobId: nextMatchedJobId,
          matchConfidence: nextConfidence,
          matchConfirmed: confirmed ? 1 : 0,
          updatedAt: new Date(),
        })
        .where(eq(billingDocumentReferencesTable.id, existing.id));
    } else {
      await tx.insert(billingDocumentReferencesTable).values({
        documentId: invoice.id,
        referenceType: "delivery_note",
        referenceNumber: linkNumber,
        source: "automatic_match",
        confidence: nextConfidence,
        matchedDocumentId: deliveryNote.id,
        matchedJobId,
        matchConfidence: nextConfidence,
        matchConfirmed: confirmed ? 1 : 0,
      });
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: confirmed ? "auto_link_confirmed" : "auto_link_suggested",
      entityType: "billing_documents",
      entityId: invoice.id,
      summary: `Doklad automaticky propojen s dodacím listem #${deliveryNote.id} (shoda ${Math.round(
        suggestion.score * 100,
      )} %).`,
      method: "SYSTEM",
      path: `/billing/documents/${invoice.id}`,
    });
    return { linked: true, confirmed };
  });
}

export async function reconcileDocumentRelationships(
  documentId: number,
  actor: Actor = SYSTEM_ACTOR,
): Promise<DocumentRelationshipReconciliationResult> {
  await matchDocumentReferences(documentId);
  const cfg = await resolveDocumentLinkingConfig();
  const suggestions = await findDocumentMatchSuggestions(documentId);
  const selected = cfg.autoLinkEnabled
    ? selectAutomaticDocumentMatches(suggestions, cfg.autoLinkMinScore)
    : [];
  const linkedDocumentIds: number[] = [];
  const confirmedDocumentIds: number[] = [];

  for (const suggestion of selected) {
    const result = await persistDocumentRelationship(documentId, suggestion, actor);
    if (result.linked) linkedDocumentIds.push(suggestion.documentId);
    if (result.confirmed) {
      confirmedDocumentIds.push(suggestion.documentId);
      await refreshApprovedDocumentPropagation(documentId, actor);
      await refreshApprovedDocumentPropagation(suggestion.documentId, actor);
    }
  }
  return { documentId, suggestions, linkedDocumentIds, confirmedDocumentIds };
}

async function reconcileDocumentRelationshipsSafely(
  documentId: number,
  actor: Actor,
): Promise<void> {
  try {
    await reconcileDocumentRelationships(documentId, actor);
  } catch (error) {
    logger.error(
      { err: error, documentId },
      "Automatic billing-document relationship reconciliation failed",
    );
  }
}

/**
 * Reconcile every historical invoice against all delivery notes. Re-running is
 * safe: relationship writes and price propagation are idempotent, and manual
 * confirmations/rejections are preserved.
 */
export async function reconcileAllDocumentRelationships(
  actor: Actor = SYSTEM_ACTOR,
): Promise<DocumentRelationshipBackfillResult> {
  const documents = await db
    .select({ id: billingDocumentsTable.id })
    .from(billingDocumentsTable)
    .where(
      and(
        inArray(billingDocumentsTable.docType, ["invoice", "credit_note"]),
        isNull(billingDocumentsTable.primaryDocumentId),
        ne(billingDocumentsTable.status, "duplicate"),
        ne(billingDocumentsTable.status, "ignored"),
      ),
    )
    .orderBy(asc(billingDocumentsTable.id));

  let withLinks = 0;
  let withConfirmedLinks = 0;
  const failedDocumentIds: number[] = [];
  for (const document of documents) {
    try {
      const result = await reconcileDocumentRelationships(document.id, actor);
      if (result.linkedDocumentIds.length > 0) withLinks++;
      if (result.confirmedDocumentIds.length > 0) withConfirmedLinks++;
    } catch (error) {
      failedDocumentIds.push(document.id);
      logger.error(
        { err: error, documentId: document.id },
        "Historical billing-document reconciliation failed",
      );
    }
  }
  return {
    processed: documents.length,
    withLinks,
    withConfirmedLinks,
    failedDocumentIds,
  };
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

  if (input.jobId != null) {
    const [job] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, input.jobId));
    if (!job)
      throw appError(
        400,
        "Vybraná zakázka již neexistuje. Obnovte stránku a vyberte ji znovu.",
      );
  }
  if (input.customerId != null) {
    const [customer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.id, input.customerId));
    if (!customer)
      throw appError(
        400,
        "Vybraný zákazník již neexistuje. Obnovte stránku a vyberte ho znovu.",
      );
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
  await reconcileDocumentRelationshipsSafely(id, SYSTEM_ACTOR);
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
  activityId?: number | null;
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
    if (input.jobId !== undefined) {
      patch.jobId = input.jobId;
      // Mutually exclusive: setting a job clears the activity assignment.
      if (input.jobId != null) patch.activityId = null;
    }
    if (input.activityId !== undefined) {
      patch.activityId = input.activityId;
      // Mutually exclusive: setting an activity clears the job assignment.
      if (input.activityId != null) patch.jobId = null;
    }
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
    // Undo any invoice-price fill this document previously made onto another
    // document's (delivery-note) material before recomputing from the current
    // line data — an edited price/quantity/job must not leave a stale fill
    // hanging, and a line that drops out of eligibility (price zeroed,
    // reassigned, etc.) must revert its target back to "awaiting invoice"
    // (NULL price, see revertInvoicePricePropagation). Cheap no-op when this
    // document never filled anything.
    await revertInvoicePricePropagation(tx, documentId, actor);
    const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(
      tx,
      documentId,
      actor,
    );
    // Keep the job's materials in sync when editing a line of an approved doc;
    // exclude the lines just consumed above so this document's own sync does
    // not also create a duplicate material for the same line.
    await syncJobMaterialsForDocument(tx, documentId, actor, {
      excludeSourceLineIds: consumedLineIds,
    });
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
  activityId?: number | null;
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
    const orphanActivityMaterials = await tx
      .select({ id: activityMaterialsTable.id })
      .from(activityMaterialsTable)
      .where(
        and(
          eq(activityMaterialsTable.sourceType, MATERIAL_SOURCE_TYPE),
          eq(activityMaterialsTable.sourceId, lineId),
        ),
      );
    for (const m of orphanActivityMaterials) {
      await reconcileSourceMovements(tx, "activity_material", m.id, null, actor);
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
    await tx.delete(activityMaterialsTable).where(
      and(
        eq(activityMaterialsTable.sourceType, MATERIAL_SOURCE_TYPE),
        eq(activityMaterialsTable.sourceId, lineId),
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
      // Resolve jobId / activityId with mutual exclusion.
      // Part-level setting takes priority; fall back to the original line's values
      // only when the part carries neither override.
      const hasPartJobOrActivity = p.jobId !== undefined || p.activityId !== undefined;
      const resolvedJobId = hasPartJobOrActivity
        ? (p.activityId != null ? null : (p.jobId ?? null))
        : (line.activityId != null ? null : (line.jobId ?? null));
      const resolvedActivityId = hasPartJobOrActivity
        ? (p.jobId != null ? null : (p.activityId ?? null))
        : (line.jobId != null ? null : (line.activityId ?? null));
      return {
        ...vals,
        parentLineId: null,
        jobId: resolvedJobId,
        activityId: resolvedActivityId,
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

async function confirmedTargetJobIds(
  tx: DbOrTx,
  doc: BillingDocument,
): Promise<Set<number>> {
  const jobIds = new Set<number>();
  if (doc.jobId != null) jobIds.add(doc.jobId);
  const refs = await tx
    .select()
    .from(billingDocumentReferencesTable)
    .where(eq(billingDocumentReferencesTable.documentId, doc.id));
  const linkedDocumentIds: number[] = [];
  for (const ref of refs) {
    if (ref.matchConfirmed !== 1) continue;
    if (ref.matchedJobId != null) jobIds.add(ref.matchedJobId);
    if (ref.matchedDocumentId != null) linkedDocumentIds.push(ref.matchedDocumentId);
  }
  if (linkedDocumentIds.length === 0) return jobIds;

  const linkedDocuments = await tx
    .select()
    .from(billingDocumentsTable)
    .where(inArray(billingDocumentsTable.id, linkedDocumentIds));
  for (const linkedDocument of linkedDocuments) {
    if (linkedDocument.jobId != null) jobIds.add(linkedDocument.jobId);
  }
  const linkedRefs = await tx
    .select()
    .from(billingDocumentReferencesTable)
    .where(inArray(billingDocumentReferencesTable.documentId, linkedDocumentIds));
  for (const ref of linkedRefs) {
    if (ref.matchConfirmed === 1 && ref.matchedJobId != null) {
      jobIds.add(ref.matchedJobId);
    }
  }
  return jobIds;
}

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
 * job — to a SINGLE job derived from confirmed references or their linked
 * delivery notes. Ambiguous links get no fallback, mirroring the target set of
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
    const targetJobIds = await confirmedTargetJobIds(tx, doc);
    if (targetJobIds.size === 1) {
      fallbackJobId = targetJobIds.values().next().value ?? null;
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
  const existingActivity = lineIds.length
    ? await tx
        .select()
        .from(activityMaterialsTable)
        .where(
          and(
            eq(activityMaterialsTable.sourceType, MATERIAL_SOURCE_TYPE),
            inArray(activityMaterialsTable.sourceId, lineIds),
          ),
        )
    : [];
  const desired = new Set<number>();
  const desiredActivity = new Set<number>();
  const affectedMaterialIds = new Set<number>();
  const affectedActivityMaterialIds = new Set<number>();
  // Materials already issued on a customer invoice are frozen: a re-sync
  // (e.g. "Aktualizovat ceny" or a bulk-confirm re-run on the same approved
  // document) must never rewrite their price nor delete them, even though
  // their sourceId still ties them to this document's line.
  const invoicedBySourceId = new Map(
    existing.filter((m) => m.invoicedInvoiceId != null).map((m) => [m.sourceId, m]),
  );

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

      // Activity-assigned lines: propagate to activity_materials, not job materials.
      if (line.activityId != null) {
        desiredActivity.add(line.id);
        const priceNum =
          line.unitPriceWithoutVat == null ? 0 : num(line.unitPriceWithoutVat);
        const hasPrice = priceNum > 0;
        const warehouseItemId = await resolveWarehouseItemIdByName(tx, line.description);
        const actValues = {
          activityId: line.activityId,
          name: line.description,
          quantity:
            line.quantity == null ? null : String(round2(num(line.quantity))),
          unit: line.unit ?? null,
          pricePerUnit:
            isInvoiceDoc || hasPrice ? String(round2(priceNum)) : null,
          warehouseItemId,
        };
        const [upserted] = await tx
          .insert(activityMaterialsTable)
          .values({
            ...actValues,
            sourceType: MATERIAL_SOURCE_TYPE,
            sourceId: line.id,
          })
          .onConflictDoUpdate({
            target: [activityMaterialsTable.sourceType, activityMaterialsTable.sourceId],
            targetWhere: isNotNull(activityMaterialsTable.sourceType),
            set: actValues,
          })
          .returning({ id: activityMaterialsTable.id });
        if (upserted) affectedActivityMaterialIds.add(upserted.id);
        continue;
      }

      const jobId = line.jobId ?? fallbackJobId;
      if (jobId == null) continue;

      desired.add(line.id);
      // Frozen: this line's material is already on an issued customer
      // invoice — keep it as-is (still "desired" so it survives the
      // toDelete pass below, but never rewritten).
      if (invoicedBySourceId.has(line.id)) {
        affectedMaterialIds.add(invoicedBySourceId.get(line.id)!.id);
        continue;
      }
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
      // Resolve stable FK to warehouse card for unambiguous matches.
      const warehouseItemId = await resolveWarehouseItemIdByName(tx, line.description);
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
        warehouseItemId,
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

  // Never delete a material already issued on a customer invoice — e.g. when
  // the document is un-approved after invoicing, its lines drop out of
  // `desired` entirely, but the billed material must survive for audit and
  // to keep the invoice's job-material trail intact.
  const toDelete = existing
    .filter(
      (m) =>
        m.invoicedInvoiceId == null && (m.sourceId == null || !desired.has(m.sourceId)),
    )
    .map((m) => m.id);
  if (toDelete.length) {
    // Reverse the stock issue of each propagated material before removing it,
    // then drop the material rows.
    for (const materialId of toDelete) {
      await reconcileSourceMovements(tx, "material", materialId, null, actor);
    }
    await tx.delete(materialsTable).where(inArray(materialsTable.id, toDelete));
  }

  const activityToDelete = existingActivity
    .filter((m) => m.sourceId == null || !desiredActivity.has(m.sourceId))
    .map((m) => m.id);
  if (activityToDelete.length) {
    for (const materialId of activityToDelete) {
      await reconcileSourceMovements(tx, "activity_material", materialId, null, actor);
    }
    await tx
      .delete(activityMaterialsTable)
      .where(inArray(activityMaterialsTable.id, activityToDelete));
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
  for (const materialId of affectedActivityMaterialIds) {
    const [m] = await tx
      .select()
      .from(activityMaterialsTable)
      .where(eq(activityMaterialsTable.id, materialId));
    await reconcileActivityMaterialStockMovement(
      tx,
      m
        ? {
            id: m.id,
            name: m.name,
            quantity: m.quantity,
            pricePerUnit: m.pricePerUnit,
            jobId: null,
            warehouseItemId: m.warehouseItemId,
          }
        : null,
      actor,
    );
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
  const targetJobIds = await confirmedTargetJobIds(tx, doc);
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
  // A material already issued on a CUSTOMER invoice (invoicedInvoiceId set) is
  // frozen — its billed price must never be rewritten by a later approval or
  // review-queue confirmation. It still stays in the match pool below so a
  // matching invoice line is correctly consumed (see consumedLineIds); dropping
  // it here would leave the line "unconsumed" and cause
  // syncJobMaterialsForDocument to create a brand-new duplicate material for
  // the same item.
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

    // A material already billed to the customer is frozen: ANY later
    // matching invoice line (even a different, later-arriving supplier
    // invoice) must consume the line so `syncJobMaterialsForDocument` never
    // creates a duplicate material for the same item — but the frozen
    // material's price/provenance must never be rewritten. This check must
    // run BEFORE the "different invoice line" stability check below, or a
    // frozen material that was originally priced by one invoice line would
    // fail to consume a different invoice line matching it later.
    if (m.invoicedInvoiceId != null) {
      usedMaterialIds.add(m.id);
      consumedLineIds.add(line.id);
      continue;
    }

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

async function refreshApprovedDocumentPropagation(
  documentId: number,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId));
    if (
      !doc ||
      doc.status !== "approved" ||
      !INVOICE_DOCUMENT_TYPES.has(doc.docType)
    ) {
      return;
    }
    const propagation = await propagateInvoicePricesToJobMaterials(
      tx,
      documentId,
      actor,
    );
    await syncJobMaterialsForDocument(tx, documentId, actor, {
      excludeSourceLineIds: propagation.consumedLineIds,
    });
    await reconcileDocumentStockMovements(tx, documentId, actor);
  });
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
    // Task #685 (risk #5): a document already merged away as a duplicate
    // (status="duplicate", primaryDocumentId set) must never be approved
    // directly — its lines are dead weight kept only for traceability. If it
    // were approved here it would run the SAME price-propagation/material
    // sync/warehouse-movement pipeline as the primary that absorbed it,
    // double-writing stock and prices for what is logically one document.
    if (doc.status === "duplicate") {
      throw appError(
        409,
        doc.primaryDocumentId
          ? `Doklad je sloučen jako duplicita dokladu #${doc.primaryDocumentId} – schvalte tento hlavní doklad, ne duplicitu.`
          : "Doklad je označen jako duplicita a nelze jej samostatně schválit.",
      );
    }
    await assertCompleteBeforeTerminalAction(tx, doc, "approve");
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
    const { updated: priceUpdates } = await applyWarehouseCatalogAndPriceHistory(tx, id, actor);
    // Backfill costPriceAtTime on OUT movements for the same items that were
    // created on or after the invoice date and still have the field null.
    // This reduces the "chybí cena pohybu" count without any manual effort.
    if (doc.issueDate && priceUpdates.length > 0) {
      await backfillOutMovementCostPrices(
        tx,
        priceUpdates.map((u) => ({ warehouseItemId: u.warehouseItemId, purchasePrice: u.newPrice })),
        new Date(doc.issueDate),
        doc.documentNumber ? `dokladu ${doc.documentNumber}` : "schváleného nákladového dokladu",
      );
    }
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
  matchedBy: "code" | "name" | "created";
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
): Promise<{ updated: WarehousePriceUpdate[]; skipped: number; created: number }> {
  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  const updated: WarehousePriceUpdate[] = [];
  let skipped = 0;
  let created = 0;
  if (!doc || doc.status !== "approved") return { updated, skipped, created };

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
    let matchedBy: "code" | "name" | "created" = "code";
    if (!item) {
      item = byName.get(line.description.trim().toLowerCase());
      matchedBy = "name";
    }
    const newPrice = round2(num(line.unitPriceWithoutVat));
    let oldPrice: number | null = null;
    if (item) {
      oldPrice = item.purchasePrice == null ? null : num(item.purchasePrice);
      // Fill catalogue fields only when empty (never clobber operator data).
      const catalogue: Record<string, string> = {};
      if (!item.ean && line.ean) catalogue.ean = line.ean;
      if (!item.supplierSku && line.supplierSku)
        catalogue.supplierSku = line.supplierSku;
      if (!item.supplierName && doc.supplierName)
        catalogue.supplierName = doc.supplierName;
      if (!item.supplierIc && doc.supplierIc)
        catalogue.supplierIc = doc.supplierIc;
      if (!item.manufacturer && line.manufacturer)
        catalogue.manufacturer = line.manufacturer;
      if (!item.normalizedName)
        catalogue.normalizedName = normalizeItemName(item.name);
      await tx
        .update(warehouseItemsTable)
        .set({ purchasePrice: String(newPrice), ...catalogue })
        .where(eq(warehouseItemsTable.id, item.id));
    } else {
      // No matching warehouse card yet — auto-create one so "Aktualizovat ceny"
      // also zakládá chybějící skladové karty instead of silently skipping the
      // line. Catalogue card only: quantity stays 0 and NO stock movement is
      // created — a rebill / job material is not received into stock, so we
      // never fabricate a příjem here.
      matchedBy = "created";
      const code = (line.supplierSku ?? line.ean ?? "")?.trim() || null;
      const [createdItem] = await tx
        .insert(warehouseItemsTable)
        .values({
          name: line.description,
          code,
          unit: line.unit ?? null,
          quantity: "0",
          purchasePrice: String(newPrice),
          ean: line.ean ?? null,
          supplierSku: line.supplierSku ?? null,
          supplierName: doc.supplierName ?? null,
          supplierIc: doc.supplierIc ?? null,
          manufacturer: line.manufacturer ?? null,
          normalizedName: normalizeItemName(line.description),
        })
        .returning();
      if (!createdItem) {
        skipped++;
        continue;
      }
      item = createdItem;
      // Keep the in-memory maps current so a later line with the same code/name
      // updates this new card instead of creating a duplicate.
      if (code) byCode.set(code.toLowerCase(), createdItem);
      byName.set(createdItem.name.trim().toLowerCase(), createdItem);
      created++;
    }
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
      }: ${updated.length} položek${
        created ? ` (z toho ${created} nově založeno)` : ""
      }`,
      method: "POST",
      path: `/billing/documents/${documentId}/apply-warehouse-prices`,
    });
  }

  return { updated, skipped, created };
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
): Promise<{ updated: WarehousePriceUpdate[]; skipped: number; created: number }> {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (doc.status !== "approved") {
    throw appError(409, "Ceny do skladu lze přenést až po schválení dokladu.");
  }
  return db.transaction(async (tx) => {
    const result = await applyWarehouseCatalogAndPriceHistory(tx, documentId, actor);
    // "Aktualizovat ceny" can be the first thing to run price propagation for a
    // document that was approved before its job link was confirmed (or before
    // a price correction) — keep job material pricing consistent with what
    // approveDocument would have produced by re-running the same propagation.
    await revertInvoicePricePropagation(tx, documentId, actor);
    const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(
      tx,
      documentId,
      actor,
    );
    await syncJobMaterialsForDocument(tx, documentId, actor, {
      excludeSourceLineIds: consumedLineIds,
    });
    return result;
  });
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
  if (status === "duplicate") {
    throw appError(
      400,
      "Doklad nelze označit jako duplicitu bez cílového dokladu. Použijte akci spárovat jako duplicitu.",
    );
  }
  await db.transaction(async (tx) => {
    if (status === "ignored") {
      await assertCompleteBeforeTerminalAction(tx, doc, "ignore");
    }
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
    if (doc.status === "approved") {
      const lines = await tx
        .select({ id: billingDocumentLinesTable.id })
        .from(billingDocumentLinesTable)
        .where(eq(billingDocumentLinesTable.documentId, id));
      await removeWarehousePriceHistoryForDocument(
        tx,
        id,
        lines.map((l) => l.id),
      );
    }
    // Reconcile job materials (removes them when leaving "approved").
    await syncJobMaterialsForDocument(tx, id, actor);
    // Reverse warehouse receipts when leaving "approved" (storno of příjem).
    await reconcileDocumentStockMovements(tx, id, actor);
  });
  return getDocument(id);
}

async function removeWarehousePriceHistoryForDocument(
  tx: DbOrTx,
  documentId: number,
  lineIds: number[],
): Promise<number> {
  const historyWhere = lineIds.length
    ? or(
        eq(warehousePriceHistoryTable.billingDocumentId, documentId),
        inArray(warehousePriceHistoryTable.billingDocumentLineId, lineIds),
      )!
    : eq(warehousePriceHistoryTable.billingDocumentId, documentId);

  const rows = await tx
    .select({
      id: warehousePriceHistoryTable.id,
      warehouseItemId: warehousePriceHistoryTable.warehouseItemId,
      purchasePrice: warehousePriceHistoryTable.purchasePrice,
    })
    .from(warehousePriceHistoryTable)
    .where(historyWhere);
  if (!rows.length) return 0;

  const deletedPricesByItem = new Map<number, number[]>();
  for (const row of rows) {
    const prices = deletedPricesByItem.get(row.warehouseItemId) ?? [];
    prices.push(num(row.purchasePrice));
    deletedPricesByItem.set(row.warehouseItemId, prices);
  }

  await tx
    .delete(warehousePriceHistoryTable)
    .where(inArray(warehousePriceHistoryTable.id, rows.map((r) => r.id)));

  for (const [warehouseItemId, deletedPrices] of deletedPricesByItem) {
    const [item] = await tx
      .select({ purchasePrice: warehouseItemsTable.purchasePrice })
      .from(warehouseItemsTable)
      .where(eq(warehouseItemsTable.id, warehouseItemId));
    if (!item || item.purchasePrice == null) continue;

    const currentPrice = num(item.purchasePrice);
    const stillHasDeletedPrice = deletedPrices.some(
      (deletedPrice) => Math.abs(deletedPrice - currentPrice) < 0.005,
    );
    if (!stillHasDeletedPrice) continue;

    const [latest] = await tx
      .select({ purchasePrice: warehousePriceHistoryTable.purchasePrice })
      .from(warehousePriceHistoryTable)
      .where(eq(warehousePriceHistoryTable.warehouseItemId, warehouseItemId))
      .orderBy(desc(warehousePriceHistoryTable.createdAt), desc(warehousePriceHistoryTable.id))
      .limit(1);

    await tx
      .update(warehouseItemsTable)
      .set({
        purchasePrice: latest ? String(round2(num(latest.purchasePrice))) : null,
      })
      .where(eq(warehouseItemsTable.id, warehouseItemId));
  }

  return rows.length;
}

const EXTRACTION_REQUEUE_TERMINAL_STATUSES = new Set([
  "approved",
  "ignored",
  "reviewed",
  "duplicate",
]);

export interface RequeueExtractionOptions {
  force?: boolean;
}

export async function requeueExtraction(id: number, options: RequeueExtractionOptions = {}) {
  const [doc] = await db
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, id));
  if (!doc) throw appError(404, "Doklad nenalezen.");
  if (options.force && EXTRACTION_REQUEUE_TERMINAL_STATUSES.has(doc.status)) {
    throw appError(409, "Doklad je ve finálním stavu a hromadná AI analýza jej nepřepíše.");
  }
  await db.insert(extractionJobsTable).values({
    documentId: id,
    force: options.force === true,
  });
  return getDocument(id);
}

export interface RequeueAllExtractionsResult {
  queued: number;
  alreadyQueued: number;
  skippedTerminal: number;
  totalConsidered: number;
}

type RequeueDocumentCandidate = {
  id: number;
  status: string;
};

type ActiveExtractionJobCandidate = {
  id: number;
  documentId: number;
  status: string;
  force: boolean;
};

type JobAttachmentDocumentCandidate = {
  jobId: number;
  url: string | null;
};

type LockedBillingDocumentLineCandidate = {
  documentId: number;
};

type LockedPropagatedMaterialCandidate = {
  documentId: number;
};

export async function requeueAllExtractions(actor: Actor): Promise<RequeueAllExtractionsResult> {
  return db.transaction(async (tx) => {
    const docs = await tx
      .select({
        id: billingDocumentsTable.id,
        status: billingDocumentsTable.status,
      })
      .from(billingDocumentsTable)
      .orderBy(billingDocumentsTable.id) as RequeueDocumentCandidate[];

    const activeJobs = await tx
      .select({ documentId: extractionJobsTable.documentId })
      .from(extractionJobsTable)
      .where(inArray(extractionJobsTable.status, ["queued", "running"])) as Pick<
        ActiveExtractionJobCandidate,
        "documentId"
      >[];
    const activeDocumentIds = new Set(activeJobs.map((job) => job.documentId));

    const idsToQueue: number[] = [];
    let alreadyQueued = 0;
    let skippedTerminal = 0;
    for (const doc of docs) {
      if (EXTRACTION_REQUEUE_TERMINAL_STATUSES.has(doc.status)) {
        skippedTerminal++;
        continue;
      }
      if (activeDocumentIds.has(doc.id)) {
        alreadyQueued++;
        continue;
      }
      idsToQueue.push(doc.id);
    }

    if (idsToQueue.length) {
      await tx.insert(extractionJobsTable).values(
        idsToQueue.map((documentId) => ({
          documentId,
          force: true,
        })),
      );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "requeue_all_ai_extraction",
      entityType: "billing_documents",
      entityId: null,
      summary: `Hromadně zařazena AI analýza dokladů: ${idsToQueue.length} nově, ${alreadyQueued} již čeká, ${skippedTerminal} přeskočeno.`,
      method: "POST",
      path: "/billing/documents/extract-all",
    });

    return {
      queued: idsToQueue.length,
      alreadyQueued,
      skippedTerminal,
      totalConsidered: docs.length,
    };
  });
}

export interface ReanalyzeJobAttachmentDocumentsResult {
  jobsScanned: number;
  attachmentsScanned: number;
  created: number;
  skippedAttachments: number;
  queued: number;
  alreadyQueued: number;
  skippedTerminal: number;
  skippedLocked: number;
  totalJobDocuments: number;
}

export async function reanalyzeJobAttachmentDocuments(
  actor: Actor,
): Promise<ReanalyzeJobAttachmentDocumentsResult> {
  const dokladAttachments = (
    await db
      .select({
        jobId: attachmentsTable.jobId,
        url: attachmentsTable.url,
      })
      .from(attachmentsTable)
      .where(inArray(attachmentsTable.type, Array.from(DOKLAD_TYPES)))
  ) as JobAttachmentDocumentCandidate[];
  const storedDokladAttachments = dokladAttachments.filter((att) => att.url?.startsWith("/objects/"));

  const jobIds = Array.from(new Set(storedDokladAttachments.map((att) => att.jobId)));
  let created = 0;
  let skippedAttachments = 0;
  for (const jobId of jobIds) {
    const result = await analyzeJobDocuments(jobId, actor);
    created += result.createdCount;
    skippedAttachments += result.skipped;
  }

  const queueResult = await db.transaction(async (tx) => {
    const docs = await tx
      .select({
        id: billingDocumentsTable.id,
        status: billingDocumentsTable.status,
      })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.source, "job_attachment"))
      .orderBy(billingDocumentsTable.id) as RequeueDocumentCandidate[];

    const activeJobs = await tx
      .select({
        id: extractionJobsTable.id,
        documentId: extractionJobsTable.documentId,
        status: extractionJobsTable.status,
        force: extractionJobsTable.force,
      })
      .from(extractionJobsTable)
      .where(inArray(extractionJobsTable.status, ["queued", "running"])) as ActiveExtractionJobCandidate[];
    const activeByDocumentId = new Map<number, ActiveExtractionJobCandidate[]>();
    for (const job of activeJobs) {
      const jobs = activeByDocumentId.get(job.documentId) ?? [];
      jobs.push(job);
      activeByDocumentId.set(job.documentId, jobs);
    }
    const lockedLines = await tx
      .select({ documentId: billingDocumentLinesTable.documentId })
      .from(billingDocumentLinesTable)
      .where(isNotNull(billingDocumentLinesTable.invoicedInvoiceId)) as LockedBillingDocumentLineCandidate[];
    const lockedMaterials = await tx
      .select({ documentId: billingDocumentLinesTable.documentId })
      .from(materialsTable)
      .innerJoin(
        billingDocumentLinesTable,
        eq(materialsTable.sourceId, billingDocumentLinesTable.id),
      )
      .where(
        and(
          eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
          isNotNull(materialsTable.invoicedInvoiceId),
        ),
      ) as LockedPropagatedMaterialCandidate[];
    const lockedDocumentIds = new Set([
      ...lockedLines.map((line) => line.documentId),
      ...lockedMaterials.map((material) => material.documentId),
    ]);

    const idsToQueue: number[] = [];
    const queuedJobIdsToUpgrade: number[] = [];
    let alreadyQueued = 0;
    let skippedTerminal = 0;
    let skippedLocked = 0;
    for (const doc of docs) {
      if (lockedDocumentIds.has(doc.id)) {
        skippedLocked++;
        continue;
      }
      const active = activeByDocumentId.get(doc.id) ?? [];
      if (active.length) {
        const queuedJobs = active.filter((job) => job.status === "queued");
        const hasForcedActive = active.some((job) => job.force);
        if (queuedJobs.length) {
          alreadyQueued++;
          queuedJobIdsToUpgrade.push(...queuedJobs.map((job) => job.id));
          continue;
        }
        if (hasForcedActive) {
          alreadyQueued++;
          continue;
        }
      }
      idsToQueue.push(doc.id);
    }

    if (queuedJobIdsToUpgrade.length) {
      await tx
        .update(extractionJobsTable)
        .set({ force: true, updatedAt: new Date() })
        .where(inArray(extractionJobsTable.id, queuedJobIdsToUpgrade));
    }
    if (idsToQueue.length) {
      await tx.insert(extractionJobsTable).values(
        idsToQueue.map((documentId) => ({
          documentId,
          force: true,
        })),
      );
    }

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "reanalyze_job_attachment_documents",
      entityType: "billing_documents",
      entityId: null,
      summary: `Znovu analyzovány zakázkové doklady: ${idsToQueue.length} nově ve frontě, ${alreadyQueued} již čeká, ${skippedTerminal} přeskočeno.`,
      method: "POST",
      ...{
        summary: `Znovu analyzovany zakazkove doklady: ${idsToQueue.length} nove ve fronte, ${alreadyQueued} uz ceka, ${skippedLocked} zamceno vystavenou fakturou.`,
      },
      path: "/billing/documents/reanalyze-job-attachments",
    });

    return {
      queued: idsToQueue.length,
      alreadyQueued,
      skippedTerminal,
      skippedLocked,
      totalJobDocuments: docs.length,
    };
  });

  return {
    jobsScanned: jobIds.length,
    attachmentsScanned: storedDokladAttachments.length,
    created,
    skippedAttachments,
    ...queueResult,
  };
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
    const propagatedActivity = lineIds.length
      ? await tx
          .select({ id: activityMaterialsTable.id })
          .from(activityMaterialsTable)
          .where(
            and(
              eq(activityMaterialsTable.sourceType, MATERIAL_SOURCE_TYPE),
              inArray(activityMaterialsTable.sourceId, lineIds),
            ),
          )
      : [];
    for (const m of propagatedActivity) {
      await reconcileSourceMovements(tx, "activity_material", m.id, null, actor);
    }
    if (propagatedActivity.length) {
      await tx
        .delete(activityMaterialsTable)
        .where(inArray(activityMaterialsTable.id, propagatedActivity.map((m) => m.id)));
    }
    // Remove purchase-price history written by this document before the
    // document/line FKs are nulled by ON DELETE SET NULL. If the warehouse
    // item's current purchase price still equals the deleted document's price,
    // roll it back to the latest remaining history entry.
    await removeWarehousePriceHistoryForDocument(tx, id, lineIds);
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

const DOKLAD_TYPES = new Set(["invoice", "receipt", "delivery_note", "credit_note"]);

// Namespace for the Postgres advisory lock keyed by (class, jobId) that
// serializes concurrent "Analyzovat doklady" runs for the same job (e.g. a
// double-click). Arbitrary but fixed so lock/unlock always agree.
const ANALYZE_JOB_DOCUMENTS_LOCK_CLASS = 894_612_305;

async function linkExistingDocumentToJobAttachmentTx(
  tx: DbOrTx,
  documentId: number,
  jobId: number,
  customerId: number | null,
  actor: Actor,
): Promise<boolean> {
  const [doc] = await tx
    .select()
    .from(billingDocumentsTable)
    .where(eq(billingDocumentsTable.id, documentId));
  if (!doc) return false;

  const patch: Partial<typeof billingDocumentsTable.$inferInsert> = {};
  const notes: string[] = [];
  let linkedToJob = false;

  if (doc.jobId == null) {
    patch.jobId = jobId;
    linkedToJob = true;
    notes.push(`doplněna vazba na zakázku #${jobId}`);
  }
  if (doc.customerId == null && customerId != null) {
    patch.customerId = customerId;
  }
  if (doc.status === "duplicate" && doc.primaryDocumentId == null) {
    patch.status = "needs_review";
    patch.warnings = [
      doc.warnings,
      "Doklad byl označen jako duplicita bez technické vazby na primární doklad. Při reanalýze příloh zakázky byl vrácen ke kontrole.",
    ]
      .filter(Boolean)
      .join("\n");
    notes.push("neplatná duplicita vrácena ke kontrole");
  }

  if (Object.keys(patch).length === 0) return false;

  await tx
    .update(billingDocumentsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(billingDocumentsTable.id, doc.id));

  if (linkedToJob && doc.status === "approved") {
    await syncJobMaterialsForDocument(tx, doc.id, actor);
  }

  await tx.insert(auditLogTable).values({
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "update",
    entityType: "billing_documents",
    entityId: doc.id,
    summary: `Reanalýza příloh zakázky: ${notes.join(", ")}`,
    method: "POST",
    path: `/jobs/${jobId}/documents/analyze`,
  });

  return true;
}

/**
 * Create cost documents from a job's "doklady" attachments (účtenky / dodací
 * listy / faktury) that have not already been imported. The attachment bytes
 * are fetched from storage, hashed for dedup, ISDOC-parsed when applicable, and
 * queued. Returns the documents created (skipping ones already imported).
 *
 * Two safety nets guard against duplicates:
 *  - A Postgres advisory lock (transaction-scoped, so it always auto-releases,
 *    even on error/crash) serializes concurrent runs for the *same job* — a
 *    double-click waits for the first run to finish rather than racing it.
 *  - `createDocumentSafe` catches the DB-level sha256 unique-constraint
 *    violation, which also protects against races with *other* ingest paths
 *    (manual upload, e-mail import) touching the exact same content.
 */
export async function analyzeJobDocuments(jobId: number, actor: Actor) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ANALYZE_JOB_DOCUMENTS_LOCK_CLASS}, ${jobId})`,
    );

    const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (!job) throw appError(404, "Zakázka nenalezena.");

    const attachments = await tx
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
      const [existing] = await tx
        .select({ id: billingDocumentsTable.id })
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.sha256, hash))
        .limit(1);
      if (existing) {
        await linkExistingDocumentToJobAttachmentTx(
          tx,
          existing.id,
          jobId,
          job.customerId ?? null,
          actor,
        );
        skipped++;
        continue;
      }
      const docType =
        att.type === "receipt"
          ? "receipt"
          : att.type === "delivery_note"
            ? "delivery_note"
            : att.type === "credit_note"
              ? "credit_note"
              : "invoice";
      const result = await createDocumentSafe(
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
      if (result.status === "duplicate") {
        skipped++;
        continue;
      }
      created.push(result.document);
    }
    return { created, createdCount: created.length, skipped };
  });
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
  confidence?: number | null;
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
  pageNumber?: number | null;
  pageCount?: number | null;
  finalTotalPresent?: boolean | null;
  lines: AiSuggestionLine[];
  relatedDocuments?: AiSuggestionReference[];
  confidence: number;
  warnings: string[];
  model: string;
  rawJson: string;
}

export interface ApplyAiSuggestionOptions {
  replaceExisting?: boolean;
}

/** Only fill a header field from AI when the document doesn't already have one. */
function fillIfEmpty<T>(current: T | null, suggestion: T | null | undefined): T | null {
  if (current != null && current !== ("" as unknown as T)) return current;
  return suggestion ?? null;
}

function fillFromAi<T>(
  current: T | null,
  suggestion: T | null | undefined,
  replaceExisting: boolean,
): T | null {
  return replaceExisting ? (suggestion ?? null) : fillIfEmpty(current, suggestion);
}

async function cleanupBeforeForcedAiLineReplacement(
  tx: DbOrTx,
  documentId: number,
  lineIds: number[],
  actor: Actor,
): Promise<void> {
  if (!lineIds.length) return;
  await revertInvoicePricePropagation(tx, documentId, actor);
  await removeWarehousePriceHistoryForDocument(tx, documentId, lineIds);
  await syncJobMaterialsForDocument(tx, documentId, actor);
  await reconcileDocumentStockMovements(tx, documentId, actor);
  for (const lineId of lineIds) {
    await reconcileSourceMovements(tx, "billing_document_line", lineId, null, actor);
  }
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
  options: ApplyAiSuggestionOptions = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId));
    if (!doc) throw appError(404, "Doklad nenalezen.");
    const replaceExisting = options.replaceExisting === true;
    const actor = SYSTEM_ACTOR;

    const existingLines = await tx
      .select({
        id: billingDocumentLinesTable.id,
        invoicedInvoiceId: billingDocumentLinesTable.invoicedInvoiceId,
      })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, documentId));
    if (replaceExisting && existingLines.some((line) => line.invoicedInvoiceId != null)) {
      throw appError(
        409,
        "Doklad má položky použité ve faktuře. AI analýzu nelze vynuceně přepsat.",
      );
    }

    const existingLineIds = existingLines.map((line) => line.id);
    if (replaceExisting && existingLineIds.length) {
      const lockedMaterials = await tx
        .select({ id: materialsTable.id })
        .from(materialsTable)
        .where(
          and(
            eq(materialsTable.sourceType, MATERIAL_SOURCE_TYPE),
            inArray(materialsTable.sourceId, existingLineIds),
            isNotNull(materialsTable.invoicedInvoiceId),
          ),
        );
      if (lockedMaterials.length) {
        throw appError(
          409,
          "Doklad ma material pouzity ve vystavene fakture. AI analyzu nelze vynucene prepsat.",
        );
      }
    }

    const lowConfidenceWarning =
      suggestion.confidence < CONFIDENCE_REVIEW_THRESHOLD
        ? `ALARM: Spolehlivost automatického vytěžení je pouze ${Math.round(
            suggestion.confidence * 100,
          )} %. Doklad vyžaduje ruční kontrolu.`
        : null;
    const incompleteMultipageWarning =
      suggestion.pageCount != null &&
      suggestion.pageCount > 1 &&
      suggestion.finalTotalPresent === false
        ? `NEUPLNY_VICESTRANKOVY_DOKLAD: Viditelná je pouze strana ${suggestion.pageNumber ?? "?"}/${suggestion.pageCount} a chybí finální součet dokladu. Stránku je nutné sloučit s dalšími stranami před schválením nebo ignorováním.`
        : null;
    const warnings = Array.from(
      new Set([
        "Hlavička a položky předvyplněny pomocí AI (OpenAI). Před schválením pečlivě zkontrolujte.",
        ...(lowConfidenceWarning ? [lowConfidenceWarning] : []),
        ...(incompleteMultipageWarning ? [incompleteMultipageWarning] : []),
        ...suggestion.warnings,
      ]),
    ).join("\n");

    const docType =
      suggestion.docType && VALID_DOC_TYPE.has(suggestion.docType)
        ? suggestion.docType
        : doc.docType;

    await tx
      .update(billingDocumentsTable)
      .set({
        // Never override a value a human / ISDOC already set.
        docType,
        primaryDocumentId: replaceExisting ? null : doc.primaryDocumentId,
        mergeGroupId: replaceExisting ? null : doc.mergeGroupId,
        supplierName: fillFromAi(doc.supplierName, suggestion.supplierName, replaceExisting),
        supplierIc: fillFromAi(doc.supplierIc, suggestion.supplierIc, replaceExisting),
        supplierDic: fillFromAi(doc.supplierDic, suggestion.supplierDic, replaceExisting),
        supplierAddress: fillFromAi(doc.supplierAddress, suggestion.supplierAddress, replaceExisting),
        documentNumber: fillFromAi(doc.documentNumber, suggestion.documentNumber, replaceExisting),
        variableSymbol: fillFromAi(doc.variableSymbol, suggestion.variableSymbol, replaceExisting),
        issueDate: fillFromAi(doc.issueDate, suggestion.issueDate, replaceExisting),
        taxableSupplyDate: fillFromAi(doc.taxableSupplyDate, suggestion.taxableSupplyDate, replaceExisting),
        dueDate: fillFromAi(doc.dueDate, suggestion.dueDate, replaceExisting),
        currency: replaceExisting ? (suggestion.currency || "CZK") : (doc.currency || suggestion.currency || "CZK"),
        subtotalWithoutVat:
          replaceExisting || doc.subtotalWithoutVat == null
            ? (suggestion.subtotalWithoutVat != null
                ? String(round2(suggestion.subtotalWithoutVat))
                : null)
            : doc.subtotalWithoutVat,
        totalVat:
          replaceExisting || doc.totalVat == null
            ? (suggestion.totalVat != null ? String(round2(suggestion.totalVat)) : null)
            : doc.totalVat,
        totalWithVat:
          replaceExisting || doc.totalWithVat == null
            ? (suggestion.totalWithVat != null
                ? String(round2(suggestion.totalWithVat))
                : null)
            : doc.totalWithVat,
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

    if (replaceExisting && existingLines.length) {
      await cleanupBeforeForcedAiLineReplacement(
        tx,
        documentId,
        existingLineIds,
        actor,
      );
      await tx
        .delete(billingDocumentLinesTable)
        .where(eq(billingDocumentLinesTable.documentId, documentId));
    }

    if ((!existingLines.length || replaceExisting) && suggestion.lines.length) {
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
              confidence: l.confidence ?? suggestion.confidence,
            },
            idx,
          ),
        ),
      );
    }

    // Persist AI-suggested document references (deduped against existing ones).
    if (replaceExisting) {
      await tx
        .delete(billingDocumentReferencesTable)
        .where(
          and(
            eq(billingDocumentReferencesTable.documentId, documentId),
            eq(billingDocumentReferencesTable.source, "ai"),
          ),
        );
    }

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
  await reconcileIncompleteMultipagePagesSafely(documentId, SYSTEM_ACTOR);
  await reconcileDocumentRelationshipsSafely(documentId, SYSTEM_ACTOR);
}

// ---------------------------------------------------------------------------
// Review Queue — enriched line-level work queue for billing review
// ---------------------------------------------------------------------------

export type ReviewReason =
  | "needs_review"
  | "low_confidence"
  | "missing_job"
  | "missing_warehouse_item"
  | "price_jump";

export interface ReviewQueueItem {
  lineId: number;
  documentId: number;
  lineType: string;
  description: string;
  quantity: number;
  unit: string | null;
  unitPriceWithoutVat: number;
  confidence: number | null;
  jobId: number | null;
  allocationType: string;
  matchConfirmed: boolean;
  approved: boolean;
  supplierSku: string | null;
  ean: string | null;
  feeType: string | null;
  document: {
    id: number;
    status: string;
    docType: string;
    supplierName: string | null;
    documentNumber: string | null;
    variableSymbol: string | null;
    issueDate: string | null;
  };
  reasons: ReviewReason[];
  suggestedWarehouseItemId: number | null;
  suggestedWarehouseItemName: string | null;
  previousPrice: number | null;
  priceChangePercent: number | null;
  suggestedJobId: number | null;
  suggestedJobTitle: string | null;
}

export interface ReviewQueueListResult {
  items: ReviewQueueItem[];
  total: number;
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.8;
const PRICE_JUMP_THRESHOLD_PERCENT = 20;

// Statuses where a document is still open and worth reviewing.
// 'approved', 'ignored', and 'duplicate' are terminal — skip them.
const OPEN_DOC_STATUSES = ["uploaded", "needs_review", "reviewed"] as const;

// ---------------------------------------------------------------------------
// Shared helper: batch-load all warehouse items into lookup maps
// ---------------------------------------------------------------------------

type WarehouseLookupItem = { id: number; name: string; purchasePrice: string | null };

async function loadWarehouseLookupMaps(): Promise<{
  byEan: Map<string, WarehouseLookupItem>;
  bySku: Map<string, WarehouseLookupItem>;
  byNorm: Map<string, WarehouseLookupItem>;
}> {
  const items = await db
    .select({
      id: warehouseItemsTable.id,
      name: warehouseItemsTable.name,
      ean: warehouseItemsTable.ean,
      supplierSku: warehouseItemsTable.supplierSku,
      normalizedName: warehouseItemsTable.normalizedName,
      purchasePrice: warehouseItemsTable.purchasePrice,
    })
    .from(warehouseItemsTable);

  const byEan = new Map<string, WarehouseLookupItem>();
  const bySku = new Map<string, WarehouseLookupItem>();
  const byNorm = new Map<string, WarehouseLookupItem>();
  for (const item of items) {
    if (item.ean) byEan.set(item.ean, item);
    if (item.supplierSku) bySku.set(item.supplierSku, item);
    if (item.normalizedName) byNorm.set(item.normalizedName, item);
  }
  return { byEan, bySku, byNorm };
}

function matchLineToWarehouse(
  line: {
    ean: string | null;
    supplierSku: string | null;
    description: string;
  },
  maps: { byEan: Map<string, WarehouseLookupItem>; bySku: Map<string, WarehouseLookupItem>; byNorm: Map<string, WarehouseLookupItem> },
): WarehouseLookupItem | null {
  if (line.ean) {
    const m = maps.byEan.get(line.ean);
    if (m) return m;
  }
  if (line.supplierSku) {
    const m = maps.bySku.get(line.supplierSku);
    if (m) return m;
  }
  const norm = normalizeItemName(line.description);
  if (norm) {
    const m = maps.byNorm.get(norm);
    if (m) return m;
  }
  return null;
}

function computeReasons(
  line: {
    lineType: string;
    feeType: string | null;
    allocationType: string;
    jobId: number | null;
    matchConfirmed: number;
    confidence: string | null;
  },
  doc: { status: string },
  warehouseMatch: WarehouseLookupItem | null,
  unitPrice: number,
): { reasons: ReviewReason[]; priceChangePercent: number | null; previousPrice: number | null } {
  let previousPrice: number | null = null;
  let priceChangePercent: number | null = null;
  if (warehouseMatch?.purchasePrice != null) {
    previousPrice = num(warehouseMatch.purchasePrice);
    if (previousPrice > 0 && unitPrice > 0) {
      priceChangePercent = round2(((unitPrice - previousPrice) / previousPrice) * 100);
    }
  }

  const isMaterial = line.lineType === "material" && !line.feeType;

  const reasons: ReviewReason[] = [];
  if (doc.status === "needs_review") reasons.push("needs_review");
  if (line.confidence != null && num(line.confidence) < REVIEW_CONFIDENCE_THRESHOLD) {
    reasons.push("low_confidence");
  }
  if (isMaterial && line.allocationType === "rebill" && !line.jobId && !line.matchConfirmed) {
    reasons.push("missing_job");
  }
  if (isMaterial && warehouseMatch === null) {
    reasons.push("missing_warehouse_item");
  }
  if (priceChangePercent !== null && Math.abs(priceChangePercent) >= PRICE_JUMP_THRESHOLD_PERCENT) {
    reasons.push("price_jump");
  }

  return { reasons, priceChangePercent, previousPrice };
}

export async function listReviewQueue(opts: {
  page?: number;
  pageSize?: number;
  reason?: string;
}): Promise<ReviewQueueListResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));

  // Fetch ALL non-approved, non-confirmed, non-invoiced lines from open documents.
  // matchConfirmed=0 is enforced at SQL level so confirmed lines stay hidden even
  // when a document is re-set to needs_review — returnReviewLines explicitly resets
  // matchConfirmed=0 for lines that should come back.
  // We intentionally widen the remaining SQL filter and compute reasons in-memory
  // so every trigger (missing warehouse item, price jump, etc.) is covered —
  // not just confidence and document status.
  const allRows = await db
    .select({
      line: billingDocumentLinesTable,
      doc: {
        id: billingDocumentsTable.id,
        status: billingDocumentsTable.status,
        docType: billingDocumentsTable.docType,
        supplierName: billingDocumentsTable.supplierName,
        documentNumber: billingDocumentsTable.documentNumber,
        variableSymbol: billingDocumentsTable.variableSymbol,
        issueDate: billingDocumentsTable.issueDate,
      },
    })
    .from(billingDocumentLinesTable)
    .innerJoin(
      billingDocumentsTable,
      eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id),
    )
    .where(
      and(
        eq(billingDocumentLinesTable.approved, 0),
        eq(billingDocumentLinesTable.matchConfirmed, 0),
        isNull(billingDocumentLinesTable.invoicedInvoiceId),
        inArray(billingDocumentsTable.status, [...OPEN_DOC_STATUSES]),
      ),
    )
    .orderBy(asc(billingDocumentsTable.id), asc(billingDocumentLinesTable.sortOrder));

  // Batch-load warehouse catalogue for matching
  const warehouseMaps = await loadWarehouseLookupMaps();

  // Batch-query confirmed/suggested jobs from document references
  const allDocIds = [...new Set(allRows.map((r) => r.doc.id))];
  const suggestedJobByDocId = new Map<number, { jobId: number; jobTitle: string }>();

  if (allDocIds.length > 0) {
    const refs = await db
      .select({
        documentId: billingDocumentReferencesTable.documentId,
        matchedJobId: billingDocumentReferencesTable.matchedJobId,
        matchConfirmed: billingDocumentReferencesTable.matchConfirmed,
        matchConfidence: billingDocumentReferencesTable.matchConfidence,
        jobTitle: jobsTable.title,
      })
      .from(billingDocumentReferencesTable)
      .innerJoin(jobsTable, eq(billingDocumentReferencesTable.matchedJobId, jobsTable.id))
      .where(
        and(
          inArray(billingDocumentReferencesTable.documentId, allDocIds),
          isNotNull(billingDocumentReferencesTable.matchedJobId),
          eq(billingDocumentReferencesTable.rejected, 0),
        ),
      )
      .orderBy(
        desc(billingDocumentReferencesTable.matchConfirmed),
        desc(billingDocumentReferencesTable.matchConfidence),
      );

    for (const ref of refs) {
      if (ref.matchedJobId && !suggestedJobByDocId.has(ref.documentId)) {
        suggestedJobByDocId.set(ref.documentId, {
          jobId: ref.matchedJobId,
          jobTitle: ref.jobTitle,
        });
      }
    }
  }

  // Build enriched items and filter to those with at least one review reason
  const allItems: ReviewQueueItem[] = [];

  for (const r of allRows) {
    const line = r.line;
    const doc = r.doc;
    const unitPrice = num(line.unitPriceWithoutVat);
    const warehouseMatch = matchLineToWarehouse(line, warehouseMaps);

    const { reasons, priceChangePercent, previousPrice } = computeReasons(
      line,
      doc,
      warehouseMatch,
      unitPrice,
    );

    // Skip lines that don't need any attention
    if (reasons.length === 0) continue;

    const suggestedJob = suggestedJobByDocId.get(doc.id) ?? null;

    allItems.push({
      lineId: line.id,
      documentId: line.documentId,
      lineType: line.lineType,
      description: line.description,
      quantity: num(line.quantity),
      unit: line.unit,
      unitPriceWithoutVat: unitPrice,
      confidence: line.confidence != null ? num(line.confidence) : null,
      jobId: line.jobId,
      allocationType: line.allocationType,
      matchConfirmed: !!line.matchConfirmed,
      approved: !!line.approved,
      supplierSku: line.supplierSku,
      ean: line.ean,
      feeType: line.feeType,
      document: {
        id: doc.id,
        status: doc.status,
        docType: doc.docType,
        supplierName: doc.supplierName,
        documentNumber: doc.documentNumber,
        variableSymbol: doc.variableSymbol,
        issueDate: doc.issueDate,
      },
      reasons,
      suggestedWarehouseItemId: warehouseMatch?.id ?? null,
      suggestedWarehouseItemName: warehouseMatch?.name ?? null,
      previousPrice,
      priceChangePercent,
      suggestedJobId: suggestedJob?.jobId ?? null,
      suggestedJobTitle: suggestedJob?.jobTitle ?? null,
    });
  }

  // Optional reason filter (after in-memory enrichment)
  const filtered = opts.reason
    ? allItems.filter((item) => item.reasons.includes(opts.reason as ReviewReason))
    : allItems;

  const total = filtered.length;
  const offset = (page - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);

  return { items, total };
}

export interface BulkReviewDiff {
  total: number;
  toConfirm: number;
  alreadyConfirmed: number;
  priceJumps: number;
  missingJobCount: number;
  missingWarehouseItemCount: number;
  /** Lines that will still appear in the review queue after confirmation (have reasons that persist regardless of matchConfirmed). */
  stillUnresolved: number;
  /** Lines with a job assigned — those will propagate materials to the job when the document is approved. */
  withJobAssigned: number;
  /** IDs of jobs that will receive materials once the document is approved (deduplicated). */
  affectedJobIds: number[];
}

export async function bulkConfirmReviewLines(
  lineIds: number[],
  actor: Actor,
  dryRun = false,
): Promise<BulkReviewDiff> {
  if (lineIds.length === 0) {
    return {
      total: 0,
      toConfirm: 0,
      alreadyConfirmed: 0,
      priceJumps: 0,
      missingJobCount: 0,
      missingWarehouseItemCount: 0,
      stillUnresolved: 0,
      withJobAssigned: 0,
      affectedJobIds: [],
    };
  }

  const lines = await db
    .select()
    .from(billingDocumentLinesTable)
    .where(
      and(
        inArray(billingDocumentLinesTable.id, lineIds),
        isNull(billingDocumentLinesTable.invoicedInvoiceId),
      ),
    );

  // Batch-load doc statuses for lines (needed for needs_review reason)
  const allDocIds = [...new Set(lines.map((l) => l.documentId))];
  const docStatusMap = new Map<number, string>();
  if (allDocIds.length > 0) {
    const docs = await db
      .select({ id: billingDocumentsTable.id, status: billingDocumentsTable.status })
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, allDocIds));
    for (const d of docs) docStatusMap.set(d.id, d.status);
  }

  // Task #685 (risk #5): lines belonging to a document already merged away
  // as a duplicate must never be bulk-confirmed — that would re-run price
  // propagation/material sync for a dead document and double-write the
  // primary's already-applied stock/price effects. Silently drop them
  // (never count as toConfirm) rather than 500 the whole batch over stale
  // line ids a client happened to still have selected.
  const liveLines = lines.filter((l) => docStatusMap.get(l.documentId) !== "duplicate");

  // Resolve warehouse matches to compute accurate diff fields
  const warehouseMaps = await loadWarehouseLookupMaps();

  let priceJumps = 0;
  let missingWarehouseItemCount = 0;
  let missingJobCount = 0;
  let stillUnresolved = 0;
  let withJobAssigned = 0;
  const affectedJobIdSet = new Set<number>();

  for (const l of liveLines) {
    const unitPrice = num(l.unitPriceWithoutVat);
    const warehouseMatch = matchLineToWarehouse(l, warehouseMaps);
    const docStatus = docStatusMap.get(l.documentId) ?? "";
    const { reasons } = computeReasons(l, { status: docStatus }, warehouseMatch, unitPrice);

    if (reasons.includes("price_jump")) priceJumps++;
    if (reasons.includes("missing_warehouse_item")) missingWarehouseItemCount++;
    if (reasons.includes("missing_job")) missingJobCount++;
    if (l.jobId != null) {
      withJobAssigned++;
      affectedJobIdSet.add(l.jobId);
    }

    // After confirmation matchConfirmed=1 so missing_job disappears.
    // Any other remaining reasons mean the line still needs attention.
    const persistingReasons = reasons.filter((r) => r !== "missing_job");
    if (persistingReasons.length > 0) stillUnresolved++;
  }

  const alreadyConfirmed = liveLines.filter((l) => !!l.matchConfirmed).length;
  const toConfirmLines = liveLines.filter((l) => !l.matchConfirmed);
  const toConfirm = toConfirmLines.length;

  if (!dryRun && toConfirm > 0) {
    const toConfirmIds = toConfirmLines.map((l) => l.id);
    await db.transaction(async (tx) => {
      await tx
        .update(billingDocumentLinesTable)
        .set({ matchConfirmed: 1, updatedAt: new Date() })
        .where(inArray(billingDocumentLinesTable.id, toConfirmIds));

      // A newly-confirmed line can be exactly what makes a document's job link
      // eligible for price propagation onto a pre-existing (delivery-note)
      // material — the same thing approveDocument does at approval time. Redo
      // it per affected document so bulk-confirming lines refreshes material
      // prices on their target jobs, not just the confirmation flag.
      const affectedDocIds = [...new Set(toConfirmLines.map((l) => l.documentId))];
      for (const docId of affectedDocIds) {
        await revertInvoicePricePropagation(tx, docId, actor);
        const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(
          tx,
          docId,
          actor,
        );
        await syncJobMaterialsForDocument(tx, docId, actor, {
          excludeSourceLineIds: consumedLineIds,
        });
      }

      await tx.insert(auditLogTable).values({
        action: "bulk_confirm_review_lines",
        entityType: "billing_document_line",
        entityId: null,
        actorUserId: actor.userId,
        actorName: actor.name,
        summary: `Hromadně potvrzeno ${toConfirmIds.length} řádků dokladu`,
      });
    });
  }

  return {
    total: lineIds.length,
    toConfirm,
    alreadyConfirmed,
    priceJumps,
    missingJobCount,
    missingWarehouseItemCount,
    stillUnresolved,
    withJobAssigned,
    affectedJobIds: [...affectedJobIdSet],
  };
}

export interface SkipReviewResult {
  skipped: number;
  alreadySkipped: number;
}

/**
 * Skip lines in the review queue: marks them as reviewed but deliberately
 * excluded from job/warehouse propagation (allocationType = not_rebilled).
 * The skipReason is stored in the audit log for traceability.
 */
export async function skipReviewLines(
  lineIds: number[],
  skipReason: string,
  actor: Actor,
  dryRun = false,
): Promise<SkipReviewResult> {
  if (lineIds.length === 0) return { skipped: 0, alreadySkipped: 0 };

  const lines = await db
    .select({ id: billingDocumentLinesTable.id, allocationType: billingDocumentLinesTable.allocationType, matchConfirmed: billingDocumentLinesTable.matchConfirmed })
    .from(billingDocumentLinesTable)
    .where(
      and(
        inArray(billingDocumentLinesTable.id, lineIds),
        isNull(billingDocumentLinesTable.invoicedInvoiceId),
      ),
    );

  // A line is "already skipped" if it's already not_rebilled + confirmed
  const alreadySkipped = lines.filter(
    (l) => l.allocationType === "not_rebilled" && !!l.matchConfirmed,
  ).length;
  const toSkipLines = lines.filter(
    (l) => !(l.allocationType === "not_rebilled" && !!l.matchConfirmed),
  );
  const skipped = toSkipLines.length;

  if (!dryRun && skipped > 0) {
    const toSkipIds = toSkipLines.map((l) => l.id);
    await db.transaction(async (tx) => {
      await tx
        .update(billingDocumentLinesTable)
        .set({ allocationType: "not_rebilled", matchConfirmed: 1, updatedAt: new Date() })
        .where(inArray(billingDocumentLinesTable.id, toSkipIds));

      await tx.insert(auditLogTable).values({
        action: "skip_review_lines",
        entityType: "billing_document_line",
        entityId: null,
        actorUserId: actor.userId,
        actorName: actor.name,
        summary: `Přeskočeno ${toSkipIds.length} řádků (důvod: ${skipReason})`,
      });
    });
  }

  return { skipped, alreadySkipped };
}

export interface ReturnReviewResult {
  returned: number;
  alreadyUnconfirmed: number;
}

/**
 * Return lines for correction: resets matchConfirmed to 0 so they reappear in
 * the review queue. If a line's allocationType was set to not_rebilled during
 * a skip, it is also reset to 'internal' so it's visible again.
 */
export async function returnReviewLines(
  lineIds: number[],
  actor: Actor,
): Promise<ReturnReviewResult> {
  if (lineIds.length === 0) return { returned: 0, alreadyUnconfirmed: 0 };

  const lines = await db
    .select({ id: billingDocumentLinesTable.id, matchConfirmed: billingDocumentLinesTable.matchConfirmed, allocationType: billingDocumentLinesTable.allocationType })
    .from(billingDocumentLinesTable)
    .where(inArray(billingDocumentLinesTable.id, lineIds));

  const alreadyUnconfirmed = lines.filter((l) => !l.matchConfirmed).length;
  const toReturnLines = lines.filter((l) => !!l.matchConfirmed);
  const returned = toReturnLines.length;

  if (returned > 0) {
    const toReturnIds = toReturnLines.map((l) => l.id);
    await db.transaction(async (tx) => {
      // Reset matchConfirmed; if the line was skipped (not_rebilled), restore to rebill so
      // the missing_job reason fires again — that was the original allocation intent.
      // Never reset to "internal" which would suppress the missing_job detection.
      for (const l of toReturnLines) {
        await tx
          .update(billingDocumentLinesTable)
          .set({
            matchConfirmed: 0,
            ...(l.allocationType === "not_rebilled" ? { allocationType: "rebill" } : {}),
            updatedAt: new Date(),
          })
          .where(eq(billingDocumentLinesTable.id, l.id));
      }

      await tx.insert(auditLogTable).values({
        action: "return_review_lines",
        entityType: "billing_document_line",
        entityId: null,
        actorUserId: actor.userId,
        actorName: actor.name,
        summary: `Vráceno k opravě ${toReturnIds.length} řádků dokladu`,
      });
    });
  }

  return { returned, alreadyUnconfirmed };
}

export interface AssignWarehouseResult {
  lineId: number;
  warehouseItemId: number;
  warehouseItemName: string;
}

/**
 * Assign an existing warehouse catalogue card to a billing document line.
 *
 * Establishes the match by updating the line's EAN/SKU/description to ensure
 * the next matchLineToWarehouse call resolves the correct item (priority: EAN → SKU → name).
 * Idempotent: re-assigning the same item is a no-op for DB state but still audited.
 */
export async function assignWarehouseItemToLine(
  lineId: number,
  warehouseItemId: number,
  actor: Actor,
): Promise<AssignWarehouseResult> {
  const [line] = await db
    .select()
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.id, lineId));
  if (!line) throw Object.assign(new Error("Řádek nenalezen."), { status: 404 });

  const [item] = await db
    .select()
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, warehouseItemId));
  if (!item) throw Object.assign(new Error("Skladová položka nenalezena."), { status: 404 });

  // Determine the best linking field (EAN > SKU > name).
  // This ensures future matchLineToWarehouse calls resolve the same item.
  const updates: Partial<{
    ean: string | null;
    supplierSku: string | null;
    description: string;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  if (item.ean) {
    updates.ean = item.ean;
  } else if (item.supplierSku) {
    updates.supplierSku = item.supplierSku;
  } else {
    updates.description = item.name;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(billingDocumentLinesTable)
      .set(updates)
      .where(eq(billingDocumentLinesTable.id, lineId));

    await tx.insert(auditLogTable).values({
      action: "assign_warehouse_item",
      entityType: "billing_document_line",
      entityId: lineId,
      actorUserId: actor.userId,
      actorName: actor.name,
      summary: `Přiřazena sklad. karta "${item.name}" (id=${warehouseItemId}) k řádku ${lineId}`,
    });
  });

  return { lineId, warehouseItemId, warehouseItemName: item.name };
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

/**
 * Fetch bytes for every AI-supported file attached to a document, in upload
 * order (oldest first — typically page 1, 2, 3…). A multi-page group upload
 * attaches one `billing_document_files` row per page; single-file documents
 * still work through this path (one row, same as `getDocumentFileBuffer`).
 * Files whose type isn't AI-supported (e.g. an ISDOC XML sitting alongside a
 * visual PDF) are skipped rather than sent to the model.
 */
export async function getDocumentAllFileBuffers(
  documentId: number,
): Promise<ExtractionFileInput[]> {
  const rows = await db
    .select()
    .from(billingDocumentFilesTable)
    .where(eq(billingDocumentFilesTable.documentId, documentId))
    .orderBy(billingDocumentFilesTable.id);
  const supported = rows.filter(
    (r): r is typeof r & { objectPath: string } =>
      !!r.objectPath && isSupportedForAi(r.mimeType, r.originalFileName),
  );
  const files: ExtractionFileInput[] = [];
  for (const row of supported) {
    const buffer = await objectStorage.getPrivateObjectBuffer(row.objectPath);
    files.push({ buffer, contentType: row.mimeType, fileName: row.originalFileName });
  }
  return files;
}

void sql;
