import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, billingSettingsTable, customersTable, jobsTable, peopleTable, usersTable,
  switchboardsTable, switchboardAssigneesTable, switchboardChecklistInstancesTable,
  switchboardChecklistResponsesTable, switchboardChecklistTemplatesTable,
  switchboardChecklistTemplateVersionsTable, switchboardMeasurementsTable,
  switchboardDefectsTable, switchboardPhotosTable, switchboardLabelVersionsTable,
  switchboardProtocolVersionsTable, switchboardEventsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { checklistDefinitionSchema, itemIsRelevant } from "../lib/switchboard-checklist";
import { decryptQrToken, publicQrUrl } from "../lib/switchboard-qr";
import { summarizeLatestMeasurements } from "../lib/switchboard-operation-rules";
import {
  evaluateProtocolReadiness, generateSwitchboardProtocolPdf,
  SWITCHBOARD_PROTOCOL_GENERATOR_VERSION, type ProtocolBlocker,
  type ProtocolReadinessInput, type SwitchboardProtocolSnapshot,
} from "../lib/switchboard-protocol";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const id = z.coerce.number().int().positive();
const generateBody = z.object({ overrideReason: z.string().trim().min(10).max(2000).nullable().optional() }).strict();
type ReadExecutor = Pick<typeof db, "select">;

type ProtocolSource = {
  snapshotBase: Omit<SwitchboardProtocolSnapshot, "protocol">;
  readiness: ProtocolReadinessInput;
  checklistInstanceId: number | null;
  qrTokenCiphertext: string | null;
};

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const sourceFingerprint = (value: Omit<SwitchboardProtocolSnapshot, "protocol">) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function loadProtocolSource(executor: ReadExecutor, switchboardId: number): Promise<ProtocolSource | null> {
  const [board] = await executor.select().from(switchboardsTable).where(eq(switchboardsTable.id, switchboardId));
  if (!board) return null;
  const [jobRow] = await executor.select({ job: jobsTable, customer: customersTable }).from(jobsTable).leftJoin(customersTable, eq(customersTable.id, jobsTable.customerId)).where(eq(jobsTable.id, board.jobId));
  if (!jobRow) throw Object.assign(new Error("Zakázka rozvaděče nebyla nalezena."), { statusCode: 409 });
  const [settings] = await executor.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, 1));
  const [instance] = await executor.select().from(switchboardChecklistInstancesTable).where(eq(switchboardChecklistInstancesTable.switchboardId, board.id)).orderBy(desc(switchboardChecklistInstancesTable.id)).limit(1);
  const [latestLabel] = await executor.select().from(switchboardLabelVersionsTable).where(eq(switchboardLabelVersionsTable.switchboardId, board.id)).orderBy(desc(switchboardLabelVersionsTable.version)).limit(1);
  const assignees = await executor.select({ name: peopleTable.name, responsible: switchboardAssigneesTable.isResponsible }).from(switchboardAssigneesTable).innerJoin(peopleTable, eq(peopleTable.id, switchboardAssigneesTable.personId)).where(eq(switchboardAssigneesTable.switchboardId, board.id));
  const measurements = await executor.select().from(switchboardMeasurementsTable).where(eq(switchboardMeasurementsTable.switchboardId, board.id)).orderBy(switchboardMeasurementsTable.measuredAt, switchboardMeasurementsTable.id);
  const defects = await executor.select().from(switchboardDefectsTable).where(eq(switchboardDefectsTable.switchboardId, board.id)).orderBy(switchboardDefectsTable.foundAt, switchboardDefectsTable.id);
  const photos = await executor.select().from(switchboardPhotosTable).where(eq(switchboardPhotosTable.switchboardId, board.id)).orderBy(switchboardPhotosTable.createdAt, switchboardPhotosTable.id);
  let responses: Array<typeof switchboardChecklistResponsesTable.$inferSelect> = [];
  let templateName: string | null = null; let templateVersion: number | null = null;
  let definition: z.infer<typeof checklistDefinitionSchema> | null = null;
  if (instance) {
    definition = checklistDefinitionSchema.parse(instance.templateSnapshot);
    responses = await executor.select().from(switchboardChecklistResponsesTable).where(eq(switchboardChecklistResponsesTable.instanceId, instance.id));
    const [template] = await executor.select({ name: switchboardChecklistTemplatesTable.name, version: switchboardChecklistTemplateVersionsTable.version }).from(switchboardChecklistTemplateVersionsTable).innerJoin(switchboardChecklistTemplatesTable, eq(switchboardChecklistTemplatesTable.id, switchboardChecklistTemplateVersionsTable.templateId)).where(eq(switchboardChecklistTemplateVersionsTable.id, instance.templateVersionId));
    templateName = template?.name ?? null; templateVersion = template?.version ?? null;
  }
  const userIds = [...new Set([
    ...responses.map((row) => row.performedByUserId), ...measurements.map((row) => row.measuredByUserId),
    ...defects.flatMap((row) => [row.foundByUserId, row.closedByUserId]), ...photos.map((row) => row.uploadedByUserId),
    latestLabel?.approvedByUserId,
  ].filter((value): value is number => value != null))];
  const users = userIds.length ? await executor.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const userName = (userId: number | null | undefined) => users.find((user) => user.id === userId)?.name ?? null;
  const personIds = [...new Set(defects.map((row) => row.responsiblePersonId).filter((value): value is number => value != null))];
  const responsiblePeople = personIds.length ? await executor.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds)) : [];
  const responseByItem = new Map(responses.map((row) => [row.itemKey, row]));
  const measurementByResponse = new Map<number, typeof measurements>();
  for (const measurement of measurements) { if (!measurement.checklistResponseId) continue; const list = measurementByResponse.get(measurement.checklistResponseId) ?? []; list.push(measurement); measurementByResponse.set(measurement.checklistResponseId, list); }
  const phaseStatuses = { assembly: board.assemblyStatus, inspection: board.inspectionStatus, measurement: board.measurementStatus };
  const readinessItems: ProtocolReadinessInput["items"] = [];
  const phases = definition?.phases.map((phase) => ({
    key: phase.key, title: phase.title, status: phaseStatuses[phase.key],
    items: phase.items.filter((item) => itemIsRelevant(item, board.properties)).map((item) => {
      const response = responseByItem.get(item.key) ?? null;
      const linkedMeasurements = response ? measurementByResponse.get(response.id) ?? [] : [];
      const hasPassingMeasurement = linkedMeasurements.length > 0 && summarizeLatestMeasurements(linkedMeasurements).passed;
      const hasLinkedPhoto = photos.some((photo) => photo.relatedType === "checklist_item" && photo.relatedId === instance?.id && photo.checklistItemKey === item.key);
      readinessItems.push({ phaseKey: phase.key, itemKey: item.key, title: item.title, required: item.required, critical: item.critical, kind: item.kind, result: response?.result ?? null, hasLinkedPhoto, hasPassingMeasurement });
      return { key: item.key, title: item.title, required: item.required, critical: item.critical, kind: item.kind, result: response?.result ?? null, value: response?.value ?? null, unit: response?.unit ?? null, passed: response?.passed ?? null, note: response?.note ?? null, justification: response?.justification ?? null, performedBy: userName(response?.performedByUserId), performedAt: iso(response?.performedAt) };
    }),
  })) ?? [];
  const requiredBoardFields: Array<[string, unknown]> = [["výrobní číslo", board.serialNumber], ["datum výroby", board.productionDate], ["typ", board.typeDesignation], ["soustava", board.networkSystem], ["jmenovité napětí", board.ratedVoltage], ["frekvence", board.ratedFrequency], ["jmenovitý proud", board.ratedCurrent], ["IP", board.ipRating], ["normy", board.standards.length ? board.standards : null]];
  const readiness: ProtocolReadinessInput = {
    hasChecklist: !!instance,
    phaseStatuses,
    items: readinessItems,
    openCriticalDefects: defects.filter((row) => row.isCritical && row.status !== "closed").map((row) => ({ id: row.id, title: row.title })),
    labelApproved: latestLabel?.status === "approved",
    qrEnabled: board.qrEnabled && !!board.qrTokenCiphertext,
    missingBoardFields: requiredBoardFields.filter(([, value]) => value == null || String(value).trim() === "").map(([label]) => label),
  };
  return {
    readiness,
    checklistInstanceId: instance?.id ?? null,
    qrTokenCiphertext: board.qrTokenCiphertext,
    snapshotBase: {
      schemaVersion: 1,
      company: { name: settings?.supplierName ?? "Modvolt s.r.o.", ic: settings?.supplierIc ?? null, dic: settings?.supplierDic ?? null, address: settings?.supplierAddress ?? null, email: settings?.supplierEmail ?? null, phone: settings?.supplierPhone ?? null },
      job: { id: jobRow.job.id, number: jobRow.job.jobNumber, title: jobRow.job.title, address: jobRow.job.address, customerName: jobRow.customer?.companyName ?? null, customerAddress: jobRow.customer?.address ?? null },
      board: { id: board.id, designation: board.designation, internalName: board.internalName, status: board.status, installationLocation: board.installationLocation, serialNumber: board.serialNumber, productionDate: board.productionDate, typeDesignation: board.typeDesignation, manufacturer: board.manufacturer, networkSystem: board.networkSystem, ratedVoltage: board.ratedVoltage, ratedFrequency: board.ratedFrequency, ratedCurrent: board.ratedCurrent, ipRating: board.ipRating, ikRating: board.ikRating, dimensions: board.dimensions, weight: board.weight, standards: board.standards, notes: board.notes, qrReference: board.qrEnabled ? `/q/board/${board.qrTokenPrefix ?? "unknown"}…` : null },
      checklist: { instanceId: instance?.id ?? null, templateName, templateVersion, startedAt: iso(instance?.startedAt), phases },
      measurements: measurements.map((row) => ({ id: row.id, phaseKey: row.phaseKey, type: row.measurementType, subject: row.subjectLabel, value: row.value ?? row.valueText, unit: row.unit, result: row.result, instrument: row.instrument, note: row.note, measuredBy: userName(row.measuredByUserId), measuredAt: row.measuredAt.toISOString() })),
      defects: defects.map((row) => ({ id: row.id, phaseKey: row.phaseKey, title: row.title, description: row.description, severity: row.severity, critical: row.isCritical, status: row.status, responsiblePerson: responsiblePeople.find((person) => person.id === row.responsiblePersonId)?.name ?? null, dueDate: row.dueDate, foundBy: userName(row.foundByUserId), foundAt: row.foundAt.toISOString(), repairDescription: row.repairDescription, closedBy: userName(row.closedByUserId), closedAt: iso(row.closedAt) })),
      photos: photos.map((row) => ({ id: row.id, category: row.category, relation: row.relatedType, description: row.description, fileName: row.originalFileName, sha256: row.sha256, author: userName(row.uploadedByUserId), takenAt: iso(row.takenAt), createdAt: row.createdAt.toISOString() })),
      approvedLabel: latestLabel?.status === "approved" ? { id: latestLabel.id, version: latestLabel.version, approvedAt: iso(latestLabel.approvedAt), approvedBy: userName(latestLabel.approvedByUserId) } : null,
      assignees: [...assignees].sort((a, b) => Number(b.responsible) - Number(a.responsible) || a.name.localeCompare(b.name, "cs")),
    },
  };
}

function serializeProtocol(row: typeof switchboardProtocolVersionsTable.$inferSelect, createdByName: string | null = null) {
  const { pdfStoragePath: _pdfStoragePath, dataSnapshot: _dataSnapshot, ...safe } = row;
  return { ...safe, createdByName, createdAt: row.createdAt.toISOString(), downloadUrl: row.status === "final" ? `/api/switchboards/${row.switchboardId}/protocols/${row.id}/pdf` : null };
}

router.get("/switchboards/:id/protocols/readiness", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  try { const source = await loadProtocolSource(db, boardId.data); if (!source) { res.status(404).json({ error: "Rozvaděč nebyl nalezen." }); return; } const blockers = evaluateProtocolReadiness(source.readiness); res.json({ ready: blockers.length === 0, blockers }); }
  catch (error) { res.status((error as { statusCode?: number }).statusCode ?? 500).json({ error: (error as Error).message }); }
});

router.get("/switchboards/:id/protocols", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); if (!boardId.success) { res.status(400).json({ error: "Neplatný rozvaděč." }); return; }
  const rows = await db.select({ protocol: switchboardProtocolVersionsTable, createdByName: usersTable.name }).from(switchboardProtocolVersionsTable).leftJoin(usersTable, eq(usersTable.id, switchboardProtocolVersionsTable.createdByUserId)).where(eq(switchboardProtocolVersionsTable.switchboardId, boardId.data)).orderBy(desc(switchboardProtocolVersionsTable.version));
  res.json(rows.map((row) => serializeProtocol(row.protocol, row.createdByName)));
});

router.get("/switchboards/:id/protocols/:protocolId", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const protocolId = id.safeParse(req.params.protocolId); if (!boardId.success || !protocolId.success) { res.status(400).json({ error: "Neplatný protokol." }); return; }
  const [row] = await db.select({ protocol: switchboardProtocolVersionsTable, createdByName: usersTable.name }).from(switchboardProtocolVersionsTable).leftJoin(usersTable, eq(usersTable.id, switchboardProtocolVersionsTable.createdByUserId)).where(and(eq(switchboardProtocolVersionsTable.id, protocolId.data), eq(switchboardProtocolVersionsTable.switchboardId, boardId.data)));
  if (!row) { res.status(404).json({ error: "Protokol nebyl nalezen." }); return; }
  res.json({ ...serializeProtocol(row.protocol, row.createdByName), dataSnapshot: row.protocol.dataSnapshot });
});

router.post("/switchboards/:id/protocols/generate", requirePermission("switchboards.protocol.complete"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const body = generateBody.safeParse(req.body ?? {});
  if (!boardId.success || !body.success) { res.status(400).json({ error: "Neplatné zdůvodnění administrátorské výjimky." }); return; }
  let created: { protocol: typeof switchboardProtocolVersionsTable.$inferSelect; snapshot: SwitchboardProtocolSnapshot; qrTokenCiphertext: string | null; checklistInstanceId: number | null } | null = null;
  try {
    created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${boardId.data}, 8412)`);
      const source = await loadProtocolSource(tx, boardId.data); if (!source) throw Object.assign(new Error("Rozvaděč nebyl nalezen."), { statusCode: 404 });
      const blockers = evaluateProtocolReadiness(source.readiness); const suppliedReason = body.data.overrideReason?.trim() || null;
      if (blockers.length && !suppliedReason) throw Object.assign(new Error(`Finální protokol nelze vytvořit. Zbývá ${blockers.length} blokací.`), { statusCode: 409, blockers });
      if (blockers.length && !req.auth?.permissions.includes("switchboards.protocol.override")) throw Object.assign(new Error("Administrátorskou výjimku může použít pouze oprávněný uživatel."), { statusCode: 403 });
      const [{ value }] = await tx.select({ value: max(switchboardProtocolVersionsTable.version) }).from(switchboardProtocolVersionsTable).where(eq(switchboardProtocolVersionsTable.switchboardId, boardId.data));
      const version = Number(value ?? 0) + 1; const year = new Date().getFullYear(); const boardToken = source.snapshotBase.board.designation.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || `R${boardId.data}`;
      const protocolNumber = `RZ-${year}-${source.snapshotBase.job.number ?? source.snapshotBase.job.id}-${boardToken}-V${String(version).padStart(2, "0")}`;
      const generatedAt = new Date(); const actorName = req.auth?.name ?? req.auth?.username ?? "Neznámý uživatel";
      const snapshot: SwitchboardProtocolSnapshot = { ...source.snapshotBase, protocol: { number: protocolNumber, version, generatorVersion: SWITCHBOARD_PROTOCOL_GENERATOR_VERSION, sourceFingerprint: sourceFingerprint(source.snapshotBase), generatedAt: generatedAt.toISOString(), generatedBy: actorName, overrideReason: blockers.length ? suppliedReason : null, overriddenBlockers: blockers.length ? blockers : [] } };
      const path = `/objects/switchboards/${boardId.data}/protocols/${randomUUID()}.pdf`;
      const [protocol] = await tx.insert(switchboardProtocolVersionsTable).values({ switchboardId: boardId.data, version, protocolNumber, dataSnapshot: snapshot, pdfStoragePath: path, generatorVersion: SWITCHBOARD_PROTOCOL_GENERATOR_VERSION, status: "generating", createdByUserId: req.auth?.userId ?? null, createdAt: generatedAt }).returning();
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "protocol_generation_started", entityType: "switchboard_protocol_version", entityId: protocol.id, payload: { version, protocolNumber, generatorVersion: SWITCHBOARD_PROTOCOL_GENERATOR_VERSION, blockerCount: blockers.length, overrideReason: snapshot.protocol.overrideReason }, actorUserId: req.auth?.userId ?? null, actorName });
      return { protocol, snapshot, qrTokenCiphertext: source.qrTokenCiphertext, checklistInstanceId: source.checklistInstanceId };
    });
    let qrUrl: string | null = null;
    if (created.qrTokenCiphertext) qrUrl = publicQrUrl(decryptQrToken(created.qrTokenCiphertext), `${req.protocol}://${req.get("host")}`);
    const pdf = await generateSwitchboardProtocolPdf(created.snapshot, qrUrl);
    await storage.putPrivateObject(created.protocol.pdfStoragePath, pdf, "application/pdf");
    const final = await db.transaction(async (tx) => {
      const currentSource = await loadProtocolSource(tx, boardId.data);
      if (!currentSource || sourceFingerprint(currentSource.snapshotBase) !== created!.snapshot.protocol.sourceFingerprint) throw Object.assign(new Error("Data rozvaděče se během generování změnila. Načtěte aktuální stav a vytvořte novou verzi protokolu."), { statusCode: 409 });
      const [protocol] = await tx.update(switchboardProtocolVersionsTable).set({ status: "final" }).where(and(eq(switchboardProtocolVersionsTable.id, created!.protocol.id), eq(switchboardProtocolVersionsTable.status, "generating"))).returning();
      if (!protocol) throw new Error("Rozpracovanou verzi protokolu se nepodařilo dokončit.");
      const now = new Date(); await tx.update(switchboardsTable).set({ status: "protocol_completed", updatedAt: now }).where(eq(switchboardsTable.id, boardId.data));
      if (created!.checklistInstanceId) await tx.update(switchboardChecklistInstancesTable).set({ status: "completed", completedAt: now, completedByUserId: req.auth?.userId ?? null, overrideReason: created!.snapshot.protocol.overrideReason, overrideByUserId: created!.snapshot.protocol.overrideReason ? req.auth?.userId ?? null : null, updatedAt: now }).where(eq(switchboardChecklistInstancesTable.id, created!.checklistInstanceId));
      await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "protocol_generated", entityType: "switchboard_protocol_version", entityId: protocol.id, payload: { version: protocol.version, protocolNumber: protocol.protocolNumber, generatorVersion: protocol.generatorVersion, pdfSizeBytes: pdf.length, pdfSha256: createHash("sha256").update(pdf).digest("hex"), snapshotSchemaVersion: created!.snapshot.schemaVersion, sourceFingerprint: created!.snapshot.protocol.sourceFingerprint, previousBoardStatus: created!.snapshot.board.status, newBoardStatus: "protocol_completed", overrideReason: created!.snapshot.protocol.overrideReason }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null });
      return protocol;
    });
    res.status(201).json(serializeProtocol(final, req.auth?.name ?? req.auth?.username ?? null));
  } catch (error) {
    const failure = error as Error & { statusCode?: number; blockers?: ProtocolBlocker[] };
    if (created) {
      await storage.deletePrivateObject(created.protocol.pdfStoragePath).catch(() => false);
      await db.transaction(async (tx) => {
        await tx.update(switchboardProtocolVersionsTable).set({ status: "failed" }).where(and(eq(switchboardProtocolVersionsTable.id, created!.protocol.id), eq(switchboardProtocolVersionsTable.status, "generating")));
        await tx.insert(switchboardEventsTable).values({ switchboardId: boardId.data, eventType: "protocol_generation_failed", entityType: "switchboard_protocol_version", entityId: created!.protocol.id, payload: { version: created!.protocol.version, error: failure.message }, actorUserId: req.auth?.userId ?? null, actorName: req.auth?.name ?? req.auth?.username ?? null });
      }).catch(() => undefined);
    }
    res.status(failure.statusCode ?? 500).json({ error: failure.statusCode ? failure.message : `Generování protokolu selhalo: ${failure.message}`, ...(failure.blockers ? { blockers: failure.blockers } : {}) });
  }
});

router.get("/switchboards/:id/protocols/:protocolId/pdf", requirePermission("switchboards.view"), async (req, res) => {
  const boardId = id.safeParse(req.params.id); const protocolId = id.safeParse(req.params.protocolId); if (!boardId.success || !protocolId.success) { res.status(400).json({ error: "Neplatný protokol." }); return; }
  const [protocol] = await db.select().from(switchboardProtocolVersionsTable).where(and(eq(switchboardProtocolVersionsTable.id, protocolId.data), eq(switchboardProtocolVersionsTable.switchboardId, boardId.data)));
  if (!protocol || protocol.status !== "final") { res.status(404).json({ error: "Finální PDF protokolu nebylo nalezeno." }); return; }
  res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(`${protocol.protocolNumber}.pdf`)}`);
  try { await storage.servePrivateObject(protocol.pdfStoragePath, res); } catch (error) { if (!res.headersSent) res.status(error instanceof ObjectNotFoundError ? 404 : 500).json({ error: "PDF protokolu není dostupné." }); }
});

export default router;
