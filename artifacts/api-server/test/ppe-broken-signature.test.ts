import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";

/**
 * Tests that a broken or missing signature object in object storage never
 * crashes the PDF export and that the admin signature endpoint returns 404
 * (not 500) when the stored path is unreachable.
 *
 * ObjectStorageService is mocked so these tests run without real storage.
 * Every call to getPrivateObjectBuffer / servePrivateObject throws, simulating
 * a corrupt or missing object-storage entry.
 */

const STORAGE_ERROR = new Error("NoSuchKey: object not found");

vi.mock("../src/lib/objectStorage", () => {
  class MockObjectStorageService {
    async getPrivateObjectBuffer(_path: string): Promise<Buffer> {
      throw STORAGE_ERROR;
    }
    async servePrivateObject(_path: string, _res: unknown): Promise<void> {
      throw STORAGE_ERROR;
    }
    async putPrivateObject(): Promise<void> {}
    async deletePrivateObject(): Promise<void> {}
    async getPrivateObjectUrl(): Promise<string> {
      return "";
    }
    isConfigured(): boolean {
      return true;
    }
  }
  return { ObjectStorageService: MockObjectStorageService };
});

const { default: app } = await import("../src/app");

const TAG = `test-ppe-brokensig-${Date.now()}`;
const PASSWORD = "broken-sig-pw-test";

const PERSON_NAME = `Tomáš Kratochvíl ${TAG}`;
const ITEM_NAME = `Ochranné brýle ${TAG}`;

const FAKE_SIG_PATH = `/objects/ppe-signatures/99999-fake-${TAG}.png`;

let adminAgent: Agent;

let adminUserId: number;
let personId: number;
let itemId: number;
let assignmentWithSigId: number;
let assignmentWithoutSigId: number;

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
      name: `Broken Sig Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;
  userIds.push(adminUserId);

  const [person] = await db.insert(peopleTable).values({ name: PERSON_NAME }).returning();
  personId = person.id;
  personIds.push(personId);

  const [item] = await db
    .insert(ppeItemsTable)
    .values({ name: ITEM_NAME, category: "oci", active: true })
    .returning();
  itemId = item.id;
  itemIds.push(itemId);

  // Assignment that has a signatureObjectPath pointing to a non-existent object
  const [aWithSig] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: itemId,
      personId: personId,
      ppeNameSnapshot: ITEM_NAME,
      personNameSnapshot: PERSON_NAME,
      quantity: 1,
      issuedAt: "2025-03-01",
      status: "issued",
      signatureObjectPath: FAKE_SIG_PATH,
      employeeConfirmedAt: new Date("2025-03-01T10:00:00Z"),
    })
    .returning();
  assignmentWithSigId = aWithSig.id;
  assignmentIds.push(assignmentWithSigId);

  // Assignment with no signature at all
  const [aNoSig] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: itemId,
      personId: personId,
      ppeNameSnapshot: ITEM_NAME,
      personNameSnapshot: PERSON_NAME,
      quantity: 2,
      issuedAt: "2025-04-01",
      status: "issued",
    })
    .returning();
  assignmentWithoutSigId = aNoSig.id;
  assignmentIds.push(assignmentWithoutSigId);

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

// ── PDF export resilience ──────────────────────────────────────────────────────

describe("PDF export with broken/missing signature object", () => {
  it("returns 200 (not 500) even when storage throws for every signature fetch", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/export?personId=${personId}`);
    expect(res.status).toBe(200);
  });

  it("returns application/pdf content-type", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/export?personId=${personId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("returns a non-empty buffer starting with PDF magic bytes", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/export?personId=${personId}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.toString("ascii", 0, 4)).toBe("%PDF");
  });

  it("includes Content-Disposition attachment with .pdf filename", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/export?personId=${personId}`);
    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"] ?? "";
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/\.pdf/);
  });
});

// ── Admin signature endpoint: 404 on missing object ───────────────────────────

describe("GET /api/ppe/assignments/:id/signature — missing object returns 404", () => {
  it("returns 404 (not 500) when signatureObjectPath is set but storage throws", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/${assignmentWithSigId}/signature`);
    expect(res.status).toBe(404);
  });

  it("response body contains an error field (not a crash or empty body)", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/${assignmentWithSigId}/signature`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when assignment has no signatureObjectPath at all", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments/${assignmentWithoutSigId}/signature`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when assignment id does not exist", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/999999999/signature");
    expect(res.status).toBe(404);
  });
});
