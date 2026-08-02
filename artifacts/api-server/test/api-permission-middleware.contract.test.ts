import { describe, expect, it, vi } from "vitest";
import { enforceApiPermission } from "../src/middlewares/permissions";

function enforceUpload(permissions: string[]) {
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
      method: "POST",
      path: "/storage/uploads",
      auth: { permissions },
    } as never,
    response as never,
    next,
  );

  return { statusCode, body, next };
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
