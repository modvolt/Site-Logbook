import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  usersTable,
  customersTable,
  activitiesTable,
} from "@workspace/db";
import app from "../src/app";

/**
 * Endpoint-level invariant: a client can never mark an activity billed.
 *
 * The PATCH /api/activities/:id route validates its body with the
 * `UpdateActivityBody` Zod schema before any DB write. The only editable billing
 * intents are `billable`, `not_billable`, and null — the authoritative "billed"
 * state is derived solely from the invoice link (invoice_source_links /
 * billedInvoiceId) and is set server-side when an invoice is issued (cleared on
 * storno; see activity-invoice-double-bill.test.ts).
 *
 * Unlike activity-billing-status-validator.test.ts (which exercises the schema in
 * isolation), this test drives the real Express app end-to-end — authenticating
 * with a session cookie and asserting the route wires validator → 400 — so a
 * future refactor that bypasses or weakens the handler's validation is caught.
 *
 * Runs against the dev database (DATABASE_URL); the rate limiter on /auth/login
 * skips localhost, so the supertest agent can log in freely. Fixtures use a
 * unique tag and are torn down after.
 */

const TAG = `test-actpatch-${Date.now()}`;
const PASSWORD = "test-password-123";

let userId: number;
let customerId: number;
let activityId: number;
let agent: Agent;

async function makeActivity(): Promise<number> {
  const [activity] = await db
    .insert(activitiesTable)
    .values({ name: `Akce ${TAG}`, customerId, completedAt: new Date() })
    .returning();
  return activity.id;
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Test Runner",
      role: "admin",
      isActive: true,
    })
    .returning();
  userId = user.id;

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = customer.id;

  activityId = await makeActivity();

  agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TAG}-user`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  if (activityId)
    await db.delete(activitiesTable).where(inArray(activitiesTable.id, [activityId]));
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("PATCH /api/activities/:id billingStatus enforcement", () => {
  it("rejects a manual billingStatus: \"billed\" with 400", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}`)
      .send({ billingStatus: "billed" });
    expect(res.status).toBe(400);

    // The forbidden write must not have leaked into the DB.
    const [row] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, activityId));
    expect(row.billingStatus).not.toBe("billed");
  });

  it("rejects an arbitrary unknown billingStatus value with 400", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}`)
      .send({ billingStatus: "paid" });
    expect(res.status).toBe(400);
  });

  it("accepts billingStatus: \"billable\"", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}`)
      .send({ billingStatus: "billable" });
    expect(res.status).toBe(200);
    expect(res.body.billingStatus).toBe("billable");
  });

  it("accepts billingStatus: \"not_billable\"", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}`)
      .send({ billingStatus: "not_billable" });
    expect(res.status).toBe(200);
    expect(res.body.billingStatus).toBe("not_billable");
  });

  it("accepts billingStatus: null (untracked)", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}`)
      .send({ billingStatus: null });
    expect(res.status).toBe(200);
    expect(res.body.billingStatus).toBeNull();
  });
});
