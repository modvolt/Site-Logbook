import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  db,
  recurringInvoiceTemplatesTable,
  recurringInvoiceGenerationsTable,
  invoicesTable,
  customersTable,
  type RecurringInvoiceTemplate,
  type RecurringTemplateItem,
} from "@workspace/db";
import { logger } from "./logger";
import { createDraft, type Actor } from "./invoice-service";
import { publishDomains } from "./live-updates";

type VatMode = "standard" | "reverse_charge" | "zero" | "non_vat";

export type { RecurringTemplateItem };

export interface RecurringTemplateCreateInput {
  customerId: number;
  name: string;
  items: RecurringTemplateItem[];
  interval: "monthly" | "quarterly" | "yearly";
  dayOfMonth: number;
  nextGenerationDate: string;
  isActive?: boolean;
  notes?: string | null;
  vatModeDefault?: string;
}

export interface RecurringTemplateUpdateInput {
  name?: string;
  items?: RecurringTemplateItem[];
  interval?: "monthly" | "quarterly" | "yearly";
  dayOfMonth?: number;
  nextGenerationDate?: string;
  isActive?: boolean;
  notes?: string | null;
  vatModeDefault?: string;
}

function appError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * Compute the next generation date after a successful run.
 * dayOfMonth is clamped to the actual last day of the resulting month.
 */
export function nextDateAfter(
  from: string,
  interval: "monthly" | "quarterly" | "yearly",
  dayOfMonth: number,
): string {
  const [year, month] = from.split("-").map(Number) as [number, number, number];
  let nextYear = year;
  let nextMonth = month;

  if (interval === "monthly") {
    nextMonth += 1;
  } else if (interval === "quarterly") {
    nextMonth += 3;
  } else {
    nextYear += 1;
  }

  if (nextMonth > 12) {
    nextYear += Math.floor((nextMonth - 1) / 12);
    nextMonth = ((nextMonth - 1) % 12) + 1;
  }

  const maxDay = new Date(nextYear, nextMonth, 0).getDate();
  const day = Math.min(dayOfMonth, maxDay);
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Build a billing period label for deduplication (e.g. "2025-01" for monthly,
 * "2025-Q1" for quarterly, "2025" for yearly).
 */
export function periodLabel(
  date: string,
  interval: "monthly" | "quarterly" | "yearly",
): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  if (interval === "monthly") return `${year}-${String(month).padStart(2, "0")}`;
  if (interval === "quarterly") return `${year}-Q${Math.ceil(month / 3)}`;
  return String(year);
}

export async function listRecurringTemplates() {
  const rows = await db
    .select({
      id: recurringInvoiceTemplatesTable.id,
      customerId: recurringInvoiceTemplatesTable.customerId,
      customerName: customersTable.companyName,
      name: recurringInvoiceTemplatesTable.name,
      items: recurringInvoiceTemplatesTable.items,
      interval: recurringInvoiceTemplatesTable.interval,
      dayOfMonth: recurringInvoiceTemplatesTable.dayOfMonth,
      nextGenerationDate: recurringInvoiceTemplatesTable.nextGenerationDate,
      isActive: recurringInvoiceTemplatesTable.isActive,
      lastGeneratedAt: recurringInvoiceTemplatesTable.lastGeneratedAt,
      notes: recurringInvoiceTemplatesTable.notes,
      vatModeDefault: recurringInvoiceTemplatesTable.vatModeDefault,
      createdAt: recurringInvoiceTemplatesTable.createdAt,
      updatedAt: recurringInvoiceTemplatesTable.updatedAt,
    })
    .from(recurringInvoiceTemplatesTable)
    .leftJoin(
      customersTable,
      eq(recurringInvoiceTemplatesTable.customerId, customersTable.id),
    )
    .orderBy(
      desc(recurringInvoiceTemplatesTable.isActive),
      recurringInvoiceTemplatesTable.nextGenerationDate,
      recurringInvoiceTemplatesTable.id,
    );
  return rows;
}

export async function getRecurringTemplateDetail(id: number) {
  const [row] = await db
    .select({
      id: recurringInvoiceTemplatesTable.id,
      customerId: recurringInvoiceTemplatesTable.customerId,
      customerName: customersTable.companyName,
      name: recurringInvoiceTemplatesTable.name,
      items: recurringInvoiceTemplatesTable.items,
      interval: recurringInvoiceTemplatesTable.interval,
      dayOfMonth: recurringInvoiceTemplatesTable.dayOfMonth,
      nextGenerationDate: recurringInvoiceTemplatesTable.nextGenerationDate,
      isActive: recurringInvoiceTemplatesTable.isActive,
      lastGeneratedAt: recurringInvoiceTemplatesTable.lastGeneratedAt,
      notes: recurringInvoiceTemplatesTable.notes,
      vatModeDefault: recurringInvoiceTemplatesTable.vatModeDefault,
      createdAt: recurringInvoiceTemplatesTable.createdAt,
      updatedAt: recurringInvoiceTemplatesTable.updatedAt,
    })
    .from(recurringInvoiceTemplatesTable)
    .leftJoin(
      customersTable,
      eq(recurringInvoiceTemplatesTable.customerId, customersTable.id),
    )
    .where(eq(recurringInvoiceTemplatesTable.id, id));

  if (!row) return null;

  const generations = await db
    .select({
      id: recurringInvoiceGenerationsTable.id,
      invoiceId: recurringInvoiceGenerationsTable.invoiceId,
      period: recurringInvoiceGenerationsTable.period,
      errorMessage: recurringInvoiceGenerationsTable.errorMessage,
      createdAt: recurringInvoiceGenerationsTable.createdAt,
      invoiceNumber: invoicesTable.invoiceNumber,
      invoiceStatus: invoicesTable.status,
      totalWithVat: invoicesTable.totalWithVat,
    })
    .from(recurringInvoiceGenerationsTable)
    .leftJoin(
      invoicesTable,
      eq(recurringInvoiceGenerationsTable.invoiceId, invoicesTable.id),
    )
    .where(eq(recurringInvoiceGenerationsTable.templateId, id))
    .orderBy(desc(recurringInvoiceGenerationsTable.createdAt));

  return { ...row, generations };
}

export async function createRecurringTemplate(input: RecurringTemplateCreateInput) {
  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, input.customerId));
  if (!customer) throw appError(400, "Zákazník nenalezen.");

  const [row] = await db
    .insert(recurringInvoiceTemplatesTable)
    .values({
      customerId: input.customerId,
      name: input.name,
      items: input.items,
      interval: input.interval,
      dayOfMonth: input.dayOfMonth,
      nextGenerationDate: input.nextGenerationDate,
      isActive: input.isActive ?? true,
      notes: input.notes ?? null,
      vatModeDefault: input.vatModeDefault ?? "standard",
    })
    .returning();
  return getRecurringTemplateDetail(row!.id);
}

export async function updateRecurringTemplate(
  id: number,
  input: RecurringTemplateUpdateInput,
) {
  const [existing] = await db
    .select({ id: recurringInvoiceTemplatesTable.id })
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, id));
  if (!existing) throw appError(404, "Šablona nenalezena.");

  await db
    .update(recurringInvoiceTemplatesTable)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.items !== undefined && { items: input.items }),
      ...(input.interval !== undefined && { interval: input.interval }),
      ...(input.dayOfMonth !== undefined && { dayOfMonth: input.dayOfMonth }),
      ...(input.nextGenerationDate !== undefined && {
        nextGenerationDate: input.nextGenerationDate,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.vatModeDefault !== undefined && {
        vatModeDefault: input.vatModeDefault,
      }),
      updatedAt: new Date(),
    })
    .where(eq(recurringInvoiceTemplatesTable.id, id));

  return getRecurringTemplateDetail(id);
}

export async function deleteRecurringTemplate(id: number): Promise<boolean> {
  const [existing] = await db
    .select({ id: recurringInvoiceTemplatesTable.id })
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, id));
  if (!existing) return false;

  await db
    .delete(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, id));
  return true;
}

/**
 * Process all due templates and create draft invoices for them.
 * Returns counts for logging/monitoring.
 */
export async function runRecurringGeneration(today: string): Promise<{
  processed: number;
  created: number;
  skipped: number;
  failed: number;
}> {
  const dueTemplates = await db
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(
      and(
        eq(recurringInvoiceTemplatesTable.isActive, true),
        lte(recurringInvoiceTemplatesTable.nextGenerationDate, today),
      ),
    );

  let processed = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const template of dueTemplates) {
    processed++;
    const period = periodLabel(
      template.nextGenerationDate,
      template.interval as "monthly" | "quarterly" | "yearly",
    );

    try {
      await generateFromTemplate(template, period, today);
      created++;
      // Emit after each successful generation so open billing/recurring-templates
      // and billing/invoices screens refresh without a manual reload.
      publishDomains(["billingRecurringTemplates", "billingInvoices", "customers"]);
    } catch (err) {
      if (err instanceof Error && err.message.includes("DEDUPE")) {
        skipped++;
      } else {
        failed++;
        const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        logger.warn(
          { err, templateId: template.id, period },
          "Recurring invoice generation failed",
        );
        // Record the failure in the generation log so it surfaces on the template detail page
        try {
          await db.insert(recurringInvoiceGenerationsTable).values({
            templateId: template.id,
            invoiceId: null,
            period,
            errorMessage,
          });
        } catch (insertErr) {
          logger.warn(
            { insertErr, templateId: template.id, period },
            "Failed to record recurring generation error",
          );
        }
      }
    }
  }

  return { processed, created, skipped, failed };
}

/**
 * Manually generate a draft invoice for a single template right now,
 * bypassing the nextGenerationDate check. Still deduplicates by period.
 * Throws with statusCode 404 if not found, 409 if already generated for this period.
 */
export async function generateTemplateNow(id: number): Promise<{ invoiceId: number; period: string }> {
  const [template] = await db
    .select()
    .from(recurringInvoiceTemplatesTable)
    .where(eq(recurringInvoiceTemplatesTable.id, id));

  if (!template) throw appError(404, "Šablona nenalezena.");

  const period = periodLabel(
    template.nextGenerationDate,
    template.interval as "monthly" | "quarterly" | "yearly",
  );
  const today = new Date().toISOString().split("T")[0]!;
  return generateFromTemplate(template, period, today, true);
}

/** Returns true when a PostgreSQL error is a unique-constraint violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

async function generateFromTemplate(
  template: RecurringInvoiceTemplate,
  period: string,
  today: string,
  manualTrigger?: boolean,
): Promise<{ invoiceId: number; period: string }> {
  // Use an advisory lock keyed on the template id to serialize concurrent
  // generation attempts for the same template. The lock is held for the
  // duration of the outer transaction, so a second concurrent caller will
  // block on pg_advisory_xact_lock and only proceed after the first commits
  // — at which point the dedup check or the unique partial index on
  // (template_id, period) will reject the duplicate.
  // The unique index is the ultimate DB-level guarantee; the advisory lock +
  // application-level dedup check avoid unnecessary work in the common case.
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${template.id})`);

      // Dedupe: abort if a successful draft for this period already exists.
      // Failure records (invoice_id IS NULL) are informational and don't block retries.
      const [existing] = await tx
        .select({ id: recurringInvoiceGenerationsTable.id })
        .from(recurringInvoiceGenerationsTable)
        .where(
          and(
            eq(recurringInvoiceGenerationsTable.templateId, template.id),
            eq(recurringInvoiceGenerationsTable.period, period),
            isNotNull(recurringInvoiceGenerationsTable.invoiceId),
          ),
        );
      if (existing) {
        if (manualTrigger) {
          // For manual triggers, surface a 409 so the UI can show a clear message.
          // Do NOT advance nextGenerationDate — the admin triggered this manually,
          // so the scheduled date should remain intact.
          throw appError(409, `Koncept faktury pro období ${period} již existuje.`);
        }
        // Scheduler path: advance nextGenerationDate so we don't get stuck
        await tx
          .update(recurringInvoiceTemplatesTable)
          .set({
            nextGenerationDate: nextDateAfter(
              template.nextGenerationDate,
              template.interval as "monthly" | "quarterly" | "yearly",
              template.dayOfMonth,
            ),
            updatedAt: new Date(),
          })
          .where(eq(recurringInvoiceTemplatesTable.id, template.id));
        throw new Error("DEDUPE");
      }

      // Build line items from template items
      const lines = (template.items as RecurringTemplateItem[]).map((item) => ({
        sourceType: "manual" as const,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit ?? undefined,
        unitPriceWithoutVat: item.unitPriceWithoutVat,
        vatRate: item.vatRate ?? undefined,
        vatMode: item.vatMode as VatMode,
        discountPercent: item.discountPercent ?? undefined,
      }));

      // Create the draft invoice within the same transaction so the whole
      // generation is atomic: invoice, lines, generation record, and nextDate
      // advance all commit together or all roll back.
      const systemActor: Actor = { userId: null, name: "Systém (paušál)" };
      const draft = await createDraft(
        {
          customerId: template.customerId,
          vatModeDefault: template.vatModeDefault as
            | "standard"
            | "reverse_charge"
            | "zero"
            | "non_vat",
          notes: template.notes ?? undefined,
          lines,
        },
        systemActor,
        tx,
      );

      if (!draft) throw new Error("createDraft returned null");

      // Link the invoice to the template
      await tx
        .update(invoicesTable)
        .set({ recurringTemplateId: template.id })
        .where(eq(invoicesTable.id, draft.id));

      // Record the generation for dedup.
      // The unique partial index on (template_id, period) WHERE invoice_id IS NOT NULL
      // guarantees at the DB level that only one successful generation exists per
      // template+period, even under concurrent inserts.
      await tx.insert(recurringInvoiceGenerationsTable).values({
        templateId: template.id,
        invoiceId: draft.id,
        period,
      });

      // Advance nextGenerationDate
      const next = nextDateAfter(
        template.nextGenerationDate,
        template.interval as "monthly" | "quarterly" | "yearly",
        template.dayOfMonth,
      );
      await tx
        .update(recurringInvoiceTemplatesTable)
        .set({
          nextGenerationDate: next,
          lastGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recurringInvoiceTemplatesTable.id, template.id));

      return { invoiceId: draft.id, period };
    });
  } catch (err) {
    // Treat a unique-constraint violation on (template_id, period) as a
    // successful dedup — the generation already happened concurrently.
    if (isUniqueViolation(err)) {
      if (manualTrigger) {
        throw appError(409, `Koncept faktury pro období ${period} již existuje.`);
      }
      throw new Error("DEDUPE");
    }
    throw err;
  }
}

let schedulerStarted = false;

/**
 * Start the daily recurring invoice generation scheduler.
 * Runs once per day (configurable via RECURRING_CHECK_INTERVAL_HOURS env).
 */
export function startRecurringInvoiceScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const hours = Number(process.env.RECURRING_CHECK_INTERVAL_HOURS);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;

  const tick = () => {
    const today = new Date().toISOString().split("T")[0]!;
    return runRecurringGeneration(today)
      .then(({ processed, created, skipped, failed }) => {
        if (processed > 0) {
          logger.info(
            { processed, created, skipped, failed },
            "Recurring invoice generation sweep",
          );
        }
      })
      .catch((err) =>
        logger.error({ err }, "Recurring invoice generation sweep failed"),
      );
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  // Run shortly after startup
  const initial = setTimeout(tick, 30_000);
  initial.unref();

  logger.info(
    { intervalHours: intervalMs / (60 * 60 * 1000) },
    "Recurring invoice scheduler started",
  );
}
