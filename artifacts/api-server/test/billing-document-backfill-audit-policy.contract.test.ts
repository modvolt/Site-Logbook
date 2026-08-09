import { describe, expect, it } from "vitest";
import {
  BILLING_DOCUMENT_AUDIT_BEGIN_SQL,
  BILLING_DOCUMENT_AUDIT_CONTEXT_SQL,
  BILLING_DOCUMENT_AUDIT_LINES_SQL,
  BILLING_DOCUMENT_AUDIT_READ_QUERIES,
  BILLING_DOCUMENT_AUDIT_REFERENCES_SQL,
  classifyBillingDocumentBackfillAudit,
  classifyBillingLineEligibility,
  databaseNameFromPostgresUrl,
  parseBillingDocumentBackfillAuditOptions,
} from "../src/scripts/billing-document-backfill-audit-policy";

describe("billing document backfill read-only audit policy", () => {
  it("requires an exact database name and defaults the window to database time", () => {
    expect(
      parseBillingDocumentBackfillAuditOptions([
        "--database=site_logbook_production",
      ]),
    ).toEqual({
      database: "site_logbook_production",
      since: null,
    });
  });

  it("accepts one real ISO calendar date as an explicit cutoff", () => {
    expect(
      parseBillingDocumentBackfillAuditOptions([
        "--since=2026-06-09",
        "--database=site_logbook_production",
      ]),
    ).toEqual({
      database: "site_logbook_production",
      since: "2026-06-09",
    });
  });

  it.each([
    "--apply",
    "--apply=true",
    "--execute",
    "--execute=yes",
  ])("rejects the mutating argument %s", (argument) => {
    expect(() =>
      parseBillingDocumentBackfillAuditOptions([
        "--database=site_logbook_production",
        argument,
      ]),
    ).toThrow(/forbidden.*read-only/i);
  });

  it.each([
    [],
    ["--database=one", "--database=two"],
    ["--database=site_logbook_production", "--since=2026-02-30"],
    ["--database=site_logbook_production", "--since=09.06.2026"],
    ["--database=site_logbook_production", "--unknown=true"],
  ])("rejects an incomplete or ambiguous invocation %#", (args) => {
    expect(() => parseBillingDocumentBackfillAuditOptions(args)).toThrow();
  });

  it("reads but never interpolates the database identity from DATABASE_URL", () => {
    expect(
      databaseNameFromPostgresUrl(
        "postgresql://audit:secret@db.example.test:5432/site_logbook%5Fproduction?sslmode=require",
      ),
    ).toBe("site_logbook_production");
    expect(() => databaseNameFromPostgresUrl("mysql://db/name")).toThrow(
      /postgres/i,
    );
  });

  it("exposes only SELECT/CTE audit queries and a READ ONLY transaction", () => {
    expect(BILLING_DOCUMENT_AUDIT_BEGIN_SQL).toMatch(
      /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/,
    );
    expect(BILLING_DOCUMENT_AUDIT_READ_QUERIES).toHaveLength(4);

    for (const query of BILLING_DOCUMENT_AUDIT_READ_QUERIES) {
      const withoutStrings = query.replace(/'(?:''|[^'])*'/g, "''");
      expect(query.trim()).toMatch(/^(with|select)\b/i);
      expect(withoutStrings).not.toMatch(
        /\b(insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|copy|call|do|vacuum|refresh)\b/i,
      );
      expect(withoutStrings).not.toMatch(/\bfor\s+update\b/i);
    }
  });

  it("derives the default two-month cutoff from Prague database time", () => {
    expect(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL).toContain(
      "now() at time zone 'Europe/Prague'",
    );
    expect(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL).toContain("interval '2 months'");
    expect(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL).toContain("date_trunc(");
    expect(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL).toContain("'day'");
    expect(BILLING_DOCUMENT_AUDIT_CONTEXT_SQL).toContain("$1::date::timestamp");
  });

  it("keeps draft invoices inside the fail-closed provenance guards", () => {
    expect(BILLING_DOCUMENT_AUDIT_LINES_SQL).toContain("invoice_source_links");
    expect(BILLING_DOCUMENT_AUDIT_LINES_SQL).toContain(
      "invoice.status <> 'cancelled'",
    );
    expect(BILLING_DOCUMENT_AUDIT_LINES_SQL).not.toContain(
      "invoice.status <> 'draft'",
    );
  });

  it("audits delivery-note relationships only on supplier invoices and credits", () => {
    expect(BILLING_DOCUMENT_AUDIT_REFERENCES_SQL).toContain(
      "d.doc_type in ('invoice', 'credit_note')",
    );
  });

  it("reports line approval independently from match confirmation", () => {
    expect(classifyBillingLineEligibility(1)).toBe("eligible");
    expect(classifyBillingLineEligibility(0)).toBe("line_not_approved");
    expect(classifyBillingLineEligibility(2)).toBe("line_not_approved");
  });

  it("classifies unsafe repair input as blocked without producing an apply plan", () => {
    expect(
      classifyBillingDocumentBackfillAudit({
        hardBlockers: 1,
        reviewFindings: 0,
      }),
    ).toBe("BLOCK");
    expect(
      classifyBillingDocumentBackfillAudit({
        hardBlockers: 0,
        reviewFindings: 2,
      }),
    ).toBe("REVIEW");
    expect(
      classifyBillingDocumentBackfillAudit({
        hardBlockers: 0,
        reviewFindings: 0,
      }),
    ).toBe("PASS");
  });
});
