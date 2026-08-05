import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { classifyPublicBearerRoute } from "../lib/public-bearer-route-policy";

const message = {
  error: "Příliš mnoho požadavků. Zkuste to později.",
  code: "public_rate_limit_exceeded",
};

function familyKey(req: Request): string {
  const route = classifyPublicBearerRoute(req.method, req.originalUrl);
  const ip = ipKeyGenerator(req.ip || "unknown");
  return `${ip}:${route?.family ?? "unknown"}`;
}

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: familyKey,
  message,
});

const publicMutationLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: familyKey,
  message,
});

/** Run before the JSON parser so rejected public mutations are never buffered. */
export function limitPublicBearerRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const route = classifyPublicBearerRoute(req.method, req.originalUrl);
  if (route?.requestClass === "mutation") {
    publicMutationLimiter(req, res, next);
    return;
  }
  if (route?.requestClass === "read") {
    publicReadLimiter(req, res, next);
    return;
  }
  next();
}
