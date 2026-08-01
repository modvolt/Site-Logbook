import type { Readable } from "node:stream";
import { contentMatchesType, validateZipContents } from "./fileSignature";
import { scanUploadContent, type UploadScanResult } from "./upload-scanner";

export const MAX_IMPORTED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORTED_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_IMPORTED_MESSAGE_BYTES = 64 * 1024 * 1024;

const IMPORTED_DOCUMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/xml",
  "text/xml",
  "application/zip",
  "text/plain",
  "text/csv",
]);

const IMPORTED_DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  xml: "application/xml",
  isdoc: "application/xml",
  isdocx: "application/zip",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function resolveImportedContentType(
  declared: string | null | undefined,
  fileName: string,
): string | null {
  const normalized = (declared ?? "").split(";", 1)[0].trim().toLowerCase();
  const canonical = normalized === "image/jpg" ? "image/jpeg" : normalized;
  if (IMPORTED_DOCUMENT_TYPES.has(canonical)) return canonical;
  return IMPORTED_DOCUMENT_EXTENSIONS[extensionOf(fileName)] ?? null;
}

/** Decode Gmail's unpadded Base64URL form without Buffer's permissive fallback. */
export function decodeBase64UrlWithLimit(
  data: string,
  declaredSize?: number,
  maxBytes = MAX_IMPORTED_ATTACHMENT_BYTES,
): Buffer {
  if (
    declaredSize != null &&
    (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes)
  ) {
    throw new Error(`Příloha překračuje limit ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) {
    throw new Error("Příloha nemá platné Base64URL kódování.");
  }
  const unpadded = data.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    throw new Error("Příloha nemá platné Base64URL kódování.");
  }
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (unpadded.length > maxEncodedLength) {
    throw new Error(`Příloha překračuje limit ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }
  const result = Buffer.from(unpadded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (result.length > maxBytes) {
    throw new Error(`Příloha překračuje limit ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }
  if (result.toString("base64url") !== unpadded) {
    throw new Error("Příloha nemá kanonické Base64URL kódování.");
  }
  if (declaredSize != null && declaredSize !== result.length) {
    throw new Error("Deklarovaná velikost přílohy neodpovídá staženému obsahu.");
  }
  return result;
}

/** Stop a streaming IMAP download before it can allocate beyond the file cap. */
export async function bufferReadableWithLimit(
  stream: NodeJS.ReadableStream,
  maxBytes = MAX_IMPORTED_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      (stream as Readable).destroy?.();
      throw new Error(`Příloha překračuje limit ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export type ImportedFileInspection =
  | { ok: true; scan: UploadScanResult & { verdict: "content_validated" | "clean" } }
  | { ok: false; kind: "invalid" | "malicious" | "scanner_unavailable"; reason: string };

export async function inspectImportedFile(
  body: Buffer,
  contentType: string,
  fileName: string,
): Promise<ImportedFileInspection> {
  if (!body.length || body.length > MAX_IMPORTED_ATTACHMENT_BYTES) {
    return {
      ok: false,
      kind: "invalid",
      reason: "Příloha je prázdná nebo překračuje povolenou velikost.",
    };
  }
  if (!contentMatchesType(contentType, body)) {
    return {
      ok: false,
      kind: "invalid",
      reason: "Obsah přílohy neodpovídá deklarovanému typu.",
    };
  }
  if (contentType === "application/zip") {
    const zip = validateZipContents(body);
    if (!zip.ok) {
      return {
        ok: false,
        kind: "invalid",
        reason: zip.reason ?? "Obsah ZIP přílohy není podporován.",
      };
    }
  }
  const scan = await scanUploadContent(body, contentType, fileName);
  if ("reason" in scan) {
    return {
      ok: false,
      kind: scan.verdict === "malicious" ? "malicious" : "scanner_unavailable",
      reason: scan.reason,
    };
  }
  return { ok: true, scan };
}
