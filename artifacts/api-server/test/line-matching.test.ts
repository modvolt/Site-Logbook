import { describe, it, expect } from "vitest";
import { scoreLineMatch, type MatchableLine } from "../src/lib/document-matching";

/**
 * Tests for scoreLineMatch — the deterministic item-line scorer used to link an
 * invoice line back to a job material / warehouse item. Priority is
 * EAN → supplier SKU → exact name (+quantity) → partial name. A name-only match
 * must never reach the "strong" band (it must not auto-confirm a price link).
 */

describe("scoreLineMatch", () => {
  it("scores a matching EAN as a perfect strong match", () => {
    const a: MatchableLine = { ean: "8590370812345", description: "Kabel CYKY" };
    const b: MatchableLine = { ean: "859 0370-812345", description: "úplně jiný popis" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBe(1);
    expect(r.strength).toBe("strong");
    expect(r.reasons).toContain("Shodný EAN");
  });

  it("ignores too-short / empty EANs and falls through", () => {
    const a: MatchableLine = { ean: "123", description: "Šroub vrut 4x40" };
    const b: MatchableLine = { ean: "", description: "Šroub vrut 4x40" };
    const r = scoreLineMatch(a, b);
    // Falls through to exact-name match, not EAN.
    expect(r.reasons).not.toContain("Shodný EAN");
    expect(r.reasons).toContain("Shodný název položky");
  });

  it("scores a matching supplier SKU strongly", () => {
    const a: MatchableLine = { supplierSku: "ABC-100", description: "Hmoždinka" };
    const b: MatchableLine = { supplierSku: "abc100", description: "něco jiného" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBe(0.9);
    expect(r.strength).toBe("strong");
    expect(r.reasons).toContain("Shodný kód dodavatele");
  });

  it("prefers EAN over SKU when both match", () => {
    const a: MatchableLine = { ean: "8590370812345", supplierSku: "X" };
    const b: MatchableLine = { ean: "8590370812345", supplierSku: "X" };
    expect(scoreLineMatch(a, b).reasons).toEqual(["Shodný EAN"]);
  });

  it("scores an exact normalized name (diacritics/case-insensitive) at 0.6", () => {
    const a: MatchableLine = { description: "Šroub Vrut 4x40" };
    const b: MatchableLine = { description: "sroub vrut 4x40" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBe(0.6);
    expect(r.reasons).toContain("Shodný název položky");
  });

  it("bumps an exact name match to 0.8 when quantities also line up", () => {
    const a: MatchableLine = { description: "Kabel CYKY 3x1.5", quantity: 100 };
    const b: MatchableLine = { description: "kabel cyky 3x1.5", quantity: 100 };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBe(0.8);
    expect(r.reasons).toContain("Souhlasí množství");
  });

  it("keeps a partial name overlap weak and below the strong band", () => {
    const a: MatchableLine = { description: "Kabel CYKY 3x1.5 měděný" };
    const b: MatchableLine = { description: "Kabel CYKY 5x2.5 hliníkový" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(0.8);
    expect(r.strength).not.toBe("strong");
    expect(r.reasons).toContain("Podobný název položky");
  });

  it("returns a zero/none match for unrelated lines", () => {
    const a: MatchableLine = { description: "Cement Portland 25kg" };
    const b: MatchableLine = { description: "Zásuvka dvojitá bílá" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBe(0);
    expect(r.strength).toBe("none");
  });

  it("uses pre-normalized name when provided", () => {
    const a: MatchableLine = { normalizedName: "kabel cyky 3x1 5" };
    const b: MatchableLine = { description: "Kabel CYKY 3x1.5" };
    const r = scoreLineMatch(a, b);
    expect(r.score).toBeGreaterThanOrEqual(0.6);
  });
});
