import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  billingDocumentFilesTable,
  billingDocumentLinesTable,
  billingDocumentMergeMembersTable,
  billingDocumentMergesTable,
  billingDocumentReferencesTable,
  billingDocumentsTable,
  db,
  extractionJobsTable,
  invoicesTable,
  jobsTable,
  warehouseItemsTable,
  warehouseMovementsTable,
} from "@workspace/db";
import {
  mergeDocumentPages,
  reorderDocumentMerge,
  revertDocumentMerge,
} from "../src/lib/cost-document-service";

const TAG = `test-page-merge-${Date.now()}`;
const actor = { userId: null, name: TAG };
const documentIds: number[] = [];
const mergeIds: number[] = [];
const invoiceIds: number[] = [];
const jobIds: number[] = [];
const warehouseItemIds: number[] = [];

async function createDocument(status = "needs_review", jobId: number | null = null) {
  const [document] = await db
    .insert(billingDocumentsTable)
    .values({
      status,
      docType: "unknown",
      source: "manual",
      fileName: `${TAG}-${documentIds.length + 1}.jpg`,
      jobId,
    })
    .returning();
  documentIds.push(document.id);
  await db.insert(billingDocumentFilesTable).values({
    documentId: document.id,
    role: "visual_pdf",
    originalFileName: document.fileName,
    mimeType: "image/jpeg",
    objectPath: `/test/${TAG}/${document.id}`,
    pageIndex: 0,
  });
  return document;
}

afterAll(async () => {
  if (!documentIds.length) return;
  await db.delete(extractionJobsTable).where(inArray(extractionJobsTable.documentId, documentIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.actorName, TAG));
  if (warehouseItemIds.length) {
    await db
      .delete(warehouseMovementsTable)
      .where(inArray(warehouseMovementsTable.warehouseItemId, warehouseItemIds));
  }
  if (mergeIds.length) {
    await db.delete(billingDocumentMergesTable).where(inArray(billingDocumentMergesTable.id, mergeIds));
  }
  await db.delete(billingDocumentReferencesTable).where(inArray(billingDocumentReferencesTable.documentId, documentIds));
  await db.delete(billingDocumentFilesTable).where(inArray(billingDocumentFilesTable.documentId, documentIds));
  await db.delete(billingDocumentLinesTable).where(inArray(billingDocumentLinesTable.documentId, documentIds));
  await db.delete(billingDocumentsTable).where(inArray(billingDocumentsTable.id, documentIds));
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  if (warehouseItemIds.length) {
    await db.delete(warehouseItemsTable).where(inArray(warehouseItemsTable.id, warehouseItemIds));
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
});

describe("reversible document page merge", () => {
  it("keeps original files, preserves page order and queues only the primary document", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await db.insert(billingDocumentLinesTable).values([
      { documentId: first.id, description: `${TAG}-first`, quantity: "1", unitPriceWithoutVat: "10" },
      { documentId: second.id, description: `${TAG}-second`, quantity: "1", unitPriceWithoutVat: "20" },
    ]);

    const merged = await mergeDocumentPages(
      { orderedDocumentIds: [second.id, first.id] },
      actor,
    );
    mergeIds.push(merged.mergeId);

    const members = await db
      .select()
      .from(billingDocumentMergeMembersTable)
      .where(eq(billingDocumentMergeMembersTable.mergeId, merged.mergeId))
      .orderBy(billingDocumentMergeMembersTable.pageOrder);
    expect(members.map((member) => member.documentId)).toEqual([second.id, first.id]);

    const documents = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id, second.id]));
    expect(documents.find((document) => document.id === second.id)?.status).toBe("needs_review");
    expect(documents.find((document) => document.id === first.id)?.status).toBe("merged");
    expect(documents.find((document) => document.id === first.id)?.primaryDocumentId).toBe(second.id);

    const files = await db
      .select()
      .from(billingDocumentFilesTable)
      .where(inArray(billingDocumentFilesTable.documentId, [first.id, second.id]));
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => file.documentId))).toEqual(new Set([first.id, second.id]));

    const lines = await db
      .select()
      .from(billingDocumentLinesTable)
      .where(inArray(billingDocumentLinesTable.documentId, [first.id, second.id]));
    expect(lines).toHaveLength(0);

    const activeJobs = await db
      .select()
      .from(extractionJobsTable)
      .where(inArray(extractionJobsTable.documentId, [first.id, second.id]));
    expect(activeJobs.filter((job) => job.status === "queued").map((job) => job.documentId)).toEqual([second.id]);

    await reorderDocumentMerge(merged.mergeId, [first.id, second.id], actor);
    const reordered = await db
      .select()
      .from(billingDocumentMergeMembersTable)
      .where(eq(billingDocumentMergeMembersTable.mergeId, merged.mergeId))
      .orderBy(billingDocumentMergeMembersTable.pageOrder);
    expect(reordered.map((member) => member.documentId)).toEqual([first.id, second.id]);

    await revertDocumentMerge(merged.mergeId, actor);
    const restored = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id, second.id]));
    expect(restored.every((document) => document.status === "needs_review")).toBe(true);
    expect(restored.every((document) => document.primaryDocumentId == null)).toBe(true);
    const [merge] = await db
      .select()
      .from(billingDocumentMergesTable)
      .where(eq(billingDocumentMergesTable.id, merged.mergeId));
    expect(merge.status).toBe("reverted");
  });

  it("returns one merge and one AI job for concurrent and repeated identical requests", async () => {
    const first = await createDocument();
    const second = await createDocument();
    const input = { orderedDocumentIds: [first.id, second.id] };

    const [left, right] = await Promise.all([
      mergeDocumentPages(input, actor),
      mergeDocumentPages(input, actor),
    ]);
    expect(left.mergeId).toBe(right.mergeId);
    expect(left.primaryDocumentId).toBe(first.id);
    mergeIds.push(left.mergeId);

    const retry = await mergeDocumentPages(input, actor);
    expect(retry.mergeId).toBe(left.mergeId);

    const activeMerges = await db
      .select()
      .from(billingDocumentMergesTable)
      .where(eq(billingDocumentMergesTable.id, left.mergeId));
    expect(activeMerges).toHaveLength(1);
    expect(activeMerges[0]?.status).toBe("active");

    const jobs = await db
      .select()
      .from(extractionJobsTable)
      .where(inArray(extractionJobsTable.documentId, [first.id, second.id]));
    expect(jobs.filter((job) => job.status === "queued")).toHaveLength(1);
    expect(jobs.find((job) => job.status === "queued")?.documentId).toBe(first.id);
  });

  it("rejects duplicate and missing document identifiers", async () => {
    const first = await createDocument();
    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, first.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, 2_000_000_000] }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects pages assigned to different jobs", async () => {
    const jobs = await db
      .insert(jobsTable)
      .values([
        { title: `${TAG}-job-a`, date: "2026-07-16" },
        { title: `${TAG}-job-b`, date: "2026-07-16" },
      ])
      .returning({ id: jobsTable.id });
    jobIds.push(...jobs.map((job) => job.id));
    const first = await createDocument("needs_review", jobs[0]!.id);
    const second = await createDocument("needs_review", jobs[1]!.id);

    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, second.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a document line already used by an invoice", async () => {
    const first = await createDocument();
    const second = await createDocument();
    const [invoice] = await db
      .insert(invoicesTable)
      .values({ invoiceNumber: `${TAG}-invoice`, status: "issued" })
      .returning({ id: invoicesTable.id });
    invoiceIds.push(invoice!.id);
    await db.insert(billingDocumentLinesTable).values({
      documentId: first.id,
      description: `${TAG}-invoiced-line`,
      invoicedInvoiceId: invoice!.id,
    });

    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, second.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a document that already created a warehouse movement", async () => {
    const first = await createDocument();
    const second = await createDocument();
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `${TAG}-warehouse-item` })
      .returning({ id: warehouseItemsTable.id });
    warehouseItemIds.push(item!.id);
    await db.insert(warehouseMovementsTable).values({
      warehouseItemId: item!.id,
      direction: "in",
      quantity: "1",
      billingDocumentId: first.id,
      createdByName: TAG,
    });

    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, second.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a final document without changing either document", async () => {
    const editable = await createDocument();
    const approved = await createDocument("approved");
    await expect(
      mergeDocumentPages({ orderedDocumentIds: [editable.id, approved.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    const rows = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [editable.id, approved.id]));
    expect(rows.find((row) => row.id === editable.id)?.status).toBe("needs_review");
    expect(rows.find((row) => row.id === approved.id)?.status).toBe("approved");
  });

  it("rejects merging while extraction is running", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await db.insert(extractionJobsTable).values({ documentId: first.id, status: "running" });
    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, second.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    const activeMerge = await db
      .select()
      .from(billingDocumentMergeMembersTable)
      .where(inArray(billingDocumentMergeMembersTable.documentId, [first.id, second.id]));
    expect(activeMerge).toHaveLength(0);
  });

  it("rejects a manually confirmed document reference", async () => {
    const first = await createDocument();
    const second = await createDocument();
    await db.insert(billingDocumentReferencesTable).values({
      documentId: first.id,
      referenceType: "delivery_note",
      referenceNumber: `${TAG}-confirmed`,
      source: "manual",
      matchConfirmed: 1,
    });
    await expect(
      mergeDocumentPages({ orderedDocumentIds: [first.id, second.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
