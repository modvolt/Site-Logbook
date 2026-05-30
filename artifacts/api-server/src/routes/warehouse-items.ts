import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, warehouseItemsTable } from "@workspace/db";
import {
  CreateWarehouseItemBody,
  UpdateWarehouseItemParams,
  UpdateWarehouseItemBody,
  DeleteWarehouseItemParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

const NUMERIC_FIELDS = ["quantity", "purchasePrice", "salePrice", "minQuantity"] as const;

function serializeWarehouseItem(w: typeof warehouseItemsTable.$inferSelect) {
  return {
    ...w,
    quantity: w.quantity != null ? Number(w.quantity) : 0,
    purchasePrice: w.purchasePrice != null ? Number(w.purchasePrice) : null,
    salePrice: w.salePrice != null ? Number(w.salePrice) : null,
    minQuantity: w.minQuantity != null ? Number(w.minQuantity) : null,
    createdAt: w.createdAt.toISOString(),
  };
}

function numericToStrings(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of NUMERIC_FIELDS) {
    if (f in out) out[f] = toStr(out[f] as number | null | undefined);
  }
  return out;
}

router.get("/warehouse-items", async (_req, res): Promise<void> => {
  const items = await db.select().from(warehouseItemsTable).orderBy(warehouseItemsTable.name);
  res.json(items.map(serializeWarehouseItem));
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
  res.status(201).json(serializeWarehouseItem(item));
});

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

  res.json(serializeWarehouseItem(item));
});

router.delete("/warehouse-items/:id", async (req, res): Promise<void> => {
  const params = DeleteWarehouseItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db
    .delete(warehouseItemsTable)
    .where(eq(warehouseItemsTable.id, params.data.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Warehouse item not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
