import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSources = {
  gdpr: readFileSync(new URL("../src/pages/gdpr.tsx", import.meta.url), "utf8"),
  customers: readFileSync(
    new URL("../src/pages/customers.tsx", import.meta.url),
    "utf8",
  ),
  customerDetail: readFileSync(
    new URL("../src/pages/customer-detail.tsx", import.meta.url),
    "utf8",
  ),
  people: readFileSync(
    new URL("../src/pages/people.tsx", import.meta.url),
    "utf8",
  ),
};

describe("privacy deletion UI containment", () => {
  it("does not wire legacy direct-delete mutations into user-facing pages", () => {
    expect(pageSources.gdpr).not.toMatch(/\buseEraseSubjectData\b/);
    expect(pageSources.customers).not.toMatch(/\buseDeleteCustomer\b/);
    expect(pageSources.customerDetail).not.toMatch(/\buseDeleteCustomer\b/);
    expect(pageSources.customerDetail).not.toMatch(
      /\buseDeleteCustomerContact\b/,
    );
    expect(pageSources.customerDetail).not.toMatch(/\buseDeleteCustomerSite\b/);
    expect(pageSources.people).not.toMatch(/\buseDeletePerson\b/);
  });

  it("keeps the GDPR export but explains the fail-closed case workflow", () => {
    expect(pageSources.gdpr).toContain("exportSubjectData");
    expect(pageSources.gdpr).toContain(
      "Přímý výmaz je bezpečnostně zablokovaný",
    );
    expect(pageSources.gdpr).toContain(
      "žádost musí být posouzena\n              v evidovaném privacy case",
    );
    expect(pageSources.gdpr).not.toContain("handleErase");
  });

  it("does not expose customer, contact, site, or person delete handlers", () => {
    expect(pageSources.customers).not.toMatch(/\bhandleDelete\b/);
    expect(pageSources.customerDetail).not.toContain("handleDeleteContact");
    expect(pageSources.customerDetail).not.toContain("handleDeleteSite");
    expect(pageSources.people).not.toContain("handleDeletePerson");
  });
});
