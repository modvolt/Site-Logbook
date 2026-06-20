import type {
  CostDocumentDetail,
  CostDocumentDuplicate,
} from "@workspace/api-client-react";

/**
 * Thrown when the upload endpoint detects an exact-content duplicate (HTTP 409).
 * Carries the conflicting documents so the UI can offer a "nahrát i přesto"
 * (force) re-submit.
 */
export class DuplicateCostDocumentError extends Error {
  duplicates: CostDocumentDuplicate[];
  constructor(message: string, duplicates: CostDocumentDuplicate[]) {
    super(message);
    this.name = "DuplicateCostDocumentError";
    this.duplicates = duplicates;
  }
}

/**
 * Map a file to the content type the cost-document upload endpoint expects.
 * Browsers often report an empty type for `.isdoc`/`.isdocx`, so derive it from
 * the extension: ISDOC/XML → application/xml, the zipped ISDOCx → application/zip.
 */
export function costDocumentContentType(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".isdoc") || name.endsWith(".xml")) return "application/xml";
  if (name.endsWith(".isdocx")) return "application/zip";
  return file.type || "application/octet-stream";
}

export interface UploadCostDocumentOptions {
  docType?: string;
  jobId?: number;
  customerId?: number;
  /** Re-submit even when an exact duplicate was found. */
  force?: boolean;
}

/**
 * Upload a single cost document by POSTing the raw bytes to our own API
 * (same origin, cookie-authenticated). The upload op is intentionally excluded
 * from the generated react-query client (Orval JSON-stringifies bodies), so we
 * hand-roll the fetch here.
 */
export async function uploadCostDocument(
  file: File,
  opts: UploadCostDocumentOptions = {},
): Promise<CostDocumentDetail> {
  const contentType = costDocumentContentType(file);
  const query = new URLSearchParams({ name: file.name, contentType });
  if (opts.docType) query.set("docType", opts.docType);
  if (opts.jobId) query.set("jobId", String(opts.jobId));
  if (opts.customerId) query.set("customerId", String(opts.customerId));
  if (opts.force) query.set("force", "true");

  let res: Response;
  try {
    res = await fetch(`/api/billing/documents/upload?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: file,
      credentials: "include",
    });
  } catch {
    throw new Error(
      "Nahrávání selhalo: server nelze kontaktovat. Zkontrolujte připojení k internetu.",
    );
  }

  if (res.status === 409) {
    let message = "Tento soubor už pravděpodobně byl nahrán.";
    let duplicates: CostDocumentDuplicate[] = [];
    try {
      const data = (await res.json()) as {
        message?: unknown;
        duplicates?: unknown;
      };
      if (typeof data.message === "string") message = data.message;
      if (Array.isArray(data.duplicates))
        duplicates = data.duplicates as CostDocumentDuplicate[];
    } catch {
      // keep defaults
    }
    throw new DuplicateCostDocumentError(message, duplicates);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === "string") detail = data.error;
    } catch {
      // keep status-only detail
    }
    throw new Error(`Nahrávání selhalo: ${detail}`);
  }

  return (await res.json()) as CostDocumentDetail;
}
