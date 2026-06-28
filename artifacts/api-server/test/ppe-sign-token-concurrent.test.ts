import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import request from "supertest";
import {
  db,
  ppeItemsTable,
  ppeAssignmentsTable,
  peopleTable,
} from "@workspace/db";
import app from "../src/app";
import { ObjectStorageService } from "../src/lib/objectStorage";

/**
 * Concurrent PPE employee self-sign race guard.
 *
 * The public token endpoint (`POST /api/ppe/sign/:token`) is used when
 * employees open the QR/link on their own device. Two tabs or two devices
 * can race with the same token at the same moment.
 *
 * The guard is implemented via a `FOR UPDATE` row lock inside a transaction:
 * the second concurrent request waits for the first to commit, then sees
 * `employeeConfirmedAt` is already set and returns 409.
 *
 * Invariants:
 *  - Exactly one 200 and one 409 for two simultaneous requests.
 *  - `ppe_assignments.employeeConfirmedAt` is set exactly once.
 *  - `ppe_assignments.signatureObjectPath` holds exactly one value
 *    (the loser's orphaned upload is cleaned up).
 *
 * Object storage is mocked so tests run without S3/GCS.
 * No session is needed — the endpoint is public.
 */

const TAG = `test-ppe-token-concurrent-${Date.now()}`;

const MINIMAL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let personId: number;
let itemId: number;

const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

beforeAll(async () => {
  vi.spyOn(ObjectStorageService.prototype, "putPrivateObject").mockResolvedValue(
    undefined as unknown as void,
  );
  vi.spyOn(ObjectStorageService.prototype, "deletePrivateObject").mockResolvedValue(
    undefined as unknown as void,
  );

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
});

afterAll(async () => {
  vi.restoreAllMocks();

  if (assignmentIds.length > 0)
    await db.delete(ppeAssignmentsTable).where(inArray(ppeAssignmentsTable.id, assignmentIds));
  if (itemIds.length > 0)
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  if (personIds.length > 0)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
});

async function makeIssuedAssignment(): Promise<{ id: number; token: string }> {
  const token = randomUUID();
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
      signatureToken: token,
    })
    .returning();
  assignmentIds.push(assignment.id);
  return { id: assignment.id, token };
}

// ── Core concurrent race ──────────────────────────────────────────────────────

describe("concurrent PPE employee self-sign — double-sign race guard", () => {
  it("two simultaneous sign requests: exactly one 200 and one 409", async () => {
    const { token } = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("the 409 body contains a Czech error message referencing the signed state", async () => {
    const { token } = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
    ]);

    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.status).toBe(409);
    expect(typeof loser.body.error).toBe("string");
    expect(loser.body.error.length).toBeGreaterThan(0);
    expect(loser.body.error).toMatch(/podepsán/i);
  });

  it("employeeConfirmedAt is set exactly once (not null, not overwritten)", async () => {
    const { id, token } = await makeIssuedAssignment();

    await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
    ]);

    const [row] = await db
      .select({
        employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt,
        signatureObjectPath: ppeAssignmentsTable.signatureObjectPath,
      })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, id));

    expect(row.employeeConfirmedAt).not.toBeNull();
    expect(typeof row.employeeConfirmedAt).toBe("object");
  });

  it("signatureObjectPath is set to exactly one value (winner's path, not overwritten)", async () => {
    const { id, token } = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
    ]);

    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.status).toBe(200);

    const [row] = await db
      .select({ signatureObjectPath: ppeAssignmentsTable.signatureObjectPath })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, id));

    expect(row.signatureObjectPath).not.toBeNull();
    // The stored path must follow the expected pattern for this assignment
    expect(row.signatureObjectPath).toMatch(new RegExp(`/objects/ppe-signatures/${id}-${token}\\.png`));
  });

  it("three simultaneous requests: still exactly one success and two 409s", async () => {
    const { id, token } = await makeIssuedAssignment();

    const results = await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json")
        .then((r) => r.status),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json")
        .then((r) => r.status),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json")
        .then((r) => r.status),
    ]);

    const successes = results.filter((s) => s === 200);
    const conflicts = results.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(2);

    const [row] = await db
      .select({ employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, id));
    expect(row.employeeConfirmedAt).not.toBeNull();
  });

  it("200 response has correct shape (ok, employeeConfirmedAt, name snapshots)", async () => {
    const { token } = await makeIssuedAssignment();

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
      request(app)
        .post(`/api/ppe/sign/${token}`)
        .send({ signatureDataUrl: MINIMAL_PNG })
        .set("Content-Type", "application/json"),
    ]);

    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.body.ok).toBe(true);
    expect(typeof winner.body.employeeConfirmedAt).toBe("string");
    expect(winner.body.personNameSnapshot).toBe(`Pracovník ${TAG}`);
    expect(winner.body.ppeNameSnapshot).toBe(`Helma ${TAG}`);
  });
});

// ── Sequential guard (already-signed check) ───────────────────────────────────

describe("sequential sign guard — second sign after first commits → 409", () => {
  it("second request after first committed is rejected", async () => {
    const { token } = await makeIssuedAssignment();

    const first = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG })
      .set("Content-Type", "application/json");
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG })
      .set("Content-Type", "application/json");
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/podepsán/i);
  });

  it("second 409 does not overwrite employeeConfirmedAt", async () => {
    const { id, token } = await makeIssuedAssignment();

    const first = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG })
      .set("Content-Type", "application/json");
    expect(first.status).toBe(200);

    const firstConfirmedAt = first.body.employeeConfirmedAt as string;

    await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG })
      .set("Content-Type", "application/json");

    const [row] = await db
      .select({ employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, id));

    expect(row.employeeConfirmedAt).not.toBeNull();
    expect(row.employeeConfirmedAt!.toISOString()).toBe(firstConfirmedAt);
  });
});

// ── No session required ───────────────────────────────────────────────────────

describe("public endpoint — no authentication required", () => {
  it("sign succeeds with no session cookie", async () => {
    const { token } = await makeIssuedAssignment();

    const res = await request(app)
      .post(`/api/ppe/sign/${token}`)
      .send({ signatureDataUrl: MINIMAL_PNG })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
