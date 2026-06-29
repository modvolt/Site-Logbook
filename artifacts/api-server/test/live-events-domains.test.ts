/**
 * Tests for the domainsForPath() side-effects matrix.
 *
 * Verifies that every documented mutation workflow (jobs, billing, quotes, etc.)
 * maps to the expected set of domains. A regression here means a browser screen
 * stops refreshing after a related mutation.
 */
import { describe, it, expect } from "vitest";
import { domainsForPath } from "../src/lib/live-updates";
import { isLiveDomain } from "@workspace/live-events";

function domains(path: string) {
  return new Set(domainsForPath(path));
}

describe("domainsForPath — jobs", () => {
  it("job CRUD → jobs", () => {
    expect(domains("/jobs")).toContain("jobs");
    expect(domains("/jobs/5")).toContain("jobs");
    expect(domains("/jobs/5/status")).toContain("jobs");
    expect(domains("/jobs/reorder")).toContain("jobs");
  });

  it("job materials → jobs + warehouse", () => {
    const d = domains("/jobs/5/materials");
    expect(d).toContain("jobs");
    expect(d).toContain("warehouse");
  });

  it("job time-entries → jobs + people", () => {
    const d = domains("/jobs/5/time-entries");
    expect(d).toContain("jobs");
    expect(d).toContain("people");
  });

  it("tasks → jobs", () => {
    expect(domains("/tasks/1")).toContain("jobs");
  });
});

describe("domainsForPath — activities", () => {
  it("activity CRUD → activities", () => {
    expect(domains("/activities")).toContain("activities");
    expect(domains("/activities/3")).toContain("activities");
  });

  it("activity time-entries → activities + people", () => {
    const d = domains("/activities/3/time-entries");
    expect(d).toContain("activities");
    expect(d).toContain("people");
  });
});

describe("domainsForPath — warehouse", () => {
  it("warehouse-items → warehouse", () => {
    expect(domains("/warehouse-items")).toContain("warehouse");
    expect(domains("/warehouse-items/7")).toContain("warehouse");
  });

  it("warehouse-movements → warehouse", () => {
    expect(domains("/warehouse-movements")).toContain("warehouse");
  });

  it("materials (top-level) → jobs + warehouse", () => {
    const d = domains("/materials/2");
    expect(d).toContain("jobs");
    expect(d).toContain("warehouse");
  });
});

describe("domainsForPath — customers", () => {
  it("customers → customers", () => {
    expect(domains("/customers")).toContain("customers");
    expect(domains("/customers/1")).toContain("customers");
  });

  it("customer sub-resources → customers", () => {
    expect(domains("/customer-contacts/1")).toContain("customers");
    expect(domains("/customer-sites/2")).toContain("customers");
    expect(domains("/customer-site-attachments/3")).toContain("customers");
    expect(domains("/customer-documents/4")).toContain("customers");
  });
});

describe("domainsForPath — people, machines, leaves", () => {
  it("people → people", () => {
    expect(domains("/people")).toContain("people");
    expect(domains("/people/1")).toContain("people");
  });

  it("machines → machines", () => {
    expect(domains("/machines")).toContain("machines");
  });

  it("leaves → leaves", () => {
    expect(domains("/leaves")).toContain("leaves");
  });
});

describe("domainsForPath — billing", () => {
  it("invoices → billingInvoices", () => {
    expect(domains("/billing/invoices")).toContain("billingInvoices");
    expect(domains("/billing/invoices/3/issue")).toContain("billingInvoices");
    expect(domains("/billing/invoices/3/storno")).toContain("billingInvoices");
  });

  it("recurring-templates → billingRecurringTemplates", () => {
    expect(domains("/billing/recurring-templates")).toContain("billingRecurringTemplates");
    expect(domains("/billing/recurring-templates/1")).toContain("billingRecurringTemplates");
  });

  it("documents → billingDocuments + reviewQueue", () => {
    const d = domains("/billing/documents");
    expect(d).toContain("billingDocuments");
    expect(d).toContain("reviewQueue");
  });

  it("approved-lines → billingDocuments", () => {
    expect(domains("/billing/approved-lines")).toContain("billingDocuments");
  });

  it("bank-statements → bankImport", () => {
    expect(domains("/billing/bank-statements")).toContain("bankImport");
  });

  it("email-import → emailImport", () => {
    expect(domains("/billing/email-import")).toContain("emailImport");
    expect(domains("/billing/email-import/sync")).toContain("emailImport");
  });

  it("review-queue → reviewQueue + billingDocuments", () => {
    const d = domains("/billing/review-queue");
    expect(d).toContain("reviewQueue");
    expect(d).toContain("billingDocuments");
  });
});

describe("domainsForPath — ppe, quotes, sessions", () => {
  it("ppe → ppe + people", () => {
    const d = domains("/ppe");
    expect(d).toContain("ppe");
    expect(d).toContain("people");
  });

  it("quotes → quotes", () => {
    expect(domains("/quotes")).toContain("quotes");
    expect(domains("/quotes/2/convert")).toContain("quotes");
  });

  it("sessions → sessions", () => {
    expect(domains("/sessions")).toContain("sessions");
    expect(domains("/admin/sessions")).toContain("sessions");
  });

  it("auth login/setup → sessions", () => {
    expect(domains("/auth/login")).toContain("sessions");
    expect(domains("/auth/setup")).toContain("sessions");
  });
});

describe("domainsForPath — no-ops", () => {
  it("settings / auth / storage return empty arrays", () => {
    expect(domainsForPath("/settings/general")).toHaveLength(0);
    expect(domainsForPath("/storage/objects/some-key")).toHaveLength(0);
    expect(domainsForPath("/admin/backups")).toHaveLength(0);
  });
});

describe("all returned domains are valid LiveDomain values", () => {
  const testPaths = [
    "/jobs",
    "/jobs/5/materials",
    "/activities/1/time-entries",
    "/warehouse-items",
    "/customers/1",
    "/people",
    "/machines",
    "/leaves",
    "/ppe",
    "/quotes",
    "/sessions",
    "/billing/invoices",
    "/billing/documents",
    "/billing/bank-statements",
    "/billing/email-import",
    "/billing/review-queue",
    "/billing/recurring-templates",
  ];

  for (const path of testPaths) {
    it(`all domains for "${path}" pass isLiveDomain()`, () => {
      const ds = domainsForPath(path);
      for (const d of ds) {
        expect(isLiveDomain(d)).toBe(true);
      }
    });
  }
});
