import { describe, expect, it } from "vitest";
import {
  apiCacheName,
  isManagedApiCacheName,
  isOfflineCacheableApiPath,
  isValidOfflineScope,
} from "../src/lib/offline-cache-policy";

describe("identity-partitioned offline API cache", () => {
  it.each([
    "/api/jobs",
    "/api/jobs/calendar",
    "/api/jobs/42",
    "/api/jobs/42/tasks",
    "/api/jobs/42/materials",
    "/api/jobs/42/time-entries",
    "/api/switchboards",
    "/api/switchboards/9/checklist",
  ])("allows the minimum field read model: %s", (pathname) => {
    expect(isOfflineCacheableApiPath(pathname)).toBe(true);
  });

  it.each([
    "/api/auth/me",
    "/api/auth/vault/status",
    "/api/sessions",
    "/api/billing/invoices",
    "/api/storage/objects/uploads/private",
    "/api/events",
    "/api/jobs/42/documents",
    "/api/switchboards/9/documents",
    "/api/jobs/42/future-sensitive-data",
    "/api/future-module",
  ])("keeps sensitive and unknown routes out of Cache Storage: %s", (pathname) => {
    expect(isOfflineCacheableApiPath(pathname)).toBe(false);
  });

  it("accepts only opaque server scopes and recognizes managed cache names", () => {
    const scope = "a".repeat(64);
    expect(isValidOfflineScope(scope)).toBe(true);
    expect(isValidOfflineScope("user-7")).toBe(false);
    expect(apiCacheName(scope)).toBe(`stavba-api-v2-${scope}`);
    expect(isManagedApiCacheName("stavba-api")).toBe(true);
    expect(isManagedApiCacheName(apiCacheName(scope))).toBe(true);
    expect(isManagedApiCacheName("workbox-precache-v2")).toBe(false);
  });
});
