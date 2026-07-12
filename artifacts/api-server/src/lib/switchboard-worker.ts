import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { db, switchboardDocumentsTable, switchboardExtractedFieldsTable, switchboardFieldRegistryTable, switchboardProcessingJobsTable, switchboardsTable, switchboardEventsTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { parseSwitchboardLabel, SWITCHBOARD_PARSER_VERSION, type FieldDefinition } from "./switchboard-parser";
import { extractPdfOcrElements, extractPdfTextElements } from "./switchboard-pdf";

const storage = new ObjectStorageService();
let started = false; let draining = false;
const STALE_MS = 30 * 60_000;

async function processOne(id: number) {
  const [claimed] = await db.update(switchboardProcessingJobsTable).set({ status: "running", attemptCount: sql`${switchboardProcessingJobsTable.attemptCount} + 1`, startedAt: new Date(), lockedAt: new Date(), lockedBy: process.env.HOSTNAME ?? "api" })
    .where(and(eq(switchboardProcessingJobsTable.id, id), eq(switchboardProcessingJobsTable.status, "queued"))).returning();
  if (!claimed) return;
  try {
    const [document] = await db.select().from(switchboardDocumentsTable).where(eq(switchboardDocumentsTable.id, claimed.documentId));
    if (!document) throw Object.assign(new Error("Dokument neexistuje."), { code: "document_missing" });
    await db.update(switchboardDocumentsTable).set({ processingStatus: "analyzing_pdf" }).where(eq(switchboardDocumentsTable.id, document.id));
    const buffer = await storage.getPrivateObjectBuffer(document.storagePath);
    let extracted = await extractPdfTextElements(buffer);
    let registryRows = await db.select().from(switchboardFieldRegistryTable).where(eq(switchboardFieldRegistryTable.isActive, true));
    const registry: FieldDefinition[] = registryRows.map((field) => ({ ...field, minimumConfidence: Number(field.minimumConfidence) }));
    let result = parseSwitchboardLabel(extracted.elements, registry);
    if (result.status === "label_not_found") {
      await db.update(switchboardDocumentsTable).set({ processingStatus: "ocr" }).where(eq(switchboardDocumentsTable.id, document.id));
      extracted = await extractPdfOcrElements(buffer);
      result = parseSwitchboardLabel(extracted.elements, registry);
    }
    await db.transaction(async (tx) => {
      await tx.delete(switchboardExtractedFieldsTable).where(eq(switchboardExtractedFieldsTable.documentId, document.id));
      if (result.fields.length) await tx.insert(switchboardExtractedFieldsTable).values(result.fields.map((field) => ({ documentId: document.id, ...field, confidence: String(field.confidence) })));
      const finalStatus = result.status === "complete" ? "completed" : "needs_review";
      await tx.update(switchboardDocumentsTable).set({ processingStatus: finalStatus, processingErrorCode: result.status === "label_not_found" ? "label_not_found" : null, processingErrorMessage: result.status === "label_not_found" ? "Typový štítek nebyl nalezen." : null }).where(eq(switchboardDocumentsTable.id, document.id));
      await tx.update(switchboardsTable).set({ processingStatus: finalStatus, status: "documentation_uploaded", updatedAt: new Date() }).where(eq(switchboardsTable.id, document.switchboardId));
      await tx.update(switchboardProcessingJobsTable).set({ status: "completed", completedAt: new Date(), errorCode: null, errorMessage: null }).where(eq(switchboardProcessingJobsTable.id, claimed.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: document.switchboardId, eventType: "document_processed", entityType: "switchboard_document", entityId: document.id, payload: { parserVersion: SWITCHBOARD_PARSER_VERSION, result: result.status, candidatePages: result.candidatePages, fieldCount: result.fields.length }, actorName: "System" });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Neznámá chyba.";
    const exhausted = claimed.attemptCount >= claimed.maxAttempts;
    await db.update(switchboardProcessingJobsTable).set({ status: exhausted ? "failed" : "queued", availableAt: new Date(Date.now() + 30_000), errorCode: (error as { code?: string }).code ?? "processing_failed", errorMessage: message, completedAt: exhausted ? new Date() : null }).where(eq(switchboardProcessingJobsTable.id, claimed.id));
    await db.update(switchboardDocumentsTable).set({ processingStatus: exhausted ? "failed" : "queued", processingErrorCode: (error as { code?: string }).code ?? "processing_failed", processingErrorMessage: message }).where(eq(switchboardDocumentsTable.id, claimed.documentId));
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
