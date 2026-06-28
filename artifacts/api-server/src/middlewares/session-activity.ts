import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";

const THROTTLE_MS = 5 * 60 * 1000;

export function trackSessionActivity(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth || !req.sessionID) {
    next();
    return;
  }

  const session = req.session as any;
  const now = Date.now();
  const lastUpdate: number = session._lastActiveDbUpdate ?? 0;

  if (now - lastUpdate < THROTTLE_MS) {
    next();
    return;
  }

  const sid = req.sessionID;
  const userId = req.auth.userId;
  const ip = (req.ip ?? null) as string | null;
  const ua = (req.get("user-agent") ?? null) as string | null;

  void pool
    .query(
      `UPDATE user_sessions
         SET user_id = $1,
             ip_address = $2,
             user_agent = $3,
             last_active_at = now(),
             created_at = COALESCE(created_at, now())
       WHERE sid = $4`,
      [userId, ip, ua, sid],
    )
    .catch(() => {});

  session._lastActiveDbUpdate = now;
  next();
}
