import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";
import { db, billingSettingsTable, switchboardsTable, switchboardDocumentsTable, switchboardQrAccessLogsTable } from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { normalizedUserAgentSha256 } from "../lib/evidence-hash";
import { decryptQrToken, hashAuditIp, hashQrToken, renderQrPng } from "../lib/switchboard-qr";
import { deactivateSwitchboardQrGrant, rotateSwitchboardQrGrant, SwitchboardQrGrantError } from "../lib/switchboard-qr-grant";
import {
  assertNoAuthorizationCredential,
  readPublicBearerToken,
  sendPublicBearerCredentialError,
} from "../lib/public-bearer-auth";

const router: IRouter = Router(); const storage = new ObjectStorageService();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/); const id = z.coerce.number().int().positive();

async function auditAccess(req: Request, switchboardId: number | null, prefix: string | null, outcome: string) {
  await db.insert(switchboardQrAccessLogsTable).values({ switchboardId, tokenPrefix: prefix, outcome, ipHash: hashAuditIp(req.ip), userAgent: normalizedUserAgentSha256(req.get("user-agent")), authenticatedUserId: req.auth?.userId ?? null }).catch(() => undefined);
}

function publicQrToken(req: Request, res: Response, legacyToken?: string): string | null {
  try {
    if (legacyToken !== undefined) {
      assertNoAuthorizationCredential(req);
      return legacyToken;
    }
    return readPublicBearerToken(req);
  } catch (error) {
    if (sendPublicBearerCredentialError(res, error)) return null;
    throw error;
  }
}

async function getPublicSwitchboard(
  req: Request,
  res: Response,
  rawToken: string,
  includeAuthenticatedDetails: boolean,
): Promise<void> {
  const token = tokenSchema.safeParse(rawToken);
  if (!token.success) { await auditAccess(req, null, null, "invalid_format"); res.status(404).json({ error: "QR odkaz není platný." }); return; }
  const [board] = await db.select().from(switchboardsTable).where(and(eq(switchboardsTable.qrTokenHash, hashQrToken(token.data)), eq(switchboardsTable.qrEnabled, true), isNull(switchboardsTable.archivedAt), or(isNull(switchboardsTable.qrExpiresAt), gt(switchboardsTable.qrExpiresAt, new Date()))));
  if (!board) { await auditAccess(req, null, token.data.slice(0, 8), "not_found_or_inactive"); res.status(404).json({ error: "QR odkaz není aktivní." }); return; }
  const [settings, documents] = await Promise.all([db.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, 1)).then((rows) => rows[0] ?? null), db.select({ sha256: switchboardDocumentsTable.sha256, documentType: switchboardDocumentsTable.documentType, version: switchboardDocumentsTable.version, originalFileName: switchboardDocumentsTable.originalFileName, uploadedAt: switchboardDocumentsTable.uploadedAt }).from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, board.id), eq(switchboardDocumentsTable.isPublic, true))).orderBy(desc(switchboardDocumentsTable.uploadedAt))]);
  const internal = includeAuthenticatedDetails && !!req.auth?.permissions.includes("switchboards.view");
  await auditAccess(req, board.id, board.qrTokenPrefix, internal ? "authenticated_view" : "public_view");
  res.json({ designation: board.designation, serialNumber: board.serialNumber, manufacturer: board.manufacturer, productionDate: board.productionDate, documentationStatus: board.processingStatus, contact: settings ? { name: settings.supplierName, address: settings.supplierAddress, phone: settings.supplierPhone, email: settings.supplierEmail } : { name: "Modvolt s.r.o." }, publicDocuments: documents.map((document) => ({ ...document, uploadedAt: document.uploadedAt.toISOString() })), ...(internal ? { internal: { status: board.status, installationLocation: board.installationLocation, typeDesignation: board.typeDesignation, networkSystem: board.networkSystem, ratedVoltage: board.ratedVoltage, ratedCurrent: board.ratedCurrent, ipRating: board.ipRating, ikRating: board.ikRating } } : {}) });
}

async function getPublicSwitchboardDocument(
  req: Request,
  res: Response,
  rawToken: string,
): Promise<void> {
  const token = tokenSchema.safeParse(rawToken); const sha = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.params.sha256);
  if (!token.success || !sha.success) { res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  const [board] = await db.select({ id: switchboardsTable.id }).from(switchboardsTable).where(and(eq(switchboardsTable.qrTokenHash, hashQrToken(token.data)), eq(switchboardsTable.qrEnabled, true), isNull(switchboardsTable.archivedAt), or(isNull(switchboardsTable.qrExpiresAt), gt(switchboardsTable.qrExpiresAt, new Date()))));
  if (!board) { res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  const [document] = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, board.id), eq(switchboardDocumentsTable.sha256, sha.data), eq(switchboardDocumentsTable.isPublic, true)));
  if (!document) { await auditAccess(req, board.id, token.data.slice(0, 8), "public_document_denied"); res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.originalFileName)}`);
  try { await storage.servePrivateObject(document.storagePath, res); await auditAccess(req, board.id, token.data.slice(0, 8), "public_document_view"); }
  catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "Dokument není dostupný." }); }
}

router.get("/q/board", async (req, res): Promise<void> => {
  const token = publicQrToken(req, res);
  if (token) await getPublicSwitchboard(req, res, token, false);
});

router.get("/q/board/:token", async (req, res): Promise<void> => {
  const token = publicQrToken(req, res, req.params.token);
  if (token) await getPublicSwitchboard(req, res, token, true);
});

router.get("/q/board/documents/:sha256", async (req, res): Promise<void> => {
  const token = publicQrToken(req, res);
  if (token) await getPublicSwitchboardDocument(req, res, token);
});

router.get("/q/board/:token/documents/:sha256", async (req, res): Promise<void> => {
  const token = publicQrToken(req, res, req.params.token);
  if (token) await getPublicSwitchboardDocument(req, res, token);
});

router.post("/switchboards/:id/qr/rotate", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const expiresAt = z.object({ expiresAt: z.iso.datetime().nullable().optional() }).safeParse(req.body);
  if (!expiresAt.success) { res.status(400).json({ error: "Neplatná expirace QR odkazu." }); return; }
  if (!req.auth) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const result = await rotateSwitchboardQrGrant({
      switchboardId: boardId.data,
      actorUserId: req.auth.userId,
      requestedExpiresAt: expiresAt.data.expiresAt ? new Date(expiresAt.data.expiresAt) : null,
    });
    res.json({ enabled: true, publicUrl: result.publicUrl, tokenPrefix: result.board.qrTokenPrefix, expiresAt: result.board.qrExpiresAt!.toISOString() });
  } catch (error) {
    if (error instanceof RangeError) { res.status(400).json({ error: "Expirace QR odkazu musí být v budoucnosti a nejvýše pět let." }); return; }
    if (error instanceof SwitchboardQrGrantError) { res.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
});

router.post("/switchboards/:id/qr/deactivate", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  if (!req.auth) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    await deactivateSwitchboardQrGrant({ switchboardId: boardId.data, actorUserId: req.auth.userId });
    res.json({ enabled: false });
  } catch (error) {
    if (error instanceof SwitchboardQrGrantError) { res.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
});

router.get("/switchboards/:id/qr/png", requirePermission("switchboards.qr.manage"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const [board] = await db.select({ qrEnabled: switchboardsTable.qrEnabled, qrTokenCiphertext: switchboardsTable.qrTokenCiphertext })
    .from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
  if (!board?.qrEnabled || !board.qrTokenCiphertext) { res.status(409).json({ error: "QR přístup není aktivní." }); return; }
  try {
    const png = await renderQrPng(decryptQrToken(board.qrTokenCiphertext, boardId.data));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="rozvadec-${boardId.data}-qr.png"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(png);
  } catch (error) {
    req.log?.error({ err: error, switchboardId: boardId.data }, "Switchboard QR rendering failed");
    res.status(503).json({ error: "QR kód nyní nelze bezpečně vytvořit." });
  }
});

export default router;
