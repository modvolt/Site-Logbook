import type { InvoiceLine } from "@workspace/db";
import { num, round2 } from "./invoice-calc";

export type MaterialDisplayMode = "detailed" | "summary";

const MATERIAL_SOURCE_TYPES = new Set(["material", "activity_material"]);

export function normalizeMaterialDisplayMode(
  value: unknown,
): MaterialDisplayMode {
  return value === "summary" ? "summary" : "detailed";
}

type MaterialGroup = {
  firstIndex: number;
  firstLine: InvoiceLine;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
};

/**
 * Builds customer-facing lines while leaving the persisted source lines
 * untouched. Material is grouped per VAT mode/rate so the rendered VAT
 * breakdown remains identical to the detailed invoice.
 */
export function presentInvoiceLines(
  lines: InvoiceLine[],
  mode: MaterialDisplayMode,
): InvoiceLine[] {
  if (mode !== "summary") return lines;

  const groups = new Map<string, MaterialGroup>();
  lines.forEach((line, index) => {
    if (!MATERIAL_SOURCE_TYPES.has(line.sourceType)) return;
    const key = `${line.vatMode}:${line.vatRate ?? "null"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalWithoutVat = round2(
        existing.totalWithoutVat + num(line.totalWithoutVat),
      );
      existing.totalVat = round2(existing.totalVat + num(line.totalVat));
      existing.totalWithVat = round2(
        existing.totalWithVat + num(line.totalWithVat),
      );
      return;
    }
    groups.set(key, {
      firstIndex: index,
      firstLine: line,
      totalWithoutVat: num(line.totalWithoutVat),
      totalVat: num(line.totalVat),
      totalWithVat: num(line.totalWithVat),
    });
  });

  if (groups.size === 0) return lines;

  const materialIndexes = new Set(
    [...groups.values()].map((group) => group.firstIndex),
  );
  const groupByFirstIndex = new Map(
    [...groups.values()].map((group) => [group.firstIndex, group]),
  );
  const multipleVatGroups = groups.size > 1;
  const result: InvoiceLine[] = [];

  lines.forEach((line, index) => {
    if (!MATERIAL_SOURCE_TYPES.has(line.sourceType)) {
      result.push(line);
      return;
    }
    if (!materialIndexes.has(index)) return;

    const group = groupByFirstIndex.get(index);
    if (!group) return;
    const rateLabel =
      group.firstLine.vatMode === "standard" &&
      group.firstLine.vatRate != null
        ? `${num(group.firstLine.vatRate)} % DPH`
        : group.firstLine.vatMode === "reverse_charge"
          ? "přenesená daňová povinnost"
          : group.firstLine.vatMode === "non_vat"
            ? "bez DPH"
            : "0 % DPH";

    result.push({
      ...group.firstLine,
      sourceType: "material",
      sourceId: null,
      jobId: null,
      activityId: null,
      description: multipleVatGroups
        ? `Materiál (${rateLabel})`
        : "Materiál",
      quantity: "1",
      unit: "soubor",
      unitPriceWithoutVat: String(group.totalWithoutVat),
      discountPercent: null,
      totalWithoutVat: String(group.totalWithoutVat),
      totalVat: String(group.totalVat),
      totalWithVat: String(group.totalWithVat),
    });
  });

  return result;
}
