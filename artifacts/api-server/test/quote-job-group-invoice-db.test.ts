import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  customersTable,
  db,
  invoiceLinesTable,
  invoiceSourceLinksTable,
  invoicesTable,
  jobGroupsTable,
  jobsTable,
  quoteInvoiceLinksTable,
  quoteItemsTable,
  quotesTable,
} from "@workspace/db";
import {
  createQuoteJobGroupInvoiceDraft,
  deleteDraft,
} from "../src/lib/invoice-service";

const tag = `test-quote-group-invoice-${Date.now()}`;
const actor = { userId: null, name: "DB test" };
let customerId = 0;
let groupId = 0;
let quoteId = 0;
let primaryJobId = 0;
let extraJobId = 0;
let winningInvoiceId = 0;

beforeAll(async () => {
  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Customer ${tag}` })
    .returning();
  customerId = customer.id;
  const [group] = await db
    .insert(jobGroupsTable)
    .values({ name: tag, customerId, status: "open" })
    .returning();
  groupId = group.id;
  const [primary, extra] = await db
    .insert(jobsTable)
    .values([
      {
        title: `Base ${tag}`,
        date: "2026-08-10",
        status: "done",
        customerId,
        groupId,
      },
      {
        title: `Extra ${tag}`,
        date: "2026-08-11",
        status: "done",
        customerId,
        groupId,
        price: "500",
      },
    ])
    .returning();
  primaryJobId = primary.id;
  extraJobId = extra.id;
  const [quote] = await db
    .insert(quotesTable)
    .values({
      quoteNumber: `NAB-${tag}`,
      title: tag,
      customerId,
      status: "accepted",
      convertedToJobId: primaryJobId,
      convertedToJobGroupId: groupId,
    })
    .returning();
  quoteId = quote.id;
  await db.insert(quoteItemsTable).values({
    quoteId,
    position: 0,
    description: "Accepted base price",
    quantity: "2",
    unit: "ks",
    unitPrice: "1000",
    vatRate: "21",
  });
});

afterAll(async () => {
  if (winningInvoiceId) {
    await deleteDraft(winningInvoiceId, actor).catch(() => {});
  }
  if (quoteId) {
    await db
      .delete(quoteInvoiceLinksTable)
      .where(eq(quoteInvoiceLinksTable.quoteId, quoteId))
      .catch(() => {});
    await db
      .delete(quoteItemsTable)
      .where(eq(quoteItemsTable.quoteId, quoteId))
      .catch(() => {});
    await db
      .delete(quotesTable)
      .where(eq(quotesTable.id, quoteId))
      .catch(() => {});
  }
  if (primaryJobId) {
    await db
      .delete(jobsTable)
      .where(eq(jobsTable.id, primaryJobId))
      .catch(() => {});
  }
  if (extraJobId) {
    await db
      .delete(jobsTable)
      .where(eq(jobsTable.id, extraJobId))
      .catch(() => {});
  }
  if (groupId) {
    await db
      .delete(jobGroupsTable)
      .where(eq(jobGroupsTable.id, groupId))
      .catch(() => {});
  }
  if (customerId) {
    await db
      .delete(customersTable)
      .where(eq(customersTable.id, customerId))
      .catch(() => {});
  }
});

describe("quote job-group invoice - DB concurrency", () => {
  it("creates exactly one draft, snapshots the quote and protects every group job", async () => {
    const results = await Promise.allSettled([
      createQuoteJobGroupInvoiceDraft(
        groupId,
        { extraJobIds: [extraJobId], labourBillingMode: "job_price" },
        actor,
      ),
      createQuoteJobGroupInvoiceDraft(
        groupId,
        { extraJobIds: [extraJobId], labourBillingMode: "job_price" },
        actor,
      ),
    ]);
    const success = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        NonNullable<Awaited<ReturnType<typeof createQuoteJobGroupInvoiceDraft>>>
      > => result.status === "fulfilled" && result.value != null,
    );
    const conflicts = results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { statusCode?: number }).statusCode === 409,
    );
    expect(success).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    winningInvoiceId = success[0].value.id;

    const lines = await db
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, winningInvoiceId));
    expect(lines.some((line) => line.sourceType === "quote_item")).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.sourceType === "job" &&
          line.jobId === extraJobId &&
          Number(line.unitPriceWithoutVat) === 500,
      ),
    ).toBe(true);

    const sources = await db
      .select({ jobId: invoiceSourceLinksTable.jobId })
      .from(invoiceSourceLinksTable)
      .where(eq(invoiceSourceLinksTable.invoiceId, winningInvoiceId));
    expect(new Set(sources.map((source) => source.jobId))).toEqual(
      new Set([primaryJobId, extraJobId]),
    );

    const [quote] = await db
      .select({ invoiceId: quotesTable.convertedToInvoiceId })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId));
    expect(quote.invoiceId).toBe(winningInvoiceId);
    const activeLinks = await db
      .select()
      .from(quoteInvoiceLinksTable)
      .where(eq(quoteInvoiceLinksTable.quoteId, quoteId));
    expect(
      activeLinks.filter((link) => link.status === "reserved"),
    ).toHaveLength(1);

    const [invoice] = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, winningInvoiceId));
    expect(invoice.id).toBe(winningInvoiceId);
  });

  it("deleting the draft releases the quote and preserves lifecycle history", async () => {
    await deleteDraft(winningInvoiceId, actor);
    const [quote] = await db
      .select({ invoiceId: quotesTable.convertedToInvoiceId })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId));
    expect(quote.invoiceId).toBeNull();
    const [link] = await db
      .select()
      .from(quoteInvoiceLinksTable)
      .where(eq(quoteInvoiceLinksTable.quoteId, quoteId));
    expect(link.status).toBe("released");
    expect(link.invoiceId).toBeNull();
    expect(link.invoiceIdSnapshot).toBe(winningInvoiceId);
    winningInvoiceId = 0;
  });
});
