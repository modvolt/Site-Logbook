import type { Request, Response, NextFunction } from "express";
import type { Permission, UserAccountType, UserRole } from "@workspace/db";
import { getUserAuthorization } from "../lib/permissions";
import { destroySession } from "../lib/auth-session";
import { hasRecentVaultStepUp } from "../lib/vault-step-up-policy";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: UserRole;
    accountType?: UserAccountType;
    name?: string;
    sessionGeneration?: number;
    // Anti-CSRF state for the Gmail OAuth connect flow (set on /connect,
    // verified on /callback).
    gmailOAuthState?: string;
    // WebAuthn challenge for in-flight registration / authentication flows.
    webauthnChallenge?: string;
    // Temporary username stored between webauthn login/begin and login/complete.
    webauthnUsername?: string;
    // Legacy timestamp retained only so a new step-up can remove it safely.
    biometricVerifiedAt?: number;
    // Unix ms timestamp when this session last passed password or WebAuthn
    // re-verification for plaintext vault access.
    vaultVerifiedAt?: number;
  }
}

export interface AuthInfo {
  userId: number;
  username: string;
  role: UserRole;
  accountType: UserAccountType;
  name: string;
  personId: number | null;
  permissions: Permission[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

export async function attachAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const s = req.session;
  if (s?.userId && s.role && s.username && s.name) {
    try {
      const authorization = await getUserAuthorization(s.userId);
      if (!authorization) {
        await destroySession(req).catch(() => undefined);
        res.clearCookie("stavba.sid");
        next();
        return;
      }
      const { user, permissions } = authorization;
      if (s.sessionGeneration !== user.sessionGeneration) {
        await destroySession(req).catch(() => undefined);
        res.clearCookie("stavba.sid");
        next();
        return;
      }
      s.username = user.username;
      s.role = user.role as UserRole;
      s.accountType = user.accountType as UserAccountType;
      s.name = user.name;
      req.auth = {
        userId: user.id,
        username: user.username,
        role: user.role as UserRole,
        accountType: user.accountType as UserAccountType,
        name: user.name,
        personId: user.personId,
        permissions,
      };
    } catch (error) {
      next(error);
      return;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export function requireWriteAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.auth.role === "guest") {
    res.status(403).json({ error: "Guests cannot modify data" });
    return;
  }
  next();
}

/**
 * Require a recent session-bound password or WebAuthn re-verification.
 * This check has no database fallback: missing, expired, malformed or future
 * timestamps all fail closed. The legacy `biometric_required` code is kept so
 * cached PWA clients from the previous release still display their gate.
 */
export function requireVaultStepUp(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const verifiedAt = req.session?.vaultVerifiedAt;
  if (hasRecentVaultStepUp(verifiedAt)) {
    next();
    return;
  }

  if (req.session) {
    delete req.session.vaultVerifiedAt;
    delete req.session.biometricVerifiedAt;
  }
  res.status(403).json({
    error: "Opětovné ověření pro přístup do trezoru je vyžadováno",
    code: "biometric_required",
    supportedMethods: ["webauthn", "password"],
  });
}
