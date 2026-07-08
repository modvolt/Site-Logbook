/**
 * Conservative in-process extraction worker for received cost documents.
 *
 * It polls the DB-backed `extraction_jobs` queue, claims `queued` rows one at a
 * time (mark running → attempts++), and finalises them. ISDOC/XML documents are
 * already parsed inline at upload time, so machine-side there is nothing left to
 * do for them.
 *
 * AI extraction (for PDFs / photos) is OPTIONAL: it only runs when the operator
 * has configured OPENAI_API_KEY *and* enabled it (OPENAI_DOCUMENT_EXTRACTION_
 * ENABLED=true). When AI is off, or the file type is unsupported, or the document
 * already has lines (e.g. parsed from ISDOC), the worker simply routes the
 * document to `needs_review` for a human and marks the job `skipped` — exactly as
 * before. AI output is never auto-approved; it is persisted as a `needs_review`
 * suggestion. The worker never guesses values and never blocks uploads.
 *
 * The poll loop is single-flight (a module-level guard) and uses an unref'd
 * timer so it never keeps the process alive on its own.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  db,
  extractionJobsTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  resolveOpenAiConfig,
  isSupportedForAi,
  extractFromFiles,
} from "./openai-extraction";
import {
  applyAiSuggestion,
  getDocumentAllFileBuffers,
  reconcileAllDocumentRelationships,
  setDocumentStatus,
} from "./cost-document-service";
import { publishLiveEvent } from "./live-events-service";

/** Domains emitted by this worker on every state change. */
const WORKER_DOMAINS = ["billingDocuments", "reviewQueue", "emailImport"] as const;

let schedulerStarted = false;
let draining = false;
let relationshipBackfillStarted = false;

const POLL_MS = 5_000;
const BATCH = 5;

/** Statuses we never override when finishing extraction (human already acted). */
const TERMINAL_DOC_STATUSES = new Set(["approved", "ignored", "reviewed", "duplicate"]);

/** Finalise a job as `skipped` (a non-error terminal state) with a note. */
async function markSkipped(jobId: number, note: string): Promise<void> {
  await db
    .update(extractionJobsTable)
    .set({
      status: "skipped",
      lastError: note,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(extractionJobsTable.id, jobId));
  publishLiveEvent(WORKER_DOMAINS).catch(() => {});
}

async function moveDocumentToNeedsReview(
  documentId: number,
  currentStatus: string,
  force: boolean,
): Promise<void> {
  if (force && currentStatus === "approved") {
    await setDocumentStatus(documentId, "needs_review", {
      userId: null,
      name: "System",
    });
    return;
  }
  const patch: Partial<typeof billingDocumentsTable.$inferInsert> = {
    status: "needs_review",
    updatedAt: new Date(),
  };
  if (force && currentStatus === "duplicate") {
    patch.primaryDocumentId = null;
    patch.mergeGroupId = null;
  }
  await db.update(billingDocumentsTable).set(patch).where(eq(billingDocumentsTable.id, documentId));
}

async function processOne(jobId: number): Promise<void> {
  // Claim the job: queued → running, attempts++. Skip if no longer claimable.
  const claimed = await db
    .update(extractionJobsTable)
    .set({
      status: "running",
      attempts: sql`${extractionJobsTable.attempts} + 1`,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(extractionJobsTable.id, jobId),
        eq(extractionJobsTable.status, "queued"),
      ),
    )
    .returning();
  if (!claimed.length) return;
  const job = claimed[0];
  // Notify: extraction job is now running (queued → running state change).
  publishLiveEvent(WORKER_DOMAINS).catch(() => {});

  try {
    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, job.documentId));
    if (!doc) {
      await db
        .update(extractionJobsTable)
        .set({
          status: "failed",
          lastError: "Doklad neexistuje.",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(extractionJobsTable.id, job.id));
      publishLiveEvent(WORKER_DOMAINS).catch(() => {});
      return;
    }

    // Normal AI passes never touch a document a human already moved to a
    // terminal state. A forced maintenance pass is allowed to reopen it after
    // applyAiSuggestion has cleaned up document-owned propagation.
    if (TERMINAL_DOC_STATUSES.has(doc.status) && !job.force) {
      await markSkipped(job.id, "Doklad je již ve finálním stavu – přeskočeno.");
      return;
    }

    const cfg = await resolveOpenAiConfig();

    // Decide whether AI extraction should run for this document. We skip when:
    // AI is off, the file type is unsupported, there is no stored file, or the
    // document already has lines (e.g. parsed from ISDOC at upload time).
    const aiReady = cfg.ready && isSupportedForAi(doc.contentType, doc.fileName);
    const [{ count: lineCount }] = aiReady
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(billingDocumentLinesTable)
          .where(eq(billingDocumentLinesTable.documentId, doc.id))
      : [{ count: 0 }];

    if (!aiReady || (lineCount > 0 && !job.force)) {
      // No AI: route to manual review (preserve the existing behavior).
      await moveDocumentToNeedsReview(doc.id, doc.status, job.force === true);
      await markSkipped(
        job.id,
        cfg.ready
          ? "AI vytěžení se nepoužilo (nepodporovaný typ nebo doklad již obsahuje položky) – připraveno k ruční kontrole."
          : "Automatická extrakce (AI) není nakonfigurována – připraveno k ruční kontrole.",
      );
      return;
    }

    // Run AI extraction. A throw here is caught below and retried per attempts.
    // A multi-page upload (photographed page by page) attaches several files to
    // one document; all AI-supported files are sent together so the model can
    // merge the header (often only on page 1) with items spread across pages.
    const files = await getDocumentAllFileBuffers(doc.id);
    if (!files.length) {
      await moveDocumentToNeedsReview(doc.id, doc.status, job.force === true);
      await markSkipped(job.id, "Soubor dokladu nenalezen – připraveno k ruční kontrole.");
      return;
    }

    const { result, rawText, model } = await extractFromFiles(files);

    await applyAiSuggestion(
      doc.id,
      {
        docType: result.docType,
        supplierName: result.supplierName,
        supplierIc: result.supplierIc,
        supplierDic: result.supplierDic,
        supplierAddress: result.supplierAddress,
        documentNumber: result.documentNumber,
        variableSymbol: result.variableSymbol,
        issueDate: result.issueDate,
        taxableSupplyDate: result.taxableSupplyDate,
        dueDate: result.dueDate,
        currency: result.currency,
        subtotalWithoutVat: result.subtotalWithoutVat,
        totalVat: result.totalVat,
        totalWithVat: result.totalWithVat,
        pageNumber: result.pageNumber,
        pageCount: result.pageCount,
        finalTotalPresent: result.finalTotalPresent,
        lines: result.lines,
        relatedDocuments: result.relatedDocuments,
        confidence: result.confidence,
        warnings: result.warnings,
        model,
        rawJson: rawText,
      },
      { replaceExisting: job.force === true },
    );

    await db
      .update(extractionJobsTable)
      .set({
        status: "done",
        lastError: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(extractionJobsTable.id, job.id));
    logger.info(
      { extractionJobId: job.id, documentId: doc.id, confidence: result.confidence },
      "AI extraction completed",
    );
    publishLiveEvent(WORKER_DOMAINS).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "neznámá chyba";
    const exhausted = job.attempts >= job.maxAttempts;
    await db
      .update(extractionJobsTable)
      .set({
        status: exhausted ? "failed" : "queued",
        lastError: message,
        finishedAt: exhausted ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(extractionJobsTable.id, job.id));
    logger.error(
      { err, extractionJobId: job.id, documentId: job.documentId, exhausted },
      "Extraction job failed",
    );
    publishLiveEvent(WORKER_DOMAINS).catch(() => {});
  }
}

export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const pending = await db
      .select({ id: extractionJobsTable.id })
      .from(extractionJobsTable)
      .where(
        and(
          eq(extractionJobsTable.status, "queued"),
          lt(extractionJobsTable.attempts, extractionJobsTable.maxAttempts),
        ),
      )
      .orderBy(asc(extractionJobsTable.id))
      .limit(BATCH);
    for (const row of pending) {
      await processOne(row.id);
    }
  } finally {
    draining = false;
  }
}

export function startExtractionWorker(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const timer = setInterval(() => {
    drainQueue().catch((err) =>
      logger.error({ err }, "Extraction queue drain failed"),
    );
  }, POLL_MS);
  timer.unref();

  logger.info({ pollMs: POLL_MS }, "Extraction worker started");

  if (!relationshipBackfillStarted) {
    relationshipBackfillStarted = true;
    void reconcileAllDocumentRelationships()
      .then((result) => {
        logger.info(result, "Historical billing-document reconciliation completed");
        if (result.withLinks > 0) {
          publishLiveEvent(WORKER_DOMAINS).catch(() => {});
        }
      })
      .catch((err) => {
        logger.error(
          { err },
          "Historical billing-document reconciliation could not start",
        );
      });
  }
}
