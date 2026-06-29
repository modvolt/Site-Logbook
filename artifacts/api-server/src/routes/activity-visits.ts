import { Router, type IRouter } from "express";
import { eq, and, asc, gte, lte } from "drizzle-orm";
import { db, activityVisitsTable, activitiesTable, peopleTable } from "@workspace/db";
import {
  ListActivityVisitsParams,
  CreateActivityVisitParams,
  CreateActivityVisitBody,
  UpdateActivityVisitParams,
  UpdateActivityVisitBody,
  DeleteActivityVisitParams,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { z } from "zod/v4";

const router: IRouter = Router();

async function serializeVisit(v: typeof activityVisitsTable.$inferSelect) {
  let personName: string | null = null;
  if (v.personId) {
    const [p] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, v.personId));
    personName = p?.name ?? null;
  }
  return {
    id: v.id,
    activityId: v.activityId,
    personId: v.personId,
    personName,
    date: v.date,
    timeFrom: v.timeFrom,
    timeTo: v.timeTo,
    status: v.status,
    note: v.note,
    nextStep: v.nextStep,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
  };
}

const CalendarQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

router.get("/activities/visits/calendar", async (req, res): Promise<void> => {
  const parsed = CalendarQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Query params 'from' and 'to' are required (YYYY-MM-DD)" });
    return;
  }
  const { from, to } = parsed.data;

  const rows = await db
    .select({
      id: activityVisitsTable.id,
      activityId: activityVisitsTable.activityId,
      activityName: activitiesTable.name,
      personId: activityVisitsTable.personId,
      personName: peopleTable.name,
      date: activityVisitsTable.date,
      timeFrom: activityVisitsTable.timeFrom,
      timeTo: activityVisitsTable.timeTo,
      status: activityVisitsTable.status,
    })
    .from(activityVisitsTable)
    .innerJoin(activitiesTable, eq(activityVisitsTable.activityId, activitiesTable.id))
    .leftJoin(peopleTable, eq(activityVisitsTable.personId, peopleTable.id))
    .where(and(gte(activityVisitsTable.date, from), lte(activityVisitsTable.date, to)))
    .orderBy(asc(activityVisitsTable.date), asc(activityVisitsTable.id));

  res.json(rows.map((r) => ({
    id: r.id,
    activityId: r.activityId,
    activityName: r.activityName,
    personId: r.personId,
    personName: r.personName ?? null,
    date: r.date,
    timeFrom: r.timeFrom ?? null,
    timeTo: r.timeTo ?? null,
    status: r.status,
  })));
});

router.get("/activities/:activityId/visits", async (req, res): Promise<void> => {
  const params = ListActivityVisitsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [activity] = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(eq(activitiesTable.id, params.data.activityId));
  if (!activity) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  const visits = await db
    .select()
    .from(activityVisitsTable)
    .where(eq(activityVisitsTable.activityId, params.data.activityId))
    .orderBy(asc(activityVisitsTable.date), asc(activityVisitsTable.id));

  res.json(await Promise.all(visits.map(serializeVisit)));
});

router.post(
  "/activities/:activityId/visits",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = CreateActivityVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateActivityVisitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [activity] = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(eq(activitiesTable.id, params.data.activityId));
    if (!activity) {
      res.status(404).json({ error: "Activity not found" });
      return;
    }

    const createdBy: string | null = (req.session as { username?: string }).username ?? null;

    const [visit] = await db
      .insert(activityVisitsTable)
      .values({ ...parsed.data, activityId: params.data.activityId, createdBy })
      .returning();

    res.status(201).json(await serializeVisit(visit));
  },
);

router.patch(
  "/activities/:activityId/visits/:visitId",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = UpdateActivityVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateActivityVisitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [visit] = await db
      .update(activityVisitsTable)
      .set(parsed.data)
      .where(
        and(
          eq(activityVisitsTable.id, params.data.visitId),
          eq(activityVisitsTable.activityId, params.data.activityId),
        ),
      )
      .returning();

    if (!visit) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

    res.json(await serializeVisit(visit));
  },
);

router.delete(
  "/activities/:activityId/visits/:visitId",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const params = DeleteActivityVisitParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const deleted = await db
      .delete(activityVisitsTable)
      .where(
        and(
          eq(activityVisitsTable.id, params.data.visitId),
          eq(activityVisitsTable.activityId, params.data.activityId),
        ),
      )
      .returning({ id: activityVisitsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

    res.sendStatus(204);
  },
);

export default router;
