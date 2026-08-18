import type { CancelInvoiceInput } from "@workspace/api-client-react";

export type InvoiceCancellationReasonCode = CancelInvoiceInput["reasonCode"];

export const INVOICE_CANCELLATION_REASONS = [
  { value: "customer_complaint", label: "Reklamace zákazníka" },
  { value: "incorrect_job", label: "Chybná zakázka nebo plnění" },
  { value: "billing_error", label: "Chyba ve fakturačních údajích" },
  { value: "duplicate_invoice", label: "Duplicitní faktura" },
  { value: "order_cancelled", label: "Zakázka byla zrušena" },
] as const satisfies ReadonlyArray<{
  value: InvoiceCancellationReasonCode;
  label: string;
}>;

export function canDirectlyCancelInvoiceStatus(status: string): boolean {
  return status === "issued" || status === "sent";
}
