/**
 * Job-material pricing — the single deterministic rule for deciding which price
 * (and which source) wins for a job material when several signals are available.
 *
 * Pure & side-effect free: the service layer gathers the candidate prices (from
 * a confirmed-matched approved invoice, the warehouse purchase-price history, or
 * a manually entered price) and this picks one in a fixed priority order. It
 * never reads the DB, never writes stock, and never auto-confirms a match — it
 * only chooses among signals the caller already trusts.
 */

import { round2 } from "./invoice-calc";

/**
 * Where a job material's unit price came from.
 *  - `invoice`          — from a confirmed-matched approved invoice line (truth).
 *  - `stock_history`    — latest warehouse purchase price (EAN/SKU or name+supplier).
 *  - `manual`           — entered by hand in the app.
 *  - `delivery_note`    — price printed on a delivery note (provisional, pre-invoice).
 *  - `awaiting_invoice` — no trustworthy price yet; waiting for the invoice.
 */
export const MATERIAL_PRICE_SOURCES = [
  "invoice",
  "stock_history",
  "manual",
  "delivery_note",
  "awaiting_invoice",
] as const;

export type MaterialPriceSource = (typeof MATERIAL_PRICE_SOURCES)[number];

export interface ResolvedMaterialPrice {
  /** Chosen unit price, or null when nothing trustworthy is available. */
  pricePerUnit: number | null;
  source: MaterialPriceSource;
  /** 0..1 confidence in this price; null when there is no price. */
  confidence: number | null;
}

/**
 * Candidate prices for a single job material. All optional — pass whichever the
 * caller could resolve. A candidate with a null/absent `price` is treated as
 * "not available" and skipped.
 */
export interface JobMaterialPriceCandidates {
  /** Price from a confirmed-matched approved invoice line. Highest priority. */
  invoice?: { price: number | null; confidence?: number | null } | null;
  /** Warehouse purchase-price history matched by EAN or supplier SKU. */
  stockHistoryByCode?: { price: number | null } | null;
  /** Warehouse purchase-price history matched by name (+ supplier). */
  stockHistoryByName?: { price: number | null } | null;
  /** Price printed on a matched delivery note (provisional). */
  deliveryNote?: { price: number | null } | null;
  /** Existing manually-entered price on the material. */
  manual?: { price: number | null } | null;
}

function valid(price: number | null | undefined): price is number {
  return typeof price === "number" && Number.isFinite(price) && price >= 0;
}

/**
 * Resolve the winning price + source for a job material, in priority order:
 *   invoice → stock history (by code) → stock history (by name) → manual →
 *   delivery note → awaiting invoice.
 *
 * `invoice` wins even over `manual` because a confirmed invoice is the
 * authoritative cost; manual is only a stand-in until the invoice arrives.
 */
export function resolveJobMaterialPrice(
  candidates: JobMaterialPriceCandidates,
): ResolvedMaterialPrice {
  const inv = candidates.invoice;
  if (inv && valid(inv.price)) {
    const c = inv.confidence;
    return {
      pricePerUnit: round2(inv.price),
      source: "invoice",
      confidence: typeof c === "number" && Number.isFinite(c) ? c : 1,
    };
  }

  const byCode = candidates.stockHistoryByCode;
  if (byCode && valid(byCode.price)) {
    return { pricePerUnit: round2(byCode.price), source: "stock_history", confidence: 0.9 };
  }

  const byName = candidates.stockHistoryByName;
  if (byName && valid(byName.price)) {
    return { pricePerUnit: round2(byName.price), source: "stock_history", confidence: 0.6 };
  }

  const manual = candidates.manual;
  if (manual && valid(manual.price)) {
    return { pricePerUnit: round2(manual.price), source: "manual", confidence: 1 };
  }

  const dn = candidates.deliveryNote;
  if (dn && valid(dn.price)) {
    return { pricePerUnit: round2(dn.price), source: "delivery_note", confidence: 0.5 };
  }

  return { pricePerUnit: null, source: "awaiting_invoice", confidence: null };
}
