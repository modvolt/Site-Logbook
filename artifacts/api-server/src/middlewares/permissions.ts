import type { NextFunction, Request, Response } from "express";
import type { Permission } from "@workspace/db";
import { resolveApiRouteAccess } from "../lib/api-route-access-policy";

export function enforceApiPermission(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const policy = resolveApiRouteAccess(req.method, req.path);
  if (policy.kind === "deny") {
    res.status(403).json({ error: "Forbidden", code: "route_not_authorized" });
    return;
  }
  if (policy.kind === "public" || policy.kind === "authenticated") {
    next();
    return;
  }
  const missing = policy.allOf.find(
    (permission) => !req.auth?.permissions.includes(permission),
  );
  if (missing) {
    res.status(403).json({ error: "Forbidden", requiredPermission: missing });
    return;
  }
  if (
    policy.anyOf &&
    !policy.anyOf.some((permission) => req.auth?.permissions.includes(permission))
  ) {
    res.status(403).json({
      error: "Forbidden",
      requiredPermission: policy.anyOf.join(" or "),
    });
    return;
  }
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!req.auth.permissions.includes(permission)) {
      res.status(403).json({ error: "Forbidden", requiredPermission: permission });
      return;
    }
    next();
  };
}
