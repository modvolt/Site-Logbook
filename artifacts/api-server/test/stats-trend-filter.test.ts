import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, customersTable, jobsTable, invoicesTable } from "@workspace/db";
import { queryTrend } from "../src/routes/stats";

/**
 * Trend chart filter correctness — DB-backed, calling queryTrend() directly.
 *
 * The stats overview endpoint exposes three trend series (trendIssued,
 * trendPaid, trendJobs) each filterable by trendCustomerId and/or trendJobType.
 * These filters are applied in three independent SQL queries inside queryTrend().
 * This suite confirms they all narrow correctly under edge-case data:
 *
 *  1. No filter  → data from both customers appears in the relevant months.
 *  2. trendCustomerId only → all three series narrowed to that customer.
 *  3. trendJobType only → only the job series narrowed; invoice series unfiltered.
 *  4. Both params combined → intersection (customer's invoices + customer's
 *     matching-type jobs).
 *  5. Unknown jobType → zeros in job series with no error; invoice series intact.
 *
 * Fixtures use far-future dates (2040) to avoid collisions with real or other-test
 * data already in the dev database. The TAG suffix isolates customers between
 * concurrent runs.
 *
 * Runs against the dev database (DATABASE_URL).
 */

const TAG = `test-trend-${Date.now()}`;

let customerAId: number;
let customerBId: number;
const jobIds: number[] = [];
const invoiceIds: number[] = [];

// Fixture dates — far future so no other fixture data collides in these months.
// Trend window: last6Months("2040-06-30") → 2040-01 … 2040-06
const TO = "2040-06-30";
const MONTHS = ["2040-01", "2040-02", "2040-03", "2040-04", "2040-05", "2040-06"];

// Customer A: electric job + invoice, both in 2040-03
const JOB_DATE_A = "2040-03-15";
const INVOICE_ISSUE_A = "2040-03-10";
const INVOICE_PAID_DATE_A = "2040-03-20";
const INVOICE_AMOUNT_A = "1000.00";

// Customer B: plumbing job + invoice, both in 2040-04
const JOB_DATE_B = "2040-04-20";
const INVOICE_ISSUE_B = "2040-04-10";
const INVOICE_PAID_DATE_B = "2040-04-20";
const INVOICE_AMOUNT_B = "2000.00";

/** Helper: find the row for a specific YYYY-MM month label */
function month(
  trend: Array<{ month: string; issuedWithVat: number; paid: number; doneJobsCount: number }>,
  m: string,
) {
  const row = trend.find((r) => r.month === m);
  expect(row, `month ${m} not found in trend`).toBeDefined();
  return row!;
}

beforeAll(async () => {
  const [custA] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník A ${TAG}` })
    .returning();
  customerAId = custA.id;

  const [custB] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník B ${TAG}` })
    .returning();
  customerBId = custB.id;

  // Customer A: type "electric", done, 2040-03
  const [jobA] = await db
    .insert(jobsTable)
    .values({
      title: `Práce A ${TAG}`,
      type: "electric",
      date: JOB_DATE_A,
      status: "done",
      customerId: customerAId,
      price: "500",
    })
    .returning();
  jobIds.push(jobA.id);

  // Customer B: type "plumbing", done, 2040-04
  const [jobB] = await db
    .insert(jobsTable)
    .values({
      title: `Práce B ${TAG}`,
      type: "plumbing",
      date: JOB_DATE_B,
      status: "done",
      customerId: customerBId,
      price: "800",
    })
    .returning();
  jobIds.push(jobB.id);

  // Customer A invoice: paid, issued 2040-03-10, paid 2040-03-20, 1000 CZK
  const [invA] = await db
    .insert(invoicesTable)
    .values({
      status: "paid",
      customerId: customerAId,
      customerName: `Zákazník A ${TAG}`,
      issueDate: INVOICE_ISSUE_A,
      paidDate: INVOICE_PAID_DATE_A,
      totalWithVat: INVOICE_AMOUNT_A,
    })
    .returning();
  invoiceIds.push(invA.id);

  // Customer B invoice: paid, issued 2040-04-10, paid 2040-04-20, 2000 CZK
  const [invB] = await db
    .insert(invoicesTable)
    .values({
      status: "paid",
      customerId: customerBId,
      customerName: `Zákazník B ${TAG}`,
      issueDate: INVOICE_ISSUE_B,
      paidDate: INVOICE_PAID_DATE_B,
      totalWithVat: INVOICE_AMOUNT_B,
    })
    .returning();
  invoiceIds.push(invB.id);
});

afterAll(async () => {
  if (invoiceIds.length)
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  if (jobIds.length)
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  if (customerAId)
    await db.delete(customersTable).where(eq(customersTable.id, customerAId));
  if (customerBId)
    await db.delete(customersTable).where(eq(customersTable.id, customerBId));
});

describe("queryTrend – no filter (baseline)", () => {
  it("returns 6 months covering 2040-01 through 2040-06", async () => {
    const trend = await queryTrend(MONTHS, TO);
    expect(trend).toHaveLength(6);
    expect(trend.map((r) => r.month)).toEqual(MONTHS);
  });

  it("includes customer A invoice amount (≥1000) in 2040-03", async () => {
    const trend = await queryTrend(MONTHS, TO);
    const m03 = month(trend, "2040-03");
    expect(m03.issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(m03.paid).toBeGreaterThanOrEqual(1000);
  });

  it("includes customer B invoice amount (≥2000) in 2040-04", async () => {
    const trend = await queryTrend(MONTHS, TO);
    const m04 = month(trend, "2040-04");
    expect(m04.issuedWithVat).toBeGreaterThanOrEqual(2000);
    expect(m04.paid).toBeGreaterThanOrEqual(2000);
  });

  it("counts done jobs in 2040-03 (customer A) and 2040-04 (customer B)", async () => {
    const trend = await queryTrend(MONTHS, TO);
    expect(month(trend, "2040-03").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-04").doneJobsCount).toBeGreaterThanOrEqual(1);
  });
});

describe("queryTrend – trendCustomerId only", () => {
  it("customer A: 2040-03 has A's invoice (≥1000); 2040-04 is 0 (only B invoiced there)", async () => {
    const trend = await queryTrend(MONTHS, TO, customerAId);
    const m03 = month(trend, "2040-03");
    const m04 = month(trend, "2040-04");
    expect(m03.issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(m03.paid).toBeGreaterThanOrEqual(1000);
    expect(m04.issuedWithVat).toBe(0);
    expect(m04.paid).toBe(0);
  });

  it("customer A: 2040-03 job count ≥1; 2040-04 job count = 0", async () => {
    const trend = await queryTrend(MONTHS, TO, customerAId);
    expect(month(trend, "2040-03").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-04").doneJobsCount).toBe(0);
  });

  it("customer B: 2040-04 has B's invoice (≥2000); 2040-03 is 0 (only A invoiced there)", async () => {
    const trend = await queryTrend(MONTHS, TO, customerBId);
    const m03 = month(trend, "2040-03");
    const m04 = month(trend, "2040-04");
    expect(m04.issuedWithVat).toBeGreaterThanOrEqual(2000);
    expect(m04.paid).toBeGreaterThanOrEqual(2000);
    expect(m03.issuedWithVat).toBe(0);
    expect(m03.paid).toBe(0);
  });

  it("customer B: 2040-04 job count ≥1; 2040-03 job count = 0", async () => {
    const trend = await queryTrend(MONTHS, TO, customerBId);
    expect(month(trend, "2040-04").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-03").doneJobsCount).toBe(0);
  });
});

describe("queryTrend – trendJobType only", () => {
  it("electric filter: 2040-03 job count ≥1 (A is electric); 2040-04 = 0 (B is plumbing)", async () => {
    const trend = await queryTrend(MONTHS, TO, null, "electric");
    expect(month(trend, "2040-03").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-04").doneJobsCount).toBe(0);
  });

  it("plumbing filter: 2040-04 job count ≥1 (B is plumbing); 2040-03 = 0 (A is electric)", async () => {
    const trend = await queryTrend(MONTHS, TO, null, "plumbing");
    expect(month(trend, "2040-04").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-03").doneJobsCount).toBe(0);
  });

  it("jobType filter does NOT narrow invoice series — both customers' invoices appear", async () => {
    const trend = await queryTrend(MONTHS, TO, null, "electric");
    // Invoice series is not filtered by jobType: A (2040-03) and B (2040-04) both show through
    expect(month(trend, "2040-03").issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").issuedWithVat).toBeGreaterThanOrEqual(2000);
    expect(month(trend, "2040-03").paid).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").paid).toBeGreaterThanOrEqual(2000);
  });
});

describe("queryTrend – trendCustomerId + trendJobType combined (intersection)", () => {
  it("customer A + electric: 2040-03 job count ≥1; 2040-04 = 0 (no A/electric job there)", async () => {
    const trend = await queryTrend(MONTHS, TO, customerAId, "electric");
    expect(month(trend, "2040-03").doneJobsCount).toBeGreaterThanOrEqual(1);
    expect(month(trend, "2040-04").doneJobsCount).toBe(0);
  });

  it("customer A + electric: invoice series narrowed to A — 2040-03 ≥1000; 2040-04 = 0", async () => {
    const trend = await queryTrend(MONTHS, TO, customerAId, "electric");
    expect(month(trend, "2040-03").issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").issuedWithVat).toBe(0);
  });

  it("customer A + plumbing (mismatch): all months have 0 done jobs; A's invoices still appear", async () => {
    // Customer A has no plumbing jobs → job series is all zeros.
    // Invoice series is only filtered by customerId (not jobType) → A's invoices still show.
    const trend = await queryTrend(MONTHS, TO, customerAId, "plumbing");
    expect(month(trend, "2040-03").doneJobsCount).toBe(0);
    expect(month(trend, "2040-04").doneJobsCount).toBe(0);
    expect(month(trend, "2040-03").issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").issuedWithVat).toBe(0);
  });
});

describe("queryTrend – unknown / edge-case job type", () => {
  it("completely unknown jobType returns zeros in job series without throwing", async () => {
    const trend = await queryTrend(MONTHS, TO, null, "nonexistent_type_xyz_9999");
    expect(trend).toHaveLength(6);
    for (const row of trend) {
      expect(row.doneJobsCount).toBe(0);
    }
  });

  it("unknown jobType leaves invoice series fully unfiltered (A and B invoices appear)", async () => {
    const trend = await queryTrend(MONTHS, TO, null, "nonexistent_type_xyz_9999");
    expect(month(trend, "2040-03").issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").issuedWithVat).toBeGreaterThanOrEqual(2000);
  });

  it("unknown jobType combined with valid customerId: invoice series filtered, job series zeros", async () => {
    const trend = await queryTrend(MONTHS, TO, customerAId, "nonexistent_type_xyz_9999");
    // Jobs: customer A has no jobs of this type → all zeros
    for (const row of trend) {
      expect(row.doneJobsCount).toBe(0);
    }
    // Invoices: customer A had one in 2040-03
    expect(month(trend, "2040-03").issuedWithVat).toBeGreaterThanOrEqual(1000);
    expect(month(trend, "2040-04").issuedWithVat).toBe(0);
  });
});
