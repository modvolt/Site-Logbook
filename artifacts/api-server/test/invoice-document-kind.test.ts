import { describe, expect, it } from "vitest";
import { invoiceDocumentLabels } from "../src/lib/invoice-document-kind";

describe("invoice document labels", () => {
  it("labels an advance invoice as a non-tax payment request", () => {
    expect(invoiceDocumentLabels("advance", true)).toEqual({
      title: "ZÁLOHOVÁ FAKTURA",
      legalNotice: "Platební výzva – nejde o daňový doklad.",
      amountDueLabel: "Požadovaná záloha:",
    });
  });

  it("keeps standard VAT invoices labelled as tax documents", () => {
    expect(invoiceDocumentLabels("standard", true)).toEqual({
      title: "FAKTURA – daňový doklad",
      legalNotice: null,
      amountDueLabel: "Celkem k úhradě:",
    });
  });
});
