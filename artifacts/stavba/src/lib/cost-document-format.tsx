/** Czech labels + badge styling shared by the cost-document pages. */

export const COST_DOC_STATUS_LABELS: Record<string, string> = {
  uploaded: "Nahráno",
  needs_review: "Ke kontrole",
  reviewed: "Zkontrolováno",
  approved: "Schváleno",
  ignored: "Ignorováno",
  duplicate: "Duplicita",
};

const COST_DOC_STATUS_CLASSES: Record<string, string> = {
  uploaded:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  needs_review:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  reviewed:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  approved:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  ignored:
    "bg-muted text-muted-foreground",
  duplicate:
    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

export const COST_DOC_TYPE_LABELS: Record<string, string> = {
  receipt: "Účtenka",
  delivery_note: "Dodací list",
  invoice: "Přijatá faktura",
  credit_note: "Dobropis",
};

export const COST_DOC_LINE_TYPE_LABELS: Record<string, string> = {
  material: "Materiál",
  work: "Práce",
  transport: "Doprava",
  other: "Ostatní",
};

export const COST_DOC_ALLOCATION_LABELS: Record<string, string> = {
  rebill: "Přefakturovat",
  internal: "Interní náklad",
  stock: "Na sklad",
  not_rebilled: "Nepřefakturovat",
};

export function CostDocStatusBadge({ status }: { status: string }) {
  const cls =
    COST_DOC_STATUS_CLASSES[status] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {COST_DOC_STATUS_LABELS[status] ?? status}
    </span>
  );
}
