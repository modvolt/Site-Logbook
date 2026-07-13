import { Router, type IRouter, type Response } from "express";
import { eq, and, desc, sql, ne, isNotNull, asc } from "drizzle-orm";
import {
  db,
  activitiesTable,
  activityMaterialsTable,
  activityAttachmentsTable,
  activityExtraWorksTable,
  activityVisitsTable,
  customersTable,
  usersTable,
  invoicesTable,
  invoiceSourceLinksTable,
  warehouseItemsTable,
} from "@workspace/db";
import {
  reconcileActivityMaterialStockMovement,
  reconcileSourceMovements,
  resolveWarehouseItemIdByName,
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
import { ActiveWorkSessionConflict, activeWorkSessionStarts, startWorkSession, stopWorkSession } from "../lib/work-session-service";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : (v as null | undefined);

function actorOf(req: { auth?: { userId: number; name: string } }): Actor {
  return { userId: req.auth?.userId ?? null, name: req.auth?.name ?? "Systém" };
}

type ActivityFinancialAccess = { canViewCost: boolean; canViewSale: boolean };
const financialAccess = (req: import("express").Request): ActivityFinancialAccess => ({
  canViewCost: req.auth?.permissions.includes("rates.cost.view") ?? false,
  canViewSale: req.auth?.permissions.includes("billing.view") ?? false,
});

export async function serializeActivity(
  a: typeof activitiesTable.$inferSelect,
  access: ActivityFinancialAccess = { canViewCost: false, canViewSale: false },
  timerPersonId?: number | null,
  timerStarts?: Map<number, Date>,
) {
  const personalTimerStarts = timerStarts ?? await activeWorkSessionStarts("activity", [a.id], timerPersonId);
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

  const [mat, attRow, extraRow, visitSummary, materialLines] = await Promise.all([
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
    db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        lastVisitDate: sql<string | null>`max(case when ${activityVisitsTable.status} in ('completed', 'in_progress') then ${activityVisitsTable.date} end)`,
        nextVisitDate: sql<string | null>`min(case when ${activityVisitsTable.status} = 'planned' then ${activityVisitsTable.date} end)`,
      })
      .from(activityVisitsTable)
      .where(eq(activityVisitsTable.activityId, a.id))
      .then((r) => r[0]),
    db
      .select({
        name: activityMaterialsTable.name,
        quantity: activityMaterialsTable.quantity,
        pricePerUnit: activityMaterialsTable.pricePerUnit,
      })
      .from(activityMaterialsTable)
      .where(eq(activityMaterialsTable.activityId, a.id)),
  ]);

  // Compute cost for materials: use warehouse purchase_price if available by name, else fall back to pricePerUnit.
  let costMaterials = 0;
  if (materialLines.length > 0) {
    const names = [...new Set(materialLines.map((m) => m.name))];
    const warehouseRows = await db
      .select({ name: warehouseItemsTable.name, purchasePrice: warehouseItemsTable.purchasePrice })
      .from(warehouseItemsTable)
      .where(sql`lower(${warehouseItemsTable.name}) = ANY(${names.map((n) => n.toLowerCase())})`);
    const purchaseByName = new Map(warehouseRows.map((r) => [r.name.toLowerCase(), r.purchasePrice ? Number(r.purchasePrice) : null]));
    for (const m of materialLines) {
      const qty = m.quantity != null ? Number(m.quantity) : 0;
      const purchasePrice = purchaseByName.get(m.name.toLowerCase()) ?? (m.pricePerUnit != null ? Number(m.pricePerUnit) : 0);
      costMaterials += qty * purchasePrice;
    }
  }

  const materialsTotalCost = mat?.total ?? 0;
  const extraWorksTotalAmount = extraRow?.totalAmount ?? 0;
  const hoursSpent = a.hoursSpent != null ? Number(a.hoursSpent) : null;
  const fixedPrice = a.fixedPrice != null ? Number(a.fixedPrice) : null;
  const hourlyRate = a.hourlyRate != null ? Number(a.hourlyRate) : null;

  // Revenue: fixedPrice if set, else materials (sale) + extra works
  const revenueTotal = fixedPrice != null ? fixedPrice : materialsTotalCost + extraWorksTotalAmount;

  // Cost: materials at purchase prices + labour cost (hours × rate if both set)
  const labourCost = hoursSpent != null && hourlyRate != null ? hoursSpent * hourlyRate : null;
  const costTotal = costMaterials + (labourCost ?? 0);

  const marginAmount = revenueTotal - costTotal;
  const marginPct = revenueTotal > 0 ? (marginAmount / revenueTotal) * 100 : null;

  return {
    id: a.id,
    name: a.name,
    description: a.description,
    customerId: a.customerId,
    customerName,
    createdByUserId: a.createdByUserId,
    createdByUserName,
    timerStartedAt: personalTimerStarts.get(a.id)?.toISOString() ?? null,
    hoursSpent,
    fixedPrice: access.canViewSale ? fixedPrice : null,
    hourlyRate: access.canViewCost ? hourlyRate : null,
    revenueTotal: access.canViewSale ? revenueTotal : null,
    costTotal: access.canViewCost ? costTotal : null,
    marginAmount: access.canViewSale && access.canViewCost ? marginAmount : null,
    marginPct: access.canViewSale && access.canViewCost ? marginPct : null,
    materialsTotalCost: access.canViewSale ? materialsTotalCost : null,
    photosCount: attRow?.photosCount ?? 0,
    attachmentsCount: attRow?.attachmentsCount ?? 0,
    extraWorksTotalAmount,
    extraWorksTotalHours: extraRow?.totalHours ?? 0,
    billingStatus: a.billingStatus,
    billedInvoiceId: billingLink?.invoiceId ?? null,
    billedInvoiceNumber: billingLink?.invoiceNumber ?? null,
    billedInvoiceStatus: billingLink?.invoiceStatus ?? null,
    completedAt: a.completedAt ? a.completedAt.toISOString() : null,
    isArchived: a.isArchived,
    lastVisitDate: visitSummary?.lastVisitDate ?? null,
    nextVisitDate: visitSummary?.nextVisitDate ?? null,
    visitsCount: visitSummary?.total ?? 0,
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

function isDocumentOwnedMaterial(m: typeof activityMaterialsTable.$inferSelect): boolean {
  return m.sourceType === "billing_document_line" && m.sourceId != null;
}

function rejectManagedMaterial(res: Response, action: "upravit" | "smazat") {
  res.status(409).json({
    error: `Materiál nejde ${action} v aktivitě. Je řízený schváleným dokladem; upravte původní doklad.`,
  });
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

  const personalTimerStarts = await activeWorkSessionStarts("activity", rows.map((row) => row.id), req.auth!.personId);
  res.json(await Promise.all(rows.map((row) => serializeActivity(row, financialAccess(req), req.auth!.personId, personalTimerStarts))));
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
  res.status(201).json(await serializeActivity(a, financialAccess(req), req.auth!.personId));
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
  res.json(await serializeActivity(a, financialAccess(req), req.auth!.personId));
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
  if ("hourlyRate" in d && !req.auth!.permissions.includes("rates.manage")) {
    res.status(403).json({ error: "Forbidden", requiredPermission: "rates.manage" }); return;
  }
  if ("fixedPrice" in d && !req.auth!.permissions.includes("billing.manage")) {
    res.status(403).json({ error: "Forbidden", requiredPermission: "billing.manage" }); return;
  }
  if (d.name !== undefined) update.name = d.name;
  if (d.description !== undefined) update.description = d.description;
  if (d.customerId !== undefined) update.customerId = d.customerId;
  if (d.isArchived !== undefined) update.isArchived = d.isArchived;
  if (d.hoursSpent !== undefined) update.hoursSpent = toStr(d.hoursSpent);
  if (d.completedAt !== undefined) update.completedAt = d.completedAt ? new Date(d.completedAt) : null;
  if (d.billingStatus !== undefined) update.billingStatus = d.billingStatus;
  if ("fixedPrice" in d) update.fixedPrice = toStr(d.fixedPrice as number | null | undefined);
  if ("hourlyRate" in d) update.hourlyRate = toStr(d.hourlyRate as number | null | undefined);

  const [a] = await db
    .update(activitiesTable)
    .set(update)
    .where(eq(activitiesTable.id, params.data.id))
    .returning();
  if (!a) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }
  res.json(await serializeActivity(a, financialAccess(req), req.auth!.personId));
});

router.delete("/activities/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteActivityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const force = req.query.force === "true";
  if (!force) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(activityVisitsTable)
      .where(eq(activityVisitsTable.activityId, params.data.id));
    const visitCount = countRow?.count ?? 0;
    if (visitCount > 0) {
      res.status(409).json({
        error: `Akce má ${visitCount} výjezd${visitCount === 1 ? "" : visitCount < 5 ? "y" : "ů"}. Smažte je nejprve, nebo potvrďte smazání včetně výjezdů.`,
        visitCount,
      });
      return;
    }
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
  const personId = req.auth!.personId;
  if (!personId) {
    res.status(409).json({ error: "Uživatelský účet není propojen se zaměstnancem. Propojení nastavte ve správě uživatelů.", code: "time_person_unlinked" });
    return;
  }
  const [activity] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.id));
  if (!activity) { res.status(404).json({ error: "Activity not found" }); return; }
  try {
    await startWorkSession("activity", params.data.id, personId, req.auth!.userId);
  } catch (error) {
    if (error instanceof ActiveWorkSessionConflict) {
      res.status(409).json({ error: error.message, activeSession: error.active });
      return;
    }
    throw error;
  }
  res.json(await serializeActivity(activity, financialAccess(req), personId));
});

router.post("/activities/:id/timer/stop", requireAuth, async (req, res): Promise<void> => {
  const params = StopActivityTimerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const personId = req.auth!.personId;
  if (!personId) {
    res.status(409).json({ error: "Uživatelský účet není propojen se zaměstnancem. Propojení nastavte ve správě uživatelů.", code: "time_person_unlinked" });
    return;
  }
  const [activity] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.id));
  if (!activity) { res.status(404).json({ error: "Activity not found" }); return; }
  await stopWorkSession("activity", params.data.id, personId, req.auth!.userId);
  const [updated] = await db.select().from(activitiesTable).where(eq(activitiesTable.id, params.data.id));
  res.json(await serializeActivity(updated ?? activity, financialAccess(req), personId));
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
  const { quantity, pricePerUnit, warehouseItemId: bodyWarehouseItemId, ...rest } = parsed.data;
  const actor = actorOf(req);
  const m = await db.transaction(async (tx) => {
    const warehouseItemId = bodyWarehouseItemId !== undefined
      ? bodyWarehouseItemId
      : await resolveWarehouseItemIdByName(tx, rest.name);
    const [created] = await tx
      .insert(activityMaterialsTable)
      .values({
        activityId: params.data.activityId,
        ...rest,
        quantity: toStr(quantity),
        pricePerUnit: toStr(pricePerUnit),
        warehouseItemId,
      })
      .returning();
    await reconcileActivityMaterialStockMovement(
      tx,
      { id: created.id, name: created.name, quantity: created.quantity, pricePerUnit: created.pricePerUnit, jobId: null, warehouseItemId: created.warehouseItemId },
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
  const { quantity, pricePerUnit, warehouseItemId: bodyWarehouseItemId, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (quantity !== undefined) updateData.quantity = toStr(quantity);
  if (pricePerUnit !== undefined) updateData.pricePerUnit = toStr(pricePerUnit);

  const [existing] = await db
    .select()
    .from(activityMaterialsTable)
    .where(
      and(
        eq(activityMaterialsTable.id, params.data.materialId),
        eq(activityMaterialsTable.activityId, params.data.activityId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  if (isDocumentOwnedMaterial(existing)) {
    rejectManagedMaterial(res, "upravit");
    return;
  }

  const actor = actorOf(req);
  const m = await db.transaction(async (tx) => {
    if (bodyWarehouseItemId !== undefined) {
      updateData.warehouseItemId = bodyWarehouseItemId;
    } else if (typeof rest.name === "string") {
      updateData.warehouseItemId = await resolveWarehouseItemIdByName(tx, rest.name);
    }
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
      { id: updated.id, name: updated.name, quantity: updated.quantity, pricePerUnit: updated.pricePerUnit, jobId: null, warehouseItemId: updated.warehouseItemId },
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
  const [existing] = await db
    .select()
    .from(activityMaterialsTable)
    .where(
      and(
        eq(activityMaterialsTable.id, params.data.materialId),
        eq(activityMaterialsTable.activityId, params.data.activityId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  if (isDocumentOwnedMaterial(existing)) {
    rejectManagedMaterial(res, "smazat");
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
