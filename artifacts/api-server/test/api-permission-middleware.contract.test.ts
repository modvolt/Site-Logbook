import { describe, expect, it, vi } from "vitest";
import {
  accountTypeCanAccessPolicy,
  enforceApiPermission,
  requirePermission,
} from "../src/middlewares/permissions";

function enforceRoute(input: {
  method: string;
  path: string;
  accountType?: "internal" | "external";
  permissions?: string[];
}) {
  let statusCode = 200;
  let body: unknown;
  const next = vi.fn();
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };

  enforceApiPermission(
    {
      method: input.method,
      path: input.path,
      auth: {
        accountType: input.accountType,
        permissions: input.permissions ?? [],
      },
    } as never,
    response as never,
    next,
  );

  return { statusCode, body, next };
}

function enforceUpload(permissions: string[]) {
  return enforceRoute({
    method: "POST",
    path: "/storage/uploads",
    accountType: "internal",
    permissions,
  });
}

describe("staged upload permission boundary", () => {
  it("rejects a read-only guest permission set before upload side effects", () => {
    const result = enforceUpload([
      "jobs.view",
      "activities.view",
      "customers.view",
    ]);

    expect(result.statusCode).toBe(403);
    expect(result.body).toMatchObject({ error: "Forbidden" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each(["jobs.work", "activities.manage", "customers.manage"])(
    "allows the effective %s claim permission",
    (permission) => {
      const result = enforceUpload([permission]);

      expect(result.statusCode).toBe(200);
      expect(result.body).toBeUndefined();
      expect(result.next).toHaveBeenCalledOnce();
    },
  );

  it("does not treat an unrelated write permission as upload authority", () => {
    const result = enforceUpload(["billing.manage"]);

    expect(result.statusCode).toBe(403);
    expect(result.next).not.toHaveBeenCalled();
  });
});

describe("account-type route audience boundary", () => {
  it("rejects a forged external internal-permission set before route handling", () => {
    const result = enforceRoute({
      method: "GET",
      path: "/jobs",
      accountType: "external",
      permissions: ["jobs.view"],
    });

    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "Forbidden", code: "route_not_authorized" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/events"],
    ["GET", "/me/jobs"],
    ["PUT", "/preferences"],
    ["GET", "/storage/objects/uploads/known"],
    ["POST", "/client-errors"],
    ["POST", "/auth/vault/verify-password"],
    ["POST", "/auth/webauthn/verify/begin"],
  ])("rejects external access to internal authenticated route %s %s", (method, path) => {
    const result = enforceRoute({ method, path, accountType: "external" });

    expect(result.statusCode).toBe(403);
    expect(result.body).toMatchObject({ code: "route_not_authorized" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/sessions"],
    ["DELETE", "/sessions/known-sid"],
    ["GET", "/auth/webauthn/credentials"],
    ["DELETE", "/auth/webauthn/credentials/1"],
    ["POST", "/auth/webauthn/register/begin"],
    ["POST", "/auth/webauthn/register/complete"],
  ])("allows explicit shared self-service route %s %s", (method, path) => {
    const result = enforceRoute({ method, path, accountType: "external" });

    expect(result.statusCode).toBe(200);
    expect(result.next).toHaveBeenCalledOnce();
  });

  it("fails closed when a hydrated auth object has no recognized account type", () => {
    const result = enforceRoute({ method: "GET", path: "/sessions" });

    expect(result.statusCode).toBe(403);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("allows only external accounts through an external portal policy", () => {
    const portalPolicy = {
      kind: "authenticated",
      audience: "external",
    } as const;

    expect(accountTypeCanAccessPolicy("external", portalPolicy)).toBe(true);
    expect(accountTypeCanAccessPolicy("internal", portalPolicy)).toBe(false);
  });

  it("does not let route-local permissions revive an external account", () => {
    let statusCode = 200;
    let body: unknown;
    const next = vi.fn();
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };

    requirePermission("users.manage")(
      {
        auth: {
          accountType: "external",
          permissions: ["users.manage"],
        },
      } as never,
      response as never,
      next,
    );

    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: "Forbidden", code: "route_not_authorized" });
    expect(next).not.toHaveBeenCalled();
  });
});
