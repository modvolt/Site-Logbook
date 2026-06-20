import { describe, it, expect } from "vitest";
import { computeLine, deriveJobSourceLinks } from "../src/lib/invoice-calc";

/**
 * Regression for the "deleting all of a job's lines still bills the job" bug.
 *
 * Source links (which jobs an invoice bills) are recomputed from the surviving
 * lines on every draft edit. A job is billed only when it still has at least
 * one line carrying its `jobId`.
 */
describe("deriveJobSourceLinks", () => {
  const compute = (lines: { jobId?: number | null; price: number; qty?: number }[]) => {
    const raw = lines.map((l) => ({ jobId: l.jobId ?? null }));
    const computed = lines.map((l) =>
      computeLine(
        { quantity: l.qty ?? 1, unitPriceWithoutVat: l.price, vatMode: "non_vat" },
        "non_vat",
      ),
    );
    return deriveJobSourceLinks(raw, computed);
  };

  it("links each job that has at least one line, summing its amounts", () => {
    const links = compute([
      { jobId: 1, price: 1000 },
      { jobId: 1, price: 250 },
      { jobId: 2, price: 500 },
    ]);
    expect(links).toEqual([
      { jobId: 1, amountWithoutVat: 1250 },
      { jobId: 2, amountWithoutVat: 500 },
    ]);
  });

  it("drops a job's link when every line of that job is removed", () => {
    // Job 2's lines were deleted in the edit UI — only job 1 remains.
    const links = compute([{ jobId: 1, price: 1000 }]);
    expect(links).toEqual([{ jobId: 1, amountWithoutVat: 1000 }]);
    expect(links.some((l) => l.jobId === 2)).toBe(false);
  });

  it("ignores manual lines that carry no jobId", () => {
    const links = compute([
      { jobId: null, price: 9999 },
      { jobId: 1, price: 100 },
    ]);
    expect(links).toEqual([{ jobId: 1, amountWithoutVat: 100 }]);
  });

  it("produces no links when all lines are manual (no job billed)", () => {
    const links = compute([
      { jobId: null, price: 100 },
      { jobId: null, price: 200 },
    ]);
    expect(links).toEqual([]);
  });

  it("rounds summed amounts to 2 decimals", () => {
    const links = compute([
      { jobId: 7, price: 0.1, qty: 1 },
      { jobId: 7, price: 0.2, qty: 1 },
    ]);
    expect(links).toEqual([{ jobId: 7, amountWithoutVat: 0.3 }]);
  });
});
