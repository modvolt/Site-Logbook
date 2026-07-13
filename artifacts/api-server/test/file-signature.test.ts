import { describe, it, expect } from "vitest";
import { zipSync } from "fflate";
import {
  contentMatchesType,
  validateZipContents,
  BILLING_ALLOWED_MIME_TYPES,
} from "../src/lib/fileSignature";

// ---------------------------------------------------------------------------
// MIME allowlist
// ---------------------------------------------------------------------------

describe("BILLING_ALLOWED_MIME_TYPES allowlist", () => {
  it("accepts legitimate document types", () => {
    expect(BILLING_ALLOWED_MIME_TYPES.has("application/pdf")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/jpeg")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/png")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/webp")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/gif")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/heic")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("image/heif")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("application/xml")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("text/xml")).toBe(true);
    expect(BILLING_ALLOWED_MIME_TYPES.has("application/zip")).toBe(true);
  });

  it("rejects types removed from the allowlist", () => {
    expect(BILLING_ALLOWED_MIME_TYPES.has("text/plain")).toBe(false);
    expect(BILLING_ALLOWED_MIME_TYPES.has("text/csv")).toBe(false);
    expect(BILLING_ALLOWED_MIME_TYPES.has("application/msword")).toBe(false);
    expect(
      BILLING_ALLOWED_MIME_TYPES.has(
        "application/vnd.ms-excel",
      ),
    ).toBe(false);
    expect(
      BILLING_ALLOWED_MIME_TYPES.has(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
    expect(
      BILLING_ALLOWED_MIME_TYPES.has(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contentMatchesType — magic-byte validation
// ---------------------------------------------------------------------------

describe("contentMatchesType", () => {
  it("accepts a valid PDF (magic bytes %PDF)", () => {
    const buf = Buffer.from("%PDF-1.4 some content");
    expect(contentMatchesType("application/pdf", buf)).toBe(true);
  });

  it("rejects a fake JPEG (text content declared as image/jpeg)", () => {
    const buf = Buffer.from("This is plain text, not a JPEG.\n");
    expect(contentMatchesType("image/jpeg", buf)).toBe(false);
  });

  it("accepts a real JPEG (FF D8 FF header)", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(contentMatchesType("image/jpeg", buf)).toBe(true);
  });

  it("accepts a real PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(contentMatchesType("image/png", buf)).toBe(true);
  });

  it("rejects text content declared as image/png", () => {
    const buf = Buffer.from("not a png at all");
    expect(contentMatchesType("image/png", buf)).toBe(false);
  });

  it("accepts a valid GIF87a", () => {
    const buf = Buffer.from("GIF87a some data");
    expect(contentMatchesType("image/gif", buf)).toBe(true);
  });

  it("accepts a valid GIF89a", () => {
    const buf = Buffer.from("GIF89a some data");
    expect(contentMatchesType("image/gif", buf)).toBe(true);
  });

  it("accepts a valid WEBP", () => {
    const buf = Buffer.from("RIFFxxxxWEBPVP8 some data");
    expect(contentMatchesType("image/webp", buf)).toBe(true);
  });

  it("accepts a HEIC/HEIF file (ftyp box at offset 4)", () => {
    const buf = Buffer.alloc(16);
    buf.write("ftyp", 4, "ascii");
    buf.write("heic", 8, "ascii");
    expect(contentMatchesType("image/heic", buf)).toBe(true);
    expect(contentMatchesType("image/heif", buf)).toBe(true);
  });

  it("rejects a non-image ISO-BMFF container declared as HEIC", () => {
    const buf = Buffer.alloc(16);
    buf.write("ftyp", 4, "ascii");
    buf.write("mp42", 8, "ascii");
    expect(contentMatchesType("image/heic", buf)).toBe(false);
  });

  it("accepts a valid XML declaration (application/xml)", () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Invoice/>');
    expect(contentMatchesType("application/xml", buf)).toBe(true);
    expect(contentMatchesType("text/xml", buf)).toBe(true);
  });

  it("accepts XML with UTF-8 BOM", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const xml = Buffer.from('<?xml version="1.0"?><root/>');
    const buf = Buffer.concat([bom, xml]);
    expect(contentMatchesType("application/xml", buf)).toBe(true);
  });

  it("rejects plain text declared as application/xml", () => {
    const buf = Buffer.from("Hello, not XML at all");
    expect(contentMatchesType("application/xml", buf)).toBe(false);
  });

  it("rejects HTML declared as application/xml", () => {
    const buf = Buffer.from("<!DOCTYPE html><html>");
    expect(contentMatchesType("application/xml", buf)).toBe(false);
  });

  it("accepts a valid ZIP (PK magic)", () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(contentMatchesType("application/zip", buf)).toBe(true);
  });

  it("rejects text content declared as application/zip", () => {
    const buf = Buffer.from("not a zip file");
    expect(contentMatchesType("application/zip", buf)).toBe(false);
  });

  it("allows text/plain through without magic-byte check (no validator)", () => {
    const buf = Buffer.from("hello world");
    expect(contentMatchesType("text/plain", buf)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateZipContents — ZIP safety checks
// ---------------------------------------------------------------------------

function makeZip(entries: Record<string, string>): Buffer {
  const input: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    input[name] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(input));
}

function makePdfZip(name = "receipt.pdf"): Buffer {
  const pdfBytes = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
  ]);
  return Buffer.from(zipSync({ [name]: pdfBytes }));
}

describe("validateZipContents", () => {
  it("accepts a ZIP containing a PDF", () => {
    const result = validateZipContents(makePdfZip());
    expect(result.ok).toBe(true);
  });

  it("accepts a ZIP containing multiple supported files", () => {
    const pdfBytes = Buffer.from("%PDF-1.4");
    const xmlBytes = Buffer.from('<?xml version="1.0"?><root/>');
    const buf = Buffer.from(
      zipSync({
        "invoice.pdf": new Uint8Array(pdfBytes),
        "isdoc-file.isdoc": new Uint8Array(xmlBytes),
        "photo.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
      }),
    );
    const result = validateZipContents(buf);
    expect(result.ok).toBe(true);
  });

  it("rejects a ZIP containing a .txt file", () => {
    const buf = makeZip({ "readme.txt": "some text content" });
    const result = validateZipContents(buf);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/readme\.txt/);
  });

  it("rejects a ZIP containing a .csv file", () => {
    const buf = makeZip({ "data.csv": "col1,col2\n1,2" });
    const result = validateZipContents(buf);
    expect(result.ok).toBe(false);
  });

  it("rejects a ZIP containing a .doc file", () => {
    const buf = makeZip({ "contract.doc": "content" });
    const result = validateZipContents(buf);
    expect(result.ok).toBe(false);
  });

  it("rejects a nested .zip inside a .zip (recursive archive)", () => {
    const innerZip = makeZip({ "inner.pdf": "%PDF-1.4" });
    const outer = Buffer.from(
      zipSync({ "nested.zip": new Uint8Array(innerZip) }),
    );
    const result = validateZipContents(outer);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/vnořený/);
  });

  it("rejects path traversal entries (../ prefix)", () => {
    const buf = Buffer.from(
      zipSync({ "../secret.pdf": new Uint8Array(Buffer.from("%PDF-1.4")) }),
    );
    const result = validateZipContents(buf);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nebezpečné/);
  });

  it("rejects a corrupted buffer that cannot be unzipped", () => {
    const buf = Buffer.from("not a zip at all");
    const result = validateZipContents(buf);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/otevřít/);
  });

  it("allows .isdocx inside a ZIP (ISDOC e-invoice container)", () => {
    const xmlBytes = Buffer.from('<?xml version="1.0"?><Invoice/>');
    const buf = Buffer.from(
      zipSync({ "invoice.isdocx": new Uint8Array(xmlBytes) }),
    );
    const result = validateZipContents(buf);
    expect(result.ok).toBe(true);
  });
});
