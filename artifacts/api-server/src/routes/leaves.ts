import { Router, type IRouter } from "express";
import { eq, and, gte, lte, ne } from "drizzle-orm";
import { db, employeeLeavesTable, peopleTable, leaveSettingsTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { z } from "zod/v4";
import { generateLeavesSummaryPdf, generateLeavesSummaryCsv, type LeaveSummaryRow } from "../lib/leaves-export";
import { getCzechPublicHolidays } from "./public-holidays";

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

const ExportQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  personId: z.coerce.number().int().positive().optional(),
  format: z.enum(["csv", "pdf"]).default("csv"),
});

const LeaveSettingsInputSchema = z.object({
  vacationYearlyCap: z.number().int().min(1),
  sickYearlyCap: z.number().int().min(1),
  otherYearlyCap: z.number().int().min(1),
});

const DEFAULT_CAPS = { vacationYearlyCap: 25, sickYearlyCap: 60, otherYearlyCap: 30 };

async function getLeaveSettings() {
  const [row] = await db.select().from(leaveSettingsTable).where(eq(leaveSettingsTable.id, 1));
  return row ?? { id: 1, updatedAt: new Date(), ...DEFAULT_CAPS };
}

/**
 * Build a Set of YYYY-MM-DD holiday strings covering all years in [startDate, endDate].
 */
function buildHolidaySet(startDate: string, endDate: string): Set<string> {
  const startYear = parseInt(startDate.slice(0, 4), 10);
  const endYear = parseInt(endDate.slice(0, 4), 10);
  const set = new Set<string>();
  for (let y = startYear; y <= endYear; y++) {
    for (const h of getCzechPublicHolidays(y)) {
      set.add(h.date);
    }
  }
  return set;
}

/**
 * Count business days (Mon–Fri, excluding Czech public holidays) between two
 * YYYY-MM-DD strings (inclusive). Returns at least 0 for same-day entries on
 * weekends/holidays.
 */
function countBusinessDays(startDate: string, endDate: string, holidays: Set<string>): number {
  let count = 0;
  const cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(cur.toISOString().slice(0, 10))) {
      count++;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/**
 * Count calendar days inclusive. Used for annual cap checks (caps are in calendar days).
 */
function countDays(startDate: string, endDate: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

function serializeLeave(leave: typeof employeeLeavesTable.$inferSelect, personName?: string | null) {
  const holidays = buildHolidaySet(leave.startDate, leave.endDate);
  const days = countBusinessDays(leave.startDate, leave.endDate, holidays);
  return {
    ...leave,
    personName: personName ?? null,
    days,
    createdAt: leave.createdAt.toISOString(),
    updatedAt: leave.updatedAt.toISOString(),
  };
}

/**
 * Count business days of a leave that fall within [yearFrom, yearTo].
 * Clips the leave's start/end to the year window so cross-year entries
 * are counted only for the days that actually fall in the target year.
 */
function countBusinessDaysInYear(
  startDate: string,
  endDate: string,
  yearFrom: string,
  yearTo: string,
  holidays: Set<string>,
): number {
  const clippedStart = startDate < yearFrom ? yearFrom : startDate;
  const clippedEnd = endDate > yearTo ? yearTo : endDate;
  if (clippedStart > clippedEnd) return 0;
  return countBusinessDays(clippedStart, clippedEnd, holidays);
}

/**
 * Check whether adding `newDays` of `type` for `personId` in the year of
 * `startDate` would exceed the configured annual cap.
 * `excludeId` lets the update path exclude the existing entry being edited.
 * Returns the error message string if the cap is exceeded, or null if OK.
 * Note: cap check uses calendar days to match the cap configuration unit.
 */
async function checkAnnualCap(
  personId: number,
  type: "vacation" | "sick" | "other",
  newDays: number,
  year: number,
  caps: typeof DEFAULT_CAPS,
  excludeId?: number,
): Promise<string | null> {
  const capField = type === "vacation" ? "vacationYearlyCap" : type === "sick" ? "sickYearlyCap" : "otherYearlyCap";
  const cap = caps[capField];

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const conditions = [
    eq(employeeLeavesTable.personId, personId),
    eq(employeeLeavesTable.type, type),
    gte(employeeLeavesTable.endDate, from),
    lte(employeeLeavesTable.startDate, to),
  ];
  if (excludeId != null) {
    conditions.push(ne(employeeLeavesTable.id, excludeId));
  }

  const existing = await db
    .select({ startDate: employeeLeavesTable.startDate, endDate: employeeLeavesTable.endDate })
    .from(employeeLeavesTable)
    .where(and(...conditions));

  const usedDays = existing.reduce((sum, l) => sum + countDays(l.startDate, l.endDate), 0);
  const totalDays = usedDays + newDays;

  if (totalDays > cap) {
    const typeLabel = type === "vacation" ? "dovolená" : type === "sick" ? "nemoc" : "jiné volno";
    return `Roční limit pro typ „${typeLabel}" je ${cap} dní. Aktuálně čerpáno: ${usedDays} dní, požadováno dalších: ${newDays} dní (celkem ${totalDays}).`;
  }
  return null;
}

// ── LIST ──────────────────────────────────────────────────────────────────────

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

// ── CREATE ────────────────────────────────────────────────────────────────────

router.post(
  "/leaves",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const parsed = LeaveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { personId, startDate, endDate, type } = parsed.data;

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

    const newDays = countDays(startDate, endDate);
    const year = new Date(startDate + "T00:00:00Z").getUTCFullYear();
    const caps = await getLeaveSettings();
    const capError = await checkAnnualCap(personId, type, newDays, year, caps);
    if (capError) {
      res.status(422).json({ error: capError });
      return;
    }

    const [leave] = await db
      .insert(employeeLeavesTable)
      .values(parsed.data)
      .returning();

    res.status(201).json(serializeLeave(leave, person.name));
  },
);

// ── SUMMARY ───────────────────────────────────────────────────────────────────
// Must be registered BEFORE /leaves/:id so Express doesn't treat "summary" as
// an id parameter.

router.get("/leaves/summary", async (req, res): Promise<void> => {
  const parsed = SummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? new Date().getFullYear();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const [people, leaves, caps] = await Promise.all([
    db.select().from(peopleTable).orderBy(peopleTable.name),
    db
      .select()
      .from(employeeLeavesTable)
      .where(
        and(
          gte(employeeLeavesTable.endDate, from),
          lte(employeeLeavesTable.startDate, to),
        ),
      ),
    getLeaveSettings(),
  ]);

  const holidays = buildHolidaySet(from, to);

  const summary = people.map((person) => {
    const personLeaves = leaves.filter((l) => l.personId === person.id);
    let vacationDays = 0;
    let sickDays = 0;
    let otherDays = 0;

    for (const leave of personLeaves) {
      const days = countBusinessDaysInYear(leave.startDate, leave.endDate, from, to, holidays);
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
      vacationYearlyCap: caps.vacationYearlyCap,
      sickYearlyCap: caps.sickYearlyCap,
      otherYearlyCap: caps.otherYearlyCap,
      remainingVacationDays: Math.max(0, caps.vacationYearlyCap - vacationDays),
      remainingSickDays: Math.max(0, caps.sickYearlyCap - sickDays),
      remainingOtherDays: Math.max(0, caps.otherYearlyCap - otherDays),
    };
  });

  res.json(summary);
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
// Must be registered BEFORE /leaves/:id so Express doesn't treat "settings" as
// an id parameter.

router.get(
  "/leaves/settings",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const settings = await getLeaveSettings();
    res.json({
      ...settings,
      updatedAt: settings.updatedAt instanceof Date ? settings.updatedAt.toISOString() : settings.updatedAt,
    });
  },
);

router.put(
  "/leaves/settings",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const parsed = LeaveSettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [existing] = await db.select().from(leaveSettingsTable).where(eq(leaveSettingsTable.id, 1));
    let row;
    if (existing) {
      [row] = await db
        .update(leaveSettingsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(leaveSettingsTable.id, 1))
        .returning();
    } else {
      [row] = await db
        .insert(leaveSettingsTable)
        .values({ id: 1, ...parsed.data })
        .returning();
    }

    res.json({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    });
  },
);

// ── EXPORT ────────────────────────────────────────────────────────────────────
// Must be registered BEFORE /leaves/:id so Express doesn't treat "export" as
// an id parameter.

router.get(
  "/leaves/export",
  requireRole("admin", "master"),
  async (req, res): Promise<void> => {
    const parsed = ExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { format, personId } = parsed.data;
    const year = parsed.data.year ?? new Date().getFullYear();
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;

    const peopleQuery = db.select().from(peopleTable).orderBy(peopleTable.name);
    const people = personId != null
      ? (await peopleQuery).filter((p) => p.id === personId)
      : await peopleQuery;

    if (personId != null && people.length === 0) {
      res.status(404).json({ error: "Pracovník nenalezen." });
      return;
    }

    const leaves = await db
      .select()
      .from(employeeLeavesTable)
      .where(
        and(
          gte(employeeLeavesTable.endDate, from),
          lte(employeeLeavesTable.startDate, to),
        ),
      );

    const holidays = buildHolidaySet(from, to);

    const summaryRows: LeaveSummaryRow[] = people.map((person) => {
      const personLeaves = leaves.filter((l) => l.personId === person.id);
      let vacationDays = 0;
      let sickDays = 0;
      let otherDays = 0;

      for (const leave of personLeaves) {
        const days = countBusinessDaysInYear(leave.startDate, leave.endDate, from, to, holidays);
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

    const personSlug = people.length === 1
      ? `-${people[0].name.replace(/[^\w]+/g, "-").toLowerCase()}`
      : "";
    const filename = `dovolene-${year}${personSlug}`;

    if (format === "pdf") {
      const pdfBuffer = generateLeavesSummaryPdf(summaryRows, year);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
      res.send(pdfBuffer);
      return;
    }

    const csv = generateLeavesSummaryCsv(summaryRows, year);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.send(csv);
  },
);

// ── UPDATE / DELETE ───────────────────────────────────────────────────────────

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

    const { personId, startDate, endDate, type } = parsed.data;
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

    const newDays = countDays(startDate, endDate);
    const year = new Date(startDate + "T00:00:00Z").getUTCFullYear();
    const caps = await getLeaveSettings();
    const capError = await checkAnnualCap(personId, type, newDays, year, caps, id);
    if (capError) {
      res.status(422).json({ error: capError });
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

export default router;
