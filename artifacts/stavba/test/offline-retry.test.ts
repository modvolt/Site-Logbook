import { describe, expect, it } from "vitest";
import {
  OfflineReplayError,
  canManuallyRetryOfflineFailure,
  classifyReplayFailure,
  normalizeReplayError,
  offlineBackoffMs,
  throwReplayResponse,
} from "../src/lib/offline-retry";

describe("offline replay failure policy", () => {
  it.each([
    [401, undefined, "auth"],
    [409, "offline_scope_mismatch", "auth"],
    [409, "idempotency_in_progress", "transient"],
    [503, "idempotency_unavailable", "transient"],
    [409, "idempotency_ambiguous", "ambiguous"],
    [409, "idempotency_key_reused", "permanent"],
    [400, "idempotency_key_required", "permanent"],
    [400, "offline_content_digest_mismatch", "permanent"],
    [409, undefined, "conflict"],
    [422, undefined, "permanent"],
    [500, undefined, "transient"],
  ] as const)("classifies HTTP %s / %s as %s", (status, code, expected) => {
    expect(classifyReplayFailure(status, code)).toBe(expected);
  });

  it("uses capped exponential backoff with bounded jitter", () => {
    expect(offlineBackoffMs(1, undefined, () => 0.5)).toBe(1_000);
    expect(offlineBackoffMs(2, undefined, () => 0.5)).toBe(2_000);
    expect(offlineBackoffMs(20, undefined, () => 0.5)).toBe(30_000);
    expect(offlineBackoffMs(1, 90_000, () => 0)).toBe(30_000);
  });

  it("extracts a structured server code and Retry-After", async () => {
    const response = new Response(
      JSON.stringify({ error: "Operace se zpracovává", code: "idempotency_in_progress" }),
      { status: 409, headers: { "Content-Type": "application/json", "Retry-After": "2" } },
    );

    await expect(throwReplayResponse(response)).rejects.toMatchObject({
      name: "OfflineReplayError",
      kind: "transient",
      code: "idempotency_in_progress",
      retryAfterMs: 2_000,
    });
  });

  it("treats network failures as transient but unknown local errors as permanent", () => {
    expect(normalizeReplayError(new TypeError("offline"))).toMatchObject({ kind: "transient" });
    expect(normalizeReplayError(new Error("missing blob"))).toMatchObject({ kind: "permanent" });
    const original = new OfflineReplayError("conflict", "conflict", 409);
    expect(normalizeReplayError(original)).toBe(original);
  });

  it("allows manual replay only for a transient result with the same durable key", () => {
    expect(canManuallyRetryOfflineFailure("transient")).toBe(true);
    expect(canManuallyRetryOfflineFailure(undefined)).toBe(true);
    expect(canManuallyRetryOfflineFailure("conflict")).toBe(false);
    expect(canManuallyRetryOfflineFailure("permanent")).toBe(false);
    expect(canManuallyRetryOfflineFailure("ambiguous")).toBe(false);
    expect(canManuallyRetryOfflineFailure("auth")).toBe(false);
  });
});
