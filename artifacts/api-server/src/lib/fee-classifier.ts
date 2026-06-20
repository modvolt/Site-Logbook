/**
 * Fee classifier + unit normalizer — pure helpers that turn the messy line
 * items of a Czech supplier document into structured data we can reason about.
 *
 * Three concerns, all AI-free and deterministic:
 *   1. classifyFee()       — is a line a real product or a fee/discount, and of
 *                            what kind (recycling, transport, packaging, …)?
 *   2. normalizeUnit()     — map Czech unit spellings to a canonical unit.
 *   3. parsePricePer()     — detect "per 100" style pricing (Kč/100 m).
 *   4. computeDiscountPercent() — derive a discount % from list vs. final price.
 */

import { round2 } from "./invoice-calc";

export type FeeType =
  | "recycling"
  | "environmental"
  | "transport"
  | "packaging"
  | "handling"
  | "rounding"
  | "discount"
  | "deposit"
  | "other";

export interface FeeClassification {
  /** null when the line is an ordinary product (not a fee/discount). */
  feeType: FeeType | null;
  /** true for recycling/environmental fees (PHE etc.) — drives schema flag. */
  isEnvironmentalFee: boolean;
}

const FEE_KEYWORDS: { type: FeeType; patterns: RegExp[] }[] = [
  {
    type: "recycling",
    patterns: [
      /recykl/i,
      /\bPHE\b/i,
      /historick[ýy]\s*elektro/i,
      /elektroodpad/i,
      /zp[ěe]tn[ýy]\s*odb[ěe]r/i,
    ],
  },
  {
    type: "environmental",
    patterns: [/ekolog/i, /životn[íi]\s*prostřed/i, /likvidac/i],
  },
  {
    type: "transport",
    patterns: [/doprav/i, /přeprav/i, /dovoz/i, /expedic/i, /poštovn/i],
  },
  {
    type: "packaging",
    patterns: [/baln[ée]/i, /\bobal/i, /paleta/i, /palet[ay]/i],
  },
  { type: "handling", patterns: [/manipulač/i, /manipulac/i] },
  { type: "rounding", patterns: [/zaokrouhl/i] },
  {
    type: "discount",
    patterns: [/\bsleva\b/i, /\brabat\b/i, /\bbonus\b/i, /\bskonto\b/i, /\bsleva /i],
  },
  { type: "deposit", patterns: [/z[áa]loh/i, /vratn[ýáa]/i, /\bkauce\b/i] },
];

/**
 * Classify a line description as a fee/discount or an ordinary product.
 * Returns `{ feeType: null }` for ordinary products.
 */
export function classifyFee(description: string | null | undefined): FeeClassification {
  if (!description) return { feeType: null, isEnvironmentalFee: false };
  for (const group of FEE_KEYWORDS) {
    if (group.patterns.some((re) => re.test(description))) {
      return {
        feeType: group.type,
        isEnvironmentalFee:
          group.type === "recycling" || group.type === "environmental",
      };
    }
  }
  return { feeType: null, isEnvironmentalFee: false };
}

/**
 * Canonical units. Keys are normalized (lowercased, punctuation-stripped)
 * spellings seen on Czech invoices; values are the canonical unit we store.
 */
const UNIT_MAP: Record<string, string> = {
  ks: "ks",
  kus: "ks",
  kusu: "ks",
  kusy: "ks",
  pcs: "ks",
  pc: "ks",
  m: "m",
  bm: "m",
  bbm: "m",
  beznymetr: "m",
  beznychmetru: "m",
  mb: "m",
  m2: "m2",
  "m²": "m2",
  m3: "m3",
  "m³": "m3",
  kg: "kg",
  g: "g",
  t: "t",
  tuna: "t",
  l: "l",
  ltr: "l",
  litr: "l",
  ml: "ml",
  bal: "bal",
  baleni: "bal",
  balik: "bal",
  sada: "sada",
  sad: "sada",
  set: "sada",
  par: "par",
  paru: "par",
  hod: "hod",
  hodina: "hod",
  hodin: "hod",
  soubor: "soubor",
  role: "role",
  rol: "role",
  cm: "cm",
  mm: "mm",
};

/**
 * Normalize a unit string to a canonical form. Unknown units are returned
 * lowercased + trimmed (never dropped) so nothing is silently lost.
 */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const trimmed = unit.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase().replace(/[\s.]/g, "");
  return UNIT_MAP[key] ?? trimmed.toLowerCase();
}

export interface PricePer {
  /** Base quantity the unit price refers to (1 unless "per 100" etc.). */
  baseQuantity: number;
  /** Canonical base unit, when one is present in the text. */
  baseUnit: string | null;
}

/**
 * Detect "per N <unit>" pricing such as `Kč/100 m`, `za 100 ks`, `/bal`.
 * Returns `{ baseQuantity: 1 }` when no multiplier is present.
 */
export function parsePricePer(text: string | null | undefined): PricePer {
  if (!text) return { baseQuantity: 1, baseUnit: null };
  // e.g. "123 Kč / 100 m", "cena za 100 ks", "/ 1000 m"
  const m = text.match(
    /(?:\/|za|per)\s*(\d{1,6})\s*([A-Za-zÀ-ž²³]{1,6})?/i,
  );
  if (m) {
    const qty = Number(m[1]);
    if (Number.isFinite(qty) && qty > 0) {
      return { baseQuantity: qty, baseUnit: normalizeUnit(m[2] ?? null) };
    }
  }
  // "/ m" with no number → base quantity 1, unit captured
  const u = text.match(/\/\s*([A-Za-zÀ-ž²³]{1,6})/);
  if (u) return { baseQuantity: 1, baseUnit: normalizeUnit(u[1]) };
  return { baseQuantity: 1, baseUnit: null };
}

/**
 * Compute a discount percentage from a list price and a final (after-discount)
 * price. Returns null when inputs are missing/zero or the result is negative.
 */
export function computeDiscountPercent(
  listPrice: number | null | undefined,
  finalPrice: number | null | undefined,
): number | null {
  if (listPrice == null || finalPrice == null) return null;
  if (!Number.isFinite(listPrice) || !Number.isFinite(finalPrice)) return null;
  if (listPrice <= 0) return null;
  const pct = ((listPrice - finalPrice) / listPrice) * 100;
  if (pct < 0) return null;
  return round2(pct);
}
