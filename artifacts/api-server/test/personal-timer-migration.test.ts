import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(resolve(process.cwd(), "../../lib/db/migrations/0084_shocking_martin_li.sql"), "utf8");

describe("personal timer compatibility migration", () => {
  it("adds a unique optional user-to-person link", () => {
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "person_id" integer');
    expect(sql).toContain('ON DELETE set null');
    expect(sql).toContain('CREATE UNIQUE INDEX "users_person_id_uq"');
    expect(sql).toContain('HAVING count(DISTINCT person_id) = 1');
  });

  it("imports only deterministically resolved legacy timers", () => {
    expect(sql).toContain("'legacy-job-timer-0084-' || ranked.job_id");
    expect(sql).toContain("'legacy-activity-timer-0084-' || ranked.activity_id");
    expect(sql).toContain('WHEN entries.person_count = 1 THEN entries.person_id');
    expect(sql).toContain('WHEN entries.person_count IS NULL AND assignees.person_count = 1 THEN assignees.person_id');
    expect(sql).toContain('WHERE job.timer_started_at IS NOT NULL');
    expect(sql).toContain('WHERE activity.timer_started_at IS NOT NULL');
    expect(sql).toContain('AND EXISTS (');
    expect(sql).toContain("event_type = 'legacy_imported'");
  });
});
