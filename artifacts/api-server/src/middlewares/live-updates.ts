import type { Request, Response, NextFunction } from "express";
import { domainsForPath, isMutatingMethod, publishDomains } from "../lib/live-updates";

/**
 * After a successful data mutation, broadcast the affected domains to every open
 * SSE stream so other devices' open screens refresh in near real time. Mirrors
 * the audit middleware's pattern: it only acts on a successful (2xx/3xx)
 * mutating request, via the `finish` event so nothing is published if the
 * handler errors. Unlike the audit middleware it does NOT skip bank-statement /
 * email-import paths — those still change data that open screens display.
 */
export function broadcastMutations(req: Request, res: Response, next: NextFunction): void {
  if (!isMutatingMethod(req.method)) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const domains = domainsForPath(req.path);
    if (domains.length > 0) publishDomains(domains);
  });

  next();
}
