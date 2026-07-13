import { Router, type IRouter, type Request } from "express";
import { and, asc, desc, eq, isNull, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, usersTable, switchboardsTable, switchboardChecklistTemplatesTable,
  switchboardChecklistTemplateVersionsTable, switchboardChecklistInstancesTable,
  switchboardChecklistResponsesTable, switchboardMeasurementsTable, switchboardDefectsTable,
  switchboardPhotosTable, switchboardEventsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import {
  DEFAULT_SWITCHBOARD_CHECKLIST, checklistDefinitionSchema, checklistResultSchema,
  evaluatePhaseCompletion, findChecklistItem, isIdempotentChecklistRetry, itemIsRelevant, validateChecklistResponse,
} from "../lib/switchboard-checklist";

const router: IRouter = Router();
const id = z.coerce.number().int().positive();
const DEFAULT_TEMPLATE_NAME = "Výchozí výrobní protokol Modvolt";
const PHASE_KEYS = ["assembly", "inspection", "measurement"] as const;

function actor(req: Request) {
  return { actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null };
}

function phaseStatusPatch(phaseKey: typeof PHASE_KEYS[number], value: string) {
  if (phaseKey === "assembly") return { assemblyStatus: value };
  if (phaseKey === "inspection") return { inspectionStatus: value };
  return { measurementStatus: value };
}

async function ensureDefaultTemplate() {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(8405, 1)`);
    let [template] = await tx.select().from(switchboardChecklistTemplatesTable)
      .where(eq(switchboardChecklistTemplatesTable.name, DEFAULT_TEMPLATE_NAME)).orderBy(asc(switchboardChecklistTemplatesTable.id)).limit(1);
    if (!template) {
      [template] = await tx.insert(switchboardChecklistTemplatesTable).values({ name: DEFAULT_TEMPLATE_NAME, boardType: null, isActive: true }).returning();
    }
    let [version] = await tx.select().from(switchboardChecklistTemplateVersionsTable)
      .where(eq(switchboardChecklistTemplateVersionsTable.templateId, template.id)).orderBy(desc(switchboardChecklistTemplateVersionsTable.version)).limit(1);
    if (!version) {
      [version] = await tx.insert(switchboardChecklistTemplateVersionsTable).values({ templateId: template.id, version: 1, definition: DEFAULT_SWITCHBOARD_CHECKLIST }).returning();
      await tx.insert(switchboardEventsTable).values({ eventType: "checklist_default_template_created", entityType: "switchboard_checklist_template_version", entityId: version.id, payload: { templateId: template.id, version: 1 }, actorName: "System" });
    }
    return { template, version };
  });
}

async function loadChecklistPayload(switchboardId: number) {
  const [board] = await db.select({
    id: switchboardsTable.id,
    properties: switchboardsTable.properties,
    assemblyStatus: switchboardsTable.assemblyStatus,
    inspectionStatus: switchboardsTable.inspectionStatus,
    measurementStatus: switchboardsTable.measurementStatus,
  }).from(switchboardsTable).where(eq(switchboardsTable.id, switchboardId));
  if (!board) return null;
  const [instance] = await db.select().from(switchboardChecklistInstancesTable)
    .where(eq(switchboardChecklistInstancesTable.switchboardId, switchboardId))
    .orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
  if (!instance) return { board, instance: null, phases: [] };
  const parsed = checklistDefinitionSchema.safeParse(instance.templateSnapshot);
  if (!parsed.success) throw Object.assign(new Error("Historický snapshot checklistu není platný."), { statusCode: 500 });
  const responses = await db.select({
    id: switchboardChecklistResponsesTable.id,
    phaseKey: switchboardChecklistResponsesTable.phaseKey,
    itemKey: switchboardChecklistResponsesTable.itemKey,
    result: switchboardChecklistResponsesTable.result,
    value: switchboardChecklistResponsesTable.value,
    unit: switchboardChecklistResponsesTable.unit,
    passed: switchboardChecklistResponsesTable.passed,
    note: switchboardChecklistResponsesTable.note,
    justification: switchboardChecklistResponsesTable.justification,
    revision: switchboardChecklistResponsesTable.revision,
    performedByUserId: switchboardChecklistResponsesTable.performedByUserId,
    performedByName: usersTable.name,
    performedAt: switchboardChecklistResponsesTable.performedAt,
    updatedAt: switchboardChecklistResponsesTable.updatedAt,
  }).from(switchboardChecklistResponsesTable)
    .leftJoin(usersTable, eq(switchboardChecklistResponsesTable.performedByUserId, usersTable.id))
    .where(eq(switchboardChecklistResponsesTable.instanceId, instance.id));
  const statusByPhase = { assembly: board.assemblyStatus, inspection: board.inspectionStatus, measurement: board.measurementStatus };
  const phases = parsed.data.phases.map((phase) => {
    const relevantItems = phase.items.filter((item) => itemIsRelevant(item, board.properties));
    const phaseResponses = responses.filter((response) => response.phaseKey === phase.key);
    const answered = relevantItems.filter((item) => phaseResponses.some((response) => response.itemKey === item.key && response.result)).length;
    const defects = relevantItems.filter((item) => phaseResponses.some((response) => response.itemKey === item.key && response.result === "defect")).length;
    const criticalDefects = relevantItems.filter((item) => item.critical && phaseResponses.some((response) => response.itemKey === item.key && response.result === "defect")).length;
    const latest = [...phaseResponses].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return {
      ...phase,
      items: relevantItems.map((item) => ({ ...item, response: phaseResponses.find((response) => response.itemKey === item.key) ?? null })),
      summary: {
        completed: answered,
        total: relevantItems.length,
        defects,
        criticalDefects,
        status: statusByPhase[phase.key],
        lastWorker: latest?.performedByName ?? null,
        lastChangedAt: latest?.updatedAt.toISOString() ?? null,
      },
    };
  });
  return {
    board,
    instance: {
      ...instance,
      startedAt: instance.startedAt.toISOString(),
      completedAt: instance.completedAt?.toISOString() ?? null,
      updatedAt: instance.updatedAt.toISOString(),
    },
    phases,
  };
}

router.get("/switchboards/checklist-templates", requirePermission("switchboards.templates.manage"), async (_req, res) => {
  const [templates, versions] = await Promise.all([
    db.select().from(switchboardChecklistTemplatesTable).orderBy(asc(switchboardChecklistTemplatesTable.name)),
    db.select().from(switchboardChecklistTemplateVersionsTable).orderBy(desc(switchboardChecklistTemplateVersionsTable.version)),
  ]);
  res.json(templates.map((template) => ({
    ...template,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    versions: versions.filter((version) => version.templateId === template.id).map((version) => ({ ...version, createdAt: version.createdAt.toISOString() })),
  })));
});

const templateBody = z.object({
  name: z.string().trim().min(3).max(200),
  boardType: z.string().trim().min(1).max(200).nullable().optional(),
  definition: checklistDefinitionSchema,
});

router.post("/switchboards/checklist-templates", requirePermission("switchboards.templates.manage"), async (req, res) => {
  const body = templateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await db.transaction(async (tx) => {
    const [template] = await tx.insert(switchboardChecklistTemplatesTable).values({ name: body.data.name, boardType: body.data.boardType ?? null, isActive: true, createdByUserId: req.auth?.userId ?? null }).returning();
    const [version] = await tx.insert(switchboardChecklistTemplateVersionsTable).values({ templateId: template.id, version: 1, definition: body.data.definition, createdByUserId: req.auth?.userId ?? null }).returning();
    await tx.insert(switchboardEventsTable).values({ eventType: "checklist_template_created", entityType: "switchboard_checklist_template", entityId: template.id, payload: { versionId: version.id, version: 1, boardType: template.boardType }, ...actor(req) });
    return { template, version };
  });
  res.status(201).json(result);
});

router.post("/switchboards/checklist-templates/:templateId/versions", requirePermission("switchboards.templates.manage"), async (req, res) => {
  const templateId = id.safeParse(req.params.templateId);
  const definition = checklistDefinitionSchema.safeParse(req.body?.definition);
  if (!templateId.success || !definition.success) { res.status(400).json({ error: "Neplatná verze checklistové šablony." }); return; }
  try {
    const version = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${templateId.data}, 8406)`);
      const [template] = await tx.select().from(switchboardChecklistTemplatesTable).where(eq(switchboardChecklistTemplatesTable.id, templateId.data));
      if (!template) throw Object.assign(new Error("Šablona nebyla nalezena."), { statusCode: 404 });
      const [{ value }] = await tx.select({ value: max(switchboardChecklistTemplateVersionsTable.version) }).from(switchboardChecklistTemplateVersionsTable).where(eq(switchboardChecklistTemplateVersionsTable.templateId, template.id));
      const [created] = await tx.insert(switchboardChecklistTemplateVersionsTable).values({ templateId: template.id, version: Number(value ?? 0) + 1, definition: definition.data, createdByUserId: req.auth?.userId ?? null }).returning();
      await tx.insert(switchboardEventsTable).values({ eventType: "checklist_template_version_created", entityType: "switchboard_checklist_template_version", entityId: created.id, payload: { templateId: template.id, version: created.version }, ...actor(req) });
      return created;
    });
    res.status(201).json(version);
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.patch("/switchboards/checklist-templates/:templateId/active", requirePermission("switchboards.templates.manage"), async (req, res) => {
  const templateId = id.safeParse(req.params.templateId);
  const body = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!templateId.success || !body.success) { res.status(400).json({ error: "Neplatná změna šablony." }); return; }
  const [updated] = await db.update(switchboardChecklistTemplatesTable).set({ isActive: body.data.isActive, updatedAt: new Date() }).where(eq(switchboardChecklistTemplatesTable.id, templateId.data)).returning();
  if (!updated) { res.status(404).json({ error: "Šablona nebyla nalezena." }); return; }
  await db.insert(switchboardEventsTable).values({ eventType: "checklist_template_activation_changed", entityType: "switchboard_checklist_template", entityId: updated.id, payload: { isActive: updated.isActive }, ...actor(req) });
  res.json(updated);
});

router.get("/switchboards/:id/checklist", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  try {
    const payload = await loadChecklistPayload(boardId.data);
    if (!payload) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; }
    res.json(payload);
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.post("/switchboards/:id/checklist/start", requirePermission("switchboards.checklist.fill"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  if (!boardId.success) { res.status(400).json({ error: "Neplatné ID rozvaděče." }); return; }
  try {
    await ensureDefaultTemplate();
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${boardId.data}, 8407)`);
      const [board] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
      if (!board) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
      const [existing] = await tx.select().from(switchboardChecklistInstancesTable).where(and(eq(switchboardChecklistInstancesTable.switchboardId, board.id), eq(switchboardChecklistInstancesTable.status, "in_progress"))).orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
      if (existing) return { instance: existing, created: false };
      let templateVersion: typeof switchboardChecklistTemplateVersionsTable.$inferSelect | null = null;
      if (board.typeDesignation) {
        const [specific] = await tx.select({ version: switchboardChecklistTemplateVersionsTable }).from(switchboardChecklistTemplatesTable)
          .innerJoin(switchboardChecklistTemplateVersionsTable, eq(switchboardChecklistTemplateVersionsTable.templateId, switchboardChecklistTemplatesTable.id))
          .where(and(eq(switchboardChecklistTemplatesTable.isActive, true), eq(switchboardChecklistTemplatesTable.boardType, board.typeDesignation)))
          .orderBy(desc(switchboardChecklistTemplateVersionsTable.version)).limit(1);
        if (specific) templateVersion = specific.version;
      }
      if (!templateVersion) {
        const [fallback] = await tx.select({ version: switchboardChecklistTemplateVersionsTable }).from(switchboardChecklistTemplatesTable)
          .innerJoin(switchboardChecklistTemplateVersionsTable, eq(switchboardChecklistTemplateVersionsTable.templateId, switchboardChecklistTemplatesTable.id))
          .where(and(eq(switchboardChecklistTemplatesTable.isActive, true), eq(switchboardChecklistTemplatesTable.name, DEFAULT_TEMPLATE_NAME)))
          .orderBy(desc(switchboardChecklistTemplateVersionsTable.version)).limit(1);
        templateVersion = fallback?.version ?? null;
      }
      if (!templateVersion) throw Object.assign(new Error("Pro tento rozvaděč není aktivní checklistová šablona."), { statusCode: 409 });
      const definition = checklistDefinitionSchema.parse(templateVersion.definition);
      const [instance] = await tx.insert(switchboardChecklistInstancesTable).values({ switchboardId: board.id, templateVersionId: templateVersion.id, templateSnapshot: definition, status: "in_progress", currentPhase: "assembly" }).returning();
      await tx.update(switchboardsTable).set({ assemblyStatus: "in_progress", inspectionStatus: "not_started", measurementStatus: "not_started", status: "assembly", updatedAt: new Date() }).where(eq(switchboardsTable.id, board.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "checklist_started", entityType: "switchboard_checklist_instance", entityId: instance.id, payload: { templateVersionId: templateVersion.id, templateVersion: templateVersion.version }, ...actor(req) });
      return { instance, created: true };
    });
    const payload = await loadChecklistPayload(boardId.data);
    res.status(result.created ? 201 : 200).json(payload);
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

const responseBody = z.object({
  expectedRevision: z.number().int().min(0),
  result: checklistResultSchema,
  value: z.string().trim().max(100).nullable().optional(),
  unit: z.string().trim().max(30).nullable().optional(),
  passed: z.boolean().nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  justification: z.string().trim().max(1000).nullable().optional(),
});

router.patch("/switchboards/:id/checklist/responses/:itemKey", requirePermission("switchboards.checklist.fill"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  const itemKey = z.string().regex(/^[a-z0-9_]+$/).max(100).safeParse(req.params.itemKey);
  const body = responseBody.safeParse(req.body);
  if (!boardId.success || !itemKey.success || !body.success) { res.status(400).json({ error: "Neplatná odpověď checklistu." }); return; }
  try {
    await db.transaction(async (tx) => {
      const [board] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
      const [instance] = await tx.select().from(switchboardChecklistInstancesTable).where(and(eq(switchboardChecklistInstancesTable.switchboardId, boardId.data), eq(switchboardChecklistInstancesTable.status, "in_progress"))).orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
      if (!board || !instance) throw Object.assign(new Error("Aktivní checklist nebyl nalezen."), { statusCode: 404 });
      await tx.execute(sql`select pg_advisory_xact_lock(${instance.id}, 8408)`);
      const definition = checklistDefinitionSchema.parse(instance.templateSnapshot);
      const found = findChecklistItem(definition, itemKey.data);
      if (!found) throw Object.assign(new Error("Položka není součástí historické šablony checklistu."), { statusCode: 404 });
      if (!itemIsRelevant(found.item, board.properties)) throw Object.assign(new Error("Položka se podle vlastností rozvaděče nevztahuje."), { statusCode: 409 });
      const validationError = validateChecklistResponse(found.item, body.data);
      if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 });
      const [before] = await tx.select().from(switchboardChecklistResponsesTable).where(and(eq(switchboardChecklistResponsesTable.instanceId, instance.id), eq(switchboardChecklistResponsesTable.itemKey, itemKey.data)));
      if (found.item.kind === "photo" && body.data.result === "done") {
        const [photo] = await tx.select({ id: switchboardPhotosTable.id }).from(switchboardPhotosTable).where(and(eq(switchboardPhotosTable.switchboardId, board.id), eq(switchboardPhotosTable.relatedType, "checklist_item"), eq(switchboardPhotosTable.relatedId, instance.id), eq(switchboardPhotosTable.checklistItemKey, itemKey.data))).limit(1);
        if (!photo) throw Object.assign(new Error("Nejprve k položce nahrajte požadovanou fotografii."), { statusCode: 409 });
      }
      if (found.item.kind === "measurement" && body.data.result !== "not_applicable") {
        if (!before) throw Object.assign(new Error("Měřicí položku dokončete přidáním strukturovaného měření."), { statusCode: 409 });
        const [measurement] = await tx.select({ id: switchboardMeasurementsTable.id }).from(switchboardMeasurementsTable).where(eq(switchboardMeasurementsTable.checklistResponseId, before.id)).limit(1);
        if (!measurement) throw Object.assign(new Error("Měřicí položku dokončete přidáním strukturovaného měření."), { statusCode: 409 });
      }
      const normalized = {
        result: body.data.result,
        value: body.data.value || null,
        unit: body.data.unit || null,
        passed: body.data.passed ?? null,
        note: body.data.note || null,
        justification: body.data.justification || null,
      };
      const isIdempotentRetry = before && before.result && isIdempotentChecklistRetry({
        result: before.result as "done" | "defect" | "not_applicable",
        value: before.value, unit: before.unit, passed: before.passed, note: before.note,
        justification: before.justification, performedByUserId: before.performedByUserId,
      }, normalized, req.auth?.userId ?? null);
      if ((before?.revision ?? 0) !== body.data.expectedRevision) {
        if (isIdempotentRetry) return;
        throw Object.assign(new Error("Odpověď mezitím změnil jiný pracovník. Načtěte aktuální stav a změnu zopakujte."), { statusCode: 409 });
      }
      if (before?.result === "defect" && normalized.result !== "defect") {
        const [openDefect] = await tx.select({ id: switchboardDefectsTable.id }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.checklistResponseId, before.id), ne(switchboardDefectsTable.status, "closed"))).limit(1);
        if (openDefect) throw Object.assign(new Error("Nejprve závadu uzavřete a popište způsob opravy."), { statusCode: 409 });
      }
      if (before && before.performedByUserId !== req.auth?.userId && !req.auth?.permissions.includes("switchboards.checklist.edit_all")) throw Object.assign(new Error("Cizí odpověď může změnit pouze uživatel s rozšířeným oprávněním."), { statusCode: 403 });
      if (before && before.performedByUserId === req.auth?.userId && !req.auth?.permissions.includes("switchboards.checklist.edit_own") && !req.auth?.permissions.includes("switchboards.checklist.edit_all")) throw Object.assign(new Error("Nemáte oprávnění upravovat již uloženou odpověď."), { statusCode: 403 });
      const now = new Date();
      const values = {
        phaseKey: found.phase.key,
        ...normalized,
        performedByUserId: req.auth?.userId ?? null,
        performedAt: now,
        updatedAt: now,
      };
      let updated: typeof switchboardChecklistResponsesTable.$inferSelect;
      if (before) {
        const [row] = await tx.update(switchboardChecklistResponsesTable).set({ ...values, revision: sql`${switchboardChecklistResponsesTable.revision} + 1` }).where(and(eq(switchboardChecklistResponsesTable.id, before.id), eq(switchboardChecklistResponsesTable.revision, body.data.expectedRevision))).returning();
        if (!row) throw Object.assign(new Error("Odpověď mezitím změnil jiný pracovník."), { statusCode: 409 });
        updated = row;
      } else {
        [updated] = await tx.insert(switchboardChecklistResponsesTable).values({ instanceId: instance.id, itemKey: itemKey.data, ...values }).returning();
      }
      await tx.update(switchboardChecklistInstancesTable).set({ revision: sql`${switchboardChecklistInstancesTable.revision} + 1`, currentPhase: found.phase.key, updatedAt: now }).where(eq(switchboardChecklistInstancesTable.id, instance.id));
      if (updated.result === "defect") {
        const [existingDefect] = await tx.select({ id: switchboardDefectsTable.id }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.checklistResponseId, updated.id), ne(switchboardDefectsTable.status, "closed"))).limit(1);
        if (!existingDefect) {
          const [defect] = await tx.insert(switchboardDefectsTable).values({ switchboardId: board.id, checklistResponseId: updated.id, phaseKey: found.phase.key, title: found.item.title, description: updated.note ?? "Závada zjištěná při kontrole.", severity: found.item.critical ? "critical" : "medium", isCritical: found.item.critical, status: "open", foundByUserId: req.auth?.userId ?? null, foundAt: now }).returning();
          await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "defect_created_from_checklist", entityType: "switchboard_defect", entityId: defect.id, payload: { checklistResponseId: updated.id, phaseKey: found.phase.key, itemKey: found.item.key, isCritical: defect.isCritical }, ...actor(req) });
        }
      }
      await tx.update(switchboardsTable).set({ ...phaseStatusPatch(found.phase.key, "in_progress"), ...(updated.result === "defect" ? { status: "defects_found" } : {}), updatedAt: now }).where(eq(switchboardsTable.id, board.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: before ? "checklist_response_changed" : "checklist_response_recorded", entityType: "switchboard_checklist_response", entityId: updated.id, payload: { instanceId: instance.id, phaseKey: found.phase.key, itemKey: itemKey.data, before: before ? { result: before.result, value: before.value, unit: before.unit, passed: before.passed, note: before.note, justification: before.justification, revision: before.revision } : null, after: { result: updated.result, value: updated.value, unit: updated.unit, passed: updated.passed, note: updated.note, justification: updated.justification, revision: updated.revision } }, ...actor(req) });
    });
    res.json(await loadChecklistPayload(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.patch("/switchboards/:id/checklist/current-phase", requirePermission("switchboards.checklist.fill"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  const body = z.object({ phaseKey: z.enum(PHASE_KEYS) }).safeParse(req.body);
  if (!boardId.success || !body.success) { res.status(400).json({ error: "Neplatná fáze." }); return; }
  const [instance] = await db.update(switchboardChecklistInstancesTable).set({ currentPhase: body.data.phaseKey, updatedAt: new Date() }).where(and(eq(switchboardChecklistInstancesTable.switchboardId, boardId.data), eq(switchboardChecklistInstancesTable.status, "in_progress"))).returning();
  if (!instance) { res.status(404).json({ error: "Aktivní checklist nebyl nalezen." }); return; }
  await db.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "checklist_current_phase_changed", entityType: "switchboard_checklist_instance", entityId: instance.id, payload: { phaseKey: body.data.phaseKey }, ...actor(req) });
  res.json(await loadChecklistPayload(boardId.data));
});

router.post("/switchboards/:id/checklist/phases/:phaseKey/complete", requirePermission("switchboards.phases.complete"), async (req, res) => {
  const boardId = id.safeParse(req.params.id);
  const phaseKey = z.enum(PHASE_KEYS).safeParse(req.params.phaseKey);
  const completionBody = z.object({ overrideReason: z.string().trim().min(10).max(2000).nullable().optional() }).safeParse(req.body ?? {});
  if (!boardId.success || !phaseKey.success || !completionBody.success) { res.status(400).json({ error: "Neplatná fáze nebo zdůvodnění výjimky." }); return; }
  try {
    await db.transaction(async (tx) => {
      const [board] = await tx.select().from(switchboardsTable).where(eq(switchboardsTable.id, boardId.data));
      const [instance] = await tx.select().from(switchboardChecklistInstancesTable).where(and(eq(switchboardChecklistInstancesTable.switchboardId, boardId.data), eq(switchboardChecklistInstancesTable.status, "in_progress"))).orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
      if (!board || !instance) throw Object.assign(new Error("Aktivní checklist nebyl nalezen."), { statusCode: 404 });
      await tx.execute(sql`select pg_advisory_xact_lock(${instance.id}, 8409)`);
      const definition = checklistDefinitionSchema.parse(instance.templateSnapshot);
      const phase = definition.phases.find((candidate) => candidate.key === phaseKey.data)!;
      const responses = await tx.select().from(switchboardChecklistResponsesTable).where(and(eq(switchboardChecklistResponsesTable.instanceId, instance.id), eq(switchboardChecklistResponsesTable.phaseKey, phase.key)));
      const evaluation = evaluatePhaseCompletion(phase, board.properties, responses);
      if (evaluation.missing.length) throw Object.assign(new Error(`Fázi nelze dokončit. Chybí ${evaluation.missing.length} povinných položek.`), { statusCode: 409 });
      const criticalResponseDefects = evaluation.defects.filter((item) => item.critical);
      const criticalResponseIds = new Set(criticalResponseDefects.map((item) => responses.find((response) => response.itemKey === item.key)?.id).filter((value): value is number => value != null));
      const openCriticalDefects = await tx.select({ id: switchboardDefectsTable.id, checklistResponseId: switchboardDefectsTable.checklistResponseId }).from(switchboardDefectsTable).where(and(eq(switchboardDefectsTable.switchboardId, board.id), eq(switchboardDefectsTable.isCritical, true), ne(switchboardDefectsTable.status, "closed"), or(eq(switchboardDefectsTable.phaseKey, phase.key), isNull(switchboardDefectsTable.phaseKey))));
      const criticalBlockers = criticalResponseIds.size + openCriticalDefects.filter((defect) => !defect.checklistResponseId || !criticalResponseIds.has(defect.checklistResponseId)).length;
      const overrideReason = completionBody.data.overrideReason ?? null;
      if (criticalBlockers && !overrideReason) throw Object.assign(new Error(`Fázi nelze dokončit. Existuje ${criticalBlockers} kritických blokací.`), { statusCode: 409 });
      if (criticalBlockers && !req.auth?.permissions.includes("switchboards.protocol.override")) throw Object.assign(new Error("Kritickou blokaci může obejít pouze oprávněný administrátor."), { statusCode: 403 });
      const next = PHASE_KEYS[PHASE_KEYS.indexOf(phase.key) + 1] ?? phase.key;
      const now = new Date();
      await tx.update(switchboardsTable).set({ ...phaseStatusPatch(phase.key, "completed"), ...(phase.key === "assembly" ? { status: "awaiting_inspection" } : phase.key === "inspection" ? { status: "awaiting_measurement" } : { status: "ready_for_handover" }), updatedAt: now }).where(eq(switchboardsTable.id, board.id));
      await tx.update(switchboardChecklistInstancesTable).set({ currentPhase: next, revision: sql`${switchboardChecklistInstancesTable.revision} + 1`, updatedAt: now }).where(eq(switchboardChecklistInstancesTable.id, instance.id));
      await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: criticalBlockers ? "checklist_phase_completed_with_override" : "checklist_phase_completed", entityType: "switchboard_checklist_instance", entityId: instance.id, payload: { phaseKey: phase.key, relevantItemCount: evaluation.relevant.length, responseCount: responses.length, nonCriticalDefectCount: evaluation.defects.length - criticalResponseDefects.length, criticalBlockers, overrideReason }, ...actor(req) });
    });
    res.json(await loadChecklistPayload(boardId.data));
  } catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

export default router;
