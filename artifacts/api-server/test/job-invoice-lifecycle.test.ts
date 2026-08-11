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
  invoiceSourceLinksTable,
  jobsTable,
  peopleTable,
  personHourlyRatesTable,
  workSessionsTable,
  workSessionBillingLinksTable,
  invoiceLinesTable,
  materialsTable,
} from "@workspace/db";
import {
  createDraft,
  issueInvoice,
  cancelInvoice,
  ensureBillingSettings,
  getUnbilledCustomerDetail,
  deleteDraft,
  listUnbilledCustomers,
  updateBillingSettings,
  getBillingSummary,
  getReadyToBillSummary,
} from "../src/lib/invoice-service";
import { ObjectStorageService } from "../src/lib/objectStorage";

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
const personIds: number[] = [];
let originalTransportRatePerKm = 0;

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
  vi.spyOn(
    ObjectStorageService.prototype,
    "putPrivateObject",
  ).mockResolvedValue();
  vi.spyOn(
    ObjectStorageService.prototype,
    "deletePrivateObject",
  ).mockResolvedValue();

  const settings = await ensureBillingSettings();
  originalTransportRatePerKm = Number(settings.transportRatePerKm);

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
  if (personIds.length) {
    await db.delete(workSessionBillingLinksTable).where(inArray(workSessionBillingLinksTable.sessionId,
      db.select({ id: workSessionsTable.id }).from(workSessionsTable).where(inArray(workSessionsTable.personId, personIds))));
    await db.delete(workSessionsTable).where(inArray(workSessionsTable.personId, personIds));
    await db.delete(personHourlyRatesTable).where(inArray(personHourlyRatesTable.personId, personIds));
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
    personIds.length = 0;
  }
  if (jobIds.length) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    jobIds.length = 0;
  }
  await updateBillingSettings({
    transportRatePerKm: originalTransportRatePerKm,
  });
});

afterAll(async () => {
  await updateBillingSettings({
    transportRatePerKm: originalTransportRatePerKm,
  });
  if (customerId)
    await db.delete(customersTable).where(eq(customersTable.id, customerId));
  if (actor.userId)
    await db.delete(usersTable).where(eq(usersTable.id, actor.userId));
  vi.restoreAllMocks();
});

describe("job invoice lifecycle (issue / storno) end-to-end", () => {
  it("uses recorded work by default and carries transport and materials into the draft", async () => {
    await updateBillingSettings({ transportRatePerKm: 30 });
    const readyToBillBefore = await getReadyToBillSummary();
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({
        price: "0",
        pricingMode: "time_material",
        transportKm: "42",
        transportCost: "0",
      })
      .where(eq(jobsTable.id, jobId));
    await db.insert(materialsTable).values({
      jobId,
      name: `Kabel ${TAG}`,
      quantity: "2",
      unit: "ks",
      pricePerUnit: "500",
      done: true,
    });

    const [person] = await db
      .insert(peopleTable)
      .values({ name: `Pracovník ${TAG}` })
      .returning();
    personIds.push(person.id);
    const [rate] = await db
      .insert(personHourlyRatesTable)
      .values({
        personId: person.id,
        validFrom: "2026-01-01",
        costRate: "500",
        saleRate: "800",
        reason: "Testovací sazba",
        createdByUserId: actor.userId,
      })
      .returning();
    await db.insert(workSessionsTable).values({
      personId: person.id,
      parentType: "job",
      parentIdSnapshot: jobId,
      jobId,
      startedAt: new Date("2026-06-27T08:00:00Z"),
      endedAt: new Date("2026-06-27T11:00:00Z"),
      durationSeconds: 10_800,
      status: "completed",
      source: "manual",
      hourlyRateId: rate.id,
      costRateSnapshot: "500",
      saleRateSnapshot: "800",
    });

    const [readyToBillAfter, billingSummaryAfter] = await Promise.all([
      getReadyToBillSummary(),
      getBillingSummary(),
    ]);
    expect(readyToBillAfter.jobsCount).toBe(
      readyToBillBefore.jobsCount + 1,
    );
    expect(
      readyToBillAfter.totalWithoutVat -
        readyToBillBefore.totalWithoutVat,
    ).toBe(4660);
    expect(billingSummaryAfter.totalToInvoiceWithoutVat).toBe(
      readyToBillAfter.totalWithoutVat,
    );

    const customerSummaryBefore = (await listUnbilledCustomers()).find(
      (row) => row.customerId === customerId,
    );
    expect(customerSummaryBefore?.orientationalTotal).toBe(4660);

    const draft = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        materialMarkupPercent: 0,
      },
      actor,
    );
    invoiceIds.push(draft.id);
    const lines = await db
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, draft.id));

    expect(
      lines.some(
        (line) =>
          line.sourceType === "work_session" &&
          Number(line.quantity) === 3 &&
          Number(line.unitPriceWithoutVat) === 800,
      ),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.sourceType === "transport" &&
          line.description.includes("42 km") &&
          Number(line.totalWithoutVat) === 1260,
      ),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.sourceType === "material" &&
          Number(line.quantity) === 2 &&
          Number(line.unitPriceWithoutVat) === 500,
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.sourceType === "job"),
    ).toBe(false);
    expect(draft.subtotalWithoutVat).toBe(4660);

    const customerSummaryAfter = (await listUnbilledCustomers()).find(
      (row) => row.customerId === customerId,
    );
    expect(customerSummaryAfter).toBeUndefined();
    const readyToBillAfterDraft = await getReadyToBillSummary();
    expect(readyToBillAfterDraft.jobsCount).toBe(
      readyToBillBefore.jobsCount,
    );
    expect(readyToBillAfterDraft.totalWithoutVat).toBe(
      readyToBillBefore.totalWithoutVat,
    );
  });

  it("groups equal historical rates in summary but keeps workers separate without changing totals or reservations", async () => {
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({ price: "0", pricingMode: "time_material" })
      .where(eq(jobsTable.id, jobId));

    const people = await db
      .insert(peopleTable)
      .values([
        { name: `Adam ${TAG}` },
        { name: `Boris ${TAG}` },
      ])
      .returning();
    personIds.push(...people.map((person) => person.id));
    const rates = await db
      .insert(personHourlyRatesTable)
      .values(
        people.map((person) => ({
          personId: person.id,
          validFrom: "2026-01-01",
          costRate: "500",
          saleRate: "800",
          reason: "Stejná testovací sazba",
          createdByUserId: actor.userId,
        })),
      )
      .returning();
    const rateByPersonId = new Map(
      rates.map((rate) => [rate.personId, rate]),
    );
    const sessions = await db
      .insert(workSessionsTable)
      .values([
        {
          personId: people[0].id,
          parentType: "job",
          parentIdSnapshot: jobId,
          jobId,
          startedAt: new Date("2026-06-27T08:00:00Z"),
          endedAt: new Date("2026-06-27T10:00:00Z"),
          durationSeconds: 7_200,
          status: "completed",
          source: "manual",
          hourlyRateId: rateByPersonId.get(people[0].id)!.id,
          costRateSnapshot: "500",
          saleRateSnapshot: "800",
        },
        {
          personId: people[1].id,
          parentType: "job",
          parentIdSnapshot: jobId,
          jobId,
          startedAt: new Date("2026-06-27T10:00:00Z"),
          endedAt: new Date("2026-06-27T11:30:00Z"),
          durationSeconds: 5_400,
          status: "completed",
          source: "manual",
          hourlyRateId: rateByPersonId.get(people[1].id)!.id,
          costRateSnapshot: "500",
          saleRateSnapshot: "800",
        },
      ])
      .returning();

    const summaryDraft = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        labourBillingMode: "recorded_time",
        workGrouping: "summary",
      },
      actor,
    );
    invoiceIds.push(summaryDraft.id);
    const summaryLines = (
      await db
        .select()
        .from(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, summaryDraft.id))
    ).filter((line) => line.sourceType === "work_session");
    const summaryReservations = await db
      .select()
      .from(workSessionBillingLinksTable)
      .where(eq(workSessionBillingLinksTable.invoiceId, summaryDraft.id));

    expect(summaryLines).toHaveLength(1);
    expect(Number(summaryLines[0].quantity)).toBe(3.5);
    expect(Number(summaryLines[0].unitPriceWithoutVat)).toBe(800);
    expect(Number(summaryLines[0].totalWithoutVat)).toBe(2_800);
    expect(summaryReservations).toHaveLength(2);

    const summaryReservationSnapshot = summaryReservations
      .map((link) => ({
        sessionId: link.sessionId,
        seconds: link.durationSecondsSnapshot,
        rate: Number(link.saleRateSnapshot),
        amount: Number(link.amountWithoutVatSnapshot),
      }))
      .sort((a, b) => a.sessionId - b.sessionId);
    expect(summaryReservationSnapshot.map((item) => item.sessionId)).toEqual(
      sessions.map((session) => session.id).sort((a, b) => a - b),
    );

    await deleteDraft(summaryDraft.id, actor);

    const workerDraft = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        labourBillingMode: "recorded_time",
        workGrouping: "worker",
      },
      actor,
    );
    invoiceIds.push(workerDraft.id);
    const workerLines = (
      await db
        .select()
        .from(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, workerDraft.id))
    ).filter((line) => line.sourceType === "work_session");
    const workerReservations = await db
      .select()
      .from(workSessionBillingLinksTable)
      .where(eq(workSessionBillingLinksTable.invoiceId, workerDraft.id));

    expect(workerLines).toHaveLength(2);
    expect(workerLines.map((line) => line.description)).toEqual(
      expect.arrayContaining(
        people.map((person) => expect.stringContaining(person.name)),
      ),
    );
    expect(
      workerLines.reduce(
        (total, line) => total + Number(line.totalWithoutVat),
        0,
      ),
    ).toBe(Number(summaryLines[0].totalWithoutVat));
    expect(workerDraft.subtotalWithoutVat).toBe(summaryDraft.subtotalWithoutVat);

    const workerReservationSnapshot = workerReservations
      .map((link) => ({
        sessionId: link.sessionId,
        seconds: link.durationSecondsSnapshot,
        rate: Number(link.saleRateSnapshot),
        amount: Number(link.amountWithoutVatSnapshot),
      }))
      .sort((a, b) => a.sessionId - b.sessionId);
    expect(workerReservationSnapshot).toEqual(summaryReservationSnapshot);
  });

  it("keeps two historical rates of one worker on separate summary lines", async () => {
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({ price: "0", pricingMode: "time_material" })
      .where(eq(jobsTable.id, jobId));
    const [person] = await db
      .insert(peopleTable)
      .values({ name: `Sazby ${TAG}` })
      .returning();
    personIds.push(person.id);
    const rates = await db
      .insert(personHourlyRatesTable)
      .values([
        {
          personId: person.id,
          validFrom: "2026-01-01",
          validTo: "2026-06-26",
          costRate: "500",
          saleRate: "800",
          reason: "Původní testovací sazba",
          createdByUserId: actor.userId,
        },
        {
          personId: person.id,
          validFrom: "2026-06-27",
          costRate: "600",
          saleRate: "1000",
          reason: "Nová testovací sazba",
          createdByUserId: actor.userId,
        },
      ])
      .returning();
    await db.insert(workSessionsTable).values([
      {
        personId: person.id,
        parentType: "job",
        parentIdSnapshot: jobId,
        jobId,
        startedAt: new Date("2026-06-26T08:00:00Z"),
        endedAt: new Date("2026-06-26T09:00:00Z"),
        durationSeconds: 3_600,
        status: "completed",
        source: "manual",
        hourlyRateId: rates[0].id,
        costRateSnapshot: "500",
        saleRateSnapshot: "800",
      },
      {
        personId: person.id,
        parentType: "job",
        parentIdSnapshot: jobId,
        jobId,
        startedAt: new Date("2026-06-27T08:00:00Z"),
        endedAt: new Date("2026-06-27T09:00:00Z"),
        durationSeconds: 3_600,
        status: "completed",
        source: "manual",
        hourlyRateId: rates[1].id,
        costRateSnapshot: "600",
        saleRateSnapshot: "1000",
      },
    ]);

    const draft = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        labourBillingMode: "recorded_time",
        workGrouping: "summary",
      },
      actor,
    );
    invoiceIds.push(draft.id);
    const workLines = (
      await db
        .select()
        .from(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, draft.id))
    ).filter((line) => line.sourceType === "work_session");
    const reservations = await db
      .select()
      .from(workSessionBillingLinksTable)
      .where(eq(workSessionBillingLinksTable.invoiceId, draft.id));

    expect(workLines).toHaveLength(2);
    expect(
      workLines
        .map((line) => Number(line.unitPriceWithoutVat))
        .sort((a, b) => a - b),
    ).toEqual([800, 1000]);
    expect(workLines.every((line) => Number(line.quantity) === 1)).toBe(true);
    expect(draft.subtotalWithoutVat).toBe(1_800);
    expect(reservations).toHaveLength(2);
  });

  it("does not synthesize recorded work from legacy job hour counters", async () => {
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({
        price: "0",
        pricingMode: "time_material",
        hoursVasek: "4.50",
        hoursJonas: "2.25",
      })
      .where(eq(jobsTable.id, jobId));

    const draft = await createDraft(
      {
        customerId,
        jobIds: [jobId],
        labourBillingMode: "recorded_time",
        workGrouping: "worker",
      },
      actor,
    );
    invoiceIds.push(draft.id);
    const workLines = (
      await db
        .select()
        .from(invoiceLinesTable)
        .where(eq(invoiceLinesTable.invoiceId, draft.id))
    ).filter((line) => line.sourceType === "work_session");
    const reservations = await db
      .select()
      .from(workSessionBillingLinksTable)
      .where(eq(workSessionBillingLinksTable.invoiceId, draft.id));

    expect(workLines).toHaveLength(0);
    expect(reservations).toHaveLength(0);
    expect(draft.subtotalWithoutVat).toBe(0);
  });

  it("keeps an explicit job transport cost instead of the default kilometre rate", async () => {
    await updateBillingSettings({ transportRatePerKm: 30 });
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({
        price: "0",
        pricingMode: "time_material",
        transportKm: "10",
        transportCost: "500",
      })
      .where(eq(jobsTable.id, jobId));

    const detail = await getUnbilledCustomerDetail(customerId);
    const detailJob = detail.jobs.find((job) => job.id === jobId);
    expect(detailJob?.transportCost).toBe(500);
    expect(detailJob?.transportCostCalculated).toBe(false);

    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);
    const lines = await db
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, draft.id));
    const transportLine = lines.find(
      (line) => line.sourceType === "transport",
    );
    expect(Number(transportLine?.totalWithoutVat)).toBe(500);
  });

  it("keeps a fixed-price job on its contract price in automatic mode", async () => {
    const jobId = await makeDoneJob();
    await db
      .update(jobsTable)
      .set({
        pricingMode: "fixed_price",
        contractPrice: "9000",
        price: "9000",
      })
      .where(eq(jobsTable.id, jobId));

    const [person] = await db
      .insert(peopleTable)
      .values({ name: `Pracovník ${TAG}` })
      .returning();
    personIds.push(person.id);
    const [rate] = await db
      .insert(personHourlyRatesTable)
      .values({
        personId: person.id,
        validFrom: "2026-01-01",
        costRate: "500",
        saleRate: "800",
        reason: "Testovací sazba",
        createdByUserId: actor.userId,
      })
      .returning();
    await db.insert(workSessionsTable).values({
      personId: person.id,
      parentType: "job",
      parentIdSnapshot: jobId,
      jobId,
      startedAt: new Date("2026-06-27T08:00:00Z"),
      endedAt: new Date("2026-06-27T11:00:00Z"),
      durationSeconds: 10_800,
      status: "completed",
      source: "manual",
      hourlyRateId: rate.id,
      costRateSnapshot: "500",
      saleRateSnapshot: "800",
    });

    const draft = await createDraft({ customerId, jobIds: [jobId] }, actor);
    invoiceIds.push(draft.id);
    const lines = await db
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, draft.id));

    expect(
      lines.some(
        (line) =>
          line.sourceType === "job" &&
          Number(line.totalWithoutVat) === 9000,
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.sourceType === "work_session"),
    ).toBe(false);
  });

  it("reserves recorded sessions once and releases them when the draft is deleted", async () => {
    const jobId = await makeDoneJob();
    const [person] = await db.insert(peopleTable).values({ name: `Pracovník ${TAG}` }).returning();
    personIds.push(person.id);
    const [rate] = await db.insert(personHourlyRatesTable).values({
      personId: person.id,
      validFrom: "2026-01-01",
      costRate: "500",
      saleRate: "800",
      reason: "Testovací sazba",
      createdByUserId: actor.userId,
    }).returning();
    const [session] = await db.insert(workSessionsTable).values({
      personId: person.id,
      parentType: "job",
      parentIdSnapshot: jobId,
      jobId,
      startedAt: new Date("2026-06-27T08:00:00Z"),
      endedAt: new Date("2026-06-27T11:00:00Z"),
      durationSeconds: 10_800,
      status: "completed",
      source: "manual",
      hourlyRateId: rate.id,
      costRateSnapshot: "500",
      saleRateSnapshot: "800",
    }).returning();

    const results = await Promise.allSettled([
      createDraft({ customerId, jobIds: [jobId], labourBillingMode: "recorded_time" }, actor),
      createDraft({ customerId, jobIds: [jobId], labourBillingMode: "recorded_time" }, actor),
    ]);
    const created = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createDraft>>> => result.status === "fulfilled");
    expect(created).toHaveLength(1);
    invoiceIds.push(created[0].value.id);

    const [reserved] = await db.select().from(workSessionsTable).where(eq(workSessionsTable.id, session.id));
    expect(reserved.billingStatus).toBe("ready");
    const workLines = await db.select().from(invoiceLinesTable).where(eq(invoiceLinesTable.invoiceId, created[0].value.id));
    expect(workLines.some((line) => line.sourceType === "work_session" && Number(line.quantity) === 3 && Number(line.unitPriceWithoutVat) === 800)).toBe(true);

    await deleteDraft(created[0].value.id);
    invoiceIds.length = 0;
    const [released] = await db.select().from(workSessionsTable).where(eq(workSessionsTable.id, session.id));
    expect(released.billingStatus).toBe("unbilled");
    const [link] = await db.select().from(workSessionBillingLinksTable).where(eq(workSessionBillingLinksTable.sessionId, session.id));
    expect(link.status).toBe("released");
  });
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
    const cancelled = await cancelInvoice(
      draft.id,
      { returnJobsToDone: true, reasonCode: "billing_error" },
      actor,
    );
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

    await cancelInvoice(
      draft.id,
      { returnJobsToDone: true, reasonCode: "billing_error" },
      actor,
    );

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
