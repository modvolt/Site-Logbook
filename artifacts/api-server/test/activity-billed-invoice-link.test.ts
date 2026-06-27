import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  invoicesTable,
  invoiceSourceLinksTable,
  activitiesTable,
} from "@workspace/db";
import { serializeActivity } from "../src/routes/activities";

/**
 * Guards the "is this action already invoiced" indicator on the Activity
 * response (billedInvoiceId / billedInvoiceNumber / billedInvoiceStatus),
 * computed by serializeActivity from a join over invoice_source_links +
 * invoices. The lookup must:
 *   - surface a non-cancelled (issued/draft) linking invoice, and
 *   - ignore a cancelled linking invoice (storno frees the action), and
 *   - report nulls for an unbilled action.
 *
 * GET /api/activities/:id and the list both serialize through this exact
 * function, so testing it directly covers both surfaces. Runs against the dev
 * database (DATABASE_URL); fixtures use a unique tag and are torn down after.
 */

const TAG = `test-actlink-${Date.now()}`;

let customerId: number;
let userId: number;
const activityIds: number[] = [];
const invoiceIds: number[] = [];

async function makeActivity(): Promise<number> {
  const [activity] = await db
    .insert(activitiesTable)
    .values({
      name: `Akce ${TAG}`,
      customerId,
      completedAt: new Date(),
    })
    .returning();
  activityIds.push(activity.id);
  return activity.id;
}

async function makeInvoice(
  status: "draft" | "issued" | "cancelled",
  suffix: string,
): Promise<{ id: number; invoiceNumber: string }> {
  const invoiceNumber = `${TAG}-${suffix}`;
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      status,
      invoiceNumber,
      customerId,
      customerName: `Zákazník ${TAG}`,
      vatModeDefault: "standard",
    })
    .returning();
  invoiceIds.push(invoice.id);
  return { id: invoice.id, invoiceNumber };
}

async function linkActivity(invoiceId: number, activityId: number) {
  await db.insert(invoiceSourceLinksTable).values({
    invoiceId,
    activityId,
    amountWithoutVat: "1000",
  });
}

async function serializeById(id: number) {
  const [row] = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.id, id));
  return serializeActivity(row);
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
  userId = user.id;

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
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("activity billed-invoice link (serializeActivity)", () => {
  it("surfaces an issued invoice the activity is linked to", async () => {
    const actId = await makeActivity();
    const invoice = await makeInvoice("issued", "I");
    await linkActivity(invoice.id, actId);

    const out = await serializeById(actId);
    expect(out.billedInvoiceId).toBe(invoice.id);
    expect(out.billedInvoiceNumber).toBe(invoice.invoiceNumber);
    expect(out.billedInvoiceStatus).toBe("issued");
  });

  it("surfaces a draft invoice the activity is linked to", async () => {
    const actId = await makeActivity();
    const invoice = await makeInvoice("draft", "D");
    await linkActivity(invoice.id, actId);

    const out = await serializeById(actId);
    expect(out.billedInvoiceId).toBe(invoice.id);
    expect(out.billedInvoiceNumber).toBe(invoice.invoiceNumber);
    expect(out.billedInvoiceStatus).toBe("draft");
  });

  it("returns nulls when the only linking invoice is cancelled (storno frees the action)", async () => {
    const actId = await makeActivity();
    const invoice = await makeInvoice("cancelled", "X");
    await linkActivity(invoice.id, actId);

    const out = await serializeById(actId);
    expect(out.billedInvoiceId).toBeNull();
    expect(out.billedInvoiceNumber).toBeNull();
    expect(out.billedInvoiceStatus).toBeNull();
  });

  it("prefers the non-cancelled invoice when an activity has both a cancelled and an issued link", async () => {
    const actId = await makeActivity();
    const cancelled = await makeInvoice("cancelled", "Xc");
    const issued = await makeInvoice("issued", "Ii");
    await linkActivity(cancelled.id, actId);
    await linkActivity(issued.id, actId);

    const out = await serializeById(actId);
    expect(out.billedInvoiceId).toBe(issued.id);
    expect(out.billedInvoiceNumber).toBe(issued.invoiceNumber);
    expect(out.billedInvoiceStatus).toBe("issued");
  });

  it("returns nulls for an unbilled activity", async () => {
    const actId = await makeActivity();

    const out = await serializeById(actId);
    expect(out.billedInvoiceId).toBeNull();
    expect(out.billedInvoiceNumber).toBeNull();
    expect(out.billedInvoiceStatus).toBeNull();
  });

  it("serializes the list with per-activity billed state (unbilled stays null next to a billed one)", async () => {
    const billedId = await makeActivity();
    const unbilledId = await makeActivity();
    const invoice = await makeInvoice("issued", "L");
    await linkActivity(invoice.id, billedId);

    const rows = await db
      .select()
      .from(activitiesTable)
      .where(inArray(activitiesTable.id, [billedId, unbilledId]));
    const serialized = await Promise.all(rows.map(serializeActivity));
    const byId = new Map(serialized.map((s) => [s.id, s]));

    expect(byId.get(billedId)?.billedInvoiceId).toBe(invoice.id);
    expect(byId.get(billedId)?.billedInvoiceStatus).toBe("issued");
    expect(byId.get(unbilledId)?.billedInvoiceId).toBeNull();
    expect(byId.get(unbilledId)?.billedInvoiceStatus).toBeNull();
  });
});
