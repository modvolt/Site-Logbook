import { describe, it, expect } from "vitest";
import {
  classifyFee,
  normalizeUnit,
  parsePricePer,
  computeDiscountPercent,
} from "../src/lib/fee-classifier";

/**
 * Tests for the deterministic fee classifier + unit normalizer used to turn
 * messy Czech supplier line items into structured data.
 */

describe("classifyFee", () => {
  it("flags recycling / PHE fees as environmental", () => {
    for (const text of [
      "Recyklační příspěvek",
      "PHE poplatek",
      "Zpětný odběr elektroodpadu",
    ]) {
      const c = classifyFee(text);
      expect(c.feeType).toBe("recycling");
      expect(c.isEnvironmentalFee).toBe(true);
    }
  });

  it("classifies transport, packaging, discount and rounding", () => {
    expect(classifyFee("Doprava zboží").feeType).toBe("transport");
    expect(classifyFee("Balné a obal").feeType).toBe("packaging");
    expect(classifyFee("Sleva 10%").feeType).toBe("discount");
    expect(classifyFee("Zaokrouhlení").feeType).toBe("rounding");
  });

  it("returns no fee type for an ordinary product", () => {
    const c = classifyFee("Kabel CYKY 3x1,5");
    expect(c.feeType).toBeNull();
    expect(c.isEnvironmentalFee).toBe(false);
  });

  it("handles empty input", () => {
    expect(classifyFee(null).feeType).toBeNull();
    expect(classifyFee(undefined).feeType).toBeNull();
  });
});

describe("normalizeUnit", () => {
  it("maps Czech spellings to canonical units", () => {
    expect(normalizeUnit("kus")).toBe("ks");
    expect(normalizeUnit("ks")).toBe("ks");
    expect(normalizeUnit("bm")).toBe("m");
    expect(normalizeUnit("m²")).toBe("m2");
    expect(normalizeUnit("m³")).toBe("m3");
    expect(normalizeUnit("Hodina")).toBe("hod");
  });

  it("returns unknown units lowercased rather than dropping them", () => {
    expect(normalizeUnit("Foo")).toBe("foo");
  });

  it("returns null for empty input", () => {
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit("   ")).toBeNull();
  });
});

describe("parsePricePer", () => {
  it("detects per-N pricing", () => {
    expect(parsePricePer("123 Kč / 100 m")).toEqual({
      baseQuantity: 100,
      baseUnit: "m",
    });
    expect(parsePricePer("cena za 1000 ks")).toEqual({
      baseQuantity: 1000,
      baseUnit: "ks",
    });
  });

  it("defaults to base quantity 1 when no multiplier is present", () => {
    expect(parsePricePer("Kabel")).toEqual({ baseQuantity: 1, baseUnit: null });
    expect(parsePricePer(null)).toEqual({ baseQuantity: 1, baseUnit: null });
  });
});

describe("computeDiscountPercent", () => {
  it("derives a discount from list vs. final price", () => {
    expect(computeDiscountPercent(100, 80)).toBe(20);
    expect(computeDiscountPercent(250, 200)).toBe(20);
  });

  it("returns null for invalid / zero / negative inputs", () => {
    expect(computeDiscountPercent(null, 80)).toBeNull();
    expect(computeDiscountPercent(0, 80)).toBeNull();
    expect(computeDiscountPercent(80, 100)).toBeNull();
  });
});
