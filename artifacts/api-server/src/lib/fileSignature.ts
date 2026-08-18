import { unzipSync } from "fflate";

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (offset < 0 || buf.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buf[offset + index] === byte);
}

function asciiAt(buf: Buffer, ascii: string, offset = 0): boolean {
  return startsWith(buf, [...ascii].map((char) => char.charCodeAt(0)), offset);
}

function isPng(buf: Buffer): boolean {
  if (!startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return false;
  }
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buf.length) return false;
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") return length === 0 && chunkEnd === buf.length;
    offset = chunkEnd;
  }
  return false;
}

function isJpeg(buf: Buffer): boolean {
  return startsWith(buf, [0xff, 0xd8, 0xff]) && startsWith(buf, [0xff, 0xd9], buf.length - 2);
}

function isGif(buf: Buffer): boolean {
  return (asciiAt(buf, "GIF87a") || asciiAt(buf, "GIF89a")) && buf.at(-1) === 0x3b;
}

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    asciiAt(buf, "RIFF") &&
    asciiAt(buf, "WEBP", 8) &&
    buf.readUInt32LE(4) + 8 === buf.length
  );
}

function isHeif(buf: Buffer): boolean {
  if (!asciiAt(buf, "ftyp", 4) || buf.length < 12) return false;
  return new Set([
    "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis",
  ]).has(buf.toString("ascii", 8, 12));
}

function isPdf(buf: Buffer): boolean {
  if (!asciiAt(buf, "%PDF-")) return false;
  const tail = buf.subarray(Math.max(0, buf.length - 1_024)).toString("latin1");
  return /%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(tail);
}

function isXml(buf: Buffer): boolean {
  const offset = startsWith(buf, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  return asciiAt(buf, "<?xml", offset);
}

function hasZipMagic(buf: Buffer): boolean {
  return (
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])
  );
}

function isZip(buf: Buffer): boolean {
  if (!hasZipMagic(buf)) return false;
  const searchStart = Math.max(0, buf.length - 65_557);
  for (let offset = buf.length - 22; offset >= searchStart; offset--) {
    if (!startsWith(buf, [0x50, 0x4b, 0x05, 0x06], offset)) continue;
    return offset + 22 + buf.readUInt16LE(offset + 20) === buf.length;
  }
  return false;
}

function isOleCompoundFile(buf: Buffer): boolean {
  return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function isUtf8Text(buf: Buffer): boolean {
  if (buf.length === 0 || buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export interface ZipValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ZipBudget {
  maxInputBytes: number;
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_BUDGET: Readonly<ZipBudget> = Object.freeze({
  maxInputBytes: 25 * 1024 * 1024,
  maxEntries: 50,
  maxEntryUncompressedBytes: 25 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
});

const OFFICE_ZIP_BUDGET: Readonly<ZipBudget> = Object.freeze({
  ...DEFAULT_ZIP_BUDGET,
  maxEntries: 2_000,
});

export type ZipExtractionResult = ZipValidationResult & {
  entries?: Record<string, Uint8Array>;
};

/** Reject declared expansion cost before fflate allocates decompressed output. */
export function unzipWithBudget(
  buf: Buffer,
  budget: Readonly<ZipBudget> = DEFAULT_ZIP_BUDGET,
): ZipExtractionResult {
  if (!isZip(buf)) {
    return { ok: false, reason: "Archiv nemá platnou strukturu ZIP nebo obsahuje data navíc." };
  }
  if (buf.length > budget.maxInputBytes) {
    return { ok: false, reason: "Komprimovaný archiv překračuje povolenou velikost." };
  }

  let entryCount = 0;
  let declaredTotal = 0;
  try {
    const entries = unzipSync(buf, {
      filter(file) {
        if (file.name.endsWith("/")) return true;
        entryCount++;
        if (entryCount > budget.maxEntries) {
          throw new Error("Archiv obsahuje příliš mnoho souborů.");
        }
        if (file.originalSize > budget.maxEntryUncompressedBytes) {
          throw new Error("Soubor uvnitř archivu je po rozbalení příliš velký.");
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > budget.maxTotalUncompressedBytes) {
          throw new Error("Rozbalený obsah archivu překračuje povolený limit.");
        }
        if (
          file.originalSize > 1_024 &&
          file.originalSize / Math.max(1, file.size) > budget.maxCompressionRatio
        ) {
          throw new Error("Archiv má nebezpečný kompresní poměr.");
        }
        return true;
      },
    });
    const actualTotal = Object.values(entries).reduce(
      (sum, entry) => sum + entry.byteLength,
      0,
    );
    if (actualTotal > budget.maxTotalUncompressedBytes) {
      return { ok: false, reason: "Rozbalený obsah archivu překračuje povolený limit." };
    }
    return { ok: true, entries };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.message
        ? error.message
        : "Archiv nelze otevřít nebo je poškozený.",
    };
  }
}

function isOoxmlPackage(buf: Buffer, root: "word" | "xl"): boolean {
  const extraction = unzipWithBudget(buf, OFFICE_ZIP_BUDGET);
  if (!extraction.ok || !extraction.entries) return false;
  const names = Object.keys(extraction.entries).map((name) => name.toLowerCase());
  if (!names.includes("[content_types].xml")) return false;
  if (!names.some((name) => name.startsWith(`${root}/`))) return false;
  return !names.some((name) =>
    /(?:^|\/)(?:vbaproject\.bin|activex\/|embeddings\/|_xmlsignatures\/)/.test(name),
  );
}

const VALIDATORS: Record<string, (buf: Buffer) => boolean> = {
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
  "application/msword": isOleCompoundFile,
  "application/vnd.ms-excel": isOleCompoundFile,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (buf) =>
    isOoxmlPackage(buf, "word"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (buf) =>
    isOoxmlPackage(buf, "xl"),
  "text/plain": isUtf8Text,
  "text/csv": isUtf8Text,
};

export const BILLING_ALLOWED_MIME_TYPES = new Set<string>([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
  "application/pdf", "application/xml", "text/xml", "application/zip",
]);

export function contentMatchesType(contentType: string, body: Buffer): boolean {
  return VALIDATORS[contentType]?.(body) ?? false;
}

const ALLOWED_ZIP_ENTRY_EXTENSIONS = new Set([
  ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif",
  ".xml", ".isdoc", ".isdocx",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function validateZipContents(buf: Buffer): ZipValidationResult {
  const extraction = unzipWithBudget(buf);
  if (!extraction.ok || !extraction.entries) return extraction;

  let fileCount = 0;
  for (const [entryPath, bytes] of Object.entries(extraction.entries)) {
    if (entryPath.endsWith("/")) continue;
    const normalized = entryPath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (normalized.startsWith("/") || segments.some((segment) => segment === "..")) {
      return { ok: false, reason: `Archiv obsahuje nebezpečné cesty: ${entryPath}` };
    }
    const base = segments.at(-1) ?? entryPath;
    const ext = extOf(base);
    if (ext === ".zip") {
      return { ok: false, reason: "Archiv obsahuje vnořený archiv (.zip)." };
    }
    if (!ALLOWED_ZIP_ENTRY_EXTENSIONS.has(ext)) {
      return { ok: false, reason: `Archiv obsahuje nepodporovaný typ souboru: ${base}` };
    }
    const mime = ext === ".pdf" ? "application/pdf"
      : [".xml", ".isdoc"].includes(ext) ? "application/xml"
      : ext === ".isdocx" ? "application/zip"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : `image/${ext.slice(1)}`;
    if (!contentMatchesType(mime, Buffer.from(bytes))) {
      return { ok: false, reason: `Obsah souboru ${base} neodpovídá jeho typu.` };
    }
    fileCount++;
  }
  return fileCount > 0
    ? { ok: true }
    : { ok: false, reason: "Archiv je prázdný nebo neobsahuje podporované soubory." };
}
