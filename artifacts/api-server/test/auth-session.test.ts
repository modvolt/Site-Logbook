import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { establishAuthenticatedSession } from "../src/lib/auth-session";

function mockRequest(options: { saveError?: Error } = {}) {
  const events: string[] = [];
  const oldSession: Record<string, unknown> = {
    marker: "anonymous",
    regenerate: (callback: (error?: Error) => void) => {
      events.push("regenerate");
      request.session = newSession as Request["session"];
      callback();
    },
  };
  const newSession: Record<string, unknown> = {
    save: (callback: (error?: Error) => void) => {
      events.push("save");
      callback(options.saveError);
    },
    destroy: (callback: (error?: Error) => void) => {
      events.push("destroy");
      callback();
    },
  };
  const request = { session: oldSession } as unknown as Request;
  return { request, oldSession, newSession, events };
}

describe("establishAuthenticatedSession", () => {
  it("regenerates before assigning identity and persists the new session", async () => {
    const { request, oldSession, newSession, events } = mockRequest();

    await establishAuthenticatedSession(request, {
      id: 42,
      username: "admin",
      role: "admin",
      name: "Admin",
      sessionGeneration: 3,
    });

    expect(events).toEqual(["regenerate", "save"]);
    expect(oldSession).not.toHaveProperty("userId");
    expect(newSession).toMatchObject({
      userId: 42,
      username: "admin",
      role: "admin",
      name: "Admin",
      sessionGeneration: 3,
    });
  });

  it("destroys the new session when persistence fails", async () => {
    const saveError = new Error("store unavailable");
    const { request, events } = mockRequest({ saveError });

    await expect(
      establishAuthenticatedSession(request, {
        id: 7,
        username: "worker",
        role: "guest",
        name: "Worker",
        sessionGeneration: 4,
      }),
    ).rejects.toBe(saveError);

    expect(events).toEqual(["regenerate", "save", "destroy"]);
  });

  it("does not attach identity when regeneration fails", async () => {
    const failure = new Error("regenerate failed");
    const session = {
      regenerate: vi.fn((callback: (error?: Error) => void) => callback(failure)),
    } as unknown as Request["session"];
    const request = { session } as Request;

    await expect(
      establishAuthenticatedSession(request, {
        id: 1,
        username: "admin",
        role: "admin",
        name: "Admin",
        sessionGeneration: 1,
      }),
    ).rejects.toBe(failure);

    expect(session).not.toHaveProperty("userId");
  });
});
