import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { db, ppeItemsTable, ppeAssignmentsTable, peopleTable, usersTable } from "@workspace/db";
import app from "../src/app";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { issuePpePublicEvidenceToken } from "../src/lib/ppe-public-evidence";

/**
 * Contract tests for the public PPE sign-off flow.
 *
 * These endpoints require NO session — they are in PUBLIC_PREFIXES and are
 * intended to be opened by employees via a one-time link.
 *
 * Covers:
 * - GET /api/ppe/sign/:token with missing/invalid token → 400 / 404
 * - GET /api/ppe/sign/:token with a valid UUID token → 200 with assignment details
 * - GET /api/ppe/sign/:token after signing rejects replay
 * - POST /api/ppe/sign/:token with invalid token → 400 / 404
 * - POST /api/ppe/sign/:token when already signed → 409
 * - POST /api/ppe/sign/:token with valid token + PNG → sets employeeConfirmedAt
 * - Re-submitting with the same token → 409 (idempotent guard)
 */

const TAG = `ppe-sign-${Date.now()}`;

let personId: number;
let itemId: number;
let issuerId: number;

const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

/** Minimal 1×1 white PNG as a base64 data URL (valid per the signatureDataUrl schema). */
const MINIMAL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeAll(async () => {
  vi.spyOn(ObjectStorageService.prototype, "putPrivateObject").mockResolvedValue(undefined);
  vi.spyOn(ObjectStorageService.prototype, "deletePrivateObject").mockResolvedValue(undefined);

  const [issuer] = await db.insert(usersTable).values({
    username: `${TAG}-issuer`,
    passwordHash: "not-used",
    name: `Issuer ${TAG}`,
    role: "admin",
    isActive: true,
  }).returning();
  issuerId = issuer!.id;

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
  vi.restoreAllMocks();
});

async function issueSignatureToken(assignmentId: number): Promise<string> {
  const { token } = await issuePpePublicEvidenceToken({
    assignmentId,
    purpose: "ppe_signature",
    expiresAt: new Date(Date.now() + 10 * 60_000),
    createdByUserId: issuerId,
  });
  return token;
}

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
    let token = randomUUID();
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
    token = await issueSignatureToken(assignment.id);

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

  it("valid legacy token for already-signed assignment is treated as consumed", async () => {
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
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("public_token_consumed");
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
    let token = randomUUID();
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
    token = await issueSignatureToken(a.id);

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

    // A one-time credential cannot be used to read the assignment after sign.
    const getRes = await request(app).get(`/api/ppe/sign/${token}`);
    expect(getRes.status).toBe(409);
    expect(getRes.body.code).toBe("public_token_consumed");
  });

  it("submitting a second time with same token → 409 (prevents duplicate signs)", async () => {
    let token = randomUUID();
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
    token = await issueSignatureToken(a.id);

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
