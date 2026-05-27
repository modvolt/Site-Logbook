import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  db,
  activitiesTable,
  activityMaterialsTable,
  customersTable,
  usersTable,
} from "@workspace/db";
import {
  CreateActivityBody,
  GetActivityParams,
  UpdateActivityParams,
  UpdateActivityBody,
  DeleteActivityParams,
  StartActivityTimerParams,
  StopActivityTimerParams,
  ListActivityMaterialsParams,
  CreateActivityMaterialParams,
  CreateActivityMaterialBody,
  UpdateActivityMaterialParams,
  UpdateActivityMaterialBody,
  DeleteActivityMaterialParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : (v as null | undefined);

async function serializeActivity(a: typeof activitiesTable.$inferSelect) {
  let customerName: string | null = null;
  if (a.customerId) {
    const [c] = await db
      .select({ name: customersTable.companyName })
      .from(customersTable)
      .where(eq(customersTable.id, a.customerId));
    customerName = c?.name ?? null;
  }
  let createdByUserName: string | null = null;
  if (a.createdByUserId) {
    const [u] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, a.createdByUserId));
    createdByUserName = u?.name ?? null;
  }
  const [mat] = await db
    .select({
      total: sql<number>`coalesce(sum(${activityMaterialsTable.quantity} * ${activityMaterialsTable.pricePerUnit}), 0)`.mapWith(Number),
    })
    .from(activityMaterialsTable)
    .where(eq(activityMaterialsTable.activityId, a.id));

  return {
    id: a.id,
    name: a.name,
    description: a.description,
    customerId: a.customerId,
    customerName,
    createdByUserId: a.createdByUserId,
    createdByUserName,
    timerStartedAt: a.timerStartedAt ? a.timerStartedAt.toISOString() : null,
    hoursSpent: a.hoursSpent != null ? Number(a.hoursSpent) : null,
    materialsTotalCost: mat?.total ?? 0,
    isArchived: a.isArchived,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function serializeMaterial(m: typeof activityMaterialsTable.$inferSelect) {
  return {
    ...m,
    quantity: m.quantity != null ? Number(m.quantity) : null,
    pricePerUnit: m.pricePerUnit != null ? Number(m.pricePerUnit) : null,
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/activities", requireAuth, async (req, res): Promise<void> => {
  const archived = req.query.archived === "true";
  const mine = req.query.mine === "true";
  const userId = req.auth!.userId;

  const conds = [eq(activitiesTable.isArchived, archived)];
  if (mine) conds.push(eq(activitiesTable.createdByUserId, userId));

  const rows = await db
    .select()
    .from(activitiesTable)
    .where(and(...conds))
    .orderBy(desc(activitiesTable.updatedAt));

  res.json(await Promise.all(rows.map(serializeActivity)));
});

router.post("/activities", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateActivityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = req.auth!.userId;
  const [a] = await db
    .insert(activitiesTable)
    .values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      customerId: parsed.data.customerId ?? null,
      createdByUserId: userId,
    })
    .returning();
  res.status(201).json(await serializeActivity(a));
});

router.get("/activities/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetActivityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [a] = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.id, params.data.id));
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  res.json(await serializeActivity(a));
});

router.patch("/activities/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateActivityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateActivityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  const d = parsed.data;
  if (d.name !== undefined) update.name = d.name;
  if (d.description !== undefined) update.description = d.description;
  if (d.customerId !== undefined) update.customerId = d.customerId;
  if (d.isArchived !== undefined) update.isArchived = d.isArchived;
  if (d.hoursSpent !== undefined) update.hoursSpent = toStr(d.hoursSpent);

  const [a] = await db
    .update(activitiesTable)
    .set(update)
    .where(eq(activitiesTable.id, params.data.id))
    .returning();
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  res.json(await serializeActivity(a));
});

router.delete("/activities/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteActivityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [a] = await db
    .delete(activitiesTable)
    .where(eq(activitiesTable.id, params.data.id))
    .returning();
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/activities/:id/timer/start", requireAuth, async (req, res): Promise<void> => {
  const params = StartActivityTimerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Only set timerStartedAt if it's not already running, to avoid losing accumulated time.
  const [a] = await db
    .update(activitiesTable)
    .set({ timerStartedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(activitiesTable.id, params.data.id), sql`${activitiesTable.timerStartedAt} IS NULL`))
    .returning();
  if (!a) {
    // Either not found, or already running — return current state.
    const [existing] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.id));
    if (!existing) { res.status(404).json({ error: "Activity not found" }); return; }
    res.json(await serializeActivity(existing));
    return;
  }
  res.json(await serializeActivity(a));
});

router.post("/activities/:id/timer/stop", requireAuth, async (req, res): Promise<void> => {
  const params = StopActivityTimerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Atomic update: accumulate elapsed hours and clear the timer in one statement.
  const [a] = await db
    .update(activitiesTable)
    .set({
      hoursSpent: sql`round(
        (coalesce(${activitiesTable.hoursSpent}, 0)
          + case when ${activitiesTable.timerStartedAt} is not null
                 then extract(epoch from (now() - ${activitiesTable.timerStartedAt})) / 3600.0
                 else 0 end)::numeric, 2)`,
      timerStartedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(activitiesTable.id, params.data.id))
    .returning();
  if (!a) { res.status(404).json({ error: "Activity not found" }); return; }
  res.json(await serializeActivity(a));
});

// Materials
router.get("/activities/:activityId/materials", requireAuth, async (req, res): Promise<void> => {
  const params = ListActivityMaterialsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(activityMaterialsTable)
    .where(eq(activityMaterialsTable.activityId, params.data.activityId))
    .orderBy(activityMaterialsTable.sortOrder, activityMaterialsTable.createdAt);
  res.json(rows.map(serializeMaterial));
});

router.post("/activities/:activityId/materials", requireAuth, async (req, res): Promise<void> => {
  const params = CreateActivityMaterialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateActivityMaterialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [a] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.activityId));
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  const { quantity, pricePerUnit, ...rest } = parsed.data;
  const [m] = await db
    .insert(activityMaterialsTable)
    .values({
      activityId: params.data.activityId,
      ...rest,
      quantity: toStr(quantity),
      pricePerUnit: toStr(pricePerUnit),
    })
    .returning();
  res.status(201).json(serializeMaterial(m));
});

router.patch("/activities/:activityId/materials/:materialId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateActivityMaterialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateActivityMaterialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { quantity, pricePerUnit, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (quantity !== undefined) updateData.quantity = toStr(quantity);
  if (pricePerUnit !== undefined) updateData.pricePerUnit = toStr(pricePerUnit);

  const [m] = await db
    .update(activityMaterialsTable)
    .set(updateData)
    .where(
      and(
        eq(activityMaterialsTable.id, params.data.materialId),
        eq(activityMaterialsTable.activityId, params.data.activityId),
      ),
    )
    .returning();
  if (!m) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  res.json(serializeMaterial(m));
});

router.delete("/activities/:activityId/materials/:materialId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteActivityMaterialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [m] = await db
    .delete(activityMaterialsTable)
    .where(
      and(
        eq(activityMaterialsTable.id, params.data.materialId),
        eq(activityMaterialsTable.activityId, params.data.activityId),
      ),
    )
    .returning();
  if (!m) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
