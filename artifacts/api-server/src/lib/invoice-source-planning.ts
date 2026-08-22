import { num, round2, type VatMode } from "./invoice-calc";

export interface CommercialPlanningLine {
  rowType?: "item" | "section";
  sourceType: string;
  sourceId?: number | null;
  jobId?: number | null;
  activityId?: number | null;
  description: string;
  unit?: string | null;
  quantity?: number | null;
  unitPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  vatRate?: number | null;
  vatMode?: VatMode | null;
}

export interface PreparedCommercialLines<T extends CommercialPlanningLine> {
  lines: T[];
  /** Maps every raw source line index to its customer-facing line index. */
  commercialIndexByRawIndex: number[];
  sourceCountByCommercialIndex: number[];
}

/**
 * Aggregate compatible customer-facing rows without discarding the mapping to
 * each raw source. Manual rows, fixed job-price rows and section headings are
 * intentionally unique; operational material/work rows may combine across
 * jobs when their commercial units, prices, discount and VAT treatment match.
 */
export function prepareCommercialLines<T extends CommercialPlanningLine>(
  rawLines: T[],
  grouping: "by_job" | "combined",
): PreparedCommercialLines<T> {
  if (grouping === "by_job") {
    return {
      lines: rawLines,
      commercialIndexByRawIndex: rawLines.map((_, index) => index),
      sourceCountByCommercialIndex: rawLines.map(() => 1),
    };
  }

  const lines: T[] = [];
  const commercialIndexByRawIndex: number[] = [];
  const sourceCountByCommercialIndex: number[] = [];
  const compatible = new Map<string, number>();
  rawLines.forEach((line, rawIndex) => {
    const canCombine =
      line.rowType !== "section" &&
      line.sourceType !== "manual" &&
      line.sourceType !== "quote_item" &&
      line.sourceType !== "job";
    const key = canCombine
      ? JSON.stringify([
          line.sourceType,
          line.description.trim().toLocaleLowerCase("cs"),
          line.unit ?? null,
          round2(num(line.unitPriceWithoutVat)),
          line.discountPercent == null
            ? null
            : round2(num(line.discountPercent)),
          line.vatMode ?? null,
          line.vatRate == null ? null : round2(num(line.vatRate)),
        ])
      : `unique:${rawIndex}`;
    const existingIndex = compatible.get(key);
    if (existingIndex == null) {
      const commercialIndex = lines.length;
      compatible.set(key, commercialIndex);
      lines.push({ ...line });
      commercialIndexByRawIndex[rawIndex] = commercialIndex;
      sourceCountByCommercialIndex[commercialIndex] = 1;
      return;
    }
    const existing = lines[existingIndex];
    existing.quantity = round2(
      num(existing.quantity ?? 1) + num(line.quantity ?? 1),
    );
    if (existing.jobId !== line.jobId) existing.jobId = null;
    if (existing.activityId !== line.activityId) existing.activityId = null;
    if (existing.sourceId !== line.sourceId) existing.sourceId = null;
    commercialIndexByRawIndex[rawIndex] = existingIndex;
    sourceCountByCommercialIndex[existingIndex] += 1;
  });
  return { lines, commercialIndexByRawIndex, sourceCountByCommercialIndex };
}

export type SettlementMethod =
  | "direct"
  | "included_in_lump_sum"
  | "not_charged"
  | "deferred";

export function settlementMethodForCommercialSource(
  sourceCount: number,
  explicit?: SettlementMethod,
): SettlementMethod {
  return explicit ?? (sourceCount > 1 ? "included_in_lump_sum" : "direct");
}

export function finalAllocationStatus(
  method: SettlementMethod,
): "billed" | "included_in_lump_sum" | "not_charged" | "deferred" {
  return method === "direct" ? "billed" : method;
}

export function isIdempotentIssueRetryStatus(status: string): boolean {
  return status === "issued" || status === "sent" || status === "paid";
}
