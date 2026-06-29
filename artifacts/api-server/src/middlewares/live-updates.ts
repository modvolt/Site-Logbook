import type { Request, Response, NextFunction } from "express";
import { domainsForPath, isMutatingMethod, publishDomains } from "../lib/live-updates";
import { publishLiveEvent } from "../lib/live-events-service";

/**
 * After a successful data mutation, broadcast the affected domains to every
 * API instance via PG NOTIFY (which fans out to local SSE clients). Falls back
 * to the in-process publishDomains() path when PG NOTIFY fails.
 *
 * The originClientId is read from the X-Client-Id request header so the
 * originating browser (which already has fresh data from the mutation response)
 * can be skipped in the fan-out.
 *
 * Routes that call publishLiveEvent() directly (explicit side-effect matrix)
 * set res.locals.liveEventPublished = true to suppress the middleware fallback
 * and avoid double-broadcasting.
 */
export function broadcastMutations(req: Request, res: Response, next: NextFunction): void {
  if (!isMutatingMethod(req.method)) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;

    // If the route already published explicitly, do not double-broadcast.
    if (res.locals.liveEventPublished === true) return;

    const domains = domainsForPath(req.path);
    if (domains.length === 0) return;

    const originClientId =
      typeof req.headers["x-client-id"] === "string"
        ? req.headers["x-client-id"]
        : undefined;

    // Use PG NOTIFY for cross-instance delivery; fall back to in-process if
    // the notify pool is unavailable (e.g. no DATABASE_URL in tests).
    publishLiveEvent(domains, undefined, originClientId).catch(() => {
      publishDomains(domains);
    });
  });

  next();
}
