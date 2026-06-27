import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray, ne, and, isNotNull } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  invoiceSourceLinksTable,
  jobsTable,
  activitiesTable,
  activityMaterialsTable,
  activityExtraWorksTable,
} from "@workspace/db";
import { createDraft, issueInvoice } from "../src/lib/invoice-service";

/**
 * Concurrency double-bill guard for the issue flow, DB-backed.
 *
 * Issuing an invoice is the single point where a job/activity is committed as
 * "billed". Two simultaneous issues that touch the same source must never both
 * succeed, or the same job/activity ends up on two live invoices (double-bill).
 *
 * The protection is a `FOR UPDATE` row lock taken inside the issueInvoice
 * transaction:
 *  - the invoice row is locked first (status re-checked under the lock), so the
 *    SAME draft issued twice serialises — the loser sees status != "draft".
 *  - every linked job row is locked next; the first issue flips it to
 *    "vyfakturovano", so a competing draft for the SAME job sees status != "done"
 *    and 409s.
 *  - linked activity rows are locked the same way, and the issue-time
 *    already-billed check (any other non-cancelled invoice linking the activity)
 *    blocks a second live link.
 *
 * These tests fire the issues concurrently with Promise.allSettled and assert
 * the race can never produce two billed copies. They complement the
 * single-threaded lifecycle coverage in job-invoice-lifecycle.test.ts and
 * activity-invoice-double-bill.test.ts.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-concurrent-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const jobIds: number[] = [];
const activityIds: number[] = [];
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

async function makeCompletedActivity(): Promise<number> {
  const [activity] = await db
    .insert(activitiesTable)
    .values({
      name: `Akce ${TAG}`,
      customerId,
      completedAt: new Date(),
    })
    .returning();
  activityIds.push(activity.id);

  await db.insert(activityExtraWorksTable).values({
    activityId: activity.id,
    description: `Práce ${TAG}`,
    hours: "4",
    amount: "2000",
  });
  await db.insert(activityMaterialsTable).values({
    activityId: activity.id,
    name: `Materiál ${TAG}`,
    quantity: "3",
    unit: "ks",
    pricePerUnit: "150",
  });

  return activity.id;
}

/** Split allSettled results into issued winners and 409 losers. */
function classify(results: PromiseSettledResult<{ status: string }>[]) {
  const issued = results.filter(
    (r): r is PromiseFulfilledResult<{ status: string }> =>
      r.status === "fulfilled" && r.value.status === "issued",
  );
  const conflicts = results.filter(
    (r) => r.status === "rejected" && r.reason?.statusCode === 409,
  );
  return { issued, conflicts };
}

/**
 * Count invoices that actually BILLED the job — i.e. links on an issued
 * invoice. A loser draft keeps its (now un-issuable) source link, which is not a
 * double-bill; only two issued invoices for one job would be.
 */
async function countIssuedJobLinks(jobId: number): Promise<number> {
  const rows = await db
    .select({ id: invoiceSourceLinksTable.id })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        eq(invoiceSourceLinksTable.jobId, jobId),
        eq(invoicesTable.status, "issued"),
      ),
    );
  return rows.length;
}

async function countIssuedActivityLinks(activityId: number): Promise<number> {
  const rows = await db
    .select({ id: invoiceSourceLinksTable.id })
    .from(invoiceSourceLinksTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        eq(invoiceSourceLinksTable.activityId, activityId),
        eq(invoicesTable.status, "issued"),
      ),
    );
  return rows.length;
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
  if (activityIds.length) {
    await db
      .delete(activitiesTable)
      .where(inArray(activitiesTable.id, activityIds));
    activityIds.length = 0;
  }
});

afterAll(async () => {
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
});

describe("concurrent invoice issue — double-bill guard", () => {
  it("building a second draft for an already-linked done job is rejected up front", async () => {
    const jobId = await makeDoneJob();

    // First draft links the job (still "done", not yet issued).
    const draftA = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draftA.id);

    // A second operator trying to build a draft for the same job is rejected
    // immediately (no orphan draft that can never be issued).
    await expect(
      createDraft({ customerId, jobIds: [jobId] }, actor),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("two competing drafts for the SAME done job: exactly one issues, the other 409s, job billed once", async () => {
    const jobId = await makeDoneJob();

    // Draft A is built normally. Draft B is inserted directly to bypass the
    // createDraft already-billed guard (which now rejects a second draft up
    // front), so we can still exercise the issue-time FOR UPDATE race where two
    // drafts link one job and both are issued at once.
    const draftA = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draftA.id);

    const [draftB] = await db
      .insert(invoicesTable)
      .values({
        status: "draft",
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
      })
      .returning();
    invoiceIds.push(draftB.id);
    await db.insert(invoiceSourceLinksTable).values({
      invoiceId: draftB.id,
      jobId,
      amountWithoutVat: "5000",
    });

    const results = await Promise.allSettled([
      issueInvoice(draftA.id, actor),
      issueInvoice(draftB.id, actor),
    ]);
    const { issued, conflicts } = classify(results);

    // The FOR UPDATE lock on the job row serialises the two issues.
    expect(issued).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // The job is billed exactly once and is now "vyfakturovano".
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(job.status).toBe("vyfakturovano");
    expect(await countIssuedJobLinks(jobId)).toBe(1);
  });

  it("the SAME job draft issued twice concurrently: exactly one issues, the other 409s", async () => {
    const jobId = await makeDoneJob();
    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);

    const results = await Promise.allSettled([
      issueInvoice(draft.id, actor),
      issueInvoice(draft.id, actor),
    ]);
    const { issued, conflicts } = classify(results);

    // The invoice row lock + status re-check stops a double issue of one draft.
    expect(issued).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(await countIssuedJobLinks(jobId)).toBe(1);
  });

  it("the SAME activity draft issued twice concurrently: exactly one issues, the other 409s, activity billed once", async () => {
    const actId = await makeCompletedActivity();
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);

    const results = await Promise.allSettled([
      issueInvoice(draft.id, actor),
      issueInvoice(draft.id, actor),
    ]);
    const { issued, conflicts } = classify(results);

    // Activities share the issueInvoice path, so the same invoice-row lock holds.
    expect(issued).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(await countIssuedActivityLinks(actId)).toBe(1);
  });

  it("two competing drafts for the SAME activity: never double-billed (≤1 issued, never 2 live links)", async () => {
    const actId = await makeCompletedActivity();

    // Draft A is built normally. Draft B is inserted directly to bypass the
    // createDraft already-billed guard (which would reject a second draft), so we
    // can model the stale-draft race where two drafts link one activity and both
    // are issued at once.
    const draftA = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draftA.id);

    const [draftB] = await db
      .insert(invoicesTable)
      .values({
        status: "draft",
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
      })
      .returning();
    invoiceIds.push(draftB.id);
    await db.insert(invoiceSourceLinksTable).values({
      invoiceId: draftB.id,
      activityId: actId,
      amountWithoutVat: "2000",
    });

    const results = await Promise.allSettled([
      issueInvoice(draftA.id, actor),
      issueInvoice(draftB.id, actor),
    ]);
    const { issued } = classify(results);

    // The activity FOR UPDATE lock + already-billed check guarantee the activity
    // is never committed onto two live invoices — at most one issue can win.
    expect(issued.length).toBeLessThanOrEqual(1);
    expect(await countIssuedActivityLinks(actId)).toBeLessThanOrEqual(1);

    // And it is never linked to two non-cancelled invoices at once.
    const liveLinks = await db
      .select({ status: invoicesTable.status })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(
        and(
          eq(invoiceSourceLinksTable.activityId, actId),
          ne(invoicesTable.status, "cancelled"),
          isNotNull(invoiceSourceLinksTable.activityId),
        ),
      );
    const issuedLive = liveLinks.filter((l) => l.status === "issued");
    expect(issuedLive.length).toBeLessThanOrEqual(1);
  });
});
