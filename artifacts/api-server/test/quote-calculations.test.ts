import { describe, expect, it } from "vitest";
import {
  computeQuoteItemTotals,
  computeQuoteTotals,
} from "../src/lib/quote-calculations";

describe("server quote calculations", () => {
  it("excludes headings and spacers from price and margin totals", () => {
    const totals = computeQuoteTotals(
      [
        { rowType: "section", quantity: 20, unitPrice: 20, purchaseUnitPrice: 20, vatRate: 21 },
        { rowType: "item", quantity: 2, unitPrice: 125, purchaseUnitPrice: 100, vatRate: 21 },
        { rowType: "spacer", quantity: 20, unitPrice: 20, purchaseUnitPrice: 20, vatRate: 21 },
      ],
      true,
    );

    expect(totals.totalWithoutVat).toBe(250);
    expect(totals.totalVat).toBe(52.5);
    expect(totals.totalPurchaseCost).toBe(200);
    expect(totals.marginAmount).toBe(50);
    expect(totals.marginPercent).toBe(25);
    expect(totals.financialItemCount).toBe(1);
  });

  it("keeps structural item totals at zero for public responses and PDFs", () => {
    expect(
      computeQuoteItemTotals(
        { rowType: "section", quantity: 1, unitPrice: 5000, vatRate: 21 },
        true,
      ),
    ).toEqual({ totalWithoutVat: 0, totalVat: 0, totalWithVat: 0 });
  });

  it("leaves the percentage undefined when all entered purchase costs are zero", () => {
    const totals = computeQuoteTotals(
      [{ rowType: "item", quantity: 1, unitPrice: 100, purchaseUnitPrice: 0, vatRate: 21 }],
      true,
    );

    expect(totals.marginAmount).toBe(100);
    expect(totals.marginPercent).toBeNull();
  });
});
