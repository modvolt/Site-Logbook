import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, materialsTable, jobsTable } from "@workspace/db";
import {
  ListMaterialsParams,
  CreateMaterialParams,
  CreateMaterialBody,
  UpdateMaterialParams,
  UpdateMaterialBody,
  DeleteMaterialParams,
} from "@workspace/api-zod";
import {
  reconcileMaterialStockMovement,
  reconcileSourceMovements,
  type Actor,
} from "../lib/warehouse-service";

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

function actorOf(req: { auth?: { userId: number; name: string } }): Actor {
  return { userId: req.auth?.userId ?? null, name: req.auth?.name ?? "Systém" };
}

function serializeMaterial(m: typeof materialsTable.$inferSelect) {
  return {
    ...m,
    quantity: m.quantity != null ? Number(m.quantity) : null,
    pricePerUnit: m.pricePerUnit != null ? Number(m.pricePerUnit) : null,
    priceConfidence: m.priceConfidence != null ? Number(m.priceConfidence) : null,
    priceSourceDate: m.priceSourceDate != null ? m.priceSourceDate.toISOString() : null,
    invoicedAt: m.invoicedAt != null ? m.invoicedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/jobs/:jobId/materials", async (req, res): Promise<void> => {
  const params = ListMaterialsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const materials = await db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.jobId, params.data.jobId))
    .orderBy(materialsTable.sortOrder, materialsTable.createdAt);

  res.json(materials.map(serializeMaterial));
});

router.post("/jobs/:jobId/materials", async (req, res): Promise<void> => {
  const params = CreateMaterialParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const parsed = CreateMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { quantity, pricePerUnit, ...rest } = parsed.data;
  const actor = actorOf(req);
  // Insert the material and draw down any matching warehouse item (výdej) in one
  // transaction so stock and the job material can never drift apart.
  const material = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(materialsTable)
      .values({
        jobId: params.data.jobId,
        ...rest,
        quantity: toStr(quantity),
        pricePerUnit: toStr(pricePerUnit),
      })
      .returning();
    await reconcileMaterialStockMovement(tx, m, actor);
    return m;
  });

  res.status(201).json(serializeMaterial(material));
});

router.patch("/jobs/:jobId/materials/:materialId", async (req, res): Promise<void> => {
  const params = UpdateMaterialParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const parsed = UpdateMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { quantity, pricePerUnit, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (quantity !== undefined) updateData.quantity = toStr(quantity);
  if (pricePerUnit !== undefined) updateData.pricePerUnit = toStr(pricePerUnit);

  const actor = actorOf(req);
  const material = await db.transaction(async (tx) => {
    const [m] = await tx
      .update(materialsTable)
      .set(updateData)
      .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)))
      .returning();
    if (!m) return null;
    // Re-reconcile: a name/quantity change moves the issued amount accordingly.
    await reconcileMaterialStockMovement(tx, m, actor);
    return m;
  });

  if (!material) { res.status(404).json({ error: "Material not found" }); return; }

  res.json(serializeMaterial(material));
});

router.delete("/jobs/:jobId/materials/:materialId", async (req, res): Promise<void> => {
  const params = DeleteMaterialParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const actor = actorOf(req);
  const material = await db.transaction(async (tx) => {
    const [m] = await tx
      .delete(materialsTable)
      .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)))
      .returning();
    if (!m) return null;
    // Reverse the stock issue only once we know this scoped row really existed.
    await reconcileSourceMovements(tx, "material", params.data.materialId, null, actor);
    return m;
  });

  if (!material) { res.status(404).json({ error: "Material not found" }); return; }

  res.sendStatus(204);
});

export default router;
