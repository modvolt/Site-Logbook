import { describe, expect, it, vi } from "vitest";
import { uploadObjectFile } from "../../../lib/object-storage-web/src/upload-object-file";
import { fetchJson } from "../src/lib/job-groups-api";
import {
  switchboardFetch,
  uploadSwitchboardPhoto,
} from "../src/lib/switchboards-api";
import {
  beginIdentityRequestTransition,
  identityFetchStateForTest,
  installIdentityFetchGuard,
} from "../src/lib/identity-fetch";

const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";
const IDEMPOTENCY_HEADER = "idempotency-key";
const CONTENT_SHA256_HEADER = "x-stavba-content-sha256";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("identity fetch guard", () => {
  it("binds every private mutation while preserving public and transition boundaries", async () => {
    const scope = "a".repeat(64);
    let meResponse: Record<string, unknown> = {
      authenticated: true,
      offlineScope: scope,
      cacheMode: "offline-scoped",
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const nativeFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init });
        if (new URL(url, "http://127.0.0.1:4173").pathname === "/api/auth/me") {
          return new Response(JSON.stringify(meResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (
          new URL(url, "http://127.0.0.1:4173").pathname ===
          "/api/storage/uploads"
        ) {
          return new Response(
            JSON.stringify({
              objectPath: "uploads/site-photo.bin",
              metadata: {
                name: "site-photo.bin",
                size: 4,
                contentType: "application/octet-stream",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const fakeWindow = Object.assign(new EventTarget(), {
      location: new URL("http://127.0.0.1:4173/"),
      fetch: nativeFetch,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("window", fakeWindow);

    installIdentityFetchGuard();
    vi.stubGlobal("fetch", window.fetch);
    await window.fetch("/api/auth/me");
    expect(identityFetchStateForTest()).toEqual({
      scope,
      networkOnly: false,
      transitionActive: false,
    });

    await window.fetch("/api/jobs/42");
    expect(
      new Headers(calls.at(-1)?.init?.headers).get(OFFLINE_SCOPE_HEADER),
    ).toBe(scope);

    const generatedKeys = new Set<string>();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await window.fetch(`/api/private-${method.toLowerCase()}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      const headers = new Headers(calls.at(-1)?.init?.headers);
      const key = headers.get(IDEMPOTENCY_HEADER);
      expect(key).toMatch(/^[0-9a-f-]{36}$/i);
      generatedKeys.add(key!);
      expect(headers.get(OFFLINE_SCOPE_HEADER)).toBe(scope);
      expect(headers.has(CONTENT_SHA256_HEADER)).toBe(false);
    }
    expect(generatedKeys.size).toBe(4);

    await window.fetch("/api/private-explicit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "offline-replay-key-123",
      },
      body: "{}",
    });
    expect(
      new Headers(calls.at(-1)?.init?.headers).get(IDEMPOTENCY_HEADER),
    ).toBe("offline-replay-key-123");

    const backingBytes = new Uint8Array([99, 1, 2, 3, 4, 88]);
    const exactView = new Uint8Array(backingBytes.buffer, 1, 4);
    const expectedDigest = await sha256Hex(new Uint8Array([1, 2, 3, 4]));
    await window.fetch("/api/private-binary", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: exactView,
    });
    const binaryHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(binaryHeaders.get(CONTENT_SHA256_HEADER)).toBe(expectedDigest);
    expect(binaryHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();

    await window.fetch("/api/offline/replay", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Idempotency-Key": "deterministic-offline-key",
        "X-Stavba-Content-SHA256": "b".repeat(64),
        "X-Stavba-Offline-Scope": scope,
      },
      body: new Blob([new Uint8Array([7, 8, 9])]),
    });
    const replayHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(replayHeaders.get(IDEMPOTENCY_HEADER)).toBe(
      "deterministic-offline-key",
    );
    expect(replayHeaders.get(CONTENT_SHA256_HEADER)).toBe("b".repeat(64));
    expect(replayHeaders.get(OFFLINE_SCOPE_HEADER)).toBe(scope);

    let releaseDigest!: (bytes: ArrayBuffer) => void;
    const digestPending = new Promise<ArrayBuffer>((resolve) => {
      releaseDigest = resolve;
    });
    class DelayedBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return digestPending;
      }
    }
    const callCountBeforeDigest = calls.length;
    const delayedMutation = window.fetch("/api/private-delayed-binary", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new DelayedBlob(),
    });
    await Promise.resolve();
    beginIdentityRequestTransition();
    releaseDigest(new Uint8Array([4, 3, 2, 1]).buffer);
    await expect(delayedMutation).rejects.toThrow("identity is unverified");
    expect(calls).toHaveLength(callCountBeforeDigest);
    await window.fetch("/api/auth/me");

    const uploadBytes = new Uint8Array([10, 20, 30, 40]);
    const uploadFile = new File([uploadBytes], "site-photo.bin", {
      type: "application/octet-stream",
    });
    await uploadObjectFile("/api/storage", uploadFile);
    const uploadCall = calls.at(-1)!;
    expect(uploadCall.url).toContain("/api/storage/uploads?");
    const uploadHeaders = new Headers(uploadCall.init?.headers);
    expect(uploadHeaders.get(OFFLINE_SCOPE_HEADER)).toBe(scope);
    expect(uploadHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();
    expect(uploadHeaders.get(CONTENT_SHA256_HEADER)).toBe(
      await sha256Hex(uploadBytes),
    );

    await uploadSwitchboardPhoto(
      7,
      new Blob([new Uint8Array([5, 6, 7])], { type: "image/jpeg" }),
      { category: "assembly" },
    );
    let routeHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(calls.at(-1)?.url).toContain("/api/switchboards/7/photos?");
    expect(routeHeaders.get(OFFLINE_SCOPE_HEADER)).toBe(scope);
    expect(routeHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();
    expect(routeHeaders.get(CONTENT_SHA256_HEADER)).toBe(
      await sha256Hex(new Uint8Array([5, 6, 7])),
    );

    await switchboardFetch("/api/switchboards/7/checklist/start", {
      method: "POST",
    });
    routeHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(routeHeaders.get(OFFLINE_SCOPE_HEADER)).toBe(scope);
    expect(routeHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();

    await fetchJson("/api/job-groups", {
      method: "POST",
      body: JSON.stringify({ name: "Servis" }),
    });
    routeHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(routeHeaders.get(OFFLINE_SCOPE_HEADER)).toBe(scope);
    expect(routeHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();

    for (const [url, init] of [
      ["/api/auth/login", { method: "POST" }],
      ["/api/auth/logout", { method: "POST" }],
      [
        "/api/sign",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${"x".repeat(43)}` },
        },
      ],
      ["https://uploads.example.test/file", { method: "POST" }],
    ] satisfies Array<[string, RequestInit]>) {
      await window.fetch(url, init);
      const headers = new Headers(calls.at(-1)?.init?.headers);
      expect(headers.has(OFFLINE_SCOPE_HEADER)).toBe(false);
      expect(headers.has(IDEMPOTENCY_HEADER)).toBe(false);
      expect(headers.has(CONTENT_SHA256_HEADER)).toBe(false);
    }

    beginIdentityRequestTransition();
    const callCount = calls.length;
    await expect(
      window.fetch("/api/jobs/42", { method: "PATCH", body: "{}" }),
    ).rejects.toThrow("identity is unverified");
    expect(calls).toHaveLength(callCount);

    await expect(
      window.fetch("/api/auth/logout", { method: "POST" }),
    ).resolves.toBeInstanceOf(Response);
    expect(
      new Headers(calls.at(-1)?.init?.headers).has(OFFLINE_SCOPE_HEADER),
    ).toBe(false);

    meResponse = { authenticated: true, cacheMode: "network-only" };
    await window.fetch("/api/auth/me");
    expect(identityFetchStateForTest()).toEqual({
      scope: null,
      networkOnly: true,
      transitionActive: false,
    });
    await window.fetch("/api/portal/resources", { method: "POST" });
    const networkOnlyHeaders = new Headers(calls.at(-1)?.init?.headers);
    expect(networkOnlyHeaders.has(OFFLINE_SCOPE_HEADER)).toBe(false);
    expect(networkOnlyHeaders.get(IDEMPOTENCY_HEADER)).toBeTruthy();
  });
});
