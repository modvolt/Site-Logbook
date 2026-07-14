import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { createManualMovement } from "../src/lib/warehouse-service";

const HAS_TEST_DB = Boolean(process.env.DATABASE_URL) && process.env.ATOMIC_JOB_DB_TEST_ENABLED === "true";
const TAG = `atomic-job-${Date.now()}`;
const PASSWORD = "atomic-job-test-password";

let dbModule: typeof import("@workspace/db");
let agent: Agent;
let userId = 0;
let primaryPersonId = 0;
let extraPersonId = 0;
let customerId = 0;
let warehouseItemId = 0;

describe.skipIf(!HAS_TEST_DB)("POST /api/jobs atomic persistence", () => {
  beforeAll(async () => {
    dbModule = await import("@workspace/db");
    const app = (await import("../src/app")).default;
    const { db, usersTable, peopleTable, customersTable, warehouseItemsTable } = dbModule;

    const [user] = await db.insert(usersTable).values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `Admin ${TAG}`,
      role: "admin",
      isActive: true,
    }).returning();
    userId = user.id;

    const [primary, extra] = await db.insert(peopleTable).values([
      { name: `Primary ${TAG}` },
      { name: `Extra ${TAG}` },
    ]).returning();
    primaryPersonId = primary.id;
    extraPersonId = extra.id;

    const [customer] = await db.insert(customersTable).values({ companyName: `Customer ${TAG}` }).returning();
    customerId = customer.id;
    const [warehouseItem] = await db.insert(warehouseItemsTable).values({
      name: `Cable ${TAG}`,
      quantity: "0",
      unit: "m",
      purchasePrice: "20",
    }).returning();
    warehouseItemId = warehouseItem.id;
    await createManualMovement(
      db,
      warehouseItemId,
      {
        direction: "in",
        quantity: 10,
        unitPrice: 20,
        note: "Izolovany testovaci pocatecni stav",
      },
      { userId, name: `Admin ${TAG}` },
    );

    agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username: `${TAG}-admin`, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  afterAll(async () => {
    if (!dbModule) return;
    const {
      db, usersTable, peopleTable, customersTable, warehouseItemsTable,
      warehouseMovementsTable, jobsTable,
    } = dbModule;
    const jobs = await db.select({ id: jobsTable.id }).from(jobsTable).where(sql`${jobsTable.title} LIKE ${`%${TAG}%`}`);
    const jobIds = jobs.map((job) => job.id);
    if (jobIds.length > 0) {
      await db.delete(warehouseMovementsTable).where(inArray(warehouseMovementsTable.jobId, jobIds));
      await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    }
    if (warehouseItemId) await db.delete(warehouseItemsTable).where(eq(warehouseItemsTable.id, warehouseItemId));
    if (primaryPersonId && extraPersonId) {
      await db.delete(peopleTable).where(inArray(peopleTable.id, [primaryPersonId, extraPersonId]));
    }
    if (customerId) await db.delete(customersTable).where(eq(customersTable.id, customerId));
    if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("creates the job and all initial records together", async () => {
    const { db, jobAssigneesTable, tasksTable, materialsTable, warehouseMovementsTable } = dbModule;
    const response = await agent.post("/api/jobs").send({
      title: `Success ${TAG}`,
      type: "planned_work",
      date: "2026-08-01",
      status: "planned",
      assignedPersonId: primaryPersonId,
      assigneeIds: [primaryPersonId, extraPersonId, extraPersonId],
      customerId,
      tasks: [{ title: `Task ${TAG}` }],
      materials: [{
        name: `Cable ${TAG}`,
        quantity: 2,
        unit: "m",
        pricePerUnit: 30,
        warehouseItemId,
      }],
    });
    expect(response.status).toBe(201);
    const jobId = response.body.id as number;

    const [assignees, tasks, materials, movements] = await Promise.all([
      db.select().from(jobAssigneesTable).where(eq(jobAssigneesTable.jobId, jobId)),
      db.select().from(tasksTable).where(eq(tasksTable.jobId, jobId)),
      db.select().from(materialsTable).where(eq(materialsTable.jobId, jobId)),
      db.select().from(warehouseMovementsTable).where(eq(warehouseMovementsTable.jobId, jobId)),
    ]);
    expect(assignees.map((row) => row.personId)).toEqual([extraPersonId]);
    expect(tasks).toHaveLength(1);
    expect(materials).toHaveLength(1);
    expect(materials[0].done).toBe(false);
    expect(movements).toHaveLength(0);

    const consume = await agent
      .patch(`/api/jobs/${jobId}/materials/${materials[0].id}`)
      .send({ done: true });
    expect(consume.status).toBe(200);
    expect(consume.body.done).toBe(true);
    expect(consume.body.consumedAt).toBeTruthy();

    const [issuedMovements, issuedItem] = await Promise.all([
      db.select().from(warehouseMovementsTable).where(eq(warehouseMovementsTable.jobId, jobId)),
      db.select().from(dbModule.warehouseItemsTable).where(eq(dbModule.warehouseItemsTable.id, warehouseItemId)),
    ]);
    expect(issuedMovements).toHaveLength(1);
    expect(issuedMovements[0].direction).toBe("out");
    expect(Number(issuedMovements[0].quantity)).toBe(2);
    expect(Number(issuedItem[0].quantity)).toBe(8);

    const returnToPlan = await agent
      .patch(`/api/jobs/${jobId}/materials/${materials[0].id}`)
      .send({ done: false });
    expect(returnToPlan.status).toBe(200);
    expect(returnToPlan.body.done).toBe(false);
    expect(returnToPlan.body.consumedAt).toBeNull();

    const [correctedMovements, restoredItem] = await Promise.all([
      db.select().from(warehouseMovementsTable).where(eq(warehouseMovementsTable.jobId, jobId)),
      db.select().from(dbModule.warehouseItemsTable).where(eq(dbModule.warehouseItemsTable.id, warehouseItemId)),
    ]);
    expect(correctedMovements).toHaveLength(2);
    expect(correctedMovements.every((movement) => movement.jobId === jobId)).toBe(true);
    expect(correctedMovements.map((movement) => movement.direction).sort()).toEqual(["in", "out"]);
    expect(Number(restoredItem[0].quantity)).toBe(10);
  });

  it("rolls back the job and all initial rows when a later material insert fails", async () => {
    const { db, jobsTable, jobAssigneesTable, materialsTable, warehouseItemsTable, warehouseMovementsTable } = dbModule;
    const title = `Rollback ${TAG}`;
    const response = await agent.post("/api/jobs").send({
      title,
      type: "planned_work",
      date: "2026-08-02",
      status: "planned",
      assignedPersonId: primaryPersonId,
      assigneeIds: [extraPersonId],
      tasks: [{ title: `Rollback task ${TAG}` }],
      materials: [
        { name: `Cable ${TAG}`, quantity: 3, warehouseItemId },
        // numeric(10,2) overflow after the first material was already inserted
        // proves the whole transaction reverses.
        { name: `Overflow ${TAG}`, quantity: 100_000_000 },
      ],
    });
    expect(response.status).toBe(500);

    const jobs = await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.title, title));
    expect(jobs).toHaveLength(0);
    const leakedAssignees = await db.select().from(jobAssigneesTable).where(
      and(eq(jobAssigneesTable.personId, extraPersonId), sql`${jobAssigneesTable.jobId} NOT IN (SELECT id FROM jobs)`),
    );
    expect(leakedAssignees).toHaveLength(0);
    const leakedMaterials = await db.select().from(materialsTable).where(sql`${materialsTable.name} = ${`Cable ${TAG}`} AND ${materialsTable.jobId} NOT IN (SELECT id FROM jobs)`);
    expect(leakedMaterials).toHaveLength(0);
    const rollbackMovements = await db.select().from(warehouseMovementsTable).where(sql`${warehouseMovementsTable.note} = 'Výdej na zakázku' AND ${warehouseMovementsTable.jobId} NOT IN (SELECT id FROM jobs)`);
    expect(rollbackMovements).toHaveLength(0);
    const [warehouseItem] = await db.select().from(warehouseItemsTable).where(eq(warehouseItemsTable.id, warehouseItemId));
    expect(Number(warehouseItem.quantity)).toBe(10);
  });
});
