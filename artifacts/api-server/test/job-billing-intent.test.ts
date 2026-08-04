import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  customersTable,
  db,
  invoicesTable,
  jobsTable,
  peopleTable,
  usersTable,
  workSessionBillingLinksTable,
  workSessionsTable,
} from "@workspace/db";
import app from "../src/app";
import { bindAuthenticatedAgent } from "./scoped-test-agent";
import {
  createDraft,
  deleteDraft,
  getUnbilledCustomerDetail,
} from "../src/lib/invoice-service";

const TAG = `test-job-billing-intent-${Date.now()}`;
const PASSWORD = "test-password-123";
const actor = { userId: 0, name: "Billing test" };

let adminId = 0;
let masterId = 0;
let customerId = 0;
let personId = 0;
let admin: Agent;
let master: Agent;
const jobIds: number[] = [];
const invoiceIds: number[] = [];

async function makeDoneJob() {
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: `Reklamace ${TAG}`,
      type: "service_call",
      date: "2042-01-10",
      status: "done",
      customerId,
      price: "1500",
    })
    .returning();
  jobIds.push(job.id);
  await db.insert(workSessionsTable).values({
    personId,
    parentType: "job",
    parentIdSnapshot: job.id,
    jobId: job.id,
    startedAt: new Date("2042-01-10T08:00:00Z"),
    endedAt: new Date("2042-01-10T10:00:00Z"),
    durationSeconds: 7200,
    status: "completed",
    source: "manual",
    costRateSnapshot: "400",
    saleRateSnapshot: "700",
    billingStatus: "unbilled",
  });
  return job;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const [adminUser, masterUser] = await db
    .insert(usersTable)
    .values([
      {
        username: `${TAG}-admin`,
        passwordHash,
        name: "Billing Admin",
        role: "admin",
        isActive: true,
      },
      {
        username: `${TAG}-master`,
        passwordHash,
        name: "Billing Master",
        role: "master",
        isActive: true,
      },
    ])
    .returning();
  adminId = adminUser.id;
  masterId = masterUser.id;
  actor.userId = adminId;

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Customer ${TAG}` })
    .returning();
  customerId = customer.id;
  const [person] = await db
    .insert(peopleTable)
    .values({ name: `Worker ${TAG}` })
    .returning();
  personId = person.id;

  admin = request.agent(app);
  master = request.agent(app);
  expect(
    (
      await admin
        .post("/api/auth/login")
        .send({ username: `${TAG}-admin`, password: PASSWORD })
    ).status,
  ).toBe(200);
  await bindAuthenticatedAgent(admin);
  expect(
    (
      await master
        .post("/api/auth/login")
        .send({ username: `${TAG}-master`, password: PASSWORD })
    ).status,
  ).toBe(200);
  await bindAuthenticatedAgent(master);
});

afterEach(async () => {
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
    invoiceIds.length = 0;
  }
  if (jobIds.length) {
    await db
      .delete(workSessionBillingLinksTable)
      .where(
        inArray(
          workSessionBillingLinksTable.sessionId,
          db
            .select({ id: workSessionsTable.id })
            .from(workSessionsTable)
            .where(inArray(workSessionsTable.jobId, jobIds)),
        ),
      );
    await db
      .delete(workSessionsTable)
      .where(inArray(workSessionsTable.jobId, jobIds));
    await db
      .delete(auditLogTable)
      .where(
        and(
          eq(auditLogTable.entityType, "jobs"),
          inArray(auditLogTable.entityId, jobIds),
        ),
      );
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
});

afterAll(async () => {
  if (personId) await db.delete(peopleTable).where(eq(peopleTable.id, personId));
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (adminId || masterId) {
    await db
      .delete(usersTable)
      .where(inArray(usersTable.id, [adminId, masterId].filter(Boolean)));
  }
});

describe("job customer-billing intent", () => {
  it("excludes a job from billing while preserving payroll time and supports a safe return", async () => {
    const job = await makeDoneJob();

    const hidden = await master.get(`/api/jobs/${job.id}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.billingIntent).toBeNull();
    expect(hidden.body.billingExclusionReason).toBeNull();

    const forbidden = await master
      .patch(`/api/jobs/${job.id}/billing-intent`)
      .send({ billingIntent: "not_billable", reason: "Reklamace" });
    expect(forbidden.status).toBe(403);

    const missingReason = await admin
      .patch(`/api/jobs/${job.id}/billing-intent`)
      .send({ billingIntent: "not_billable" });
    expect(missingReason.status).toBe(400);

    const excluded = await admin
      .patch(`/api/jobs/${job.id}/billing-intent`)
      .send({
        billingIntent: "not_billable",
        reason: "Reklamace - práce na naše náklady",
      });
    expect(excluded.status).toBe(200);
    expect(excluded.body.billingIntent).toBe("not_billable");
    expect(excluded.body.billingExclusionReason).toContain("Reklamace");

    const [session] = await db
      .select()
      .from(workSessionsTable)
      .where(eq(workSessionsTable.jobId, job.id));
    expect(session.durationSeconds).toBe(7200);
    expect(session.costRateSnapshot).toBe("400.00");
    expect(session.billingStatus).toBe("unbilled");

    const unbilledWhileExcluded =
      await getUnbilledCustomerDetail(customerId);
    expect(unbilledWhileExcluded.jobs.map((row) => row.id)).not.toContain(
      job.id,
    );
    await expect(
      createDraft({ customerId, jobIds: [job.id] }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [audit] = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.action, "job_billing_intent_changed"),
          eq(auditLogTable.entityId, job.id),
        ),
      );
    expect(audit.entityId).toBe(job.id);
    expect(audit.summary).toContain("not_billable");

    const restored = await admin
      .patch(`/api/jobs/${job.id}/billing-intent`)
      .send({ billingIntent: "billable" });
    expect(restored.status).toBe(200);
    expect(restored.body.billingIntent).toBe("billable");
    expect(restored.body.billingExclusionReason).toBeNull();

    const unbilledAfterRestore = await getUnbilledCustomerDetail(customerId);
    expect(unbilledAfterRestore.jobs.map((row) => row.id)).toContain(job.id);

    const draft = await createDraft(
      { customerId, jobIds: [job.id] },
      actor,
    );
    invoiceIds.push(draft.id);
    const linkedConflict = await admin
      .patch(`/api/jobs/${job.id}/billing-intent`)
      .send({ billingIntent: "not_billable", reason: "Pozdní reklamace" });
    expect(linkedConflict.status).toBe(409);

    await deleteDraft(draft.id, actor);
    invoiceIds.splice(invoiceIds.indexOf(draft.id), 1);
  });
});
