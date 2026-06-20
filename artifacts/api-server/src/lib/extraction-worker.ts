/**
 * Conservative in-process extraction worker for received cost documents.
 *
 * It polls the DB-backed `extraction_jobs` queue, claims `queued` rows one at a
 * time (mark running → attempts++), and finalises them. ISDOC/XML documents are
 * already parsed inline at upload time, so machine-side there is nothing left to
 * do; AI-based extraction (for PDFs / photos) is intentionally NOT implemented
 * here — it is a downstream task. Until then this worker simply routes every
 * document to `needs_review` for a human and marks the job `done`/`skipped`. It
 * never guesses values and never blocks uploads.
 *
 * The poll loop is single-flight (a module-level guard) and uses an unref'd
 * timer so it never keeps the process alive on its own.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  db,
  extractionJobsTable,
  billingDocumentsTable,
} from "@workspace/db";
import { logger } from "./logger";

let schedulerStarted = false;
let draining = false;

const POLL_MS = 5_000;
const BATCH = 5;

/** Statuses we never override when finishing extraction (human already acted). */
const TERMINAL_DOC_STATUSES = new Set(["approved", "ignored", "reviewed"]);

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
      return;
    }

    // AI extraction is disabled: route to manual review unless a human already
    // moved the document to a terminal state.
    if (!TERMINAL_DOC_STATUSES.has(doc.status)) {
      await db
        .update(billingDocumentsTable)
        .set({ status: "needs_review", updatedAt: new Date() })
        .where(eq(billingDocumentsTable.id, doc.id));
    }

    await db
      .update(extractionJobsTable)
      .set({
        status: "skipped",
        lastError:
          "Automatická extrakce (AI) zatím není k dispozici – připraveno k ruční kontrole.",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(extractionJobsTable.id, job.id));
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
  }
}

async function drainQueue(): Promise<void> {
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
}
