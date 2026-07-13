export type MeasurementForSummary = {
  id: number;
  measurementType: string;
  subjectLabel: string | null;
  result: string;
  measuredAt: Date;
};

export function summarizeLatestMeasurements(rows: readonly MeasurementForSummary[]) {
  const latest = new Map<string, MeasurementForSummary>();
  for (const row of rows) {
    const key = `${row.measurementType}\u0000${row.subjectLabel?.trim().toLocaleLowerCase("cs") ?? ""}`;
    const previous = latest.get(key);
    if (!previous || row.measuredAt.getTime() > previous.measuredAt.getTime() || (row.measuredAt.getTime() === previous.measuredAt.getTime() && row.id > previous.id)) latest.set(key, row);
  }
  const current = [...latest.values()];
  return {
    current,
    totalSeries: current.length,
    failedSeries: current.filter((row) => row.result === "fail").length,
    passed: current.length > 0 && current.every((row) => row.result === "pass"),
  };
}

export function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function isPlausibleMeasurementTime(value: Date, now = new Date()): boolean {
  return Number.isFinite(value.getTime()) && value.getTime() <= now.getTime() + 5 * 60_000 && value.getTime() >= new Date("2000-01-01T00:00:00.000Z").getTime();
}
