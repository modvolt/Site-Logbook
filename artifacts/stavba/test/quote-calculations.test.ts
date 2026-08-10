import { describe, expect, it } from "vitest";
import {
  computeQuoteFormTotals,
  createQuoteFormRow,
  hasInvalidQuoteMargin,
  marginPercentFromPrices,
  unitPriceFromMargin,
  validateQuoteFormRows,
} from "../src/lib/quote-calculations";

describe("quote margin calculations", () => {
  it("adds the entered margin percentage to the purchase price", () => {
    expect(unitPriceFromMargin(100, 20)).toBe(120);
    expect(marginPercentFromPrices(100, 120)).toBe(20);
    expect(unitPriceFromMargin(100, 150)).toBe(250);
  });

  it("computes a weighted quote margin and ignores structural rows", () => {
    const itemA = {
      ...createQuoteFormRow("item"),
      description: "Materiál",
      quantity: "2",
      purchaseUnitPrice: "100",
      unitPrice: "125",
    };
    const itemB = {
      ...createQuoteFormRow("item"),
      description: "Montáž",
      quantity: "1",
      purchaseUnitPrice: "50",
      unitPrice: "100",
    };
    const section = {
      ...createQuoteFormRow("section"),
      description: "Systém A",
      quantity: "999",
      purchaseUnitPrice: "999",
      unitPrice: "999",
    };

    const totals = computeQuoteFormTotals([section, itemA, itemB]);
    expect(totals.financialItemCount).toBe(2);
    expect(totals.totalPurchaseCost).toBe(250);
    expect(totals.subtotalWithoutVat).toBe(350);
    expect(totals.marginAmount).toBe(100);
    expect(totals.marginPercent).toBe(40);
  });

  it("does not present an inflated margin while a purchase price is missing", () => {
    const costed = {
      ...createQuoteFormRow("item"),
      description: "Materiál",
      purchaseUnitPrice: "80",
      unitPrice: "100",
    };
    const missing = {
      ...createQuoteFormRow("item"),
      description: "Práce",
      purchaseUnitPrice: "",
      unitPrice: "1000",
    };

    const totals = computeQuoteFormTotals([costed, missing]);
    expect(totals.marginComplete).toBe(false);
    expect(totals.costedItemCount).toBe(1);
    expect(totals.marginAmount).toBeNull();
    expect(totals.marginPercent).toBeNull();
  });

  it("allows margins over 100% and blocks values that would make the sale negative", () => {
    const highMargin = {
      ...createQuoteFormRow("item"),
      description: "Střídač",
      purchaseUnitPrice: "100",
      marginPercent: "150",
      unitPrice: "250",
    };
    expect(hasInvalidQuoteMargin(highMargin)).toBe(false);
    expect(validateQuoteFormRows([highMargin])).toBeNull();

    const impossible = {
      ...createQuoteFormRow("item"),
      description: "Střídač",
      purchaseUnitPrice: "100",
      marginPercent: "-101",
      unitPrice: "",
    };
    expect(hasInvalidQuoteMargin(impossible)).toBe(true);
    expect(validateQuoteFormRows([impossible])).toContain("alespoň −100 %");
  });

  it("does not invent a percentage when the total purchase cost is zero", () => {
    const zeroCost = {
      ...createQuoteFormRow("item"),
      description: "Bonus",
      purchaseUnitPrice: "0",
      unitPrice: "100",
    };
    const totals = computeQuoteFormTotals([zeroCost]);
    expect(totals.marginAmount).toBe(100);
    expect(totals.marginPercent).toBeNull();
    expect(marginPercentFromPrices(0, 100)).toBeNull();
  });
});
