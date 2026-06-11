/**
 * Content-sniffing for uploaded files. The upload route validates the *declared*
 * content type against an allowlist, but a client can lie about it (e.g. POST
 * HTML/script bytes labelled as `image/png`). This module inspects the actual
 * leading bytes ("magic numbers") and confirms they match the declared type, so
 * disguised active content is rejected before it is stored.
 *
 * Plain-text formats (text/plain, text/csv) have no reliable signature and are
 * intentionally not byte-checked — they are inert and already on the allowlist.
 */

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
// Legacy Office (.doc/.xls): OLE2 compound file.
function isOle2(b: Buffer): boolean {
  return startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}
// Modern Office (.docx/.xlsx): ZIP container (PK\x03\x04 / empty / spanned).
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
  "application/msword": isOle2,
  "application/vnd.ms-excel": isOle2,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": isZip,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": isZip,
};

/**
 * Returns true when the file bytes are consistent with the declared content
 * type. Types without a defined validator (text/plain, text/csv) always pass.
 */
export function contentMatchesType(contentType: string, body: Buffer): boolean {
  const validate = VALIDATORS[contentType];
  if (!validate) return true;
  return validate(body);
}
