import { describe, expect, it, vi } from "vitest";
import {
  beginIdentityRequestTransition,
  identityFetchStateForTest,
  installIdentityFetchGuard,
} from "../src/lib/identity-fetch";

describe("identity fetch guard", () => {
  it("learns /me scope, binds private traffic, and blocks it synchronously during transition", async () => {
    const scope = "a".repeat(64);
    let meResponse: Record<string, unknown> = {
      authenticated: true,
      offlineScope: scope,
      cacheMode: "offline-scoped",
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (new URL(url, "http://127.0.0.1:4173").pathname === "/api/auth/me") {
        return new Response(JSON.stringify(meResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const fakeWindow = Object.assign(new EventTarget(), {
      location: new URL("http://127.0.0.1:4173/"),
      fetch: nativeFetch,
    });
    vi.stubGlobal("window", fakeWindow);

    installIdentityFetchGuard();
    await window.fetch("/api/auth/me");
    expect(identityFetchStateForTest()).toEqual({ scope, networkOnly: false, transitionActive: false });

    await window.fetch("/api/jobs/42");
    expect(new Headers(calls.at(-1)?.init?.headers).get("x-stavba-offline-scope")).toBe(scope);

    beginIdentityRequestTransition();
    const callCount = calls.length;
    await expect(window.fetch("/api/jobs/42")).rejects.toThrow("identity is unverified");
    expect(calls).toHaveLength(callCount);

    await expect(window.fetch("/api/auth/logout", { method: "POST" })).resolves.toBeInstanceOf(Response);
    await expect(window.fetch("/api/sign", {
      headers: { Authorization: `Bearer ${"x".repeat(43)}` },
    })).resolves.toBeInstanceOf(Response);
    expect(new Headers(calls.at(-1)?.init?.headers).has("x-stavba-offline-scope")).toBe(false);

    meResponse = { authenticated: true, cacheMode: "network-only" };
    await window.fetch("/api/auth/me");
    expect(identityFetchStateForTest()).toEqual({
      scope: null,
      networkOnly: true,
      transitionActive: false,
    });
    await window.fetch("/api/portal/resources");
    expect(new Headers(calls.at(-1)?.init?.headers).has("x-stavba-offline-scope")).toBe(false);
  });
});
