/**
 * Pure money / VAT math for invoices. No DB access, no side effects — kept
 * separate so the arithmetic can be reasoned about (and unit-tested) on its own.
 *
 * Money is CZK with haléře (2 decimals). All amounts are rounded to 2 decimals
 * using round-half-up with an epsilon nudge to avoid binary-float artefacts
 * (e.g. 1.005 → 1.01, not 1.00).
 */

export type VatMode = "standard" | "reverse_charge" | "zero" | "non_vat";

export const VAT_MODES: ReadonlyArray<VatMode> = [
  "standard",
  "reverse_charge",
  "zero",
  "non_vat",
];

/** Default Czech standard VAT rate (%) applied when a standard line omits one. */
export const DEFAULT_VAT_RATE = 21;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Coerce a possibly-null Drizzle numeric (string) or number to a finite number. */
export function num(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface LineInputForCalc {
  quantity?: number | null;
  unitPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  vatRate?: number | null;
  vatMode?: VatMode | null;
}

export interface ComputedLine {
  quantity: number;
  unitPriceWithoutVat: number;
  discountPercent: number | null;
  vatMode: VatMode;
  vatRate: number | null;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

/**
 * Resolve the effective VAT rate for a line given its mode. Only `standard`
 * lines carry VAT; reverse_charge (PDP), zero-rated and non-VAT lines never do.
 */
export function resolveVatRate(mode: VatMode, rate: number | null | undefined): number | null {
  switch (mode) {
    case "standard":
      return rate == null ? DEFAULT_VAT_RATE : num(rate);
    case "zero":
      return 0;
    case "reverse_charge":
    case "non_vat":
      return null;
  }
}

/** Compute the denormalized totals for a single invoice line. */
export function computeLine(
  input: LineInputForCalc,
  invoiceVatMode: VatMode,
): ComputedLine {
  const quantity = round2(num(input.quantity ?? 1));
  const unitPrice = round2(num(input.unitPriceWithoutVat ?? 0));
  const discountPercent =
    input.discountPercent == null ? null : round2(num(input.discountPercent));
  const vatMode: VatMode = input.vatMode ?? invoiceVatMode;
  const vatRate = resolveVatRate(vatMode, input.vatRate);

  const gross = quantity * unitPrice;
  const discounted = discountPercent ? gross * (1 - discountPercent / 100) : gross;
  const totalWithoutVat = round2(discounted);
  const totalVat =
    vatMode === "standard" && vatRate ? round2((totalWithoutVat * vatRate) / 100) : 0;
  const totalWithVat = round2(totalWithoutVat + totalVat);

  return {
    quantity,
    unitPriceWithoutVat: unitPrice,
    discountPercent,
    vatMode,
    vatRate,
    totalWithoutVat,
    totalVat,
    totalWithVat,
  };
}

/**
 * Resolve the effective material markup percent for an invoice. An explicit
 * per-invoice value (when provided) wins over the saved settings default;
 * negative or non-finite values collapse to 0 (no markup). `0` provided
 * explicitly stays `0` (the user opted out of the saved default).
 */
export function resolveMaterialMarkup(
  explicit: number | null | undefined,
  fallback: number | string | null | undefined,
): number {
  const raw = explicit ?? num(fallback);
  return Number.isFinite(raw) && raw > 0 ? round2(raw) : 0;
}

/**
 * Resolve the effective material markup for a single material line, walking the
 * priority chain: per-line override → category default → fallback (the already
 * resolved invoice/settings default). Each layer is "set" only when it is a
 * finite, non-negative number; anything else (null/undefined/NaN/negative) is
 * treated as "not set" and resolution falls through to the next layer.
 *
 * A per-line override (or category default) of exactly `0` is a deliberate
 * opt-out and wins — that line gets no markup even when a default exists.
 */
export function resolveLineMaterialMarkup(
  override: number | null | undefined,
  categoryMarkup: number | null | undefined,
  fallback: number,
): number {
  const isSet = (v: number | null | undefined): v is number =>
    v != null && Number.isFinite(v) && v >= 0;
  if (isSet(override)) return round2(override);
  if (isSet(categoryMarkup)) return round2(categoryMarkup);
  return isSet(fallback) ? round2(fallback) : 0;
}

/**
 * Apply a percent markup to a material unit price. A markup of 0 (or less)
 * leaves the price unchanged. Result is rounded to 2 decimals.
 */
export function applyMaterialMarkup(unitPrice: number, markupPercent: number): number {
  const factor = markupPercent > 0 ? 1 + markupPercent / 100 : 1;
  return round2(num(unitPrice) * factor);
}

export interface InvoiceTotals {
  subtotalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

/** Sum already-computed line totals into invoice-level totals. */
export function sumTotals(
  lines: ReadonlyArray<Pick<ComputedLine, "totalWithoutVat" | "totalVat">>,
): InvoiceTotals {
  const subtotalWithoutVat = round2(
    lines.reduce((acc, l) => acc + num(l.totalWithoutVat), 0),
  );
  const totalVat = round2(lines.reduce((acc, l) => acc + num(l.totalVat), 0));
  const totalWithVat = round2(subtotalWithoutVat + totalVat);
  return { subtotalWithoutVat, totalVat, totalWithVat };
}

/** Group VAT by rate (for the PDF recapitulation). Skips non-standard lines. */
export function vatBreakdown(
  lines: ReadonlyArray<ComputedLine>,
): Array<{ rate: number; base: number; vat: number }> {
  const byRate = new Map<number, { base: number; vat: number }>();
  for (const l of lines) {
    if (l.vatMode !== "standard") continue;
    const rate = l.vatRate ?? 0;
    const entry = byRate.get(rate) ?? { base: 0, vat: 0 };
    entry.base += l.totalWithoutVat;
    entry.vat += l.totalVat;
    byRate.set(rate, entry);
  }
  return Array.from(byRate.entries())
    .map(([rate, v]) => ({ rate, base: round2(v.base), vat: round2(v.vat) }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Derive invoice→job source links from the current set of lines. A job is only
 * billed (flipped to "vyfakturováno" on issue) when it still has at least one
 * line on the invoice. Deleting every line of a job in the edit UI therefore
 * drops its source link, so the job returns to the unbilled pool instead of
 * being silently marked as invoiced with nothing on the invoice for it.
 *
 * `lines[i]` and `computed[i]` must be index-aligned (same order as persisted).
 * The returned amount is the sum of each job's line `totalWithoutVat`.
 */
export function deriveJobSourceLinks(
  lines: ReadonlyArray<{ jobId?: number | null }>,
  computed: ReadonlyArray<Pick<ComputedLine, "totalWithoutVat">>,
): Array<{ jobId: number; amountWithoutVat: number }> {
  const jobAmounts = new Map<number, number>();
  lines.forEach((line, i) => {
    if (line.jobId == null) return;
    const prev = jobAmounts.get(line.jobId) ?? 0;
    jobAmounts.set(line.jobId, prev + num(computed[i]?.totalWithoutVat));
  });
  return Array.from(jobAmounts.entries()).map(([jobId, amount]) => ({
    jobId,
    amountWithoutVat: round2(amount),
  }));
}

/**
 * Derive invoice source links from the current set of lines, supporting BOTH
 * job-billed and activity-billed (dlouhodobá akce) lines. A job or activity is
 * billed only while it still has at least one line carrying its id, so deleting
 * every line of a job/activity in the edit UI drops its source link and returns
 * it to the unbilled pool. A line that carries a `jobId` is grouped as a job
 * link; otherwise an `activityId` groups it as an activity link.
 *
 * `lines[i]` and `computed[i]` must be index-aligned (same order as persisted).
 */
export function deriveSourceLinks(
  lines: ReadonlyArray<{ jobId?: number | null; activityId?: number | null }>,
  computed: ReadonlyArray<Pick<ComputedLine, "totalWithoutVat">>,
): Array<{ jobId: number | null; activityId: number | null; amountWithoutVat: number }> {
  const jobAmounts = new Map<number, number>();
  const activityAmounts = new Map<number, number>();
  lines.forEach((line, i) => {
    const amount = num(computed[i]?.totalWithoutVat);
    if (line.jobId != null) {
      jobAmounts.set(line.jobId, (jobAmounts.get(line.jobId) ?? 0) + amount);
    } else if (line.activityId != null) {
      activityAmounts.set(
        line.activityId,
        (activityAmounts.get(line.activityId) ?? 0) + amount,
      );
    }
  });
  return [
    ...Array.from(jobAmounts.entries()).map(([jobId, amount]) => ({
      jobId,
      activityId: null,
      amountWithoutVat: round2(amount),
    })),
    ...Array.from(activityAmounts.entries()).map(([activityId, amount]) => ({
      jobId: null,
      activityId,
      amountWithoutVat: round2(amount),
    })),
  ];
}

/** Czech money formatting: "12 500,00 Kč" (NBSP thousands, comma decimal). */
export function formatCzk(value: number, currency = "CZK"): string {
  const n = round2(num(value));
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
  const suffix = currency === "CZK" ? "\u00A0Kč" : `\u00A0${currency}`;
  return `${neg ? "-" : ""}${withThousands},${decPart}${suffix}`;
}
