import type { NextFunction, Request, Response } from "express";
import { onlineIdempotencyPolicyForRequest } from "../lib/online-idempotency-policy";
import { requireVaultStepUp } from "./auth";

/**
 * Online privileged mutations must prove step-up before the durable ledger is
 * read or written. The route keeps its own step-up guard as defense in depth.
 */
export function requireOnlineIdempotencyStepUp(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!onlineIdempotencyPolicyForRequest(req)) {
    next();
    return;
  }
  requireVaultStepUp(req, res, next);
}
