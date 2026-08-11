import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditChainHeadsTable,
  auditEventsTable,
  auditExportOutboxTable,
  db,
  type AuditChainHeadRow,
} from "@workspace/db";
import {
  AUDIT_CHAIN_STREAM_ID,
  canonicalAuditChainRecordJson,
  canonicalAuditExportIntentJson,
  verifyAuditChainHead,
  verifyAuditChainRecord,
  verifyAuditExportIntent,
  type AuditChainTransactionV1,
} from "./audit-chain-contract";
import {
  canonicalAuditEventJson,
  verifyAuditEventEnvelope,
} from "./audit-event-envelope";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function databaseTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Audit timestamp is not an exact UTC instant.");
  }
  return parsed;
}

export function auditHeadFromRow(row: AuditChainHeadRow) {
  return verifyAuditChainHead({
    streamId: row.streamId,
    sequence: row.sequence.toString(),
    ledgerSha256: row.ledgerSha256,
  });
}

/**
 * Maps the canonical R09 writer to an already-open domain transaction. This
 * adapter intentionally has no commit, rollback, transaction factory, or
 * general database escape hatch.
 */
export function createAuditChainDbAdapter(tx: Tx): AuditChainTransactionV1 {
  return {
    async lockHeadForUpdate(streamId) {
      if (streamId !== AUDIT_CHAIN_STREAM_ID) {
        throw new Error("Unknown audit chain stream.");
      }
      const rows = await tx
        .select()
        .from(auditChainHeadsTable)
        .where(eq(auditChainHeadsTable.streamId, streamId))
        .for("update");
      if (rows.length === 0) return null;
      if (rows.length !== 1) {
        throw new Error("Audit chain stream has multiple head rows.");
      }
      return auditHeadFromRow(rows[0]!);
    },

    async insertEventAndLedger(eventValue, recordValue) {
      const event = verifyAuditEventEnvelope(eventValue);
      const record = verifyAuditChainRecord(recordValue);
      if (
        record.streamId !== AUDIT_CHAIN_STREAM_ID ||
        record.eventId !== event.eventId ||
        record.eventSha256 !== event.integrity.eventSha256 ||
        record.recordedAt !== event.occurredAt
      ) {
        throw new Error(
          "Audit event and ledger record do not describe the same evidence.",
        );
      }
      await tx.insert(auditEventsTable).values({
        eventId: event.eventId,
        streamId: record.streamId,
        sequence: BigInt(record.sequence),
        occurredAt: databaseTimestamp(event.occurredAt),
        canonicalEventJson: canonicalAuditEventJson(event),
        eventSha256: event.integrity.eventSha256,
        canonicalLedgerJson: canonicalAuditChainRecordJson(record),
        previousLedgerSha256: record.previousLedgerSha256,
        ledgerSha256: record.integrity.ledgerSha256,
      });
    },

    async insertExportIntent(intentValue) {
      const intent = verifyAuditExportIntent(intentValue);
      await tx.insert(auditExportOutboxTable).values({
        intentId: intent.intentId,
        eventId: intent.eventId,
        streamId: intent.streamId,
        throughSequence: BigInt(intent.throughSequence),
        throughLedgerSha256: intent.throughLedgerSha256,
        eventSha256: intent.eventSha256,
        intentCreatedAt: databaseTimestamp(intent.createdAt),
        canonicalJson: canonicalAuditExportIntentJson(intent),
        intentSha256: intent.integrity.intentSha256,
      });
    },

    async compareAndAdvanceHead(transition) {
      const expected = verifyAuditChainHead(transition.expected);
      const next = verifyAuditChainHead(transition.next);
      if (
        expected.streamId !== next.streamId ||
        BigInt(next.sequence) !== BigInt(expected.sequence) + 1n ||
        next.ledgerSha256 === null
      ) {
        throw new Error("Audit chain head CAS transition is invalid.");
      }
      const expectedDigest =
        expected.ledgerSha256 === null
          ? isNull(auditChainHeadsTable.ledgerSha256)
          : eq(auditChainHeadsTable.ledgerSha256, expected.ledgerSha256);
      const rows = await tx
        .update(auditChainHeadsTable)
        .set({
          sequence: BigInt(next.sequence),
          ledgerSha256: next.ledgerSha256,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(auditChainHeadsTable.streamId, expected.streamId),
            eq(auditChainHeadsTable.sequence, BigInt(expected.sequence)),
            expectedDigest,
          ),
        )
        .returning();
      if (rows.length === 0) return false;
      if (rows.length !== 1) {
        throw new Error("Audit chain head CAS updated multiple rows.");
      }
      const stored = auditHeadFromRow(rows[0]!);
      if (!isDeepStrictEqual(stored, next)) {
        throw new Error("Audit chain head CAS stored an unexpected state.");
      }
      return true;
    },
  };
}
