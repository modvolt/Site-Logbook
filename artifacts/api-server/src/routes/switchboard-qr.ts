import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";
import { db, billingSettingsTable, switchboardsTable, switchboardDocumentsTable, switchboardEventsTable, switchboardQrAccessLogsTable } from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { createQrToken, decryptQrToken, encryptQrToken, hashAuditIp, hashQrToken, publicQrUrl, renderQrPng } from "../lib/switchboard-qr";

const router: IRouter = Router(); const storage = new ObjectStorageService();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/); const id = z.coerce.number().int().positive();
const publicLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Příliš mnoho požadavků. Zkuste to později." } });

async function auditAccess(req: Request, switchboardId: number | null, prefix: string | null, outcome: string) {
  await db.insert(switchboardQrAccessLogsTable).values({ switchboardId, tokenPrefix: prefix, outcome, ipHash: hashAuditIp(req.ip), userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null, authenticatedUserId: req.auth?.userId ?? null }).catch(() => undefined);
}

router.get("/q/board/:token", publicLimiter, async (req, res) => {
  const token = tokenSchema.safeParse(req.params.token);
  if (!token.success) { await auditAccess(req, null, null, "invalid_format"); res.status(404).json({ error: "QR odkaz není platný." }); return; }
  const [board] = await db.select().from(switchboardsTable).where(and(eq(switchboardsTable.qrTokenHash, hashQrToken(token.data)), eq(switchboardsTable.qrEnabled, true), isNull(switchboardsTable.archivedAt), or(isNull(switchboardsTable.qrExpiresAt), gt(switchboardsTable.qrExpiresAt, new Date()))));
  if (!board) { await auditAccess(req, null, token.data.slice(0, 8), "not_found_or_inactive"); res.status(404).json({ error: "QR odkaz není aktivní." }); return; }
  const [settings, documents] = await Promise.all([db.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, 1)).then((rows) => rows[0] ?? null), db.select({ sha256: switchboardDocumentsTable.sha256, documentType: switchboardDocumentsTable.documentType, version: switchboardDocumentsTable.version, originalFileName: switchboardDocumentsTable.originalFileName, uploadedAt: switchboardDocumentsTable.uploadedAt }).from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, board.id), eq(switchboardDocumentsTable.isPublic, true))).orderBy(desc(switchboardDocumentsTable.uploadedAt))]);
  const internal = !!req.auth?.permissions.includes("switchboards.view");
  await auditAccess(req, board.id, board.qrTokenPrefix, internal ? "authenticated_view" : "public_view");
  res.json({ designation: board.designation, serialNumber: board.serialNumber, manufacturer: board.manufacturer, productionDate: board.productionDate, documentationStatus: board.processingStatus, contact: settings ? { name: settings.supplierName, address: settings.supplierAddress, phone: settings.supplierPhone, email: settings.supplierEmail } : { name: "Modvolt s.r.o." }, publicDocuments: documents.map((document) => ({ ...document, uploadedAt: document.uploadedAt.toISOString() })), ...(internal ? { internal: { status: board.status, installationLocation: board.installationLocation, typeDesignation: board.typeDesignation, networkSystem: board.networkSystem, ratedVoltage: board.ratedVoltage, ratedCurrent: board.ratedCurrent, ipRating: board.ipRating, ikRating: board.ikRating } } : {}) });
});

router.get("/q/board/:token/documents/:sha256", publicLimiter, async (req, res) => {
  const token = tokenSchema.safeParse(req.params.token); const sha = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.params.sha256);
  if (!token.success || !sha.success) { res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  const [board] = await db.select({ id: switchboardsTable.id }).from(switchboardsTable).where(and(eq(switchboardsTable.qrTokenHash, hashQrToken(token.data)), eq(switchboardsTable.qrEnabled, true), isNull(switchboardsTable.archivedAt), or(isNull(switchboardsTable.qrExpiresAt), gt(switchboardsTable.qrExpiresAt, new Date()))));
  if (!board) { res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  const [document] = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, board.id), eq(switchboardDocumentsTable.sha256, sha.data), eq(switchboardDocumentsTable.isPublic, true)));
  if (!document) { await auditAccess(req, board.id, token.data.slice(0, 8), "public_document_denied"); res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.originalFileName)}`);
  try { await storage.servePrivateObject(document.storagePath, res); await auditAccess(req, board.id, token.data.slice(0, 8), "public_document_view"); }
  catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "Dokument není dostupný." }); }
});

router.post("/switchboards/:id/qr/rotate", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const token = createQrToken(); const expiresAt = z.object({ expiresAt: z.iso.datetime().nullable().optional() }).safeParse(req.body);
  if (!expiresAt.success) { res.status(400).json({ error: "Neplatná expirace QR odkazu." }); return; }
  const [board] = await db.update(switchboardsTable).set({ qrTokenHash: hashQrToken(token), qrTokenCiphertext: encryptQrToken(token), qrTokenPrefix: token.slice(0, 8), qrEnabled: true, qrExpiresAt: expiresAt.data.expiresAt ? new Date(expiresAt.data.expiresAt) : null, updatedAt: new Date() }).where(eq(switchboardsTable.id, boardId.data)).returning();
  if (!board) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  const url = publicQrUrl(token, `${req.protocol}://${req.get("host")}`);
  await db.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "qr_token_rotated", entityType: "switchboard", entityId: board.id, payload: { tokenPrefix: board.qrTokenPrefix, expiresAt: board.qrExpiresAt?.toISOString() ?? null }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null });
  res.json({ enabled: true, publicUrl: url, tokenPrefix: board.qrTokenPrefix, expiresAt: board.qrExpiresAt?.toISOString() ?? null });
});

router.post("/switchboards/:id/qr/deactivate", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const [board] = await db.update(switchboardsTable).set({ qrEnabled: false, updatedAt: new Date() }).where(eq(switchboardsTable.id, boardId.data)).returning();
  if (!board) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  await db.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "qr_token_deactivated", entityType: "switchboard", entityId: board.id, payload: { tokenPrefix: board.qrTokenPrefix }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null });
  res.json({ enabled: false });
});

router.get("/switchboards/:id/qr/png", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const [board] = await db.select({ qrEnabled: switchboardsTable.qrEnabled, qrTokenCiphertext: switchboardsTable.qrTokenCiphertext })
    .from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
  if (!board?.qrEnabled || !board.qrTokenCiphertext) { res.status(409).json({ error: "QR přístup není aktivní." }); return; }
  try {
    const png = await renderQrPng(decryptQrToken(board.qrTokenCiphertext), `${req.protocol}://${req.get("host")}`);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="rozvadec-${boardId.data}-qr.png"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(png);
  } catch (error) {
    res.status(503).json({ error: (error as Error).message });
  }
});

export default router;
