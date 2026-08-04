import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { auditLogTable, db } from "@workspace/db";

export const SECURITY_AUDIT_CODES = {
  passwordLoginSucceeded: "security.auth.password.login.succeeded",
  passwordLoginDenied: "security.auth.password.login.denied",
  logoutSucceeded: "security.auth.logout.succeeded",
  logoutFailed: "security.auth.logout.failed",
  logoutIdentityRevoked: "security.auth.logout.identity_revoked",
  setupSucceeded: "security.auth.setup.succeeded",
  setupDenied: "security.auth.setup.denied",
  vaultPasswordSucceeded: "security.auth.vault.password.succeeded",
  vaultPasswordDenied: "security.auth.vault.password.denied",
  webauthnLoginSucceeded: "security.auth.webauthn.login.succeeded",
  webauthnLoginDenied: "security.auth.webauthn.login.denied",
  webauthnRegistrationSucceeded:
    "security.auth.webauthn.registration.succeeded",
  webauthnRegistrationDenied: "security.auth.webauthn.registration.denied",
  webauthnVerifySucceeded: "security.auth.webauthn.verify.succeeded",
  webauthnVerifyDenied: "security.auth.webauthn.verify.denied",
  rateLimitExceeded: "security.auth.rate_limit.exceeded",
} as const;

export type SecurityAuditCode =
  (typeof SECURITY_AUDIT_CODES)[keyof typeof SECURITY_AUDIT_CODES];

/** Events that are alert-worthy rather than ordinary successful authentication. */
export const SECURITY_OPERATIONAL_ALERT_ACTIONS: readonly string[] =
  [
    SECURITY_AUDIT_CODES.passwordLoginDenied,
    SECURITY_AUDIT_CODES.logoutFailed,
    SECURITY_AUDIT_CODES.logoutIdentityRevoked,
    SECURITY_AUDIT_CODES.setupSucceeded,
    SECURITY_AUDIT_CODES.setupDenied,
    SECURITY_AUDIT_CODES.vaultPasswordDenied,
    SECURITY_AUDIT_CODES.webauthnLoginDenied,
    SECURITY_AUDIT_CODES.webauthnRegistrationSucceeded,
    SECURITY_AUDIT_CODES.webauthnRegistrationDenied,
    SECURITY_AUDIT_CODES.webauthnVerifyDenied,
    SECURITY_AUDIT_CODES.rateLimitExceeded,
    "security",
    "security_admin_password_reset",
  ];

export type SecurityAuditOutcome =
  | "succeeded"
  | "denied"
  | "failed"
  | "rate_limited";

const SAFE_REASONS = new Set([
  "invalid_request",
  "invalid_credentials",
  "missing_challenge",
  "unknown_credential",
  "verification_failed",
  "session_store_failure",
  "setup_already_completed",
  "limit_exceeded",
]);

const RATE_LIMIT_AUDIT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_RATE_LIMIT_AUDIT_KEYS = 512;
const rateLimitAuditKeys = new Map<string, number>();
const rateLimitAuditInFlight = new Map<string, Promise<void>>();
const MAX_RESPONSE_AUDIT_DEDUPE_KEYS = 1_024;
const responseAuditDedupeKeys = new Map<string, number>();
const responseAuditInFlight = new Map<string, Promise<void>>();

type SecurityAuditInput = {
  code: SecurityAuditCode;
  outcome: SecurityAuditOutcome;
  actorUserId?: number | null;
  reason?: string;
};

async function recordDeduplicatedSecurityAuditEvent(
  req: Request,
  input: SecurityAuditInput,
  key: string,
  persistedKeys: Map<string, number>,
  inFlightKeys: Map<string, Promise<void>>,
  maxKeys: number,
): Promise<void> {
  const now = Date.now();
  for (const [candidate, expiresAt] of persistedKeys) {
    if (expiresAt <= now) persistedKeys.delete(candidate);
  }
  if ((persistedKeys.get(key) ?? 0) > now) return;
  const existing = inFlightKeys.get(key);
  if (existing) {
    await existing;
    return;
  }
  if (persistedKeys.size + inFlightKeys.size >= maxKeys) return;

  const write = (async () => {
    if (await recordSecurityAuditEvent(req, input)) {
      persistedKeys.set(key, Date.now() + RATE_LIMIT_AUDIT_WINDOW_MS);
    }
  })();
  inFlightKeys.set(key, write);
  try {
    await write;
  } finally {
    inFlightKeys.delete(key);
  }
}

function rateLimitAuditKey(req: Request, scope: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(req.ip ?? "unknown")
    .digest("hex");
}

/** Bound durable writes because the limiter handler runs for every rejection. */
export async function recordRateLimitAuditEvent(
  req: Request,
  scope: "password_auth" | "vault_password" | "webauthn",
): Promise<void> {
  const key = rateLimitAuditKey(req, scope);
  await recordDeduplicatedSecurityAuditEvent(
    req,
    {
      code: SECURITY_AUDIT_CODES.rateLimitExceeded,
      outcome: "rate_limited",
      actorUserId: req.auth?.userId ?? null,
      reason: "limit_exceeded",
    },
    key,
    rateLimitAuditKeys,
    rateLimitAuditInFlight,
    MAX_RATE_LIMIT_AUDIT_KEYS,
  );
}

/**
 * Persist a stable security event without attacker-controlled values or request
 * metadata. Authentication must not become unavailable only because this
 * secondary audit write failed, so failures are reduced to a redacted log.
 */
export async function recordSecurityAuditEvent(
  req: Request,
  input: SecurityAuditInput,
): Promise<boolean> {
  const reason =
    input.reason && SAFE_REASONS.has(input.reason) ? input.reason : null;
  try {
    await db.insert(auditLogTable).values({
      actorUserId: input.actorUserId ?? null,
      actorName: null,
      action: input.code,
      entityType: "security_event",
      entityId: null,
      summary: reason
        ? `outcome=${input.outcome};reason=${reason}`
        : `outcome=${input.outcome}`,
      method: req.method,
      path: req.path,
    });
    return true;
  } catch (error) {
    req.log.warn(
      {
        eventCode: input.code,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "Security audit event could not be persisted",
    );
    return false;
  }
}

/**
 * Observe a security-sensitive response without changing the endpoint result.
 * This is useful for WebAuthn handlers with many guarded exits. Only status,
 * stable codes and a server-derived user ID are retained.
 */
export function auditSecurityResponse(options: {
  succeededCode: SecurityAuditCode;
  deniedCode: SecurityAuditCode;
  actorUserId?: (req: Request) => number | null | undefined;
  skipUnauthenticated?: boolean;
  dedupeDeniedByActorAndSource?: boolean;
}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.skipUnauthenticated && !req.auth) {
      next();
      return;
    }
    res.once("finish", () => {
      const succeeded = res.statusCode >= 200 && res.statusCode < 300;
      const actorUserId = options.actorUserId?.(req) ?? null;
      if (!succeeded && options.dedupeDeniedByActorAndSource) {
        const key = createHash("sha256")
          .update(options.deniedCode)
          .update("\0")
          .update(String(actorUserId ?? "anonymous"))
          .update("\0")
          .update(req.ip ?? "unknown")
          .digest("hex");
        void recordDeduplicatedSecurityAuditEvent(
          req,
          {
            code: options.deniedCode,
            outcome: res.statusCode >= 500 ? "failed" : "denied",
            actorUserId: null,
            reason:
              res.statusCode === 400
                ? "invalid_request"
                : "verification_failed",
          },
          key,
          responseAuditDedupeKeys,
          responseAuditInFlight,
          MAX_RESPONSE_AUDIT_DEDUPE_KEYS,
        );
        return;
      }
      void recordSecurityAuditEvent(req, {
        code: succeeded ? options.succeededCode : options.deniedCode,
        outcome: succeeded
          ? "succeeded"
          : res.statusCode >= 500
            ? "failed"
            : "denied",
        actorUserId: succeeded ? actorUserId : null,
        reason: succeeded
          ? undefined
          : res.statusCode === 400
            ? "invalid_request"
            : "verification_failed",
      });
    });
    next();
  };
}
