import { describe, it, expect } from "vitest";
import {
  applyMaterialMarkup,
  resolveMaterialMarkup,
  computeLine,
  sumTotals,
} from "../src/lib/invoice-calc";

/**
 * Material markup (přirážka) for invoicing. A percent markup is added to the
 * purchase unit price of MATERIAL lines only; práce/doprava/parkovné/pokuty are
 * untouched. The effective markup is an explicit per-invoice value when given,
 * otherwise the saved billing-settings default.
 */
describe("resolveMaterialMarkup", () => {
  it("uses the explicit per-invoice value over the settings default", () => {
    expect(resolveMaterialMarkup(20, 10)).toBe(20);
  });

  it("falls back to the settings default when no explicit value is given", () => {
    expect(resolveMaterialMarkup(undefined, 15)).toBe(15);
    expect(resolveMaterialMarkup(null, 15)).toBe(15);
  });

  it("accepts a numeric-string settings default (Drizzle numeric)", () => {
    expect(resolveMaterialMarkup(undefined, "12.5")).toBe(12.5);
  });

  it("treats an explicit 0 as opting out of the default", () => {
    expect(resolveMaterialMarkup(0, 25)).toBe(0);
  });

  it("collapses negative / invalid markups to 0", () => {
    expect(resolveMaterialMarkup(-5, 10)).toBe(0);
    expect(resolveMaterialMarkup(undefined, -5)).toBe(0);
    expect(resolveMaterialMarkup(Number.NaN, 10)).toBe(0);
  });
});

describe("applyMaterialMarkup", () => {
  it("adds the percent markup to the unit price", () => {
    expect(applyMaterialMarkup(100, 15)).toBe(115);
    expect(applyMaterialMarkup(250, 20)).toBe(300);
  });

  it("leaves the price unchanged for a 0 markup", () => {
    expect(applyMaterialMarkup(100, 0)).toBe(100);
  });

  it("leaves the price unchanged for a negative markup", () => {
    expect(applyMaterialMarkup(100, -10)).toBe(100);
  });

  it("rounds the marked-up price to 2 decimals", () => {
    // 99.99 * 1.155 = 115.48845 → 115.49
    expect(applyMaterialMarkup(99.99, 15.5)).toBe(115.49);
  });
});

describe("markup applied only to material lines + correct totals", () => {
  type Line = {
    sourceType: string;
    quantity: number;
    unitPrice: number;
  };

  // Mirror how buildProposedLines marks up unit prices: only `material` rows.
  const buildLines = (raw: Line[], markup: number) =>
    raw.map((l) =>
      computeLine(
        {
          quantity: l.quantity,
          unitPriceWithoutVat:
            l.sourceType === "material"
              ? applyMaterialMarkup(l.unitPrice, markup)
              : l.unitPrice,
          vatMode: "standard",
          vatRate: 21,
        },
        "standard",
      ),
    );

  const sample: Line[] = [
    { sourceType: "job", quantity: 1, unitPrice: 1000 }, // práce
    { sourceType: "transport", quantity: 1, unitPrice: 500 }, // doprava
    { sourceType: "material", quantity: 2, unitPrice: 100 }, // materiál
    { sourceType: "fine", quantity: 1, unitPrice: 300 }, // pokuta
  ];

  it("marks up only material unit prices, leaving others untouched", () => {
    const lines = buildLines(sample, 15);
    expect(lines[0].unitPriceWithoutVat).toBe(1000); // práce unchanged
    expect(lines[1].unitPriceWithoutVat).toBe(500); // doprava unchanged
    expect(lines[2].unitPriceWithoutVat).toBe(115); // 100 + 15%
    expect(lines[3].unitPriceWithoutVat).toBe(300); // pokuta unchanged
  });

  it("a 0 markup keeps every line at its base price", () => {
    const lines = buildLines(sample, 0);
    expect(lines.map((l) => l.unitPriceWithoutVat)).toEqual([1000, 500, 100, 300]);
  });

  it("subtotal / VAT / total reflect the marked-up material amount", () => {
    const lines = buildLines(sample, 15);
    // Material line total: 2 * 115 = 230 (vs 200 without markup).
    expect(lines[2].totalWithoutVat).toBe(230);
    const totals = sumTotals(lines);
    // Base 1000 + 500 + 230 + 300 = 2030 without VAT.
    expect(totals.subtotalWithoutVat).toBe(2030);
    expect(totals.totalVat).toBe(426.3); // 21% of 2030
    expect(totals.totalWithVat).toBe(2456.3);
  });

  it("without markup the totals fall back to purchase prices", () => {
    const totals = sumTotals(buildLines(sample, 0));
    // 1000 + 500 + 200 + 300 = 2000.
    expect(totals.subtotalWithoutVat).toBe(2000);
    expect(totals.totalWithVat).toBe(2420);
  });
});
