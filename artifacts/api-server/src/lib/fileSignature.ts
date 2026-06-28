/**
 * Content-sniffing for uploaded files. The upload route validates the *declared*
 * content type against an allowlist, but a client can lie about it (e.g. POST
 * script bytes labelled as `image/png`). This module inspects the actual
 * leading bytes ("magic numbers") and confirms they match the declared type, so
 * disguised active content is rejected before it is stored.
 *
 * Additionally, `validateZipContents` checks each entry inside a ZIP archive
 * for path traversal, nested archives, and disallowed extensions.
 */

import { unzipSync } from "fflate";

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buf: Buffer, ascii: string, offset = 0): boolean {
  return startsWith(
    buf,
    [...ascii].map((c) => c.charCodeAt(0)),
    offset,
  );
}

function isPng(b: Buffer): boolean {
  return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}
function isJpeg(b: Buffer): boolean {
  return startsWith(b, [0xff, 0xd8, 0xff]);
}
function isGif(b: Buffer): boolean {
  return asciiAt(b, "GIF87a") || asciiAt(b, "GIF89a");
}
function isWebp(b: Buffer): boolean {
  return asciiAt(b, "RIFF", 0) && asciiAt(b, "WEBP", 8);
}
// HEIC/HEIF are ISO-BMFF containers: a `ftyp` box at offset 4, brand follows.
// Accept any brand to avoid rejecting valid variants (heic/heix/mif1/msf1/...).
function isHeif(b: Buffer): boolean {
  return asciiAt(b, "ftyp", 4);
}
function isPdf(b: Buffer): boolean {
  return asciiAt(b, "%PDF");
}
// XML: starts with an XML declaration (<?xml) or optional UTF-8 BOM then <?xml.
// ISDOC files always carry the declaration, so this covers the real-world case
// while rejecting HTML, scripts, and other text labelled as XML.
function isXml(b: Buffer): boolean {
  let offset = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    offset = 3;
  }
  return asciiAt(b, "<?xml", offset);
}
// ZIP (PK\x03\x04 normal / empty / spanned). Used for .isdocx and bare .zip.
function isZip(b: Buffer): boolean {
  return (
    startsWith(b, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(b, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(b, [0x50, 0x4b, 0x07, 0x08])
  );
}

const VALIDATORS: Record<string, (b: Buffer) => boolean> = {
  "image/png": isPng,
  "image/jpeg": isJpeg,
  "image/gif": isGif,
  "image/webp": isWebp,
  "image/heic": isHeif,
  "image/heif": isHeif,
  "application/pdf": isPdf,
  "application/xml": isXml,
  "text/xml": isXml,
  "application/zip": isZip,
};

/**
 * The set of MIME types accepted by the cost-document upload endpoint.
 * Exported so the route and tests share a single source of truth.
 */
export const BILLING_ALLOWED_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/xml",
  "text/xml",
  "application/zip",
]);

/**
 * Returns true when the file bytes are consistent with the declared content
 * type. Types without a defined validator always pass the byte check (they
 * must still be on the allowlist to be accepted at all).
 */
export function contentMatchesType(contentType: string, body: Buffer): boolean {
  const validate = VALIDATORS[contentType];
  if (!validate) return true;
  return validate(body);
}

// ---------------------------------------------------------------------------
// ZIP content safety
// ---------------------------------------------------------------------------

/** File extensions permitted inside an uploaded ZIP archive. */
const ALLOWED_ZIP_ENTRY_EXTENSIONS = new Set([
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
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export interface ZipValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Inspect the contents of a ZIP archive for safety:
 * - No path traversal (entries must not contain `../` or start with `/`).
 * - No nested ZIP archives (a `.zip` inside a `.zip` is rejected;
 *   `.isdocx` is allowed because it is an ISDOC e-invoice container, not
 *   a recursive archive).
 * - Every entry's extension must be in the document allowlist.
 * - The archive must contain at least one non-directory entry.
 */
export function validateZipContents(buf: Buffer): ZipValidationResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch {
    return { ok: false, reason: "Archiv nelze otevřít nebo je poškozený." };
  }

  let fileCount = 0;
  for (const entryPath of Object.keys(entries)) {
    if (entryPath.endsWith("/")) continue;

    const normalized = entryPath.replace(/\\/g, "/");
    const segments = normalized.split("/");

    if (
      normalized.startsWith("/") ||
      segments.some((s) => s === "..")
    ) {
      return {
        ok: false,
        reason: `Archiv obsahuje nebezpečné cesty: ${entryPath}`,
      };
    }

    const base = segments[segments.length - 1] ?? entryPath;
    const ext = extOf(base);

    if (ext === ".zip") {
      return { ok: false, reason: "Archiv obsahuje vnořený archiv (.zip)." };
    }

    if (!ALLOWED_ZIP_ENTRY_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        reason: `Archiv obsahuje nepodporovaný typ souboru: ${base}`,
      };
    }

    fileCount++;
  }

  if (fileCount === 0) {
    return {
      ok: false,
      reason: "Archiv je prázdný nebo neobsahuje podporované soubory.",
    };
  }

  return { ok: true };
}
