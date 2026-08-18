import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturePublicGrantLocation,
  clearPublicGrant,
} from "../src/lib/public-grant-bootstrap";
import { MissingPublicGrantError, publicGrantFetch } from "../src/lib/public-grant-fetch";

const token = "T".repeat(43);

beforeEach(() => {
  clearPublicGrant();
  vi.unstubAllGlobals();
});

describe("public grant fetch", () => {
  it("keeps the credential only in a purpose-bound Authorization header", async () => {
    capturePublicGrantLocation(
      { pathname: "/sign", search: "", hash: `#token=${token}` } as Location,
      () => undefined,
    );
    const nativeFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", nativeFetch);

    await publicGrantFetch("job_signature", "/api/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    const [url, init] = nativeFetch.mock.calls[0]!;
    expect(url).toBe("/api/sign");
    expect(String(url)).not.toContain(token);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(init).toEqual(expect.objectContaining({
      cache: "no-store",
      credentials: "omit",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }));
    expect(String(init?.body)).not.toContain(token);
  });

  it("fails closed for a missing or wrong-purpose in-memory grant", () => {
    expect(() => publicGrantFetch("quote", "/api/quotes/public"))
      .toThrow(MissingPublicGrantError);
  });

  it("rejects a caller-supplied Authorization header", () => {
    capturePublicGrantLocation(
      { pathname: "/q/board", search: "", hash: token } as Location,
      () => undefined,
    );
    expect(() => publicGrantFetch("switchboard", "/api/q/board", {
      headers: { Authorization: "Bearer other" },
    })).toThrow("already contains Authorization");
  });

  it("rejects cross-origin and wrong-family destinations before attaching the grant", () => {
    capturePublicGrantLocation(
      { pathname: "/sign", search: "", hash: token } as Location,
      () => undefined,
    );

    expect(() => publicGrantFetch("job_signature", "https://evil.example/api/sign"))
      .toThrow("outside its allowed API family");
    expect(() => publicGrantFetch("job_signature", "/api/quotes/public"))
      .toThrow("outside its allowed API family");
    expect(() => publicGrantFetch("job_signature", "/api/sign", { method: "DELETE" }))
      .toThrow("outside its allowed API family");
    expect(() => publicGrantFetch("job_signature", `/api/sign/${token}`))
      .toThrow("outside its allowed API family");
    expect(() => publicGrantFetch("job_signature", `/api/sign?token=${token}`))
      .toThrow("outside its allowed API family");
  });
});
