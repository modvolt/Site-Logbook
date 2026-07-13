import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, usersTable, peopleTable, switchboardsTable, switchboardChecklistInstancesTable,
  switchboardChecklistResponsesTable, switchboardMeasurementsTable, switchboardDefectsTable,
  switchboardPhotosTable, switchboardEventsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { contentMatchesType } from "../lib/fileSignature";
import { checklistDefinitionSchema, findChecklistItem } from "../lib/switchboard-checklist";
import { isPlausibleMeasurementTime, normalizeOptionalText, summarizeLatestMeasurements } from "../lib/switchboard-operation-rules";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const id = z.coerce.number().int().positive();
const phaseSchema = z.enum(["assembly", "inspection", "measurement"]);
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const photoCategorySchema = z.enum(["open_board", "completed_board", "type_label", "qr_code", "defect_detail", "repair_state", "measurement", "other"]);
const relatedTypeSchema = z.enum(["board", "phase", "checklist_item", "defect", "defect_repair", "measurement"]);

function actor(req: Request) {
  return { actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null };
}

function phaseStatusPatch(phaseKey: string | null, value: string) {
  if (phaseKey === "assembly") return { assemblyStatus: value };
  if (phaseKey === "inspection") return { inspectionStatus: value };
  if (phaseKey === "measurement") return { measurementStatus: value };
  return {};
}

async function ensureBoard(switchboardId: number) {
  const [board] = await db.select({ id: switchboardsTable.id }).from(switchboardsTable).where(eq(switchboardsTable.id, switchboardId));
  return board ?? null;
}

async function loadOperations(switchboardId: number) {
  const [measurements, defects, photos] = await Promise.all([
    db.select().from(switchboardMeasurementsTable).where(eq(switchboardMeasurementsTable.switchboardId, switchboardId)).orderBy(desc(switchboardMeasurementsTable.measuredAt), desc(switchboardMeasurementsTable.id)),
    db.select().from(switchboardDefectsTable).where(eq(switchboardDefectsTable.switchboardId, switchboardId)).orderBy(sql`${switchboardDefectsTable.status} = 'closed'`, desc(switchboardDefectsTable.isCritical), desc(switchboardDefectsTable.foundAt)),
    db.select().from(switchboardPhotosTable).where(eq(switchboardPhotosTable.switchboardId, switchboardId)).orderBy(desc(switchboardPhotosTable.createdAt), desc(switchboardPhotosTable.id)),
  ]);
  const userIds = [...new Set([
    ...measurements.map((row) => row.measuredByUserId),
    ...defects.flatMap((row) => [row.foundByUserId, row.closedByUserId]),
    ...photos.map((row) => row.uploadedByUserId),
  ].filter((value): value is number => value != null))];
  const personIds = [...new Set(defects.map((row) => row.responsiblePersonId).filter((value): value is number => value != null))];
  const responseIds = [...new Set([
    ...measurements.map((row) => row.checklistResponseId),
    ...defects.map((row) => row.checklistResponseId),
  ].filter((value): value is number => value != null))];
  const [users, people, responses] = await Promise.all([
    userIds.length ? db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve<Array<{ id: number; name: string }>>([]),
    personIds.length ? db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds)) : Promise.resolve<Array<{ id: number; name: string }>>([]),
    responseIds.length ? db.select({ id: switchboardChecklistResponsesTable.id, itemKey: switchboardChecklistResponsesTable.itemKey }).from(switchboardChecklistResponsesTable).where(inArray(switchboardChecklistResponsesTable.id, responseIds)) : Promise.resolve<Array<{ id: number; itemKey: string }>>([]),
  ]);
  const userName = (userId: number | null) => users.find((user) => user.id === userId)?.name ?? null;
  const responseItem = (responseId: number | null) => responses.find((response) => response.id === responseId)?.itemKey ?? null;
  return {
    measurements: measurements.map((row) => ({ ...row, value: row.value == null ? null : Number(row.value), checklistItemKey: responseItem(row.checklistResponseId), measuredByName: userName(row.measuredByUserId), measuredAt: row.measuredAt.toISOString() })),
    defects: defects.map((row) => ({ ...row, checklistItemKey: responseItem(row.checklistResponseId), foundByName: userName(row.foundByUserId), closedByName: userName(row.closedByUserId), responsiblePersonName: people.find((person) => person.id === row.responsiblePersonId)?.name ?? null, foundAt: row.foundAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null })),
    photos: photos.map(({ storagePath: _storagePath, ...row }) => ({ ...row, uploadedByName: userName(row.uploadedByUserId), takenAt: row.takenAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), contentUrl: `/api/switchboards/${switchboardId}/photos/${row.id}/content` })),
  };
}

router.get("/switchboards/:id/operations", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  if (!(await ensureBoard(boardId.data))) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
  res.json(await loadOperations(boardId.data));
});

const measurementBody = z.object({
  checklistItemKey: z.string().regex(/^[a-z0-9_]+$/).max(100).nullable().optional(),
  phaseKey: phaseSchema.default("measurement"),
  measurementType: z.string().trim().min(2).max(100),
  subjectLabel: z.string().trim().max(200).nullable().optional(),
  value: z.union([z.number().finite(), z.string().trim().regex(/^-?\d+(?:[.,]\d+)?$/)]).nullable().optional(),
  valueText: z.string().trim().max(200).nullable().optional(),
  unit: z.string().trim().min(1).max(30),
  result: z.enum(["pass", "fail"]),
  instrument: z.string().trim().min(2).max(300),
  note: z.string().trim().max(2000).nullable().optional(),
  measuredAt: z.iso.datetime().optional(),
}).superRefine((value, ctx) => {
  if (value.value == null && !value.valueText) ctx.addIssue({ code: "custom", message: "Zadejte naměřenou hodnotu." });
  if (value.measurementType.startsWith("rcd_") && !value.subjectLabel) ctx.addIssue({ code: "custom", message: "U proudového chrániče zadejte označení přístroje." });
  if (value.result === "fail" && !value.note) ctx.addIssue({ code: "custom", message: "Nevyhovující měření musí obsahovat popis." });
});

router.post("/switchboards/:id/measurements", requirePermission("switchboards.measurements.create"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const body = measurementBody.safeParse(req.body);
  if (!boardId.success || !body.success) { res.status(400).json({ error: body.success ? "Neplatné ID rozvaděče." : body.error.issues.map((issue) => issue.message).join(" ") }); return; }
  const measuredAt = body.data.measuredAt ? new Date(body.data.measuredAt) : new Date();
  if (!isPlausibleMeasurementTime(measuredAt)) { res.status(400).json({ error: "Datum měření není platné." }); return; }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${boardId.data}, 8410)`);
      const [board] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
      if (!board) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
      let response: typeof switchboardChecklistResponsesTable.$inferSelect | null = null;
      let checklistItem: ReturnType<typeof findChecklistItem> = null;
      let responseCreated = false;
      if (body.data.checklistItemKey) {
        const [instance] = await tx.select().from(switchboardChecklistInstancesTable).where(and(eq(switchboardChecklistInstancesTable.switchboardId, board.id), eq(switchboardChecklistInstancesTable.status, "in_progress"))).orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
        if (!instance) throw Object.assign(new Error("Aktivní checklist nebyl nalezen."), { statusCode: 404 });
        const definition = checklistDefinitionSchema.parse(instance.templateSnapshot);
        checklistItem = findChecklistItem(definition, body.data.checklistItemKey);
        if (!checklistItem || checklistItem.item.kind !== "measurement") throw Object.assign(new Error("Vybraná položka není měřicí položkou checklistu."), { statusCode: 409 });
        [response] = await tx.select().from(switchboardChecklistResponsesTable).where(and(eq(switchboardChecklistResponsesTable.instanceId, instance.id), eq(switchboardChecklistResponsesTable.itemKey, body.data.checklistItemKey)));
        if (!response) {
          [response] = await tx.insert(switchboardChecklistResponsesTable).values({ instanceId: instance.id, phaseKey: checklistItem.phase.key, itemKey: checklistItem.item.key, result: null, revision: 1, performedByUserId: req.auth?.userId ?? null, performedAt: measuredAt }).returning();
          responseCreated = true;
        }
      }
      const numericValue = body.data.value == null ? null : String(body.data.value).replace(",", ".");
      const effectivePhaseKey = checklistItem?.phase.key ?? body.data.phaseKey;
      const [measurement] = await tx.insert(switchboardMeasurementsTable).values({ switchboardId: board.id, checklistResponseId: response?.id ?? null, phaseKey: effectivePhaseKey, measurementType: body.data.measurementType, subjectLabel: normalizeOptionalText(body.data.subjectLabel), value: numericValue, valueText: normalizeOptionalText(body.data.valueText), unit: body.data.unit, result: body.data.result, instrument: body.data.instrument, note: normalizeOptionalText(body.data.note), measuredByUserId: req.auth?.userId ?? null, measuredAt }).returning();
      if (response) {
        const rows = await tx.select().from(switchboardMeasurementsTable).where(eq(switchboardMeasurementsTable.checklistResponseId, response.id));
        const summary = summarizeLatestMeasurements(rows);
        const [openDefect] = await tx.select({ id: switchboardDefectsTable.id }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.checklistResponseId, response.id), ne(switchboardDefectsTable.status, "closed"))).limit(1);
        const passed = summary.passed && !openDefect;
        const responseValues = { result: passed ? "done" : "defect", value: String(summary.totalSeries), unit: summary.totalSeries === 1 ? "měření" : "měření", passed, note: passed ? normalizeOptionalText(body.data.note) : normalizeOptionalText(body.data.note) ?? "Nevyhovující výsledek měření." , performedByUserId: req.auth?.userId ?? null, performedAt: measuredAt, updatedAt: new Date() };
        if (responseCreated) await tx.update(switchboardChecklistResponsesTable).set(responseValues).where(eq(switchboardChecklistResponsesTable.id, response.id));
        else await tx.update(switchboardChecklistResponsesTable).set({ ...responseValues, revision: sql`${switchboardChecklistResponsesTable.revision} + 1` }).where(eq(switchboardChecklistResponsesTable.id, response.id));
        await tx.update(switchboardChecklistInstancesTable).set({ revision: sql`${switchboardChecklistInstancesTable.revision} + 1`, currentPhase: checklistItem!.phase.key, updatedAt: new Date() }).where(eq(switchboardChecklistInstancesTable.id, response.instanceId));
        if (!summary.passed && !openDefect) {
          const [defect] = await tx.insert(switchboardDefectsTable).values({ switchboardId: board.id, checklistResponseId: response.id, phaseKey: checklistItem!.phase.key, title: checklistItem!.item.title, description: normalizeOptionalText(body.data.note) ?? "Nevyhovující výsledek měření.", severity: checklistItem!.item.critical ? "critical" : "high", isCritical: checklistItem!.item.critical, status: "open", foundByUserId: req.auth?.userId ?? null, foundAt: measuredAt }).returning();
          await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "defect_created_from_measurement", entityType: "switchboard_defect", entityId: defect.id, payload: { measurementId: measurement.id, checklistResponseId: response.id, phaseKey: checklistItem!.phase.key }, ...actor(req) });
        }
      }
      await tx.update(switchboardsTable).set({ ...phaseStatusPatch(effectivePhaseKey, "in_progress"), status: body.data.result === "fail" ? "defects_found" : board.status === "defects_found" ? board.status : "measurement", updatedAt: new Date() }).where(eq(switchboardsTable.id, board.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "measurement_recorded", entityType: "switchboard_measurement", entityId: measurement.id, payload: { checklistResponseId: response?.id ?? null, checklistItemKey: body.data.checklistItemKey ?? null, phaseKey: effectivePhaseKey, measurementType: measurement.measurementType, subjectLabel: measurement.subjectLabel, value: measurement.value, valueText: measurement.valueText, unit: measurement.unit, result: measurement.result, instrument: measurement.instrument, measuredAt: measurement.measuredAt.toISOString() }, ...actor(req) });
    });
    res.status(201).json(await loadOperations(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

const defectBody = z.object({
  checklistResponseId: z.number().int().positive().nullable().optional(),
  phaseKey: phaseSchema.nullable().optional(),
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().min(3).max(5000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  isCritical: z.boolean().optional(),
  responsiblePersonId: z.number().int().positive().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
});

async function validateDefectReferences(switchboardId: number, checklistResponseId: number | null | undefined, responsiblePersonId: number | null | undefined) {
  let response: typeof switchboardChecklistResponsesTable.$inferSelect | null = null;
  if (checklistResponseId) {
    const [row] = await db.select({ response: switchboardChecklistResponsesTable }).from(switchboardChecklistResponsesTable).innerJoin(switchboardChecklistInstancesTable, eq(switchboardChecklistInstancesTable.id, switchboardChecklistResponsesTable.instanceId)).where(and(eq(switchboardChecklistResponsesTable.id, checklistResponseId), eq(switchboardChecklistInstancesTable.switchboardId, switchboardId)));
    response = row?.response ?? null;
    if (!response) throw Object.assign(new Error("Checklistová položka nepatří k tomuto rozvaděči."), { statusCode: 400 });
  }
  if (responsiblePersonId) {
    const [person] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.id, responsiblePersonId));
    if (!person) throw Object.assign(new Error("Odpovědná osoba nebyla nalezena."), { statusCode: 400 });
  }
  return response;
}

router.post("/switchboards/:id/defects", requirePermission("switchboards.defects.create"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const body = defectBody.safeParse(req.body);
  if (!boardId.success || !body.success) { res.status(400).json({ error: body.success ? "Neplatné ID rozvaděče." : body.error.issues.map((issue) => issue.message).join(" ") }); return; }
  try {
    const response = await validateDefectReferences(boardId.data, body.data.checklistResponseId, body.data.responsiblePersonId);
    const defect = await db.transaction(async (tx) => {
      const [board] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
      if (!board) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
      const phaseKey = body.data.phaseKey ?? response?.phaseKey ?? null;
      const isCritical = body.data.isCritical === true || body.data.severity === "critical";
      const [created] = await tx.insert(switchboardDefectsTable).values({ switchboardId: board.id, checklistResponseId: response?.id ?? null, phaseKey, title: body.data.title, description: body.data.description, severity: isCritical ? "critical" : body.data.severity, isCritical, status: "open", responsiblePersonId: body.data.responsiblePersonId ?? null, dueDate: body.data.dueDate ?? null, foundByUserId: req.auth?.userId ?? null }).returning();
      if (response) await tx.update(switchboardChecklistResponsesTable).set({ result: "defect", note: body.data.description, performedByUserId: req.auth?.userId ?? null, performedAt: new Date(), revision: sql`${switchboardChecklistResponsesTable.revision} + 1`, updatedAt: new Date() }).where(eq(switchboardChecklistResponsesTable.id, response.id));
      await tx.update(switchboardsTable).set({ status: "defects_found", ...phaseStatusPatch(phaseKey, "in_progress"), updatedAt: new Date() }).where(eq(switchboardsTable.id, board.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "defect_created", entityType: "switchboard_defect", entityId: created.id, payload: { checklistResponseId: created.checklistResponseId, phaseKey, severity: created.severity, isCritical: created.isCritical, responsiblePersonId: created.responsiblePersonId, dueDate: created.dueDate }, ...actor(req) });
      return created;
    });
    res.status(201).json({ defect, operations: await loadOperations(boardId.data) });
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

const defectPatch = z.object({
  title: z.string().trim().min(3).max(300).optional(), description: z.string().trim().min(3).max(5000).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(), isCritical: z.boolean().optional(),
  responsiblePersonId: z.number().int().positive().nullable().optional(), dueDate: z.iso.date().nullable().optional(),
  status: z.enum(["open", "in_repair"]).optional(),
}).strict();

router.patch("/switchboards/:id/defects/:defectId", requirePermission("switchboards.defects.create"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const defectId = id.safeParse(req.params.defectId); const body = defectPatch.safeParse(req.body);
  if (!boardId.success || !defectId.success || !body.success) { res.status(400).json({ error: "Neplatná změna závady." }); return; }
  try {
    await validateDefectReferences(boardId.data, null, body.data.responsiblePersonId);
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.id, defectId.data), eq(switchboardDefectsTable.switchboardId, boardId.data))).for("update");
      if (!before) throw Object.assign(new Error("Závada nebyla nalezena."), { statusCode: 404 });
      if (before.status === "closed") throw Object.assign(new Error("Uzavřenou závadu nejprve znovu otevřete."), { statusCode: 409 });
      let severity = body.data.severity ?? before.severity;
      const critical = body.data.isCritical ?? (severity === "critical" ? true : before.isCritical);
      if (critical) severity = "critical";
      else if (severity === "critical") severity = "high";
      const [updated] = await tx.update(switchboardDefectsTable).set({ ...body.data, severity, isCritical: critical }).where(eq(switchboardDefectsTable.id, before.id)).returning();
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "defect_updated", entityType: "switchboard_defect", entityId: updated.id, payload: { before: { title: before.title, description: before.description, severity: before.severity, isCritical: before.isCritical, responsiblePersonId: before.responsiblePersonId, dueDate: before.dueDate, status: before.status }, after: { title: updated.title, description: updated.description, severity: updated.severity, isCritical: updated.isCritical, responsiblePersonId: updated.responsiblePersonId, dueDate: updated.dueDate, status: updated.status } }, ...actor(req) });
    });
    res.json(await loadOperations(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

const closeBody = z.object({ repairDescription: z.string().trim().min(3).max(5000) });
router.post("/switchboards/:id/defects/:defectId/close", requirePermission("switchboards.defects.close"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const defectId = id.safeParse(req.params.defectId); const body = closeBody.safeParse(req.body);
  if (!boardId.success || !defectId.success || !body.success) { res.status(400).json({ error: "Zadejte platný způsob opravy." }); return; }
  try {
    await db.transaction(async (tx) => {
      const [defect] = await tx.select().from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.id, defectId.data), eq(switchboardDefectsTable.switchboardId, boardId.data))).for("update");
      if (!defect) throw Object.assign(new Error("Závada nebyla nalezena."), { statusCode: 404 });
      if (defect.status === "closed") return;
      if (defect.checklistResponseId) {
        const measurements = await tx.select().from(switchboardMeasurementsTable).where(eq(switchboardMeasurementsTable.checklistResponseId, defect.checklistResponseId));
        if (measurements.length && !summarizeLatestMeasurements(measurements).passed) throw Object.assign(new Error("Měřicí závadu lze uzavřít až po vyhovujícím opakovaném měření."), { statusCode: 409 });
      }
      const now = new Date();
      const [closed] = await tx.update(switchboardDefectsTable).set({ status: "closed", repairDescription: body.data.repairDescription, closedByUserId: req.auth?.userId ?? null, closedAt: now }).where(eq(switchboardDefectsTable.id, defect.id)).returning();
      if (defect.checklistResponseId) await tx.update(switchboardChecklistResponsesTable).set({ result: "done", note: body.data.repairDescription, passed: true, performedByUserId: req.auth?.userId ?? null, performedAt: now, revision: sql`${switchboardChecklistResponsesTable.revision} + 1`, updatedAt: now }).where(eq(switchboardChecklistResponsesTable.id, defect.checklistResponseId));
      const [remaining] = await tx.select({ id: switchboardDefectsTable.id }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.switchboardId, boardId.data), ne(switchboardDefectsTable.status, "closed"), ne(switchboardDefectsTable.id, defect.id))).limit(1);
      await tx.update(switchboardsTable).set({ status: remaining ? "defects_found" : "defects_resolved", updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "defect_closed", entityType: "switchboard_defect", entityId: closed.id, payload: { previousStatus: defect.status, repairDescription: body.data.repairDescription, checklistResponseId: defect.checklistResponseId, closedAt: now.toISOString() }, ...actor(req) });
    });
    res.json(await loadOperations(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.post("/switchboards/:id/defects/:defectId/reopen", requirePermission("switchboards.defects.close"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const defectId = id.safeParse(req.params.defectId);
  if (!boardId.success || !defectId.success) { res.status(400).json({ error: "Neplatná závada." }); return; }
  try {
    await db.transaction(async (tx) => {
      const [defect] = await tx.select().from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.id, defectId.data), eq(switchboardDefectsTable.switchboardId, boardId.data))).for("update");
      if (!defect) throw Object.assign(new Error("Závada nebyla nalezena."), { statusCode: 404 });
      if (defect.status !== "closed") return;
      const [opened] = await tx.update(switchboardDefectsTable).set({ status: "open", repairDescription: null, closedByUserId: null, closedAt: null }).where(eq(switchboardDefectsTable.id, defect.id)).returning();
      if (defect.checklistResponseId) await tx.update(switchboardChecklistResponsesTable).set({ result: "defect", passed: false, note: defect.description, performedByUserId: req.auth?.userId ?? null, performedAt: new Date(), revision: sql`${switchboardChecklistResponsesTable.revision} + 1`, updatedAt: new Date() }).where(eq(switchboardChecklistResponsesTable.id, defect.checklistResponseId));
      await tx.update(switchboardsTable).set({ status: "defects_found", ...phaseStatusPatch(defect.phaseKey, "in_progress"), updatedAt: new Date() }).where(eq(switchboardsTable.id, boardId.data));
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "defect_reopened", entityType: "switchboard_defect", entityId: opened.id, payload: { previousClosedAt: defect.closedAt?.toISOString() ?? null, phaseKey: defect.phaseKey }, ...actor(req) });
    });
    res.json(await loadOperations(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

const photoMetaSchema = z.object({
  name: z.string().trim().min(1).max(255), contentType: z.string().trim(), category: photoCategorySchema,
  relatedType: relatedTypeSchema.default("board"), relatedId: z.coerce.number().int().positive().nullable().optional(),
  phaseKey: phaseSchema.nullable().optional(), checklistItemKey: z.string().regex(/^[a-z0-9_]+$/).max(100).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(), takenAt: z.iso.datetime().nullable().optional(),
});

async function validatePhotoRelation(switchboardId: number, meta: z.infer<typeof photoMetaSchema>) {
  if (meta.relatedType === "board") return;
  if (meta.relatedType === "phase" || meta.relatedType === "checklist_item") {
    if (!meta.relatedId || !meta.phaseKey) throw Object.assign(new Error("Chybí vazba fotografie na fázi."), { statusCode: 400 });
    const [instance] = await db.select().from(switchboardChecklistInstancesTable).where(and(eq(switchboardChecklistInstancesTable.id, meta.relatedId), eq(switchboardChecklistInstancesTable.switchboardId, switchboardId)));
    if (!instance) throw Object.assign(new Error("Checklist fotografie nepatří k tomuto rozvaděči."), { statusCode: 400 });
    if (meta.relatedType === "checklist_item") {
      if (!meta.checklistItemKey) throw Object.assign(new Error("Chybí klíč checklistové položky."), { statusCode: 400 });
      const found = findChecklistItem(checklistDefinitionSchema.parse(instance.templateSnapshot), meta.checklistItemKey);
      if (!found || found.phase.key !== meta.phaseKey) throw Object.assign(new Error("Checklistová položka fotografie není platná."), { statusCode: 400 });
    }
    return;
  }
  if (!meta.relatedId) throw Object.assign(new Error("Chybí ID souvisejícího záznamu."), { statusCode: 400 });
  if (meta.relatedType === "defect" || meta.relatedType === "defect_repair") {
    const [row] = await db.select({ id: switchboardDefectsTable.id }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.id, meta.relatedId), eq(switchboardDefectsTable.switchboardId, switchboardId)));
    if (!row) throw Object.assign(new Error("Závada fotografie nepatří k tomuto rozvaděči."), { statusCode: 400 });
  } else if (meta.relatedType === "measurement") {
    const [row] = await db.select({ id: switchboardMeasurementsTable.id }).from(switchboardMeasurementsTable).where(and(eq(switchboardMeasurementsTable.id, meta.relatedId), eq(switchboardMeasurementsTable.switchboardId, switchboardId)));
    if (!row) throw Object.assign(new Error("Měření fotografie nepatří k tomuto rozvaděči."), { statusCode: 400 });
  }
}

function parsePhotoBody(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: () => true, limit: MAX_PHOTO_BYTES })(req, res, (error) => {
    if ((error as { type?: string; status?: number } | undefined)?.type === "entity.too.large" || (error as { status?: number } | undefined)?.status === 413) { res.status(413).json({ error: "Fotografie je příliš velká (max. 20 MB)." }); return; }
    if (error) { next(error); return; } next();
  });
}

router.post("/switchboards/:id/photos", requirePermission("switchboards.photos.create"), parsePhotoBody, async (req, res) => {
  const boardId = id.safeParse(req.params.id); const meta = photoMetaSchema.safeParse(req.query);
  if (!boardId.success || !meta.success) { res.status(400).json({ error: "Neplatná metadata fotografie." }); return; }
  if (!PHOTO_TYPES.has(meta.data.contentType)) { res.status(415).json({ error: "Podporovány jsou pouze JPEG, PNG, WebP a HEIC fotografie." }); return; }
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) { res.status(400).json({ error: "Chybí obsah fotografie." }); return; }
  if (!contentMatchesType(meta.data.contentType, body)) { res.status(415).json({ error: "Obsah fotografie neodpovídá deklarovanému typu." }); return; }
  const takenAt = meta.data.takenAt ? new Date(meta.data.takenAt) : null;
  if (takenAt && !isPlausibleMeasurementTime(takenAt)) { res.status(400).json({ error: "Datum pořízení fotografie není platné." }); return; }
  try {
    if (!(await ensureBoard(boardId.data))) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
    await validatePhotoRelation(boardId.data, meta.data);
    const sha256 = createHash("sha256").update(body).digest("hex"); const objectPath = `/objects/switchboards/${boardId.data}/photos/${randomUUID()}`;
    await storage.putPrivateObject(objectPath, body, meta.data.contentType);
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${boardId.data}, 8411)`);
        const candidates = await tx.select().from(switchboardPhotosTable).where(and(eq(switchboardPhotosTable.switchboardId, boardId.data), eq(switchboardPhotosTable.sha256, sha256)));
        const duplicate = candidates.find((row) => row.relatedType === meta.data.relatedType && row.relatedId === (meta.data.relatedId ?? null) && row.phaseKey === (meta.data.phaseKey ?? null) && row.checklistItemKey === (meta.data.checklistItemKey ?? null));
        if (duplicate) return { photo: duplicate, duplicate: true };
        const [created] = await tx.insert(switchboardPhotosTable).values({ switchboardId: boardId.data, category: meta.data.category, relatedType: meta.data.relatedType, relatedId: meta.data.relatedId ?? null, phaseKey: meta.data.phaseKey ?? null, checklistItemKey: meta.data.checklistItemKey ?? null, storagePath: objectPath, originalFileName: meta.data.name, mimeType: meta.data.contentType, sizeBytes: body.length, sha256, description: normalizeOptionalText(meta.data.description), uploadedByUserId: req.auth?.userId ?? null, takenAt }).returning();
        await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "photo_uploaded", entityType: "switchboard_photo", entityId: created.id, payload: { category: created.category, relatedType: created.relatedType, relatedId: created.relatedId, phaseKey: created.phaseKey, checklistItemKey: created.checklistItemKey, mimeType: created.mimeType, sizeBytes: created.sizeBytes, sha256: created.sha256 }, ...actor(req) });
        return { photo: created, duplicate: false };
      });
      if (result.duplicate) await storage.deletePrivateObject(objectPath).catch(() => false);
      res.status(result.duplicate ? 200 : 201).json({ photoId: result.photo.id, duplicate: result.duplicate, operations: await loadOperations(boardId.data) });
    } catch (error) { await storage.deletePrivateObject(objectPath).catch(() => false); throw error; }
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.get("/switchboards/:id/photos/:photoId/content", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const photoId = id.safeParse(req.params.photoId);
  if (!boardId.success || !photoId.success) { res.status(400).json({ error: "Neplatná fotografie." }); return; }
  const [photo] = await db.select().from(switchboardPhotosTable).where(and(eq(switchboardPhotosTable.id, photoId.data), eq(switchboardPhotosTable.switchboardId, boardId.data)));
  if (!photo) { res.status(404).json({ error: "Fotografie nebyla nalezena." }); return; }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(photo.originalFileName)}`);
  try { await storage.servePrivateObject(photo.storagePath, res); } catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "Fotografie není dostupná." }); }
});

export default router;
