import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { db, peopleTable, employeeLeavesTable } from "@workspace/db";
import {
  generateLeavesSummaryCsv,
  generateLeavesSummaryPdf,
  type LeaveSummaryRow,
} from "../src/lib/leaves-export";

/**
 * Leave-export smoke tests.
 *
 * Locked-in invariants:
 * 1. CSV output starts with a UTF-8 BOM and contains the expected header columns.
 * 2. PDF output starts with the PDF magic bytes (%PDF-).
 * 3. The personId filter applied in the route returns only that person's rows.
 * 4. The year window applied in the route excludes leaves from other years.
 *
 * DB-backed tests run against the dev DB (DATABASE_URL) and replicate the route's
 * query logic so that a future schema rename (column or table) will surface here
 * before it can silently break production exports. Fixtures are created with a
 * unique TAG and torn down in afterAll.
 */

const TAG = `test-lexp-${Date.now()}`;

const personIds: number[] = [];
const leaveIds: number[] = [];

let personAId: number;
let personBId: number;

// ── Fixtures ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Two workers
  const [personA] = await db
    .insert(peopleTable)
    .values({ name: `Worker A ${TAG}` })
    .returning();
  personAId = personA.id;
  personIds.push(personAId);

  const [personB] = await db
    .insert(peopleTable)
    .values({ name: `Worker B ${TAG}` })
    .returning();
  personBId = personB.id;
  personIds.push(personBId);

  // 2025 leaves — personA: vacation (5 days) + sick (2 days); personB: vacation (3 days)
  const [la1] = await db
    .insert(employeeLeavesTable)
    .values({ personId: personAId, type: "vacation", startDate: "2025-07-01", endDate: "2025-07-05" })
    .returning();
  leaveIds.push(la1.id);

  const [la2] = await db
    .insert(employeeLeavesTable)
    .values({ personId: personAId, type: "sick", startDate: "2025-09-10", endDate: "2025-09-11" })
    .returning();
  leaveIds.push(la2.id);

  const [lb1] = await db
    .insert(employeeLeavesTable)
    .values({ personId: personBId, type: "vacation", startDate: "2025-08-01", endDate: "2025-08-03" })
    .returning();
  leaveIds.push(lb1.id);

  // A 2024 leave for personA — must NOT appear in a 2025 export
  const [l2024] = await db
    .insert(employeeLeavesTable)
    .values({ personId: personAId, type: "vacation", startDate: "2024-12-20", endDate: "2024-12-22" })
    .returning();
  leaveIds.push(l2024.id);
});

afterAll(async () => {
  if (leaveIds.length)
    await db.delete(employeeLeavesTable).where(inArray(employeeLeavesTable.id, leaveIds));
  if (personIds.length)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
});

// ── Shared helper: replicates the route's DB query + summary aggregation ──────

/**
 * Mirrors /leaves/export route logic: queries the DB for the given year window
 * and optional personId, then builds the LeaveSummaryRow array.
 */
async function buildSummaryRows(year: number, personIdFilter?: number): Promise<LeaveSummaryRow[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const allPeople = await db.select().from(peopleTable).orderBy(peopleTable.name);
  const people =
    personIdFilter != null ? allPeople.filter((p) => p.id === personIdFilter) : allPeople;

  const leaves = await db
    .select()
    .from(employeeLeavesTable)
    .where(
      and(
        gte(employeeLeavesTable.endDate, from),
        lte(employeeLeavesTable.startDate, to),
      ),
    );

  return people.map((person) => {
    const personLeaves = leaves.filter((l) => l.personId === person.id);
    let vacationDays = 0;
    let sickDays = 0;
    let otherDays = 0;

    for (const leave of personLeaves) {
      // Clip to year window (mirrors countDaysInYear in leaves.ts)
      const clippedStart = leave.startDate < from ? from : leave.startDate;
      const clippedEnd = leave.endDate > to ? to : leave.endDate;
      if (clippedStart > clippedEnd) continue;
      const days =
        Math.round(
          (new Date(clippedEnd + "T00:00:00Z").getTime() -
            new Date(clippedStart + "T00:00:00Z").getTime()) /
            86400000,
        ) + 1;

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
}

// ── Unit tests: CSV generator ─────────────────────────────────────────────────

const sampleRows: LeaveSummaryRow[] = [
  {
    personId: 1,
    personName: "Novák Jan",
    year: 2025,
    vacationDays: 5,
    sickDays: 2,
    otherDays: 0,
    totalDays: 7,
  },
  {
    personId: 2,
    personName: "Svobodová, Eva",
    year: 2025,
    vacationDays: 3,
    sickDays: 0,
    otherDays: 1,
    totalDays: 4,
  },
];

describe("generateLeavesSummaryCsv — unit", () => {
  it("starts with a UTF-8 BOM (\\uFEFF)", () => {
    const csv = generateLeavesSummaryCsv(sampleRows, 2025);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("second line is the header with all required columns", () => {
    const csv = generateLeavesSummaryCsv(sampleRows, 2025);
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
    // First line is a comment (#), second is the header
    const header = lines[1];
    expect(header).toContain("Pracovník");
    expect(header).toContain("Rok");
    expect(header).toContain("Dovolená (dny)");
    expect(header).toContain("Nemoc (dny)");
    expect(header).toContain("Jiné (dny)");
    expect(header).toContain("Celkem (dny)");
  });

  it("produces one data row per input row", () => {
    const csv = generateLeavesSummaryCsv(sampleRows, 2025);
    const lines = csv
      .replace(/^\uFEFF/, "")
      .split("\r\n")
      .filter((l) => l.length > 0);
    // comment + header + 2 data rows
    expect(lines).toHaveLength(4);
  });

  it("quotes a name that contains a comma", () => {
    const csv = generateLeavesSummaryCsv(sampleRows, 2025);
    expect(csv).toContain('"Svobodová, Eva"');
  });

  it("data row values match the input row fields", () => {
    const csv = generateLeavesSummaryCsv([sampleRows[0]], 2025);
    expect(csv).toContain("Novák Jan");
    expect(csv).toContain("2025");
    const lines = csv
      .replace(/^\uFEFF/, "")
      .split("\r\n")
      .filter((l) => l.length > 0);
    const cols = lines[2].split(","); // skip comment + header
    expect(Number(cols[2])).toBe(5); // vacationDays
    expect(Number(cols[3])).toBe(2); // sickDays
    expect(Number(cols[5])).toBe(7); // totalDays
  });

  it("handles an empty row list", () => {
    const csv = generateLeavesSummaryCsv([], 2025);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv
      .replace(/^\uFEFF/, "")
      .split("\r\n")
      .filter((l) => l.length > 0);
    // comment + header, no data rows
    expect(lines).toHaveLength(2);
  });
});

// ── Unit tests: PDF generator ─────────────────────────────────────────────────

describe("generateLeavesSummaryPdf — unit", () => {
  it("returns a Buffer starting with PDF magic bytes (%PDF-)", () => {
    const buf = generateLeavesSummaryPdf(sampleRows, 2025);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("produces a non-trivially-sized buffer (> 1 kB)", () => {
    const buf = generateLeavesSummaryPdf(sampleRows, 2025);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("handles an empty row list without throwing", () => {
    expect(() => generateLeavesSummaryPdf([], 2025)).not.toThrow();
    const buf = generateLeavesSummaryPdf([], 2025);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

// ── Integration tests: DB schema + generator (year filter + personId filter) ──

describe("leave export — DB-backed integration", () => {
  it("year filter: 2025 export excludes the 2024 leave for personA", async () => {
    const rows = await buildSummaryRows(2025, personAId);
    // personA has 5 vacation days + 2 sick days in 2025; 3 vacation days in 2024
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.personId).toBe(personAId);
    expect(row.vacationDays).toBe(5); // NOT 8 (would be 8 if 2024 leak)
    expect(row.sickDays).toBe(2);
    expect(row.totalDays).toBe(7);
  });

  it("personId filter: only personB's row is returned", async () => {
    const rows = await buildSummaryRows(2025, personBId);
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(personBId);
    expect(rows[0].personName).toContain(`Worker B ${TAG}`);
  });

  it("personId filter: personA does not appear when filtering by personB", async () => {
    const rows = await buildSummaryRows(2025, personBId);
    const personARow = rows.find((r) => r.personId === personAId);
    expect(personARow).toBeUndefined();
  });

  it("personId filter: personB vacation days are correct (3 days, Aug 1–3)", async () => {
    const rows = await buildSummaryRows(2025, personBId);
    expect(rows[0].vacationDays).toBe(3);
    expect(rows[0].sickDays).toBe(0);
    expect(rows[0].totalDays).toBe(3);
  });

  it("no personId filter: both people appear in the result", async () => {
    const rows = await buildSummaryRows(2025);
    const personARow = rows.find((r) => r.personId === personAId);
    const personBRow = rows.find((r) => r.personId === personBId);
    expect(personARow).toBeDefined();
    expect(personBRow).toBeDefined();
  });

  it("CSV output from DB rows has correct BOM + header", async () => {
    const rows = await buildSummaryRows(2025, personAId);
    const csv = generateLeavesSummaryCsv(rows, 2025);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Pracovník");
    expect(csv).toContain("Dovolená (dny)");
  });

  it("PDF output from DB rows starts with PDF magic bytes", async () => {
    const rows = await buildSummaryRows(2025, personAId);
    const buf = generateLeavesSummaryPdf(rows, 2025);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
