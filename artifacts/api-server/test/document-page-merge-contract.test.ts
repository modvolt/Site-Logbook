import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("multi-page document contract", () => {
  it("ships an additive reversible migration without changing older migrations", () => {
    const migration = read("lib/db/migrations/0091_document_page_merges.sql");
    expect(migration).toContain('CREATE TABLE "billing_document_merges"');
    expect(migration).toContain('CREATE TABLE "billing_document_merge_members"');
    expect(migration).toContain('ADD COLUMN "billing_document_id"');
    expect(migration).toContain('ADD COLUMN "page_index"');
    expect(migration).toContain('ADD COLUMN "detected_doc_type_confidence"');
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/i);
  });

  it("protects job upload and merge with both module and assignment permissions", () => {
    const permissions = read("artifacts/api-server/src/middlewares/permissions.ts");
    const routes = read("artifacts/api-server/src/routes/billing-documents.ts");
    expect(permissions).toContain("jobs\\/\\d+\\/documents\\/(?:upload|merge-pages)");
    expect(routes).toMatch(/"\/jobs\/:id\/documents\/upload",\s*requireAssignedJobWork/);
    expect(routes).toMatch(/"\/jobs\/:id\/documents\/merge-pages",\s*requireAssignedJobWork/);
  });

  it("returns a dedicated sanitized job document response without billing lines or totals", () => {
    const route = read("artifacts/api-server/src/routes/attachments.ts");
    const start = route.indexOf('router.get("/jobs/:jobId/documents"');
    const end = route.indexOf('router.post("/jobs/:jobId/attachments"', start);
    const handler = route.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain("requireAssignedJobView");
    expect(handler).toContain("detectedDocTypeConfidence");
    expect(handler).not.toContain("billingDocumentLinesTable");
    expect(handler).not.toContain("totalWithVat");
    expect(handler).not.toContain("unitPrice");
  });

  it("keeps merge operations locked, audited and blocked by downstream accounting state", () => {
    const service = read("artifacts/api-server/src/lib/cost-document-service.ts");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("stopQueuedExtractionOrRejectRunning");
    expect(service).toContain("warehouseMovementsTable.billingDocumentId");
    expect(service).toContain("line.invoicedInvoiceId != null");
    expect(service).toContain('action: "document_pages_merged"');
    expect(service).toContain('status: "reverted"');
    expect(service).not.toMatch(/document_pages_merged[\s\S]{0,1000}deletePrivateObject/);
  });

  it("exposes mobile capture, drag ordering and desktop bulk merge without price fields", () => {
    const jobDetail = read("artifacts/stavba/src/pages/job-detail.tsx");
    const billing = read("artifacts/stavba/src/pages/billing-documents.tsx");
    expect(jobDetail).toContain("Vyfotit stránku");
    expect(jobDetail).toContain("verticalListSortingStrategy");
    expect(jobDetail).toContain("uploadJobDocumentPage");
    expect(jobDetail).toContain("mergeJobDocumentPages");
    expect(billing).toContain("Sloučit jako jeden doklad");
    expect(billing).toContain("SortableBillingDocument");
  });
});
