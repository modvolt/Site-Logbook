import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";

const HAS_TEST_DB = Boolean(process.env.DATABASE_URL) && process.env.JOB_STATUS_DB_TEST_ENABLED === "true";
const TAG = `job-status-${Date.now()}`;
const ACTOR_NAME = `Status test ${TAG}`;

let dbModule: typeof import("@workspace/db");
let statusModule: typeof import("../src/lib/job-status-service");
let userId = 0;
let personId = 0;
let customerId = 0;
const jobIds: number[] = [];

describe.skipIf(!HAS_TEST_DB)("job-status transitions against an isolated database", () => {
  beforeAll(async () => {
    dbModule = await import("@workspace/db");
    statusModule = await import("../src/lib/job-status-service");
    const { db, usersTable, peopleTable, customersTable } = dbModule;

    const [user] = await db.insert(usersTable).values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash("test-only-password", 10),
      name: ACTOR_NAME,
      role: "admin",
      isActive: true,
    }).returning();
    userId = user.id;

    const [person] = await db.insert(peopleTable).values({ name: `Worker ${TAG}` }).returning();
    personId = person.id;
    const [customer] = await db.insert(customersTable).values({ companyName: `Customer ${TAG}` }).returning();
    customerId = customer.id;
  });

  afterAll(async () => {
    if (!dbModule) return;
    const {
      auditLogTable,
      customersTable,
      db,
      jobsTable,
      peopleTable,
      usersTable,
      workSessionsTable,
    } = dbModule;
    if (jobIds.length > 0) {
      await db.delete(workSessionsTable).where(inArray(workSessionsTable.jobId, jobIds));
      await db.delete(auditLogTable).where(
        and(eq(auditLogTable.entityType, "job"), inArray(auditLogTable.entityId, jobIds)),
      );
      await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    }
    if (personId) await db.delete(peopleTable).where(eq(peopleTable.id, personId));
    if (customerId) await db.delete(customersTable).where(eq(customersTable.id, customerId));
    if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function createJob(values: Partial<typeof dbModule.jobsTable.$inferInsert> = {}) {
    const [job] = await dbModule.db.insert(dbModule.jobsTable).values({
      title: `Job ${TAG}`,
      type: "planned_work",
      date: "2026-08-15",
      status: "planned",
      customerId,
      hoursSpent: "2",
      ...values,
    }).returning();
    jobIds.push(job.id);
    return job;
  }

  it("blocks hard readiness failures and requires acknowledgement for warnings", async () => {
    const job = await createJob({ customerId: null, hoursSpent: "0" });
    await dbModule.db.insert(dbModule.tasksTable).values({ jobId: job.id, title: `Task ${TAG}` });
    const [session] = await dbModule.db.insert(dbModule.workSessionsTable).values({
      personId,
      parentType: "job",
      parentIdSnapshot: job.id,
      jobId: job.id,
      startedAt: new Date(),
      status: "active",
      createdByUserId: userId,
    }).returning();

    await expect(statusModule.transitionJobStatus(
      job.id,
      "done",
      { userId, name: ACTOR_NAME },
      { acknowledgeWarnings: true },
    )).rejects.toMatchObject({ code: "completion_blocked" });

    await dbModule.db.update(dbModule.jobsTable).set({ customerId }).where(eq(dbModule.jobsTable.id, job.id));
    await dbModule.db.update(dbModule.workSessionsTable).set({
      status: "completed",
      endedAt: new Date(),
      durationSeconds: 60,
    }).where(eq(dbModule.workSessionsTable.id, session.id));

    await expect(statusModule.transitionJobStatus(
      job.id,
      "done",
      { userId, name: ACTOR_NAME },
    )).rejects.toMatchObject({ code: "completion_warnings" });

    const completed = await statusModule.transitionJobStatus(
      job.id,
      "done",
      { userId, name: ACTOR_NAME },
      { acknowledgeWarnings: true },
    );
    expect(completed.status).toBe("done");

    const audit = await dbModule.db.select().from(dbModule.auditLogTable).where(
      and(
        eq(dbModule.auditLogTable.entityType, "job"),
        eq(dbModule.auditLogTable.entityId, job.id),
      ),
    );
    expect(audit.some((row) => row.action === "job_completed")).toBe(true);

    const reopened = await statusModule.transitionJobStatus(
      job.id,
      "in_progress",
      { userId, name: ACTOR_NAME },
    );
    expect(reopened.status).toBe("in_progress");
  });

  it("rolls back every status in a batch when one job is blocked", async () => {
    const valid = await createJob({ title: `Valid ${TAG}` });
    const blocked = await createJob({ title: `Blocked ${TAG}`, customerId: null });

    await expect(statusModule.transitionJobStatuses(
      [valid.id, blocked.id],
      "done",
      { userId, name: ACTOR_NAME },
      { acknowledgeWarnings: true },
    )).rejects.toMatchObject({ code: "completion_blocked", jobId: blocked.id });

    const rows = await dbModule.db.select({ id: dbModule.jobsTable.id, status: dbModule.jobsTable.status })
      .from(dbModule.jobsTable)
      .where(inArray(dbModule.jobsTable.id, [valid.id, blocked.id]));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "planned")).toBe(true);
  });
});
