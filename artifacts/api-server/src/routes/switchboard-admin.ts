import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { db, jobsTable, switchboardsTable, switchboardEventsTable } from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { redactSwitchboardAuditPayload } from "../lib/switchboard-admin";

const router: IRouter = Router();
const positiveId = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);

router.get("/switchboard-events", requirePermission("switchboards.audit.view"), async (req, res) => {
  const boardId = req.query.boardId == null || req.query.boardId === "" ? null : positiveId.safeParse(req.query.boardId);
  const actorUserId = req.query.actorUserId == null || req.query.actorUserId === "" ? null : positiveId.safeParse(req.query.actorUserId);
  const offset = nonNegativeInt.safeParse(req.query.offset ?? 0);
  const limit = z.coerce.number().int().min(1).max(100).safeParse(req.query.limit ?? 50);
  const eventType = typeof req.query.eventType === "string" ? req.query.eventType.trim() : "";
  const from = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;
  if ((boardId && !boardId.success) || (actorUserId && !actorUserId.success) || !offset.success || !limit.success || eventType.length > 100 || (from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) {
    res.status(400).json({ error: "Neplatný filtr auditní historie." });
    return;
  }

  const conditions: SQL[] = [];
  if (boardId?.success) conditions.push(eq(switchboardEventsTable.switchboardId, boardId.data));
  if (actorUserId?.success) conditions.push(eq(switchboardEventsTable.actorUserId, actorUserId.data));
  if (eventType) conditions.push(eq(switchboardEventsTable.eventType, eventType));
  if (from) conditions.push(gte(switchboardEventsTable.createdAt, from));
  if (to) conditions.push(lte(switchboardEventsTable.createdAt, to));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }], eventTypes] = await Promise.all([
    db.select({
      event: switchboardEventsTable,
      boardDesignation: switchboardsTable.designation,
      boardInternalName: switchboardsTable.internalName,
      jobId: jobsTable.id,
      jobNumber: jobsTable.jobNumber,
      jobTitle: jobsTable.title,
    }).from(switchboardEventsTable)
      .leftJoin(switchboardsTable, eq(switchboardsTable.id, switchboardEventsTable.switchboardId))
      .leftJoin(jobsTable, eq(jobsTable.id, switchboardsTable.jobId))
      .where(where)
      .orderBy(desc(switchboardEventsTable.createdAt), desc(switchboardEventsTable.id))
      .limit(limit.data)
      .offset(offset.data),
    db.select({ total: sql<number>`count(*)::int` }).from(switchboardEventsTable).where(where),
    db.selectDistinct({ eventType: switchboardEventsTable.eventType }).from(switchboardEventsTable).orderBy(asc(switchboardEventsTable.eventType)),
  ]);

  res.json({
    items: rows.map(({ event, ...context }) => ({
      ...event,
      payload: redactSwitchboardAuditPayload(event.payload),
      createdAt: event.createdAt.toISOString(),
      board: event.switchboardId == null ? null : {
        id: event.switchboardId,
        designation: context.boardDesignation,
        internalName: context.boardInternalName,
        job: context.jobId == null ? null : { id: context.jobId, jobNumber: context.jobNumber, title: context.jobTitle },
      },
    })),
    total: total ?? 0,
    eventTypes: eventTypes.map((row) => row.eventType),
  });
});

export default router;
