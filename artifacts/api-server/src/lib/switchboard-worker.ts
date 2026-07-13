import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { db, switchboardDocumentsTable, switchboardExtractedFieldsTable, switchboardFieldRegistryTable, switchboardProcessingJobsTable, switchboardsTable, switchboardEventsTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { parseSwitchboardLabel, SWITCHBOARD_PARSER_VERSION, type FieldDefinition } from "./switchboard-parser";
import { extractPdfOcrElements, extractPdfTextElements, shouldUseOcrFallback } from "./switchboard-pdf";
import { switchboardPatchFromExtractedFields } from "./switchboard-field-values";
import { createSwitchboardLabelVersion } from "./switchboard-label-version";

const storage = new ObjectStorageService();
let started = false; let draining = false;
const STALE_MS = 30 * 60_000;

async function processOne(id: number) {
  const [claimed] = await db.update(switchboardProcessingJobsTable).set({ status: "running", attemptCount: sql`${switchboardProcessingJobsTable.attemptCount} + 1`, startedAt: new Date(), lockedAt: new Date(), lockedBy: process.env.HOSTNAME ?? "api" })
    .where(and(eq(switchboardProcessingJobsTable.id, id), eq(switchboardProcessingJobsTable.status, "queued"))).returning();
  if (!claimed) return;
  let switchboardId: number | null = null;
  try {
    const [document] = await db.select().from(switchboardDocumentsTable).where(eq(switchboardDocumentsTable.id, claimed.documentId));
    if (!document) throw Object.assign(new Error("Dokument neexistuje."), { code: "document_missing" });
    switchboardId = document.switchboardId;
    await db.update(switchboardDocumentsTable).set({ processingStatus: "analyzing_pdf" }).where(eq(switchboardDocumentsTable.id, document.id));
    const buffer = await storage.getPrivateObjectBuffer(document.storagePath);
    let extracted = await extractPdfTextElements(buffer);
    let registryRows = await db.select().from(switchboardFieldRegistryTable).where(eq(switchboardFieldRegistryTable.isActive, true));
    const registry: FieldDefinition[] = registryRows.map((field) => ({ ...field, minimumConfidence: Number(field.minimumConfidence) }));
    let result = parseSwitchboardLabel(extracted.elements, registry);
    if (shouldUseOcrFallback(result.status)) {
      await db.update(switchboardDocumentsTable).set({ processingStatus: "ocr" }).where(eq(switchboardDocumentsTable.id, document.id));
      extracted = await extractPdfOcrElements(buffer);
      result = parseSwitchboardLabel(extracted.elements, registry);
    }
    const complete = result.status === "complete";
    const reviewCode = result.status === "label_not_found"
      ? "label_not_found"
      : ("ambiguousPages" in result && result.ambiguousPages.length
          ? "multiple_label_candidates"
          : ("ambiguousFields" in result && result.ambiguousFields.length
              ? "multiple_value_candidates"
              : ("missingRequired" in result && result.missingRequired.length ? "missing_required_fields" : null)));
    const reviewMessage = reviewCode === "label_not_found"
      ? "Typový štítek nebyl nalezen."
      : reviewCode === "multiple_label_candidates"
        ? "Bylo nalezeno více rovnocenných kandidátů typového štítku."
        : reviewCode === "multiple_value_candidates"
          ? "U některých polí bylo nalezeno více rovnocenných hodnot."
          : reviewCode === "missing_required_fields"
            ? "Některá povinná pole chybí nebo nemají dostatečnou jistotu."
            : null;
    const auditPayload = {
      parserVersion: SWITCHBOARD_PARSER_VERSION,
      result: result.status,
      extractionMethod: extracted.elements.some((element) => element.method === "ocr") ? "ocr" : "text_layer",
      candidatePages: result.candidatePages,
      selectedPage: "selectedPage" in result ? result.selectedPage : null,
      ambiguousPages: "ambiguousPages" in result ? result.ambiguousPages : [],
      ambiguousFields: "ambiguousFields" in result ? result.ambiguousFields : [],
      fieldCount: result.fields.length,
      fields: result.fields.map((field) => ({
        fieldKey: field.fieldKey,
        foundLabel: field.foundLabel,
        matchedAlias: field.matchedAlias,
        rawValue: field.rawValue,
        normalizedValue: field.normalizedValue,
        confidence: field.confidence,
        pageNumber: field.pageNumber,
        blockId: field.blockId,
        extractionMethod: field.extractionMethod,
        relativeRelation: field.relativeRelation,
        validationStatus: field.validationStatus,
        validationMessage: field.validationMessage,
        valueCandidates: field.valueCandidates,
      })),
    };
    await db.transaction(async (tx) => {
      await tx.delete(switchboardExtractedFieldsTable).where(eq(switchboardExtractedFieldsTable.documentId, document.id));
      if (result.fields.length) await tx.insert(switchboardExtractedFieldsTable).values(result.fields.map((field) => ({ documentId: document.id, ...field, confidence: String(field.confidence) })));
      const intermediateStatus = complete ? "generating_label" : "needs_review";
      await tx.update(switchboardDocumentsTable).set({ processingStatus: intermediateStatus, processingErrorCode: reviewCode, processingErrorMessage: reviewMessage }).where(eq(switchboardDocumentsTable.id, document.id));
      await tx.update(switchboardsTable).set({
        ...(complete ? switchboardPatchFromExtractedFields(result.fields) : {}),
        processingStatus: intermediateStatus,
        status: "documentation_uploaded",
        updatedAt: new Date(),
      }).where(eq(switchboardsTable.id, document.switchboardId));
      if (!complete) {
        await tx.update(switchboardProcessingJobsTable).set({ status: "completed", completedAt: new Date(), errorCode: reviewCode, errorMessage: reviewMessage }).where(eq(switchboardProcessingJobsTable.id, claimed.id));
        await tx.insert(switchboardEventsTable).values({ switchboardId: document.switchboardId, eventType: "document_processed", entityType: "switchboard_document", entityId: document.id, payload: auditPayload, actorName: "System" });
      }
    });
    if (!complete) return;

    const labelResult = await createSwitchboardLabelVersion({
      switchboardId: document.switchboardId,
      sourceDocumentId: document.id,
      mode: "automatic",
      actor: { userId: null, name: "System" },
    });
    await db.transaction(async (tx) => {
      await tx.update(switchboardDocumentsTable).set({ processingStatus: "completed", processingErrorCode: null, processingErrorMessage: null }).where(eq(switchboardDocumentsTable.id, document.id));
      await tx.update(switchboardsTable).set({ processingStatus: "completed", updatedAt: new Date() }).where(eq(switchboardsTable.id, document.switchboardId));
      await tx.update(switchboardProcessingJobsTable).set({ status: "completed", completedAt: new Date(), errorCode: null, errorMessage: null }).where(eq(switchboardProcessingJobsTable.id, claimed.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: document.switchboardId, eventType: "document_processed", entityType: "switchboard_document", entityId: document.id, payload: { ...auditPayload, labelVersion: labelResult.label.version, labelCreated: labelResult.created, qrActivated: labelResult.qrActivated }, actorName: "System" });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Neznámá chyba.";
    const code = (error as { code?: string }).code ?? "processing_failed";
    const requiresReview = ["qr_inactive", "qr_expired", "label_fields_missing"].includes(code);
    const exhausted = requiresReview || claimed.attemptCount >= claimed.maxAttempts;
    const documentStatus = requiresReview ? "needs_review" : exhausted ? "failed" : "queued";
    await db.update(switchboardProcessingJobsTable).set({ status: exhausted ? "failed" : "queued", availableAt: new Date(Date.now() + 30_000), errorCode: code, errorMessage: message, completedAt: exhausted ? new Date() : null }).where(eq(switchboardProcessingJobsTable.id, claimed.id));
    await db.update(switchboardDocumentsTable).set({ processingStatus: documentStatus, processingErrorCode: code, processingErrorMessage: message }).where(eq(switchboardDocumentsTable.id, claimed.documentId));
    if (switchboardId) {
      await db.update(switchboardsTable).set({ processingStatus: documentStatus, updatedAt: new Date() }).where(eq(switchboardsTable.id, switchboardId));
      if (requiresReview) await db.insert(switchboardEventsTable).values({ switchboardId, eventType: "label_generation_blocked", entityType: "switchboard_document", entityId: claimed.documentId, payload: { code, message }, actorName: "System" });
    }
    logger.error({ err: error, switchboardProcessingJobId: claimed.id }, "Switchboard document processing failed");
  }
}

export async function drainSwitchboardQueue() {
  if (draining) return; draining = true;
  try {
    await db.update(switchboardProcessingJobsTable).set({ status: "queued", lockedAt: null, lockedBy: null, availableAt: new Date(), errorMessage: "Úloha obnovena po restartu serveru." }).where(and(eq(switchboardProcessingJobsTable.status, "running"), lt(switchboardProcessingJobsTable.lockedAt, new Date(Date.now() - STALE_MS))));
    const jobs = await db.select({ id: switchboardProcessingJobsTable.id }).from(switchboardProcessingJobsTable).where(and(eq(switchboardProcessingJobsTable.status, "queued"), lte(switchboardProcessingJobsTable.availableAt, new Date()))).orderBy(asc(switchboardProcessingJobsTable.availableAt)).limit(2);
    for (const job of jobs) await processOne(job.id);
  } finally { draining = false; }
}

export function startSwitchboardWorker() {
  if (started) return; started = true;
  void drainSwitchboardQueue();
  setInterval(() => void drainSwitchboardQueue(), 5_000).unref();
}
