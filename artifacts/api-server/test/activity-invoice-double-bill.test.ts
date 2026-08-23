import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  invoiceSourceAllocationsTable,
  invoiceSourceLinksTable,
  activitiesTable,
  activityMaterialsTable,
  activityExtraWorksTable,
} from "@workspace/db";
import {
  createDraft,
  issueInvoice,
  cancelInvoice,
  getUnbilledCustomerDetail,
} from "../src/lib/invoice-service";
import { ObjectStorageService } from "../src/lib/objectStorage";

/**
 * Double-bill guard for completed long-term actions (dlouhodobé akce), DB-backed.
 *
 * Unlike jobs — which are protected by their status transition (done →
 * vyfakturovano) so a second draft for the same job fails at issue time — an
 * activity's `billingStatus` is cosmetic. Parent source links preserve
 * provenance, while `invoice_source_allocations` exclusively reserves each raw
 * work/material source so a partially billed activity can expose only its
 * remaining sources without permitting a double bill.
 *
 * Two enforcement points are covered:
 *  1. createDraft rejects a second reservation of the same raw source.
 *  2. issueInvoice rejects a stale draft whose reservation is no longer active.
 *
 * Runs against the dev database (DATABASE_URL). Fixtures use a unique tag and
 * are torn down afterwards.
 */

const TAG = `test-actbill-${Date.now()}`;
const actor = { userId: 0, name: "Test Runner" };

let customerId: number;
const activityIds: number[] = [];
const invoiceIds: number[] = [];

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

beforeAll(async () => {
  vi.spyOn(
    ObjectStorageService.prototype,
    "putPrivateObject",
  ).mockResolvedValue();
  vi.spyOn(
    ObjectStorageService.prototype,
    "deletePrivateObject",
  ).mockResolvedValue();

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
  vi.restoreAllMocks();
});

describe("activity double-bill guard", () => {
  it("links an activity onto a draft via source links", async () => {
    const actId = await makeCompletedActivity();
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);

    const links = await db
      .select()
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.activityId, actId));
    expect(links.map((l) => l.invoiceId)).toContain(draft.id);
  });

  it("rejects creating a second draft for already-reserved activity sources (400)", async () => {
    const actId = await makeCompletedActivity();
    const draft1 = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft1.id);

    await expect(
      createDraft({ customerId, activityIds: [actId] }, actor),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects issuing a stale draft whose raw source got billed by another invoice (409)", async () => {
    const actId = await makeCompletedActivity();

    // Draft A is built first (the "stale" draft that will be issued last).
    const draftA = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draftA.id);

    const reserved = await db
      .select()
      .from(invoiceSourceAllocationsTable)
      .where(eq(invoiceSourceAllocationsTable.invoiceId, draftA.id));
    const stolen = reserved.find(
      (allocation) => allocation.status === "reserved",
    );
    expect(stolen).toBeDefined();

    // Model the stale-draft race explicitly at the raw-source ledger: draft A's
    // reservation is released, then invoice B settles that exact same source.
    await db
      .update(invoiceSourceAllocationsTable)
      .set({
        status: "released",
        releasedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invoiceSourceAllocationsTable.id, stolen!.id));
    const [invoiceB] = await db
      .insert(invoicesTable)
      .values({
        status: "issued",
        invoiceNumber: `${TAG}-B`,
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
      })
      .returning();
    invoiceIds.push(invoiceB.id);
    await db.insert(invoiceSourceLinksTable).values({
      invoiceId: invoiceB.id,
      activityId: actId,
      amountWithoutVat: "2000",
    });
    await db.insert(invoiceSourceAllocationsTable).values({
      invoiceId: invoiceB.id,
      invoiceIdSnapshot: invoiceB.id,
      sourceType: stolen!.sourceType,
      sourceId: stolen!.sourceId,
      jobId: stolen!.jobId,
      activityId: stolen!.activityId,
      sourceDescription: stolen!.sourceDescription,
      sourceUnit: stolen!.sourceUnit,
      originalQuantity: stolen!.originalQuantity,
      allocatedQuantity: stolen!.allocatedQuantity,
      sourceAmountWithoutVat: stolen!.sourceAmountWithoutVat,
      status: "billed",
      settlementMethod: "direct",
      legacyIncomplete: false,
      createdByUserId: actor.userId,
      updatedByUserId: actor.userId,
      settledAt: new Date(),
    });

    // Issuing the stale draft A must now be blocked.
    await expect(issueInvoice(draftA.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("does not reserve the activity when the linking invoice is cancelled (storno frees it)", async () => {
    const actId = await makeCompletedActivity();

    // A cancelled invoice that still carries the activity source link must NOT
    // count as billed — a storno releases the activity back to the pool.
    const [invoiceB] = await db
      .insert(invoicesTable)
      .values({
        status: "cancelled",
        invoiceNumber: `${TAG}-Bx`,
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
      })
      .returning();
    invoiceIds.push(invoiceB.id);
    await db.insert(invoiceSourceLinksTable).values({
      invoiceId: invoiceB.id,
      activityId: actId,
      amountWithoutVat: "2000",
    });

    // Building a fresh draft for the activity therefore succeeds (no double-bill).
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);
    const links = await db
      .select()
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.activityId, actId));
    expect(links.map((l) => l.invoiceId)).toContain(draft.id);
  });
});

describe("activity invoice lifecycle (issue / storno) end-to-end", () => {
  it("drops the activity from the unbilled pool once its invoice is issued, and restores it on storno", async () => {
    const actId = await makeCompletedActivity();

    // The completed activity is offered for invoicing up front.
    const before = await getUnbilledCustomerDetail(customerId);
    expect(before.activities.map((a) => a.id)).toContain(actId);

    // Draft + issue an invoice from the activity.
    const draft = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft.id);
    const issued = await issueInvoice(draft.id, actor);
    expect(issued.status).toBe("issued");

    // The issued invoice flips the cosmetic billing flag on the activity…
    const [afterIssueAct] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, actId));
    expect(afterIssueAct.billingStatus).toBe("billed");

    // …and the activity no longer appears because all of its raw sources are
    // settled in the allocation ledger.
    const afterIssue = await getUnbilledCustomerDetail(customerId);
    expect(afterIssue.activities.map((a) => a.id)).not.toContain(actId);

    // Storno the invoice — the activity must return to the unbilled pool and its
    // cosmetic billing flag must be cleared.
    const cancelled = await cancelInvoice(
      draft.id,
      { returnJobsToDone: true, reasonCode: "billing_error" },
      actor,
    );
    expect(cancelled.status).toBe("cancelled");

    const [afterCancelAct] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, actId));
    expect(afterCancelAct.billingStatus).toBeNull();

    const afterCancel = await getUnbilledCustomerDetail(customerId);
    expect(afterCancel.activities.map((a) => a.id)).toContain(actId);
  });

  it("can re-bill an activity after its first invoice is stornoed (no permanent loss)", async () => {
    const actId = await makeCompletedActivity();

    const draft1 = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft1.id);
    await issueInvoice(draft1.id, actor);
    await cancelInvoice(
      draft1.id,
      { returnJobsToDone: true, reasonCode: "billing_error" },
      actor,
    );

    // After storno the activity is free again, so a brand-new invoice can bill it.
    const draft2 = await createDraft(
      { customerId, activityIds: [actId] },
      actor,
    );
    invoiceIds.push(draft2.id);
    const reissued = await issueInvoice(draft2.id, actor);
    expect(reissued.status).toBe("issued");

    const links = await db
      .select()
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.activityId, actId));
    const liveInvoiceIds = links.map((l) => l.invoiceId);
    expect(liveInvoiceIds).toContain(draft2.id);
  });
});
