import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  jobsTable,
  materialsTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "@workspace/db";
import { detectStaleAndDuplicateMaterials } from "../src/lib/material-integrity";
import {
  approveDocument,
  revertInvoicePricePropagation,
  propagateInvoicePricesToJobMaterials,
  syncJobMaterialsForDocument,
} from "../src/lib/cost-document-service";

/**
 * Task #696 — automated coverage for the stale-price/duplicate-material
 * detection logic added in `src/lib/material-integrity.ts` (extracted from
 * `scripts/cleanup-duplicate-materials.ts`, Task #690). Previously that logic
 * was only validated manually with hand-inserted rows.
 *
 * Seeds two failure shapes directly (bypassing the now-fixed pipeline, since
 * the bug it detects can no longer be reproduced through normal mutations):
 *   1. A "stale sync" material whose stored price no longer matches its
 *      source cost-document line.
 *   2. A duplicate pair of materials both pointing at the same
 *      billing_document_line via sourceId.
 * Then asserts the detector flags exactly these and nothing else contributed
 * by this test's fixtures, and that re-running the real
 * revert -> propagate -> sync pipeline resolves the stale case.
 */

const TAG = `test-mi-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const docIds: number[] = [];

async function makeJob(): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({ title: `Zakázka ${TAG}`, customerId, date: "2026-01-10" })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

async function makeApprovedInvoiceLine(opts: {
  jobId: number;
  description: string;
  quantity: string;
  unitPrice: string;
}): Promise<{ docId: number; lineId: number }> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "approved",
      docType: "invoice",
      source: "manual",
      customerId,
      jobId: opts.jobId,
      supplierName: `Dodavatel ${TAG}`,
      supplierIc: "12345678",
      documentNumber: `DOC-${TAG}-${Math.random().toString(36).slice(2, 7)}`,
      issueDate: "2026-01-15",
    })
    .returning();
  docIds.push(doc.id);

  const [line] = await db
    .insert(billingDocumentLinesTable)
    .values({
      documentId: doc.id,
      jobId: opts.jobId,
      description: opts.description,
      quantity: opts.quantity,
      unit: "ks",
      unitPriceWithoutVat: opts.unitPrice,
      lineType: "material",
      allocationType: "rebill",
      approved: 1,
    })
    .returning();
  return { docId: doc.id, lineId: line.id };
}

async function jobMaterials(jobId: number) {
  return db.select().from(materialsTable).where(eq(materialsTable.jobId, jobId));
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({ username: `${TAG}-user`, passwordHash: "x", name: "Test Runner", role: "admin" })
    .returning();
  actor.userId = user.id;

  const [customer] = await db.insert(customersTable).values({ companyName: `Zákazník ${TAG}` }).returning();
  customerId = customer.id;
});

afterEach(async () => {
  if (docIds.length) {
    await db.delete(billingDocumentsTable).where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId) await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId) await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("material integrity detection (stale price / duplicate)", () => {
  it("flags a stale-priced sync material and resolving it clears the finding after revert->propagate->sync", async () => {
    const jobId = await makeJob();
    const { docId, lineId } = await makeApprovedInvoiceLine({
      jobId,
      description: `Jistič ${TAG}`,
      quantity: "2",
      unitPrice: "100",
    });

    // Real pipeline creates the correctly-priced material.
    await db.transaction(async (tx) => {
      const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(tx, docId, actor);
      await syncJobMaterialsForDocument(tx, docId, actor, { excludeSourceLineIds: consumedLineIds });
    });
    const [mat] = await jobMaterials(jobId);
    expect(Number(mat.pricePerUnit)).toBe(100);

    // Simulate the pre-fix bug: the invoice line's price changed but the
    // material row was never re-synced, leaving it stale.
    await db
      .update(billingDocumentLinesTable)
      .set({ unitPriceWithoutVat: "150" })
      .where(eq(billingDocumentLinesTable.id, lineId));

    const before = await detectStaleAndDuplicateMaterials();
    const ourFindings = before.findings.filter((f) => f.materialId === mat.id);
    expect(ourFindings).toHaveLength(1);
    expect(["stale_sync", "stale_propagation_price"]).toContain(ourFindings[0].kind);
    expect(ourFindings[0].storedPrice).toBe(100);
    expect(ourFindings[0].expectedPrice).toBe(150);
    expect(before.affectedDocumentIds.has(docId)).toBe(true);

    // Re-run the real fix pipeline (exactly what --apply does) and confirm the
    // finding is gone afterwards.
    await db.transaction(async (tx) => {
      await revertInvoicePricePropagation(tx, docId, actor);
      const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(tx, docId, actor);
      await syncJobMaterialsForDocument(tx, docId, actor, { excludeSourceLineIds: consumedLineIds });
    });

    const [fixedMat] = await jobMaterials(jobId);
    expect(Number(fixedMat.pricePerUnit)).toBe(150);

    const after = await detectStaleAndDuplicateMaterials();
    expect(after.findings.some((f) => f.materialId === mat.id)).toBe(false);
    expect(after.findings.some((f) => f.materialId === fixedMat.id)).toBe(false);
  });

  it("flags a duplicate group when two materials reference the same billing_document_line", async () => {
    const jobId = await makeJob();
    const { lineId } = await makeApprovedInvoiceLine({
      jobId,
      description: `Zásuvka ${TAG}`,
      quantity: "1",
      unitPrice: "80",
    });

    // Simulate the bug's failure mode directly: two materials both claim the
    // same source line via sourceId (real pipeline is idempotent and would
    // never create this on its own — see document-price-propagation.test.ts).
    const dup = await db
      .insert(materialsTable)
      .values([
        {
          jobId,
          name: `Zásuvka ${TAG} (A)`,
          quantity: "1",
          unit: "ks",
          pricePerUnit: "80",
          sourceType: "billing_document_line",
          sourceId: lineId,
        },
      ])
      .returning();
    // The partial unique index on (sourceType, sourceId) blocks a second row
    // via sourceId directly, so simulate the duplicate the way the real bug
    // produced it: second row references the same line via priceSourceLineId
    // (propagation provenance) instead, which is the other half of the
    // detector's duplicate-grouping key.
    const dup2 = await db
      .insert(materialsTable)
      .values({
        jobId,
        name: `Zásuvka ${TAG} (B)`,
        quantity: "1",
        unit: "ks",
        pricePerUnit: "80",
        priceSource: "invoice",
        priceSourceLineId: lineId,
      })
      .returning();

    const report = await detectStaleAndDuplicateMaterials();
    const group = report.duplicateGroups.find((g) => g.billingDocumentLineId === lineId);
    expect(group).toBeDefined();
    expect(group!.materialIds.sort()).toEqual([dup[0].id, dup2[0].id].sort());

    await db.delete(materialsTable).where(inArray(materialsTable.id, [dup[0].id, dup2[0].id]));
  });

  it("does not flag a healthy, correctly-priced sync material", async () => {
    const jobId = await makeJob();
    const { docId } = await makeApprovedInvoiceLine({
      jobId,
      description: `Kabel ${TAG}`,
      quantity: "3",
      unitPrice: "50",
    });

    await db.transaction(async (tx) => {
      const { consumedLineIds } = await propagateInvoicePricesToJobMaterials(tx, docId, actor);
      await syncJobMaterialsForDocument(tx, docId, actor, { excludeSourceLineIds: consumedLineIds });
    });
    const [mat] = await jobMaterials(jobId);

    const report = await detectStaleAndDuplicateMaterials();
    expect(report.findings.some((f) => f.materialId === mat.id)).toBe(false);
    expect(report.duplicateGroups.some((g) => g.materialIds.includes(mat.id))).toBe(false);
  });
});
