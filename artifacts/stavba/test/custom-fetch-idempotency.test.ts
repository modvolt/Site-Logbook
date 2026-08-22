import { afterEach, describe, expect, it, vi } from "vitest";
import { customFetch } from "../../../lib/api-client-react/src/custom-fetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("customFetch mutation idempotency", () => {
  it("adds a generated Idempotency-Key to a PATCH request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );

    await customFetch("http://localhost/api/users/7", {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated user" }),
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("preserves an explicitly supplied Idempotency-Key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await customFetch("http://localhost/api/users/7", {
      method: "PATCH",
      headers: { "Idempotency-Key": "explicit-operation-123" },
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("explicit-operation-123");
  });
});
