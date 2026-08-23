import { describe, expect, it } from "vitest";
import {
  finalAllocationStatus,
  isIdempotentIssueRetryStatus,
  prepareCommercialLines,
  settlementMethodForCommercialSource,
  type CommercialPlanningLine,
} from "../src/lib/invoice-source-planning";

function line(patch: Partial<CommercialPlanningLine>): CommercialPlanningLine {
  return {
    sourceType: "work_session",
    description: "Odpracované práce",
    quantity: 1,
    unit: "h",
    unitPriceWithoutVat: 620,
    vatMode: "standard",
    vatRate: 21,
    ...patch,
  };
}

describe("multi-job commercial grouping", () => {
  it("presents four source sessions from two jobs as one 8.5-hour row", () => {
    const raw = [
      line({ sourceId: 1, jobId: 101, quantity: 2 }),
      line({ sourceId: 2, jobId: 101, quantity: 1.5 }),
      line({ sourceId: 3, jobId: 202, quantity: 3 }),
      line({ sourceId: 4, jobId: 202, quantity: 2 }),
    ];

    const plan = prepareCommercialLines(raw, "combined");

    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      quantity: 8.5,
      jobId: null,
      sourceId: null,
      description: "Odpracované práce",
    });
    expect(plan.commercialIndexByRawIndex).toEqual([0, 0, 0, 0]);
    expect(plan.sourceCountByCommercialIndex).toEqual([4]);
    expect(settlementMethodForCommercialSource(4)).toBe("included_in_lump_sum");
  });

  it("combines the same material from two jobs without merging incompatible VAT", () => {
    const raw = [
      line({
        sourceType: "material",
        sourceId: 11,
        jobId: 101,
        description: "Jistič",
        quantity: 3,
        unit: "ks",
        unitPriceWithoutVat: 250,
      }),
      line({
        sourceType: "material",
        sourceId: 12,
        jobId: 202,
        description: "Jistič",
        quantity: 5,
        unit: "ks",
        unitPriceWithoutVat: 250,
      }),
      line({
        sourceType: "material",
        sourceId: 13,
        jobId: 202,
        description: "Jistič",
        quantity: 1,
        unit: "ks",
        unitPriceWithoutVat: 250,
        vatRate: 12,
      }),
    ];

    const plan = prepareCommercialLines(raw, "combined");

    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ quantity: 8, vatRate: 21 });
    expect(plan.lines[1]).toMatchObject({ quantity: 1, vatRate: 12 });
    expect(plan.commercialIndexByRawIndex).toEqual([0, 0, 1]);
  });

  it("never folds a manual row or section into an operational source row", () => {
    const plan = prepareCommercialLines(
      [
        line({ sourceId: 1, quantity: 2 }),
        line({
          sourceType: "manual",
          sourceId: null,
          description: "Odpracované práce",
          quantity: 2,
        }),
        line({
          rowType: "section",
          sourceType: "manual",
          sourceId: null,
          description: "Realizace",
          quantity: 0,
        }),
      ],
      "combined",
    );

    expect(plan.lines).toHaveLength(3);
    expect(plan.commercialIndexByRawIndex).toEqual([0, 1, 2]);
  });
});

describe("source settlement lifecycle", () => {
  it.each([
    ["direct", "billed"],
    ["included_in_lump_sum", "included_in_lump_sum"],
    ["not_charged", "not_charged"],
    ["deferred", "deferred"],
  ] as const)("maps %s to final status %s", (method, expected) => {
    expect(finalAllocationStatus(method)).toBe(expected);
  });

  it("treats only already-finalised invoice states as idempotent issue retries", () => {
    expect(isIdempotentIssueRetryStatus("issued")).toBe(true);
    expect(isIdempotentIssueRetryStatus("sent")).toBe(true);
    expect(isIdempotentIssueRetryStatus("paid")).toBe(true);
    expect(isIdempotentIssueRetryStatus("draft")).toBe(false);
    expect(isIdempotentIssueRetryStatus("cancelled")).toBe(false);
  });
});
