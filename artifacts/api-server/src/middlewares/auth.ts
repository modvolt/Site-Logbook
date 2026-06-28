import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@workspace/db";
import { db, webauthnCredentialsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: UserRole;
    name?: string;
    // Anti-CSRF state for the Gmail OAuth connect flow (set on /connect,
    // verified on /callback).
    gmailOAuthState?: string;
    // WebAuthn challenge for in-flight registration / authentication flows.
    webauthnChallenge?: string;
    // Temporary username stored between webauthn login/begin and login/complete.
    webauthnUsername?: string;
    // Unix ms timestamp when the user last passed biometric re-verification.
    // Used by requireBiometricVerified to gate vault access for 5 minutes.
    biometricVerifiedAt?: number;
  }
}

export interface AuthInfo {
  userId: number;
  username: string;
  role: UserRole;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  const s = req.session;
  if (s?.userId && s.role && s.username && s.name) {
    req.auth = { userId: s.userId, username: s.username, role: s.role, name: s.name };
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

const BIOMETRIC_TTL_MS = 5 * 60 * 1000;

/**
 * Require recent biometric verification before proceeding.
 * Skips the check when the user has no WebAuthn credentials registered
 * (so users on non-biometric devices can still access the vault).
 */
export function requireBiometricVerified(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const verifiedAt = req.session?.biometricVerifiedAt;
  if (verifiedAt && Date.now() - verifiedAt < BIOMETRIC_TTL_MS) {
    next();
    return;
  }

  const userId = req.auth.userId;
  db.select({ cnt: count() })
    .from(webauthnCredentialsTable)
    .where(eq(webauthnCredentialsTable.userId, userId))
    .then(([row]) => {
      const cnt = Number(row?.cnt ?? 0);
      if (cnt === 0) {
        next();
        return;
      }
      res.status(403).json({ error: "Biometrické ověření vyžadováno", code: "biometric_required" });
    })
    .catch(() => {
      // On DB error, fail open to prevent permanent lockout
      next();
    });
}
