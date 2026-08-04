import { describe, expect, it, vi } from "vitest";
import type { Agent } from "supertest";
import { bindAuthenticatedAgent } from "./scoped-test-agent";

describe("scoped SuperTest agent", () => {
  it("binds private requests while leaving public auth routes headerless", async () => {
    const scope = "a".repeat(64);
    let plugin: ((request: { method: string; url: string; set: (name: string, value: string) => void }) => void) | undefined;
    const agent = {
      get: vi.fn(async () => ({
        status: 200,
        body: { authenticated: true, offlineScope: scope },
      })),
      use: vi.fn((next) => {
        plugin = next;
        return agent;
      }),
    } as unknown as Agent;

    await bindAuthenticatedAgent(agent);
    const set = vi.fn();
    plugin?.({ method: "PATCH", url: "/api/jobs/42", set });
    expect(set).toHaveBeenCalledWith("X-Stavba-Offline-Scope", scope);
    expect(set).toHaveBeenCalledWith("Idempotency-Key", expect.stringMatching(/^db-test-/));

    set.mockClear();
    plugin?.({ method: "POST", url: "/api/auth/logout", set });
    expect(set).not.toHaveBeenCalled();
  });

  it("fails instead of inventing a scope when /me is not authenticated", async () => {
    const agent = {
      get: vi.fn(async () => ({
        status: 200,
        body: { authenticated: false, offlineScope: null },
      })),
      use: vi.fn(),
    } as unknown as Agent;

    await expect(bindAuthenticatedAgent(agent)).rejects.toThrow("valid offline scope");
    expect(agent.use).not.toHaveBeenCalled();
  });
});
