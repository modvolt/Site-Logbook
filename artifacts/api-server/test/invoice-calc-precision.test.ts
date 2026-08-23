import { describe, expect, it } from "vitest";
import {
  applyMaterialMarkup,
  computeLine,
  sumTotals,
  vatBreakdown,
} from "../src/lib/invoice-calc";

describe("invoice money precision", () => {
  it("rounds quantity, price and VAT in decimal cents without float drift", () => {
    const line = computeLine(
      {
        quantity: 3,
        unitPriceWithoutVat: 0.1,
        vatMode: "standard",
        vatRate: 21,
      },
      "standard",
    );

    expect(line.totalWithoutVat).toBe(0.3);
    expect(line.totalVat).toBe(0.06);
    expect(line.totalWithVat).toBe(0.36);
  });

  it("rounds the commercial line once after applying a percent discount", () => {
    const line = computeLine(
      {
        quantity: 3,
        unitPriceWithoutVat: 999.99,
        discountPercent: 12.5,
        vatMode: "standard",
        vatRate: 21,
      },
      "standard",
    );

    expect(line.totalWithoutVat).toBe(2624.97);
    expect(line.totalVat).toBe(551.24);
    expect(line.totalWithVat).toBe(3176.21);
  });

  it("sums already rounded cents exactly across many lines", () => {
    const lines = Array.from({ length: 1_000 }, () =>
      computeLine(
        {
          quantity: 1,
          unitPriceWithoutVat: 0.1,
          vatMode: "standard",
          vatRate: 21,
        },
        "standard",
      ),
    );

    expect(sumTotals(lines)).toEqual({
      subtotalWithoutVat: 100,
      totalVat: 20,
      totalWithVat: 120,
    });
    expect(vatBreakdown(lines)).toEqual([{ rate: 21, base: 100, vat: 20 }]);
  });

  it("keeps section rows structurally visible but financially zero", () => {
    expect(
      computeLine(
        {
          rowType: "section",
          quantity: 999,
          unitPriceWithoutVat: 999,
          vatMode: "standard",
          vatRate: 21,
        },
        "standard",
      ),
    ).toMatchObject({
      quantity: 0,
      unitPriceWithoutVat: 0,
      totalWithoutVat: 0,
      totalVat: 0,
      totalWithVat: 0,
    });
  });

  it("applies material markup using decimal basis points", () => {
    expect(applyMaterialMarkup(0.1, 12.5)).toBe(0.11);
    expect(applyMaterialMarkup(1_999.99, 17.5)).toBe(2_349.99);
  });
});
