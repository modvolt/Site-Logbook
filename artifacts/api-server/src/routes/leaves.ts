import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db, employeeLeavesTable, peopleTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { z } from "zod/v4";

const router: IRouter = Router();

const LeaveInputSchema = z.object({
  personId: z.number().int().positive(),
  type: z.enum(["vacation", "sick", "other"]).default("vacation"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().optional().nullable(),
});

const LeaveQuerySchema = z.object({
  personId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(["vacation", "sick", "other"]).optional(),
});

const SummaryQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
});

function serializeLeave(leave: typeof employeeLeavesTable.$inferSelect, personName?: string | null) {
  const start = new Date(leave.startDate + "T00:00:00Z");
  const end = new Date(leave.endDate + "T00:00:00Z");
  const diffMs = end.getTime() - start.getTime();
  const days = Math.max(1, Math.round(diffMs / 86400000) + 1);
  return {
    ...leave,
    personName: personName ?? null,
    days,
    createdAt: leave.createdAt.toISOString(),
    updatedAt: leave.updatedAt.toISOString(),
  };
}

router.get("/leaves", async (req, res): Promise<void> => {
  const parsed = LeaveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { personId, from, to, type } = parsed.data;
  const conditions = [];
  if (personId != null) conditions.push(eq(employeeLeavesTable.personId, personId));
  if (from) conditions.push(gte(employeeLeavesTable.endDate, from));
  if (to) conditions.push(lte(employeeLeavesTable.startDate, to));
  if (type) conditions.push(eq(employeeLeavesTable.type, type));

  const rows = await db
    .select({ leave: employeeLeavesTable, personName: peopleTable.name })
    .from(employeeLeavesTable)
    .leftJoin(peopleTable, eq(employeeLeavesTable.personId, peopleTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(employeeLeavesTable.startDate);

  res.json(rows.map((r) => serializeLeave(r.leave, r.personName)));
});

router.post(
  "/leaves",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const parsed = LeaveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { personId, startDate, endDate } = parsed.data;

    if (startDate > endDate) {
      res.status(400).json({ error: "Datum konce musí být stejné nebo pozdější než datum začátku." });
      return;
    }

    const [person] = await db
      .select({ id: peopleTable.id, name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, personId));
    if (!person) {
      res.status(404).json({ error: "Pracovník nenalezen." });
      return;
    }

    const [leave] = await db
      .insert(employeeLeavesTable)
      .values(parsed.data)
      .returning();

    res.status(201).json(serializeLeave(leave, person.name));
  },
);

router.put(
  "/leaves/:id",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const parsed = LeaveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { personId, startDate, endDate } = parsed.data;
    if (startDate > endDate) {
      res.status(400).json({ error: "Datum konce musí být stejné nebo pozdější než datum začátku." });
      return;
    }

    const [personExists] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(eq(peopleTable.id, personId));
    if (!personExists) {
      res.status(400).json({ error: "Pracovník nebyl nalezen." });
      return;
    }

    const [leave] = await db
      .update(employeeLeavesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(employeeLeavesTable.id, id))
      .returning();

    if (!leave) {
      res.status(404).json({ error: "Dovolená nenalezena." });
      return;
    }

    const [person] = await db
      .select({ name: peopleTable.name })
      .from(peopleTable)
      .where(eq(peopleTable.id, leave.personId));

    res.json(serializeLeave(leave, person?.name ?? null));
  },
);

router.delete(
  "/leaves/:id",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const deleted = await db
      .delete(employeeLeavesTable)
      .where(eq(employeeLeavesTable.id, id))
      .returning({ id: employeeLeavesTable.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Dovolená nenalezena." });
      return;
    }

    res.sendStatus(204);
  },
);

router.get("/leaves/summary", async (req, res): Promise<void> => {
  const parsed = SummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? new Date().getFullYear();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const people = await db.select().from(peopleTable).orderBy(peopleTable.name);
  const leaves = await db
    .select()
    .from(employeeLeavesTable)
    .where(
      and(
        gte(employeeLeavesTable.endDate, from),
        lte(employeeLeavesTable.startDate, to),
      ),
    );

  const summary = people.map((person) => {
    const personLeaves = leaves.filter((l) => l.personId === person.id);
    let vacationDays = 0;
    let sickDays = 0;
    let otherDays = 0;

    for (const leave of personLeaves) {
      const start = new Date(leave.startDate + "T00:00:00Z");
      const end = new Date(leave.endDate + "T00:00:00Z");
      const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
      if (leave.type === "vacation") vacationDays += days;
      else if (leave.type === "sick") sickDays += days;
      else otherDays += days;
    }

    return {
      personId: person.id,
      personName: person.name,
      year,
      vacationDays,
      sickDays,
      otherDays,
      totalDays: vacationDays + sickDays + otherDays,
    };
  });

  res.json(summary);
});

export default router;
