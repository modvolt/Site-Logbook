import { unzip } from "fflate";
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
 * Extensions accepted by the cost-document upload endpoint. Keep in sync with
 * BILLING_ALLOWED_MIME_TYPES on the server (artifacts/api-server/src/lib/fileSignature.ts).
 */
export const ALLOWED_COST_DOC_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".xml",
  ".isdoc",
  ".isdocx",
  ".zip",
] as const;

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isAllowedExtension(name: string): boolean {
  const ext = extOf(name) as (typeof ALLOWED_COST_DOC_EXTENSIONS)[number];
  return (ALLOWED_COST_DOC_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Validate a file before uploading. Returns an error message (Czech) if the
 * file's extension is not on the server allowlist, or null if it is accepted.
 * This is a fast client-side gate; the server also validates content.
 */
export function validateCostDocumentFile(file: File): string | null {
  if (!isAllowedExtension(file.name)) {
    return `Soubor „${file.name}" není podporován. Povolené typy: PDF, fotografie (JPEG, PNG, WEBP, GIF, HEIC), XML/ISDOC nebo ZIP.`;
  }
  return null;
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
  if (name.endsWith(".heic") || name.endsWith(".heif")) {
    return file.type || "image/heic";
  }
  return file.type || "application/octet-stream";
}

/** File extensions the cost-document upload endpoint accepts (inside a ZIP). */
const SUPPORTED_DOC_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".xml",
  ".isdoc",
  ".isdocx",
];

function isSupportedDocName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Photo extensions — the only files it makes sense to offer "pages of one document" for. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"];

/**
 * Is this a photo (not a PDF, ISDOC/XML, or ZIP)? Used to decide whether a
 * multi-file selection should offer the "are these pages of one document?"
 * prompt (task #679) — PDFs and e-invoices are already complete documents.
 */
export function isImageFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return file.type.startsWith("image/");
}

/**
 * Is this file a ZIP archive we should expand into individual documents?
 * `.isdocx` is also a zip container but is a single e-invoice document, so it is
 * deliberately uploaded as-is and never treated as an archive to unpack.
 */
export function isZipArchive(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".isdocx")) return false;
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".isdocx")) return "application/zip";
  if (lower.endsWith(".xml") || lower.endsWith(".isdoc")) return "application/xml";
  return "application/octet-stream";
}

export interface ExpandZipResult {
  /** Supported documents extracted from the archive. */
  files: File[];
  /** Number of entries skipped because they are not supported document types. */
  skipped: number;
}

/**
 * Expand a ZIP archive client-side into the supported documents it contains.
 * Directories, macOS resource forks (`__MACOSX/`), dotfiles, empty entries and
 * unsupported file types are skipped. Nested archives are NOT recursed into —
 * a `.zip` inside the archive counts as an unsupported (skipped) entry, while a
 * `.isdocx` is kept as a single e-invoice document. Each extracted file is then
 * uploaded through the normal single-file path (same dedup + extraction queue).
 */
export async function expandZipArchive(zip: File): Promise<ExpandZipResult> {
  const buf = new Uint8Array(await zip.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
    },
  );

  const files: File[] = [];
  let skipped = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/")) continue; // directory entry
    if (path.startsWith("__MACOSX/")) continue; // macOS resource fork
    const base = path.split("/").pop() ?? path;
    if (!base || base.startsWith(".")) continue; // hidden / dotfiles
    if (!isSupportedDocName(base) || bytes.length === 0) {
      skipped++;
      continue;
    }
    // Copy into a fresh ArrayBuffer-backed view so the bytes satisfy BlobPart
    // (fflate returns Uint8Array<ArrayBufferLike>, which TS rejects directly).
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    files.push(new File([copy], base, { type: guessMimeFromName(base) }));
  }
  return { files, skipped };
}

export interface UploadCostDocumentOptions {
  docType?: string;
  jobId?: number;
  customerId?: number;
  /** Re-submit even when an exact duplicate was found. */
  force?: boolean;
  /**
   * Multi-page photo upload (task #679): a client-generated id shared by every
   * page of the same document. The first page (with this token) creates the
   * document; later pages with the same token attach to it instead of creating
   * a new one. Required together with `groupComplete`.
   */
  groupToken?: string;
  /** True on the last page of a group upload — triggers extraction + merge check. */
  groupComplete?: boolean;
}

/** Generates a client-side token to tag every page of one multi-page upload. */
export function newUploadGroupToken(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `grp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Upload a single cost document by POSTing the raw bytes to our own API
 * (same origin, cookie-authenticated). The upload op is intentionally excluded
 * from the generated react-query client (Orval JSON-stringifies bodies), so we
 * hand-roll the fetch here.
 *
 * Throws synchronously (before the network request) if the file's extension is
 * not on the server allowlist.
 */
export async function uploadCostDocument(
  file: File,
  opts: UploadCostDocumentOptions = {},
): Promise<CostDocumentDetail> {
  const validationError = validateCostDocumentFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const contentType = costDocumentContentType(file);
  const query = new URLSearchParams({ name: file.name, contentType });
  if (opts.docType) query.set("docType", opts.docType);
  if (opts.jobId) query.set("jobId", String(opts.jobId));
  if (opts.customerId) query.set("customerId", String(opts.customerId));
  if (opts.force) query.set("force", "true");
  if (opts.groupToken) {
    query.set("groupToken", opts.groupToken);
    query.set("groupComplete", opts.groupComplete ? "true" : "false");
  }

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
