export type QuoteRowType = "item" | "section" | "spacer";

export interface QuoteFormRow {
  clientId: string;
  rowType: QuoteRowType;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  purchaseUnitPrice: string;
  marginPercent: string;
  vatRate: string;
}

export interface QuoteFormTotals {
  subtotalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  totalPurchaseCost: number;
  marginAmount: number | null;
  marginPercent: number | null;
  financialItemCount: number;
  costedItemCount: number;
  marginComplete: boolean;
}

let nextClientRowId = 0;

export function parseQuoteNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatQuoteInput(value: number, decimals = 2): string {
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function createQuoteFormRow(rowType: QuoteRowType = "item"): QuoteFormRow {
  nextClientRowId += 1;
  return {
    clientId: `quote-row-${nextClientRowId}`,
    rowType,
    description: "",
    quantity: rowType === "item" ? "1" : "",
    unit: rowType === "item" ? "ks" : "",
    unitPrice: rowType === "item" ? "0" : "",
    purchaseUnitPrice: "",
    marginPercent: "",
    vatRate: rowType === "item" ? "21" : "",
  };
}

export function marginPercentFromPrices(
  purchaseUnitPrice: number,
  unitPrice: number,
): number | null {
  if (purchaseUnitPrice === 0) return unitPrice === 0 ? 0 : null;
  return Math.round(((unitPrice - purchaseUnitPrice) / purchaseUnitPrice) * 10_000) / 100;
}

export function unitPriceFromMargin(
  purchaseUnitPrice: number,
  marginPercent: number,
): number | null {
  if (marginPercent < -100) return null;
  return Math.round((purchaseUnitPrice * (1 + marginPercent / 100)) * 100) / 100;
}

export function hasInvalidQuoteMargin(row: QuoteFormRow): boolean {
  if (row.marginPercent.trim() === "") return false;

  const margin = parseQuoteNumber(row.marginPercent);
  const purchaseUnitPrice = parseQuoteNumber(row.purchaseUnitPrice);
  if (margin == null || purchaseUnitPrice == null) return true;
  return margin < -100;
}

export function computeQuoteFormTotals(
  rows: QuoteFormRow[],
  vatPayer = true,
): QuoteFormTotals {
  let subtotalWithoutVat = 0;
  let totalVat = 0;
  let totalPurchaseCost = 0;
  let financialItemCount = 0;
  let costedItemCount = 0;

  for (const row of rows) {
    if (row.rowType !== "item") continue;
    financialItemCount += 1;
    const quantity = parseQuoteNumber(row.quantity) ?? 1;
    const unitPrice = parseQuoteNumber(row.unitPrice) ?? 0;
    const vatRate = parseQuoteNumber(row.vatRate) ?? 0;
    const totalWithoutVat = Math.round(quantity * unitPrice * 100) / 100;
    const vat = vatPayer
      ? Math.round(totalWithoutVat * (vatRate / 100) * 100) / 100
      : 0;
    subtotalWithoutVat += totalWithoutVat;
    totalVat += vat;

    const purchaseUnitPrice = parseQuoteNumber(row.purchaseUnitPrice);
    if (purchaseUnitPrice != null) {
      costedItemCount += 1;
      totalPurchaseCost += Math.round(quantity * purchaseUnitPrice * 100) / 100;
    }
  }

  subtotalWithoutVat = Math.round(subtotalWithoutVat * 100) / 100;
  totalVat = Math.round(totalVat * 100) / 100;
  totalPurchaseCost = Math.round(totalPurchaseCost * 100) / 100;
  const totalWithVat = Math.round((subtotalWithoutVat + totalVat) * 100) / 100;
  const marginComplete =
    financialItemCount > 0 && financialItemCount === costedItemCount;
  const marginAmount = marginComplete
    ? Math.round((subtotalWithoutVat - totalPurchaseCost) * 100) / 100
    : null;
  const marginPercent =
    marginAmount != null && totalPurchaseCost !== 0
      ? Math.round((marginAmount / totalPurchaseCost) * 10_000) / 100
      : null;

  return {
    subtotalWithoutVat,
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

export function validateQuoteFormRows(rows: QuoteFormRow[]): string | null {
  for (const row of rows) {
    if (row.rowType === "spacer") continue;
    if (!row.description.trim()) {
      return row.rowType === "section"
        ? "Doplňte název sekce."
        : "Doplňte popis každé cenové položky.";
    }
    if (row.rowType !== "item") continue;

    const quantity = parseQuoteNumber(row.quantity);
    const unitPrice = parseQuoteNumber(row.unitPrice);
    const purchaseUnitPrice = parseQuoteNumber(row.purchaseUnitPrice);
    if (hasInvalidQuoteMargin(row)) {
      return `Marže položky „${row.description.trim()}“ musí být číslo alespoň −100 %.`;
    }
    if (quantity == null || quantity <= 0) {
      return `Množství položky „${row.description.trim()}“ musí být větší než nula.`;
    }
    if (unitPrice == null || unitPrice < 0) {
      return `Doplňte platnou prodejní cenu položky „${row.description.trim()}“.`;
    }
    if (row.purchaseUnitPrice.trim() !== "" && (purchaseUnitPrice == null || purchaseUnitPrice < 0)) {
      return `Doplňte platnou nákupní cenu položky „${row.description.trim()}“.`;
    }
  }
  return null;
}
