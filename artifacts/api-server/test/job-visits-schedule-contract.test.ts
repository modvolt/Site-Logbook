import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("job visit schedule contract", () => {
  it("uses the shared projection for dashboard and calendar", () => {
    const dashboard = read("artifacts/api-server/src/routes/dashboard.ts");
    const jobs = read("artifacts/api-server/src/routes/jobs.ts");

    expect(dashboard).toContain("listJobScheduleOccurrences");
    expect(dashboard).toContain("listScheduledJobIds");
    expect(jobs).toContain("listJobScheduleOccurrences");
    expect(jobs).toContain("occurrenceKey: occurrence.occurrenceKey");
  });

  it("cancels a visit instead of deleting its historical row", () => {
    const route = read("artifacts/api-server/src/routes/visits.ts");

    expect(route).toContain('.set({ status: "cancelled", updatedAt: new Date() })');
    expect(route).not.toContain(".delete(jobVisitsTable)");
  });

  it("does not hard-code admin or master roles in the visit route", () => {
    const route = read("artifacts/api-server/src/routes/visits.ts");
    const detail = read("artifacts/stavba/src/pages/job-detail.tsx");
    const permissions = read("artifacts/api-server/src/middlewares/permissions.ts");

    expect(route).not.toContain("requireRole");
    expect(detail).toContain('can("jobs.manage")');
    expect(permissions).toContain('prefixes: ["/jobs", "/dashboard"');
    expect(permissions).toContain('manage: "jobs.manage"');
  });

  it("updates a visit occurrence separately during calendar drag and drop", () => {
    const calendar = read("artifacts/stavba/src/pages/calendar.tsx");

    expect(calendar).toContain("useUpdateJobVisit");
    expect(calendar).toContain("job.occurrenceKey");
    expect(calendar).toContain("if (job.visitId != null)");
  });

  it("keeps migration 0088 additive and blocks destructive rollback when visit times exist", () => {
    const up = read("lib/db/migrations/0088_abandoned_wendell_vaughn.sql").toLowerCase();
    const down = read("lib/db/rollbacks/0088_abandoned_wendell_vaughn.down.sql").toLowerCase();

    expect(up).toContain('alter table "job_visits" add column');
    expect(up).not.toMatch(/\b(update|delete from|drop table)\b/);
    expect(down).toContain("rollback 0088 blocked");
    expect(down).toContain('where "start_time" is not null or "end_time" is not null');
  });
});
