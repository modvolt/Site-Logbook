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
  documentLinkingSettingsTable,
} from "@workspace/db";
import {
  approveDocument,
  setDocumentStatus,
  deleteDocument,
  syncJobMaterialsForDocument,
  propagateInvoicePricesToJobMaterials,
  updateLine,
  updateWarehousePricesFromDocument,
  bulkConfirmReviewLines,
  reconcileDocumentRelationships,
} from "../src/lib/cost-document-service";
import {
  createDraft,
  deleteDraft,
  getUnbilledCustomerDetail,
} from "../src/lib/invoice-service";

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
    // Price is cleared to null (NOT 0) so the material is non-billable until a
    // trustworthy price source reappears.
    expect(reverted.pricePerUnit).toBeNull();
    expect(reverted.priceSourceDocumentId).toBeNull();
    expect(reverted.priceSourceLineId).toBeNull();

    // A reverted "čeká na fakturu" material must NOT be offered for billing.
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
    const unbilled = await getUnbilledCustomerDetail(customerId);
    const offeredMaterialIds = unbilled.jobs
      .flatMap((j) => j.materials)
      .map((m) => m.id);
    expect(offeredMaterialIds).not.toContain(reverted.id);

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
    expect(released.pricePerUnit).toBeNull();
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
    expect(released.pricePerUnit).toBeNull();
  });

  it("Task #683a: editing an already-consumed invoice line's price re-propagates without duplicating the material", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Vypínač ${TAG}`,
      ean: "9111111111111",
      quantity: "2",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Vypínač ${TAG}`,
      ean: "9111111111111",
      quantity: "2",
      unitPrice: "100",
    });
    await approveDocument(inv.docId, actor);

    const [filled] = await jobMaterials(jobId);
    expect(filled.priceSource).toBe("invoice");
    expect(Number(filled.pricePerUnit)).toBe(100);

    // Edit the already-consumed invoice line's price upward.
    await updateLine(inv.docId, inv.lineId, { unitPriceWithoutVat: 150 }, actor);

    const mats = await jobMaterials(jobId);
    // Still ONE material — the edit must not create a duplicate.
    expect(mats).toHaveLength(1);
    expect(mats[0].priceSource).toBe("invoice");
    expect(Number(mats[0].pricePerUnit)).toBe(150);
    expect(mats[0].priceSourceLineId).toBe(inv.lineId);
  });

  it("Task #683b: editing a consumed invoice line to drop out of eligibility (reassigned to stock) reverts the material to awaiting_invoice", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Relé ${TAG}`,
      ean: "9222222222222",
      quantity: "3",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Relé ${TAG}`,
      ean: "9222222222222",
      quantity: "3",
      unitPrice: "70",
    });
    await approveDocument(inv.docId, actor);

    const [filled] = await jobMaterials(jobId);
    expect(filled.priceSource).toBe("invoice");

    // Reassign the line to "stock" (warehouse receipt) → no longer a
    // rebill-to-job material line → revert.
    await updateLine(inv.docId, inv.lineId, { allocationType: "stock" }, actor);

    const mats = await jobMaterials(jobId);
    expect(mats).toHaveLength(1);
    expect(mats[0].priceSource).toBe("awaiting_invoice");
    expect(mats[0].pricePerUnit).toBeNull();
    expect(mats[0].priceSourceDocumentId).toBeNull();
  });

  it("Task #683c: manual 'Aktualizovat ceny' (updateWarehousePricesFromDocument) fills a job material that missed propagation at approval", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Stykač ${TAG}`,
      ean: "9333333333333",
      quantity: "1",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);

    // Invoice approved WITHOUT a job link yet (e.g. imported, job confirmed later).
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId: null,
      description: `Stykač ${TAG}`,
      ean: "9333333333333",
      quantity: "1",
      unitPrice: "300",
    });
    await approveDocument(inv.docId, actor);

    // Material is still awaiting invoice — propagation never had a confirmed target.
    let [mat] = await jobMaterials(jobId);
    expect(mat.priceSource).toBe("awaiting_invoice");

    // Now confirm the job link on the invoice (simulating a later manual match)...
    await db
      .update(billingDocumentsTable)
      .set({ jobId })
      .where(eq(billingDocumentsTable.id, inv.docId));

    // ...and run the manual "Aktualizovat ceny" action.
    await updateWarehousePricesFromDocument(inv.docId, actor);

    [mat] = await jobMaterials(jobId);
    expect(mat.priceSource).toBe("invoice");
    expect(Number(mat.pricePerUnit)).toBe(300);
    expect(mat.priceSourceDocumentId).toBe(inv.docId);
  });

  it("Task #683d: bulk-confirming a review line added to an already-approved invoice syncs it into job materials", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Item A ${TAG}`,
      ean: "9444444444441",
      quantity: "5",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);

    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Item A ${TAG}`,
      ean: "9444444444441",
      quantity: "5",
      unitPrice: "50",
    });
    await approveDocument(inv.docId, actor);

    // Baseline: one material, filled from the invoice.
    expect(await jobMaterials(jobId)).toHaveLength(1);

    // A second line is added to the (already-approved) invoice document later
    // (e.g. late CSV import) and needs human review before it counts.
    const [newLine] = await db
      .insert(billingDocumentLinesTable)
      .values({
        documentId: inv.docId,
        jobId,
        description: `Item B ${TAG}`,
        quantity: "2",
        unit: "ks",
        unitPriceWithoutVat: "80",
        lineType: "material",
        allocationType: "rebill",
        approved: 1,
        matchConfirmed: 0,
      })
      .returning();

    // Not yet synced — bulk-confirm hasn't run, so no second material exists.
    expect(await jobMaterials(jobId)).toHaveLength(1);

    await bulkConfirmReviewLines([newLine.id], actor);

    const mats = await jobMaterials(jobId);
    expect(mats).toHaveLength(2);
    const itemB = mats.find((m) => m.name === `Item B ${TAG}`);
    expect(itemB).toBeTruthy();
    expect(itemB!.priceSource).toBe("invoice");
    expect(Number(itemB!.pricePerUnit)).toBe(80);
  });

  it("Task #685: a re-approve/bulk-confirm resync never rewrites or deletes an already-invoiced material's price", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Konektor ${TAG}`,
      ean: "9555555555555",
      quantity: "2",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const inv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Konektor ${TAG}`,
      ean: "9555555555555",
      quantity: "2",
      unitPrice: "40",
    });
    await approveDocument(inv.docId, actor);

    const [filled] = await jobMaterials(jobId);
    expect(Number(filled.pricePerUnit)).toBe(40);

    // Bill the material to the customer — it is now frozen (invoicedInvoiceId set).
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
    const invoice = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(invoice.id);
    const [reserved] = await jobMaterials(jobId);
    expect(reserved.invoicedInvoiceId).toBe(invoice.id);

    // Someone later edits the invoice line's price upward AFTER the material was
    // already billed. The already-issued invoice line item keeps its own
    // captured amount regardless, but the underlying job material must stay
    // frozen at its billed price/state too — never silently rewritten.
    await updateLine(inv.docId, inv.lineId, { unitPriceWithoutVat: 999 }, actor);
    let [afterEdit] = await jobMaterials(jobId);
    expect(Number(afterEdit.pricePerUnit)).toBe(40);
    expect(afterEdit.invoicedInvoiceId).toBe(invoice.id);

    // A manual "Aktualizovat ceny" resync (or an equivalent bulk-confirm
    // re-run) on the same approved invoice must also leave it untouched —
    // never rewritten, never deleted (still present for audit).
    await updateWarehousePricesFromDocument(inv.docId, actor);
    [afterEdit] = await jobMaterials(jobId);
    expect(afterEdit).toBeDefined();
    expect(Number(afterEdit.pricePerUnit)).toBe(40);
    expect(afterEdit.invoicedInvoiceId).toBe(invoice.id);

    // Cleanup: release the reservation so afterEach can delete the draft cleanly.
    await deleteDraft(invoice.id);
    invoiceIds.pop();
  });

  it("Task #685: a supplier invoice approved AFTER a material was already billed to the customer must consume (not duplicate) that material", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Rozvaděč ${TAG}`,
      ean: "9777777777777",
      quantity: "1",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    const [awaiting] = await jobMaterials(jobId);
    expect(awaiting.priceSource).toBe("awaiting_invoice");

    // An earlier supplier invoice for the SAME item fills its price (first
    // real-world purchase), before it gets billed to the customer.
    const firstSupplierInv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Rozvaděč ${TAG}`,
      ean: "9777777777777",
      quantity: "1",
      unitPrice: "300",
    });
    await approveDocument(firstSupplierInv.docId, actor);
    const [priced] = await jobMaterials(jobId);
    expect(Number(priced.pricePerUnit)).toBe(300);

    // Bill the material to the customer — it is now frozen (invoicedInvoiceId set).
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
    const invoice = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(invoice.id);
    const [reserved] = await jobMaterials(jobId);
    expect(reserved.invoicedInvoiceId).toBe(invoice.id);

    // The supplier invoice for the same item arrives and is approved
    // afterward — it must consume the already-billed material (matched by
    // EAN) instead of creating a second, duplicate material row.
    const supplierInv = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Rozvaděč ${TAG}`,
      ean: "9777777777777",
      quantity: "1",
      unitPrice: "500",
    });
    await approveDocument(supplierInv.docId, actor);

    const mats = await jobMaterials(jobId);
    expect(mats).toHaveLength(1);
    // The frozen material keeps its billed state — never rewritten by the
    // later-arriving supplier invoice.
    expect(mats[0].id).toBe(reserved.id);
    expect(mats[0].invoicedInvoiceId).toBe(invoice.id);
    expect(Number(mats[0].pricePerUnit)).toBe(300);
    expect(mats[0].priceSourceDocumentId).toBe(firstSupplierInv.docId);

    // Cleanup: release the reservation so afterEach can delete the draft cleanly.
    await deleteDraft(invoice.id);
    invoiceIds.pop();
  });

  it("Task #685 (risk #5): a merged-away duplicate document can never be approved or bulk-confirmed into a double warehouse/material write", async () => {
    const jobId = await makeJob();
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `Svorka ${TAG}`, ean: "9666666666666", unit: "ks" })
      .returning();
    itemIds.push(item.id);
    const primary = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Svorka ${TAG}`,
      ean: "9666666666666",
      quantity: "3",
      unitPrice: "50",
    });
    await approveDocument(primary.docId, actor);

    const [matAfterPrimary] = await jobMaterials(jobId);
    expect(matAfterPrimary).toBeDefined();
    expect(Number(matAfterPrimary.pricePerUnit)).toBe(50);

    // A second doc (e.g. a duplicate scan of the same invoice) that has
    // already been merged away — status="duplicate", primaryDocumentId set —
    // same shape performMergeTx leaves behind. Its own line is still present
    // for traceability, but it must be structurally dead for approval/sync.
    const secondary = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId,
      description: `Svorka ${TAG}`,
      ean: "9666666666666",
      quantity: "3",
      unitPrice: "50",
    });
    await db
      .update(billingDocumentsTable)
      .set({ status: "duplicate", primaryDocumentId: primary.docId })
      .where(eq(billingDocumentsTable.id, secondary.docId));

    // Direct approve on the duplicate must be rejected outright (409), never
    // silently run propagation/sync a second time.
    await expect(approveDocument(secondary.docId, actor)).rejects.toMatchObject({
      statusCode: 409,
    });

    // A stale bulk-confirm request against the duplicate's own line must be a
    // no-op: not counted as confirmable, and no second material/movement.
    const diff = await bulkConfirmReviewLines([secondary.lineId], actor);
    expect(diff.toConfirm).toBe(0);

    const matsAfter = await jobMaterials(jobId);
    expect(matsAfter).toHaveLength(1);
    expect(Number(matsAfter[0].pricePerUnit)).toBe(50);
    expect(Number(matsAfter[0].quantity)).toBe(3);

    const movements = await db
      .select()
      .from(warehouseMovementsTable)
      .where(eq(warehouseMovementsTable.jobId, jobId));
    // Exactly one issue movement for this job's material — never doubled by
    // the duplicate silently re-running the sync pipeline a second time.
    expect(
      movements.filter((m) => m.sourceType === "material" && m.direction === "out"),
    ).toHaveLength(1);
    const netForJob = movements.reduce(
      (sum, m) => sum + (m.direction === "out" ? -Number(m.quantity) : Number(m.quantity)),
      0,
    );
    expect(netForJob).toBeCloseTo(-3, 2);
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

  it("scenario 10: a late invoice inherits a completed job through its delivery-note link", async () => {
    const jobId = await makeJob();
    const dn = await makeDoc({
      docType: "delivery_note",
      status: "needs_review",
      jobId,
      description: `Kabel pozdni faktura ${TAG}`,
      ean: "1234567890128",
      quantity: "10",
      unitPrice: null,
    });
    await approveDocument(dn.docId, actor);
    await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));

    const invoice = await makeDoc({
      docType: "invoice",
      status: "needs_review",
      jobId: null,
      description: `Kabel pozdni faktura ${TAG}`,
      ean: "1234567890128",
      quantity: "10",
      unitPrice: "87.50",
    });
    await db.insert(billingDocumentReferencesTable).values({
      documentId: invoice.docId,
      referenceType: "delivery_note",
      referenceNumber: `DL-${TAG}`,
      source: "automatic_match",
      matchedDocumentId: dn.docId,
      matchConfidence: "0.95",
      matchConfirmed: 1,
    });
    await approveDocument(invoice.docId, actor);

    const [material] = await jobMaterials(jobId);
    expect(material.pricePerUnit).toBe("87.50");
    expect(material.priceSource).toBe("invoice");
    expect(material.priceSourceDocumentId).toBe(invoice.docId);
  });

  it("scenario 11: an exact 80 percent match auto-confirms and propagates its price", async () => {
    // Enable auto-confirm for this test via the DB singleton.
    await db
      .insert(documentLinkingSettingsTable)
      .values({ id: 1, autoConfirmEnabled: true, autoConfirmMinScore: "0.8" })
      .onConflictDoUpdate({
        target: documentLinkingSettingsTable.id,
        set: { autoConfirmEnabled: true, autoConfirmMinScore: "0.8" },
      });

    try {
      const jobId = await makeJob();
      const dn = await makeDoc({
        docType: "delivery_note",
        status: "needs_review",
        jobId,
        description: `Kabel osmdesat procent ${TAG}`,
        ean: "2234567890127",
        quantity: "4",
        unitPrice: null,
      });
      await approveDocument(dn.docId, actor);
      await db.update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, jobId));
      const [deliveryDocument] = await db
        .select()
        .from(billingDocumentsTable)
        .where(eq(billingDocumentsTable.id, dn.docId));

      const invoice = await makeDoc({
        docType: "invoice",
        status: "needs_review",
        jobId: null,
        description: `Kabel osmdesat procent ${TAG}`,
        ean: "2234567890127",
        quantity: "4",
        unitPrice: "125",
      });
      await db.insert(billingDocumentReferencesTable).values({
        documentId: invoice.docId,
        referenceType: "delivery_note",
        referenceNumber: deliveryDocument.documentNumber!,
        source: "ai",
      });

      const reconciliation = await reconcileDocumentRelationships(
        invoice.docId,
        actor,
      );
      expect(reconciliation.confirmedDocumentIds).toContain(dn.docId);
      await approveDocument(invoice.docId, actor);

      const [material] = await jobMaterials(jobId);
      expect(material.pricePerUnit).toBe("125.00");
      expect(material.priceSourceDocumentId).toBe(invoice.docId);
    } finally {
      // Restore default (auto-confirm off) so other tests are not affected.
      await db
        .update(documentLinkingSettingsTable)
        .set({ autoConfirmEnabled: false })
        .where(eq(documentLinkingSettingsTable.id, 1));
    }
  });
});
