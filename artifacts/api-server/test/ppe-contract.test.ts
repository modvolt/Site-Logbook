import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";
import app from "../src/app";

/**
 * HTTP-level contract tests for the PPE (OOPP) API.
 *
 * Covers:
 * - 401 / 403 role guards (unauthenticated → 401, guest write → 403)
 * - Admin full CRUD for items and assignments
 * - 409 guard on editing confirmed assignments
 * - 400 guard on issuing to an archived item
 * - Snapshot immutability through the API
 * - GET /api/people/stats now returns assignedPpeCount + ppeAttentionCount
 *   (also validates the /people/:id vs /people/stats route-ordering fix)
 */

const TAG = `test-ppe-${Date.now()}`;
const PASSWORD = "test-ppe-pw-123";

let adminUserId: number;
let guestUserId: number;
let personId: number;
let itemId: number;
let assignmentId: number;

let adminAgent: Agent;
let guestAgent: Agent;

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
      name: `PPE Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;
  userIds.push(adminUserId);

  const [guest] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-guest`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `PPE Guest ${TAG}`,
      role: "guest",
      isActive: true,
    })
    .returning();
  guestUserId = guest.id;
  userIds.push(guestUserId);

  const [person] = await db
    .insert(peopleTable)
    .values({ name: `Worker ${TAG}` })
    .returning();
  personId = person.id;
  personIds.push(personId);

  adminAgent = request.agent(app);
  let res = await adminAgent.post("/api/auth/login").send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(res.status).toBe(200);

  guestAgent = request.agent(app);
  res = await guestAgent.post("/api/auth/login").send({ username: `${TAG}-guest`, password: PASSWORD });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  if (assignmentIds.length > 0)
    await db.delete(ppeAssignmentsTable).where(inArray(ppeAssignmentsTable.id, assignmentIds));
  if (itemIds.length > 0)
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  if (personIds.length > 0)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  if (userIds.length > 0)
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

// ── Auth guards ──────────────────────────────────────────────────────────────

describe("auth guards", () => {
  it("unauthenticated GET /api/ppe/items → 401", async () => {
    const res = await request(app).get("/api/ppe/items");
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /api/ppe/assignments → 401", async () => {
    const res = await request(app).get("/api/ppe/assignments");
    expect(res.status).toBe(401);
  });

  it("guest POST /api/ppe/items → 403", async () => {
    const res = await guestAgent.post("/api/ppe/items").send({
      name: "Helma", category: "hlava",
    });
    expect(res.status).toBe(403);
  });

  it("guest POST /api/ppe/assignments → 403", async () => {
    const res = await guestAgent.post("/api/ppe/assignments").send({
      ppeItemId: 999, personId, quantity: 1, issuedAt: "2025-01-01",
    });
    expect(res.status).toBe(403);
  });

  it("guest GET /api/ppe/items → 200 (read allowed)", async () => {
    const res = await guestAgent.get("/api/ppe/items");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("guest GET /api/ppe/assignments → 200 (read allowed)", async () => {
    const res = await guestAgent.get("/api/ppe/assignments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── PPE item CRUD ────────────────────────────────────────────────────────────

describe("PPE item CRUD (admin)", () => {
  it("POST /api/ppe/items creates an item", async () => {
    const res = await adminAgent.post("/api/ppe/items").send({
      name: `Helma ${TAG}`,
      category: "hlava",
      defaultReplacementMonths: 12,
      defaultInspectionMonths: 6,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`Helma ${TAG}`);
    expect(res.body.category).toBe("hlava");
    expect(res.body.active).toBe(true);
    itemId = res.body.id;
    itemIds.push(itemId);
  });

  it("GET /api/ppe/items lists items (includes newly created)", async () => {
    const res = await adminAgent.get("/api/ppe/items");
    expect(res.status).toBe(200);
    expect(res.body.some((i: any) => i.id === itemId)).toBe(true);
  });

  it("PATCH /api/ppe/items/:id updates the item", async () => {
    const res = await adminAgent.patch(`/api/ppe/items/${itemId}`).send({
      name: `Helma Updated ${TAG}`,
      category: "hlava",
      active: true,
      description: "Ochranná přilba",
      defaultReplacementMonths: 24,
      defaultInspectionMonths: 12,
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Helma Updated ${TAG}`);
    expect(res.body.defaultReplacementMonths).toBe(24);
  });

  it("PATCH /api/ppe/items/:id with invalid category → 400", async () => {
    const res = await adminAgent.patch(`/api/ppe/items/${itemId}`).send({
      category: "not_a_valid_category",
    });
    expect(res.status).toBe(400);
  });

  it("guest PATCH /api/ppe/items/:id → 403", async () => {
    const res = await guestAgent.patch(`/api/ppe/items/${itemId}`).send({
      name: `Helma Updated ${TAG}`,
      category: "hlava",
      active: true,
    });
    expect(res.status).toBe(403);
  });
});

// ── Assignment CRUD ──────────────────────────────────────────────────────────

describe("PPE assignment CRUD (admin)", () => {
  const todayStr = new Date().toISOString().slice(0, 10);

  it("POST /api/ppe/assignments creates an assignment with snapshots", async () => {
    const res = await adminAgent.post("/api/ppe/assignments").send({
      ppeItemId: itemId,
      personId,
      quantity: 2,
      size: "M",
      issuedAt: todayStr,
    });
    expect(res.status).toBe(201);
    expect(res.body.ppeItemId).toBe(itemId);
    expect(res.body.personId).toBe(personId);
    expect(res.body.status).toBe("issued");
    expect(typeof res.body.ppeNameSnapshot).toBe("string");
    expect(res.body.ppeNameSnapshot.length).toBeGreaterThan(0);
    expect(typeof res.body.personNameSnapshot).toBe("string");
    expect(res.body.personNameSnapshot.length).toBeGreaterThan(0);
    assignmentId = res.body.id;
    assignmentIds.push(assignmentId);
  });

  it("POST /api/ppe/assignments fails issuing to an archived item → 400", async () => {
    const [archived] = await db
      .insert(ppeItemsTable)
      .values({ name: `Archived ${TAG}`, category: "ruky", active: false })
      .returning();
    itemIds.push(archived.id);

    const res = await adminAgent.post("/api/ppe/assignments").send({
      ppeItemId: archived.id,
      personId,
      quantity: 1,
      issuedAt: todayStr,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archiv/i);
  });

  it("GET /api/ppe/assignments lists assignments", async () => {
    const res = await adminAgent.get("/api/ppe/assignments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((a: any) => a.id === assignmentId)).toBe(true);
  });

  it("GET /api/ppe/assignments?personId= filters by person", async () => {
    const res = await adminAgent.get(`/api/ppe/assignments?personId=${personId}`);
    expect(res.status).toBe(200);
    expect(res.body.every((a: any) => a.personId === personId)).toBe(true);
    expect(res.body.some((a: any) => a.id === assignmentId)).toBe(true);
  });

  it("GET /api/ppe/assignments?status=issued filters by status", async () => {
    const res = await adminAgent.get("/api/ppe/assignments?status=issued");
    expect(res.status).toBe(200);
    expect(res.body.every((a: any) => a.status === "issued")).toBe(true);
  });

  it("PATCH /api/ppe/assignments/:id returns an assignment", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${assignmentId}`).send({
      status: "returned",
      returnedAt: todayStr,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("returned");
    expect(res.body.returnedAt).toBe(todayStr);
  });

  it("guest PATCH /api/ppe/assignments/:id → 403", async () => {
    const res = await guestAgent.patch(`/api/ppe/assignments/${assignmentId}`).send({
      status: "returned",
    });
    expect(res.status).toBe(403);
  });
});

// ── Confirmed assignment 409 guard ───────────────────────────────────────────

describe("confirmed assignment edit guard", () => {
  let confirmedAssignmentId: number;

  beforeAll(async () => {
    const [confirmedItem] = await db
      .insert(ppeItemsTable)
      .values({ name: `ConfirmedItem ${TAG}`, category: "telo", active: true })
      .returning();
    itemIds.push(confirmedItem.id);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: confirmedItem.id,
        personId,
        ppeNameSnapshot: confirmedItem.name,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        employeeConfirmedAt: new Date(),
      })
      .returning();
    confirmedAssignmentId = assignment.id;
    assignmentIds.push(confirmedAssignmentId);
  });

  it("PATCH on confirmed assignment with non-status field → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      quantity: 99,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it("PATCH on confirmed assignment with replaceBy → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      replaceBy: "2030-01-01",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH on confirmed assignment with nextInspectionAt → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      nextInspectionAt: "2030-06-01",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH on confirmed assignment with size → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      size: "XL",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH on confirmed assignment with serialNumber → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      serialNumber: "SN-9999",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH on confirmed assignment with notes → 409", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      notes: "pokus o přepsání",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH on confirmed assignment with empty body → 200 (no-op, not rejected)", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.employeeConfirmedAt).not.toBeNull();
  });

  it("employeeConfirmedAt remains set after empty-body PATCH (immutable)", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.employeeConfirmedAt).toBeDefined();
    expect(res.body.employeeConfirmedAt).not.toBeNull();
  });

  it("PATCH on confirmed assignment with status/returnedAt fields → 200", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      status: "returned",
      returnedAt: new Date().toISOString().slice(0, 10),
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("returned");
  });

  it("employeeConfirmedAt remains set after status-change PATCH (immutable via update path)", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      status: "returned",
    });
    expect(res.status).toBe(200);
    expect(res.body.employeeConfirmedAt).not.toBeNull();
  });

  it("confirmToken is never exposed in PATCH response", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmedAssignmentId}`).send({
      status: "returned",
    });
    expect(res.status).toBe(200);
    expect(res.body.confirmToken).toBeUndefined();
  });
});

// ── Confirm token flow (POST /ppe/confirm, GET /ppe/confirm) ─────────────────

describe("employee confirmation signature flow", () => {
  let confirmItemId: number;
  let confirmAssignmentId: number;
  let confirmToken: string;

  beforeAll(async () => {
    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `ConfirmFlowItem ${TAG}`, category: "telo", active: true })
      .returning();
    confirmItemId = item.id;
    itemIds.push(confirmItemId);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: confirmItemId,
        personId,
        ppeNameSnapshot: item.name,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
      })
      .returning();
    confirmAssignmentId = assignment.id;
    assignmentIds.push(confirmAssignmentId);
  });

  it("POST /api/ppe/assignments/:id/request-confirm → 200 with confirmUrl and token", async () => {
    const res = await adminAgent.post(`/api/ppe/assignments/${confirmAssignmentId}/request-confirm`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(typeof res.body.confirmUrl).toBe("string");
    expect(res.body.confirmUrl).toContain(res.body.token);
    confirmToken = res.body.token;
  });

  it("GET /api/ppe/confirm?token= returns assignment info without confirmToken field", async () => {
    const res = await adminAgent.get(`/api/ppe/confirm?token=${confirmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(confirmAssignmentId);
    expect(res.body.employeeConfirmedAt).toBeNull();
    expect(res.body.confirmToken).toBeUndefined();
  });

  it("GET /api/ppe/confirm with invalid token → 404", async () => {
    const res = await adminAgent.get("/api/ppe/confirm?token=definitely-not-a-real-token-xyz");
    expect(res.status).toBe(404);
  });

  it("GET /api/ppe/confirm with missing token → 400", async () => {
    const res = await adminAgent.get("/api/ppe/confirm");
    expect(res.status).toBe(400);
  });

  it("POST /api/ppe/confirm with valid token → 200, sets employeeConfirmedAt", async () => {
    const res = await request(app).post("/api/ppe/confirm").send({ token: confirmToken });
    expect(res.status).toBe(200);
    expect(res.body.already).toBe(false);
    expect(res.body.assignment.employeeConfirmedAt).not.toBeNull();
    expect(res.body.assignment.id).toBe(confirmAssignmentId);
    expect(res.body.assignment.confirmToken).toBeUndefined();
  });

  it("POST /api/ppe/confirm again with same token → 200 with already:true (idempotent)", async () => {
    const res = await request(app).post("/api/ppe/confirm").send({ token: confirmToken });
    expect(res.status).toBe(200);
    expect(res.body.already).toBe(true);
    expect(res.body.assignment.employeeConfirmedAt).not.toBeNull();
  });

  it("POST /api/ppe/confirm with missing token → 400", async () => {
    const res = await request(app).post("/api/ppe/confirm").send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/ppe/confirm with invalid token → 404", async () => {
    const res = await request(app).post("/api/ppe/confirm").send({ token: "bad-token-xyz" });
    expect(res.status).toBe(404);
  });

  it("POST /api/ppe/assignments/:id/request-confirm on already-confirmed → 409", async () => {
    const res = await adminAgent.post(`/api/ppe/assignments/${confirmAssignmentId}/request-confirm`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/potvrzen/i);
  });

  it("after confirmation, PATCH with non-status field → 409 (guard still active)", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmAssignmentId}`).send({
      notes: "pokus po potvrzení",
    });
    expect(res.status).toBe(409);
  });

  it("after confirmation, employeeConfirmedAt cannot be cleared by PATCH (field silently stripped)", async () => {
    const res = await adminAgent.patch(`/api/ppe/assignments/${confirmAssignmentId}`).send({
      status: "returned",
    });
    expect(res.status).toBe(200);
    expect(res.body.employeeConfirmedAt).not.toBeNull();
  });

  it("DELETE /api/ppe/assignments/:id on confirmed assignment → 409", async () => {
    const res = await adminAgent.delete(`/api/ppe/assignments/${confirmAssignmentId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Podepsaný výdej nelze smazat/);
  });
});

// ── request-confirm guards ────────────────────────────────────────────────────

describe("request-confirm guards", () => {
  let returnedAssignmentId: number;

  beforeAll(async () => {
    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `ReqConfirmGuardItem ${TAG}`, category: "telo", active: true })
      .returning();
    itemIds.push(item.id);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: item.id,
        personId,
        ppeNameSnapshot: item.name,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "returned",
        returnedAt: todayStr,
      })
      .returning();
    returnedAssignmentId = assignment.id;
    assignmentIds.push(returnedAssignmentId);
  });

  it("POST request-confirm on returned assignment → 409", async () => {
    const res = await adminAgent.post(`/api/ppe/assignments/${returnedAssignmentId}/request-confirm`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/aktivní/i);
  });

  it("POST request-confirm on non-existent assignment → 404", async () => {
    const res = await adminAgent.post("/api/ppe/assignments/9999999/request-confirm");
    expect(res.status).toBe(404);
  });

  it("guest POST request-confirm → 403", async () => {
    const res = await guestAgent.post(`/api/ppe/assignments/${returnedAssignmentId}/request-confirm`);
    expect(res.status).toBe(403);
  });

  it("POST request-confirm is idempotent (same token returned on repeat call for issued assignment)", async () => {
    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `IdempotentConfirm ${TAG}`, category: "telo", active: true })
      .returning();
    itemIds.push(item.id);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: item.id,
        personId,
        ppeNameSnapshot: item.name,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
      })
      .returning();
    assignmentIds.push(assignment.id);

    const first = await adminAgent.post(`/api/ppe/assignments/${assignment.id}/request-confirm`);
    expect(first.status).toBe(200);
    const second = await adminAgent.post(`/api/ppe/assignments/${assignment.id}/request-confirm`);
    expect(second.status).toBe(200);
    expect(second.body.token).toBe(first.body.token);
  });
});

// ── Archive / reactivate ─────────────────────────────────────────────────────

describe("item archive / reactivate", () => {
  let archiveItemId: number;

  beforeAll(async () => {
    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `ToArchive ${TAG}`, category: "nohy", active: true })
      .returning();
    archiveItemId = item.id;
    itemIds.push(archiveItemId);
  });

  it("DELETE /api/ppe/items/:id archives the item (active=false)", async () => {
    const res = await adminAgent.delete(`/api/ppe/items/${archiveItemId}`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("GET /api/ppe/items does not include archived items by default", async () => {
    const res = await adminAgent.get("/api/ppe/items");
    expect(res.status).toBe(200);
    const found = res.body.find((i: any) => i.id === archiveItemId);
    expect(found).toBeUndefined();
  });

  it("GET /api/ppe/items?includeArchived=true includes archived items", async () => {
    const res = await adminAgent.get("/api/ppe/items?includeArchived=true");
    expect(res.status).toBe(200);
    expect(res.body.some((i: any) => i.id === archiveItemId)).toBe(true);
  });

  it("guest DELETE /api/ppe/items/:id → 403", async () => {
    const [secondItem] = await db
      .insert(ppeItemsTable)
      .values({ name: `ArchiveGuard ${TAG}`, category: "nohy", active: true })
      .returning();
    itemIds.push(secondItem.id);
    const res = await guestAgent.delete(`/api/ppe/items/${secondItem.id}`);
    expect(res.status).toBe(403);
  });
});

// ── Snapshot immutability ────────────────────────────────────────────────────

describe("snapshot immutability", () => {
  let snapItemId: number;
  let snapAssignmentId: number;

  beforeAll(async () => {
    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `SnapItem ${TAG}`, category: "oci", active: true })
      .returning();
    snapItemId = item.id;
    itemIds.push(snapItemId);

    const todayStr = new Date().toISOString().slice(0, 10);
    const res = await adminAgent.post("/api/ppe/assignments").send({
      ppeItemId: snapItemId,
      personId,
      quantity: 1,
      issuedAt: todayStr,
    });
    expect(res.status).toBe(201);
    snapAssignmentId = res.body.id;
    assignmentIds.push(snapAssignmentId);
  });

  it("renaming the PPE item does not change the assignment snapshot via API", async () => {
    const originalSnap = (await adminAgent.get("/api/ppe/assignments")).body.find(
      (a: any) => a.id === snapAssignmentId,
    ).ppeNameSnapshot;

    await db
      .update(ppeItemsTable)
      .set({ name: `SnapItem RENAMED ${TAG}` })
      .where(eq(ppeItemsTable.id, snapItemId));

    const res = await adminAgent.get("/api/ppe/assignments");
    const assignment = res.body.find((a: any) => a.id === snapAssignmentId);
    expect(assignment.ppeNameSnapshot).toBe(originalSnap);

    await db
      .update(ppeItemsTable)
      .set({ name: `SnapItem ${TAG}` })
      .where(eq(ppeItemsTable.id, snapItemId));
  });
});

// ── CSV/PDF export ────────────────────────────────────────────────────────────

describe("GET /api/ppe/assignments/export", () => {
  let exportItem1Id: number;
  let exportItem2Id: number;
  let exportItem3Id: number;
  let exportPerson2Id: number;

  const PERSON1_NAME_SNAP = `ExportWorkerA ${TAG}`;
  const PERSON2_NAME_SNAP = `ExportWorkerB ${TAG}`;
  const ITEM_ISSUED_NAME = `ExportHelmaIssued ${TAG}`;
  const ITEM_RETURNED_NAME = `ExportHelmaReturned ${TAG}`;
  const ITEM_OVERDUE_NAME = `ExportHelmaOverdue ${TAG}`;

  beforeAll(async () => {
    const todayStr = new Date().toISOString().slice(0, 10);

    const [person2] = await db
      .insert(peopleTable)
      .values({ name: PERSON2_NAME_SNAP })
      .returning();
    exportPerson2Id = person2.id;
    personIds.push(exportPerson2Id);

    const [item1] = await db
      .insert(ppeItemsTable)
      .values({ name: ITEM_ISSUED_NAME, category: "hlava", active: true })
      .returning();
    exportItem1Id = item1.id;
    itemIds.push(exportItem1Id);

    const [item2] = await db
      .insert(ppeItemsTable)
      .values({ name: ITEM_RETURNED_NAME, category: "hlava", active: true })
      .returning();
    exportItem2Id = item2.id;
    itemIds.push(exportItem2Id);

    const [item3] = await db
      .insert(ppeItemsTable)
      .values({ name: ITEM_OVERDUE_NAME, category: "hlava", active: true })
      .returning();
    exportItem3Id = item3.id;
    itemIds.push(exportItem3Id);

    // Assignment for person1 (the shared personId) with status=issued
    const [a1] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: exportItem1Id,
        personId,
        ppeNameSnapshot: ITEM_ISSUED_NAME,
        personNameSnapshot: PERSON1_NAME_SNAP,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
      })
      .returning();
    assignmentIds.push(a1.id);

    // Assignment for person2 with status=returned
    const [a2] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: exportItem2Id,
        personId: exportPerson2Id,
        ppeNameSnapshot: ITEM_RETURNED_NAME,
        personNameSnapshot: PERSON2_NAME_SNAP,
        quantity: 1,
        issuedAt: todayStr,
        returnedAt: todayStr,
        status: "returned",
      })
      .returning();
    assignmentIds.push(a2.id);

    // Overdue assignment: status=issued, replaceBy in the past
    const [a3] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: exportItem3Id,
        personId,
        ppeNameSnapshot: ITEM_OVERDUE_NAME,
        personNameSnapshot: PERSON1_NAME_SNAP,
        quantity: 1,
        issuedAt: "2022-01-01",
        replaceBy: "2022-06-01",
        status: "issued",
      })
      .returning();
    assignmentIds.push(a3.id);
  });

  it("GET /api/ppe/assignments/export?format=csv → 200 with text/csv content-type", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/i);
  });

  it("unauthenticated GET /api/ppe/assignments/export → 401", async () => {
    const res = await request(app).get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(401);
  });

  it("CSV export includes all assignments when no filter is applied", async () => {
    const res = await adminAgent.get("/api/ppe/assignments/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.text).toContain(ITEM_ISSUED_NAME);
    expect(res.text).toContain(ITEM_RETURNED_NAME);
  });

  it("personId filter: export only returns rows for the given person", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${exportPerson2Id}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(PERSON2_NAME_SNAP);
    expect(res.text).not.toContain(ITEM_ISSUED_NAME);
  });

  it("status filter: export with status=issued excludes returned assignments", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&status=issued",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(ITEM_ISSUED_NAME);
    expect(res.text).not.toContain(ITEM_RETURNED_NAME);
  });

  it("status filter: export with status=returned excludes issued assignments", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&status=returned",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(ITEM_RETURNED_NAME);
    expect(res.text).not.toContain(ITEM_ISSUED_NAME);
  });

  it("overdue filter: returns only assignments with replaceBy/nextInspectionAt in the past (status=issued)", async () => {
    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&overdue=true",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(ITEM_OVERDUE_NAME);
    // issued assignment without overdue dates should not appear
    expect(res.text).not.toContain(ITEM_ISSUED_NAME);
    // returned assignment should not appear (overdue filter requires status=issued)
    expect(res.text).not.toContain(ITEM_RETURNED_NAME);
  });

  it("overdue filter: returned assignments with past replaceBy are excluded", async () => {
    const [overdueReturnedItem] = await db
      .insert(ppeItemsTable)
      .values({ name: `OverdueReturnedItem ${TAG}`, category: "ruky", active: true })
      .returning();
    itemIds.push(overdueReturnedItem.id);

    const [overdueReturned] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: overdueReturnedItem.id,
        personId,
        ppeNameSnapshot: overdueReturnedItem.name,
        personNameSnapshot: PERSON1_NAME_SNAP,
        quantity: 1,
        issuedAt: "2021-01-01",
        returnedAt: "2021-06-01",
        replaceBy: "2021-03-01",
        status: "returned",
      })
      .returning();
    assignmentIds.push(overdueReturned.id);

    const res = await adminAgent.get(
      "/api/ppe/assignments/export?format=csv&overdue=true",
    );
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(overdueReturnedItem.name);
  });

  it("personId + status combined filter: only that person's issued assignments", async () => {
    const res = await adminAgent.get(
      `/api/ppe/assignments/export?format=csv&personId=${personId}&status=issued`,
    );
    expect(res.status).toBe(200);
    // person1 has issued assignments
    expect(res.text).toContain(PERSON1_NAME_SNAP);
    // person2's returned assignment should not appear
    expect(res.text).not.toContain(PERSON2_NAME_SNAP);
  });
});

// ── /api/people/stats includes PPE counts ────────────────────────────────────

describe("GET /api/people/stats includes PPE fields", () => {
  it("returns 200 with assignedPpeCount and ppeAttentionCount fields (routing fix)", async () => {
    const res = await adminAgent.get("/api/people/stats");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect("assignedPpeCount" in res.body[0]).toBe(true);
      expect("ppeAttentionCount" in res.body[0]).toBe(true);
      expect(typeof res.body[0].assignedPpeCount).toBe("number");
      expect(typeof res.body[0].ppeAttentionCount).toBe("number");
    }
  });

  it("the /people/stats path is not shadowed by /people/:id (returns stats, not 400)", async () => {
    const res = await adminAgent.get("/api/people/stats");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
