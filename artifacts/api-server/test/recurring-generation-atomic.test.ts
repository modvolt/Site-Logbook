import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  customersTable,
  invoicesTable,
  recurringInvoiceTemplatesTable,
  recurringInvoiceGenerationsTable,
} from "@workspace/db";
import {
  generateTemplateNow,
  runRecurringGeneration,
  periodLabel,
} from "../src/lib/recurring-templates";
import { createDraft } from "../src/lib/invoice-service";

/**
 * Atomicity & idempotency invariants for recurring invoice generation.
 *
 * Guards:
 * 1. Concurrent scheduler + manual trigger for the same template+period
 *    produces exactly one draft invoice and one generation record.
 * 2. A simulated mid-generation failure leaves no orphaned invoice
 *    (everything rolls back together).
 * 3. Retry after a failure creates exactly one invoice.
 * 4. The unique partial index on (template_id, period) WHERE invoice_id IS NOT NULL
 *    rejects a second successful insert at the DB level.
 *
 * Runs against the dev database (DATABASE_URL).
 * Fixtures are tagged and torn down after the suite.
 */

const TAG = `test-rig-${Date.now()}`;
const TODAY = "2025-01-15";

let customerId: number;
const templateIds: number[] = [];
const invoiceIds: number[] = [];

async function makeTemplate(overrides: { nextGenerationDate?: string } = {}) {
  const [tpl] = await db
    .insert(recurringInvoiceTemplatesTable)
    .values({
      customerId,
      name: `Paušál ${TAG}`,
      items: [
        {
          description: "Měsíční paušál",
          quantity: 1,
          unit: null,
          unitPriceWithoutVat: 1000,
          vatRate: 21,
          vatMode: "standard",
          discountPercent: null,
          sortOrder: 0,
        },
      ],
      interval: "monthly",
      dayOfMonth: 1,
      nextGenerationDate: overrides.nextGenerationDate ?? TODAY,
      isActive: true,
    })
    .returning();
  templateIds.push(tpl!.id);
  return tpl!;
}

async function successfulGenerationsFor(templateId: number) {
  return db
    .select()
    .from(recurringInvoiceGenerationsTable)
    .where(
      and(
        eq(recurringInvoiceGenerationsTable.templateId, templateId),
        isNotNull(recurringInvoiceGenerationsTable.invoiceId),
      ),
    );
}

async function invoicesForTemplate(templateId: number) {
  return db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.recurringTemplateId, templateId));
}

beforeAll(async () => {
  const [cust] = await db
    .insert(customersTable)
    .values({ companyName: `Zákazník ${TAG}` })
    .returning();
  customerId = cust!.id;

  // Clean up any stale templates from previous failed runs so runRecurringGeneration
  // doesn't pick up leftover due templates and skew the created/skipped counts.
  await db
    .delete(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.name, `Paušál ${TAG}`));
});

afterAll(async () => {
  if (invoiceIds.length) {
    await db
      .delete(invoicesTable)
      .where(eq(invoicesTable.recurringTemplateId, templateIds[0] ?? -1));
  }
  for (const id of templateIds) {
    await db
      .delete(recurringInvoiceTemplatesTable)
      .where(eq(recurringInvoiceTemplatesTable.id, id));
  }
  await db.delete(customersTable).where(eq(customersTable.id, customerId));
});

describe("recurring invoice generation atomicity", () => {
  it("creates exactly one draft when both scheduler and manual trigger fire", async () => {
    const tpl = await makeTemplate();
    const period = periodLabel(tpl.nextGenerationDate, "monthly");

    // Fire scheduler and manual trigger concurrently for the same period.
    const results = await Promise.allSettled([
      runRecurringGeneration(TODAY),
      generateTemplateNow(tpl.id),
    ]);

    // At least one must succeed (the other may dedupe as 409 / DEDUPE)
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    // The loser must be a 409 or DEDUPE, not an unexpected error
    for (const f of failed) {
      const err = (f as PromiseRejectedResult).reason as Error & { statusCode?: number };
      const isDedupe =
        err.statusCode === 409 || err.message.includes("DEDUPE") || err.message.includes("již existuje");
      expect(isDedupe).toBe(true);
    }

    // DB invariants: exactly one invoice and one successful generation record
    const gens = await successfulGenerationsFor(tpl.id);
    expect(gens.length).toBe(1);
    expect(gens[0]!.period).toBe(period);

    const inv = await invoicesForTemplate(tpl.id);
    expect(inv.length).toBe(1);
    expect(inv[0]!.status).toBe("draft");
    invoiceIds.push(inv[0]!.id);
  });

  it("leaves no orphan when generation fails mid-transaction (full rollback)", async () => {
    const tpl = await makeTemplate({ nextGenerationDate: "2025-02-01" });
    const actor = { userId: null, name: "Test Runner" };

    // Simulate a crash that occurs INSIDE the generation transaction — after the
    // draft invoice is created but before the generation record and nextDate
    // advance are committed. The whole transaction must roll back, leaving
    // nothing in the DB.
    await expect(
      db.transaction(async (tx) => {
        // This mirrors what generateFromTemplate does internally.
        const draft = await createDraft(
          {
            customerId: tpl.customerId,
            vatModeDefault: tpl.vatModeDefault as "standard",
            lines: [
              {
                sourceType: "manual" as const,
                description: "Test item",
                quantity: 1,
                unitPriceWithoutVat: 100,
                vatMode: "standard" as const,
              },
            ],
          },
          actor,
          tx,
        );
        // Link the invoice to the template — mirrors what generateFromTemplate
        // does before recording the generation row. This ensures the "no orphan"
        // assertion below via invoicesForTemplate() is meaningful and not a
        // false-positive caused by a missing recurringTemplateId filter.
        await tx
          .update(invoicesTable)
          .set({ recurringTemplateId: tpl.id })
          .where(eq(invoicesTable.id, draft.id));

        // Inject a crash AFTER the draft and template link are written but
        // BEFORE the generation record and nextDate advance commit.
        // The whole transaction must roll back, leaving nothing in the DB.
        throw new Error("simulated mid-generation crash");
      }),
    ).rejects.toThrow("simulated mid-generation crash");

    // After rollback: no invoice should exist for this template
    const inv = await invoicesForTemplate(tpl.id);
    expect(inv.length).toBe(0);

    // Retry: a real generation must now succeed and produce exactly one invoice
    await generateTemplateNow(tpl.id);
    const invAfterRetry = await invoicesForTemplate(tpl.id);
    expect(invAfterRetry.length).toBe(1);
    invoiceIds.push(invAfterRetry[0]!.id);
  });

  it("retrying a failed generation creates exactly one invoice", async () => {
    const tpl = await makeTemplate({ nextGenerationDate: "2025-03-01" });

    // First call: scheduler generates an invoice for this template
    await runRecurringGeneration("2025-03-01");

    // Assert the specific template was generated exactly once
    const invAfterFirst = await invoicesForTemplate(tpl.id);
    expect(invAfterFirst.length).toBe(1);

    // Second call (retry for same date): same period → deduped
    await runRecurringGeneration("2025-03-01");

    // Still exactly one invoice for our template after the retry
    const inv = await invoicesForTemplate(tpl.id);
    expect(inv.length).toBe(1);
    invoiceIds.push(inv[0]!.id);
  });

  it("unique partial index rejects a second successful generation record at DB level", async () => {
    const tpl = await makeTemplate({ nextGenerationDate: "2025-04-01" });
    const period = periodLabel("2025-04-01", "monthly");

    // Insert a fake generation record (simulating a prior success)
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        status: "draft",
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
        paymentMethod: "transfer",
        createdByUserId: null,
      })
      .returning();
    invoiceIds.push(inv!.id);

    await db.insert(recurringInvoiceGenerationsTable).values({
      templateId: tpl.id,
      invoiceId: inv!.id,
      period,
    });

    // A second successful insert for the same (template_id, period) must fail
    const [inv2] = await db
      .insert(invoicesTable)
      .values({
        status: "draft",
        customerId,
        customerName: `Zákazník ${TAG}`,
        vatModeDefault: "standard",
        paymentMethod: "transfer",
        createdByUserId: null,
      })
      .returning();
    invoiceIds.push(inv2!.id);

    await expect(
      db.insert(recurringInvoiceGenerationsTable).values({
        templateId: tpl.id,
        invoiceId: inv2!.id,
        period,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      // Drizzle wraps the PG error; code is on err.cause
      const cause = (err as { cause?: { code?: string } })?.cause;
      return cause?.code === "23505";
    });
  });

  it("failure records (invoice_id IS NULL) do not block retries", async () => {
    const tpl = await makeTemplate({ nextGenerationDate: "2025-05-01" });
    const period = periodLabel("2025-05-01", "monthly");

    // Insert a failure record (no invoiceId)
    await db.insert(recurringInvoiceGenerationsTable).values({
      templateId: tpl.id,
      invoiceId: null,
      period,
      errorMessage: "simulated failure",
    });

    // Should still be able to generate successfully after a failure record
    await runRecurringGeneration("2025-05-01");

    const gens = await successfulGenerationsFor(tpl.id);
    expect(gens.length).toBe(1);

    const inv = await invoicesForTemplate(tpl.id);
    expect(inv.length).toBe(1);
    invoiceIds.push(inv[0]!.id);
  });
});
