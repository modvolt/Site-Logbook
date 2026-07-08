import { Router, type IRouter, type Response } from "express";
import { eq, and, ilike, or } from "drizzle-orm";
import {
  db,
  materialsTable,
  jobsTable,
  billingDocumentsTable,
  billingDocumentLinesTable,
  auditLogTable,
} from "@workspace/db";
import {
  ListMaterialsParams,
  CreateMaterialParams,
  CreateMaterialBody,
  UpdateMaterialParams,
  UpdateMaterialBody,
  DeleteMaterialParams,
  LinkMaterialToDocumentParams,
  LinkMaterialToDocumentBody,
} from "@workspace/api-zod";
import {
  reconcileMaterialStockMovement,
  reconcileSourceMovements,
  resolveWarehouseItemIdByName,
  type Actor,
} from "../lib/warehouse-service";
import { requireRole } from "../middlewares/auth";

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
    purchasePricePerUnit: m.purchasePricePerUnit != null ? Number(m.purchasePricePerUnit) : null,
    priceConfidence: m.priceConfidence != null ? Number(m.priceConfidence) : null,
    priceSourceDate: m.priceSourceDate != null ? m.priceSourceDate.toISOString() : null,
    invoicedAt: m.invoicedAt != null ? m.invoicedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

function isDocumentOwnedMaterial(m: typeof materialsTable.$inferSelect): boolean {
  return m.sourceType === "billing_document_line" && m.sourceId != null;
}

function isCustomerInvoicedMaterial(m: typeof materialsTable.$inferSelect): boolean {
  return m.invoicedInvoiceId != null;
}

function rejectManagedMaterial(res: Response, action: "upravit" | "smazat") {
  res.status(409).json({
    error: `Materiál nejde ${action} v zakázce. Je řízený schváleným dokladem nebo už byl použit ve fakturaci; upravte původní doklad.`,
  });
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

  const { quantity, pricePerUnit, warehouseItemId: bodyWarehouseItemId, ...rest } = parsed.data;
  const actor = actorOf(req);
  // Insert the material and draw down any matching warehouse item (výdej) in one
  // transaction so stock and the job material can never drift apart.
  const material = await db.transaction(async (tx) => {
    // Prefer explicit warehouseItemId from body (user picked one); fall back to
    // auto-resolution by name for unambiguous matches.
    const warehouseItemId = bodyWarehouseItemId !== undefined
      ? bodyWarehouseItemId
      : await resolveWarehouseItemIdByName(tx, rest.name);
    const [m] = await tx
      .insert(materialsTable)
      .values({
        jobId: params.data.jobId,
        ...rest,
        quantity: toStr(quantity),
        pricePerUnit: toStr(pricePerUnit),
        warehouseItemId,
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

  const { quantity, pricePerUnit, warehouseItemId: bodyWarehouseItemId, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (quantity !== undefined) updateData.quantity = toStr(quantity);
  if (pricePerUnit !== undefined) updateData.pricePerUnit = toStr(pricePerUnit);

  const [existing] = await db
    .select()
    .from(materialsTable)
    .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)));
  if (!existing) { res.status(404).json({ error: "Material not found" }); return; }
  if (isDocumentOwnedMaterial(existing) || isCustomerInvoicedMaterial(existing)) {
    rejectManagedMaterial(res, "upravit");
    return;
  }

  const actor = actorOf(req);
  const material = await db.transaction(async (tx) => {
    if (bodyWarehouseItemId !== undefined) {
      // Explicit override from the UI takes priority over auto-resolution.
      updateData.warehouseItemId = bodyWarehouseItemId;
    } else if (typeof rest.name === "string") {
      // When the name changes, re-resolve the warehouseItemId so the FK stays
      // accurate. If name wasn't updated we leave the existing ID in place.
      updateData.warehouseItemId = await resolveWarehouseItemIdByName(tx, rest.name);
    }
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

  const [existing] = await db
    .select()
    .from(materialsTable)
    .where(and(eq(materialsTable.id, params.data.materialId), eq(materialsTable.jobId, params.data.jobId)));
  if (!existing) { res.status(404).json({ error: "Material not found" }); return; }
  if (isDocumentOwnedMaterial(existing) || isCustomerInvoicedMaterial(existing)) {
    rejectManagedMaterial(res, "smazat");
    return;
  }

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

// ---------------------------------------------------------------------------
// Linkable document lines: approved billing-document lines searchable across
// all documents — used by the material linking dialog (admin only).
// ---------------------------------------------------------------------------

router.get("/materials/linkable-document-lines", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const conditions = [eq(billingDocumentLinesTable.approved, 1)];

  if (q) {
    const like = `%${q}%`;
    conditions.push(
      or(
        ilike(billingDocumentLinesTable.description, like),
        ilike(billingDocumentsTable.supplierName, like),
        ilike(billingDocumentsTable.documentNumber, like),
      )!,
    );
  }

  const rows = await db
    .select({
      id: billingDocumentLinesTable.id,
      documentId: billingDocumentLinesTable.documentId,
      documentNumber: billingDocumentsTable.documentNumber,
      supplierName: billingDocumentsTable.supplierName,
      description: billingDocumentLinesTable.description,
      quantity: billingDocumentLinesTable.quantity,
      unit: billingDocumentLinesTable.unit,
      unitPriceWithoutVat: billingDocumentLinesTable.unitPriceWithoutVat,
      totalWithoutVat: billingDocumentLinesTable.totalWithoutVat,
      approved: billingDocumentLinesTable.approved,
      sortOrder: billingDocumentLinesTable.sortOrder,
    })
    .from(billingDocumentLinesTable)
    .innerJoin(billingDocumentsTable, eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id))
    .where(and(...conditions))
    .orderBy(billingDocumentsTable.documentNumber, billingDocumentLinesTable.sortOrder)
    .limit(100);

  res.json(
    rows.map((r) => ({
      ...r,
      quantity: r.quantity != null ? Number(r.quantity) : null,
      unitPriceWithoutVat: Number(r.unitPriceWithoutVat),
      totalWithoutVat: Number(r.totalWithoutVat),
      approved: r.approved === 1,
    })),
  );
});

// ---------------------------------------------------------------------------
// Link/unlink a job-material row to a billing-document line (admin only).
// Linking records where the purchase price came from so margin is trackable.
// The selling pricePerUnit stays unchanged — only the provenance link is set.
// ---------------------------------------------------------------------------

router.patch("/materials/:materialId/link-document", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = LinkMaterialToDocumentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const parsed = LinkMaterialToDocumentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { materialId } = params.data;
  const { billingDocumentLineId } = parsed.data;
  const actor = actorOf(req);

  const [existing] = await db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.id, materialId));
  if (!existing) { res.status(404).json({ error: "Material not found" }); return; }

  let updateData: Record<string, unknown>;

  if (billingDocumentLineId != null) {
    // Verify the billing document line exists and is approved.
    const [line] = await db
      .select({
        id: billingDocumentLinesTable.id,
        documentId: billingDocumentLinesTable.documentId,
        approved: billingDocumentLinesTable.approved,
        supplierName: billingDocumentsTable.supplierName,
        issueDate: billingDocumentsTable.issueDate,
      })
      .from(billingDocumentLinesTable)
      .innerJoin(billingDocumentsTable, eq(billingDocumentLinesTable.documentId, billingDocumentsTable.id))
      .where(eq(billingDocumentLinesTable.id, billingDocumentLineId));

    if (!line) { res.status(404).json({ error: "Billing document line not found" }); return; }
    if (!line.approved) { res.status(400).json({ error: "Řádek dokladu není schválen." }); return; }

    // Fetch the line's unit price to store as purchase price for margin display.
    const [linePrice] = await db
      .select({ unitPriceWithoutVat: billingDocumentLinesTable.unitPriceWithoutVat })
      .from(billingDocumentLinesTable)
      .where(eq(billingDocumentLinesTable.id, billingDocumentLineId));

    updateData = {
      priceSource: "manual_link",
      priceSourceDocumentId: line.documentId,
      priceSourceLineId: billingDocumentLineId,
      priceSourceSupplierName: line.supplierName ?? null,
      priceSourceDate: line.issueDate ? new Date(line.issueDate) : null,
      purchasePricePerUnit: linePrice?.unitPriceWithoutVat ?? null,
    };
  } else {
    // Unlink: revert to "manual" provenance and clear all source references.
    updateData = {
      priceSource: "manual",
      priceSourceDocumentId: null,
      priceSourceLineId: null,
      priceSourceSupplierName: null,
      priceSourceDate: null,
      purchasePricePerUnit: null,
    };
  }

  const [updated] = await db
    .update(materialsTable)
    .set(updateData)
    .where(eq(materialsTable.id, materialId))
    .returning();

  // Audit log.
  await db.insert(auditLogTable).values({
    actorUserId: actor.userId,
    actorName: actor.name,
    action: billingDocumentLineId != null ? "material_link_document" : "material_unlink_document",
    entityType: "material",
    entityId: materialId,
  });

  res.json(serializeMaterial(updated));
});

export default router;
