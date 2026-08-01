import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UpdateJobBillingIntentBody } from "@workspace/api-zod";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("job billing-intent contract", () => {
  it("accepts only explicit customer-billing intents", () => {
    expect(
      UpdateJobBillingIntentBody.safeParse({
        billingIntent: "not_billable",
        reason: "Reklamace",
      }).success,
    ).toBe(true);
    expect(
      UpdateJobBillingIntentBody.safeParse({
        billingIntent: "billed",
        reason: "Neplatný stav",
      }).success,
    ).toBe(false);
  });

  it("uses an additive default and protects a used rollback", () => {
    const migration = read(
      "lib/db/migrations/0094_steep_black_widow.sql",
    );
    const rollback = read(
      "lib/db/rollbacks/0094_steep_black_widow.down.sql",
    );
    expect(migration).toContain(
      `"billing_intent" text DEFAULT 'billable' NOT NULL`,
    );
    expect(migration).toContain("jobs_billing_exclusion_reason_check");
    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE)\s+/im);
    expect(rollback).toContain("Rollback 0094 blocked");
    expect(rollback).toContain("job_billing_intent_changed");
    expect(rollback).toContain("1785167642005");
  });

  it("enforces the exclusion in listings, draft creation and issue time", () => {
    const service = read("artifacts/api-server/src/lib/invoice-service.ts");
    const route = read("artifacts/api-server/src/routes/jobs.ts");
    const permissions = read(
      "artifacts/api-server/src/lib/api-route-access-policy.ts",
    );
    const billingPage = read(
      "artifacts/stavba/src/pages/billing-unbilled-detail.tsx",
    );
    expect(service).toContain(
      'eq(jobsTable.billingIntent, "billable")',
    );
    expect(service).toContain('job.billingIntent !== "billable"');
    expect(route).toContain('requirePermission("billing.manage")');
    expect(route).toContain("UpdateJobBillingIntentBody.safeParse");
    expect(permissions).toContain(
      '/^\\/jobs\\/\\d+\\/billing-intent$/.test(path)',
    );
    expect(billingPage).toContain("useUpdateJobBillingIntent");
    expect(billingPage).toContain("Nefakturovat");
    expect(billingPage).toContain(
      "Čas a náklady zůstávají uložené pro mzdy",
    );
  });
});
