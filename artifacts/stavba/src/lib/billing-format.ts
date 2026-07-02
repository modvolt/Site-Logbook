import { format } from "date-fns";

/** Format a money amount as Czech koruna, e.g. `1 234,50 Kč`. */
export function fmtKc(n: number | null | undefined, decimals = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("cs-CZ", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} Kč`;
}

/** Format an ISO date string as `d.M.yyyy`, or `—` when missing. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return format(new Date(iso), "d.M.yyyy");
}

export const VAT_MODE_LABELS: Record<string, string> = {
  standard: "Standardní DPH",
  reverse_charge: "Přenesená daňová povinnost",
  zero: "Nulová sazba",
  non_vat: "Neplátce DPH",
};

export const VAT_RATE_OPTIONS = [
  { label: "21 %", vatMode: "standard" as const, vatRate: 21 },
  { label: "12 %", vatMode: "standard" as const, vatRate: 12 },
  { label: "PDP", vatMode: "reverse_charge" as const, vatRate: null },
] as const;

export const VAT_HEADER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "standard", label: "Standardní (DPH)" },
  { value: "reverse_charge", label: "PDP (přenesená daňová povinnost)" },
];

export function vatModeLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  return VAT_MODE_LABELS[mode] ?? mode;
}

/** Czech plural of "den" — 1 den, 2–4 dny, 5+ dní. */
export function dayNoun(days: number): string {
  const n = Math.abs(days);
  if (n === 1) return "den";
  if (n >= 2 && n <= 4) return "dny";
  return "dní";
}

/**
 * Whole calendar days an issued/sent invoice is past its due date.
 * Returns a positive number only when overdue, otherwise `null`.
 * Paid, cancelled and draft invoices are never overdue.
 */
export function overdueDays(
  dueDate: string | null | undefined,
  status: string,
): number | null {
  if (!dueDate) return null;
  if (status !== "issued" && status !== "sent") return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  due.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - due.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

/** Label such as "Po splatnosti 3 dny". */
export function overdueLabel(days: number): string {
  return `Po splatnosti ${days} ${dayNoun(days)}`;
}
