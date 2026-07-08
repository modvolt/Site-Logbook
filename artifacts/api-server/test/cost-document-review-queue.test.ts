import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  jobsTable,
  materialsTable,
} from "@workspace/db";
import { listDocuments } from "../src/lib/cost-document-service";

/**
 * AI review-queue filtering + sorting (DB-backed).
 *
 * The queue is built from listDocuments({ status: "needs_review", aiOnly: true,
 * sort: "confidence_asc" }). Two pieces of logic have no other automated cover:
 *
 *  - `aiOnly` must keep ONLY documents that were prefilled by AI (i.e. have an
 *    `aiExtractedAt`), so manually-uploaded / ISDOC docs never leak into the
 *    review queue.
 *  - `confidence_asc` must surface the riskiest suggestions first: lowest
 *    `aiConfidence` first, NULL confidence last (Postgres ASC NULLS LAST), ties
 *    broken by newest (`createdAt` desc).
 *
 * Runs against the dev database (DATABASE_URL). All fixtures carry a unique tag
 * and are torn down afterwards. Requires the billing tables from migrations
 * 0008/0009 to exist (see .agents/memory/test-db-schema-drift.md).
 */

const TAG = `test-rq-${Date.now()}`;
const docIds: number[] = [];
const jobIds: number[] = [];
const materialIds: number[] = [];

interface DocOpts {
  status?: string;
  source?: string;
  aiConfidence?: string | null;
  aiExtractedAt?: Date | null;
  createdAt?: Date;
}

async function makeDoc(opts: DocOpts): Promise<number> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: opts.status ?? "needs_review",
      docType: "invoice",
      source: opts.source ?? "manual",
      supplierName: `Dodavatel ${TAG}`,
      aiConfidence: opts.aiConfidence ?? null,
      aiExtractedAt: opts.aiExtractedAt ?? null,
      aiModel: opts.aiExtractedAt ? "gpt-4o" : null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  docIds.push(doc.id);
  return doc.id;
}

/** Restrict assertions to a known set of ids (the table is shared / global). */
function only(rows: { id: number }[], ids: number[]): number[] {
  const set = new Set(ids);
  return rows.map((r) => r.id).filter((id) => set.has(id));
}

afterAll(async () => {
  if (materialIds.length) {
    await db.delete(materialsTable).where(inArray(materialsTable.id, materialIds));
    materialIds.length = 0;
  }
  if (docIds.length) {
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
});

describe("listDocuments aiOnly filter", () => {
  let aiDocId: number;
  let manualDocId: number;

  beforeAll(async () => {
    aiDocId = await makeDoc({
      source: "email",
      aiConfidence: "0.85",
      aiExtractedAt: new Date(),
    });
    // A needs_review doc with NO aiExtractedAt (e.g. manual upload / ISDOC prefill).
    manualDocId = await makeDoc({ aiConfidence: null, aiExtractedAt: null });
  });

  it("excludes documents with no aiExtractedAt when aiOnly is true", async () => {
    const rows = await listDocuments({ status: "needs_review", aiOnly: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(aiDocId);
    expect(ids).not.toContain(manualDocId);
    // Every returned row really was AI-extracted.
    for (const r of rows) {
      expect(r.aiExtractedAt).not.toBeNull();
    }
  });

  it("includes non-AI documents when aiOnly is not set", async () => {
    const rows = await listDocuments({ status: "needs_review" });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(aiDocId);
    expect(ids).toContain(manualDocId);
  });
});

describe("listDocuments confidence_asc sort", () => {
  let lowId: number;
  let midId: number;
  let highId: number;
  let nullNewerId: number;
  let nullOlderId: number;

  beforeAll(async () => {
    const base = Date.now();
    // Distinct createdAt so the tie-break ordering is deterministic.
    lowId = await makeDoc({
      source: "email",
      aiConfidence: "0.20",
      aiExtractedAt: new Date(),
      createdAt: new Date(base - 5000),
    });
    midId = await makeDoc({
      source: "email",
      aiConfidence: "0.55",
      aiExtractedAt: new Date(),
      createdAt: new Date(base - 4000),
    });
    highId = await makeDoc({
      source: "email",
      aiConfidence: "0.95",
      aiExtractedAt: new Date(),
      createdAt: new Date(base - 3000),
    });
    // Two AI docs with NULL confidence; the newer must come before the older
    // within the NULLS-last group (tie broken by createdAt desc).
    nullOlderId = await makeDoc({
      source: "email",
      aiConfidence: null,
      aiExtractedAt: new Date(),
      createdAt: new Date(base - 2000),
    });
    nullNewerId = await makeDoc({
      source: "email",
      aiConfidence: null,
      aiExtractedAt: new Date(),
      createdAt: new Date(base - 1000),
    });
  });

  it("returns lowest aiConfidence first, NULL confidence last, tie-broken by newest", async () => {
    const rows = await listDocuments({
      status: "needs_review",
      aiOnly: true,
      sort: "confidence_asc",
    });
    const ids = [lowId, midId, highId, nullNewerId, nullOlderId];
    const order = only(rows, ids);
    expect(order).toEqual([lowId, midId, highId, nullNewerId, nullOlderId]);
  });

  it("defaults to newest-first (createdAt desc) without confidence_asc", async () => {
    const rows = await listDocuments({ status: "needs_review", aiOnly: true });
    const ids = [lowId, midId, highId, nullNewerId, nullOlderId];
    const order = only(rows, ids);
    // Newest createdAt first: nullNewer, nullOlder, high, mid, low.
    expect(order).toEqual([nullNewerId, nullOlderId, highId, midId, lowId]);
  });
});

describe("listDocuments job linkage resilience", () => {
  it("does not hide an invalid duplicate with no primaryDocumentId in the default list", async () => {
    const brokenDuplicateId = await makeDoc({
      status: "duplicate",
      source: "email",
      aiExtractedAt: new Date(),
      aiConfidence: "0.90",
    });

    const rows = await listDocuments({});
    expect(rows.map((r) => r.id)).toContain(brokenDuplicateId);
  });

  it("finds a document for a job through propagated material provenance", async () => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        title: `Zakazka ${TAG}`,
        type: "planned_work",
        date: "2026-07-08",
      })
      .returning();
    jobIds.push(job.id);

    const docId = await makeDoc({
      status: "approved",
      source: "email",
      aiExtractedAt: new Date(),
      aiConfidence: "0.90",
    });

    const [line] = await db
      .insert(billingDocumentLinesTable)
      .values({
        documentId: docId,
        lineType: "material",
        description: `Material ${TAG}`,
        quantity: "2",
        unitPriceWithoutVat: "50",
        totalWithoutVat: "100",
        totalVat: "21",
        totalWithVat: "121",
        approved: 1,
      })
      .returning();

    const [material] = await db
      .insert(materialsTable)
      .values({
        jobId: job.id,
        name: `Material ${TAG}`,
        quantity: "2",
        pricePerUnit: "50",
        sourceType: "billing_document_line",
        sourceId: line.id,
        priceSourceDocumentId: docId,
        priceSourceLineId: line.id,
      })
      .returning();
    materialIds.push(material.id);

    const rows = await listDocuments({ jobId: job.id });
    expect(rows.map((r) => r.id)).toContain(docId);
  });
});
