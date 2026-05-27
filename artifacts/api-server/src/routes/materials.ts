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

const router: IRouter = Router();

const toStr = (v: number | null | undefined): string | null | undefined =>
  v != null ? String(v) : v as null | undefined;

function serializeMaterial(m: typeof materialsTable.$inferSelect) {
  return {
    ...m,
    quantity: m.quantity != null ? Number(m.quantity) : null,
    pricePerUnit: m.pricePerUnit != null ? Number(m.pricePerUnit) : null,
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
  const [material] = await db
    .insert(materialsTable)
    .values({
      jobId: params.data.jobId,
      ...rest,
      quantity: toStr(quantity),
      pricePerUnit: toStr(pricePerUnit),
    })
    .returning();

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

  const [material] = await db
    .update(materialsTable)
    .set(updateData)
    .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)))
    .returning();

  if (!material) { res.status(404).json({ error: "Material not found" }); return; }

  res.json(serializeMaterial(material));
});

router.delete("/jobs/:jobId/materials/:materialId", async (req, res): Promise<void> => {
  const params = DeleteMaterialParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [material] = await db
    .delete(materialsTable)
    .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)))
    .returning();

  if (!material) { res.status(404).json({ error: "Material not found" }); return; }

  res.sendStatus(204);
});

export default router;
