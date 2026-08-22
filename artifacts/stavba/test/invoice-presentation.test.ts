import { describe, expect, it } from "vitest";
import {
  createDefaultPresentationGroups,
  initializePresentationGroups,
  mergePresentationGroups,
  movePresentationGroup,
  splitPresentationGroup,
  validatePresentationGroups,
} from "../src/lib/invoice-presentation";

const lines = [
  {
    description: "Práce technika",
    totalWithoutVat: 1_000,
    vatMode: "standard" as const,
    vatRate: 21,
  },
  {
    description: "Kabeláž",
    totalWithoutVat: 600,
    vatMode: "standard" as const,
    vatRate: 21,
  },
  {
    description: "Revize",
    totalWithoutVat: 500,
    vatMode: "reverse_charge" as const,
    vatRate: null,
  },
];

describe("invoice customer presentation", () => {
  it("keeps each internal source exactly once by default", () => {
    const groups = createDefaultPresentationGroups(lines);

    expect(groups).toEqual([
      { description: "Práce technika", lineIndexes: [0] },
      { description: "Kabeláž", lineIndexes: [1] },
      { description: "Revize", lineIndexes: [2] },
    ]);
    expect(validatePresentationGroups(groups, lines)).toBeNull();
  });

  it("merges same-tax rows without losing their hidden source indexes", () => {
    const result = mergePresentationGroups(
      createDefaultPresentationGroups(lines),
      [0, 1],
      lines,
    );

    expect(result.error).toBeNull();
    expect(result.groups[0]).toEqual({
      description: "Práce technika",
      lineIndexes: [0, 1],
    });
    expect(validatePresentationGroups(result.groups, lines)).toBeNull();
  });

  it("rejects merging rows with different VAT treatment", () => {
    const original = createDefaultPresentationGroups(lines);
    const result = mergePresentationGroups(original, [0, 2], lines);

    expect(result.error).toContain("stejným režimem a sazbou DPH");
    expect(result.groups).toEqual(original);
  });

  it("splits a merged row back to source texts and supports reordering", () => {
    const merged = mergePresentationGroups(
      createDefaultPresentationGroups(lines),
      [0, 1],
      lines,
    ).groups;
    const split = splitPresentationGroup(merged, 0, lines);

    expect(split).toEqual(createDefaultPresentationGroups(lines));
    expect(
      movePresentationGroup(split, 2, 0).map((group) => group.lineIndexes),
    ).toEqual([[2], [0], [1]]);
  });

  it("falls back to one row per source when stored groups are incomplete", () => {
    expect(
      initializePresentationGroups(lines, [
        { description: "Jen část", lineIndexes: [0] },
      ]),
    ).toEqual(createDefaultPresentationGroups(lines));
  });
});
