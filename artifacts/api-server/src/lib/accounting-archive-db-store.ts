import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  accountingPaymentEventsTable,
  accountingReasonArtifactsTable,
  accountingVersionRelationsTable,
  accountingWarehousePriceObservationsTable,
  db,
} from "@workspace/db";
import type {
  AccountingArchiveEntryBytes,
  AccountingArchiveEntryKind,
} from "./accounting-archive-contract";
import type {
  AccountingArchiveRepositoryPort,
  ClaimedAccountingArchiveIntent,
} from "./accounting-archive-worker";

function assertClaimedRow(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & {
  intent_id: string;
  attempt_count: number;
  canonical_json: string;
} {
  if (
    typeof value.intent_id !== "string" ||
    typeof value.canonical_json !== "string" ||
    !Number.isSafeInteger(value.attempt_count) ||
    Number(value.attempt_count) < 1
  ) {
    throw new Error("Claimed accounting archive outbox row is invalid.");
  }
}

async function loadCanonicalEntry(
  kind: AccountingArchiveEntryKind,
  id: string,
): Promise<string | null> {
  if (kind === "document-version") {
    const [row] = await db
      .select({ canonicalJson: accountingDocumentVersionsTable.canonicalJson })
      .from(accountingDocumentVersionsTable)
      .where(eq(accountingDocumentVersionsTable.id, id))
      .limit(1);
    return row?.canonicalJson ?? null;
  }
  if (kind === "lifecycle-event") {
    const [row] = await db
      .select({ canonicalJson: accountingLifecycleEventsTable.canonicalJson })
      .from(accountingLifecycleEventsTable)
      .where(eq(accountingLifecycleEventsTable.id, id))
      .limit(1);
    return row?.canonicalJson ?? null;
  }
  if (kind === "payment-event") {
    const [row] = await db
      .select({ canonicalJson: accountingPaymentEventsTable.canonicalJson })
      .from(accountingPaymentEventsTable)
      .where(eq(accountingPaymentEventsTable.id, id))
      .limit(1);
    return row?.canonicalJson ?? null;
  }
  if (
    kind === "warehouse-price-observation" ||
    kind === "warehouse-price-legacy-observation"
  ) {
    const [row] = await db
      .select({
        canonicalJson: accountingWarehousePriceObservationsTable.canonicalJson,
      })
      .from(accountingWarehousePriceObservationsTable)
      .where(eq(accountingWarehousePriceObservationsTable.id, id))
      .limit(1);
    return row?.canonicalJson ?? null;
  }
  if (kind === "reason-artifact") {
    const [row] = await db
      .select({ canonicalJson: accountingReasonArtifactsTable.canonicalJson })
      .from(accountingReasonArtifactsTable)
      .where(eq(accountingReasonArtifactsTable.id, id))
      .limit(1);
    return row?.canonicalJson ?? null;
  }
  const [row] = await db
    .select({ canonicalJson: accountingVersionRelationsTable.canonicalJson })
    .from(accountingVersionRelationsTable)
    .where(eq(accountingVersionRelationsTable.id, id))
    .limit(1);
  return row?.canonicalJson ?? null;
}

/**
 * PostgreSQL lease/CAS adapter for the R13 archive worker. It deliberately has
 * no storage dependency and does not start a worker; runtime activation remains
 * a later, separately gated cutover.
 */
export const accountingArchiveDbRepository: AccountingArchiveRepositoryPort = {
  async claimNext(input) {
    const leaseToken = randomUUID();
    return db.transaction(async (tx) => {
      const result = await tx.execute(sql<{
        intent_id: string;
        attempt_count: number;
        canonical_json: string;
      }>`
        with candidate as (
          select intent_id
          from accounting_export_outbox
          where (
            state = 'pending' and available_at <= ${input.now}
          ) or (
            state = 'exporting' and lease_expires_at <= ${input.now}
          )
          order by available_at, intent_id
          for update skip locked
          limit 1
        )
        update accounting_export_outbox as outbox
        set state = 'exporting',
            attempt_count = outbox.attempt_count + 1,
            lease_token = ${leaseToken},
            lease_expires_at = ${input.leaseExpiresAt},
            last_failure_category = null,
            updated_at = ${input.now}
        from candidate
        where outbox.intent_id = candidate.intent_id
        returning outbox.intent_id, outbox.attempt_count, outbox.canonical_json
      `);
      const row = result.rows[0];
      if (!row) return null;
      assertClaimedRow(row);
      return {
        intentId: row.intent_id,
        leaseToken,
        attemptCount: Number(row.attempt_count),
        canonicalIntentJson: row.canonical_json,
      } satisfies ClaimedAccountingArchiveIntent;
    });
  },

  async loadEntry(input): Promise<AccountingArchiveEntryBytes | null> {
    const canonicalJson = await loadCanonicalEntry(input.kind, input.id);
    return canonicalJson === null ? null : { ...input, canonicalJson };
  },

  async markExported(input) {
    const rows = await db
      .update(accountingExportOutboxTable)
      .set({
        state: "exported",
        leaseToken: null,
        leaseExpiresAt: null,
        manifestObjectKey: input.receipt.manifestObjectKey,
        manifestVersionId: input.receipt.manifestVersionId,
        manifestSha256: input.receipt.manifestSha256,
        bundleSha256: input.receipt.bundleSha256,
        checksumSha256: input.receipt.checksumSha256,
        exportedAt: input.exportedAt,
        deadLetteredAt: null,
        lastFailureCategory: null,
        updatedAt: input.exportedAt,
      })
      .where(
        and(
          eq(accountingExportOutboxTable.intentId, input.claim.intentId),
          eq(accountingExportOutboxTable.state, "exporting"),
          eq(accountingExportOutboxTable.leaseToken, input.claim.leaseToken),
          gt(accountingExportOutboxTable.leaseExpiresAt, input.exportedAt),
        ),
      )
      .returning({ intentId: accountingExportOutboxTable.intentId });
    return rows.length === 1;
  },

  async markFailed(input) {
    const deadLetter = !input.failure.retryable;
    const delaySeconds = Math.min(
      900,
      5 * 2 ** Math.max(0, input.claim.attemptCount - 1),
    );
    const rows = await db
      .update(accountingExportOutboxTable)
      .set({
        state: deadLetter ? "dead_letter" : "pending",
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: deadLetter
          ? input.failure.occurredAt
          : new Date(input.failure.occurredAt.valueOf() + delaySeconds * 1_000),
        deadLetteredAt: deadLetter ? input.failure.occurredAt : null,
        lastFailureCategory: input.failure.category,
        updatedAt: input.failure.occurredAt,
      })
      .where(
        and(
          eq(accountingExportOutboxTable.intentId, input.claim.intentId),
          eq(accountingExportOutboxTable.state, "exporting"),
          eq(accountingExportOutboxTable.leaseToken, input.claim.leaseToken),
          gt(
            accountingExportOutboxTable.leaseExpiresAt,
            input.failure.occurredAt,
          ),
        ),
      )
      .returning({ intentId: accountingExportOutboxTable.intentId });
    if (rows.length !== 1) return "lost_lease";
    return deadLetter ? "dead_letter" : "pending";
  },
};
