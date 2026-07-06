import { describe, it, expect, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  billingDocumentFilesTable,
  billingDocumentReferencesTable,
  extractionJobsTable,
} from "@workspace/db";
import { ingestGroupFile, getDocumentAllFileBuffers } from "../src/lib/cost-document-service";

/**
 * Task #679: uploading several photos as "pages of one document" must produce
 * ONE `billing_documents` row with multiple `billing_document_files`, not one
 * row per photo — and the (single) extraction job must only be enqueued once
 * the group is complete, so AI sees every page together.
 *
 * DB-backed (DATABASE_URL). No real image bytes are needed: `ingestGroupFile`
 * only cares about dedup (sha256) and grouping, not content parsing.
 */

const TAG = `test-group-upload-${Date.now()}`;
const docIds: number[] = [];
const actor = { userId: null, name: TAG };

afterAll(async () => {
  if (docIds.length) {
    await db
      .delete(extractionJobsTable)
      .where(inArray(extractionJobsTable.documentId, docIds));
    await db
      .delete(billingDocumentReferencesTable)
      .where(inArray(billingDocumentReferencesTable.documentId, docIds));
    await db
      .delete(billingDocumentFilesTable)
      .where(inArray(billingDocumentFilesTable.documentId, docIds));
    await db
      .delete(billingDocumentLinesTable)
      .where(inArray(billingDocumentLinesTable.documentId, docIds));
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
});

describe("ingestGroupFile (multi-page upload)", () => {
  it("collapses 3 pages sharing a groupToken into one document with 3 files", async () => {
    const groupToken = `${TAG}-group-1`;
    const pages = [
      Buffer.from(`${TAG}-page-1`, "utf8"),
      Buffer.from(`${TAG}-page-2`, "utf8"),
      Buffer.from(`${TAG}-page-3`, "utf8"),
    ];

    let documentId: number | null = null;
    for (let i = 0; i < pages.length; i++) {
      const result = await ingestGroupFile(
        pages[i],
        {
          fileName: `${TAG}-page-${i + 1}.jpg`,
          contentType: "image/jpeg",
          source: "manual",
          groupToken,
          groupComplete: i === pages.length - 1,
        },
        actor,
      );
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("unreachable");
      if (documentId == null) {
        documentId = result.document.id;
        docIds.push(documentId);
      } else {
        // Every page after the first attaches to the SAME document row.
        expect(result.document.id).toBe(documentId);
      }
    }

    expect(documentId).not.toBeNull();

    const files = await db
      .select()
      .from(billingDocumentFilesTable)
      .where(eq(billingDocumentFilesTable.documentId, documentId!));
    expect(files).toHaveLength(3);

    const [doc] = await db
      .select()
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.id, documentId!));
    expect(doc.mergeGroupId).toBe(groupToken);

    // Extraction is enqueued exactly once — only when the group completed.
    const jobs = await db
      .select()
      .from(extractionJobsTable)
      .where(eq(extractionJobsTable.documentId, documentId!));
    expect(jobs).toHaveLength(1);

    // All 3 page buffers are retrievable together for merged extraction.
    const buffers = await getDocumentAllFileBuffers(documentId!);
    expect(buffers).toHaveLength(3);
  });

  it("does not enqueue extraction until the group is marked complete", async () => {
    const groupToken = `${TAG}-group-2`;
    const first = await ingestGroupFile(
      Buffer.from(`${TAG}-incomplete-page-1`, "utf8"),
      {
        fileName: `${TAG}-incomplete-1.jpg`,
        contentType: "image/jpeg",
        source: "manual",
        groupToken,
        groupComplete: false,
      },
      actor,
    );
    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("unreachable");
    docIds.push(first.document.id);

    const jobsBeforeComplete = await db
      .select()
      .from(extractionJobsTable)
      .where(eq(extractionJobsTable.documentId, first.document.id));
    expect(jobsBeforeComplete).toHaveLength(0);

    const second = await ingestGroupFile(
      Buffer.from(`${TAG}-incomplete-page-2`, "utf8"),
      {
        fileName: `${TAG}-incomplete-2.jpg`,
        contentType: "image/jpeg",
        source: "manual",
        groupToken,
        groupComplete: true,
      },
      actor,
    );
    expect(second.status).toBe("created");
    if (second.status !== "created") throw new Error("unreachable");
    expect(second.document.id).toBe(first.document.id);

    const jobsAfterComplete = await db
      .select()
      .from(extractionJobsTable)
      .where(eq(extractionJobsTable.documentId, first.document.id));
    expect(jobsAfterComplete).toHaveLength(1);
  });
});
