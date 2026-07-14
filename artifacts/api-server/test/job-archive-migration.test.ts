import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ListJobsQueryParams } from "@workspace/api-zod";

const migrationSql = readFileSync(
  resolve(process.cwd(), "../../lib/db/migrations/0086_quick_imperial_guard.sql"),
  "utf8",
);
const rollbackSql = readFileSync(
  resolve(process.cwd(), "../../lib/db/rollbacks/0086_quick_imperial_guard.down.sql"),
  "utf8",
);
const jobsRoute = readFileSync(resolve(process.cwd(), "src/routes/jobs.ts"), "utf8");

describe("job archive migration contract", () => {
  it("is additive and does not rewrite existing jobs", () => {
    expect(migrationSql).toContain('ADD COLUMN "archived_at" timestamp');
    expect(migrationSql).toContain('ADD COLUMN "archived_by_user_id" integer');
    expect(migrationSql).toContain('ADD COLUMN "status_before_archive" text');
    expect(migrationSql).toContain('CREATE INDEX "jobs_archived_at_idx"');
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+"?jobs"?/i);
    expect(migrationSql).not.toMatch(/UPDATE\s+"?jobs"?/i);
  });

  it("refuses a destructive rollback while archived state exists", () => {
    expect(rollbackSql).toContain('WHERE "archived_at" IS NOT NULL');
    expect(rollbackSql).toContain("Rollback 0086 blocked");
    expect(rollbackSql).toContain("DELETE FROM drizzle.__drizzle_migrations");
    expect(rollbackSql).toContain("created_at = 1783979822106");
    expect(rollbackSql).toContain("BEGIN;");
    expect(rollbackSql).toContain("COMMIT;");
  });

  it("uses soft-delete and keeps explicit restore support", () => {
    const archiveBlock = jobsRoute.slice(
      jobsRoute.indexOf('router.delete("/jobs/:id"'),
      jobsRoute.indexOf('router.patch("/jobs/:id/status"'),
    );
    expect(archiveBlock).toContain(".update(jobsTable)");
    expect(archiveBlock).not.toContain(".delete(jobsTable)");
    expect(archiveBlock).toContain('eq(workSessionsTable.status, "active")');
    expect(archiveBlock).toContain('ne(invoicesTable.status, "cancelled")');
    expect(archiveBlock).toContain('router.post("/jobs/:id/restore"');
  });

  it("accepts the includeArchived query switch", () => {
    const parsed = ListJobsQueryParams.safeParse({ includeArchived: "true" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.includeArchived).toBe(true);
  });
});
