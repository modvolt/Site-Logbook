import { describe, expect, it } from "vitest";
import {
  clearExternalAccountLifecycleIntent,
  createExternalAccountLifecycleRequester,
  ExternalAccountLifecycleError,
  type StorageLike,
} from "../src/lib/external-account-idempotency";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  serializedValues() {
    return [...this.values.values()].join("\n");
  }
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function idempotencyKey(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("Idempotency-Key");
}

describe("external account lifecycle idempotency", () => {
  it("retries a transport failure with the same key and clears it on success", async () => {
    const storage = new MemoryStorage();
    const keys: Array<string | null> = [];
    let attempts = 0;
    const request = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0001",
      sleep: async () => undefined,
      fetchImpl: async (_input, init) => {
        keys.push(idempotencyKey(init));
        attempts += 1;
        if (attempts === 1) throw new TypeError("connection reset");
        return jsonResponse(201, { userId: 41 });
      },
    });

    await expect(
      request<{ userId: number }>("/external-accounts", "POST", {
        username: "vendor-one",
        password: "not-persisted-secret",
      }),
    ).resolves.toEqual({ userId: 41 });

    expect(keys).toEqual(["request-key-0001", "request-key-0001"]);
    expect(storage.serializedValues()).toBe("");
  });

  it("keeps the same key across a later requester after transport uncertainty", async () => {
    const storage = new MemoryStorage();
    const keys: Array<string | null> = [];
    const failingRequest = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0002",
      sleep: async () => undefined,
      fetchImpl: async (_input, init) => {
        keys.push(idempotencyKey(init));
        throw new TypeError("offline");
      },
    });

    await expect(
      failingRequest("/external-accounts/7/activate", "POST", {
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_transport_unknown",
      reconciliationRequired: false,
    });

    const resumedRequest = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => {
        throw new Error("a retained intent must not allocate a new key");
      },
      fetchImpl: async (_input, init) => {
        keys.push(idempotencyKey(init));
        return jsonResponse(200, { status: "active" });
      },
    });

    await expect(
      resumedRequest("/external-accounts/7/activate", "POST", {
        expectedVersion: 2,
      }),
    ).resolves.toEqual({ status: "active" });
    expect(keys).toEqual([
      "request-key-0002",
      "request-key-0002",
      "request-key-0002",
    ]);
    expect(storage.serializedValues()).toBe("");
  });

  it("blocks ambiguous replay until the operator explicitly clears the intent", async () => {
    const storage = new MemoryStorage();
    const keys: Array<string | null> = [];
    let fetches = 0;
    const request = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0003",
      fetchImpl: async (_input, init) => {
        fetches += 1;
        keys.push(idempotencyKey(init));
        return jsonResponse(500, { error: "unknown result" });
      },
    });

    await expect(
      request("/external-accounts/9/revoke", "POST", {
        expectedVersion: 5,
        reason: "duplicate vendor",
      }),
    ).rejects.toBeInstanceOf(ExternalAccountLifecycleError);
    await expect(
      request("/external-accounts/9/revoke", "POST", {
        expectedVersion: 5,
        reason: "duplicate vendor",
      }),
    ).rejects.toMatchObject({
      code: "idempotency_ambiguous",
      reconciliationRequired: true,
    });
    expect(fetches).toBe(1);

    clearExternalAccountLifecycleIntent(
      "POST",
      "/external-accounts/9/revoke",
      storage,
    );
    const clearedRequest = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0004",
      fetchImpl: async (_input, init) => {
        fetches += 1;
        keys.push(idempotencyKey(init));
        return jsonResponse(200, { status: "revoked" });
      },
    });

    await expect(
      clearedRequest("/external-accounts/9/revoke", "POST", {
        expectedVersion: 5,
        reason: "duplicate vendor",
      }),
    ).resolves.toEqual({ status: "revoked" });
    expect(keys).toEqual(["request-key-0003", "request-key-0004"]);
  });

  it("never persists request bodies, credentials, or body hashes", async () => {
    const storage = new MemoryStorage();
    const request = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0005",
      sleep: async () => undefined,
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });

    await expect(
      request("/external-accounts", "POST", {
        username: "secret-vendor",
        password: "very-secret-password",
      }),
    ).rejects.toBeInstanceOf(ExternalAccountLifecycleError);

    const persisted = storage.serializedValues();
    expect(persisted).toContain("request-key-0005");
    expect(persisted).not.toContain("secret-vendor");
    expect(persisted).not.toContain("very-secret-password");
    expect(persisted).not.toContain("body");
    expect(Object.keys(JSON.parse(persisted)).sort()).toEqual([
      "idempotencyKey",
      "state",
      "version",
    ]);
  });

  it("treats a malformed retained intent as ambiguous instead of allocating a new key", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "modvolt.external-account-idempotency.v1:POST:/external-accounts/11/activate",
      '{"version":1,"idempotencyKey":"truncated',
    );
    let fetches = 0;
    const request = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-should-not-be-created",
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse(200, { status: "active" });
      },
    });

    await expect(
      request("/external-accounts/11/activate", "POST", {
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_intent_invalid",
      reconciliationRequired: true,
    });
    expect(fetches).toBe(0);
  });

  it("retains the key across biometric step-up and removes it on deterministic rejection", async () => {
    const storage = new MemoryStorage();
    const keys: Array<string | null> = [];
    const biometricRequest = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => "request-key-0006",
      fetchImpl: async (_input, init) => {
        keys.push(idempotencyKey(init));
        return jsonResponse(403, {
          code: "biometric_required",
          error: "step-up required",
        });
      },
    });
    await expect(
      biometricRequest("/external-accounts/12/scopes", "PUT", {
        expectedVersion: 1,
        scopes: [],
      }),
    ).rejects.toMatchObject({ code: "biometric_required" });

    const rejectedRequest = createExternalAccountLifecycleRequester({
      storage,
      randomUUID: () => {
        throw new Error("biometric retry must retain the key");
      },
      fetchImpl: async (_input, init) => {
        keys.push(idempotencyKey(init));
        return jsonResponse(400, {
          code: "invalid_scope",
          error: "invalid scope",
        });
      },
    });
    await expect(
      rejectedRequest("/external-accounts/12/scopes", "PUT", {
        expectedVersion: 1,
        scopes: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });

    expect(keys).toEqual(["request-key-0006", "request-key-0006"]);
    expect(storage.serializedValues()).toBe("");
  });
});
