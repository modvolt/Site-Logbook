import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "@workspace/db";
import { createDraft, deleteDraft, cancelInvoice } from "../src/lib/invoice-service";
import {
  getApprovedLinesForCustomer,
  findDuplicates,
} from "../src/lib/cost-document-service";

/**
 * Reservation invariant for re-billed cost-document lines (DB-backed).
 *
 * Locks in the guarantee from .agents/memory/invoice-billing-invariants.md §4:
 * an approved cost-document line, once pulled onto a draft invoice (with
 * sourceType "billing_document_line" + its line id), is reserved
 * (`invoicedInvoiceId` set) so it leaves /billing/approved-lines and cannot be
 * billed twice — and is released again when that invoice is deleted (draft) or
 * cancelled (storno). Two real bugs once let lines be billed more than once;
 * these tests would have caught both.
 *
 * Also covers the duplicate-document detection signals (hash, IČO + number,
 * supplier + number + total).
 *
 * Runs against the dev database (DATABASE_URL). Fixtures are created with a
 * unique tag and torn down afterwards.
 */

const TAG = `test-cdb-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const docIds: number[] = [];
const invoiceIds: number[] = [];

async function makeApprovedDoc(opts: {
  documentNumber?: string | null;
  supplierName?: string | null;
  supplierIc?: string | null;
  sha256?: string | null;
  variableSymbol?: string | null;
  issueDate?: string | null;
  totalWithVat?: string | null;
  withLine?: boolean;
}): Promise<{ docId: number; lineId: number | null }> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "approved",
      docType: "invoice",
      source: "manual",
      customerId,
      supplierName: opts.supplierName ?? `Dodavatel ${TAG}`,
      supplierIc: opts.supplierIc ?? null,
      documentNumber: opts.documentNumber ?? null,
      variableSymbol: opts.variableSymbol ?? null,
      issueDate: opts.issueDate ?? null,
      sha256: opts.sha256 ?? null,
      totalWithVat: opts.totalWithVat ?? null,
    })
    .returning();
  docIds.push(doc.id);

  let lineId: number | null = null;
  if (opts.withLine) {
    const [line] = await db
      .insert(billingDocumentLinesTable)
      .values({
        documentId: doc.id,
        description: `Materiál ${TAG}`,
        quantity: "2",
        unit: "ks",
        unitPriceWithoutVat: "500",
        vatRate: "21",
        vatMode: "standard",
        totalWithoutVat: "1000",
        totalVat: "210",
        totalWithVat: "1210",
        allocationType: "rebill",
        approved: 1,
      })
      .returning();
    lineId = line.id;
  }
  return { docId: doc.id, lineId };
}

async function lineReservation(lineId: number): Promise<number | null> {
  const [row] = await db
    .select({ invoicedInvoiceId: billingDocumentLinesTable.invoicedInvoiceId })
    .from(billingDocumentLinesTable)
    .where(eq(billingDocumentLinesTable.id, lineId));
  return row?.invoicedInvoiceId ?? null;
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
  // Drafts/invoices and the cost docs created per-test are cleaned here so each
  // test starts from an empty approved-lines pool for this customer.
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
    invoiceIds.length = 0;
  }
  if (docIds.length) {
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("cost-document line reservation roundtrip", () => {
  it("reserves an approved line when it is pulled onto a draft, then releases it on draft delete", async () => {
    const { lineId } = await makeApprovedDoc({ withLine: true });
    expect(lineId).not.toBeNull();

    // Before: the line is offered for billing.
    const before = await getApprovedLinesForCustomer(customerId);
    expect(before.map((l) => l.id)).toContain(lineId);
    expect(await lineReservation(lineId!)).toBeNull();

    // Create a draft that re-bills the cost line.
    const draft = await createDraft(
      {
        customerId,
        lines: [
          {
            description: `Materiál ${TAG}`,
            quantity: 2,
            unitPriceWithoutVat: 500,
            vatRate: 21,
            vatMode: "standard",
            sourceType: "billing_document_line",
            sourceId: lineId!,
          },
        ],
      },
      actor,
    );
    invoiceIds.push(draft.id);

    // Reserved: the line is now tied to the draft and gone from the pool.
    expect(await lineReservation(lineId!)).toBe(draft.id);
    const during = await getApprovedLinesForCustomer(customerId);
    expect(during.map((l) => l.id)).not.toContain(lineId);

    // Delete the draft → the line returns to the pool.
    await deleteDraft(draft.id);
    invoiceIds.length = 0;
    expect(await lineReservation(lineId!)).toBeNull();
    const after = await getApprovedLinesForCustomer(customerId);
    expect(after.map((l) => l.id)).toContain(lineId);
  });

  it("releases a reserved line when the invoice is cancelled (storno)", async () => {
    const { lineId } = await makeApprovedDoc({ withLine: true });

    const draft = await createDraft(
      {
        customerId,
        lines: [
          {
            description: `Materiál ${TAG}`,
            quantity: 2,
            unitPriceWithoutVat: 500,
            vatRate: 21,
            vatMode: "standard",
            sourceType: "billing_document_line",
            sourceId: lineId!,
          },
        ],
      },
      actor,
    );
    invoiceIds.push(draft.id);
    expect(await lineReservation(lineId!)).toBe(draft.id);

    // Promote to "issued" directly (skips PDF/object-storage), then storno.
    await db
      .update(invoicesTable)
      .set({ status: "issued", invoiceNumber: `${TAG}-1` })
      .where(eq(invoicesTable.id, draft.id));

    await cancelInvoice(draft.id, false, actor);

    expect(await lineReservation(lineId!)).toBeNull();
    const after = await getApprovedLinesForCustomer(customerId);
    expect(after.map((l) => l.id)).toContain(lineId);
  });

  it("does NOT reserve a line when sourceId is dropped (the original double-bill bug)", async () => {
    const { lineId } = await makeApprovedDoc({ withLine: true });

    // Simulate a mapper that keeps sourceType but loses sourceId: the line is
    // billed as plain text and stays re-billable. This is the failure mode the
    // reservation invariant must surface — we assert the (buggy) consequence so
    // a regression to it is visible, while the real path above proves the fix.
    const draft = await createDraft(
      {
        customerId,
        lines: [
          {
            description: `Materiál ${TAG}`,
            quantity: 2,
            unitPriceWithoutVat: 500,
            vatRate: 21,
            vatMode: "standard",
            sourceType: "billing_document_line",
            sourceId: null,
          },
        ],
      },
      actor,
    );
    invoiceIds.push(draft.id);

    // Nothing reserved → still in the pool (i.e. would be billable twice).
    expect(await lineReservation(lineId!)).toBeNull();
    const during = await getApprovedLinesForCustomer(customerId);
    expect(during.map((l) => l.id)).toContain(lineId);
  });
});

describe("findDuplicates", () => {
  it("flags an exact content-hash match", async () => {
    const sha = `sha-${TAG}`;
    const { docId } = await makeApprovedDoc({ sha256: sha });
    const matches = await findDuplicates({ sha256: sha });
    expect(matches.map((m) => m.id)).toContain(docId);
    expect(matches.find((m) => m.id === docId)?.reason).toMatch(/soubor/i);
  });

  it("flags a same IČO + document number match", async () => {
    const ic = `ic-${TAG}`;
    const num = `FV-${TAG}`;
    const { docId } = await makeApprovedDoc({ supplierIc: ic, documentNumber: num });
    const matches = await findDuplicates({ supplierIc: ic, documentNumber: num });
    expect(matches.map((m) => m.id)).toContain(docId);
    expect(matches.find((m) => m.id === docId)?.reason).toMatch(/IČO/i);
  });

  it("flags a same supplier + document number + total match", async () => {
    const supplier = `Supplier ${TAG}`;
    const num = `DOC-${TAG}`;
    const { docId } = await makeApprovedDoc({
      supplierName: supplier,
      documentNumber: num,
      totalWithVat: "1210.00",
    });
    const matches = await findDuplicates({
      supplierName: supplier,
      documentNumber: num,
      totalWithVat: 1210,
    });
    expect(matches.map((m) => m.id)).toContain(docId);
  });

  it("excludes the probe document itself via excludeId", async () => {
    const sha = `sha-self-${TAG}`;
    const { docId } = await makeApprovedDoc({ sha256: sha });
    const matches = await findDuplicates({ sha256: sha, excludeId: docId });
    expect(matches.map((m) => m.id)).not.toContain(docId);
  });

  it("returns no matches for an unrelated probe", async () => {
    await makeApprovedDoc({ sha256: `sha-${TAG}`, supplierIc: `ic-${TAG}` });
    const matches = await findDuplicates({
      sha256: `nonexistent-${TAG}`,
      supplierIc: `nope-${TAG}`,
      documentNumber: `none-${TAG}`,
    });
    expect(matches).toHaveLength(0);
  });
});
