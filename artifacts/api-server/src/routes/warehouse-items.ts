import { Router, type IRouter } from "express";
import { and, count, eq, isNull, lte, sql, desc, ilike } from "drizzle-orm";
import { db, warehouseItemsTable, auditLogTable } from "@workspace/db";
import { warehouseMovementsTable } from "@workspace/db";
import { warehousePriceHistoryTable } from "@workspace/db";
import { billingDocumentsTable, billingDocumentLinesTable } from "@workspace/db";
import {
  CreateWarehouseItemBody,
  UpdateWarehouseItemParams,
  UpdateWarehouseItemBody,
  DeleteWarehouseItemParams,
  ImportWarehouseItemsBody,
  ListWarehouseItemMovementsParams,
  CreateWarehouseMovementParams,
  CreateWarehouseMovementBody,
  UpdateWarehouseMovementParams,
  UpdateWarehouseMovementBody,
  ListWarehouseMovementsQueryParams,
  ListWarehouseItemsQueryParams,
  ListWarehouseItemPriceHistoryParams,
  CancelLastWarehouseMovementParams,
} from "@workspace/api-zod";
import {
  listItemMovements,
  listMovements,
  createManualMovement,
  type Actor,
  type AppError,
} from "../lib/warehouse-service";
import { num, round2 } from "../lib/invoice-calc";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

function actorOf(req: { auth?: { userId: number; name: string } }): Actor {
  return { userId: req.auth?.userId ?? null, name: req.auth?.name ?? "Systém" };
}

const NUMERIC_FIELDS = ["quantity", "purchasePrice", "salePrice", "minQuantity"] as const;

function serializeWarehouseItem(
  w: typeof warehouseItemsTable.$inferSelect,
  latestPriceDate?: string | null,
  hasPriceHistory?: boolean,
) {
  return {
    ...w,
    quantity: w.quantity != null ? Number(w.quantity) : 0,
    purchasePrice: w.purchasePrice != null ? Number(w.purchasePrice) : null,
    salePrice: w.salePrice != null ? Number(w.salePrice) : null,
    minQuantity: w.minQuantity != null ? Number(w.minQuantity) : null,
    createdAt: w.createdAt.toISOString(),
    latestPriceDate: latestPriceDate ?? null,
    hasPriceHistory: hasPriceHistory ?? false,
  };
}

function numericToStrings(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of NUMERIC_FIELDS) {
    if (f in out) out[f] = toStr(out[f] as number | null | undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Warehouse summary
// ---------------------------------------------------------------------------

router.get("/warehouse-summary", async (_req, res): Promise<void> => {
  const [agg] = await db
    .select({
      itemCount: count(),
      itemsBelowMin: sql<number>`sum(case when ${warehouseItemsTable.minQuantity} is not null and ${warehouseItemsTable.quantity} <= ${warehouseItemsTable.minQuantity} then 1 else 0 end)`.mapWith(Number),
      itemsWithoutPrice: sql<number>`sum(case when ${warehouseItemsTable.purchasePrice} is null then 1 else 0 end)`.mapWith(Number),
      itemsWithNoPriceAtAll: sql<number>`sum(case when ${warehouseItemsTable.purchasePrice} is null and not exists (select 1 from ${warehousePriceHistoryTable} where ${warehousePriceHistoryTable.warehouseItemId} = ${warehouseItemsTable.id}) then 1 else 0 end)`.mapWith(Number),
      stockValue: sql<number>`coalesce(sum(${warehouseItemsTable.quantity} * ${warehouseItemsTable.purchasePrice}), 0)`.mapWith(Number),
    })
    .from(warehouseItemsTable);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [movRow] = await db
    .select({ c: count() })
    .from(warehouseMovementsTable)
    .where(sql`${warehouseMovementsTable.createdAt} >= ${todayStart}`);

  // Count billing documents with stock-allocated lines that are not yet approved
  const [waitRow] = await db
    .select({ c: count() })
    .from(billingDocumentsTable)
    .where(
      and(
        sql`${billingDocumentsTable.status} in ('needs_review', 'awaiting_approval', 'pending')`,
        sql`exists (
          select 1 from ${billingDocumentLinesTable}
          where ${billingDocumentLinesTable.documentId} = ${billingDocumentsTable.id}
            and ${billingDocumentLinesTable.lineType} = 'material'
            and ${billingDocumentLinesTable.allocationType} = 'stock'
        )`,
      ),
    );

  res.json({
    stockValue: round2(num(agg?.stockValue ?? 0)),
    itemCount: Number(agg?.itemCount ?? 0),
    itemsBelowMin: Number(agg?.itemsBelowMin ?? 0),
    itemsWithoutPrice: Number(agg?.itemsWithoutPrice ?? 0),
    itemsWithNoPriceAtAll: Number(agg?.itemsWithNoPriceAtAll ?? 0),
    movementsToday: Number(movRow?.c ?? 0),
    waitingForInvoice: Number(waitRow?.c ?? 0),
  });
});

// ---------------------------------------------------------------------------
// Warehouse items list + create
// ---------------------------------------------------------------------------

router.get("/warehouse-items", async (req, res): Promise<void> => {
  const query = ListWarehouseItemsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { category, supplierName, belowMin, noPrice, noPriceAtAll, changedAfter } = query.data;

  const conds = [];
  if (category) conds.push(ilike(warehouseItemsTable.category, `%${category}%`));
  if (supplierName) conds.push(ilike(warehouseItemsTable.supplierName, `%${supplierName}%`));
  if (belowMin === true) {
    conds.push(
      and(
        sql`${warehouseItemsTable.minQuantity} is not null`,
        lte(warehouseItemsTable.quantity, warehouseItemsTable.minQuantity!),
      )!,
    );
  }
  if (noPriceAtAll === true) {
    conds.push(isNull(warehouseItemsTable.purchasePrice));
    conds.push(
      sql`not exists (
        select 1 from ${warehousePriceHistoryTable}
        where ${warehousePriceHistoryTable.warehouseItemId} = ${warehouseItemsTable.id}
      )`,
    );
  } else if (noPrice === true) {
    conds.push(isNull(warehouseItemsTable.purchasePrice));
  }
  if (changedAfter) {
    const since = new Date(`${changedAfter}T00:00:00`);
    conds.push(
      sql`exists (
        select 1 from ${warehouseMovementsTable}
        where ${warehouseMovementsTable.warehouseItemId} = ${warehouseItemsTable.id}
          and ${warehouseMovementsTable.createdAt} >= ${since}
      )`,
    );
  }

  // Fetch latest price dates for all items in one query (also used to determine hasPriceHistory)
  const priceRows = await db
    .select({
      warehouseItemId: warehousePriceHistoryTable.warehouseItemId,
      latestDate: sql<string>`max(${warehousePriceHistoryTable.createdAt})`,
    })
    .from(warehousePriceHistoryTable)
    .groupBy(warehousePriceHistoryTable.warehouseItemId);

  const priceDateMap = new Map<number, string>();
  for (const r of priceRows) {
    if (r.latestDate) priceDateMap.set(r.warehouseItemId, new Date(r.latestDate).toISOString());
  }

  const items = await db
    .select()
    .from(warehouseItemsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(warehouseItemsTable.name);

  res.json(items.map((item) => serializeWarehouseItem(
    item,
    priceDateMap.get(item.id) ?? null,
    priceDateMap.has(item.id),
  )));
});

router.post("/warehouse-items", async (req, res): Promise<void> => {
  const parsed = CreateWarehouseItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [item] = await db
    .insert(warehouseItemsTable)
    .values(numericToStrings(parsed.data) as any)
    .returning();
  res.status(201).json(serializeWarehouseItem(item, null));
});

// ---------------------------------------------------------------------------
// Warehouse import
// ---------------------------------------------------------------------------

router.post("/warehouse-items/import", async (req, res): Promise<void> => {
  const parsed = ImportWarehouseItemsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: warehouseItemsTable.id, code: warehouseItemsTable.code })
      .from(warehouseItemsTable);
    const byCode = new Map<string, number>();
    for (const row of existing) {
      if (row.code) byCode.set(row.code.trim().toLowerCase(), row.id);
    }

    for (const raw of parsed.data.items) {
      const name = raw.name?.trim();
      if (!name) {
        skipped++;
        continue;
      }
      const code = raw.code?.trim() || null;
      const provided: Record<string, unknown> = { name };
      if (raw.category !== undefined) provided.category = raw.category;
      if (raw.unit !== undefined) provided.unit = raw.unit;
      if (raw.purchasePrice !== undefined) provided.purchasePrice = raw.purchasePrice;
      if (raw.salePrice !== undefined) provided.salePrice = raw.salePrice;
      if (raw.minQuantity !== undefined) provided.minQuantity = raw.minQuantity;

      const key = code?.toLowerCase();
      const matchId = key ? byCode.get(key) : undefined;

      if (matchId != null) {
        await tx
          .update(warehouseItemsTable)
          .set(numericToStrings(provided) as any)
          .where(eq(warehouseItemsTable.id, matchId));
        updated++;
      } else {
        const [row] = await tx
          .insert(warehouseItemsTable)
          .values(numericToStrings({ ...provided, code }) as any)
          .returning({ id: warehouseItemsTable.id });
        if (key && row) byCode.set(key, row.id);
        created++;
      }
    }
  });

  res.json({ created, updated, skipped });
});

// ---------------------------------------------------------------------------
// Warehouse item update + delete
// ---------------------------------------------------------------------------

router.patch("/warehouse-items/:id", async (req, res): Promise<void> => {
  const params = UpdateWarehouseItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateWarehouseItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [item] = await db
    .update(warehouseItemsTable)
    .set(numericToStrings(parsed.data) as any)
    .where(eq(warehouseItemsTable.id, params.data.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Warehouse item not found" });
    return;
  }

  res.json(serializeWarehouseItem(item, null));
});

router.delete("/warehouse-items/:id", async (req, res): Promise<void> => {
  const params = DeleteWarehouseItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db
    .select({ id: warehouseItemsTable.id, name: warehouseItemsTable.name })
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, params.data.id));

  if (!item) {
    res.status(404).json({ error: "Warehouse item not found" });
    return;
  }

  const [movRow] = await db
    .select({ c: count() })
    .from(warehouseMovementsTable)
    .where(eq(warehouseMovementsTable.warehouseItemId, params.data.id));
  const [priceRow] = await db
    .select({ c: count() })
    .from(warehousePriceHistoryTable)
    .where(eq(warehousePriceHistoryTable.warehouseItemId, params.data.id));

  const movCount = Number(movRow?.c ?? 0);
  const priceCount = Number(priceRow?.c ?? 0);

  if (movCount > 0 || priceCount > 0) {
    const parts: string[] = [];
    if (movCount > 0) parts.push(`${movCount} pohyb${movCount === 1 ? "" : movCount < 5 ? "y" : "ů"} na skladě`);
    if (priceCount > 0) parts.push(`${priceCount} záznam${priceCount === 1 ? "" : priceCount < 5 ? "y" : "ů"} cenové historie`);
    res.status(409).json({
      error: `Položku „${item.name}" nelze smazat — má ${parts.join(" a ")}. Místo smazání ji ponechte ve skladu (bude mít nulový stav, ale historie zůstane dohledatelná).`,
    });
    return;
  }

  await db.delete(warehouseItemsTable).where(eq(warehouseItemsTable.id, params.data.id));

  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

router.get("/warehouse-items/:id/price-history", async (req, res): Promise<void> => {
  const params = ListWarehouseItemPriceHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [item] = await db
    .select({ id: warehouseItemsTable.id })
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, params.data.id));
  if (!item) {
    res.status(404).json({ error: "Warehouse item not found" });
    return;
  }

  const rows = await db
    .select()
    .from(warehousePriceHistoryTable)
    .where(eq(warehousePriceHistoryTable.warehouseItemId, params.data.id))
    .orderBy(desc(warehousePriceHistoryTable.createdAt));

  res.json(
    rows.map((r) => ({
      ...r,
      purchasePrice: Number(r.purchasePrice),
      documentDate: r.documentDate ? r.documentDate.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// ---------------------------------------------------------------------------
// Stock movements (ledger / kniha pohybů)
// ---------------------------------------------------------------------------

router.get("/warehouse-items/:id/movements", async (req, res): Promise<void> => {
  const params = ListWarehouseItemMovementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [item] = await db
    .select({ id: warehouseItemsTable.id })
    .from(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, params.data.id));
  if (!item) {
    res.status(404).json({ error: "Warehouse item not found" });
    return;
  }
  res.json(await listItemMovements(db, params.data.id));
});

router.post("/warehouse-items/:id/movements/cancel-last", async (req, res): Promise<void> => {
  const params = CancelLastWarehouseMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const actor = actorOf(req);

  try {
    const result = await db.transaction(async (tx) => {
      // Find the latest manual movement for this item that hasn't been reversed
      const [last] = await tx
        .select()
        .from(warehouseMovementsTable)
        .where(
          and(
            eq(warehouseMovementsTable.warehouseItemId, params.data.id),
            eq(warehouseMovementsTable.sourceType, "manual"),
          ),
        )
        .orderBy(desc(warehouseMovementsTable.createdAt), desc(warehouseMovementsTable.id))
        .limit(1);

      if (!last) {
        throw Object.assign(new Error("Žádný ruční pohyb k stornování."), { statusCode: 404 });
      }

      // If the last movement is itself a storno, refuse to storno a storno
      if (last.note && /^Storno pohybu #\d+/.test(last.note)) {
        throw Object.assign(
          new Error("Poslední pohyb je již storno — nelze stornovat znovu."),
          { statusCode: 409 },
        );
      }

      // Insert a reversal movement (opposite direction, same quantity)
      const reverseDirection: "in" | "out" = last.direction === "in" ? "out" : "in";
      const [reversal] = await tx
        .insert(warehouseMovementsTable)
        .values({
          warehouseItemId: last.warehouseItemId,
          direction: reverseDirection,
          quantity: last.quantity,
          unitPrice: last.unitPrice,
          sourceType: "manual",
          sourceId: null,
          note: `Storno pohybu #${last.id}`,
          createdByUserId: actor.userId,
          createdByName: actor.name,
        })
        .returning();

      // Recompute quantity
      const qRes = (await tx.execute(sql`
        select coalesce(sum(case when direction = 'in' then quantity else -quantity end), 0) as qty
        from warehouse_movements
        where warehouse_item_id = ${params.data.id}
      `)) as unknown as { rows: Array<{ qty: string | number }> };
      const qty = round2(num(qRes.rows[0]?.qty ?? 0));
      await tx
        .update(warehouseItemsTable)
        .set({ quantity: String(qty) })
        .where(eq(warehouseItemsTable.id, params.data.id));

      return reversal;
    });

    const [serialized] = await listMovements(db, {
      warehouseItemId: params.data.id,
      limit: 1,
    });
    res.status(201).json(serialized ?? result);
  } catch (err) {
    const e = err as AppError;
    res.status(e.statusCode ?? 500).json({ error: e.message });
  }
});

router.post("/warehouse-items/:id/movements", async (req, res): Promise<void> => {
  const params = CreateWarehouseMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateWarehouseMovementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Idempotency: if key provided, check for existing movement first
  const idempotencyKey = (parsed.data as any).idempotencyKey ?? null;
  if (idempotencyKey) {
    const [existing] = await db
      .select({ id: warehouseMovementsTable.id })
      .from(warehouseMovementsTable)
      .where(
        and(
          eq(warehouseMovementsTable.warehouseItemId, params.data.id),
          eq(warehouseMovementsTable.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      const [serialized] = await listMovements(db, {
        warehouseItemId: params.data.id,
        limit: 500,
      });
      const found = (await listMovements(db, { warehouseItemId: params.data.id, limit: 1000 }))
        .find((m) => m.id === existing.id);
      res.status(409).json(found ?? serialized);
      return;
    }
  }

  try {
    await createManualMovement(
      db,
      params.data.id,
      {
        direction: parsed.data.direction,
        quantity: parsed.data.quantity,
        unitPrice: parsed.data.unitPrice ?? null,
        note: parsed.data.note ?? null,
        idempotencyKey,
      },
      actorOf(req),
    );
    // Re-read with joins so the response matches the WarehouseMovement shape.
    const [serialized] = await listMovements(db, {
      warehouseItemId: params.data.id,
      limit: 1,
    });
    res.status(201).json(serialized);
  } catch (err) {
    // PG unique violation (23505) = duplicate idempotency key raced past pre-check
    if ((err as any)?.code === "23505") {
      res.status(409).json({ error: "Pohyb s tímto klíčem byl již zaznamenán (duplicitní požadavek)." });
      return;
    }
    const e = err as AppError;
    res.status(e.statusCode ?? 500).json({ error: e.message });
  }
});

router.patch("/warehouse-movements/:id", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = UpdateWarehouseMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateWarehouseMovementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [movement] = await db
    .select()
    .from(warehouseMovementsTable)
    .where(eq(warehouseMovementsTable.id, params.data.id));

  if (!movement) {
    res.status(404).json({ error: "Movement not found" });
    return;
  }

  if (movement.direction !== "out") {
    res.status(400).json({ error: "Nákupní cenu lze opravit pouze na výdejovém pohybu (OUT)." });
    return;
  }

  const oldPrice = movement.costPriceAtTime != null ? Number(movement.costPriceAtTime) : null;
  const newPrice = parsed.data.costPriceAtTime;

  const costStr = newPrice != null ? String(newPrice) : null;

  await db.transaction(async (tx) => {
    await tx
      .update(warehouseMovementsTable)
      .set({ costPriceAtTime: costStr })
      .where(eq(warehouseMovementsTable.id, params.data.id));

    await tx.insert(auditLogTable).values({
      actorUserId: req.auth?.userId ?? null,
      actorName: req.auth?.name ?? "Systém",
      action: "update_cost_price",
      entityType: "warehouse_movement",
      entityId: params.data.id,
      summary: `Nákupní cena pohybu #${params.data.id} opravena: ${oldPrice ?? "—"} → ${newPrice ?? "—"} Kč`,
      method: req.method,
      path: req.path,
    });
  });

  const all = await listMovements(db, { warehouseItemId: movement.warehouseItemId, limit: 1000 });
  const updated = all.find((m) => m.id === params.data.id) ?? all[0];

  res.json(updated);
});

router.get("/warehouse-movements/job-margin-trend", async (req, res): Promise<void> => {
  const jobId = parseInt(req.query.jobId as string, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "jobId (integer) je povinný parametr." });
    return;
  }

  // Bucket OUT movements by ISO week, ordered ascending
  const rows = (await db.execute(sql`
    select
      date_trunc('week', ${warehouseMovementsTable.createdAt})::date::text as period,
      coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.unitPrice} * ${warehouseMovementsTable.quantity} else 0 end), 0)             as period_sale_value,
      coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.costPriceAtTime} * ${warehouseMovementsTable.quantity} else 0 end), 0) as period_cost_value
    from ${warehouseMovementsTable}
    where ${warehouseMovementsTable.jobId} = ${jobId}
      and ${warehouseMovementsTable.direction} = 'out'
    group by date_trunc('week', ${warehouseMovementsTable.createdAt})
    order by period asc
  `)) as unknown as { rows: Array<{ period: string; period_sale_value: string; period_cost_value: string }> };

  // Compute cumulative values
  let cumSale = 0;
  let cumCost = 0;
  const points = rows.rows.map((r) => {
    cumSale = round2(cumSale + num(r.period_sale_value));
    cumCost = round2(cumCost + num(r.period_cost_value));
    const cumulativeMarginPct = cumSale > 0
      ? round2(((cumSale - cumCost) / cumSale) * 100)
      : null;
    return { period: r.period, cumulativeSaleValue: cumSale, cumulativeCostValue: cumCost, cumulativeMarginPct };
  });

  res.json({ jobId, points });
});

router.get("/warehouse-movements/job-margin-summary", async (req, res): Promise<void> => {
  const jobId = parseInt(req.query.jobId as string, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "jobId (integer) je povinný parametr." });
    return;
  }

  const agg = (await db.execute(sql`
    select
      coalesce(sum(${warehouseMovementsTable.quantity}), 0)                                                          as total_qty_out,
      coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.unitPrice} * ${warehouseMovementsTable.quantity} else 0 end), 0)          as total_sale_value,
      coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.costPriceAtTime} * ${warehouseMovementsTable.quantity} else 0 end), 0) as total_cost_value,
      coalesce(sum(case when ${warehouseMovementsTable.unitPrice} is not null then ${warehouseMovementsTable.quantity} else 0 end), 0)          as covered_qty_out,
      coalesce(sum(case when ${warehouseMovementsTable.costPriceAtTime} is not null then ${warehouseMovementsTable.quantity} else 0 end), 0)    as covered_cost_qty_out
    from ${warehouseMovementsTable}
    where ${warehouseMovementsTable.jobId} = ${jobId}
      and ${warehouseMovementsTable.direction} = 'out'
  `)) as unknown as { rows: Array<{ total_qty_out: string; total_sale_value: string; total_cost_value: string; covered_qty_out: string; covered_cost_qty_out: string }> };

  const row = agg.rows[0]!;
  const totalSaleValue = round2(num(row.total_sale_value));
  const totalCostValue = round2(num(row.total_cost_value));
  const marginPercent = totalSaleValue > 0
    ? round2(((totalSaleValue - totalCostValue) / totalSaleValue) * 100)
    : null;

  res.json({
    jobId,
    totalQtyOut: round2(num(row.total_qty_out)),
    totalSaleValue,
    totalCostValue,
    coveredQtyOut: round2(num(row.covered_qty_out)),
    coveredCostQtyOut: round2(num(row.covered_cost_qty_out)),
    marginPercent,
  });
});

router.get("/warehouse-movements", async (req, res): Promise<void> => {
  const query = ListWarehouseMovementsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  res.json(await listMovements(db, query.data));
});

export default router;
