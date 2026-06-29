/**
 * Unit tests for the @workspace/live-events shared module.
 *
 * Ensures the runtime-accessible domain list, type guard, and payload parser
 * behave correctly without any server or browser dependencies.
 */
import { describe, it, expect } from "vitest";
import {
  LIVE_DOMAINS,
  isLiveDomain,
  parseLiveEventPayload,
  type LiveDomain,
} from "./index";

describe("LIVE_DOMAINS", () => {
  it("contains at least the 16 documented domains", () => {
    expect(LIVE_DOMAINS.length).toBeGreaterThanOrEqual(16);
  });

  it("has no duplicate entries", () => {
    expect(new Set(LIVE_DOMAINS).size).toBe(LIVE_DOMAINS.length);
  });

  it("includes all expected domains", () => {
    const expected: LiveDomain[] = [
      "jobs",
      "activities",
      "warehouse",
      "customers",
      "people",
      "machines",
      "leaves",
      "billingInvoices",
      "billingDocuments",
      "billingRecurringTemplates",
      "bankImport",
      "emailImport",
      "reviewQueue",
      "ppe",
      "quotes",
      "sessions",
    ];
    for (const d of expected) {
      expect(LIVE_DOMAINS).toContain(d);
    }
  });
});

describe("isLiveDomain", () => {
  it("returns true for every entry in LIVE_DOMAINS", () => {
    for (const d of LIVE_DOMAINS) {
      expect(isLiveDomain(d)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isLiveDomain("unknown")).toBe(false);
    expect(isLiveDomain("JOBS")).toBe(false);
    expect(isLiveDomain("Jobs")).toBe(false);
    expect(isLiveDomain("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isLiveDomain(null)).toBe(false);
    expect(isLiveDomain(undefined)).toBe(false);
    expect(isLiveDomain(42)).toBe(false);
    expect(isLiveDomain({})).toBe(false);
    expect(isLiveDomain([])).toBe(false);
  });
});

describe("parseLiveEventPayload", () => {
  it("parses a minimal valid payload", () => {
    const raw = JSON.stringify({
      eventId: 1,
      ts: "2024-01-01T00:00:00.000Z",
      domains: ["jobs"],
    });
    const result = parseLiveEventPayload(raw);
    expect(result).not.toBeNull();
    expect(result!.domains).toEqual(["jobs"]);
    expect(result!.eventId).toBe(1);
  });

  it("parses a full payload with entityIds and originClientId", () => {
    const raw = JSON.stringify({
      eventId: 42,
      ts: "2024-06-01T12:00:00.000Z",
      domains: ["jobs", "warehouse"],
      entityIds: { jobs: [1, 2, 3] },
      originClientId: "abc-123",
    });
    const result = parseLiveEventPayload(raw);
    expect(result).not.toBeNull();
    expect(result!.domains).toEqual(["jobs", "warehouse"]);
    expect(result!.entityIds).toEqual({ jobs: [1, 2, 3] });
    expect(result!.originClientId).toBe("abc-123");
  });

  it("filters out unknown domains but keeps known ones", () => {
    const raw = JSON.stringify({
      eventId: 1,
      ts: "2024-01-01T00:00:00.000Z",
      domains: ["jobs", "UNKNOWN_DOMAIN", "warehouse", null, 42],
    });
    const result = parseLiveEventPayload(raw);
    expect(result).not.toBeNull();
    expect(result!.domains).toEqual(["jobs", "warehouse"]);
  });

  it("returns null when all domains are unknown", () => {
    const raw = JSON.stringify({
      eventId: 1,
      ts: "2024-01-01T00:00:00.000Z",
      domains: ["UNKNOWN", "ALSO_UNKNOWN"],
    });
    expect(parseLiveEventPayload(raw)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseLiveEventPayload("not-json")).toBeNull();
    expect(parseLiveEventPayload("{broken}")).toBeNull();
    expect(parseLiveEventPayload("")).toBeNull();
  });

  it("returns null when domains field is missing", () => {
    expect(parseLiveEventPayload(JSON.stringify({ eventId: 1 }))).toBeNull();
  });

  it("returns null when domains field is not an array", () => {
    expect(
      parseLiveEventPayload(JSON.stringify({ domains: "jobs" })),
    ).toBeNull();
    expect(
      parseLiveEventPayload(JSON.stringify({ domains: null })),
    ).toBeNull();
  });

  it("returns null for non-object JSON values", () => {
    expect(parseLiveEventPayload(JSON.stringify(null))).toBeNull();
    expect(parseLiveEventPayload(JSON.stringify(42))).toBeNull();
    expect(parseLiveEventPayload(JSON.stringify("jobs"))).toBeNull();
    expect(parseLiveEventPayload(JSON.stringify([]))).toBeNull();
  });

  it("defaults eventId to 0 when missing or non-numeric", () => {
    const raw = JSON.stringify({
      ts: "2024-01-01T00:00:00.000Z",
      domains: ["sessions"],
    });
    const result = parseLiveEventPayload(raw);
    expect(result!.eventId).toBe(0);
  });
});
