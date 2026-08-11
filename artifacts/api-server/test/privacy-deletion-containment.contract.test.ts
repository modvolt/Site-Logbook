import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  blockDirectPrivacyDeletion,
  DIRECT_PRIVACY_DELETION_OPERATIONS,
  PRIVACY_CASE_REQUIRED_CODE,
  PRIVACY_CASE_REQUIRED_MESSAGE,
} from "../src/middlewares/privacy-case-required";

const ROUTE_CONTRACTS = [
  {
    file: "gdpr.ts",
    method: "post",
    path: "/gdpr/erase",
    operation: "gdpr_direct_erase",
  },
  {
    file: "customers.ts",
    method: "delete",
    path: "/customers/:id",
    operation: "customer_hard_delete",
  },
  {
    file: "customer-contacts.ts",
    method: "delete",
    path: "/customer-contacts/:id",
    operation: "customer_contact_hard_delete",
  },
  {
    file: "customer-sites.ts",
    method: "delete",
    path: "/customer-sites/:id",
    operation: "customer_site_hard_delete",
  },
  {
    file: "people.ts",
    method: "delete",
    path: "/people/:id",
    operation: "person_hard_delete",
  },
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("direct privacy deletion containment", () => {
  it.each(DIRECT_PRIVACY_DELETION_OPERATIONS)(
    "fails closed before the legacy %s handler",
    (operation) => {
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const next = vi.fn();

      blockDirectPrivacyDeletion(operation)(
        {} as never,
        { status } as never,
        next,
      );

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        error: PRIVACY_CASE_REQUIRED_MESSAGE,
        code: PRIVACY_CASE_REQUIRED_CODE,
        operation,
      });
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTE_CONTRACTS)(
    "places the gate before the $method $path handler",
    ({ file, method, path, operation }) => {
      const source = readFileSync(
        new URL(`../src/routes/${file}`, import.meta.url),
        "utf8",
      );
      const routeGate = new RegExp(
        `router\\.${method}\\(\\s*"${escapeRegExp(path)}"\\s*,\\s*` +
          `blockDirectPrivacyDeletion\\("${operation}"\\)\\s*,\\s*async`,
      );

      expect(source).toMatch(routeGate);
    },
  );

  it("has no environment, request-header, or next-callback bypass", () => {
    const source = readFileSync(
      new URL("../src/middlewares/privacy-case-required.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("process.env");
    expect(source).not.toContain("req.headers");
    expect(source).not.toContain("next(");
  });
});
