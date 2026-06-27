import { Router, type IRouter } from "express";
import { eq, and, desc, sql, ne, isNotNull } from "drizzle-orm";
import {
  db,
  activitiesTable,
  activityMaterialsTable,
  activityAttachmentsTable,
  activityExtraWorksTable,
  customersTable,
  usersTable,
  invoicesTable,
  invoiceSourceLinksTable,
} from "@workspace/db";
import {
  reconcileActivityMaterialStockMovement,
  reconcileSourceMovements,
  type Actor,
} from "../lib/warehouse-service";
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
  ListActivityAttachmentsParams,
  CreateActivityAttachmentParams,
  CreateActivityAttachmentBody,
  DeleteActivityAttachmentParams,
  ListActivityExtraWorksParams,
  CreateActivityExtraWorkParams,
  CreateActivityExtraWorkBody,
  UpdateActivityExtraWorkParams,
  UpdateActivityExtraWorkBody,
  DeleteActivityExtraWorkParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : (v as null | undefined);

function actorOf(req: { auth?: { userId: number; name: string } }): Actor {
  return { userId: req.auth?.userId ?? null, name: req.auth?.name ?? "Systém" };
}

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

  const [billingLink] = await db
    .select({
      invoiceId: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      invoiceStatus: invoicesTable.status,
    })
    .from(invoiceSourceLinksTable)
    .innerJoin(invoicesTable, eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoiceSourceLinksTable.activityId, a.id),
        isNotNull(invoiceSourceLinksTable.activityId),
        ne(invoicesTable.status, "cancelled"),
      ),
    )
    .limit(1);

  const [mat, attRow, extraRow] = await Promise.all([
    db
      .select({
        total: sql<number>`coalesce(sum(${activityMaterialsTable.quantity} * ${activityMaterialsTable.pricePerUnit}), 0)`.mapWith(Number),
      })
      .from(activityMaterialsTable)
      .where(eq(activityMaterialsTable.activityId, a.id))
      .then((r) => r[0]),
    db
      .select({
        photosCount: sql<number>`count(*) filter (where ${activityAttachmentsTable.type} = 'photo')`.mapWith(Number),
        attachmentsCount: sql<number>`count(*) filter (where ${activityAttachmentsTable.type} != 'photo')`.mapWith(Number),
      })
      .from(activityAttachmentsTable)
      .where(eq(activityAttachmentsTable.activityId, a.id))
      .then((r) => r[0]),
    db
      .select({
        totalAmount: sql<number>`coalesce(sum(${activityExtraWorksTable.amount}), 0)`.mapWith(Number),
        totalHours: sql<number>`coalesce(sum(${activityExtraWorksTable.hours}), 0)`.mapWith(Number),
      })
      .from(activityExtraWorksTable)
      .where(eq(activityExtraWorksTable.activityId, a.id))
      .then((r) => r[0]),
  ]);

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
    photosCount: attRow?.photosCount ?? 0,
    attachmentsCount: attRow?.attachmentsCount ?? 0,
    extraWorksTotalAmount: extraRow?.totalAmount ?? 0,
    extraWorksTotalHours: extraRow?.totalHours ?? 0,
    billingStatus: a.billingStatus,
    billedInvoiceId: billingLink?.invoiceId ?? null,
    billedInvoiceNumber: billingLink?.invoiceNumber ?? null,
    billedInvoiceStatus: billingLink?.invoiceStatus ?? null,
    completedAt: a.completedAt ? a.completedAt.toISOString() : null,
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

function serializeAttachment(a: typeof activityAttachmentsTable.$inferSelect) {
  return {
    ...a,
    createdAt: a.createdAt.toISOString(),
  };
}

function serializeExtraWork(w: typeof activityExtraWorksTable.$inferSelect) {
  return {
    ...w,
    hours: w.hours != null ? Number(w.hours) : null,
    amount: w.amount != null ? Number(w.amount) : null,
    createdAt: w.createdAt.toISOString(),
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
  if (d.completedAt !== undefined) update.completedAt = d.completedAt ? new Date(d.completedAt) : null;
  if (d.billingStatus !== undefined) update.billingStatus = d.billingStatus;

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
  const actor = actorOf(req);
  const m = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(activityMaterialsTable)
      .values({
        activityId: params.data.activityId,
        ...rest,
        quantity: toStr(quantity),
        pricePerUnit: toStr(pricePerUnit),
      })
      .returning();
    await reconcileActivityMaterialStockMovement(
      tx,
      { id: created.id, name: created.name, quantity: created.quantity, pricePerUnit: created.pricePerUnit, jobId: null },
      actor,
    );
    return created;
  });
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

  const actor = actorOf(req);
  const m = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(activityMaterialsTable)
      .set(updateData)
      .where(
        and(
          eq(activityMaterialsTable.id, params.data.materialId),
          eq(activityMaterialsTable.activityId, params.data.activityId),
        ),
      )
      .returning();
    if (!updated) return null;
    await reconcileActivityMaterialStockMovement(
      tx,
      { id: updated.id, name: updated.name, quantity: updated.quantity, pricePerUnit: updated.pricePerUnit, jobId: null },
      actor,
    );
    return updated;
  });
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
  const actor = actorOf(req);
  const m = await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(activityMaterialsTable)
      .where(
        and(
          eq(activityMaterialsTable.id, params.data.materialId),
          eq(activityMaterialsTable.activityId, params.data.activityId),
        ),
      )
      .returning();
    if (!deleted) return null;
    // Reverse the stock issue only once we know this scoped row really existed.
    await reconcileSourceMovements(tx, "activity_material", params.data.materialId, null, actor);
    return deleted;
  });
  if (!m) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  res.sendStatus(204);
});

// Attachments (photos)
router.get("/activities/:activityId/attachments", requireAuth, async (req, res): Promise<void> => {
  const params = ListActivityAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(activityAttachmentsTable)
    .where(eq(activityAttachmentsTable.activityId, params.data.activityId))
    .orderBy(desc(activityAttachmentsTable.createdAt));
  res.json(rows.map(serializeAttachment));
});

router.post("/activities/:activityId/attachments", requireAuth, async (req, res): Promise<void> => {
  const params = CreateActivityAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateActivityAttachmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [a] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.activityId));
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  const [att] = await db
    .insert(activityAttachmentsTable)
    .values({ activityId: params.data.activityId, ...parsed.data })
    .returning();
  res.status(201).json(serializeAttachment(att));
});

router.delete("/activities/:activityId/attachments/:attachmentId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteActivityAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [att] = await db
    .delete(activityAttachmentsTable)
    .where(
      and(
        eq(activityAttachmentsTable.id, params.data.attachmentId),
        eq(activityAttachmentsTable.activityId, params.data.activityId),
      ),
    )
    .returning();
  if (!att) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  res.sendStatus(204);
});

// Extra works (vícepráce)
router.get("/activities/:activityId/extra-works", requireAuth, async (req, res): Promise<void> => {
  const params = ListActivityExtraWorksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(activityExtraWorksTable)
    .where(eq(activityExtraWorksTable.activityId, params.data.activityId))
    .orderBy(activityExtraWorksTable.sortOrder, activityExtraWorksTable.createdAt);
  res.json(rows.map(serializeExtraWork));
});

router.post("/activities/:activityId/extra-works", requireAuth, async (req, res): Promise<void> => {
  const params = CreateActivityExtraWorkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateActivityExtraWorkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [a] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.activityId));
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  const { hours, amount, ...rest } = parsed.data;
  const [w] = await db
    .insert(activityExtraWorksTable)
    .values({
      activityId: params.data.activityId,
      ...rest,
      hours: toStr(hours),
      amount: toStr(amount),
    })
    .returning();
  res.status(201).json(serializeExtraWork(w));
});

router.patch("/activities/:activityId/extra-works/:extraWorkId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateActivityExtraWorkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateActivityExtraWorkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { hours, amount, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (hours !== undefined) updateData.hours = toStr(hours);
  if (amount !== undefined) updateData.amount = toStr(amount);

  const [w] = await db
    .update(activityExtraWorksTable)
    .set(updateData)
    .where(
      and(
        eq(activityExtraWorksTable.id, params.data.extraWorkId),
        eq(activityExtraWorksTable.activityId, params.data.activityId),
      ),
    )
    .returning();
  if (!w) {
    res.status(404).json({ error: "Extra work not found" });
    return;
  }
  res.json(serializeExtraWork(w));
});

router.delete("/activities/:activityId/extra-works/:extraWorkId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteActivityExtraWorkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [w] = await db
    .delete(activityExtraWorksTable)
    .where(
      and(
        eq(activityExtraWorksTable.id, params.data.extraWorkId),
        eq(activityExtraWorksTable.activityId, params.data.activityId),
      ),
    )
    .returning();
  if (!w) {
    res.status(404).json({ error: "Extra work not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
