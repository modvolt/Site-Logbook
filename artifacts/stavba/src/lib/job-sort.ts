type SortableJob = {
  date: string;
  status: string;
  startTime?: string | null;
};

export function isJobFinished(status: string): boolean {
  return status === "done" || status === "cancelled";
}

export function sortJobsDoneLast<T extends SortableJob>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const aDone = isJobFinished(a.status) ? 1 : 0;
    const bDone = isJobFinished(b.status) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}
