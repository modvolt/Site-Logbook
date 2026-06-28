import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, count, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  usersTable,
  ppeItemsTable,
  ppeAssignmentsTable,
  ppeHandoverDocumentsTable,
  peopleTable,
} from "@workspace/db";
import app from "../src/app";
import { ObjectStorageService } from "../src/lib/objectStorage";

/**
 * Concurrent PPE handover signing — double-sign race guard.
 *
 * The sign handler (`POST /api/ppe/assignments/:id/sign`) must ensure that
 * even when two requests race simultaneously — e.g. two admin tabs or two
 * devices — exactly one succeeds (201) and the other is rejected (409).
 *
 * The guard is implemented via two complementary mechanisms:
 *  1. A `FOR UPDATE` row lock on the assignment inside the transaction,
 *     which serialises concurrent sign attempts and lets the second re-check
 *     `employeeConfirmedAt` on the locked, committed row.
 *  2. A UNIQUE constraint on `ppe_handover_documents.assignment_id`, which
 *     catches any residual race that sneaks past the re-check (e.g. a very
 *     tight window where both requests pass the pre-transaction check).
 *
 * These tests fire the sign requests concurrently with Promise.allSettled
 * and assert the invariants that must hold regardless of which request wins.
 *
 * Object storage (PNG/PDF upload) is mocked so tests run without S3/GCS.
 * The vitest `.ttf` plugin (vitest.config.ts) handles font loading for the
 * PDF generation that still runs synchronously inside the handler.
 */

const TAG = `test-ppe-sign-concurrent-${Date.now()}`;
const PASSWORD = "test-ppe-sign-pw-123";

const SAMPLE_SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SIGN_BODY = {
  signatureDataUrl: SAMPLE_SIGNATURE_PNG,
  signatoryName: `Správce ${TAG}`,
  confirmationAccepted: true as const,
};

let adminUserId: number;
let personId: number;
let itemId: number;

let adminAgent: Agent;

const userIds: number[] = [];
const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

beforeAll(async () => {
  // Mock object storage so PNG/PDF uploads never hit real S3 or GCS.
  vi.spyOn(ObjectStorageService.prototype, "putPrivateObject").mockResolvedValue(
    undefined as unknown as void,
  );
  vi.spyOn(ObjectStorageService.prototype, "deletePrivateObject").mockResolvedValue(
    undefined as unknown as void,
  );

  const [admin] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `SignTest Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;
  userIds.push(adminUserId);

  const [person] = await db
    .insert(peopleTable)
    .values({ name: `Pracovník ${TAG}` })
    .returning();
  personId = person.id;
  personIds.push(personId);

  const [item] = await db
    .insert(ppeItemsTable)
    .values({ name: `Helma ${TAG}`, category: "hlava", active: true })
    .returning();
  itemId = item.id;
  itemIds.push(itemId);

  adminAgent = request.agent(app);
  const login = await adminAgent
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  vi.restoreAllMocks();

  if (assignmentIds.length > 0) {
    await db
      .delete(ppeAssignmentsTable)
      .where(inArray(ppeAssignmentsTable.id, assignmentIds));
  }
  if (itemIds.length > 0) {
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  }
  if (personIds.length > 0) {
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  }
  if (userIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
});

async function makeIssuedAssignment(): Promise<number> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [assignment] = await db
    .insert(ppeAssignmentsTable)
    .values({
      ppeItemId: itemId,
      personId,
      ppeNameSnapshot: `Helma ${TAG}`,
      personNameSnapshot: `Pracovník ${TAG}`,
      quantity: 1,
      issuedAt: todayStr,
      status: "issued",
    })
    .returning();
  assignmentIds.push(assignment.id);
  return assignment.id;
}

async function countHandoverDocs(assignmentId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ppeHandoverDocumentsTable)
    .where(eq(ppeHandoverDocumentsTable.assignmentId, assignmentId));
  return Number(row.n);
}

// ── Core concurrent race ──────────────────────────────────────────────────────

describe("concurrent PPE handover signing — double-sign race guard", () => {
  it("two simultaneous sign requests: exactly one 201 and one 409", async () => {
    const assignmentId = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("the 409 body contains a Czech error message", async () => {
    const assignmentId = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
    ]);

    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.status).toBe(409);
    expect(typeof loser.body.error).toBe("string");
    expect(loser.body.error.length).toBeGreaterThan(0);
    // The Czech error message must mention that the assignment was already signed.
    expect(loser.body.error).toMatch(/podepsán|existuje/i);
  });

  it("ppe_handover_documents ends up with exactly one row for the assignment", async () => {
    const assignmentId = await makeIssuedAssignment();

    await Promise.all([
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
    ]);

    const docCount = await countHandoverDocs(assignmentId);
    expect(docCount).toBe(1);
  });

  it("three simultaneous requests: still exactly one handover document row", async () => {
    const assignmentId = await makeIssuedAssignment();

    const results = await Promise.all([
      adminAgent
        .post(`/api/ppe/assignments/${assignmentId}/sign`)
        .send(SIGN_BODY)
        .then((r) => r.status),
      adminAgent
        .post(`/api/ppe/assignments/${assignmentId}/sign`)
        .send(SIGN_BODY)
        .then((r) => r.status),
      adminAgent
        .post(`/api/ppe/assignments/${assignmentId}/sign`)
        .send(SIGN_BODY)
        .then((r) => r.status),
    ]);

    const successes = results.filter((s) => s === 201);
    const conflicts = results.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(2);

    expect(await countHandoverDocs(assignmentId)).toBe(1);
  });

  it("201 response has documentNumber in OOPP-YYYY-NNNNNN format", async () => {
    const assignmentId = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
    ]);

    const winner = r1.status === 201 ? r1 : r2;
    expect(winner.status).toBe(201);
    expect(winner.body.documentNumber).toMatch(/^OOPP-\d{4}-\d{6}$/);
  });

  it("assignment.employeeConfirmedAt is set after the race", async () => {
    const assignmentId = await makeIssuedAssignment();

    await Promise.all([
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
      adminAgent.post(`/api/ppe/assignments/${assignmentId}/sign`).send(SIGN_BODY),
    ]);

    const [assignment] = await db
      .select({ employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, assignmentId));

    expect(assignment.employeeConfirmedAt).not.toBeNull();
  });
});

// ── Sequential guard (already-signed check) ───────────────────────────────────

describe("sequential sign guard — second sign after first succeeds", () => {
  it("second sign request after the first committed → 409", async () => {
    const assignmentId = await makeIssuedAssignment();

    const first = await adminAgent
      .post(`/api/ppe/assignments/${assignmentId}/sign`)
      .send(SIGN_BODY);
    expect(first.status).toBe(201);

    const second = await adminAgent
      .post(`/api/ppe/assignments/${assignmentId}/sign`)
      .send(SIGN_BODY);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/podepsán|existuje/i);
  });

  it("second sign 409 does not create an extra handover document row", async () => {
    const assignmentId = await makeIssuedAssignment();

    await adminAgent
      .post(`/api/ppe/assignments/${assignmentId}/sign`)
      .send(SIGN_BODY);
    await adminAgent
      .post(`/api/ppe/assignments/${assignmentId}/sign`)
      .send(SIGN_BODY);

    expect(await countHandoverDocs(assignmentId)).toBe(1);
  });
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe("sign endpoint auth guards", () => {
  it("unauthenticated request → 401", async () => {
    const assignmentId = await makeIssuedAssignment();
    const res = await request(app)
      .post(`/api/ppe/assignments/${assignmentId}/sign`)
      .send(SIGN_BODY);
    expect(res.status).toBe(401);
  });
});
