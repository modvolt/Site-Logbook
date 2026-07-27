import { and, eq, ne } from "drizzle-orm";
import {
  auditLogTable,
  db,
  invoicesTable,
  invoiceSourceLinksTable,
  jobsTable,
} from "@workspace/db";

export type JobBillingIntent = "billable" | "not_billable";

export class JobBillingIntentError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = "JobBillingIntentError";
  }
}

export async function updateJobBillingIntent(
  jobId: number,
  input: { billingIntent: JobBillingIntent; reason?: string | null },
  actor: { userId: number; name: string },
) {
  const reason =
    input.billingIntent === "not_billable" ? input.reason?.trim() ?? "" : null;
  if (
    input.billingIntent === "not_billable" &&
    (reason == null || reason.length < 3)
  ) {
    throw new JobBillingIntentError(
      "Uveďte důvod, proč se zakázka nebude fakturovat.",
      400,
      "billing_exclusion_reason_required",
    );
  }
  if (reason != null && reason.length > 500) {
    throw new JobBillingIntentError(
      "Důvod může mít nejvýše 500 znaků.",
      400,
      "billing_exclusion_reason_too_long",
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .for("update");
    if (!existing) {
      throw new JobBillingIntentError(
        "Zakázka nebyla nalezena.",
        404,
        "job_not_found",
      );
    }

    const normalizedReason = reason || null;
    if (
      existing.billingIntent === input.billingIntent &&
      existing.billingExclusionReason === normalizedReason
    ) {
      return existing;
    }

    const [liveInvoice] = await tx
      .select({
        invoiceId: invoicesTable.id,
        invoiceNumber: invoicesTable.invoiceNumber,
      })
      .from(invoiceSourceLinksTable)
      .innerJoin(
        invoicesTable,
        eq(invoiceSourceLinksTable.invoiceId, invoicesTable.id),
      )
      .where(
        and(
          eq(invoiceSourceLinksTable.jobId, jobId),
          ne(invoicesTable.status, "cancelled"),
        ),
      )
      .limit(1);
    if (liveInvoice || existing.status === "vyfakturovano") {
      const invoiceLabel = liveInvoice?.invoiceNumber
        ? ` ${liveInvoice.invoiceNumber}`
        : liveInvoice?.invoiceId
          ? ` #${liveInvoice.invoiceId}`
          : "";
      throw new JobBillingIntentError(
        `Zakázka je navázaná na fakturu${invoiceLabel}. Nejprve zrušte koncept nebo stornujte fakturu.`,
        409,
        "job_has_live_invoice",
      );
    }

    const changedAt = new Date();
    const [updated] = await tx
      .update(jobsTable)
      .set({
        billingIntent: input.billingIntent,
        billingExclusionReason: normalizedReason,
        billingIntentChangedAt: changedAt,
        billingIntentChangedByUserId: actor.userId,
      })
      .where(eq(jobsTable.id, jobId))
      .returning();

    await tx.insert(auditLogTable).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "job_billing_intent_changed",
      entityType: "jobs",
      entityId: jobId,
      method: "PATCH",
      path: `/jobs/${jobId}/billing-intent`,
      summary: JSON.stringify({
        from: existing.billingIntent,
        to: input.billingIntent,
        reason: normalizedReason,
      }),
    });

    return updated;
  });
}
