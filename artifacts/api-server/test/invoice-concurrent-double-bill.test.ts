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
import {
  createDraft,
  issueInvoice,
  cancelInvoice,
} from "../src/lib/invoice-service";

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

/**
 * Insert a "stale" draft directly linking a source, bypassing createDraft's
 * already-billed guard. Models a draft that was prepared in parallel and is then
 * issued at the same instant another transaction cancels the live invoice.
 */
async function insertStaleDraft(link: {
  jobId?: number;
  activityId?: number;
  amountWithoutVat: string;
}): Promise<number> {
  const [draft] = await db
    .insert(invoicesTable)
    .values({
      status: "draft",
      customerId,
      customerName: `Zákazník ${TAG}`,
      vatModeDefault: "standard",
    })
    .returning();
  invoiceIds.push(draft.id);
  await db.insert(invoiceSourceLinksTable).values({
    invoiceId: draft.id,
    jobId: link.jobId,
    activityId: link.activityId,
    amountWithoutVat: link.amountWithoutVat,
  });
  return draft.id;
}

/**
 * storno-then-rebill race, DB-backed.
 *
 * The complementary race to two simultaneous issues: one transaction cancels
 * (storno) the live invoice while another issues a fresh draft for the SAME
 * source at the same instant. cancelInvoice flips a job back to "done";
 * issueInvoice flips it to "vyfakturováno". The shared FOR UPDATE locks (job row
 * for jobs; the activity row + already-billed check for activities) must
 * serialise the two so the source can never end up on two live (non-cancelled)
 * issued invoices, nor be left in a status that contradicts its links.
 */
describe("concurrent storno + rebill — double-bill guard", () => {
  it("cancel(A) + issue(B) for the SAME job: never two live issued links, status stays consistent", async () => {
    const jobId = await makeDoneJob();

    // A is issued first → job is "vyfakturováno", linked to one issued invoice.
    const draftA = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draftA.id);
    await issueInvoice(draftA.id, actor);

    // B is a stale draft for the same job, prepared in parallel.
    const draftB = await insertStaleDraft({ jobId, amountWithoutVat: "5000" });

    // Storno A (returning the job to "done") races issuing B.
    const results = await Promise.allSettled([
      cancelInvoice(draftA.id, true, actor),
      issueInvoice(draftB.id, actor),
    ]);
    const { issued } = classify(
      // cancelInvoice resolves to an invoice detail too; only issueInvoice's
      // result can be "issued", so reuse the same classifier.
      results as PromiseSettledResult<{ status: string }>[],
    );

    // Whatever the interleaving: the job is billed at most once, and never sits
    // on two non-cancelled issued invoices.
    expect(issued.length).toBeLessThanOrEqual(1);
    expect(await countIssuedJobLinks(jobId)).toBeLessThanOrEqual(1);

    // A is always cancelled (its own row lock guarantees the storno commits).
    const [invA] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draftA.id));
    expect(invA.status).toBe("cancelled");

    // The job status must agree with its live billing: billed ⇒ "vyfakturováno",
    // unbilled ⇒ "done". It can never be "vyfakturováno" with zero issued links.
    const issuedLinks = await countIssuedJobLinks(jobId);
    const [job] = await db
      .select({ status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    if (issuedLinks === 1) {
      expect(job.status).toBe("vyfakturovano");
    } else {
      expect(job.status).toBe("done");
    }
  });

  it("cancel(A) + issue(B) for the SAME activity: never two live issued links", async () => {
    const actId = await makeCompletedActivity();

    const draftA = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draftA.id);
    await issueInvoice(draftA.id, actor);

    const draftB = await insertStaleDraft({
      activityId: actId,
      amountWithoutVat: "2000",
    });

    const results = await Promise.allSettled([
      cancelInvoice(draftA.id, true, actor),
      issueInvoice(draftB.id, actor),
    ]);
    const { issued } = classify(
      results as PromiseSettledResult<{ status: string }>[],
    );

    // The activity FOR UPDATE lock + already-billed check keep the activity off
    // two live invoices regardless of who wins the race.
    expect(issued.length).toBeLessThanOrEqual(1);
    expect(await countIssuedActivityLinks(actId)).toBeLessThanOrEqual(1);

    const [invA] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draftA.id));
    expect(invA.status).toBe("cancelled");

    // Never linked to two non-cancelled issued invoices at once.
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

/**
 * Guard-rejection race, DB-backed.
 *
 * The complement to the double-bill races above: here the linked source is made
 * UN-billable *after* the draft was built but *before* the issue can take its
 * own row lock. issueInvoice re-checks each linked job/activity under a
 * `FOR UPDATE` lock (not just the state captured when the draft was built), so
 * the issue must 409 and the invoice must stay a draft.
 *
 * To prove it is the re-check under the lock — and not the build-time state —
 * that blocks, these tests:
 *  1. build the draft while the source is fully billable (createDraft would
 *     itself reject otherwise), then
 *  2. flip the source to an un-billable state inside a parallel transaction that
 *     HOLDS the row lock, then
 *  3. start issueInvoice, which blocks on the SAME row lock, then
 *  4. commit the flip and release the lock.
 *
 * issueInvoice can only read the row once the holder commits, so the un-billable
 * value it sees is necessarily the re-checked, post-build value.
 */
describe("concurrent guard rejection — re-check under FOR UPDATE", () => {
  it("a linked job reopened mid-flight (away from done) is rejected by the re-check; invoice stays draft", async () => {
    const jobId = await makeDoneJob();

    // Draft built while the job is still "done" — proves the rejection below is
    // NOT a build-time check (createDraft itself rejects a non-done job).
    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);

    // Hold the job row locked + reopened in a parallel transaction. We only
    // release it once issueInvoice is already waiting on the SAME lock.
    let releaseHold!: () => void;
    const held = new Promise<void>((r) => {
      releaseHold = r;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((r) => {
      signalLocked = r;
    });

    const reopenAndHold = db.transaction(async (tx) => {
      // UPDATE takes (and keeps) the row lock for the rest of this tx.
      await tx
        .update(jobsTable)
        .set({ status: "in_progress" })
        .where(eq(jobsTable.id, jobId));
      signalLocked();
      await held;
    });

    // The reopen tx now holds the job row lock with status = "in_progress".
    await locked;

    // issueInvoice locks the invoice, recalcs, then blocks trying to lock the
    // job row FOR UPDATE — it cannot read the (uncommitted) reopened status yet.
    const issuePromise = issueInvoice(draft.id, actor).catch((e) => e);

    // Give the issue a moment to reach and block on the job lock, then commit
    // the reopen so the issue reads the post-build "in_progress" status.
    await new Promise((r) => setTimeout(r, 150));
    releaseHold();
    await reopenAndHold;

    const result = await issuePromise;
    expect(result?.statusCode).toBe(409);

    // The invoice never left draft and the job was never billed.
    const [inv] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draft.id));
    expect(inv.status).toBe("draft");
    expect(await countIssuedJobLinks(jobId)).toBe(0);

    const [job] = await db
      .select({ status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(job.status).toBe("in_progress");
  });

  it("a linked activity un-completed mid-flight is rejected by the re-check; invoice stays draft", async () => {
    const actId = await makeCompletedActivity();

    // Draft built while the activity is completed — createDraft rejects an
    // un-completed activity, so this rejection can only come from the re-check.
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);

    let releaseHold!: () => void;
    const held = new Promise<void>((r) => {
      releaseHold = r;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((r) => {
      signalLocked = r;
    });

    const uncompleteAndHold = db.transaction(async (tx) => {
      await tx
        .update(activitiesTable)
        .set({ completedAt: null })
        .where(eq(activitiesTable.id, actId));
      signalLocked();
      await held;
    });

    await locked;

    const issuePromise = issueInvoice(draft.id, actor).catch((e) => e);

    await new Promise((r) => setTimeout(r, 150));
    releaseHold();
    await uncompleteAndHold;

    const result = await issuePromise;
    expect(result?.statusCode).toBe(409);

    const [inv] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draft.id));
    expect(inv.status).toBe("draft");
    expect(await countIssuedActivityLinks(actId)).toBe(0);

    const [act] = await db
      .select({ completedAt: activitiesTable.completedAt })
      .from(activitiesTable)
      .where(eq(activitiesTable.id, actId));
    expect(act.completedAt).toBeNull();
  });
});

/**
 * Recovery path, DB-backed.
 *
 * The complement to the guard-rejection block above: once an issue has been
 * REJECTED (409) because a linked source went un-billable, returning the source
 * to a billable state must let the SAME draft issue successfully. This guards
 * against a regression where the FOR UPDATE re-check leaves the draft
 * permanently un-issuable — a stuck lock, a poisoned link, or a status the guard
 * never accepts again.
 *
 * No concurrency is needed here: the re-check reads the committed row, so a
 * plain committed status flip is enough to drive the source un-billable and then
 * billable again.
 */
describe("guard recovery — blocked draft issues once the source is fixed", () => {
  it("a job reopened then set back to done: issue 409s, then the SAME draft issues", async () => {
    const jobId = await makeDoneJob();
    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);

    // Reopen the job (away from "done") — the re-check must reject the issue.
    await db
      .update(jobsTable)
      .set({ status: "in_progress" })
      .where(eq(jobsTable.id, jobId));

    const rejected = await issueInvoice(draft.id, actor).catch((e) => e);
    expect(rejected?.statusCode).toBe(409);

    // The invoice stayed a draft and the job was never billed.
    const [stillDraft] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draft.id));
    expect(stillDraft.status).toBe("draft");
    expect(await countIssuedJobLinks(jobId)).toBe(0);

    // Fix the job (back to "done") and re-issue the SAME draft — it must succeed.
    await db
      .update(jobsTable)
      .set({ status: "done" })
      .where(eq(jobsTable.id, jobId));

    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");

    // The job is now billed exactly once and flipped to "vyfakturováno".
    const [job] = await db
      .select({ status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    expect(job.status).toBe("vyfakturovano");
    expect(await countIssuedJobLinks(jobId)).toBe(1);
  });

  it("an activity un-completed then re-completed: issue 409s, then the SAME draft issues", async () => {
    const actId = await makeCompletedActivity();
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);

    // Un-complete the activity — the re-check must reject the issue.
    await db
      .update(activitiesTable)
      .set({ completedAt: null })
      .where(eq(activitiesTable.id, actId));

    const rejected = await issueInvoice(draft.id, actor).catch((e) => e);
    expect(rejected?.statusCode).toBe(409);

    const [stillDraft] = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, draft.id));
    expect(stillDraft.status).toBe("draft");
    expect(await countIssuedActivityLinks(actId)).toBe(0);

    // Re-complete the activity and re-issue the SAME draft — it must succeed.
    await db
      .update(activitiesTable)
      .set({ completedAt: new Date() })
      .where(eq(activitiesTable.id, actId));

    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");

    // The activity is billed by exactly one issued invoice.
    expect(await countIssuedActivityLinks(actId)).toBe(1);
  });
});
