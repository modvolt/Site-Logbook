import { describe, it, expect } from "vitest";
import { parseDecimal, decimalError } from "../src/components/decimal-input";

/**
 * Unit tests for the decimal parsing and validation helpers used by
 * DecimalInput in job-form, activity-form, and other inline quantity fields.
 *
 * These cover the validation logic that drives the "Neplatné číslo" error
 * message and the disabled state of "Přidat materiál" on the new-job form.
 */

describe("parseDecimal", () => {
  it("returns null for an empty string", () => {
    expect(parseDecimal("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(parseDecimal("   ")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("1a2")).toBeNull();
    expect(parseDecimal("xyz")).toBeNull();
  });

  it("parses an integer", () => {
    expect(parseDecimal("5")).toBe(5);
    expect(parseDecimal("100")).toBe(100);
  });

  it("parses a decimal with period separator", () => {
    expect(parseDecimal("1.5")).toBe(1.5);
    expect(parseDecimal("3.14")).toBeCloseTo(3.14);
  });

  it("parses a decimal with Czech comma separator", () => {
    expect(parseDecimal("1,5")).toBe(1.5);
    expect(parseDecimal("2,75")).toBeCloseTo(2.75);
  });

  it("returns null for Infinity", () => {
    expect(parseDecimal("Infinity")).toBeNull();
    expect(parseDecimal("-Infinity")).toBeNull();
  });
});

describe("decimalError", () => {
  it("returns undefined for an empty string (blank is allowed)", () => {
    expect(decimalError("")).toBeUndefined();
    expect(decimalError("   ")).toBeUndefined();
  });

  it("returns 'Neplatné číslo' for non-numeric input", () => {
    expect(decimalError("abc")).toBe("Neplatné číslo");
    expect(decimalError("xyz")).toBe("Neplatné číslo");
    expect(decimalError("1a")).toBe("Neplatné číslo");
  });

  it("returns undefined for a valid positive number", () => {
    expect(decimalError("5")).toBeUndefined();
    expect(decimalError("1.5")).toBeUndefined();
    expect(decimalError("1,5")).toBeUndefined();
  });

  it("returns 'Nesmí být záporné' for a negative number (default: no negatives)", () => {
    expect(decimalError("-1")).toBe("Nesmí být záporné");
    expect(decimalError("-0.5")).toBe("Nesmí být záporné");
  });

  it("allows negative numbers when allowNegative is true", () => {
    expect(decimalError("-1", { allowNegative: true })).toBeUndefined();
    expect(decimalError("-100", { allowNegative: true })).toBeUndefined();
  });

  it("returns 'Musí být větší než 0' when positiveOnly and value is zero", () => {
    expect(decimalError("0", { positiveOnly: true })).toBe("Musí být větší než 0");
  });

  it("returns 'Musí být větší než 0' when positiveOnly and value is negative", () => {
    expect(decimalError("-1", { positiveOnly: true })).toBe("Musí být větší než 0");
  });

  it("returns undefined when positiveOnly and value is positive", () => {
    expect(decimalError("1", { positiveOnly: true })).toBeUndefined();
    expect(decimalError("0.01", { positiveOnly: true })).toBeUndefined();
  });

  it("respects the max option", () => {
    expect(decimalError("11", { max: 10 })).toMatch(/nesmí přesáhnout/i);
    expect(decimalError("10", { max: 10 })).toBeUndefined();
    expect(decimalError("9", { max: 10 })).toBeUndefined();
  });
});

describe("job-form material validation — combined newMatHasErrors logic", () => {
  /**
   * Mirrors the exact gate used in job-form.tsx:
   *   const newMatQtyError = decimalError(newMaterial.quantity);
   *   const newMatPriceError = decimalError(newMaterial.pricePerUnit);
   *   const newMatHasErrors = !!(newMatQtyError || newMatPriceError);
   * The "Přidat materiál" button is disabled when name is empty OR newMatHasErrors.
   */
  function canAdd(name: string, quantity: string, price: string): boolean {
    const qtyError = decimalError(quantity);
    const priceError = decimalError(price);
    const hasErrors = !!(qtyError || priceError);
    return !!name.trim() && !hasErrors;
  }

  it("blocks adding when quantity is invalid text", () => {
    expect(canAdd("Beton", "abc", "")).toBe(false);
  });

  it("blocks adding when price is invalid text", () => {
    expect(canAdd("Beton", "5", "xyz")).toBe(false);
  });

  it("blocks adding when material name is empty even if numbers are valid", () => {
    expect(canAdd("", "5", "100")).toBe(false);
    expect(canAdd("  ", "5", "100")).toBe(false);
  });

  it("allows adding when name is filled and both fields are empty (optional)", () => {
    expect(canAdd("Beton", "", "")).toBe(true);
  });

  it("allows adding when name is filled and both numbers are valid", () => {
    expect(canAdd("Beton", "5", "100")).toBe(true);
    expect(canAdd("Písek", "1,5", "250")).toBe(true);
  });

  it("allows adding when name is filled and only quantity is provided", () => {
    expect(canAdd("Beton", "10", "")).toBe(true);
  });
});
