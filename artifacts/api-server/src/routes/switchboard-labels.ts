import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db, switchboardDocumentsTable, switchboardLabelVersionsTable, switchboardEventsTable } from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { validateLabelSnapshot, type SwitchboardLabelSnapshot } from "../lib/switchboard-label";
import { compareSnapshotRecords } from "../lib/switchboard-admin";
import { createSwitchboardLabelVersion, latestCompletedDboDocumentId } from "../lib/switchboard-label-version";

const router: IRouter = Router(); const storage = new ObjectStorageService(); const id = z.coerce.number().int().positive();
const serialize = (row: typeof switchboardLabelVersionsTable.$inferSelect) => {
  const { pdfStoragePath: _pdfStoragePath, pngStoragePath: _pngStoragePath, ...label } = row;
  return { ...label, createdAt: row.createdAt.toISOString(), approvedAt: row.approvedAt?.toISOString() ?? null };
};

router.get("/switchboards/:id/labels", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  const rows = await db.select().from(switchboardLabelVersionsTable).where(eq(switchboardLabelVersionsTable.switchboardId, boardId.data)).orderBy(desc(switchboardLabelVersionsTable.version)); res.json(rows.map(serialize));
});

router.get("/switchboards/:id/labels/compare", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const fromId = id.safeParse(req.query.from); const toId = id.safeParse(req.query.to);
  if (!boardId.success || !fromId.success || !toId.success) { res.status(400).json({ error: "Vyberte dvě platné verze štítku." }); return; }
  if (fromId.data === toId.data) { res.status(400).json({ error: "Pro porovnání vyberte dvě rozdílné verze štítku." }); return; }
  const labels = await db.select().from(switchboardLabelVersionsTable).where(and(eq(switchboardLabelVersionsTable.switchboardId, boardId.data), inArray(switchboardLabelVersionsTable.id, [fromId.data, toId.data])));
  if (labels.length !== 2) { res.status(404).json({ error: "Jedna z verzí štítku nebyla nalezena." }); return; }
  const sourceIds = labels.map((label) => label.sourceDocumentId).filter((value): value is number => value != null);
  const sources = sourceIds.length ? await db.select({ id: switchboardDocumentsTable.id, version: switchboardDocumentsTable.version }).from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, boardId.data), inArray(switchboardDocumentsTable.id, sourceIds))) : [];
  const meta = (labelId: number) => {
    const label = labels.find((row) => row.id === labelId)!;
    return { id: label.id, version: label.version, status: label.status, generatorVersion: label.generatorVersion, sourceDocumentId: label.sourceDocumentId, sourceDocumentVersion: sources.find((source) => source.id === label.sourceDocumentId)?.version ?? null, createdAt: label.createdAt.toISOString(), approvedAt: label.approvedAt?.toISOString() ?? null };
  };
  const before = labels.find((label) => label.id === fromId.data)!;
  const after = labels.find((label) => label.id === toId.data)!;
  res.json({ from: meta(fromId.data), to: meta(toId.data), changes: compareSnapshotRecords(before.inputSnapshot, after.inputSnapshot) });
});

router.post("/switchboards/:id/labels/generate", requirePermission("switchboards.labels.generate"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  try {
    const sourceDocumentId = await latestCompletedDboDocumentId(boardId.data);
    const { label } = await createSwitchboardLabelVersion({
      switchboardId: boardId.data,
      sourceDocumentId,
      mode: "manual",
      actor: { userId: req.auth?.userId ?? null, name: req.auth?.name ?? req.auth?.username ?? null },
      requestBaseUrl: `${req.protocol}://${req.get("host")}`,
    });
    res.status(201).json(serialize(label));
  } catch (error) {
    const typed = error as Error & { statusCode?: number; missingFields?: string[] };
    res.status(typed.statusCode ?? 500).json({ error: typed.message || "Generování štítku selhalo.", ...(typed.missingFields ? { missingFields: typed.missingFields } : {}) });
  }
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
