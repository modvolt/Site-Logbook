import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "@workspace/db";
import { ExtractionResultSchema } from "../src/lib/openai-extraction";
import {
  applyAiSuggestion,
  getDocument,
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
});

// ---------------------------------------------------------------------------
// applyAiSuggestion docType persistence (DB-backed)
// ---------------------------------------------------------------------------

const TAG = `test-doctype-${Date.now()}`;
const docIds: number[] = [];

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
  if (docIds.length) {
    await db
      .delete(billingDocumentLinesTable)
      .where(inArray(billingDocumentLinesTable.documentId, docIds));
    await db
      .delete(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, docIds));
    docIds.length = 0;
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
});
