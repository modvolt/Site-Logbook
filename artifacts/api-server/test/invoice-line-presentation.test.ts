import { describe, expect, it } from "vitest";
import type { InvoiceLine } from "@workspace/db";
import {
  encodeInvoicePresentation,
  getStoredInvoicePresentationGroups,
  normalizeMaterialDisplayMode,
  presentInvoiceLines,
  validateInvoicePresentationGroups,
  type MaterialDisplayMode,
} from "../src/lib/invoice-line-presentation";

function line(id: number, patch: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    id,
    invoiceId: 10,
    sourceType: "manual",
    sourceId: null,
    jobId: null,
    activityId: null,
    description: `Položka ${id}`,
    quantity: "1",
    unit: "ks",
    unitPriceWithoutVat: "100",
    discountPercent: null,
    vatRate: "21",
    vatMode: "standard",
    totalWithoutVat: "100",
    totalVat: "21",
    totalWithVat: "121",
    sortOrder: id,
    createdAt: new Date("2026-07-27T10:00:00Z"),
    updatedAt: new Date("2026-07-27T10:00:00Z"),
    ...patch,
  };
}

function present(lines: InvoiceLine[], mode: MaterialDisplayMode) {
  return presentInvoiceLines(lines, mode);
}

describe("invoice material presentation", () => {
  it("keeps detailed material lines unchanged by default", () => {
    const lines = [
      line(1, { sourceType: "material", description: "Kabel" }),
      line(2, { sourceType: "activity_material", description: "Jistič" }),
    ];

    expect(present(lines, "detailed")).toBe(lines);
  });

  it("shows material with the same VAT as one exact customer-facing amount", () => {
    const work = line(1, {
      sourceType: "work_session",
      description: "Práce",
      totalWithoutVat: "800",
      totalVat: "168",
      totalWithVat: "968",
    });
    const lines = [
      work,
      line(2, {
        sourceType: "material",
        sourceId: 41,
        description: "Kabel",
        unitPriceWithoutVat: "130",
        totalWithoutVat: "260",
        totalVat: "54.60",
        totalWithVat: "314.60",
      }),
      line(3, {
        sourceType: "activity_material",
        sourceId: 8,
        description: "Jistič",
        unitPriceWithoutVat: "120",
        totalWithoutVat: "120",
        totalVat: "25.20",
        totalWithVat: "145.20",
      }),
    ];

    const result = present(lines, "summary");

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(work);
    expect(result[1]).toMatchObject({
      description: "Materiál",
      sourceType: "material",
      sourceId: null,
      quantity: "1",
      unit: "soubor",
      unitPriceWithoutVat: "380",
      totalWithoutVat: "380",
      totalVat: "79.8",
      totalWithVat: "459.8",
    });
  });

  it("keeps separate material totals for different VAT rates", () => {
    const lines = [
      line(1, {
        sourceType: "material",
        vatRate: "21",
        totalWithoutVat: "100",
        totalVat: "21",
        totalWithVat: "121",
      }),
      line(2, {
        sourceType: "material",
        vatRate: "12",
        totalWithoutVat: "50",
        totalVat: "6",
        totalWithVat: "56",
      }),
    ];

    const result = present(lines, "summary");

    expect(result.map((item) => item.description)).toEqual([
      "Materiál (21 % DPH)",
      "Materiál (12 % DPH)",
    ]);
    expect(
      result.reduce((sum, item) => sum + Number(item.totalWithVat), 0),
    ).toBe(177);
  });

  it("does not relabel unrelated received-document or manual costs as material", () => {
    const costLine = line(1, {
      sourceType: "billing_document_line",
      description: "Pronájem plošiny",
    });
    const manual = line(2, {
      sourceType: "manual",
      description: "Revize",
    });

    expect(present([costLine, manual], "summary")).toEqual([costLine, manual]);
  });
});

describe("custom invoice presentation", () => {
  it("round-trips Unicode text and merges source totals without mutating sources", () => {
    const lines = [
      line(1, {
        sourceType: "work_session",
        sourceId: 71,
        description: "Práce technika",
        totalWithoutVat: "800",
        totalVat: "168",
        totalWithVat: "968",
      }),
      line(2, {
        sourceType: "material",
        sourceId: 42,
        description: "Kabel CYKY",
        totalWithoutVat: "260",
        totalVat: "54.6",
        totalWithVat: "314.6",
      }),
      line(3, {
        sourceType: "transport",
        sourceId: 9,
        description: "Doprava",
        totalWithoutVat: "300",
        totalVat: "63",
        totalWithVat: "363",
      }),
    ];
    const snapshot = structuredClone(lines);
    const groups = [
      {
        description: "Kompletní montáž a dodávka ⚡",
        lineIndexes: [0, 1],
      },
      { description: "Doprava na místo realizace", lineIndexes: [2] },
    ];

    const stored = encodeInvoicePresentation(groups, lines);
    const result = presentInvoiceLines(lines, stored);

    expect(normalizeMaterialDisplayMode(stored)).toBe("custom");
    expect(getStoredInvoicePresentationGroups(stored)).toEqual(groups);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      description: "Kompletní montáž a dodávka ⚡",
      sourceType: "manual",
      sourceId: null,
      quantity: "1",
      unit: null,
      totalWithoutVat: "1060",
      totalVat: "222.6",
      totalWithVat: "1282.6",
    });
    expect(result[1]).toMatchObject({
      description: "Doprava na místo realizace",
      sourceType: "manual",
      sourceId: null,
      quantity: "1",
      unit: "ks",
      totalWithoutVat: "300",
    });
    expect(lines).toEqual(snapshot);
  });

  it("requires every source exactly once so hidden sources remain linked", () => {
    const lines = [line(1), line(2)];

    expect(() =>
      validateInvoicePresentationGroups(
        [{ description: "Jen první", lineIndexes: [0] }],
        lines,
      ),
    ).toThrow("Každý interní zdroj");
    expect(() =>
      validateInvoicePresentationGroups(
        [
          { description: "První", lineIndexes: [0, 1] },
          { description: "Podruhé", lineIndexes: [1] },
        ],
        lines,
      ),
    ).toThrow("ve více zákaznických řádcích");
  });

  it("rejects merging different VAT treatments", () => {
    const lines = [
      line(1, { vatRate: "21" }),
      line(2, { vatRate: "12", totalVat: "12", totalWithVat: "112" }),
    ];

    expect(() =>
      encodeInvoicePresentation(
        [{ description: "Jedna dodávka", lineIndexes: [0, 1] }],
        lines,
      ),
    ).toThrow("stejným režimem a sazbou DPH");
  });

  it("falls back to detailed lines when stored custom data is malformed", () => {
    const lines = [line(1), line(2)];
    const malformed =
      'custom:v1:{"version":1,"groups":[{"description":"Skryto","lineIndexes":[0]}]}';

    expect(presentInvoiceLines(lines, malformed)).toBe(lines);
  });
});
