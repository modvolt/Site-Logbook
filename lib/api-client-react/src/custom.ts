import { customFetch } from "./custom-fetch";
import { downloadQuotePdf } from "./generated/api";

/**
 * Download an issued invoice's PDF (admin only).
 *
 * The PDF endpoint returns a binary body and is intentionally excluded from the
 * generated react-query client, so it needs a hand-rolled fetch. Mirrors the
 * shape of the generated `downloadBackup` helper.
 */
export function downloadInvoicePdf(
  id: number,
  options?: RequestInit,
): Promise<Blob> {
  return customFetch<Blob>(`/api/billing/invoices/${id}/pdf`, {
    ...options,
    method: "GET",
    responseType: "blob",
  });
}

/** Authenticated binary quote export, with an explicit archive version when selected. */
export async function downloadQuotePdfFile(
  id: number,
  version?: number,
): Promise<Blob> {
  const blob = await downloadQuotePdf(
    id,
    version == null ? undefined : { version },
    {
      cache: "no-store",
      headers: { Accept: "application/pdf" },
    },
  );
  if (
    !(blob instanceof Blob) ||
    blob.type.split(";")[0] !== "application/pdf" ||
    (await blob.slice(0, 5).text()) !== "%PDF-"
  ) {
    throw new Error("Server nevrátil platné PDF nabídky.");
  }
  return blob;
}
