import type { InvoiceLine } from "@workspace/db";
import { num, round2 } from "./invoice-calc";

export type MaterialDisplayMode = "detailed" | "summary";
export type InvoicePresentationMode = MaterialDisplayMode | "custom";

export interface InvoicePresentationGroup {
  description: string;
  lineIndexes: number[];
}

const MATERIAL_SOURCE_TYPES = new Set(["material", "activity_material"]);
const CUSTOM_PRESENTATION_PREFIX = "custom:v1:";
const MAX_PRESENTATION_GROUPS = 500;
const MAX_PRESENTATION_DESCRIPTION_LENGTH = 500;
const MAX_STORED_PRESENTATION_LENGTH = 100_000;

type StoredInvoicePresentation = {
  version: 1;
  groups: InvoicePresentationGroup[];
};

function parseStoredInvoicePresentation(
  value: unknown,
): StoredInvoicePresentation | null {
  if (
    typeof value !== "string" ||
    !value.startsWith(CUSTOM_PRESENTATION_PREFIX) ||
    value.length > MAX_STORED_PRESENTATION_LENGTH
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      value.slice(CUSTOM_PRESENTATION_PREFIX.length),
    ) as {
      version?: unknown;
      groups?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.groups)) return null;

    const groups: InvoicePresentationGroup[] = [];
    for (const candidate of parsed.groups) {
      if (!candidate || typeof candidate !== "object") return null;
      const description = (candidate as { description?: unknown }).description;
      const lineIndexes = (candidate as { lineIndexes?: unknown }).lineIndexes;
      if (
        typeof description !== "string" ||
        !Array.isArray(lineIndexes) ||
        !lineIndexes.every(Number.isInteger)
      ) {
        return null;
      }
      groups.push({ description, lineIndexes: [...lineIndexes] as number[] });
    }

    return { version: 1, groups };
  } catch {
    return null;
  }
}

export function normalizeMaterialDisplayMode(
  value: unknown,
): InvoicePresentationMode {
  if (value === "summary") return "summary";
  return parseStoredInvoicePresentation(value) ? "custom" : "detailed";
}

export function getStoredInvoicePresentationGroups(
  value: unknown,
): InvoicePresentationGroup[] {
  return parseStoredInvoicePresentation(value)?.groups ?? [];
}

function taxKey(line: InvoiceLine): string {
  return `${line.vatMode}:${line.vatRate ?? "null"}`;
}

/**
 * Validates that every persisted source line is represented exactly once.
 * Custom presentation may merge lines, but it may never detach, omit or move
 * the source provenance that reserves materials and links jobs.
 */
export function validateInvoicePresentationGroups(
  groups: readonly InvoicePresentationGroup[],
  lines: readonly InvoiceLine[],
): InvoicePresentationGroup[] {
  if (lines.length === 0) {
    throw new Error("Vlastní texty vyžadují alespoň jednu položku faktury.");
  }
  if (groups.length === 0 || groups.length > MAX_PRESENTATION_GROUPS) {
    throw new Error(
      "Vlastní podoba faktury neobsahuje platné skupiny položek.",
    );
  }

  const seen = new Set<number>();
  const normalized = groups.map((group) => {
    const description = group.description.trim();
    if (!description) {
      throw new Error("Každý zákaznický řádek musí mít vlastní text.");
    }
    if (description.length > MAX_PRESENTATION_DESCRIPTION_LENGTH) {
      throw new Error(
        `Text zákaznického řádku může mít nejvýše ${MAX_PRESENTATION_DESCRIPTION_LENGTH} znaků.`,
      );
    }
    if (!Array.isArray(group.lineIndexes) || group.lineIndexes.length === 0) {
      throw new Error(
        "Zákaznický řádek musí obsahovat alespoň jeden interní zdroj.",
      );
    }

    const indexes = group.lineIndexes.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
        throw new Error("Vlastní podoba faktury odkazuje na neplatný zdroj.");
      }
      if (seen.has(index)) {
        throw new Error(
          "Jeden interní zdroj nelze použít ve více zákaznických řádcích.",
        );
      }
      seen.add(index);
      return index;
    });

    const firstTaxKey = taxKey(lines[indexes[0]]);
    if (indexes.some((index) => taxKey(lines[index]) !== firstTaxKey)) {
      throw new Error(
        "Sloučit lze pouze položky se stejným režimem a sazbou DPH.",
      );
    }

    return { description, lineIndexes: indexes };
  });

  if (seen.size !== lines.length) {
    throw new Error(
      "Každý interní zdroj musí zůstat zahrnutý v některém zákaznickém řádku.",
    );
  }

  return normalized;
}

export function encodeInvoicePresentation(
  groups: readonly InvoicePresentationGroup[],
  lines: readonly InvoiceLine[],
): string {
  const payload: StoredInvoicePresentation = {
    version: 1,
    groups: validateInvoicePresentationGroups(groups, lines),
  };
  const stored = `${CUSTOM_PRESENTATION_PREFIX}${JSON.stringify(payload)}`;
  if (stored.length > MAX_STORED_PRESENTATION_LENGTH) {
    throw new Error("Vlastní podoba faktury je příliš rozsáhlá.");
  }
  return stored;
}

type MaterialGroup = {
  firstIndex: number;
  firstLine: InvoiceLine;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
};

function presentMaterialSummary(lines: InvoiceLine[]): InvoiceLine[] {
  const groups = new Map<string, MaterialGroup>();
  lines.forEach((line, index) => {
    if (!MATERIAL_SOURCE_TYPES.has(line.sourceType)) return;
    const key = taxKey(line);
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
      group.firstLine.vatMode === "standard" && group.firstLine.vatRate != null
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
      description: multipleVatGroups ? `Materiál (${rateLabel})` : "Materiál",
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

function presentCustomGroups(
  lines: InvoiceLine[],
  storedMode: unknown,
): InvoiceLine[] {
  const stored = parseStoredInvoicePresentation(storedMode);
  if (!stored) return lines;

  let groups: InvoicePresentationGroup[];
  try {
    groups = validateInvoicePresentationGroups(stored.groups, lines);
  } catch {
    // Fail open to the detailed source rows. A malformed setting must never
    // hide an amount or source from the customer invoice.
    return lines;
  }

  return groups.map((group, groupIndex) => {
    const sourceLines = group.lineIndexes.map((index) => lines[index]);
    const firstLine = sourceLines[0];
    const totalWithoutVat = round2(
      sourceLines.reduce((sum, line) => sum + num(line.totalWithoutVat), 0),
    );
    const totalVat = round2(
      sourceLines.reduce((sum, line) => sum + num(line.totalVat), 0),
    );
    const totalWithVat = round2(
      sourceLines.reduce((sum, line) => sum + num(line.totalWithVat), 0),
    );

    if (sourceLines.length === 1) {
      return {
        ...firstLine,
        sourceType: "manual",
        sourceId: null,
        jobId: null,
        activityId: null,
        description: group.description,
        sortOrder: groupIndex,
      };
    }

    return {
      ...firstLine,
      sourceType: "manual",
      sourceId: null,
      jobId: null,
      activityId: null,
      description: group.description,
      quantity: "1",
      unit: null,
      unitPriceWithoutVat: String(totalWithoutVat),
      discountPercent: null,
      totalWithoutVat: String(totalWithoutVat),
      totalVat: String(totalVat),
      totalWithVat: String(totalWithVat),
      sortOrder: groupIndex,
    };
  });
}

/**
 * Builds customer-facing lines while leaving the persisted source lines
 * untouched. This is the only projection used by invoice detail and PDF.
 */
export function presentInvoiceLines(
  lines: InvoiceLine[],
  storedMode: unknown,
): InvoiceLine[] {
  const mode = normalizeMaterialDisplayMode(storedMode);
  if (mode === "summary") return presentMaterialSummary(lines);
  if (mode === "custom") return presentCustomGroups(lines, storedMode);
  return lines;
}
