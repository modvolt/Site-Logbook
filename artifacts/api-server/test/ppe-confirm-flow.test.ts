import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import request from "supertest";
import { db, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";
import app from "../src/app";

/**
 * Contract tests for the public PPE sign-off flow.
 *
 * These endpoints require NO session — they are in PUBLIC_PREFIXES and are
 * intended to be opened by employees via a one-time link.
 *
 * Covers:
 * - GET /api/ppe/sign/:token with missing/invalid token → 400 / 404
 * - GET /api/ppe/sign/:token with a valid UUID token → 200 with assignment details
 * - GET /api/ppe/sign/:token when already signed → 200 with alreadySigned:true
 * - POST /api/ppe/sign/:token with invalid token → 400 / 404
 * - POST /api/ppe/sign/:token when already signed → 409
 * - POST /api/ppe/sign/:token with valid token + PNG → sets employeeConfirmedAt
 * - Re-submitting with the same token → 409 (idempotent guard)
 */

const TAG = `ppe-sign-${Date.now()}`;

let personId: number;
let itemId: number;

const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

/** Minimal 1×1 white PNG as a base64 data URL (valid per the signatureDataUrl schema). */
const MINIMAL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ" +
  "AABjkB6QAAAABJRU5ErkJggg==";

beforeAll(async () => {
  const [person] = await db
    .insert(peopleTable)
    .values({ name: `Worker ${TAG}` })
    .returning();
  personId = person.id;
  personIds.push(personId);

  const [item] = await db
    .insert(ppeItemsTable)
    .values({ name: `Helma ${TAG}`, category: "hlava", active: true })
    .returning();
  itemId = item.id;
  itemIds.push(itemId);
});

afterAll(async () => {
  if (assignmentIds.length > 0)
    await db.delete(ppeAssignmentsTable).where(inArray(ppeAssignmentsTable.id, assignmentIds));
  if (itemIds.length > 0)
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  if (personIds.length > 0)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
});

// ── GET /api/ppe/sign/:token ──────────────────────────────────────────────────

describe("GET /api/ppe/sign/:token", () => {
  it("token that fails UUID pattern validation → 400", async () => {
    const res = await request(app).get("/api/ppe/sign/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("unknown UUID token → 404", async () => {
    const res = await request(app).get(`/api/ppe/sign/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it("valid UUID token → 200 with assignment details (no session required)", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);

    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
      })
      .returning();
    assignmentIds.push(assignment.id);

    const res = await request(app).get(`/api/ppe/sign/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(assignment.id);
    expect(res.body.ppeNameSnapshot).toBe(`Helma ${TAG}`);
    expect(res.body.personNameSnapshot).toBe(`Worker ${TAG}`);
    expect(res.body.quantity).toBe(1);
    expect(res.body.alreadySigned).toBe(false);
    expect(res.body.employeeConfirmedAt).toBeNull();
    expect(res.body.signatureToken).toBeUndefined();
  });

  it("valid token for already-signed assignment → 200 with alreadySigned:true", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);

    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
        employeeConfirmedAt: new Date(),
      })
      .returning();
    assignmentIds.push(assignment.id);

    const res = await request(app).get(`/api/ppe/sign/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.alreadySigned).toBe(true);
    expect(res.body.employeeConfirmedAt).not.toBeNull();
  });
});

// ── POST /api/ppe/sign/:token ─────────────────────────────────────────────────

describe("POST /api/ppe/sign/:token", () => {
  it("token that fails UUID pattern validation → 400", async () => {
    const res = await request(app)
      .post("/api/ppe/sign/not-a-uuid")
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(400);
  });

  it("missing or invalid signatureDataUrl body → 400", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);
    const [a] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
      })
      .returning();
    assignmentIds.push(a.id);

    const noBody = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({})
      .set("Content-Type", "application/json");
    expect(noBody.status).toBe(400);

    const wrongType = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: "not-a-png-data-url" })
      .set("Content-Type", "application/json");
    expect(wrongType.status).toBe(400);
  });

  it("unknown UUID token → 404", async () => {
    const res = await request(app)
      .post(`/api/ppe/sign/${randomUUID()}`)
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(404);
  });

  it("already-signed assignment → 409 (idempotency guard)", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);
    const [a] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
        employeeConfirmedAt: new Date(),
      })
      .returning();
    assignmentIds.push(a.id);

    const res = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it("valid token + PNG → sets employeeConfirmedAt (no session required)", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);
    const [a] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
      })
      .returning();
    assignmentIds.push(a.id);

    const res = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.employeeConfirmedAt).not.toBeNull();
    expect(typeof res.body.employeeConfirmedAt).toBe("string");
    expect(res.body.personNameSnapshot).toBe(`Worker ${TAG}`);
    expect(res.body.ppeNameSnapshot).toBe(`Helma ${TAG}`);

    // GET after sign → alreadySigned:true
    const getRes = await request(app).get(`/api/ppe/sign/${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.alreadySigned).toBe(true);
    expect(getRes.body.employeeConfirmedAt).not.toBeNull();
  });

  it("submitting a second time with same token → 409 (prevents duplicate signs)", async () => {
    const token = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);
    const [a] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: itemId,
        personId,
        ppeNameSnapshot: `Helma ${TAG}`,
        personNameSnapshot: `Worker ${TAG}`,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
        signatureToken: token,
      })
      .returning();
    assignmentIds.push(a.id);

    const first = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG_DATA_URL })
      .set("Content-Type", "application/json");
    expect(second.status).toBe(409);
    expect(second.body.error).toBeDefined();
  });
});
