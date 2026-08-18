import { describe, expect, it, vi } from "vitest";
import { offlineBlobSha256, verifyOfflineReplayIdentity } from "../src/lib/offline-replay";

const owner = { userId: 7, scope: "a".repeat(64) };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("offline replay identity verification", () => {
  it("creates a stable SHA-256 digest for raw offline uploads", async () => {
    await expect(offlineBlobSha256(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("bypasses caches and accepts only the exact live owner", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ authenticated: true, offlineScope: owner.scope, user: { id: owner.userId } }),
    );

    await expect(verifyOfflineReplayIdentity(owner, fetcher as typeof fetch)).resolves.toBe("verified");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it.each([
    [{ authenticated: true, offlineScope: "b".repeat(64), user: { id: 7 } }, "scope_mismatch"],
    [{ authenticated: true, offlineScope: owner.scope, user: { id: 8 } }, "scope_mismatch"],
    [{ authenticated: false }, "unauthenticated"],
  ] as const)("rejects a non-matching response", async (body, expected) => {
    const fetcher = vi.fn(async () => jsonResponse(body));
    await expect(verifyOfflineReplayIdentity(owner, fetcher as typeof fetch)).resolves.toBe(expected);
  });

  it("pauses rather than replaying when identity verification is unavailable", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(verifyOfflineReplayIdentity(owner, fetcher as typeof fetch)).resolves.toBe("unavailable");
  });
});
