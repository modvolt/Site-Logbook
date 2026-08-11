export type QuoteRowType = "item" | "section" | "spacer";

export interface QuoteCalculationItem {
  rowType?: QuoteRowType | string | null;
  quantity: number;
  unitPrice: number;
  purchaseUnitPrice?: number | null;
  vatRate?: number | null;
}

export interface QuoteItemTotals {
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

export interface QuoteTotals extends QuoteItemTotals {
  totalPurchaseCost: number;
  marginAmount: number | null;
  marginPercent: number | null;
  financialItemCount: number;
  costedItemCount: number;
  marginComplete: boolean;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeQuoteRowType(
  value: string | null | undefined,
): QuoteRowType {
  return value === "section" || value === "spacer" ? value : "item";
}

export function computeQuoteItemTotals(
  item: QuoteCalculationItem,
  vatPayer: boolean,
): QuoteItemTotals {
  if (normalizeQuoteRowType(item.rowType) !== "item") {
    return { totalWithoutVat: 0, totalVat: 0, totalWithVat: 0 };
  }

  const base = round2(item.unitPrice * item.quantity);
  if (!vatPayer || item.vatRate == null) {
    return { totalWithoutVat: base, totalVat: 0, totalWithVat: base };
  }
  const vat = round2(base * (item.vatRate / 100));
  return {
    totalWithoutVat: base,
    totalVat: vat,
    totalWithVat: round2(base + vat),
  };
}

export function computeQuoteTotals(
  items: QuoteCalculationItem[],
  vatPayer: boolean,
): QuoteTotals {
  let totalWithoutVat = 0;
  let totalVat = 0;
  let totalPurchaseCost = 0;
  let financialItemCount = 0;
  let costedItemCount = 0;

  for (const item of items) {
    if (normalizeQuoteRowType(item.rowType) !== "item") continue;
    financialItemCount += 1;
    const totals = computeQuoteItemTotals(item, vatPayer);
    totalWithoutVat += totals.totalWithoutVat;
    totalVat += totals.totalVat;
    if (item.purchaseUnitPrice != null) {
      costedItemCount += 1;
      totalPurchaseCost += round2(item.purchaseUnitPrice * item.quantity);
    }
  }

  totalWithoutVat = round2(totalWithoutVat);
  totalVat = round2(totalVat);
  totalPurchaseCost = round2(totalPurchaseCost);
  const totalWithVat = round2(totalWithoutVat + totalVat);
  const marginComplete =
    financialItemCount > 0 && costedItemCount === financialItemCount;
  const marginAmount = marginComplete
    ? round2(totalWithoutVat - totalPurchaseCost)
    : null;
  const marginPercent =
    marginAmount != null && totalPurchaseCost !== 0
      ? round2((marginAmount / totalPurchaseCost) * 100)
      : null;

  return {
    totalWithoutVat,
    totalVat,
    totalWithVat,
    totalPurchaseCost,
    marginAmount,
    marginPercent,
    financialItemCount,
    costedItemCount,
    marginComplete,
  };
}
