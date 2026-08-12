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
import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
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
  reconcileDocumentRelationships,
  reconcileIncompleteMultipagePagesSafely,
} from "./cost-document-service";
import { publishLiveEvent } from "./live-events-service";

/** Domains emitted by this worker on every state change. */
const WORKER_DOMAINS = [
  "billingDocuments",
  "reviewQueue",
  "emailImport",
] as const;

export type SchedulerStopHandle = Readonly<{
  stop(): void;
}>;

let schedulerHandle: SchedulerStopHandle | undefined;
let draining = false;
let relationshipBackfillCompleted = false;
let relationshipBackfillRun: Promise<void> | undefined;

const POLL_MS = 5_000;
const BATCH = 5;
const STALE_RUNNING_MS = 30 * 60 * 1_000;

function isStopped(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

class ExtractionWorkerStoppedError extends Error {
  constructor() {
    super("Extraction worker stopped");
    this.name = "ExtractionWorkerStoppedError";
  }
}

function throwIfStopped(signal?: AbortSignal): void {
  if (isStopped(signal)) throw new ExtractionWorkerStoppedError();
}

async function requeueAbortedExtractionClaim(job: {
  id: number;
  attempts: number;
  startedAt: Date | null;
}): Promise<boolean> {
  if (!job.startedAt) return false;
  const requeued = await db
    .update(extractionJobsTable)
    .set({
      status: "queued",
      attempts: sql`greatest(${extractionJobsTable.attempts} - 1, 0)`,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(extractionJobsTable.id, job.id),
        eq(extractionJobsTable.status, "running"),
        eq(extractionJobsTable.attempts, job.attempts),
        eq(extractionJobsTable.startedAt, job.startedAt),
      ),
    )
    .returning({ id: extractionJobsTable.id });
  return requeued.length === 1;
}

/** Statuses we never override when finishing extraction (human already acted). */
const TERMINAL_DOC_STATUSES = new Set([
  "approved",
  "ignored",
  "reviewed",
  "duplicate",
  "merged",
]);

async function reconcileDocumentRelationshipsUntilStopped(
  signal: AbortSignal,
): Promise<{
  processed: number;
  withLinks: number;
  withConfirmedLinks: number;
  failedDocumentIds: number[];
  stopped: boolean;
}> {
  if (signal.aborted) {
    return {
      processed: 0,
      withLinks: 0,
      withConfirmedLinks: 0,
      failedDocumentIds: [],
      stopped: true,
    };
  }

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

  let processed = 0;
  let withLinks = 0;
  let withConfirmedLinks = 0;
  const failedDocumentIds: number[] = [];
  for (const document of documents) {
    if (signal.aborted) break;
    try {
      const result = await reconcileDocumentRelationships(document.id);
      processed += 1;
      if (result.linkedDocumentIds.length > 0) withLinks += 1;
      if (result.confirmedDocumentIds.length > 0) withConfirmedLinks += 1;
    } catch (error) {
      processed += 1;
      failedDocumentIds.push(document.id);
      logger.error(
        { err: error, documentId: document.id },
        "Historical billing-document reconciliation failed",
      );
    }
  }

  return {
    processed,
    withLinks,
    withConfirmedLinks,
    failedDocumentIds,
    stopped: signal.aborted,
  };
}

/** Finalise a job as `skipped` (a non-error terminal state) with a note. */
async function markSkipped(
  jobId: number,
  note: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfStopped(signal);
  await db
    .update(extractionJobsTable)
    .set({
      status: "skipped",
      lastError: note,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(extractionJobsTable.id, jobId));
  throwIfStopped(signal);
  publishLiveEvent(WORKER_DOMAINS).catch(() => {});
}

async function moveDocumentToNeedsReview(
  documentId: number,
  force: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfStopped(signal);
  return db.transaction(async (tx) => {
    const [document] = await tx
      .select({ status: billingDocumentsTable.status })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId))
      .for("update");
    throwIfStopped(signal);
    if (!document || TERMINAL_DOC_STATUSES.has(document.status)) {
      return false;
    }

    await tx
      .update(billingDocumentsTable)
      .set({
        status: "needs_review",
        updatedAt: new Date(),
        ...(force
          ? {
              primaryDocumentId: null,
              mergeGroupId: null,
            }
          : {}),
      })
      .where(eq(billingDocumentsTable.id, documentId));
    return true;
  });
}

async function processOne(jobId: number, signal?: AbortSignal): Promise<void> {
  if (isStopped(signal)) return;
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
  if (isStopped(signal)) {
    await requeueAbortedExtractionClaim(job);
    return;
  }
  // Notify: extraction job is now running (queued → running state change).
  publishLiveEvent(WORKER_DOMAINS).catch(() => {});
  let claimCanBeSafelyRequeued = true;

  try {
    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, job.documentId));
    throwIfStopped(signal);
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
      throwIfStopped(signal);
      publishLiveEvent(WORKER_DOMAINS).catch(() => {});
      return;
    }

    // Neither ordinary nor forced AI passes may rewrite a document after a
    // human terminal decision. A correction must open a new immutable version;
    // it cannot be emulated by reopening and replacing this row.
    const forcedDuplicate = job.force === true && doc.status === "duplicate";
    if (TERMINAL_DOC_STATUSES.has(doc.status) && !forcedDuplicate) {
      await markSkipped(
        job.id,
        "Doklad je již ve finálním stavu – přeskočeno.",
        signal,
      );
      return;
    }

    const cfg = await resolveOpenAiConfig();
    throwIfStopped(signal);

    // Decide whether AI extraction should run for this document. We skip when:
    // AI is off, the file type is unsupported, there is no stored file, or the
    // document already has lines (e.g. parsed from ISDOC at upload time).
    const aiReady =
      cfg.ready && isSupportedForAi(doc.contentType, doc.fileName);
    const [{ count: lineCount }] = aiReady
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(billingDocumentLinesTable)
          .where(eq(billingDocumentLinesTable.documentId, doc.id))
      : [{ count: 0 }];
    throwIfStopped(signal);

    if (!aiReady || (lineCount > 0 && !job.force)) {
      // No AI: route to manual review (preserve the existing behavior).
      const moved = await moveDocumentToNeedsReview(
        doc.id,
        job.force === true,
        signal,
      );
      await markSkipped(
        job.id,
        moved
          ? cfg.ready
            ? "AI vytěžení se nepoužilo (nepodporovaný typ nebo doklad již obsahuje položky) – připraveno k ruční kontrole."
            : "Automatická extrakce (AI) není nakonfigurována – připraveno k ruční kontrole."
          : "Doklad mezitím přešel do finálního stavu – přeskočeno.",
        signal,
      );
      return;
    }

    // Run AI extraction. A throw here is caught below and retried per attempts.
    // A multi-page upload (photographed page by page) attaches several files to
    // one document; all AI-supported files are sent together so the model can
    // merge the header (often only on page 1) with items spread across pages.
    const files = await getDocumentAllFileBuffers(doc.id);
    throwIfStopped(signal);
    if (!files.length) {
      const moved = await moveDocumentToNeedsReview(
        doc.id,
        job.force === true,
        signal,
      );
      await markSkipped(
        job.id,
        moved
          ? "Soubor dokladu nenalezen – připraveno k ruční kontrole."
          : "Doklad mezitím přešel do finálního stavu – přeskočeno.",
        signal,
      );
      return;
    }

    throwIfStopped(signal);
    const { result, rawText, model } = await extractFromFiles(files);

    throwIfStopped(signal);
    claimCanBeSafelyRequeued = false;
    await applyAiSuggestion(
      doc.id,
      {
        docType: result.docType,
        docTypeConfidence: result.docTypeConfidence,
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
    if (isStopped(signal)) return;
    await reconcileIncompleteMultipagePagesSafely(doc.id);
    if (isStopped(signal)) return;
    logger.info(
      {
        extractionJobId: job.id,
        documentId: doc.id,
        confidence: result.confidence,
      },
      "AI extraction completed",
    );
    publishLiveEvent(WORKER_DOMAINS).catch(() => {});
  } catch (err) {
    if (
      claimCanBeSafelyRequeued &&
      (err instanceof ExtractionWorkerStoppedError || isStopped(signal))
    ) {
      await requeueAbortedExtractionClaim(job);
      return;
    }
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

export async function drainQueue(signal?: AbortSignal): Promise<void> {
  if (isStopped(signal) || draining) return;
  draining = true;
  try {
    if (isStopped(signal)) return;
    const recovered = await db
      .update(extractionJobsTable)
      .set({
        status: "queued",
        startedAt: null,
        lastError:
          "Předchozí běh byl přerušen restartem serveru; úloha byla obnovena.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(extractionJobsTable.status, "running"),
          lt(
            extractionJobsTable.startedAt,
            new Date(Date.now() - STALE_RUNNING_MS),
          ),
          lt(extractionJobsTable.attempts, extractionJobsTable.maxAttempts),
        ),
      )
      .returning({ id: extractionJobsTable.id });
    if (isStopped(signal)) return;
    if (recovered.length) {
      logger.warn(
        { count: recovered.length },
        "Recovered stale extraction jobs",
      );
      publishLiveEvent(WORKER_DOMAINS).catch(() => {});
    }

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
      if (isStopped(signal)) break;
      await processOne(row.id, signal);
    }
  } finally {
    draining = false;
  }
}

export function startExtractionWorker(): SchedulerStopHandle {
  if (schedulerHandle) return schedulerHandle;
  const abortController = new AbortController();
  const { signal } = abortController;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    drainQueue(signal).catch((err) =>
      logger.error({ err }, "Extraction queue drain failed"),
    );
  }, POLL_MS);
  timer.unref();

  logger.info({ pollMs: POLL_MS }, "Extraction worker started");

  const initialBackfill = setTimeout(() => {
    void (async () => {
      const previousRun = relationshipBackfillRun;
      if (previousRun) await previousRun;

      if (stopped || signal.aborted || relationshipBackfillCompleted) return;
      const run = reconcileDocumentRelationshipsUntilStopped(signal)
        .then((result) => {
          if (signal.aborted) return;
          relationshipBackfillCompleted = true;
          logger.info(
            result,
            "Historical billing-document reconciliation completed",
          );
          if (result.withLinks > 0) {
            publishLiveEvent(WORKER_DOMAINS).catch(() => {});
          }
        })
        .catch((err) => {
          if (signal.aborted) return;
          logger.error(
            { err },
            "Historical billing-document reconciliation could not start",
          );
        })
        .finally(() => {
          if (relationshipBackfillRun === run) {
            relationshipBackfillRun = undefined;
          }
        });
      relationshipBackfillRun = run;
      await run;
    })();
  }, 0);
  initialBackfill.unref();

  const handle: SchedulerStopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      clearTimeout(initialBackfill);
      clearInterval(timer);
      if (schedulerHandle === handle) schedulerHandle = undefined;
    },
  };
  schedulerHandle = handle;
  return handle;
}
