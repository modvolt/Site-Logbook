import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, switchboardsTable, switchboardDocumentsTable, switchboardExtractedFieldsTable,
  switchboardFieldRegistryTable, switchboardEventsTable, switchboardProcessingJobsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { normalizeFieldLabel, validateSwitchboardValue, SWITCHBOARD_PARSER_VERSION } from "../lib/switchboard-parser";
import { compareExtractionVersions, extractionIsComplete } from "../lib/switchboard-review-logic";
import { findRegistryNameCollision, normalizeRegistryAliases } from "../lib/switchboard-admin";

const router: IRouter = Router();
const id = z.coerce.number().int().positive();

function actor(req: { auth?: { userId: number; name: string; username: string } | null }) {
  return { actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null };
}

function effective(field: typeof switchboardExtractedFieldsTable.$inferSelect) {
  return field.manuallyCorrected ? field.correctedValue : field.normalizedValue;
}

async function refreshReviewStatus(documentId: number, switchboardId: number): Promise<void> {
  const [document, fields, registry] = await Promise.all([
    db.select().from(switchboardDocumentsTable).where(eq(switchboardDocumentsTable.id, documentId)).then((rows) => rows[0]),
    db.select().from(switchboardExtractedFieldsTable).where(eq(switchboardExtractedFieldsTable.documentId, documentId)),
    db.select().from(switchboardFieldRegistryTable).where(and(eq(switchboardFieldRegistryTable.isActive, true), eq(switchboardFieldRegistryTable.required, true))),
  ]);
  if (!document || document.processingErrorCode === "multiple_label_candidates") return;
  const complete = extractionIsComplete(fields.map((field) => ({ ...field, confidence: Number(field.confidence) })), registry.map((definition) => ({ fieldKey: definition.fieldKey, minimumConfidence: Number(definition.minimumConfidence) })));
  const status = complete ? "completed" : "needs_review";
  await db.transaction(async (tx) => {
    await tx.update(switchboardDocumentsTable).set({ processingStatus: status, processingErrorCode: complete ? null : "missing_required_fields", processingErrorMessage: complete ? null : "Některá povinná pole chybí nebo nemají dostatečnou jistotu." }).where(eq(switchboardDocumentsTable.id, documentId));
    await tx.update(switchboardsTable).set({ processingStatus: status, updatedAt: new Date() }).where(eq(switchboardsTable.id, switchboardId));
  });
}

router.get("/switchboards/field-registry", requirePermission("switchboards.parser.manage"), async (_req, res) => {
  const rows = await db.select().from(switchboardFieldRegistryTable).orderBy(asc(switchboardFieldRegistryTable.labelOrder), asc(switchboardFieldRegistryTable.id));
  res.json(rows.map((row) => ({ ...row, minimumConfidence: Number(row.minimumConfidence), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })));
});

const registryPatch = z.object({
  aliases: z.array(z.string().trim().min(1).max(100)).max(50).optional(), required: z.boolean().optional(),
  minimumConfidence: z.number().min(0.5).max(1).optional(), labelOrder: z.number().int().min(0).optional(),
  protocolOrder: z.number().int().min(0).optional(), isActive: z.boolean().optional(),
}).strict();

router.patch("/switchboards/field-registry/:registryId", requirePermission("switchboards.parser.manage"), async (req, res) => {
  const parsedId = id.safeParse(req.params.registryId); const parsed = registryPatch.safeParse(req.body);
  if (!parsedId.success || !parsed.success) { res.status(400).json({ error: "Neplatná konfigurace pole." }); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(0, 8410)`);
      const registry = await tx.select().from(switchboardFieldRegistryTable).orderBy(asc(switchboardFieldRegistryTable.id));
      const before = registry.find((field) => field.id === parsedId.data);
      if (!before) throw Object.assign(new Error("Pole registru nebylo nalezeno."), { statusCode: 404 });
      const aliases = parsed.data.aliases == null
        ? before.aliases
        : normalizeRegistryAliases(parsed.data.aliases).filter((alias) => normalizeFieldLabel(alias) !== normalizeFieldLabel(before.canonicalNameCs));
      const collision = findRegistryNameCollision(registry, before.id, {
        aliases,
        isActive: parsed.data.isActive ?? before.isActive,
      });
      if (collision) {
        throw Object.assign(new Error(`Název „${collision.submittedName}“ koliduje s polem ${collision.conflictingFieldKey} („${collision.conflictingName}“).`), { statusCode: 409 });
      }
      const patch = {
        ...parsed.data,
        aliases,
        minimumConfidence: parsed.data.minimumConfidence == null ? undefined : String(parsed.data.minimumConfidence),
        updatedByUserId: req.auth?.userId ?? null,
        updatedAt: new Date(),
      };
      const [row] = await tx.update(switchboardFieldRegistryTable).set(patch).where(eq(switchboardFieldRegistryTable.id, before.id)).returning();
      await tx.insert(switchboardEventsTable).values({ eventType: "field_registry_updated", entityType: "switchboard_field_registry", entityId: row.id, payload: { before: { aliases: before.aliases, required: before.required, minimumConfidence: Number(before.minimumConfidence), labelOrder: before.labelOrder, protocolOrder: before.protocolOrder, isActive: before.isActive }, after: { aliases: row.aliases, required: row.required, minimumConfidence: Number(row.minimumConfidence), labelOrder: row.labelOrder, protocolOrder: row.protocolOrder, isActive: row.isActive } }, ...actor(req) });
      return row;
    });
    res.json({ ...updated, minimumConfidence: Number(updated.minimumConfidence), createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) { res.status(statusCode).json({ error: (error as Error).message }); return; }
    throw error;
  }
});

router.get("/switchboards/:id/extractions", requirePermission("switchboards.extraction.review"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  const documents = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, boardId.data), eq(switchboardDocumentsTable.documentType, "schrack_norm_dbo"))).orderBy(desc(switchboardDocumentsTable.version));
  const fieldsPromise: Promise<Array<typeof switchboardExtractedFieldsTable.$inferSelect>> = documents.length
    ? db.select().from(switchboardExtractedFieldsTable).where(inArray(switchboardExtractedFieldsTable.documentId, documents.map((d) => d.id))).orderBy(asc(switchboardExtractedFieldsTable.fieldKey))
    : Promise.resolve([]);
  const [fields, registry] = await Promise.all([
    fieldsPromise,
    db.select().from(switchboardFieldRegistryTable).where(eq(switchboardFieldRegistryTable.isActive, true)),
  ]);
  res.json(documents.map(({ storagePath: _storagePath, ...document }) => {
    const documentFields = fields.filter((field) => field.documentId === document.id);
    return { ...document, uploadedAt: document.uploadedAt.toISOString(), missingFields: registry.filter((definition) => definition.required && !documentFields.some((field) => field.fieldKey === definition.fieldKey && effective(field))).map((definition) => ({ fieldKey: definition.fieldKey, canonicalNameCs: definition.canonicalNameCs, dataType: definition.dataType })), fields: documentFields.map((field) => ({ ...field, confidence: Number(field.confidence), effectiveValue: effective(field), correctedAt: field.correctedAt?.toISOString() ?? null, createdAt: field.createdAt.toISOString() })) };
  }));
});

const correctionBody = z.object({ value: z.string().trim().min(1).max(500), reason: z.string().trim().min(3).max(1000) });
const BOARD_FIELD_MAP: Record<string, keyof typeof switchboardsTable.$inferInsert> = {
  boardDesignation: "designation", serialNumber: "serialNumber", productionDate: "productionDate",
  typeDesignation: "typeDesignation", dimensions: "dimensions", ratedCurrent: "ratedCurrent",
  ipRating: "ipRating", ikRating: "ikRating", networkSystem: "networkSystem",
  ratedVoltage: "ratedVoltage", ratedFrequency: "ratedFrequency", weight: "weight",
};

router.patch("/switchboards/:id/extractions/:fieldId", requirePermission("switchboards.extraction.correct"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const fieldId = id.safeParse(req.params.fieldId); const body = correctionBody.safeParse(req.body);
  if (!boardId.success || !fieldId.success || !body.success) { res.status(400).json({ error: "Neplatná ruční oprava." }); return; }
  const result = await db.transaction(async (tx) => {
    const [field] = await tx.select().from(switchboardExtractedFieldsTable).where(eq(switchboardExtractedFieldsTable.id, fieldId.data)).for("update");
    if (!field) return null;
    const [document] = await tx.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.id, field.documentId), eq(switchboardDocumentsTable.switchboardId, boardId.data)));
    if (!document) return null;
    const [definition] = await tx.select().from(switchboardFieldRegistryTable).where(eq(switchboardFieldRegistryTable.fieldKey, field.fieldKey));
    if (!definition) throw Object.assign(new Error("Definice pole nebyla nalezena."), { statusCode: 409 });
    const validation = validateSwitchboardValue(definition.dataType, body.data.value);
    if (!validation.valid || !validation.normalized) throw Object.assign(new Error(validation.message ?? "Hodnota není platná."), { statusCode: 400 });
    const now = new Date();
    const [updated] = await tx.update(switchboardExtractedFieldsTable).set({ manuallyCorrected: true, correctedValue: validation.normalized, correctedByUserId: req.auth?.userId ?? null, correctedAt: now, validationStatus: "valid", validationMessage: null }).where(eq(switchboardExtractedFieldsTable.id, field.id)).returning();
    const boardColumn = BOARD_FIELD_MAP[field.fieldKey];
    if (boardColumn) await tx.update(switchboardsTable).set({ [boardColumn]: validation.normalized, updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
    if (field.fieldKey === "standard") await tx.update(switchboardsTable).set({ standards: validation.normalized.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean), updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
    await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "extracted_field_corrected", entityType: "switchboard_extracted_field", entityId: field.id, payload: { fieldKey: field.fieldKey, rawValue: field.rawValue, previousEffectiveValue: effective(field), correctedValue: validation.normalized, reason: body.data.reason, documentId: document.id, documentVersion: document.version }, ...actor(req) });
    return updated;
  });
  if (!result) { res.status(404).json({ error: "Vytěžené pole nebylo nalezeno u tohoto rozvaděče." }); return; }
  await refreshReviewStatus(result.documentId, boardId.data);
  res.json({ ...result, confidence: Number(result.confidence), effectiveValue: effective(result), correctedAt: result.correctedAt?.toISOString() ?? null, createdAt: result.createdAt.toISOString() });
});

const manualFieldBody = correctionBody.extend({ documentId: z.number().int().positive(), fieldKey: z.string().trim().min(1).max(100) });
router.post("/switchboards/:id/extractions", requirePermission("switchboards.extraction.correct"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const body = manualFieldBody.safeParse(req.body);
  if (!boardId.success || !body.success) { res.status(400).json({ error: "Neplatné ruční doplnění pole." }); return; }
  try {
    const created = await db.transaction(async (tx) => {
      const [document] = await tx.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.id, body.data.documentId), eq(switchboardDocumentsTable.switchboardId, boardId.data)));
      if (!document) throw Object.assign(new Error("Dokument nebyl nalezen."), { statusCode: 404 });
      const [definition] = await tx.select().from(switchboardFieldRegistryTable).where(and(eq(switchboardFieldRegistryTable.fieldKey, body.data.fieldKey), eq(switchboardFieldRegistryTable.isActive, true)));
      if (!definition) throw Object.assign(new Error("Pole registru nebylo nalezeno."), { statusCode: 404 });
      const existing = await tx.select({ id: switchboardExtractedFieldsTable.id }).from(switchboardExtractedFieldsTable).where(and(eq(switchboardExtractedFieldsTable.documentId, document.id), eq(switchboardExtractedFieldsTable.fieldKey, definition.fieldKey)));
      if (existing.length) throw Object.assign(new Error("Pole už existuje; použijte opravu existující hodnoty."), { statusCode: 409 });
      const validation = validateSwitchboardValue(definition.dataType, body.data.value);
      if (!validation.valid || !validation.normalized) throw Object.assign(new Error(validation.message ?? "Hodnota není platná."), { statusCode: 400 });
      const now = new Date();
      const [field] = await tx.insert(switchboardExtractedFieldsTable).values({ documentId: document.id, fieldKey: definition.fieldKey, foundLabel: definition.canonicalNameCs, matchedAlias: null, rawValue: null, normalizedValue: null, confidence: "1", pageNumber: 1, blockId: "manual", extractionMethod: "manual", relativeRelation: "manual_confirmation", validationStatus: "valid", validationMessage: null, parserVersion: SWITCHBOARD_PARSER_VERSION, manuallyCorrected: true, correctedValue: validation.normalized, correctedByUserId: req.auth?.userId ?? null, correctedAt: now }).returning();
      const boardColumn = BOARD_FIELD_MAP[definition.fieldKey];
      if (boardColumn) await tx.update(switchboardsTable).set({ [boardColumn]: validation.normalized, updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
      if (definition.fieldKey === "standard") await tx.update(switchboardsTable).set({ standards: validation.normalized.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean), updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "extracted_field_manually_added", entityType: "switchboard_extracted_field", entityId: field.id, payload: { documentId: document.id, documentVersion: document.version, fieldKey: definition.fieldKey, value: validation.normalized, reason: body.data.reason }, ...actor(req) });
      return field;
    });
    await refreshReviewStatus(created.documentId, boardId.data);
    res.status(201).json({ ...created, confidence: Number(created.confidence), effectiveValue: effective(created), correctedAt: created.correctedAt?.toISOString() ?? null, createdAt: created.createdAt.toISOString() });
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.get("/switchboards/:id/documents/compare", requirePermission("switchboards.extraction.review"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const fromId = id.safeParse(req.query.from); const toId = id.safeParse(req.query.to);
  if (!boardId.success || !fromId.success || !toId.success) { res.status(400).json({ error: "Vyberte dvě platné verze dokumentu." }); return; }
  if (fromId.data === toId.data) { res.status(400).json({ error: "Pro porovnání vyberte dvě rozdílné verze dokumentu." }); return; }
  const docs = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.switchboardId, boardId.data), inArray(switchboardDocumentsTable.id, [fromId.data, toId.data])));
  if (docs.length !== 2) { res.status(404).json({ error: "Jedna z verzí dokumentu nebyla nalezena." }); return; }
  const [fields, registry] = await Promise.all([
    db.select().from(switchboardExtractedFieldsTable).where(inArray(switchboardExtractedFieldsTable.documentId, [fromId.data, toId.data])),
    db.select({ fieldKey: switchboardFieldRegistryTable.fieldKey, canonicalNameCs: switchboardFieldRegistryTable.canonicalNameCs }).from(switchboardFieldRegistryTable),
  ]);
  const reviewRows = (documentId: number) => fields.filter((field) => field.documentId === documentId).map((field) => ({ ...field, confidence: Number(field.confidence) }));
  const keys = compareExtractionVersions(reviewRows(fromId.data), reviewRows(toId.data)).map((change) => change.fieldKey);
  const valueFor = (documentId: number, key: string) => { const field = fields.find((item) => item.documentId === documentId && item.fieldKey === key); return field ? { rawValue: field.rawValue, normalizedValue: field.normalizedValue, correctedValue: field.correctedValue, effectiveValue: effective(field), confidence: Number(field.confidence) } : null; };
  const documentMeta = (documentId: number) => { const document = docs.find((row) => row.id === documentId)!; return { id: document.id, version: document.version, originalFileName: document.originalFileName, sha256: document.sha256, processingStatus: document.processingStatus, uploadedAt: document.uploadedAt.toISOString() }; };
  res.json({ from: documentMeta(fromId.data), to: documentMeta(toId.data), changes: keys.map((key) => ({ fieldKey: key, canonicalNameCs: registry.find((field) => field.fieldKey === key)?.canonicalNameCs ?? key, before: valueFor(fromId.data, key), after: valueFor(toId.data, key) })) });
});

router.post("/switchboards/:id/documents/:documentId/reprocess", requirePermission("switchboards.extraction.review"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const documentId = id.safeParse(req.params.documentId);
  if (!boardId.success || !documentId.success) { res.status(400).json({ error: "Neplatný dokument." }); return; }
  const [document] = await db.select().from(switchboardDocumentsTable).where(and(eq(switchboardDocumentsTable.id, documentId.data), eq(switchboardDocumentsTable.switchboardId, boardId.data), eq(switchboardDocumentsTable.documentType, "schrack_norm_dbo")));
  if (!document) { res.status(404).json({ error: "DBO dokument nebyl nalezen." }); return; }
  const job = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${document.id}, 8402)`);
    const active = await tx.select({ id: switchboardProcessingJobsTable.id }).from(switchboardProcessingJobsTable).where(and(eq(switchboardProcessingJobsTable.documentId, document.id), inArray(switchboardProcessingJobsTable.status, ["queued", "running"])));
    if (active.length) throw Object.assign(new Error("Dokument už čeká na zpracování."), { statusCode: 409 });
    const [created] = await tx.insert(switchboardProcessingJobsTable).values({ documentId: document.id, parserVersion: SWITCHBOARD_PARSER_VERSION }).returning();
    await tx.update(switchboardDocumentsTable).set({ processingStatus: "queued", processingErrorCode: null, processingErrorMessage: null }).where(eq(switchboardDocumentsTable.id, document.id));
    await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "document_reprocessing_requested", entityType: "switchboard_document", entityId: document.id, payload: { parserVersion: SWITCHBOARD_PARSER_VERSION, processingJobId: created.id }, ...actor(req) });
    return created;
  }).catch((error: unknown) => {
    if ((error as { statusCode?: number }).statusCode === 409) return null;
    throw error;
  });
  if (!job) { res.status(409).json({ error: "Dokument už čeká na zpracování." }); return; }
  res.status(202).json({ queued: true, processingJobId: job.id });
});

export default router;
