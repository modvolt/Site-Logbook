import { and, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { db, jobsTable, jobVisitsTable } from "@workspace/db";
import { projectJobSchedule } from "./job-schedule-policy";

export async function listJobScheduleOccurrences(from: string, to: string) {
  const [baseRows, visitRows] = await Promise.all([
    db
      .select({
        jobId: jobsTable.id,
        date: jobsTable.date,
        personId: jobsTable.assignedPersonId,
        startTime: jobsTable.startTime,
        endTime: jobsTable.endTime,
      })
      .from(jobsTable)
      .where(and(isNull(jobsTable.archivedAt), gte(jobsTable.date, from), lte(jobsTable.date, to))),
    db
      .select({
        visitId: jobVisitsTable.id,
        jobId: jobVisitsTable.jobId,
        date: jobVisitsTable.date,
        personId: jobVisitsTable.personId,
        startTime: jobVisitsTable.startTime,
        endTime: jobVisitsTable.endTime,
        fallbackStartTime: jobsTable.startTime,
        fallbackEndTime: jobsTable.endTime,
        status: jobVisitsTable.status,
        note: jobVisitsTable.note,
      })
      .from(jobVisitsTable)
      .innerJoin(jobsTable, eq(jobVisitsTable.jobId, jobsTable.id))
      .where(and(
        isNull(jobsTable.archivedAt),
        ne(jobVisitsTable.status, "cancelled"),
        gte(jobVisitsTable.date, from),
        lte(jobVisitsTable.date, to),
      )),
  ]);

  return projectJobSchedule(baseRows, visitRows);
}

export async function listScheduledJobIds(from: string, to: string): Promise<number[]> {
  const occurrences = await listJobScheduleOccurrences(from, to);
  return Array.from(new Set(occurrences.map((occurrence) => occurrence.jobId)));
}
