import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, billingSettingsTable, switchboardsTable, switchboardDocumentsTable, switchboardLabelVersionsTable, switchboardEventsTable } from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { decryptQrToken, publicQrUrl } from "../lib/switchboard-qr";
import { generateSwitchboardLabel, SWITCHBOARD_LABEL_GENERATOR_VERSION, validateLabelSnapshot, type SwitchboardLabelSnapshot } from "../lib/switchboard-label";

const router: IRouter = Router(); const storage = new ObjectStorageService(); const id = z.coerce.number().int().positive();
const serialize = (row: typeof switchboardLabelVersionsTable.$inferSelect) => {
  const { pdfStoragePath: _pdfStoragePath, pngStoragePath: _pngStoragePath, ...label } = row;
  return { ...label, createdAt: row.createdAt.toISOString(), approvedAt: row.approvedAt?.toISOString() ?? null };
};

router.get("/switchboards/:id/labels", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  const rows = await db.select().from(switchboardLabelVersionsTable).where(eq(switchboardLabelVersionsTable.switchboardId, boardId.data)).orderBy(desc(switchboardLabelVersionsTable.version)); res.json(rows.map(serialize));
});

router.post("/switchboards/:id/labels/generate", requirePermission("switchboards.labels.generate"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  const [[board], [settings], [sourceDocument]] = await Promise.all([
    db.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data)),
    db.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, 1)),
    db.select({ id: switchboardDocumentsTable.id }).from(switchboardDocumentsTable)
      .where(and(eq(switchboardDocumentsTable.switchboardId, boardId.data), eq(switchboardDocumentsTable.documentType, "schrack_norm_dbo"), eq(switchboardDocumentsTable.processingStatus, "completed")))
      .orderBy(desc(switchboardDocumentsTable.version)).limit(1),
  ]);
  if (!board) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  if (!board.qrEnabled || !board.qrTokenCiphertext) { res.status(409).json({ error: "Nejprve aktivujte QR přístup rozvaděče." }); return; }
  let token: string; try { token = decryptQrToken(board.qrTokenCiphertext); } catch (error) { res.status(503).json({ error: (error as Error).message }); return; }
  const snapshot: SwitchboardLabelSnapshot = { designation: board.designation, serialNumber: board.serialNumber ?? "", productionDate: board.productionDate ?? "", typeDesignation: board.typeDesignation ?? "", manufacturer: board.manufacturer, standards: board.standards, networkSystem: board.networkSystem ?? "", ratedVoltage: board.ratedVoltage ?? "", ratedFrequency: board.ratedFrequency ?? "", ratedCurrent: board.ratedCurrent ?? "", dimensions: board.dimensions, weight: board.weight, ipRating: board.ipRating ?? "", ikRating: board.ikRating, companyAddress: settings?.supplierAddress, companyPhone: settings?.supplierPhone };
  const missing = validateLabelSnapshot(snapshot); if (missing.length) { res.status(409).json({ error: "Typový štítek nelze vytvořit, chybí povinné potvrzené údaje.", missingFields: missing }); return; }
  const url = publicQrUrl(token, `${req.protocol}://${req.get("host")}`); const output = await generateSwitchboardLabel(snapshot, url);
  const nonce = randomUUID(); const pdfPath = `/objects/switchboards/${board.id}/labels/${nonce}.pdf`; const pngPath = `/objects/switchboards/${board.id}/labels/${nonce}.png`;
  try {
    await Promise.all([storage.putPrivateObject(pdfPath, output.pdf, "application/pdf"), storage.putPrivateObject(pngPath, output.png, "image/png")]);
    const label = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${board.id}, 8403)`);
      const [{ value }] = await tx.select({ value: max(switchboardLabelVersionsTable.version) }).from(switchboardLabelVersionsTable).where(eq(switchboardLabelVersionsTable.switchboardId, board.id));
      const [created] = await tx.insert(switchboardLabelVersionsTable).values({ switchboardId: board.id, version: Number(value ?? 0) + 1, sourceDocumentId: sourceDocument?.id ?? null, inputSnapshot: snapshot, pdfStoragePath: pdfPath, pngStoragePath: pngPath, qrTarget: `/q/board/${board.qrTokenPrefix ?? "unknown"}…`, status: "draft", generatorVersion: SWITCHBOARD_LABEL_GENERATOR_VERSION, createdByUserId: req.auth?.userId ?? null }).returning();
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "label_generated", entityType: "switchboard_label_version", entityId: created.id, payload: { version: created.version, sourceDocumentId: sourceDocument?.id ?? null, generatorVersion: SWITCHBOARD_LABEL_GENERATOR_VERSION, qrTokenPrefix: board.qrTokenPrefix }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null }); return created;
    });
    res.status(201).json(serialize(label));
  } catch (error) { await Promise.allSettled([storage.deletePrivateObject(pdfPath), storage.deletePrivateObject(pngPath)]); res.status(500).json({ error: `Generování štítku selhalo: ${(error as Error).message}` }); }
});

router.post("/switchboards/:id/labels/:labelId/approve", requirePermission("switchboards.labels.approve"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const labelId = id.safeParse(req.params.labelId); if (!boardId.success || !labelId.success) { res.status(400).json({ error: "Neplatný štítek." }); return; }
  const [label] = await db.select().from(switchboardLabelVersionsTable).where(and(eq(switchboardLabelVersionsTable.id, labelId.data), eq(switchboardLabelVersionsTable.switchboardId, boardId.data)));
  if (!label) { res.status(404).json({ error: "Štítek nebyl nalezen." }); return; }
  const missing = validateLabelSnapshot(label.inputSnapshot as Partial<SwitchboardLabelSnapshot>); if (missing.length) { res.status(409).json({ error: "Štítek nemá všechna povinná pole.", missingFields: missing }); return; }
  const now = new Date(); const [approved] = await db.update(switchboardLabelVersionsTable).set({ status: "approved", approvedByUserId: req.auth?.userId ?? null, approvedAt: now }).where(eq(switchboardLabelVersionsTable.id, label.id)).returning();
  await db.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "label_approved", entityType: "switchboard_label_version", entityId: label.id, payload: { version: label.version }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null }); res.json(serialize(approved));
});

router.get("/switchboards/:id/labels/:labelId/:format", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const labelId = id.safeParse(req.params.labelId); const format = z.enum(["pdf", "png"]).safeParse(req.params.format); if (!boardId.success || !labelId.success || !format.success) { res.status(400).json({ error: "Neplatný výstup štítku." }); return; }
  const [label] = await db.select().from(switchboardLabelVersionsTable).where(and(eq(switchboardLabelVersionsTable.id, labelId.data), eq(switchboardLabelVersionsTable.switchboardId, boardId.data)));
  const path = format.data === "pdf" ? label?.pdfStoragePath : label?.pngStoragePath; if (!label || !path) { res.status(404).json({ error: "Výstup štítku nebyl nalezen." }); return; }
  try { await storage.servePrivateObject(path, res); } catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "Výstup štítku není dostupný." }); }
});

export default router;
