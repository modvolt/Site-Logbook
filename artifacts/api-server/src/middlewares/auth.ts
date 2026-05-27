import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: UserRole;
    name?: string;
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
