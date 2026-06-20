/**
 * Service layer for received cost documents (přijaté nákladové doklady).
 *
 * Covers: creating documents from uploaded files / job attachments, duplicate
 * detection, machine-side ISDOC parsing, the review lifecycle, line matching /
 * splitting across jobs, and surfacing approved lines to the outgoing-invoice
 * builder. No AI — every value is either read from an ISDOC document or entered
 * by an admin during review. Matching is only ever a suggestion.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  extractionJobsTable,
  attachmentsTable,
  jobsTable,
  auditLogTable,
  type BillingDocument,
  type BillingDocumentLine,
} from "@workspace/db";
import { computeLine, num, round2, type VatMode } from "./invoice-calc";
import { parseIsdocBuffer, isParsableIsdoc, type ParsedDocument } from "./isdoc-parser";
import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

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

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    notes: row.notes,
    warnings: row.warnings,
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
    sortOrder: row.sortOrder,
  };
}

export type SerializedDocument = ReturnType<typeof serializeDocument>;
export type SerializedLine = ReturnType<typeof serializeLine>;

// ---------------------------------------------------------------------------
// Line totals
// ---------------------------------------------------------------------------

function lineValues(
  documentId: number,
  parsed: {
    description: string;
    quantity?: number | null;
    unit?: string | null;
    unitPriceWithoutVat?: number | null;
    vatRate?: number | null;
    lineType?: string;
  },
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
  return {
    documentId,
    lineType: parsed.lineType && VALID_LINE_TYPE.has(parsed.lineType) ? parsed.lineType : "material",
    description: parsed.description,
    quantity: String(c.quantity),
    unit: parsed.unit ?? null,
    unitPriceWithoutVat: String(c.unitPriceWithoutVat),
    vatRate: c.vatRate == null ? null : String(c.vatRate),
    vatMode: c.vatMode,
    totalWithoutVat: String(c.totalWithoutVat),
    totalVat: String(c.totalVat),
    totalWithVat: String(c.totalWithVat),
    sortOrder,
  };
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
  let warnings: string | null = null;
  if (buffer && isParsableIsdoc(input.contentType, input.fileName)) {
    try {
      parsed = parseIsdocBuffer(buffer, input.fileName);
      warnings = "Hlavička a položky předvyplněny z ISDOC. Zkontrolujte před schválením.";
    } catch (err) {
      warnings = `Automatické zpracování ISDOC selhalo: ${
        err instanceof Error ? err.message : "neznámá chyba"
      }`;
    }
  }

  const docType =
    input.docType && VALID_DOC_TYPE.has(input.docType) ? input.docType : "invoice";

  const id = await db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(billingDocumentsTable)
      .values({
        status: "needs_review",
        docType,
        source: input.source,
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
        jobId: input.jobId ?? null,
        customerId: input.customerId ?? null,
        warnings,
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
              vatRate: l.vatRate,
            },
            idx,
          ),
        ),
      );
    }

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
// Read
// ---------------------------------------------------------------------------

export interface DocumentFilters {
  status?: string;
  supplierIc?: string;
  jobId?: number;
  customerId?: number;
}

export async function listDocuments(filters: DocumentFilters) {
  const conds = [];
  if (filters.status) conds.push(eq(billingDocumentsTable.status, filters.status));
  if (filters.supplierIc)
    conds.push(eq(billingDocumentsTable.supplierIc, filters.supplierIc));
  if (filters.jobId != null) conds.push(eq(billingDocumentsTable.jobId, filters.jobId));
  if (filters.customerId != null)
    conds.push(eq(billingDocumentsTable.customerId, filters.customerId));

  const rows = await db
    .select()
    .from(billingDocumentsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(billingDocumentsTable.createdAt));
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

  return {
    document: serializeDocument(doc),
    lines: lines.map(serializeLine),
    duplicates,
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
 * and replaced by the parts (each referencing the original via parent_line_id
 * for provenance). The parts' quantities must sum to the original quantity
 * (within a haléř) so no value is invented or lost.
 */
export async function splitLine(
  documentId: number,
  lineId: number,
  parts: SplitPart[],
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

    // Delete the original, insert the parts in its place.
    await tx
      .delete(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.id, lineId));

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
        parentLineId: lineId,
        jobId: p.jobId ?? line.jobId ?? null,
        allocationType:
          p.allocationType && VALID_ALLOC.has(p.allocationType)
            ? p.allocationType
            : line.allocationType,
        sortOrder: baseSort + idx,
      };
    });
    await tx.insert(billingDocumentLinesTable).values(values);
    return undefined;
  }).then(() => getDocument(documentId));
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
  await db.delete(billingDocumentsTable).where(eq(billingDocumentsTable.id, id));
  await db.insert(auditLogTable).values({
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "delete",
    entityType: "billing_documents",
    entityId: id,
    summary: `Nákladový doklad smazán${doc.documentNumber ? ` (${doc.documentNumber})` : ""}`,
    method: "DELETE",
    path: `/billing/documents/${id}`,
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

void sql;
