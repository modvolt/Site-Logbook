import { describe, expect, it } from "vitest";
import { resolvePermissions } from "../../../lib/db/src/permissions";

describe("role permissions with individual overrides", () => {
  it("keeps billing restricted to admin by default", () => {
    expect(resolvePermissions("master", [])).not.toContain("billing.view");
    expect(resolvePermissions("admin", [])).toContain("billing.view");
  });

  it("keeps employee rates and internal costs restricted by default", () => {
    expect(resolvePermissions("guest", [])).not.toContain("rates.cost.view");
    expect(resolvePermissions("master", [])).not.toContain("rates.cost.view");
    expect(resolvePermissions("master", [])).not.toContain("rates.sale.view");
    expect(resolvePermissions("admin", [])).toContain("rates.cost.view");
    expect(resolvePermissions("admin", [])).toContain("rates.sale.view");
  });

  it("extends a role with an explicit allow", () => {
    expect(
      resolvePermissions("master", [{ permission: "statistics.view", effect: "allow" }]),
    ).toContain("statistics.view");
  });

  it("restricts even an admin with an explicit deny", () => {
    expect(
      resolvePermissions("admin", [{ permission: "billing.view", effect: "deny" }]),
    ).not.toContain("billing.view");
  });

  it("ignores unknown persisted permission keys", () => {
    expect(
      resolvePermissions("guest", [{ permission: "obsolete.permission", effect: "allow" }]),
    ).toEqual(resolvePermissions("guest", []));
  });
});
