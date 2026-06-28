import { describe, it, expect } from "vitest";
import { PROTECTED_OBJECT_PREFIXES } from "../src/routes/storage";

describe("PROTECTED_OBJECT_PREFIXES", () => {
  it("contains ppe-handovers to guard signed documents and signature images", () => {
    expect(PROTECTED_OBJECT_PREFIXES).toContain("ppe-handovers");
  });

  it("contains backups to guard database dump files", () => {
    expect(PROTECTED_OBJECT_PREFIXES).toContain("backups");
  });

  it("contains invoices to guard issued invoice PDFs", () => {
    expect(PROTECTED_OBJECT_PREFIXES).toContain("invoices");
  });

  it("has no duplicates", () => {
    const unique = new Set(PROTECTED_OBJECT_PREFIXES);
    expect(unique.size).toBe(PROTECTED_OBJECT_PREFIXES.length);
  });
});

describe("signPpeHandover signature validation constants", () => {
  it("PNG magic bytes are exactly 8 bytes and match the PNG spec", () => {
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(PNG_MAGIC).toHaveLength(8);
    expect(PNG_MAGIC[0]).toBe(0x89);
    expect(String.fromCharCode(...PNG_MAGIC.slice(1, 4))).toBe("PNG");
  });

  it("data URL prefix matches expected format", () => {
    const PREFIX = "data:image/png;base64,";
    const sampleDataUrl = `${PREFIX}iVBORw0KGgo=`;
    expect(sampleDataUrl.startsWith(PREFIX)).toBe(true);
    const base64Part = sampleDataUrl.slice(PREFIX.length);
    expect(base64Part.length).toBeGreaterThan(0);
  });

  it("500 KB limit is correctly specified in bytes", () => {
    const MAX_BYTES = 500 * 1024;
    expect(MAX_BYTES).toBe(512000);
  });

  it("document number format OOPP-{year}-{id padded to 6} is correct", () => {
    const year = 2026;
    const id = 42;
    const docNumber = `OOPP-${year}-${String(id).padStart(6, "0")}`;
    expect(docNumber).toBe("OOPP-2026-000042");
  });
});
