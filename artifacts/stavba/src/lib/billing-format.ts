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

export function vatModeLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  return VAT_MODE_LABELS[mode] ?? mode;
}
