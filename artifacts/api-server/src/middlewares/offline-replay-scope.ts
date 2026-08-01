import type { NextFunction, Request, Response } from "express";
import { createOfflineIdentityScope } from "../lib/offline-identity";

export const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";

/**
 * Bind a replayed mutation to the identity epoch that originally queued it.
 * This closes the race between the client's live /auth/me check and the
 * mutation itself (for example when another tab logs in as a different user).
 */
export function enforceOfflineReplayScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const suppliedScope = req.get(OFFLINE_SCOPE_HEADER);
  if (!suppliedScope) {
    next();
    return;
  }
  if (!req.auth || !Number.isInteger(req.session.sessionGeneration)) {
    res.status(401).json({ error: "Unauthorized", code: "offline_identity_unavailable" });
    return;
  }
  const expectedScope = createOfflineIdentityScope({
    userId: req.auth.userId,
    sessionGeneration: req.session.sessionGeneration!,
    role: req.auth.role,
    permissions: req.auth.permissions,
  });
  if (suppliedScope !== expectedScope) {
    res.status(409).json({ error: "Offline identity changed", code: "offline_scope_mismatch" });
    return;
  }
  next();
}
