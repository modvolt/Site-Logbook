import { describe, expect, it } from "vitest";
import { projectJobSchedule, type BaseJobScheduleInput, type VisitJobScheduleInput } from "../src/lib/job-schedule-policy";

const baseJob: BaseJobScheduleInput = {
  jobId: 40,
  date: "2026-07-14",
  personId: 3,
  startTime: "08:00",
  endTime: "12:00",
};

function visit(overrides: Partial<VisitJobScheduleInput> = {}): VisitJobScheduleInput {
  return {
    visitId: 10,
    jobId: 40,
    date: "2026-07-15",
    personId: 3,
    startTime: null,
    endTime: null,
    fallbackStartTime: "08:00",
    fallbackEndTime: "12:00",
    status: "planned",
    note: null,
    ...overrides,
  };
}

describe("job schedule projection", () => {
  it("keeps the original job date as its first occurrence", () => {
    expect(projectJobSchedule([baseJob], [])).toEqual([
      expect.objectContaining({ occurrenceKey: "job:40", date: "2026-07-14" }),
    ]);
  });

  it("adds another workday without replacing the original job date", () => {
    const result = projectJobSchedule([baseJob], [visit()]);

    expect(result.map((row) => [row.occurrenceKey, row.date])).toEqual([
      ["job:40", "2026-07-14"],
      ["visit:10", "2026-07-15"],
    ]);
  });

  it("uses visit-specific times and otherwise falls back to the job times", () => {
    const result = projectJobSchedule([baseJob], [
      visit(),
      visit({ visitId: 11, date: "2026-07-16", startTime: "13:00", endTime: "17:30" }),
    ]);

    expect(result.find((row) => row.visitId === 10)).toMatchObject({ startTime: "08:00", endTime: "12:00" });
    expect(result.find((row) => row.visitId === 11)).toMatchObject({ startTime: "13:00", endTime: "17:30" });
  });

  it("does not project cancelled visits", () => {
    const result = projectJobSchedule([baseJob], [visit({ status: "cancelled" })]);

    expect(result.map((row) => row.occurrenceKey)).toEqual(["job:40"]);
  });

  it("lets an explicit visit replace the implicit occurrence in the same slot", () => {
    const result = projectJobSchedule([baseJob], [visit({ date: baseJob.date })]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ occurrenceKey: "visit:10", occurrenceType: "visit" });
  });

  it("projects only the oldest of identical legacy visits without deleting history", () => {
    const result = projectJobSchedule([], [visit({ visitId: 12 }), visit({ visitId: 10 }), visit({ visitId: 11 })]);

    expect(result).toHaveLength(1);
    expect(result[0].visitId).toBe(10);
  });
});
