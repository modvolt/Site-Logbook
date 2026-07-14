export interface BaseJobScheduleInput {
  jobId: number;
  date: string;
  personId: number | null;
  startTime: string | null;
  endTime: string | null;
}

export interface VisitJobScheduleInput {
  visitId: number;
  jobId: number;
  date: string;
  personId: number | null;
  startTime: string | null;
  endTime: string | null;
  fallbackStartTime: string | null;
  fallbackEndTime: string | null;
  status: string;
  note: string | null;
}

export interface JobScheduleOccurrence {
  occurrenceKey: string;
  occurrenceType: "job" | "visit";
  visitId: number | null;
  jobId: number;
  date: string;
  personId: number | null;
  startTime: string | null;
  endTime: string | null;
  visitStatus: string | null;
  visitNote: string | null;
}

function slotKey(occurrence: Pick<JobScheduleOccurrence, "jobId" | "date" | "personId" | "startTime" | "endTime">) {
  return [
    occurrence.jobId,
    occurrence.date,
    occurrence.personId ?? "none",
    occurrence.startTime ?? "none",
    occurrence.endTime ?? "none",
  ].join(":");
}

export function projectJobSchedule(
  baseJobs: BaseJobScheduleInput[],
  visits: VisitJobScheduleInput[],
): JobScheduleOccurrence[] {
  const projectedVisits: JobScheduleOccurrence[] = visits
    .filter((visit) => visit.status !== "cancelled")
    .map((visit) => ({
      occurrenceKey: `visit:${visit.visitId}`,
      occurrenceType: "visit",
      visitId: visit.visitId,
      jobId: visit.jobId,
      date: visit.date,
      personId: visit.personId,
      startTime: visit.startTime ?? visit.fallbackStartTime,
      endTime: visit.endTime ?? visit.fallbackEndTime,
      visitStatus: visit.status,
      visitNote: visit.note,
    }));

  // Legacy data can contain repeated visits. Keep the oldest occurrence in
  // the projection without deleting any historical row.
  const uniqueVisits = new Map<string, JobScheduleOccurrence>();
  for (const visit of projectedVisits.sort((a, b) => (a.visitId ?? 0) - (b.visitId ?? 0))) {
    const key = slotKey(visit);
    if (!uniqueVisits.has(key)) uniqueVisits.set(key, visit);
  }

  const occupiedSlots = new Set(uniqueVisits.keys());
  const baseOccurrences: JobScheduleOccurrence[] = baseJobs
    .map((job) => ({
      occurrenceKey: `job:${job.jobId}`,
      occurrenceType: "job" as const,
      visitId: null,
      jobId: job.jobId,
      date: job.date,
      personId: job.personId,
      startTime: job.startTime,
      endTime: job.endTime,
      visitStatus: null,
      visitNote: null,
    }))
    .filter((occurrence) => !occupiedSlots.has(slotKey(occurrence)));

  return [...baseOccurrences, ...uniqueVisits.values()].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99") ||
    a.jobId - b.jobId ||
    a.occurrenceKey.localeCompare(b.occurrenceKey),
  );
}
