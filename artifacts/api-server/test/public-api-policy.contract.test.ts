import { describe, expect, it } from "vitest";
import { isPublicApiRequest } from "../src/lib/public-api-policy";
import { secureTokenEqual } from "../src/lib/internal-auth";
import {
  hasRecentVaultStepUp,
  VAULT_STEP_UP_TTL_MS,
} from "../src/lib/vault-step-up-policy";

describe("explicit public API policy", () => {
  const publicRequests = [
    ["GET", "/api/healthz"],
    ["HEAD", "/api/healthz/"],
    ["GET", "/api/auth/me?refresh=1"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/auth/setup"],
    ["POST", "/api/auth/webauthn/login/begin"],
    ["POST", "/api/auth/webauthn/login/complete"],
    ["GET", "/api/storage/public-objects/logo/example.png"],
    ["GET", "/api/ppe/sign/token"],
    ["POST", "/api/ppe/sign/token"],
    ["GET", "/api/sign/token"],
    ["POST", "/api/sign/token"],
    ["GET", "/api/quotes/public/token"],
    ["POST", "/api/quotes/public/token/accept"],
    ["POST", "/api/quotes/public/token/reject"],
    ["GET", "/api/q/board/token"],
    ["GET", `/api/q/board/token/documents/${"a".repeat(64)}`],
    ["POST", "/api/internal/backup-trigger"],
  ] as const;

  for (const [method, path] of publicRequests) {
    it(`allows ${method} ${path}`, () => {
      expect(isPublicApiRequest(method, path)).toBe(true);
    });
  }

  const privateNearMisses = [
    ["GET", "/api/auth/future-route"],
    ["POST", "/api/auth/webauthn/register/begin"],
    ["POST", "/api/auth/vault/verify-password"],
    ["GET", "/api/storage/public-objects"],
    ["DELETE", "/api/sign/token"],
    ["POST", "/api/quotes/public/token"],
    ["GET", "/api/internal/backup-trigger"],
    ["POST", "/api/internal/future-admin-action"],
    ["GET", "/api/internal/backup-trigger/extra"],
    ["GET", "/api/q/board/token/private"],
  ] as const;

  for (const [method, path] of privateNearMisses) {
    it(`keeps ${method} ${path} private`, () => {
      expect(isPublicApiRequest(method, path)).toBe(false);
    });
  }
});

describe("internal bearer comparison", () => {
  it("accepts only the same non-empty token", () => {
    expect(secureTokenEqual("test-secret-123", "test-secret-123")).toBe(true);
    expect(secureTokenEqual("test-secret-123", "test-secret-124")).toBe(false);
    expect(secureTokenEqual("short", "a-different-length-secret")).toBe(false);
    expect(secureTokenEqual("", "")).toBe(false);
  });
});

describe("vault step-up timestamp policy", () => {
  const now = 2_000_000_000_000;

  it("accepts only a recent finite server timestamp", () => {
    expect(hasRecentVaultStepUp(now - VAULT_STEP_UP_TTL_MS + 1, now)).toBe(true);
    expect(hasRecentVaultStepUp(now - VAULT_STEP_UP_TTL_MS, now)).toBe(false);
    expect(hasRecentVaultStepUp(now + 1, now)).toBe(false);
    expect(hasRecentVaultStepUp(undefined, now)).toBe(false);
    expect(hasRecentVaultStepUp(Number.NaN, now)).toBe(false);
  });
});
