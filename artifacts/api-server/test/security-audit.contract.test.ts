import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const valuesMock = vi.fn();
const root = resolve(import.meta.dirname, "..", "..", "..");

vi.mock("@workspace/db", () => ({
  auditLogTable: {},
  db: {
    insert: vi.fn(() => ({ values: valuesMock })),
  },
}));

import {
  recordRateLimitAuditEvent,
  recordSecurityAuditEvent,
  SECURITY_AUDIT_CODES,
  SECURITY_OPERATIONAL_ALERT_ACTIONS,
} from "../src/lib/security-audit";

function fakeRequest(ip = "198.51.100.24") {
  return {
    method: "POST",
    path: "/auth/login",
    ip,
    log: { warn: vi.fn() },
  } as any;
}

describe("redacted security audit events", () => {
  beforeEach(() => {
    valuesMock.mockReset();
    valuesMock.mockResolvedValue(undefined);
  });

  it("persists only stable allowlisted fields and never an actor name", async () => {
    const req = fakeRequest();
    await recordSecurityAuditEvent(req, {
      code: SECURITY_AUDIT_CODES.passwordLoginDenied,
      outcome: "denied",
      reason: "invalid_credentials",
    });

    expect(valuesMock).toHaveBeenCalledWith({
      actorUserId: null,
      actorName: null,
      action: "security.auth.password.login.denied",
      entityType: "security_event",
      entityId: null,
      summary: "outcome=denied;reason=invalid_credentials",
      method: "POST",
      path: "/auth/login",
    });
    expect(JSON.stringify(valuesMock.mock.calls)).not.toMatch(
      /passwordHash|username|user-agent|authorization|sessionId|cookie/i,
    );
  });

  it("drops non-allowlisted reasons instead of persisting attacker-controlled text", async () => {
    await recordSecurityAuditEvent(fakeRequest(), {
      code: SECURITY_AUDIT_CODES.passwordLoginDenied,
      outcome: "denied",
      reason: "username=attacker-controlled@example.invalid",
    });

    expect(valuesMock.mock.calls[0]?.[0]?.summary).toBe("outcome=denied");
  });

  it("does not fail authentication when the secondary audit write fails", async () => {
    const req = fakeRequest();
    valuesMock.mockRejectedValueOnce(new Error("postgres host details"));

    await expect(
      recordSecurityAuditEvent(req, {
        code: SECURITY_AUDIT_CODES.passwordLoginSucceeded,
        outcome: "succeeded",
        actorUserId: 42,
      }),
    ).resolves.toBe(false);
    expect(req.log.warn).toHaveBeenCalledWith(
      {
        eventCode: SECURITY_AUDIT_CODES.passwordLoginSucceeded,
        errorName: "Error",
      },
      "Security audit event could not be persisted",
    );
  });

  it("alerts on adverse auth outcomes but not ordinary successful login or logout", () => {
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).toContain(
      SECURITY_AUDIT_CODES.passwordLoginDenied,
    );
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).toContain(
      SECURITY_AUDIT_CODES.rateLimitExceeded,
    );
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).toContain("security");
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).toContain(
      "security_admin_password_reset",
    );
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).not.toContain(
      SECURITY_AUDIT_CODES.passwordLoginSucceeded,
    );
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).not.toContain(
      SECURITY_AUDIT_CODES.logoutSucceeded,
    );
    expect(SECURITY_OPERATIONAL_ALERT_ACTIONS).not.toContain(
      SECURITY_AUDIT_CODES.vaultPasswordSucceeded,
    );
  });

  it("deduplicates repeated limiter rejections for the same source and scope", async () => {
    const req = fakeRequest();
    await recordRateLimitAuditEvent(req, "password_auth");
    await recordRateLimitAuditEvent(req, "password_auth");

    expect(valuesMock).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: SECURITY_AUDIT_CODES.rateLimitExceeded,
        summary: "outcome=rate_limited;reason=limit_exceeded",
      }),
    );
  });

  it("does not confirm a dedupe window until the durable write succeeds", async () => {
    const req = fakeRequest("198.51.100.25");
    valuesMock.mockRejectedValueOnce(new Error("transient database failure"));

    await recordRateLimitAuditEvent(req, "vault_password");
    await recordRateLimitAuditEvent(req, "vault_password");

    expect(valuesMock).toHaveBeenCalledTimes(2);
    expect(valuesMock.mock.calls[1]?.[0]).toMatchObject({
      action: SECURITY_AUDIT_CODES.rateLimitExceeded,
      summary: "outcome=rate_limited;reason=limit_exceeded",
    });
  });

  it("uses one route-owned vault audit and marks identity-revoked logout fallback", () => {
    const vault = readFileSync(
      resolve(root, "artifacts/api-server/src/lib/vault-step-up.ts"),
      "utf8",
    );
    const auth = readFileSync(
      resolve(root, "artifacts/api-server/src/routes/auth.ts"),
      "utf8",
    );

    expect(vault).not.toMatch(/auditLogTable|actorName|entityId|\.insert\(/);
    expect(auth).toContain("logoutResult === \"identity-revoked\"");
    expect(auth).toContain("SECURITY_AUDIT_CODES.logoutIdentityRevoked");
  });
});
