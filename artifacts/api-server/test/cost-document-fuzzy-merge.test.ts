import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  billingDocumentsTable,
  billingDocumentLinesTable,
  billingDocumentFilesTable,
  billingDocumentReferencesTable,
  extractionJobsTable,
} from "@workspace/db";
import { createDocument } from "../src/lib/cost-document-service";

/**
 * Task #679: `mergeRelatedDocumentsTx` must still match/merge two scans of the
 * same supplier document even when the document *number* doesn't line up
 * (missing, or OCR'd differently per photo) — via `scoreDocumentSimilarity`
 * (IČO + total + date + line overlap) instead of the identity check. Three
 * bands: confident match auto-merges, a middling match flags BOTH docs
 * `needs_review` with an explanation (never a silent guess), and a
 * insufficient match (different IČO) does nothing.
 *
 * DB-backed (DATABASE_URL): each doc is ingested as ISDOC (deterministic,
 * inline-parsed header/lines, no AI/network dependency) with a distinct
 * top-level <ID> so the identity fast-path (IČO + doc number) never fires and
 * the fuzzy fallback is what's under test. Fixtures are tagged and torn down.
 */

const TAG = `test-fuzzy-merge-${Date.now()}`;
const docIds: number[] = [];
// scoreDocumentSimilarity/ico() strips non-digits, and the sibling lookup
// matches supplierIc verbatim — use pure-numeric, per-group-unique IČOs
// derived from the current timestamp so groups never collide with each other
// or with real data in a shared dev DB.
const ICO_BASE = Date.now() % 100000000;
const icoFor = (n: number) => String(ICO_BASE + n).padStart(8, "0");

function isdoc(opts: {
  id: string;
  ic: string;
  issueDate: string;
  total: number;
  lines: { desc: string; amount: number }[];
}): Buffer {
  const lineXml = opts.lines
    .map(
      (l, i) => `
    <InvoiceLine>
      <ID>${i + 1}</ID>
      <InvoicedQuantity unitCode="ks">1</InvoicedQuantity>
      <LineExtensionAmount>${l.amount}</LineExtensionAmount>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item><Description>${l.desc}</Description></Item>
    </InvoiceLine>`,
    )
    .join("");
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.1">
  <ID>${opts.id}</ID>
  <IssueDate>${opts.issueDate}</IssueDate>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification><ID>${opts.ic}</ID></PartyIdentification>
      <PartyName><Name>Stavebniny Dodavatel s.r.o.</Name></PartyName>
    </Party>
  </AccountingSupplierParty>
  <InvoiceLines>${lineXml}
  </InvoiceLines>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>${opts.total}</TaxExclusiveAmount>
    <TaxInclusiveAmount>${Math.round(opts.total * 1.21 * 100) / 100}</TaxInclusiveAmount>
  </LegalMonetaryTotal>
</Invoice>`,
    "utf8",
  );
}

async function ingest(buf: Buffer, suffix: string) {
  const doc = await createDocument(
    {
      objectPath: `private/test/${TAG}-${suffix}.isdoc`,
      fileName: `${TAG}-${suffix}.isdoc`,
      contentType: "application/xml",
      fileSize: buf.byteLength,
      sha256: `${TAG}-${suffix}`,
      source: "manual",
    },
    buf,
    { userId: null, name: TAG },
  );
  docIds.push(doc.id);
  return doc;
}

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

describe("mergeRelatedDocumentsTx fuzzy fallback (no matching document number)", () => {
  it("auto-merges two scans with the same IČO, total, date, and line items", async () => {
    const ic = icoFor(1);
    const lines = [
      { desc: "Cement 25kg", amount: 1000 },
      { desc: "Trubka PVC", amount: 500 },
    ];
    const first = await ingest(
      isdoc({ id: `${TAG}-A1`, ic, issueDate: "2024-05-01", total: 1500, lines }),
      "auto-a",
    );
    const second = await ingest(
      isdoc({ id: `${TAG}-A2-DIFFERENT`, ic, issueDate: "2024-05-01", total: 1500, lines }),
      "auto-b",
    );

    const [refreshedFirst] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id]));
    const [refreshedSecond] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [second.id]));

    // One of the two absorbed the other (status="duplicate", primaryDocumentId set).
    const merged = [refreshedFirst, refreshedSecond].find((d) => d.status === "duplicate");
    const primary = [refreshedFirst, refreshedSecond].find((d) => d.status !== "duplicate");
    expect(merged).toBeDefined();
    expect(primary).toBeDefined();
    expect(merged?.primaryDocumentId).toBe(primary?.id);
  });

  it("flags both documents needs_review on a middling match instead of guessing", async () => {
    const ic = icoFor(2);
    const first = await ingest(
      isdoc({
        id: `${TAG}-B1`,
        ic,
        issueDate: "2024-06-01",
        total: 2000,
        lines: [{ desc: "Sádrokarton", amount: 2000 }],
      }),
      "mid-a",
    );
    const second = await ingest(
      isdoc({
        id: `${TAG}-B2-DIFFERENT`,
        ic,
        issueDate: "2024-06-01",
        total: 2000,
        // Different line items entirely: same IČO/total/date (score ~0.6),
        // but no line overlap, so it must stay below the auto-merge threshold.
        lines: [{ desc: "Úplně jiná položka XYZ", amount: 2000 }],
      }),
      "mid-b",
    );

    const [refreshedFirst] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id]));
    const [refreshedSecond] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [second.id]));

    expect(refreshedFirst.status).toBe("needs_review");
    expect(refreshedSecond.status).toBe("needs_review");
    expect(refreshedFirst.warnings).toMatch(/Možná duplicita/);
    expect(refreshedSecond.warnings).toMatch(/Možná duplicita/);
    expect(refreshedFirst.primaryDocumentId).toBeNull();
    expect(refreshedSecond.primaryDocumentId).toBeNull();
  });

  it("does nothing when the supplier IČO differs", async () => {
    const first = await ingest(
      isdoc({
        id: `${TAG}-C1`,
        ic: icoFor(3),
        issueDate: "2024-07-01",
        total: 3000,
        lines: [{ desc: "Beton", amount: 3000 }],
      }),
      "diff-a",
    );
    const second = await ingest(
      isdoc({
        id: `${TAG}-C2`,
        ic: icoFor(4),
        issueDate: "2024-07-01",
        total: 3000,
        lines: [{ desc: "Beton", amount: 3000 }],
      }),
      "diff-b",
    );

    const [refreshedFirst] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id]));
    const [refreshedSecond] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [second.id]));

    expect(refreshedFirst.status).not.toBe("duplicate");
    expect(refreshedSecond.status).not.toBe("duplicate");
    expect(refreshedFirst.primaryDocumentId).toBeNull();
    expect(refreshedSecond.primaryDocumentId).toBeNull();
  });

  it("Task #685: never auto-merges an already-APPROVED document — flags the new one for review instead", async () => {
    const ic = icoFor(5);
    const lines = [
      { desc: "Omítka jádrová", amount: 800 },
      { desc: "Sádra", amount: 400 },
    ];
    const first = await ingest(
      isdoc({ id: `${TAG}-D1`, ic, issueDate: "2024-08-01", total: 1200, lines }),
      "approved-a",
    );
    // Approve the first document — it now carries applied price/warehouse
    // effects that a silent auto-merge would orphan.
    await db
      .update(billingDocumentsTable)
      .set({ status: "approved" })
      .where(eq(billingDocumentsTable.id, first.id));

    const second = await ingest(
      isdoc({ id: `${TAG}-D2-DIFFERENT`, ic, issueDate: "2024-08-01", total: 1200, lines }),
      "approved-b",
    );

    const [refreshedFirst] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [first.id]));
    const [refreshedSecond] = await db
      .select()
      .from(billingDocumentsTable)
      .where(inArray(billingDocumentsTable.id, [second.id]));

    // The approved document is untouched — never flipped to "duplicate".
    expect(refreshedFirst.status).toBe("approved");
    expect(refreshedFirst.primaryDocumentId).toBeNull();
    // The new document is flagged for a human instead of being silently merged.
    expect(refreshedSecond.status).toBe("needs_review");
    expect(refreshedSecond.primaryDocumentId).toBeNull();
    expect(refreshedSecond.warnings).toMatch(/schváleným dokladem/);
  });
});
