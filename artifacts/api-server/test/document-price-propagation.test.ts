import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  jobsTable,
  materialsTable,
  warehouseItemsTable,
  warehousePriceHistoryTable,
  warehouseMovementsTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
  billingDocumentReferencesTable,
} from "@workspace/db";
import {
  approveDocument,
  setDocumentStatus,
  deleteDocument,
  syncJobMaterialsForDocument,
  propagateInvoicePricesToJobMaterials,
} from "../src/lib/cost-document-service";
import { createDraft, deleteDraft } from "../src/lib/invoice-service";

/**
 * Task #124 — invoice price propagation pipeline (DB-backed).
 *
 * Locks in the core guarantees from .agents/memory (document-price-propagation):
 *  1. A delivery note (no price) creates a job material in `awaiting_invoice`.
 *  2. Approving the matching invoice fills that SAME material's price in place
 *     (source `invoice`), instead of creating a duplicate material — so no
 *     double stock issue.
 *  8. Re-approving the same invoice is idempotent (no duplicate materials, no
 *     duplicate price-history rows; values converge).
 *  - The warehouse item gets the purchase price + catalogue fields + one
 *    history row per cost-document line.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-dpp-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const docIds: number[] = [];
const itemIds: number[] = [];
const invoiceIds: number[] = [];

async function makeJob(): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({ title: `Zakázka ${TAG}`, customerId, date: "2026-01-10" })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

/** Create a document (default delivery note) with one material line. */
async function makeDoc(opts: {
  docType?: "invoice" | "delivery_note" | "credit_note";
  status?: "approved" | "needs_review";
  jobId?: number | null;
  description: string;
  ean?: string | null;
  supplierSku?: string | null;
  quantity?: string;
  unitPrice?: string | null;
}): Promise<{ docId: number; lineId: number }> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: opts.status ?? "needs_review",
      docType: opts.docType ?? "delivery_note",
      source: "manual",
      customerId,
      jobId: opts.jobId ?? null,
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
      jobId: opts.jobId ?? null,
      description: opts.description,
      ean: opts.ean ?? null,
      supplierSku: opts.supplierSku ?? null,
      quantity: opts.quantity ?? "5",
      unit: "ks",
      unitPriceWithoutVat: opts.unitPrice ?? "0",
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
    .values({
      username: `${TAG}-user`,
      passwordHash: "x",
      name: "Test Runner",
      role: "admin",
    })
    .returning();
  actor.userId = user.id;

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = customer.id;
});

afterEach(async () => {
  if (invoiceIds.length) {
    for (const invId of invoiceIds) {
      await deleteDraft(invId).catch(() => {});
    }
    invoiceIds.length = 0;
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
  if (itemIds.length) {
    await db
      .delete(warehouseItemsTable)
      .where(inArray(warehouseItemsTable.id, itemIds));
    itemIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("invoice price propagation", () => {
  it("scenario 1: delivery note without price creates an awaiting_invoice material", async () => {
    const jobId = await makeJob();
    const { docId } = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Kabel ${TAG}`,
      ean: "1111111111111",
      quantity: "5",
      unitPrice: null,
    });

    await approveDocument(docId, actor);

    const mats = await jobMaterials(jobId);
    expect(mats).toHaveLength(1);
    expect(mats[0].priceSource).toBe("awaiting_invoice");
    expect(mats[0].pricePerUnit).toBeNull();
  });

  it("scenario 2: approving the invoice fills the existing material in place (no duplicate, source invoice)", async () => {
    const jobId = await makeJob();
    // Delivery note (no price) → awaiting_invoice material.
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Zásuvka ${TAG}`,
      ean: "2222222222222",
      quantity: "5",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);

    // Invoice for the same item, now priced, confirmed-linked to the job.
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Zásuvka ${TAG}`,
      ean: "2222222222222",
      quantity: "5",
      unitPrice: "120",
    });
    await approveDocument(inv.docId, actor);

    const mats = await jobMaterials(jobId);
    // Still ONE material (filled, not duplicated).
    expect(mats).toHaveLength(1);
    expect(mats[0].priceSource).toBe("invoice");
    expect(Number(mats[0].pricePerUnit)).toBe(120);
    expect(mats[0].priceSourceDocumentId).toBe(inv.docId);
  });

  it("scenario 8: re-approving the invoice is idempotent (no dup material, no dup price-history)", async () => {
    const jobId = await makeJob();
    // Pre-create a warehouse item so catalogue + history flow.
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `Jistič ${TAG}`, quantity: "0", code: "JST-1" })
      .returning();
    itemIds.push(item.id);

    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Jistič ${TAG}`,
      supplierSku: "JST-1",
      quantity: "3",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);

    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Jistič ${TAG}`,
      supplierSku: "JST-1",
      quantity: "3",
      unitPrice: "85",
    });
    await approveDocument(inv.docId, actor);
    // Re-run approve to assert idempotence.
    await approveDocument(inv.docId, actor);

    const mats = await jobMaterials(jobId);
    expect(mats).toHaveLength(1);
    expect(mats[0].priceSource).toBe("invoice");

    const history = await db
      .select()
      .from(warehousePriceHistoryTable)
      .where(eq(warehousePriceHistoryTable.warehouseItemId, item.id));
    // One history row per cost-document line (delivery-note line + invoice line),
    // never duplicated by the re-approve.
    const byLine = new Set(history.map((h) => h.billingDocumentLineId));
    expect(history.length).toBe(byLine.size);
    expect(history.every((h) => Number(h.purchasePrice) >= 0)).toBe(true);
  });

  it("propagate returns no consumed lines when there is no confirmed-linked job", async () => {
    // Invoice with NO job link → nothing to fill.
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId: null,
      description: `Volný materiál ${TAG}`,
      ean: "3333333333333",
      quantity: "1",
      unitPrice: "50",
    });
    await db
      .update(billingDocumentsTable)
      .set({ status: "approved" })
      .where(eq(billingDocumentsTable.id, inv.docId));

    const result = await db.transaction((tx) =>
      propagateInvoicePricesToJobMaterials(tx, inv.docId, actor),
    );
    expect(result.filled).toBe(0);
    expect(result.consumedLineIds.size).toBe(0);
  });

  it("scenario 7: billing a priced material to the customer marks it invoiced and creates NO second stock movement", async () => {
    const jobId = await makeJob();
    // Delivery note + invoice → one priced material (source invoice).
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Svorka ${TAG}`,
      ean: "4444444444444",
      quantity: "4",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Svorka ${TAG}`,
      ean: "4444444444444",
      quantity: "4",
      unitPrice: "60",
    });
    await approveDocument(inv.docId, actor);

    const [mat] = await jobMaterials(jobId);
    expect(mat.invoicedInvoiceId).toBeNull();

    // Snapshot stock movements tied to this job BEFORE customer invoicing.
    const movesBefore = await db
      .select()
      .from(warehouseMovementsTable)
      .where(eq(warehouseMovementsTable.jobId, jobId));

    // Move the job to "done" so it can be billed to the customer.
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));

    const invoice = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(invoice.id);

    // The material is now reserved on the customer invoice.
    const [matAfter] = await jobMaterials(jobId);
    expect(matAfter.invoicedInvoiceId).toBe(invoice.id);
    expect(matAfter.invoicedAt).not.toBeNull();

    // No second stock movement was created by customer invoicing.
    const movesAfter = await db
      .select()
      .from(warehouseMovementsTable)
      .where(eq(warehouseMovementsTable.jobId, jobId));
    expect(movesAfter.length).toBe(movesBefore.length);

    // Deleting the draft releases the reservation (re-billable again).
    await deleteDraft(invoice.id);
    invoiceIds.pop();
    const [matReleased] = await jobMaterials(jobId);
    expect(matReleased.invoicedInvoiceId).toBeNull();
    expect(matReleased.invoicedAt).toBeNull();
  });

  it("scenario 8: un-approving an invoice reverts the price it filled back to awaiting-invoice without changing stock", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Lišta ${TAG}`,
      ean: "6666666666666",
      quantity: "3",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Lišta ${TAG}`,
      ean: "6666666666666",
      quantity: "3",
      unitPrice: "90",
    });
    await approveDocument(inv.docId, actor);

    const [filled] = await jobMaterials(jobId);
    expect(filled.priceSource).toBe("invoice");
    expect(Number(filled.pricePerUnit)).toBe(90);
    expect(filled.priceSourceDocumentId).toBe(inv.docId);

    const movesBefore = await db
      .select()
      .from(warehouseMovementsTable)
      .where(eq(warehouseMovementsTable.jobId, jobId));

    // Un-approve the invoice → price must roll back to awaiting_invoice.
    await setDocumentStatus(inv.docId, "needs_review", actor);

    const [reverted] = await jobMaterials(jobId);
    expect(reverted.priceSource).toBe("awaiting_invoice");
    expect(Number(reverted.pricePerUnit)).toBe(0);
    expect(reverted.priceSourceDocumentId).toBeNull();
    expect(reverted.priceSourceLineId).toBeNull();

    // Stock movements unchanged (quantity never moved).
    const movesAfter = await db
      .select()
      .from(warehouseMovementsTable)
      .where(eq(warehouseMovementsTable.jobId, jobId));
    expect(movesAfter.length).toBe(movesBefore.length);
  });

  it("scenario 8b: releasing a customer invoice reverts a material whose source doc was un-approved while reserved", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Páska ${TAG}`,
      ean: "7777777777777",
      quantity: "5",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Páska ${TAG}`,
      ean: "7777777777777",
      quantity: "5",
      unitPrice: "120",
    });
    await approveDocument(inv.docId, actor);

    // Reserve the priced material on a customer invoice.
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
    const invoice = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(invoice.id);

    const [reserved] = await jobMaterials(jobId);
    expect(reserved.invoicedInvoiceId).toBe(invoice.id);
    expect(reserved.priceSource).toBe("invoice");

    // Un-approve the cost doc WHILE the material is reserved → revert skips it
    // (keeps the captured price for the in-flight customer invoice).
    await setDocumentStatus(inv.docId, "needs_review", actor);
    const [stillReserved] = await jobMaterials(jobId);
    expect(stillReserved.priceSource).toBe("invoice");
    expect(stillReserved.invoicedInvoiceId).toBe(invoice.id);

    // Now release the customer invoice → release must re-validate provenance and
    // roll the price back since the source doc is no longer approved.
    await deleteDraft(invoice.id);
    invoiceIds.pop();
    const [released] = await jobMaterials(jobId);
    expect(released.invoicedInvoiceId).toBeNull();
    expect(released.priceSource).toBe("awaiting_invoice");
    expect(Number(released.pricePerUnit)).toBe(0);
    expect(released.priceSourceDocumentId).toBeNull();
  });

  it("scenario 8c: releasing reverts a material whose source doc was DELETED while reserved (FK set-null provenance)", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Hmoždinka ${TAG}`,
      ean: "8888888888888",
      quantity: "6",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Hmoždinka ${TAG}`,
      ean: "8888888888888",
      quantity: "6",
      unitPrice: "45",
    });
    await approveDocument(inv.docId, actor);

    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
    const invoice = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(invoice.id);

    const [reserved] = await jobMaterials(jobId);
    expect(reserved.invoicedInvoiceId).toBe(invoice.id);
    expect(reserved.priceSource).toBe("invoice");

    // Delete the source invoice document WHILE the material is reserved. The
    // FK ON DELETE SET NULL clears priceSourceDocumentId but leaves
    // priceSource='invoice' → stale invoice provenance with no source.
    await deleteDocument(inv.docId, actor);
    docIds.splice(docIds.indexOf(inv.docId), 1);
    const [afterDocDelete] = await jobMaterials(jobId);
    expect(afterDocDelete.priceSource).toBe("invoice");
    expect(afterDocDelete.priceSourceDocumentId).toBeNull();

    // Releasing the customer invoice must detect the invalid provenance and
    // revert the price (source no longer exists).
    await deleteDraft(invoice.id);
    invoiceIds.pop();
    const [released] = await jobMaterials(jobId);
    expect(released.invoicedInvoiceId).toBeNull();
    expect(released.priceSource).toBe("awaiting_invoice");
    expect(Number(released.pricePerUnit)).toBe(0);
  });

  it("scenario 9: material API serialization exposes the price-source provenance fields", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Trubka ${TAG}`,
      ean: "5555555555555",
      quantity: "2",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Trubka ${TAG}`,
      ean: "5555555555555",
      quantity: "2",
      unitPrice: "200",
    });
    await approveDocument(inv.docId, actor);

    const [mat] = await jobMaterials(jobId);
    // The row carries the full provenance the API serializer surfaces.
    expect(mat).toHaveProperty("priceSource", "invoice");
    expect(mat).toHaveProperty("priceSourceDocumentId", inv.docId);
    expect(mat).toHaveProperty("priceSourceLineId");
    expect(mat).toHaveProperty("priceConfidence");
    expect(mat).toHaveProperty("priceSourceSupplierName");
    expect(mat).toHaveProperty("adminNote");
    expect(mat).toHaveProperty("invoicedInvoiceId");
    expect(mat).toHaveProperty("invoicedAt");
  });
});
