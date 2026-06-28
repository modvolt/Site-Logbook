import type { PpeItem, PpeAssignment } from "@workspace/api-client-react";

export const PPE_CATEGORY_LABELS: Record<string, string> = {
  hlava: "Hlava",
  ruky: "Ruce",
  telo: "Tělo",
  nohy: "Nohy",
  oci: "Oči",
  sluch: "Sluch",
  dychaci: "Dýchací cesty",
  ostatni: "Ostatní",
};

export const PPE_STATUS_LABELS: Record<string, string> = {
  issued: "Vydáno",
  returned: "Vráceno",
  damaged: "Poškozeno",
  lost: "Ztraceno",
  disposed: "Zlikvidováno",
};

export const PPE_STATUS_COLORS: Record<string, string> = {
  issued: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  returned: "bg-muted text-muted-foreground",
  damaged: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  lost: "bg-destructive/10 text-destructive",
  disposed: "bg-muted text-muted-foreground",
};

export type PpeOverdueState = "ok" | "overdue_replace" | "overdue_inspection" | "both";

function localDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getPpeOverdueState(assignment: Pick<PpeAssignment, "status" | "replaceBy" | "nextInspectionAt">): PpeOverdueState {
  if (assignment.status !== "issued") return "ok";
  const todayStr = localDateStr();
  const replaceOverdue = assignment.replaceBy != null && assignment.replaceBy <= todayStr;
  const inspectionOverdue = assignment.nextInspectionAt != null && assignment.nextInspectionAt <= todayStr;
  if (replaceOverdue && inspectionOverdue) return "both";
  if (replaceOverdue) return "overdue_replace";
  if (inspectionOverdue) return "overdue_inspection";
  return "ok";
}

export function isPpeOverdue(assignment: Pick<PpeAssignment, "status" | "replaceBy" | "nextInspectionAt">): boolean {
  return getPpeOverdueState(assignment) !== "ok";
}

/**
 * Given an issue date and catalog intervals (months), compute the default
 * replaceBy and nextInspectionAt dates.
 */
export function computeDefaultDates(
  issuedAt: string,
  item: Pick<PpeItem, "defaultReplacementMonths" | "defaultInspectionMonths">,
): { replaceBy: string | null; nextInspectionAt: string | null } {
  function addMonths(dateStr: string, months: number): string {
    const [yStr, mStr, dStr] = dateStr.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10) - 1; // 0-based
    const day = parseInt(dStr, 10);
    const totalMonths = y * 12 + m + months;
    const newY = Math.floor(totalMonths / 12);
    const newM = (totalMonths % 12) + 1; // 1-based
    // Clamp day to last day of target month (handles e.g. Jan 31 + 1 month → Feb 28)
    const maxDay = new Date(newY, newM, 0).getDate();
    const newD = Math.min(day, maxDay);
    return `${newY}-${String(newM).padStart(2, "0")}-${String(newD).padStart(2, "0")}`;
  }

  return {
    replaceBy: item.defaultReplacementMonths ? addMonths(issuedAt, item.defaultReplacementMonths) : null,
    nextInspectionAt: item.defaultInspectionMonths ? addMonths(issuedAt, item.defaultInspectionMonths) : null,
  };
}

export function formatPpeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
