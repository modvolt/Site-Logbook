import { Router, type IRouter } from "express";
import { eq, and, gt, ne } from "drizzle-orm";
import { db, userSessionsTable, usersTable, auditLogTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

function parseUa(ua: string | null): string {
  if (!ua) return "Neznámý prohlížeč";
  if (/iPhone|iPad/i.test(ua)) {
    const browser = /CriOS/i.test(ua) ? "Chrome" : /FxiOS/i.test(ua) ? "Firefox" : "Safari";
    return `${browser} / iPhone`;
  }
  if (/Android/i.test(ua)) {
    const browser = /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : "Prohlížeč";
    return `${browser} / Android`;
  }
  if (/Windows/i.test(ua)) {
    const browser = /Edg/i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : "Prohlížeč";
    return `${browser} / Windows`;
  }
  if (/Macintosh/i.test(ua)) {
    const browser = /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : "Safari";
    return `${browser} / Mac`;
  }
  if (/Linux/i.test(ua)) {
    const browser = /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : "Prohlížeč";
    return `${browser} / Linux`;
  }
  return ua.slice(0, 80);
}

function serializeSession(row: any, currentSid: string) {
  return {
    sid: row.sid,
    userId: row.userId ?? null,
    username: row.username ?? null,
    name: row.name ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    userAgentParsed: parseUa(row.userAgent ?? null),
    lastActiveAt: row.lastActiveAt ? (row.lastActiveAt as Date).toISOString() : null,
    createdAt: row.createdAt ? (row.createdAt as Date).toISOString() : null,
    expiresAt: row.expire ? (row.expire as Date).toISOString() : null,
    isCurrent: row.sid === currentSid,
  };
}

async function writeAudit(actorId: number, actorName: string, action: string, summary: string) {
  await db
    .insert(auditLogTable)
    .values({
      actorUserId: actorId,
      actorName,
      action,
      entityType: "sessions",
      entityId: null,
      summary,
      method: "DELETE",
      path: "/sessions",
    })
    .catch(() => {});
}

router.get("/sessions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const now = new Date();
  const rows = await db
    .select({
      sid: userSessionsTable.sid,
      userId: userSessionsTable.userId,
      username: usersTable.username,
      name: usersTable.name,
      ipAddress: userSessionsTable.ipAddress,
      userAgent: userSessionsTable.userAgent,
      lastActiveAt: userSessionsTable.lastActiveAt,
      createdAt: userSessionsTable.createdAt,
      expire: userSessionsTable.expire,
    })
    .from(userSessionsTable)
    .leftJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
    .where(
      and(
        eq(userSessionsTable.userId, userId),
        gt(userSessionsTable.expire, now),
      ),
    );

  res.json(rows.map((r) => serializeSession(r, req.sessionID as string)));
});

router.get("/admin/sessions", requireRole("admin"), async (req, res): Promise<void> => {
  const now = new Date();
  const userIdFilter = req.query.userId ? Number(req.query.userId) : null;

  const conditions = [gt(userSessionsTable.expire, now)];
  if (userIdFilter) {
    conditions.push(eq(userSessionsTable.userId, userIdFilter));
  }

  const rows = await db
    .select({
      sid: userSessionsTable.sid,
      userId: userSessionsTable.userId,
      username: usersTable.username,
      name: usersTable.name,
      ipAddress: userSessionsTable.ipAddress,
      userAgent: userSessionsTable.userAgent,
      lastActiveAt: userSessionsTable.lastActiveAt,
      createdAt: userSessionsTable.createdAt,
      expire: userSessionsTable.expire,
    })
    .from(userSessionsTable)
    .leftJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
    .where(and(...conditions));

  res.json(rows.map((r) => serializeSession(r, req.sessionID as string)));
});

router.delete("/sessions/:sid", requireAuth, async (req, res): Promise<void> => {
  const sid = String(req.params.sid);
  const currentUserId = req.auth!.userId;
  const isAdmin = req.auth!.role === "admin";

  const [row] = await db
    .select({ userId: userSessionsTable.userId })
    .from(userSessionsTable)
    .where(eq(userSessionsTable.sid, sid));

  if (!row) {
    res.status(404).json({ error: "Session nenalezena" });
    return;
  }

  if (!isAdmin && row.userId !== currentUserId) {
    res.status(403).json({ error: "Nemáte oprávnění ukončit tuto session" });
    return;
  }

  await db.delete(userSessionsTable).where(eq(userSessionsTable.sid, sid as string));

  await writeAudit(
    currentUserId,
    req.auth!.name,
    "delete",
    `Ukončení session ${sid.slice(0, 8)}... (userId=${row.userId ?? "?"})`,
  );

  res.sendStatus(204);
});

router.delete("/users/:id/sessions", requireRole("admin"), async (req, res): Promise<void> => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "Neplatné ID uživatele" });
    return;
  }

  await db
    .delete(userSessionsTable)
    .where(
      and(
        eq(userSessionsTable.userId, userId),
        ne(userSessionsTable.sid, req.sessionID as string),
      ),
    );

  await writeAudit(
    req.auth!.userId,
    req.auth!.name,
    "delete",
    `Odhlášení všech session uživatele userId=${userId}`,
  );

  res.sendStatus(204);
});

export default router;
