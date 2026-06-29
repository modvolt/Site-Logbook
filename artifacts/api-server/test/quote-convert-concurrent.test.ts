import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, count } from "drizzle-orm";
import {
  db,
  usersTable,
  customersTable,
  quotesTable,
  quoteItemsTable,
  jobsTable,
} from "@workspace/db";
import { convertQuoteToJob } from "../src/lib/quote-service";

/**
 * Atomic quote → job conversion — concurrency guard (DB-backed).
 *
 * `convertQuoteToJob` wraps the whole operation in a single DB transaction
 * with a `SELECT … FOR UPDATE` lock on the quote row. Two simultaneous calls
 * for the same quote therefore serialise: the winner inserts a job and sets
 * `convertedToJobId`; the loser re-reads the now-locked row and sees a
 * non-null `convertedToJobId`, then throws a 409 AppError.
 *
 * Invariants verified:
 *  - Exactly one new job is created.
 *  - Exactly one `convertedToJobId` is written on the quote.
 *  - Exactly one call succeeds (resolved); exactly one call rejects with
 *    statusCode 409.
 *  - No orphaned jobs (all jobs in DB that came from the quote share the
 *    same single jobId).
 */

const TAG = `test-quote-convert-${Date.now()}`;

let customerId: number;
let quoteId: number;
const jobIdsToClean: number[] = [];

async function makeAcceptedQuote(): Promise<number> {
  const [quote] = await db
    .insert(quotesTable)
    .values({
      quoteNumber: `NAB-${TAG}`,
      title: `Nabídka ${TAG}`,
      customerId,
      status: "accepted",
    })
    .returning();
  return quote.id;
}

beforeAll(async () => {
  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = customer.id;

  quoteId = await makeAcceptedQuote();
});

afterAll(async () => {
  if (jobIdsToClean.length) {
    for (const jid of jobIdsToClean) {
      await db.delete(jobsTable).where(eq(jobsTable.id, jid)).catch(() => {});
    }
  }
  if (quoteId) {
    await db.delete(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quoteId)).catch(() => {});
    await db.delete(quotesTable).where(eq(quotesTable.id, quoteId)).catch(() => {});
  }
  if (customerId) {
    await db.delete(customersTable).where(eq(customersTable.id, customerId)).catch(() => {});
  }
});

describe("convertQuoteToJob — atomic transaction guard", () => {
  it("sequential conversion: succeeds once, rejects 409 on the second call", async () => {
    const first = await convertQuoteToJob(quoteId);
    jobIdsToClean.push(first.jobId);

    const err = await convertQuoteToJob(quoteId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(409);

    const [quote] = await db
      .select({ convertedToJobId: quotesTable.convertedToJobId })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId));
    expect(quote.convertedToJobId).toBe(first.jobId);
  });

  it("two parallel requests: exactly one succeeds, exactly one 409s, exactly one job created", async () => {
    const parallelTitle = `Nabídka-parallel-${TAG}`;
    const [freshQuote] = await db
      .insert(quotesTable)
      .values({
        quoteNumber: `NAB-PAR-${TAG}`,
        title: parallelTitle,
        customerId,
        status: "accepted",
      })
      .returning();
    const freshQuoteId = freshQuote.id;

    const results = await Promise.allSettled([
      convertQuoteToJob(freshQuoteId),
      convertQuoteToJob(freshQuoteId),
    ]);

    const successes = results.filter(
      (r): r is PromiseFulfilledResult<{ jobId: number }> => r.status === "fulfilled",
    );
    const failures = results.filter(
      (r) => r.status === "rejected" && (r.reason as { statusCode?: number })?.statusCode === 409,
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winningJobId = successes[0].value.jobId;
    jobIdsToClean.push(winningJobId);

    const [quote] = await db
      .select({ convertedToJobId: quotesTable.convertedToJobId })
      .from(quotesTable)
      .where(eq(quotesTable.id, freshQuoteId));

    expect(quote.convertedToJobId).toBe(winningJobId);

    const allJobsForTitle = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.title, parallelTitle));

    expect(allJobsForTitle).toHaveLength(1);
    expect(allJobsForTitle[0].id).toBe(winningJobId);

    await db.delete(quoteItemsTable).where(eq(quoteItemsTable.quoteId, freshQuoteId)).catch(() => {});
    await db.delete(quotesTable).where(eq(quotesTable.id, freshQuoteId)).catch(() => {});
  });

  it("non-accepted quote: rejects 409 with status message", async () => {
    const [draftQuote] = await db
      .insert(quotesTable)
      .values({ quoteNumber: `NAB-DRAFT-${TAG}`, title: `Draft ${TAG}`, status: "draft" })
      .returning();

    const err = await convertQuoteToJob(draftQuote.id).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(409);

    await db.delete(quotesTable).where(eq(quotesTable.id, draftQuote.id)).catch(() => {});
  });

  it("non-existent quote: rejects 404", async () => {
    const err = await convertQuoteToJob(999_999_999).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(404);
  });
});
