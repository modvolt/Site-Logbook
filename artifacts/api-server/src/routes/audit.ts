import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db, auditLogTable } from "@workspace/db";

const router: IRouter = Router();

function serializeEntry(e: typeof auditLogTable.$inferSelect) {
  return {
    ...e,
    createdAt: e.createdAt.toISOString(),
  };
}

router.get("/audit-logs", async (req, res): Promise<void> => {
  const conditions: Array<SQL> = [];

  const userId = Number(req.query.userId);
  if (req.query.userId != null && req.query.userId !== "" && Number.isInteger(userId)) {
    conditions.push(eq(auditLogTable.actorUserId, userId));
  }

  const entityType = req.query.entityType;
  if (typeof entityType === "string" && entityType.trim() !== "") {
    conditions.push(eq(auditLogTable.entityType, entityType.trim()));
  }

  const action = req.query.action;
  if (typeof action === "string" && action.trim() !== "") {
    conditions.push(eq(auditLogTable.action, action.trim()));
  }

  const from = req.query.from;
  if (typeof from === "string" && from.trim() !== "") {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(auditLogTable.createdAt, d));
  }

  const to = req.query.to;
  if (typeof to === "string" && to.trim() !== "") {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) conditions.push(lte(auditLogTable.createdAt, d));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(auditLogTable)
      .where(where)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogTable)
      .where(where),
  ]);

  res.json({ items: items.map(serializeEntry), total: total ?? 0 });
});

export default router;
