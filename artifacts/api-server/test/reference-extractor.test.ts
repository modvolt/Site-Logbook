import { describe, it, expect } from "vitest";
import {
  extractReferences,
  normalizeReferenceNumber,
} from "../src/lib/reference-extractor";

/**
 * Tests for the AI-free text reference extractor. It must only return numbers
 * that explicitly appear next to a recognized Czech label and never guess.
 */

describe("normalizeReferenceNumber", () => {
  it("strips case and punctuation for comparison", () => {
    expect(normalizeReferenceNumber("OBJ-2024/001")).toBe("OBJ2024001");
    expect(normalizeReferenceNumber("dl.123")).toBe("DL123");
    expect(normalizeReferenceNumber("  4500012345 ")).toBe("4500012345");
  });
});

describe("extractReferences", () => {
  it("extracts a delivery-note number", () => {
    const refs = extractReferences("Dodací list č. DL2024001 ze dne 1.5.2024");
    expect(refs).toContainEqual(
      expect.objectContaining({
        referenceType: "delivery_note",
        referenceNumber: "DL2024001",
        source: "text",
      }),
    );
  });

  it("distinguishes our order (supplier_order) from your order (order)", () => {
    const supplier = extractReferences("Naše objednávka: 4500099999");
    expect(supplier).toContainEqual(
      expect.objectContaining({
        referenceType: "supplier_order",
        referenceNumber: "4500099999",
      }),
    );

    const buyer = extractReferences("Vaše objednávka č. OBJ-2024/55");
    expect(buyer).toContainEqual(
      expect.objectContaining({
        referenceType: "order",
        referenceNumber: "OBJ-2024/55",
      }),
    );
  });

  it("extracts a job (zakázka) reference", () => {
    const refs = extractReferences("Zakázka č. ZAK-2024-12");
    expect(refs).toContainEqual(
      expect.objectContaining({
        referenceType: "job",
        referenceNumber: "ZAK-2024-12",
      }),
    );
  });

  it("never captures non-numeric noise words as references", () => {
    expect(extractReferences("Dodací list ze dne pondělí")).toEqual([]);
    expect(extractReferences("objednávka číslo")).toEqual([]);
  });

  it("dedupes the same (type, number) keeping the highest confidence", () => {
    const refs = extractReferences(
      "Dodací list DL2024001. Dodací list č. DL2024001.",
    );
    const dl = refs.filter((r) => r.referenceType === "delivery_note");
    expect(dl).toHaveLength(1);
  });

  it("returns an empty array for empty / non-string input", () => {
    expect(extractReferences("")).toEqual([]);
    expect(extractReferences(undefined as unknown as string)).toEqual([]);
  });
});
