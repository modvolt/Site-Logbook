import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createOfflineIdentityScope } from "../src/lib/offline-identity";
import { enforceOfflineReplayScope } from "../src/middlewares/offline-replay-scope";

const auth = {
  userId: 7,
  username: "field-user",
  role: "guest" as const,
  name: "Field User",
  personId: 12,
  permissions: ["jobs.view", "jobs.work"] as const,
};

function run(suppliedScope?: string, authenticated = true) {
  const status = vi.fn();
  const json = vi.fn();
  status.mockReturnValue({ json });
  const req = {
    auth: authenticated ? auth : undefined,
    session: { sessionGeneration: authenticated ? 3 : undefined },
    get: vi.fn(() => suppliedScope),
  } as unknown as Request;
  const res = { status } as unknown as Response;
  const next = vi.fn() as NextFunction;
  enforceOfflineReplayScope(req, res, next);
  return { status, json, next };
}

describe("offline replay scope middleware", () => {
  it("does not affect ordinary requests without a replay header", () => {
    const result = run();
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it("accepts the exact current user and authorization epoch", () => {
    const scope = createOfflineIdentityScope({
      userId: auth.userId,
      sessionGeneration: 3,
      role: auth.role,
      permissions: [...auth.permissions],
    });
    const result = run(scope);
    expect(result.next).toHaveBeenCalledOnce();
  });

  it("rejects a changed identity atomically at the API boundary", () => {
    const result = run("f".repeat(64));
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(409);
    expect(result.json).toHaveBeenCalledWith({
      error: "Offline identity changed",
      code: "offline_scope_mismatch",
    });
  });

  it("rejects a replay header without an authenticated identity", () => {
    const result = run("f".repeat(64), false);
    expect(result.status).toHaveBeenCalledWith(401);
  });
});
