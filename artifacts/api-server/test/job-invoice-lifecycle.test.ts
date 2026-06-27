import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  invoiceSourceLinksTable,
  jobsTable,
} from "@workspace/db";
import {
  createDraft,
  issueInvoice,
  cancelInvoice,
  getUnbilledCustomerDetail,
} from "../src/lib/invoice-service";

/**
 * Job invoiced-status lifecycle, DB-backed.
 *
 * A job's authoritative billed state is the "vyfakturovano" status, which is set
 * server-side ONLY by issuing an invoice that links the job (done →
 * vyfakturovano) and reverted to "done" on storno. A client never writes this
 * status directly — that path is pinned shut by job-billing-status-validator.ts.
 *
 * This test pins the legitimate path: issuing an invoice flips a linked done job
 * to "vyfakturovano" and removes it from the unbilled pool; storno restores it
 * to "done" and returns it to the pool. It mirrors the activity lifecycle
 * coverage in activity-invoice-double-bill.test.ts.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-jobbill-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const invoiceIds: number[] = [];

async function makeDoneJob(): Promise<number> {
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: `Zakázka ${TAG}`,
      type: "other",
      date: "2026-06-27",
      status: "done",
      customerId,
      price: "5000",
    })
    .returning();
  jobIds.push(job.id);
  return job.id;
}

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: "x",
      name: "Test Runner",
      role: "admin",
    })
    .returning();
  actor.userId = user.id;

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = customer.id;
});

afterEach(async () => {
  if (invoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
    invoiceIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("job invoice lifecycle (issue / storno) end-to-end", () => {
  it("flips a linked done job to \"vyfakturovano\" on issue, and back to \"done\" on storno", async () => {
    const jobId = await makeDoneJob();

    // The done job is offered for invoicing up front.
    const before = await getUnbilledCustomerDetail(customerId);
    expect(before.jobs.map((j) => j.id)).toContain(jobId);

    // Draft + issue an invoice from the job.
    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);
    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");

    // Issuing the invoice is the ONLY way the job reaches "vyfakturovano".
    const [afterIssueJob] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(afterIssueJob.status).toBe("vyfakturovano");

    // …and it disappears from the unbilled pool (its source link on a
    // non-cancelled invoice is the source of truth).
    const afterIssue = await getUnbilledCustomerDetail(customerId);
    expect(afterIssue.jobs.map((j) => j.id)).not.toContain(jobId);

    // Storno the invoice — the job must revert to "done" and return to the pool.
    const cancelled = await cancelInvoice(draft.id, true, actor);
    expect(cancelled.status).toBe("cancelled");

    const [afterCancelJob] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(afterCancelJob.status).toBe("done");

    const afterCancel = await getUnbilledCustomerDetail(customerId);
    expect(afterCancel.jobs.map((j) => j.id)).toContain(jobId);
  });

  it("creates the job source link on issue and clears it (cancelled) on storno", async () => {
    const jobId = await makeDoneJob();

    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);
    await issueInvoice(draft.id, actor);

    // The job is linked to a non-cancelled invoice — i.e. it really is billed.
    const liveBefore = await db
      .select({ status: invoicesTable.status })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(eq(invoiceSourceLinksTable.jobId, jobId));
    expect(liveBefore.some((l) => l.status !== "cancelled")).toBe(true);

    await cancelInvoice(draft.id, true, actor);

    // After storno the only link points at a cancelled invoice — not billed.
    const liveAfter = await db
      .select({ status: invoicesTable.status })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(eq(invoiceSourceLinksTable.jobId, jobId));
    expect(liveAfter.every((l) => l.status === "cancelled")).toBe(true);
  });
});
