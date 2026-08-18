import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  BILLING_ALLOWED_MIME_TYPES,
  contentMatchesType,
  unzipWithBudget,
  validateZipContents,
} from "../src/lib/fileSignature";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX8AAAAASUVORK5CYII=",
  "base64",
);

function zip(entries: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(entries));
}

describe("BILLING_ALLOWED_MIME_TYPES", () => {
  it("allows passive invoice formats and rejects Office/text formats", () => {
    for (const mime of [
      "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
      "image/heic", "image/heif", "application/xml", "text/xml", "application/zip",
    ]) expect(BILLING_ALLOWED_MIME_TYPES.has(mime)).toBe(true);
    for (const mime of ["text/plain", "text/csv", "application/msword", "application/vnd.ms-excel"])
      expect(BILLING_ALLOWED_MIME_TYPES.has(mime)).toBe(false);
  });
});

describe("contentMatchesType", () => {
  it("accepts structurally complete known formats", () => {
    expect(contentMatchesType("application/pdf", PDF)).toBe(true);
    expect(contentMatchesType("image/jpeg", JPEG)).toBe(true);
    expect(contentMatchesType("image/png", PNG)).toBe(true);
    expect(contentMatchesType("image/gif", Buffer.from("GIF89a data;"))).toBe(true);

    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(8, 4);
    webp.write("WEBP", 8, "ascii");
    expect(contentMatchesType("image/webp", webp)).toBe(true);

    const heic = Buffer.alloc(16);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    expect(contentMatchesType("image/heic", heic)).toBe(true);
  });

  it("rejects spoofed, incomplete, unknown and trailing-polyglot content", () => {
    expect(contentMatchesType("image/jpeg", Buffer.from("not jpeg"))).toBe(false);
    expect(contentMatchesType("image/png", PNG.subarray(0, 12))).toBe(false);
    expect(contentMatchesType("application/pdf", Buffer.from("%PDF-1.4 only header"))).toBe(false);
    expect(contentMatchesType("application/x-unknown", Buffer.from("anything"))).toBe(false);
    expect(contentMatchesType("image/png", Buffer.concat([PNG, Buffer.from("<script>")]))).toBe(false);
    expect(contentMatchesType("application/pdf", Buffer.concat([PDF, Buffer.from("<script>")]))).toBe(false);
  });

  it("validates XML, UTF-8 text, OLE and OOXML containers", () => {
    expect(contentMatchesType("application/xml", Buffer.from('<?xml version="1.0"?><x/>'))).toBe(true);
    expect(contentMatchesType("text/plain", Buffer.from("bezpečný text", "utf8"))).toBe(true);
    expect(contentMatchesType("text/plain", Buffer.from([0, 1, 2]))).toBe(false);

    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(contentMatchesType("application/msword", ole)).toBe(true);
    const docx = zip({
      "[Content_Types].xml": new TextEncoder().encode("<Types/>") ,
      "word/document.xml": new TextEncoder().encode("<document/>") ,
    });
    expect(contentMatchesType(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    )).toBe(true);
    const macroDocx = zip({
      "[Content_Types].xml": new TextEncoder().encode("<Types/>") ,
      "word/document.xml": new TextEncoder().encode("<document/>") ,
      "word/vbaProject.bin": new Uint8Array([1, 2, 3]),
    });
    expect(contentMatchesType(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      macroDocx,
    )).toBe(false);
  });

  it("requires a canonical ZIP ending", () => {
    const valid = zip({ "invoice.pdf": PDF });
    expect(contentMatchesType("application/zip", valid)).toBe(true);
    expect(contentMatchesType("application/zip", Buffer.concat([valid, Buffer.from("polyglot")]))).toBe(false);
  });
});

describe("bounded ZIP extraction", () => {
  it("accepts supported contents and rejects traversal, nested and spoofed entries", () => {
    expect(validateZipContents(zip({ "invoice.pdf": PDF, "photo.jpg": JPEG })).ok).toBe(true);
    expect(validateZipContents(zip({ "../secret.pdf": PDF })).ok).toBe(false);
    expect(validateZipContents(zip({ "readme.txt": new TextEncoder().encode("x") })).ok).toBe(false);
    expect(validateZipContents(zip({ "fake.pdf": new TextEncoder().encode("not pdf") })).ok).toBe(false);
    const nested = zip({ "inner.pdf": PDF });
    expect(validateZipContents(zip({ "nested.zip": nested })).ok).toBe(false);
  });

  it("accepts a real ISDOCX nested container", () => {
    const isdocx = zip({ "invoice.isdoc": new TextEncoder().encode('<?xml version="1.0"?><Invoice/>') });
    expect(validateZipContents(zip({ "invoice.isdocx": isdocx })).ok).toBe(true);
  });

  it("rejects excessive entry count and total expansion before use", () => {
    const many = zip({ "a.pdf": PDF, "b.pdf": PDF });
    const entryResult = unzipWithBudget(many, {
      maxInputBytes: 10_000,
      maxEntries: 1,
      maxEntryUncompressedBytes: 10_000,
      maxTotalUncompressedBytes: 20_000,
      maxCompressionRatio: 1_000,
    });
    expect(entryResult.ok).toBe(false);
    expect(entryResult.reason).toMatch(/mnoho/);

    const expanded = zip({ "zeros.pdf": new Uint8Array(1_000_000) });
    const bomb = unzipWithBudget(expanded, {
      maxInputBytes: 100_000,
      maxEntries: 5,
      maxEntryUncompressedBytes: 2_000_000,
      maxTotalUncompressedBytes: 2_000_000,
      maxCompressionRatio: 10,
    });
    expect(bomb.ok).toBe(false);
    expect(bomb.reason).toMatch(/kompresní poměr/);
  });
});
