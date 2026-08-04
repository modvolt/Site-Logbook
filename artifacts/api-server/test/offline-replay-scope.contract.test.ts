import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createOfflineIdentityScope } from "../src/lib/offline-identity";
import {
  attachOfflineResponseScope,
  enforceOfflineReplayScope,
  OFFLINE_SCOPE_HEADER,
} from "../src/middlewares/offline-replay-scope";

const auth = {
  userId: 7,
  username: "field-user",
  role: "guest" as const,
  name: "Field User",
  personId: 12,
  permissions: ["jobs.view", "jobs.work"] as const,
};

function run(input: {
  suppliedScope?: string;
  authenticated?: boolean;
  method?: string;
  originalUrl?: string;
  destination?: string;
} = {}) {
  const {
    suppliedScope,
    authenticated = true,
    method = "GET",
    originalUrl = "/api/jobs/42",
    destination = "empty",
  } = input;
  const status = vi.fn();
  const json = vi.fn();
  status.mockReturnValue({ json });
  const req = {
    auth: authenticated ? auth : undefined,
    session: { sessionGeneration: authenticated ? 3 : undefined },
    method,
    originalUrl,
    get: vi.fn((name: string) => {
      if (name.toLowerCase() === OFFLINE_SCOPE_HEADER) return suppliedScope;
      if (name.toLowerCase() === "sec-fetch-dest") return destination;
      return undefined;
    }),
  } as unknown as Request;
  const res = { status } as unknown as Response;
  const next = vi.fn() as NextFunction;
  enforceOfflineReplayScope(req, res, next);
  return { status, json, next };
}

describe("offline replay scope middleware", () => {
  it("fails closed when an ordinary private API fetch omits the scope", () => {
    const result = run();
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(428);
    expect(result.json).toHaveBeenCalledWith({
      error: "Identity scope required",
      code: "identity_scope_required",
    });
  });

  it("accepts the exact current user and authorization epoch", () => {
    const scope = createOfflineIdentityScope({
      userId: auth.userId,
      sessionGeneration: 3,
      role: auth.role,
      permissions: [...auth.permissions],
    });
    const result = run({ suppliedScope: scope });
    expect(result.next).toHaveBeenCalledOnce();
  });

  it("rejects a changed identity atomically at the API boundary", () => {
    const result = run({ suppliedScope: "f".repeat(64) });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(409);
    expect(result.json).toHaveBeenCalledWith({
      error: "Offline identity changed",
      code: "offline_scope_mismatch",
    });
  });

  it("rejects a replay header without an authenticated identity", () => {
    const result = run({ suppliedScope: "f".repeat(64), authenticated: false });
    expect(result.status).toHaveBeenCalledWith(401);
  });

  it("allows headerless browser resources that cannot set custom headers", () => {
    const result = run({ destination: "image" });
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it("allows headerless SSE because it carries invalidation topics only", () => {
    const result = run({ originalUrl: "/api/events" });
    expect(result.next).toHaveBeenCalledOnce();
  });
});

describe("offline response scope middleware", () => {
  it("labels authenticated GET responses with the current identity epoch", () => {
    const setHeader = vi.fn();
    const req = {
      method: "GET",
      auth,
      session: { sessionGeneration: 3 },
    } as unknown as Request;
    const res = { setHeader } as unknown as Response;
    const next = vi.fn() as NextFunction;

    attachOfflineResponseScope(req, res, next);

    expect(setHeader).toHaveBeenCalledWith(
      OFFLINE_SCOPE_HEADER,
      createOfflineIdentityScope({
        userId: auth.userId,
        sessionGeneration: 3,
        role: auth.role,
        permissions: [...auth.permissions],
      }),
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not label unauthenticated or mutating responses", () => {
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const next = vi.fn() as NextFunction;

    attachOfflineResponseScope(
      { method: "GET", session: {} } as unknown as Request,
      res,
      next,
    );
    attachOfflineResponseScope(
      { method: "POST", auth, session: { sessionGeneration: 3 } } as unknown as Request,
      res,
      next,
    );

    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
