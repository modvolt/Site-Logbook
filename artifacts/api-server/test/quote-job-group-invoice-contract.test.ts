import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("quote job-group invoice contract", () => {
  it("adds only an auditable lifecycle table and a guarded rollback", () => {
    const migration = read("lib/db/migrations/0090_secret_killmonger.sql");
    const rollback = read("lib/db/rollbacks/0090_secret_killmonger.down.sql");
    expect(migration).toContain('CREATE TABLE "quote_invoice_links"');
    expect(migration).toContain('"quote_invoice_links_active_quote_uq"');
    expect(migration).toContain("WHERE");
    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE)\s+/im);
    expect(rollback).toContain(
      'IF EXISTS (SELECT 1 FROM "quote_invoice_links")',
    );
    expect(rollback).toContain("Rollback 0090 blocked");
    expect(rollback).toContain("1783988026596");
  });

  it("copies accepted quote items and includes only explicitly selected extras", () => {
    const service = read("artifacts/api-server/src/lib/invoice-service.ts");
    const start = service.indexOf(
      "export async function createQuoteJobGroupInvoiceDraft",
    );
    const end = service.indexOf("export interface InvoiceUpdateInput", start);
    const block = service.slice(start, end);
    expect(block).toContain('.for("update")');
    expect(block).toContain('quote.status !== "accepted"');
    expect(block).toContain("input.extraJobIds ?? []");
    expect(block).toContain('sourceType: "quote_item"');
    expect(block).toContain("unitPriceWithoutVat: num(item.unitPrice)");
    expect(block).toContain("ensureQuoteGroupSourceLinks");
    expect(block).toContain("quoteInvoiceLinksTable");
    expect(block).toContain("convertedToInvoiceId: created.id");
    expect(block).toContain("quote_job_group_invoice_draft_created");
    expect(block).not.toContain("jobIds: jobs.map");
  });

  it("releases or bills the quote reservation with every invoice lifecycle", () => {
    const service = read("artifacts/api-server/src/lib/invoice-service.ts");
    expect(service).toContain(
      'releaseQuoteInvoiceBilling(tx, id, actor.userId, "draft_deleted")',
    );
    expect(service).toContain(
      'releaseQuoteInvoiceBilling(tx, id, actor.userId, "invoice_cancelled")',
    );
    expect(service).toContain(
      '.set({ status: "billed", billedAt: new Date() })',
    );
    expect(service).toContain("convertedToInvoiceId: null");
  });

  it("keeps every job in the quote group protected after draft edits", () => {
    const service = read("artifacts/api-server/src/lib/invoice-service.ts");
    const jobsRoute = read("artifacts/api-server/src/routes/jobs.ts");
    const groupsRoute = read("artifacts/api-server/src/routes/job-groups.ts");
    expect(service).toContain("async function ensureQuoteGroupSourceLinks");
    expect(service).toContain(
      "await ensureQuoteGroupSourceLinks(tx, id, quoteLink.jobGroupId)",
    );
    expect(service).toContain(
      "Vazba faktury na přijatou nabídku už není platná.",
    );
    expect(service).toContain(
      "v akci už není dokončená; fakturu nelze vystavit.",
    );
    expect(jobsRoute).toContain("GROUP_BILLING_LOCKED");
    expect(groupsRoute).toContain("GROUP_BILLING_LOCKED");
    expect(groupsRoute).toContain(
      "Zakázku nelze z akce odebrat, dokud je akce navázaná na fakturu.",
    );
  });

  it("exposes a billing-protected API and an explicit extra-work UI", () => {
    const spec = read("lib/api-spec/openapi.yaml");
    const route = read("artifacts/api-server/src/routes/billing.ts");
    const page = read("artifacts/stavba/src/pages/job-group-detail.tsx");
    expect(spec).toContain("/billing/job-groups/{id}/invoice-draft:");
    expect(spec).toContain("QuoteJobGroupInvoiceDraftInput:");
    expect(route).toContain('"/billing/job-groups/:id/invoice-draft"');
    expect(page).toContain('can("billing.manage")');
    expect(page).toContain("Schválené vícepráce");
    expect(page).toContain("extraJobIds: Array.from(extraJobIds)");
    expect(page).toMatch(/položek přijaté nabídky/);
  });
});
