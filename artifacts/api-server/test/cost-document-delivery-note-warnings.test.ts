import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
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
 * Delivery notes (`delivery_note`) must NEVER surface the sum-of-lines vs.
 * document-total reconciliation ("Součet položek …") warning in the non-AI
 * ingestion path (ISDOC). A delivery note is not a payment document — its
 * monetary totals are routinely absent or inconsistent, so a mismatch is
 * expected and a payment-oriented warning would only add noise. This guards the
 * docType-based gating (`isPaymentDoc`) in `createDocument`, keeping it
 * consistent with the AI path (task #104) and the frontend `isPaymentDocument`
 * helper.
 *
 * A companion case proves a normal `invoice` with the *same* mismatch still
 * surfaces the reconciliation warning, so the suppression is docType-specific
 * rather than a blanket removal.
 *
 * DB-backed (DATABASE_URL): fixtures carry a unique tag and are torn down.
 */

const TAG = `test-delivnote-warn-${Date.now()}`;
const docIds: number[] = [];

const RECONCILE_RE = /Součet položek/;

// Lines sum to 1500 (1000 + 500) but the document base (TaxExclusiveAmount) is
// 9999 — a deliberate > 0.5 CZK mismatch that triggers reconciliation.
function isdocWithMismatch(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.1">
  <ID>${TAG}</ID>
  <IssueDate>2024-05-01</IssueDate>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification><ID>12345678</ID></PartyIdentification>
      <PartyName><Name>Stavebniny Dodavatel s.r.o.</Name></PartyName>
    </Party>
  </AccountingSupplierParty>
  <InvoiceLines>
    <InvoiceLine>
      <ID>1</ID>
      <InvoicedQuantity unitCode="ks">10</InvoicedQuantity>
      <LineExtensionAmount>1000</LineExtensionAmount>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item><Description>Cement 25kg</Description></Item>
    </InvoiceLine>
    <InvoiceLine>
      <ID>2</ID>
      <InvoicedQuantity unitCode="m">5</InvoicedQuantity>
      <LineExtensionAmount>500</LineExtensionAmount>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
      <Item><Description>Trubka</Description></Item>
    </InvoiceLine>
  </InvoiceLines>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>9999</TaxExclusiveAmount>
    <TaxInclusiveAmount>12098.79</TaxInclusiveAmount>
  </LegalMonetaryTotal>
</Invoice>`;
}

async function ingest(docType: string): Promise<string | null> {
  const buf = Buffer.from(isdocWithMismatch(), "utf8");
  const doc = await createDocument(
    {
      objectPath: `private/test/${TAG}-${docType}.isdoc`,
      fileName: `${TAG}-${docType}.isdoc`,
      contentType: "application/xml",
      fileSize: buf.byteLength,
      sha256: `${TAG}-${docType}`,
      source: "manual",
      docType,
    },
    buf,
    { userId: null, name: TAG },
  );
  docIds.push(doc.id);
  return doc.warnings;
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

describe("createDocument reconciliation warning gating (ISDOC)", () => {
  it("does NOT emit the reconciliation warning for a delivery note with a line-sum mismatch", async () => {
    const warnings = await ingest("delivery_note");
    expect(warnings).not.toBeNull();
    // The ISDOC prefill notice still appears; the payment-oriented
    // reconciliation message must not.
    expect(warnings).not.toMatch(RECONCILE_RE);
  });

  it("DOES emit the reconciliation warning for an invoice with the same mismatch", async () => {
    const warnings = await ingest("invoice");
    expect(warnings).not.toBeNull();
    expect(warnings).toMatch(RECONCILE_RE);
  });
});
