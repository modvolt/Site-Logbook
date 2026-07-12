import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, jobsTable, peopleTable, switchboardsTable, switchboardAssigneesTable,
  switchboardEventsTable, switchboardDocumentsTable, switchboardProcessingJobsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { SWITCHBOARD_PARSER_VERSION } from "../lib/switchboard-parser";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
const documentTypes = ["schrack_design", "schrack_norm_dbo", "measurement_protocol", "checklist_protocol", "other"] as const;

function parsePdfBody(req: Request, res: Response, next: NextFunction): void {
  express.raw({ type: "application/pdf", limit: MAX_DOCUMENT_BYTES })(req, res, (error) => {
    if ((error as { type?: string; status?: number } | undefined)?.type === "entity.too.large" || (error as { status?: number } | undefined)?.status === 413) {
      res.status(413).json({ error: "PDF je příliš velké (max. 30 MB)." });
      return;
    }
    if (error) { next(error); return; }
    next();
  });
}

const idSchema = z.coerce.number().int().positive();
const statuses = [
  "created", "documentation_uploaded", "assembly", "wiring", "awaiting_inspection",
  "inspection", "awaiting_measurement", "measurement", "defects_found",
  "defects_resolved", "protocol_completed", "ready_for_handover", "handed_over",
  "service", "archived",
] as const;

const boardInput = z.object({
  jobId: z.number().int().positive(),
  internalName: z.string().trim().min(1).max(200),
  designation: z.string().trim().min(1).max(200),
  installationLocation: z.string().trim().max(500).nullable().optional(),
  serialNumber: z.string().trim().max(120).nullable().optional(),
  productionDate: z.iso.date().nullable().optional(),
  typeDesignation: z.string().trim().max(200).nullable().optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  networkSystem: z.string().trim().max(50).nullable().optional(),
  ratedVoltage: z.string().trim().max(50).nullable().optional(),
  ratedFrequency: z.string().trim().max(50).nullable().optional(),
  ratedCurrent: z.string().trim().max(50).nullable().optional(),
  ipRating: z.string().trim().max(50).nullable().optional(),
  ikRating: z.string().trim().max(50).nullable().optional(),
  dimensions: z.string().trim().max(100).nullable().optional(),
  weight: z.string().trim().max(50).nullable().optional(),
  standards: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  properties: z.record(z.string(), z.boolean()).optional(),
  notes: z.string().trim().max(10_000).nullable().optional(),
  status: z.enum(statuses).optional(),
  assigneeIds: z.array(z.number().int().positive()).max(100).optional(),
  responsiblePersonId: z.number().int().positive().nullable().optional(),
});

const boardPatch = boardInput.omit({ jobId: true }).partial().strict();

function actor(req: Request) {
  return {
    actorUserId: req.auth?.userId ?? null,
    actorName: req.auth?.name ?? req.auth?.username ?? null,
  };
}

async function serializeBoard(board: typeof switchboardsTable.$inferSelect) {
  const [job, assignees] = await Promise.all([
    db.select({ id: jobsTable.id, title: jobsTable.title, jobNumber: jobsTable.jobNumber })
      .from(jobsTable).where(eq(jobsTable.id, board.jobId)).then((rows) => rows[0] ?? null),
    db.select({
      id: switchboardAssigneesTable.id,
      personId: switchboardAssigneesTable.personId,
      personName: peopleTable.name,
      isResponsible: switchboardAssigneesTable.isResponsible,
      assignedAt: switchboardAssigneesTable.assignedAt,
    }).from(switchboardAssigneesTable)
      .innerJoin(peopleTable, eq(switchboardAssigneesTable.personId, peopleTable.id))
      .where(eq(switchboardAssigneesTable.switchboardId, board.id))
      .orderBy(desc(switchboardAssigneesTable.isResponsible), asc(peopleTable.name)),
  ]);
  return {
    ...board,
    job,
    assignees: assignees.map((item) => ({ ...item, assignedAt: item.assignedAt.toISOString() })),
    productionDate: board.productionDate ?? null,
    qrExpiresAt: board.qrExpiresAt?.toISOString() ?? null,
    archivedAt: board.archivedAt?.toISOString() ?? null,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  };
}

async function assertPeopleExist(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ id: peopleTable.id }).from(peopleTable).where(inArray(peopleTable.id, ids));
  if (rows.length !== new Set(ids).size) throw Object.assign(new Error("Některý přiřazený pracovník neexistuje."), { statusCode: 400 });
}

router.get("/switchboards", requirePermission("switchboards.view"), async (req, res): Promise<void> => {
  const jobId = req.query.jobId == null ? null : idSchema.safeParse(req.query.jobId);
  if (jobId && !jobId.success) {
    res.status(400).json({ error: "Neplatné ID zakázky." });
    return;
  }
  const includeArchived = req.query.includeArchived === "true";
  const filters = [
    ...(jobId?.success ? [eq(switchboardsTable.jobId, jobId.data)] : []),
    ...(!includeArchived ? [isNull(switchboardsTable.archivedAt)] : []),
  ];
  const rows = await db.select().from(switchboardsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(switchboardsTable.updatedAt), desc(switchboardsTable.id));
  res.json(await Promise.all(rows.map(serializeBoard)));
});

router.get("/switchboards/:id/documents", requirePermission("switchboards.documents.view"), async (req, res): Promise<void> => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const rows = await db.select().from(switchboardDocumentsTable)
    .where(eq(switchboardDocumentsTable.switchboardId, parsedId.data))
    .orderBy(desc(switchboardDocumentsTable.uploadedAt), desc(switchboardDocumentsTable.version));
  res.json(rows.map(({ storagePath: _storagePath, ...row }) => ({ ...row, uploadedAt: row.uploadedAt.toISOString() })));
});

router.post(
  "/switchboards/:id/documents",
  requirePermission("switchboards.documents.upload"),
  parsePdfBody,
  async (req, res): Promise<void> => {
    const parsedId = idSchema.safeParse(req.params.id);
    const parsedType = z.enum(documentTypes).safeParse(req.query.type);
    const fileName = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 255) : "";
    if (!parsedId.success || !parsedType.success || !fileName) { res.status(400).json({ error: "Chybí platný typ dokumentu nebo název souboru." }); return; }
    if (!Buffer.isBuffer(req.body) || req.body.length < 5) { res.status(400).json({ error: "PDF soubor je prázdný." }); return; }
    if (req.body.length > MAX_DOCUMENT_BYTES) { res.status(413).json({ error: "PDF je příliš velké (max. 30 MB)." }); return; }
    if (req.body.subarray(0, 5).toString("ascii") !== "%PDF-") { res.status(415).json({ error: "Obsah souboru není platné PDF." }); return; }
    const sha256 = createHash("sha256").update(req.body).digest("hex");
    const objectPath = `/objects/switchboards/${parsedId.data}/documents/${randomUUID()}.pdf`;
    const duplicate = await db.select({ id: switchboardDocumentsTable.id, version: switchboardDocumentsTable.version })
      .from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, parsedId.data), eq(switchboardDocumentsTable.sha256, sha256)));
    if (duplicate.length) { res.status(409).json({ error: `Stejný dokument už existuje jako verze ${duplicate[0].version}.`, duplicateDocumentId: duplicate[0].id }); return; }
    try {
      await objectStorage.putPrivateObject(objectPath, req.body, "application/pdf");
      const document = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${parsedId.data}, 8401)`);
        const [board] = await tx.select({ id: switchboardsTable.id }).from(switchboardsTable).where(eq(switchboardsTable.id, parsedId.data));
        if (!board) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
        const [{ value: currentVersion }] = await tx.select({ value: max(switchboardDocumentsTable.version) }).from(switchboardDocumentsTable)
          .where(and(eq(switchboardDocumentsTable.switchboardId, board.id), eq(switchboardDocumentsTable.documentType, parsedType.data)));
        const [created] = await tx.insert(switchboardDocumentsTable).values({
          switchboardId: board.id, documentType: parsedType.data, version: Number(currentVersion ?? 0) + 1,
          storagePath: objectPath, originalFileName: fileName, mimeType: "application/pdf", sha256,
          sizeBytes: req.body.length, processingStatus: parsedType.data === "schrack_norm_dbo" ? "queued" : "stored",
          uploadedByUserId: req.auth?.userId ?? null,
        }).returning();
        if (parsedType.data === "schrack_norm_dbo") await tx.insert(switchboardProcessingJobsTable).values({ documentId: created.id, parserVersion: SWITCHBOARD_PARSER_VERSION });
        await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "document_uploaded", entityType: "switchboard_document", entityId: created.id, payload: { documentType: parsedType.data, version: created.version, sha256, fileName, sizeBytes: req.body.length }, ...actor(req) });
        return created;
      });
      res.status(201).json({ ...document, storagePath: undefined, uploadedAt: document.uploadedAt.toISOString() });
    } catch (error) {
      await objectStorage.deletePrivateObject(objectPath).catch(() => false);
      const dbCode = (error as { code?: string }).code;
      res.status((error as { statusCode?: number }).statusCode ?? (dbCode === "23505" ? 409 : 500)).json({ error: dbCode === "23505" ? "Stejný dokument už byl mezitím nahrán." : (error as Error).message || "Uložení dokumentu selhalo." });
    }
  },
);

router.get("/switchboards/:id/documents/:documentId/download", requirePermission("switchboards.documents.view"), async (req, res): Promise<void> => {
  const boardId = idSchema.safeParse(req.params.id); const documentId = idSchema.safeParse(req.params.documentId);
  if (!boardId.success || !documentId.success) { res.status(400).json({ error: "Neplatné ID dokumentu." }); return; }
  const [document] = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.id, documentId.data), eq(switchboardDocumentsTable.switchboardId, boardId.data)));
  if (!document) { res.status(404).json({ error: "Dokument nebyl nalezen." }); return; }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.originalFileName)}`);
  try { await objectStorage.servePrivateObject(document.storagePath, res); }
  catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "Soubor dokumentu není dostupný." }); }
});

router.get("/switchboards/:id", requirePermission("switchboards.view"), async (req, res): Promise<void> => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const [row] = await db.select().from(switchboardsTable).where(eq(switchboardsTable.id, parsedId.data));
  if (!row) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  res.json(await serializeBoard(row));
});

router.post("/switchboards", requirePermission("switchboards.create"), async (req, res): Promise<void> => {
  const parsed = boardInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { assigneeIds = [], responsiblePersonId, ...values } = parsed.data;
  const personIds = Array.from(new Set([...assigneeIds, ...(responsiblePersonId ? [responsiblePersonId] : [])]));
  try {
    await assertPeopleExist(personIds);
    const created = await db.transaction(async (tx) => {
      const [job] = await tx.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, values.jobId));
      if (!job) throw Object.assign(new Error("Zakázka nebyla nalezena."), { statusCode: 400 });
      const [row] = await tx.insert(switchboardsTable).values({
        ...values,
        createdByUserId: req.auth?.userId ?? null,
      }).returning();
      if (personIds.length) await tx.insert(switchboardAssigneesTable).values(personIds.map((personId) => ({
        switchboardId: row.id, personId, isResponsible: personId === responsiblePersonId,
      })));
      await tx.insert(switchboardEventsTable).values({
        switchboardId: row.id, eventType: "switchboard_created", entityType: "switchboard",
        entityId: row.id, payload: { after: values, assigneeIds: personIds }, ...actor(req),
      });
      return row;
    });
    res.status(201).json(await serializeBoard(created));
  } catch (error) {
    const code = (error as { code?: string }).code;
    const status = (error as { statusCode?: number }).statusCode ?? (code === "23505" ? 409 : 500);
    res.status(status).json({ error: code === "23505" ? "Výrobní číslo už používá jiný rozvaděč." : (error as Error).message });
  }
});

router.patch("/switchboards/:id", requirePermission("switchboards.update"), async (req, res): Promise<void> => {
  const parsedId = idSchema.safeParse(req.params.id);
  const parsed = boardPatch.safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Neplatná data rozvaděče." }); return; }
  const { assigneeIds, responsiblePersonId, ...values } = parsed.data;
  try {
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, parsedId.data)).for("update");
      if (!before) return null;
      const [row] = await tx.update(switchboardsTable).set({ ...values, updatedAt: new Date() })
        .where(eq(switchboardsTable.id, parsedId.data)).returning();
      if (assigneeIds !== undefined || responsiblePersonId !== undefined) {
        const existing = await tx.select().from(switchboardAssigneesTable).where(eq(switchboardAssigneesTable.switchboardId, row.id));
        const ids = Array.from(new Set([
          ...(assigneeIds ?? existing.map((item) => item.personId)),
          ...(responsiblePersonId ? [responsiblePersonId] : []),
        ]));
        await assertPeopleExist(ids);
        await tx.delete(switchboardAssigneesTable).where(eq(switchboardAssigneesTable.switchboardId, row.id));
        if (ids.length) await tx.insert(switchboardAssigneesTable).values(ids.map((personId) => ({
          switchboardId: row.id, personId, isResponsible: personId === responsiblePersonId,
        })));
      }
      await tx.insert(switchboardEventsTable).values({
        switchboardId: row.id, eventType: "switchboard_updated", entityType: "switchboard",
        entityId: row.id, payload: { before, patch: parsed.data }, ...actor(req),
      });
      return row;
    });
    if (!updated) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
    res.json(await serializeBoard(updated));
  } catch (error) {
    const code = (error as { code?: string }).code;
    res.status(code === "23505" ? 409 : 500).json({ error: code === "23505" ? "Výrobní číslo už používá jiný rozvaděč." : (error as Error).message });
  }
});

router.post("/switchboards/:id/archive", requirePermission("switchboards.archive"), async (req, res): Promise<void> => {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(switchboardsTable)
      .set({ status: "archived", archivedAt: now, qrEnabled: false, updatedAt: now })
      .where(eq(switchboardsTable.id, parsedId.data)).returning();
    if (updated) await tx.insert(switchboardEventsTable).values({
      switchboardId: updated.id, eventType: "switchboard_archived", entityType: "switchboard",
      entityId: updated.id, payload: { archivedAt: now.toISOString(), qrDisabled: true }, ...actor(req),
    });
    return updated ?? null;
  });
  if (!row) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  res.json(await serializeBoard(row));
});

export default router;
