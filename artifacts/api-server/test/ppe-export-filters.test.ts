import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  usersTable,
  ppeItemsTable,
  ppeAssignmentsTable,
  peopleTable,
} from "@workspace/db";
import app from "../src/app";

/**
 * Integration tests for GET /api/ppe/assignments/export.
 *
 * Covers every independent filter branch (personId, status, overdue,
 * issuedFrom/issuedTo) and their combinations, plus CSV/PDF response-header
 * correctness and Czech diacritics round-trip in CSV output.
 *
 * Runs against the dev database (DATABASE_URL). All fixtures carry a unique tag
 * and are torn down afterwards.
 */

const TAG = `test-ppe-exp-${Date.now()}`;
const PASSWORD = "test-ppe-exp-pw-123";

// Czech-diacritics names to exercise ř/š/ě/č/ů etc.
const PERSON1_NAME = `Jiří Novák ${TAG}`;
const PERSON2_NAME = `Šárka Dvořáčková ${TAG}`;
const ITEM1_NAME = `Přilba se štítem ${TAG}`;
const ITEM2_NAME = `Rukavice ${TAG}`;

let adminAgent: Agent;

let adminUserId: number;
let person1Id: number;
let person2Id: number;
let item1Id: number;
let item2Id: number;

// Three assignments with distinct characteristics:
//   A1 – person1 / item1 / issued / issuedAt past / replaceBy in past → overdue
//   A2 – person2 / item2 / returned / issuedAt mid-range
//   A3 – person1 / item1 / issued / issuedAt recent / replaceBy far future
let assignmentId1: number;
let assignmentId2: number;
let assignmentId3: number;

const userIds: number[] = [];
const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `PPE Export Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;
  userIds.push(adminUserId);

  const [p1] = await db.insert(peopleTable).values({ name: PERSON1_NAME }).returning();
  person1Id = p1.id;
  personIds.push(person1Id);

  const [p2] = await db.insert(peopleTable).values({ name: PERSON2_NAME }).returning();
  person2Id = p2.id;
  personIds.push(person2Id);

  const [i1] = await db
    .insert(ppeItemsTable)
    .values({ name: ITEM1_NAME, category: "hlava", active: true })
    .returning();
  item1Id = i1.id;
  itemIds.push(item1Id);

  const [i2] = await db
    .insert(ppeItemsTable)
    .values({ name: ITEM2_NAME, category: "ruky", active: true })
    .returning();
  item2Id = i2.id;
  itemIds.push(item2Id);

  // A1: issued, old date, overdue (replaceBy in the past)
  const [a1] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: item1Id,
      personId: person1Id,
      ppeNameSnapshot: ITEM1_NAME,
      personNameSnapshot: PERSON1_NAME,
      quantity: 1,
      issuedAt: "2024-01-15",
      replaceBy: "2020-01-01",
      status: "issued",
    })
    .returning();
  assignmentId1 = a1.id;
  assignmentIds.push(assignmentId1);

  // A2: returned, mid-range date
  const [a2] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: item2Id,
      personId: person2Id,
      ppeNameSnapshot: ITEM2_NAME,
      personNameSnapshot: PERSON2_NAME,
      quantity: 2,
      issuedAt: "2024-06-01",
      returnedAt: "2024-08-01",
      status: "returned",
    })
    .returning();
  assignmentId2 = a2.id;
  assignmentIds.push(assignmentId2);

  // A3: issued, recent date, not overdue
  const [a3] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: item1Id,
      personId: person1Id,
      ppeNameSnapshot: ITEM1_NAME,
      personNameSnapshot: PERSON1_NAME,
      quantity: 3,
      issuedAt: "2025-01-01",
      replaceBy: "2030-01-01",
      status: "issued",
    })
    .returning();
  assignmentId3 = a3.id;
  assignmentIds.push(assignmentId3);

  adminAgent = request.agent(app);
  const loginRes = await adminAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(loginRes.status).toBe(200);
});

afterAll(async () => {
  if (assignmentIds.length)
    await db.delete(ppeAssignmentsTable).where(inArray(ppeAssignmentsTable.id, assignmentIds));
  if (itemIds.length)
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  if (personIds.length)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  if (userIds.length)
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

// ── Helper: parse CSV text into rows filtered to our test data ────────────────

function parseTestCsvRows(csvText: string): string[] {
  // Strip leading UTF-8 BOM (\uFEFF) if present
  const clean = csvText.startsWith("\uFEFF") ? csvText.slice(1) : csvText;
  const lines = clean.split(/\r\n|\n/).filter(Boolean);
  // Skip header row; keep only lines that mention our TAG
  return lines.slice(1).filter((l) => l.includes(TAG));
}

function csvRowIds(lines: string[]): Set<string> {
  // Uniquely identify rows by (personName, ppeName, issuedAt) — columns 0, 1, 6
  return new Set(
    lines.map((line) => {
      const cols = splitCsvLine(line);
      return `${cols[0]}|${cols[1]}|${cols[6]}`;
    }),
  );
}

function splitCsvLine(line: string): string[] {
  // Simple CSV split (no embedded commas in our test data)
  return line.split(",");
}

// ── CSV response-header correctness ──────────────────────────────────────────

describe("CSV response headers", () => {
  it("returns Content-Type text/csv with charset=utf-8", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-type"]).toMatch(/utf-8/i);
  });

  it("returns Content-Disposition attachment with .csv filename", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] ?? "";
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.csv/);
  });

  it("includes a UTF-8 BOM so Excel opens diacritics correctly", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.text.startsWith("\uFEFF")).toBe(true);
  });
});

// ── PDF response-header correctness ──────────────────────────────────────────

describe("PDF response headers", () => {
  it("returns Content-Type application/pdf", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("returns Content-Disposition attachment with .pdf filename", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export");
    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] ?? "";
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.pdf/);
  });

  it("returns a non-empty PDF buffer", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export");
    expect(res.status).toBe(200);
    // PDF magic bytes: %PDF
    expect(res.body.toString("ascii", 0, 4)).toBe("%PDF");
  });
});

// ── Czech diacritics round-trip in CSV ───────────────────────────────────────

describe("Czech diacritics in CSV output", () => {
  it("preserves ř/š/ě/č/ů in person and PPE names", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    const lines = parseTestCsvRows(res.text);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const hasJiri = lines.some((line) => line.includes("Jiří Novák"));
    const hasSarka = lines.some((line) => line.includes("Šárka Dvořáčková"));
    const hasPrilba = lines.some((line) => line.includes("Přilba se štítem"));
    expect(hasJiri).toBe(true);
    expect(hasSarka).toBe(true);
    expect(hasPrilba).toBe(true);
  });

  it("CSV header row contains Czech column names with diacritics", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    const clean = res.text.startsWith("\uFEFF") ? res.text.slice(1) : res.text;
    const headerLine = clean.split(/\r\n|\n/)[0];
    expect(headerLine).toContain("Zaměstnanec");
    expect(headerLine).toContain("Pomůcka");
    expect(headerLine).toContain("Počet");
  });
});

// ── No-filter export ──────────────────────────────────────────────────────────

describe("no-filter export", () => {
  it("CSV includes all three test assignments", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    const lines = parseTestCsvRows(res.text);
    const ids = csvRowIds(lines);
    expect(ids.size).toBe(3);
  });
});

// ── personId filter ───────────────────────────────────────────────────────────

describe("personId filter", () => {
  it("filters to only person1's assignments (A1 + A3)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person1Id}`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r[0].includes("Jiří Novák"))).toBe(true);
  });

  it("filters to only person2's assignments (A2)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person2Id}`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toContain("Šárka Dvořáčková");
  });

  it("PDF export also respects personId filter", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/export?personId=${person2Id}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });
});

// ── status filter ─────────────────────────────────────────────────────────────

describe("status filter", () => {
  it("status=issued returns only A1 + A3 from test data", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv&status=issued");
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r[9] === "Vydáno")).toBe(true);
  });

  it("status=returned returns only A2 from test data", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv&status=returned");
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    expect(rows[0][9]).toBe("Vráceno");
  });

  it("invalid status value is ignored (returns all test rows)", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&status=not_a_real_status",
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(3);
  });
});

// ── overdue filter ────────────────────────────────────────────────────────────

describe("overdue filter", () => {
  it("overdue=true returns only A1 (issued with past replaceBy)", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv&overdue=true");
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    // A1 is the only one overdue in our test data
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toContain("Jiří Novák");
    // issuedAt column (index 6) — CSV outputs raw ISO date, not formatted
    expect(rows[0][6]).toBe("2024-01-15");
  });

  it("overdue=true excludes the returned assignment (A2) even if replaceBy were past", async () => {
    // A2 has status=returned, overdue filter requires status=issued → must be excluded
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv&overdue=true");
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    const hasReturned = rows.some((r) => r[9] === "Vráceno");
    expect(hasReturned).toBe(false);
  });

  it("overdue=true PDF export → 200 application/pdf", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?overdue=true");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });
});

// ── issuedFrom / issuedTo date-range filter ───────────────────────────────────

describe("issuedFrom / issuedTo date-range filter", () => {
  it("issuedFrom=2024-01-15&issuedTo=2024-01-15 returns only A1", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&issuedFrom=2024-01-15&issuedTo=2024-01-15",
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    // CSV outputs raw ISO date
    expect(rows[0][6]).toBe("2024-01-15");
  });

  it("issuedFrom=2025-01-01&issuedTo=2025-01-01 returns only A3", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&issuedFrom=2025-01-01&issuedTo=2025-01-01",
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    // CSV outputs raw ISO date
    expect(rows[0][6]).toBe("2025-01-01");
  });

  it("issuedFrom=2024-01-01&issuedTo=2024-12-31 returns A1 + A2", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&issuedFrom=2024-01-01&issuedTo=2024-12-31",
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(2);
  });

  it("invalid date format is ignored (no filter applied)", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&issuedFrom=not-a-date",
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text);
    // All 3 test rows present (issuedFrom ignored)
    expect(rows.length).toBe(3);
  });
});

// ── Combined filters ──────────────────────────────────────────────────────────

describe("combined filters", () => {
  it("personId + status=issued → only person1 issued (A1 + A3)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person1Id}&status=issued`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r[0].includes("Jiří Novák"))).toBe(true);
    expect(rows.every((r) => r[9] === "Vydáno")).toBe(true);
  });

  it("personId + status=returned → only person2 returned (A2)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person2Id}&status=returned`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    expect(rows[0][9]).toBe("Vráceno");
  });

  it("personId + issuedFrom+issuedTo → intersection (A1 only for person1 in 2024)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person1Id}&issuedFrom=2024-01-01&issuedTo=2024-12-31`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    // CSV outputs raw ISO date
    expect(rows[0][6]).toBe("2024-01-15");
  });

  it("personId + overdue → person1 overdue (A1 only)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person1Id}&overdue=true`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toContain("Jiří Novák");
  });

  it("status=issued + issuedFrom+issuedTo → A3 only (issued in 2025)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&status=issued&issuedFrom=2025-01-01&issuedTo=2025-12-31`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text).map(splitCsvLine);
    expect(rows.length).toBe(1);
    // CSV outputs raw ISO date
    expect(rows[0][6]).toBe("2025-01-01");
  });

  it("all four filters combined — no matching test row yields empty result for our data", async () => {
    // personId=person2 + status=issued + issuedFrom past + overdue=true
    // person2 only has a returned assignment → no match in our test data
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${person2Id}&status=issued&overdue=true`,
    );
    expect(res.status).toBe(200);
    const rows = parseTestCsvRows(res.text);
    expect(rows.length).toBe(0);
  });
});

// ── Empty result set (personId=999999999 guarantees zero matches) ────────────

// personId=999999999 is a positive integer that will never exist in the DB,
// so the filter is applied (the route gates on `personId && isFinite`) and
// returns zero data rows — exercising empty-result code paths in both generators.
const NONEXISTENT_PERSON_ID = 999999999;

describe("empty result set export", () => {
  it("CSV with zero rows → 200, text/csv content-type", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
  });

  it("CSV with zero rows → non-empty body (header row still present, no data rows)", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(0);
    const clean = res.text.startsWith("\uFEFF") ? res.text.slice(1) : res.text;
    const lines = clean.split(/\r\n|\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Zaměstnanec");
  });

  it("CSV with zero rows → attachment Content-Disposition with .csv extension", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] ?? "";
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.csv/);
  });

  it("PDF with zero rows → 200, application/pdf content-type", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("PDF with zero rows → non-empty body starting with PDF magic bytes", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.toString("ascii", 0, 4)).toBe("%PDF");
  });

  it("PDF with zero rows → attachment Content-Disposition with .pdf extension", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?personId=${NONEXISTENT_PERSON_ID}`,
    );
    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] ?? "";
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.pdf/);
  });
});

// ── Unauthenticated access ────────────────────────────────────────────────────

describe("auth guard on export endpoint", () => {
  it("unauthenticated GET /api/ppe/assignments/export → 401", async () => {
    const res = await request(app).get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(401);
  });
});
