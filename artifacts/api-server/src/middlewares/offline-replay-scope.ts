import type { NextFunction, Request, Response } from "express";
import { createOfflineIdentityScope } from "../lib/offline-identity";

export const OFFLINE_SCOPE_HEADER = "x-stavba-offline-scope";

function currentOfflineScope(req: Request): string | null {
  if (
    !req.auth ||
    req.auth.accountType !== "internal" ||
    !Number.isInteger(req.session.sessionGeneration)
  ) return null;
  return createOfflineIdentityScope({
    userId: req.auth.userId,
    sessionGeneration: req.session.sessionGeneration!,
    role: req.auth.role,
    permissions: req.auth.permissions,
  });
}

/**
 * Bind cacheable authenticated reads to the server-authoritative identity
 * epoch. The service worker refuses to persist a response unless this value
 * matches the scope its requesting tab supplied earlier via /api/auth/me.
 */
export function attachOfflineResponseScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "GET") {
    const scope = currentOfflineScope(req);
    if (scope) res.setHeader(OFFLINE_SCOPE_HEADER, scope);
  }
  next();
}

function isHeaderlessBrowserResource(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const destination = req.get("Sec-Fetch-Dest");
  return Boolean(destination && destination !== "empty");
}

/**
 * Bind ordinary private API traffic and offline replays to the identity epoch
 * that initiated them. Browser resource navigations cannot set custom headers;
 * they remain safe through the synchronous cross-tab reset and are never part
 * of the service-worker runtime cache. SSE carries invalidation topics only.
 */
export function enforceOfflineReplayScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // The external portal is deliberately online-only and never participates in
  // the internal PWA cache or offline mutation queue.
  if (req.auth?.accountType === "external") {
    next();
    return;
  }
  const path = req.originalUrl.split("?", 1)[0].replace(/\/+$/, "");
  if ((req.method === "GET" && path === "/api/events") || isHeaderlessBrowserResource(req)) {
    next();
    return;
  }
  const suppliedScope = req.get(OFFLINE_SCOPE_HEADER);
  if (!suppliedScope) {
    res.status(428).json({
      error: "Identity scope required",
      code: "identity_scope_required",
    });
    return;
  }
  const expectedScope = currentOfflineScope(req);
  if (!expectedScope) {
    res.status(401).json({ error: "Unauthorized", code: "offline_identity_unavailable" });
    return;
  }
  if (suppliedScope !== expectedScope) {
    res.status(409).json({ error: "Offline identity changed", code: "offline_scope_mismatch" });
    return;
  }
  next();
}
