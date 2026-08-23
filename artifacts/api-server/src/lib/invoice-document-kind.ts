export type InvoiceDocumentType = "standard" | "advance";

export interface InvoiceDocumentLabels {
  title: string;
  legalNotice: string | null;
  amountDueLabel: string;
}

/** Accounting-safe customer-facing labels shared by generated documents. */
export function invoiceDocumentLabels(
  documentType: InvoiceDocumentType,
  taxDocument: boolean,
): InvoiceDocumentLabels {
  if (documentType === "advance") {
    return {
      title: "ZÁLOHOVÁ FAKTURA",
      legalNotice: "Platební výzva – nejde o daňový doklad.",
      amountDueLabel: "Požadovaná záloha:",
    };
  }
  return {
    title: taxDocument ? "FAKTURA – daňový doklad" : "FAKTURA",
    legalNotice: null,
    amountDueLabel: "Celkem k úhradě:",
  };
}
