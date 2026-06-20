import { customFetch } from "./custom-fetch";

/**
 * Download an issued invoice's PDF (admin only).
 *
 * The PDF endpoint returns a binary body and is intentionally excluded from the
 * generated react-query client, so it needs a hand-rolled fetch. Mirrors the
 * shape of the generated `downloadBackup` helper.
 */
export function downloadInvoicePdf(id: number, options?: RequestInit): Promise<Blob> {
  return customFetch<Blob>(`/api/billing/invoices/${id}/pdf`, {
    ...options,
    method: "GET",
    responseType: "blob",
  });
}
