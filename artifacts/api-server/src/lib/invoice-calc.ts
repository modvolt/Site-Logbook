/**
 * Pure money / VAT math for invoices. No DB access, no side effects — kept
 * separate so the arithmetic can be reasoned about (and unit-tested) on its own.
 *
 * Money is CZK with haléře (2 decimals). Arithmetic is performed as bigint
 * cents / basis points, never with binary floating-point multiplication. API
 * numbers are converted only at the boundary and DB values remain `numeric`.
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

function decimalString(value: unknown): string {
  if (value == null || value === "") return "0";
  const raw = String(value).trim();
  if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
    return "0";
  }
  if (!/[eE]/.test(raw)) return raw;

  const [coefficient, exponentRaw] = raw.toLowerCase().split("e");
  const exponent = Number(exponentRaw);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return "0";
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const point = whole.length + exponent;
  const plain =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${plain}` : plain;
}

/** Parse a decimal boundary value into a fixed-scale bigint, half-up. */
function scaledInteger(value: unknown, decimalPlaces: number): bigint {
  const raw = decimalString(value);
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [wholeRaw = "0", fractionRaw = ""] = unsigned.split(".");
  const whole = BigInt(wholeRaw || "0");
  const kept = fractionRaw.slice(0, decimalPlaces).padEnd(decimalPlaces, "0");
  let result = whole * 10n ** BigInt(decimalPlaces) + BigInt(kept || "0");
  if ((fractionRaw[decimalPlaces] ?? "0") >= "5") result += 1n;
  return negative ? -result : result;
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Denominator must be positive.");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}

export function round2(value: number): number {
  return centsToNumber(scaledInteger(value, 2));
}

/** Coerce a possibly-null Drizzle numeric (string) or number to a finite number. */
export function num(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface LineInputForCalc {
  rowType?: "item" | "section" | null;
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
export function resolveVatRate(
  mode: VatMode,
  rate: number | null | undefined,
): number | null {
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
  if (input.rowType === "section") {
    return {
      quantity: 0,
      unitPriceWithoutVat: 0,
      discountPercent: null,
      vatMode: input.vatMode ?? invoiceVatMode,
      vatRate: null,
      totalWithoutVat: 0,
      totalVat: 0,
      totalWithVat: 0,
    };
  }
  const quantity = round2(num(input.quantity ?? 1));
  const unitPrice = round2(num(input.unitPriceWithoutVat ?? 0));
  const discountPercent =
    input.discountPercent == null ? null : round2(num(input.discountPercent));
  const vatMode: VatMode = input.vatMode ?? invoiceVatMode;
  const vatRate = resolveVatRate(vatMode, input.vatRate);

  const quantityHundredths = scaledInteger(quantity, 2);
  const unitPriceCents = scaledInteger(unitPrice, 2);
  const grossCents = divideHalfUp(quantityHundredths * unitPriceCents, 100n);
  const discountBasisPoints = scaledInteger(discountPercent ?? 0, 2);
  const discountCents = discountPercent
    ? divideHalfUp(grossCents * discountBasisPoints, 10_000n)
    : 0n;
  const totalWithoutVatCents = grossCents - discountCents;
  const vatBasisPoints = scaledInteger(vatRate ?? 0, 2);
  const totalVatCents =
    vatMode === "standard" && vatRate
      ? divideHalfUp(totalWithoutVatCents * vatBasisPoints, 10_000n)
      : 0n;
  const totalWithoutVat = centsToNumber(totalWithoutVatCents);
  const totalVat = centsToNumber(totalVatCents);
  const totalWithVat = centsToNumber(totalWithoutVatCents + totalVatCents);

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
export function applyMaterialMarkup(
  unitPrice: number,
  markupPercent: number,
): number {
  const priceCents = scaledInteger(unitPrice, 2);
  const markupBasisPoints = scaledInteger(
    markupPercent > 0 ? markupPercent : 0,
    2,
  );
  return centsToNumber(
    divideHalfUp(priceCents * (10_000n + markupBasisPoints), 10_000n),
  );
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
  const subtotalCents = lines.reduce(
    (acc, line) => acc + scaledInteger(line.totalWithoutVat, 2),
    0n,
  );
  const vatCents = lines.reduce(
    (acc, line) => acc + scaledInteger(line.totalVat, 2),
    0n,
  );
  const subtotalWithoutVat = centsToNumber(subtotalCents);
  const totalVat = centsToNumber(vatCents);
  const totalWithVat = centsToNumber(subtotalCents + vatCents);
  return { subtotalWithoutVat, totalVat, totalWithVat };
}

/** Group VAT by rate (for the PDF recapitulation). Skips non-standard lines. */
export function vatBreakdown(
  lines: ReadonlyArray<ComputedLine>,
): Array<{ rate: number; base: number; vat: number }> {
  const byRate = new Map<number, { base: bigint; vat: bigint }>();
  for (const l of lines) {
    if (l.vatMode !== "standard") continue;
    const rate = l.vatRate ?? 0;
    const entry = byRate.get(rate) ?? { base: 0n, vat: 0n };
    entry.base += scaledInteger(l.totalWithoutVat, 2);
    entry.vat += scaledInteger(l.totalVat, 2);
    byRate.set(rate, entry);
  }
  return Array.from(byRate.entries())
    .map(([rate, v]) => ({
      rate,
      base: centsToNumber(v.base),
      vat: centsToNumber(v.vat),
    }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Legacy line-to-parent projection retained for compatibility and pure math
 * tests. The invoice service no longer derives operational settlement from
 * editable commercial lines; `invoice_source_allocations` is authoritative.
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
 * Legacy mixed-parent projection. It is not used to settle or release raw
 * sources after draft edits; the allocation ledger preserves those sources
 * independently of customer-facing rows.
 *
 * `lines[i]` and `computed[i]` must be index-aligned (same order as persisted).
 */
export function deriveSourceLinks(
  lines: ReadonlyArray<{ jobId?: number | null; activityId?: number | null }>,
  computed: ReadonlyArray<Pick<ComputedLine, "totalWithoutVat">>,
): Array<{
  jobId: number | null;
  activityId: number | null;
  amountWithoutVat: number;
}> {
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
