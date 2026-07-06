import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, billingDocumentsTable, extractionJobsTable } from "@workspace/db";
import {
  createDocumentSafe,
  analyzeJobDocuments,
  type Actor,
} from "../src/lib/cost-document-service";

/**
 * DB-backed dedup guard for received cost documents (Task #677).
 *
 * `billing_documents_sha256_unique_idx` (a partial unique index on sha256,
 * excluding NULLs) is what actually prevents two rows with identical content
 * from ever existing, even when two requests race past the "does this hash
 * exist?" pre-check at the same time. `createDocumentSafe` turns the resulting
 * 23505 into a normal `{status:"duplicate"}` instead of a 500, and
 * `analyzeJobDocuments` additionally serialises concurrent runs for the same
 * job with a transaction-scoped advisory lock (so a double-click on
 * "Analyzovat doklady" cannot create two documents nor two extraction jobs).
 */

const TAG = `test-sha256-dedup-${Date.now()}`;
const actor: Actor = { userId: null, name: "Test Runner" };
const docIdsToClean: number[] = [];

function baseInput(hash: string, suffix: string) {
  return {
    objectPath: `/objects/cost-documents/${TAG}-${suffix}`,
    fileName: `doklad-${suffix}.pdf`,
    contentType: "application/pdf",
    fileSize: 123,
    sha256: hash,
    source: "manual",
  };
}

afterAll(async () => {
  for (const id of docIdsToClean) {
    await db
      .delete(extractionJobsTable)
      .where(eq(extractionJobsTable.documentId, id))
      .catch(() => {});
    await db.delete(billingDocumentsTable).where(eq(billingDocumentsTable.id, id)).catch(() => {});
  }
});

describe("createDocumentSafe — sha256 dedup (DB-level unique constraint)", () => {
  it("two concurrent inserts with identical content: exactly one creates, one is a duplicate", async () => {
    const hash = `${TAG}-concurrent`;
    const [a, b] = await Promise.all([
      createDocumentSafe(baseInput(hash, "a"), null, actor),
      createDocumentSafe(baseInput(hash, "b"), null, actor),
    ]);

    const created = [a, b].filter((r) => r.status === "created");
    const duplicates = [a, b].filter((r) => r.status === "duplicate");
    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    if (created[0]?.status === "created") docIdsToClean.push(created[0].document.id);

    const rows = await db
      .select({ id: billingDocumentsTable.id })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    expect(rows).toHaveLength(1);

    // The winning document got exactly one extraction job queued.
    const jobs = await db
      .select({ id: extractionJobsTable.id })
      .from(extractionJobsTable)
      .where(eq(extractionJobsTable.documentId, rows[0].id));
    expect(jobs).toHaveLength(1);
  });

  it("sequential re-submission of the same content is rejected as duplicate (not a second row)", async () => {
    const hash = `${TAG}-sequential`;
    const first = await createDocumentSafe(baseInput(hash, "seq1"), null, actor);
    expect(first.status).toBe("created");
    if (first.status === "created") docIdsToClean.push(first.document.id);

    const second = await createDocumentSafe(baseInput(hash, "seq2"), null, actor);
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate") {
      expect(second.duplicates[0]?.id).toBe(
        first.status === "created" ? first.document.id : undefined,
      );
    }

    const rows = await db
      .select({ id: billingDocumentsTable.id })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.sha256, hash));
    expect(rows).toHaveLength(1);
  });

  it("delete + re-upload of the same content creates a fresh row and a fresh extraction job", async () => {
    const hash = `${TAG}-reupload`;
    const first = await createDocumentSafe(baseInput(hash, "r1"), null, actor);
    expect(first.status).toBe("created");
    const firstId = first.status === "created" ? first.document.id : -1;

    await db.delete(extractionJobsTable).where(eq(extractionJobsTable.documentId, firstId));
    await db.delete(billingDocumentsTable).where(eq(billingDocumentsTable.id, firstId));

    const second = await createDocumentSafe(baseInput(hash, "r2"), null, actor);
    expect(second.status).toBe("created");
    if (second.status === "created") {
      docIdsToClean.push(second.document.id);
      expect(second.document.id).not.toBe(firstId);

      const jobs = await db
        .select({ id: extractionJobsTable.id })
        .from(extractionJobsTable)
        .where(eq(extractionJobsTable.documentId, second.document.id));
      expect(jobs).toHaveLength(1);
    }
  });
});

describe("analyzeJobDocuments — double-click guard", () => {
  it("two concurrent 'Analyzovat doklady' runs for the same non-existent job both reject 404 without a stray lock", async () => {
    const jobId = 999_999_991;
    const results = await Promise.allSettled([
      analyzeJobDocuments(jobId, actor),
      analyzeJobDocuments(jobId, actor),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as { statusCode?: number })?.statusCode).toBe(404);
      }
    }
  });
});
