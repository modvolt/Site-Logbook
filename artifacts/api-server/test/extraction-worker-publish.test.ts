/**
 * Unit tests for extraction-worker.ts publish behaviour.
 *
 * Verifies two key invariants from task P1.2:
 *   1. drainQueue() does NOT emit a live event when it finds no pending jobs
 *      (i.e. the initial SELECT — "mere loading" — must not trigger publish).
 *   2. drainQueue() DOES emit a live event when it successfully claims and
 *      processes an extraction job (real state change in DB).
 *
 * Strategy: publishLiveEvent is replaced by a vi.spy. openai-extraction is
 * mocked so AI never runs (cfg.ready = false), keeping the test self-contained.
 * cost-document-service is mocked so getDocumentFileBuffer is never reached.
 * The real database is used so the actual Drizzle queries execute.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  extractionJobsTable,
} from "@workspace/db";

const mocks = vi.hoisted(() => ({
  publishLiveEvent: vi.fn().mockResolvedValue(undefined),
  resolveOpenAiConfig: vi.fn().mockResolvedValue({ ready: false }),
  isSupportedForAi: vi.fn().mockReturnValue(false),
  extractFromFile: vi.fn(),
  applyAiSuggestion: vi.fn(),
  getDocumentFileBuffer: vi.fn(),
}));

vi.mock("../src/lib/live-events-service", () => ({
  publishLiveEvent: mocks.publishLiveEvent,
}));

vi.mock("../src/lib/openai-extraction", () => ({
  resolveOpenAiConfig: mocks.resolveOpenAiConfig,
  isSupportedForAi: mocks.isSupportedForAi,
  extractFromFile: mocks.extractFromFile,
}));

vi.mock("../src/lib/cost-document-service", () => ({
  applyAiSuggestion: mocks.applyAiSuggestion,
  getDocumentFileBuffer: mocks.getDocumentFileBuffer,
}));

const { drainQueue } = await import("../src/lib/extraction-worker");

const TAG = `test-ew-publish-${Date.now()}`;
let createdDocIds: number[] = [];
let createdJobIds: number[] = [];

afterEach(async () => {
  mocks.publishLiveEvent.mockClear();

  // Clean up test rows
  if (createdJobIds.length) {
    for (const id of createdJobIds) {
      await db.delete(extractionJobsTable).where(eq(extractionJobsTable.id, id));
    }
    createdJobIds = [];
  }
  if (createdDocIds.length) {
    for (const id of createdDocIds) {
      await db.delete(billingDocumentsTable).where(eq(billingDocumentsTable.id, id));
    }
    createdDocIds = [];
  }
});

describe("extraction worker – publish behaviour", () => {
  it("does NOT emit when the queue is empty (bare SELECT, no state change)", async () => {
    // No extraction jobs in the queue — drainQueue should just SELECT and return.
    await drainQueue();
    // publishLiveEvent must never be called on a bare SELECT.
    expect(mocks.publishLiveEvent).not.toHaveBeenCalled();
  });

  it("DOES emit after claiming a queued job and transitioning its state", async () => {
    // Insert a billing document + extraction job in 'queued' state.
    const [doc] = await db
      .insert(billingDocumentsTable)
      .values({
        fileName: `${TAG}-doc.pdf`,
        contentType: "application/pdf",
        status: "pending",
        source: "manual",
        sizeBytes: 1234,
      })
      .returning();
    createdDocIds.push(doc.id);

    const [job] = await db
      .insert(extractionJobsTable)
      .values({
        documentId: doc.id,
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
      })
      .returning();
    createdJobIds.push(job.id);

    // Run the drain — AI is off (mocked), so the document goes to needs_review
    // and the job is marked skipped.
    await drainQueue();

    // At least one emit must have occurred (claim → running, then skipped).
    expect(mocks.publishLiveEvent).toHaveBeenCalled();
    // All calls must include billingDocuments.
    for (const call of mocks.publishLiveEvent.mock.calls) {
      expect(call[0]).toContain("billingDocuments");
    }
  });
});
