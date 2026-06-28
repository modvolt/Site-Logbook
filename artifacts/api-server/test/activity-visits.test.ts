import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  usersTable,
  customersTable,
  activitiesTable,
  activityVisitsTable,
} from "@workspace/db";
import app from "../src/app";

/**
 * Activity visits (výjezdy) CRUD + invariant tests.
 *
 * Key invariant: completing a visit (status="completed") must NOT change the
 * parent activity's own status / completedAt.
 *
 * Fixtures are tagged and torn down in afterAll. Runs against the dev DB
 * (DATABASE_URL); the rate limiter skips localhost for supertest agents.
 */

const TAG = `test-actvisits-${Date.now()}`;
const PASSWORD = "test-password-123";

let userId: number;
let customerId: number;
let activityId: number;
let agent: Agent;

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: "Test Runner Visits",
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

  const [activity] = await db
    .insert(activitiesTable)
    .values({ name: `Akce ${TAG}`, customerId })
    .returning();
  activityId = activity.id;

  agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TAG}-user`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  if (activityId)
    await db.delete(activityVisitsTable).where(eq(activityVisitsTable.activityId, activityId));
  if (activityId)
    await db.delete(activitiesTable).where(eq(activitiesTable.id, activityId));
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (userId)
    await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("GET /api/activities/:activityId/visits — list", () => {
  it("returns 200 with an empty array for a new activity", async () => {
    const res = await agent.get(`/api/activities/${activityId}/visits`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 404 for a non-existent activity", async () => {
    const res = await agent.get(`/api/activities/999999999/visits`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/activities/:activityId/visits — create", () => {
  let visitId: number;

  afterAll(async () => {
    if (visitId)
      await db.delete(activityVisitsTable).where(eq(activityVisitsTable.id, visitId));
  });

  it("creates a visit with required fields", async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-01",
      status: "planned",
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.date).toBe("2026-07-01");
    expect(res.body.status).toBe("planned");
    expect(res.body.activityId).toBe(activityId);
    visitId = res.body.id;
  });

  it("creates a visit with all optional fields", async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-02",
      status: "completed",
      timeFrom: "09:00",
      timeTo: "11:30",
      note: "Provedena revize elektroinstalace",
      nextStep: "Přinést nové pojistky",
    });
    expect(res.status).toBe(201);
    expect(res.body.timeFrom).toBe("09:00");
    expect(res.body.timeTo).toBe("11:30");
    expect(res.body.note).toBe("Provedena revize elektroinstalace");
    expect(res.body.nextStep).toBe("Přinést nové pojistky");

    // Cleanup extra visit
    await db.delete(activityVisitsTable).where(eq(activityVisitsTable.id, res.body.id));
  });

  it("rejects a visit without a date with 400", async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      status: "planned",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status value with 400", async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-03",
      status: "done",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent activity", async () => {
    const res = await agent.post(`/api/activities/999999999/visits`).send({
      date: "2026-07-01",
      status: "planned",
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/activities/:activityId/visits/:visitId — update", () => {
  let visitId: number;

  beforeAll(async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-05",
      status: "planned",
    });
    visitId = res.body.id;
  });

  afterAll(async () => {
    if (visitId)
      await db.delete(activityVisitsTable).where(eq(activityVisitsTable.id, visitId));
  });

  it("updates status to in_progress", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}/visits/${visitId}`)
      .send({ status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("updates note and nextStep", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}/visits/${visitId}`)
      .send({ note: "Kontrola", nextStep: "Výměna kabelu" });
    expect(res.status).toBe(200);
    expect(res.body.note).toBe("Kontrola");
    expect(res.body.nextStep).toBe("Výměna kabelu");
  });

  it("returns 404 for a non-existent visit", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}/visits/999999999`)
      .send({ status: "completed" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid status with 400", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}/visits/${visitId}`)
      .send({ status: "approved" });
    expect(res.status).toBe(400);
  });
});

describe("KEY INVARIANT: completing a visit does not change activity status", () => {
  let visitId: number;

  beforeAll(async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-10",
      status: "planned",
    });
    visitId = res.body.id;
  });

  afterAll(async () => {
    if (visitId)
      await db.delete(activityVisitsTable).where(eq(activityVisitsTable.id, visitId));
  });

  it("activity has no completedAt before the visit is updated", async () => {
    const [row] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, activityId));
    expect(row.completedAt).toBeNull();
  });

  it("completing the visit returns status=completed", async () => {
    const res = await agent
      .patch(`/api/activities/${activityId}/visits/${visitId}`)
      .send({ status: "completed" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
  });

  it("activity completedAt is STILL null after visit completed", async () => {
    const [row] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, activityId));
    expect(row.completedAt).toBeNull();
  });

  it("activity GET reflects lastVisitDate but NOT a changed activity-level status", async () => {
    const res = await agent.get(`/api/activities/${activityId}`);
    expect(res.status).toBe(200);
    expect(res.body.lastVisitDate).toBe("2026-07-10");
    // The activity should not be completed just because a visit is done.
    expect(res.body.completedAt).toBeNull();
  });
});

describe("GET /api/activities/:activityId visits aggregates", () => {
  let plannedVisitId: number;
  let completedVisitId: number;

  beforeAll(async () => {
    const r1 = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-08-01",
      status: "planned",
    });
    plannedVisitId = r1.body.id;

    const r2 = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-15",
      status: "completed",
    });
    completedVisitId = r2.body.id;
  });

  afterAll(async () => {
    for (const id of [plannedVisitId, completedVisitId].filter(Boolean))
      await db.delete(activityVisitsTable).where(eq(activityVisitsTable.id, id));
  });

  it("nextVisitDate reflects the earliest future planned visit", async () => {
    const res = await agent.get(`/api/activities/${activityId}`);
    expect(res.status).toBe(200);
    expect(res.body.nextVisitDate).toBe("2026-08-01");
  });

  it("visitsCount is accurate", async () => {
    const res = await agent.get(`/api/activities/${activityId}`);
    expect(res.body.visitsCount).toBeGreaterThanOrEqual(2);
  });
});

describe("DELETE /api/activities/:activityId/visits/:visitId", () => {
  let visitId: number;

  beforeAll(async () => {
    const res = await agent.post(`/api/activities/${activityId}/visits`).send({
      date: "2026-07-20",
      status: "planned",
    });
    visitId = res.body.id;
  });

  it("deletes the visit and returns 204", async () => {
    const res = await agent.delete(`/api/activities/${activityId}/visits/${visitId}`);
    expect(res.status).toBe(204);
  });

  it("visit no longer appears in the list", async () => {
    const res = await agent.get(`/api/activities/${activityId}/visits`);
    expect(res.status).toBe(200);
    const found = res.body.find((v: { id: number }) => v.id === visitId);
    expect(found).toBeUndefined();
  });

  it("returns 404 when trying to delete again", async () => {
    const res = await agent.delete(`/api/activities/${activityId}/visits/${visitId}`);
    expect(res.status).toBe(404);
  });
});
