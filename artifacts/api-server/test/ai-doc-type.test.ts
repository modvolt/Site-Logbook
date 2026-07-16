import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  invoicesTable,
  jobsTable,
  materialsTable,
} from "@workspace/db";
import { ExtractionResultSchema, normalizeResult } from "../src/lib/openai-extraction";
import {
  applyAiSuggestion,
  approveDocument,
  confirmDocumentType,
  getDocument,
  setDocumentStatus,
  type AiSuggestionInput,
} from "../src/lib/cost-document-service";

/**
 * Recognised document type (docType) round-trip.
 *
 * The default AI prompt now teaches the model to actively distinguish an invoice
 * from a delivery note, receipt, and credit note. Two layers must carry that
 * recognised type through without regression:
 *
 *  - ExtractionResultSchema must MAP a valid docType (receipt / delivery_note /
 *    invoice / credit_note) and fall back to null when the field is absent, null,
 *    or not one of the allowed values (so an unknown value never propagates).
 *  - applyAiSuggestion must OVERWRITE the document's default "invoice" docType
 *    with a valid recognised type, but LEAVE the existing value untouched when the
 *    suggestion's docType is missing/invalid (uncertainty must not corrupt it).
 *
 * The applyAiSuggestion cases run against the dev database (DATABASE_URL); all
 * fixtures carry a unique tag and are torn down afterwards.
 */

// ---------------------------------------------------------------------------
// ExtractionResultSchema docType mapping (pure, no DB)
// ---------------------------------------------------------------------------

describe("ExtractionResultSchema docType mapping", () => {
  it.each(["receipt", "delivery_note", "invoice", "credit_note"] as const)(
    "maps the valid docType %s through unchanged",
    (docType) => {
      const parsed = ExtractionResultSchema.parse({ docType });
      expect(parsed.docType).toBe(docType);
    },
  );

  it("falls back to null when docType is absent", () => {
    const parsed = ExtractionResultSchema.parse({});
    expect(parsed.docType).toBeNull();
  });

  it("falls back to null when docType is explicitly null", () => {
    const parsed = ExtractionResultSchema.parse({ docType: null });
    expect(parsed.docType).toBeNull();
  });

  it("rejects an unrecognised docType value (never propagated)", () => {
    const result = ExtractionResultSchema.safeParse({ docType: "proforma" });
    expect(result.success).toBe(false);
  });

  it.each([
    [-0.2, 0],
    [0.34, 0.34],
    [1.4, 1],
  ])("clamps docTypeConfidence %s to %s", (input, expected) => {
    const parsed = ExtractionResultSchema.parse({
      docType: "invoice",
      docTypeConfidence: input,
    });
    expect(parsed.docTypeConfidence).toBe(expected);
  });
});

describe("ExtractionResultSchema multi-page completeness", () => {
  it("keeps explicit page completeness signals and emits an incomplete-page warning", () => {
    const parsed = ExtractionResultSchema.parse({
      docType: "invoice",
      pageNumber: 1,
      pageCount: 2,
      finalTotalPresent: false,
      confidence: 0.9,
    });

    expect(parsed.pageNumber).toBe(1);
    expect(parsed.pageCount).toBe(2);
    expect(parsed.finalTotalPresent).toBe(false);

    const normalized = normalizeResult(parsed, 0);
    expect(normalized.warnings.join("\n")).toContain("NEUPLNY_VICESTRANKOVY_DOKLAD");
  });
});

// ---------------------------------------------------------------------------
// applyAiSuggestion docType persistence (DB-backed)
// ---------------------------------------------------------------------------

const TAG = `test-doctype-${Date.now()}`;
const actor = { userId: null, name: TAG };
const docIds: number[] = [];
const invoiceIds: number[] = [];
const jobIds: number[] = [];
const materialIds: number[] = [];

async function makeDoc(docType: string): Promise<number> {
  const [doc] = await db
    .insert(billingDocumentsTable)
    .values({
      status: "received",
      docType,
      source: "manual",
      supplierName: `Dodavatel ${TAG}`,
    })
    .returning();
  docIds.push(doc.id);
  return doc.id;
}

function suggestion(
  docType: string | null | undefined,
): AiSuggestionInput {
  return {
    docType,
    lines: [],
    relatedDocuments: [],
    confidence: 0.9,
    warnings: [],
    model: "gpt-4o",
    rawJson: JSON.stringify({ docType }),
  };
}

afterAll(async () => {
  if (materialIds.length) {
    await db.delete(materialsTable).where(inArray(materialsTable.id, materialIds));
    materialIds.length = 0;
  }
  if (docIds.length) {
    await db
      .delete(billingDocumentLinesTable)
      .where(inArray(billingDocumentLinesTable.documentId, docIds));
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
  }
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
    invoiceIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
});

describe("applyAiSuggestion docType", () => {
  it.each(["delivery_note", "receipt", "credit_note"] as const)(
    "overwrites the default invoice with the recognised docType %s",
    async (docType) => {
      const id = await makeDoc("invoice");
      await applyAiSuggestion(id, suggestion(docType));
      const doc = await getDocument(id);
      expect(doc?.document.docType).toBe(docType);
    },
  );

  it("keeps the existing docType when the suggestion docType is missing", async () => {
    const id = await makeDoc("delivery_note");
    await applyAiSuggestion(id, suggestion(null));
    const doc = await getDocument(id);
    expect(doc?.document.docType).toBe("delivery_note");
  });

  it("keeps the existing docType when the suggestion docType is invalid", async () => {
    const id = await makeDoc("receipt");
    await applyAiSuggestion(id, suggestion("proforma"));
    const doc = await getDocument(id);
    expect(doc?.document.docType).toBe("receipt");
  });

  it("keeps a low AI type confidence visible without auto-approving the document", async () => {
    const id = await makeDoc("unknown");
    await applyAiSuggestion(id, {
      ...suggestion("receipt"),
      docTypeConfidence: 0.34,
    });
    const doc = await getDocument(id);
    expect(doc?.document.docType).toBe("receipt");
    expect(doc?.document.detectedDocType).toBe("receipt");
    expect(doc?.document.detectedDocTypeConfidence).toBe(0.34);
    expect(doc?.document.docTypeSource).toBe("ai");
    expect(doc?.document.status).toBe("needs_review");
  });

  it("persists a visible alarm and line confidence below 80 percent", async () => {
    const id = await makeDoc("invoice");
    await applyAiSuggestion(id, {
      ...suggestion("invoice"),
      confidence: 0.79,
      lines: [{ description: `Kabel ${TAG}`, quantity: 1 }],
    });
    const doc = await getDocument(id);
    expect(doc?.document.warnings).toContain("ALARM");
    expect(doc?.document.warnings).toContain("79 %");
    const [line] = await db
      .select()
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, id));
    expect(line.confidence).toBe("0.79");
  });

  it("blocks forced AI replacement when a propagated job material is already invoiced", async () => {
    const id = await makeDoc("invoice");
    await applyAiSuggestion(id, {
      ...suggestion("invoice"),
      lines: [{ description: `Kabel invoiced ${TAG}`, quantity: 1 }],
    });
    const [line] = await db
      .select()
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.documentId, id));
    expect(line).toBeTruthy();
    if (!line) throw new Error("Test line was not created.");
    const [job] = await db
      .insert(jobsTable)
      .values({
        title: `Zakazka ${TAG}`,
        date: "2026-07-08",
      })
      .returning({ id: jobsTable.id });
    expect(job).toBeTruthy();
    if (!job) throw new Error("Test job was not created.");
    jobIds.push(job.id);
    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        status: "issued",
        invoiceNumber: `${TAG}-LOCK`,
      })
      .returning({ id: invoicesTable.id });
    expect(invoice).toBeTruthy();
    if (!invoice) throw new Error("Test invoice was not created.");
    invoiceIds.push(invoice.id);
    const [material] = await db
      .insert(materialsTable)
      .values({
        jobId: job.id,
        name: line.description,
        quantity: line.quantity,
        unit: line.unit,
        pricePerUnit: line.unitPriceWithoutVat,
        sourceType: "billing_document_line",
        sourceId: line.id,
        invoicedInvoiceId: invoice.id,
        done: true,
      })
      .returning({ id: materialsTable.id });
    expect(material).toBeTruthy();
    if (!material) throw new Error("Test material was not created.");
    materialIds.push(material.id);

    await expect(
      applyAiSuggestion(
        id,
        {
          ...suggestion("invoice"),
          lines: [{ description: `Novy kabel ${TAG}`, quantity: 2 }],
        },
        { replaceExisting: true },
      ),
    ).rejects.toThrow(/material pouzity ve vystavene fakture/);
  });

  it("clears duplicate linkage during forced AI replacement", async () => {
    const primaryId = await makeDoc("invoice");
    const duplicateId = await makeDoc("invoice");
    await db
      .update(billingDocumentsTable)
      .set({
        status: "duplicate",
        primaryDocumentId: primaryId,
        mergeGroupId: `${TAG}-merge`,
      })
      .where(eq(billingDocumentsTable.id, duplicateId));

    await applyAiSuggestion(
      duplicateId,
      {
        ...suggestion("invoice"),
        lines: [{ description: `Samostatny doklad ${TAG}`, quantity: 1 }],
      },
      { replaceExisting: true },
    );

    const doc = await getDocument(duplicateId);
    expect(doc?.document.status).toBe("needs_review");
    expect(doc?.document.primaryDocumentId).toBeNull();
    expect(doc?.document.mergeGroupId).toBeNull();
  });

  it("blocks approving or ignoring an incomplete multi-page material page", async () => {
    const id = await makeDoc("invoice");
    await applyAiSuggestion(id, {
      ...suggestion("invoice"),
      pageNumber: 1,
      pageCount: 2,
      finalTotalPresent: false,
      lines: [{ description: `Jistic ${TAG}`, lineType: "material", quantity: 1 }],
    });

    await expect(
      approveDocument(id, { userId: null, name: "Test" }),
    ).rejects.toThrow(/vícestránkového dokladu/);
    await expect(
      setDocumentStatus(id, "ignored", { userId: null, name: "Test" }),
    ).rejects.toThrow(/vícestránkového dokladu/);
  });

  it("blocks approval when the declared type conflicts with AI until an admin confirms it", async () => {
    const id = await makeDoc("invoice");
    await db
      .update(billingDocumentsTable)
      .set({ declaredDocType: "invoice", docTypeSource: "user" })
      .where(eq(billingDocumentsTable.id, id));
    await applyAiSuggestion(id, {
      ...suggestion("delivery_note"),
      docTypeConfidence: 0.93,
    });

    const conflict = await getDocument(id);
    expect(conflict?.document.docType).toBe("unknown");
    expect(conflict?.document.declaredDocType).toBe("invoice");
    expect(conflict?.document.detectedDocType).toBe("delivery_note");
    expect(conflict?.document.detectedDocTypeConfidence).toBe(0.93);
    expect(conflict?.document.docTypeSource).toBe("conflict");
    await expect(approveDocument(id, actor)).rejects.toMatchObject({ statusCode: 409 });

    await confirmDocumentType(id, "delivery_note", actor);
    const confirmed = await getDocument(id);
    expect(confirmed?.document.docType).toBe("delivery_note");
    expect(confirmed?.document.docTypeSource).toBe("admin");
    expect(confirmed?.document.docTypeConfirmedAt).not.toBeNull();
  });
});
