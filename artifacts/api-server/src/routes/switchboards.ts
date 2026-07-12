import { Router, type IRouter, type Request } from "express";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, jobsTable, peopleTable, switchboardsTable, switchboardAssigneesTable,
  switchboardEventsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";

const router: IRouter = Router();

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
