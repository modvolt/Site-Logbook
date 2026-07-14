import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConvertQuoteToJobBody, CreateJobBody } from "@workspace/api-zod";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("quote to job-group conversion contract", () => {
  it("keeps migration 0089 additive and existing records untouched", () => {
    const migration = read("lib/db/migrations/0089_thin_robin_chapel.sql");

    expect(migration).toContain('ADD COLUMN "converted_to_job_group_id" integer');
    expect(migration).toContain('ON DELETE set null');
    expect(migration).toContain('CREATE UNIQUE INDEX "quotes_converted_job_group_uidx"');
    expect(migration).not.toMatch(/\bUPDATE\s+"?quotes"?/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("blocks destructive schema rollback after a quote-group link is used", () => {
    const rollback = read("lib/db/rollbacks/0089_thin_robin_chapel.down.sql");

    expect(rollback).toContain('WHERE "converted_to_job_group_id" IS NOT NULL');
    expect(rollback).toContain("Rollback 0089 blocked");
    expect(rollback).toContain("DELETE FROM drizzle.__drizzle_migrations");
    expect(rollback).toContain("created_at = 1783986815471");
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("COMMIT;");
  });

  it("creates the group, first job, quote links and audit in one transaction", () => {
    const service = read("artifacts/api-server/src/lib/quote-service.ts");
    const start = service.indexOf("export async function convertQuoteToJob");
    const block = service.slice(start);

    expect(block).toContain("db.transaction");
    expect(block).toContain(".for(\"update\")");
    expect(block).toContain(".insert(jobGroupsTable)");
    expect(block).toContain(".insert(jobsTable)");
    expect(block).toContain("convertedToJobGroupId: group.id");
    expect(block).toContain('action: "quote_converted_to_job_group"');
    expect(block).toContain("pg_advisory_xact_lock");
  });

  it("accepts an explicit planned date and atomic group assignment", () => {
    const conversion = ConvertQuoteToJobBody.safeParse({ plannedDate: "2026-08-03" });
    expect(conversion.success).toBe(true);

    const job = CreateJobBody.safeParse({
      title: "Druhý den realizace",
      type: "planned_work",
      date: "2026-08-04",
      status: "planned",
      customerId: 10,
      groupId: 20,
    });
    expect(job.success).toBe(true);
  });

  it("offers a dated conversion dialog and redirects to the created action", () => {
    const quoteDetail = read("artifacts/stavba/src/pages/quote-detail.tsx");
    const groupDetail = read("artifacts/stavba/src/pages/job-group-detail.tsx");

    expect(quoteDetail).toContain("Zahájit realizaci nabídky");
    expect(quoteDetail).toContain("data: { plannedDate }");
    expect(quoteDetail).toContain("`/job-groups/${result.jobGroupId}`");
    expect(groupDetail).toContain("Přidat zakázku");
    expect(groupDetail).toContain("groupId=${group.id}");
  });

  it("protects source lineage from generic group deletion and primary-job removal", () => {
    const routes = read("artifacts/api-server/src/routes/job-groups.ts");

    expect(routes).toContain("Akci vytvořenou z nabídky nelze smazat");
    expect(routes).toContain("První zakázku vytvořenou z nabídky nelze z její akce odebrat");
    expect(routes).toContain("Všechny zakázky v akci musí patřit stejnému zákazníkovi");
    expect(routes).toContain("scheduleRangeForJobs");
    expect(routes).toContain('ne(jobVisitsTable.status, "cancelled")');
  });
});
