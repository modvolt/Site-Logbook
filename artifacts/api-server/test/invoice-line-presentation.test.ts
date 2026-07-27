import { describe, expect, it } from "vitest";
import type { InvoiceLine } from "@workspace/db";
import {
  presentInvoiceLines,
  type MaterialDisplayMode,
} from "../src/lib/invoice-line-presentation";

function line(
  id: number,
  patch: Partial<InvoiceLine> = {},
): InvoiceLine {
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

    expect(present([costLine, manual], "summary")).toEqual([
      costLine,
      manual,
    ]);
  });
});
