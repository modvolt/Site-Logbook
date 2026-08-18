import { describe, expect, it } from "vitest";
import {
  AUDIT_CHAIN_STREAM_ID,
  appendAuditEventInTransaction,
  canonicalAuditChainRecordJson,
  canonicalAuditExportIntentJson,
  createAuditChainRecord,
  createAuditExportIntent,
  verifyAuditChainHead,
  verifyAuditChainRecord,
  verifyAuditExportIntent,
  type AuditChainHeadTransitionV1,
  type AuditChainHeadV1,
  type AuditChainRecordV1,
  type AuditChainTransactionV1,
  type AuditExportIntentV1,
} from "../src/lib/audit-chain-contract";
import {
  auditProjectionSha256,
  createAuditEventEnvelope,
  type AuditEventEnvelopeV1,
  type AuditEventInputV1,
} from "../src/lib/audit-event-envelope";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function eventInput(
  eventId = "018f6f8e-7c20-7a4b-8c4d-1234567890ab",
): AuditEventInputV1 {
  const before = { id: 123, notePresent: false };
  const after = { id: 123, notePresent: true };
  return {
    eventId,
    occurredAt: "2026-08-11T10:11:12.345Z",
    actor: {
      kind: "user",
      id: "user:42",
      authentication: "session",
      delegatedById: null,
    },
    source: {
      kind: "api",
      component: "api-server",
      operation: "job.note.update",
      buildRevision: "1".repeat(40),
      requestIdSha256: SHA_A,
    },
    action: { code: "job.note.update", outcome: "succeeded" },
    entity: { type: "job", id: "123", version: "7" },
    reason: { code: null, detailArtifactRef: null, detailSha256: null },
    state: {
      before: {
        availability: "present",
        completeness: "complete",
        projection: "job.audit/v1",
        data: before,
        sha256: auditProjectionSha256("job.audit/v1", before),
        missingFields: [],
        reason: null,
      },
      after: {
        availability: "present",
        completeness: "complete",
        projection: "job.audit/v1",
        data: after,
        sha256: auditProjectionSha256("job.audit/v1", after),
        missingFields: [],
        reason: null,
      },
    },
    correlation: {
      correlationIdSha256: SHA_A,
      causationEventSha256: null,
      idempotencyKeySha256: SHA_B,
    },
    artifactRefs: [],
  };
}

function event(eventId?: string): AuditEventEnvelopeV1 {
  return createAuditEventEnvelope(eventInput(eventId));
}

class RecordingTransaction implements AuditChainTransactionV1 {
  readonly calls: string[] = [];
  event: AuditEventEnvelopeV1 | null = null;
  record: AuditChainRecordV1 | null = null;
  intent: AuditExportIntentV1 | null = null;
  transition: AuditChainHeadTransitionV1 | null = null;

  constructor(
    private readonly head: AuditChainHeadV1 | null = null,
    private readonly advanceResult = true,
    private readonly failAt: "event" | "record" | "intent" | null = null,
  ) {}

  async lockHeadForUpdate() {
    this.calls.push("lock-head");
    return this.head;
  }

  async insertEventEnvelope(value: AuditEventEnvelopeV1) {
    this.calls.push("insert-event");
    if (this.failAt === "event") throw new Error("event insert failed");
    this.event = value;
  }

  async insertLedgerRecord(value: AuditChainRecordV1) {
    this.calls.push("insert-ledger");
    if (this.failAt === "record") throw new Error("ledger insert failed");
    this.record = value;
  }

  async insertExportIntent(value: AuditExportIntentV1) {
    this.calls.push("insert-export-intent");
    if (this.failAt === "intent") throw new Error("intent insert failed");
    this.intent = value;
  }

  async compareAndAdvanceHead(value: AuditChainHeadTransitionV1) {
    this.calls.push("advance-head");
    this.transition = value;
    return this.advanceResult;
  }
}

describe("audit chain transaction contract v1", () => {
  it("creates a deterministic genesis record and a bound export intent", () => {
    const envelope = event();
    const record = createAuditChainRecord(envelope, null);
    const intent = createAuditExportIntent(record);

    expect(record).toMatchObject({
      schemaVersion: "site-logbook.audit-chain-record/v1",
      streamId: AUDIT_CHAIN_STREAM_ID,
      sequence: "1",
      eventId: envelope.eventId,
      eventSha256: envelope.integrity.eventSha256,
      recordedAt: envelope.occurredAt,
      previousLedgerSha256: null,
    });
    expect(record.integrity.ledgerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent).toMatchObject({
      schemaVersion: "site-logbook.audit-export-intent/v1",
      intentId: envelope.eventId,
      kind: "audit-chain-export",
      throughSequence: "1",
      throughLedgerSha256: record.integrity.ledgerSha256,
      eventSha256: envelope.integrity.eventSha256,
      destination: {
        kind: "versioned-object-storage",
        namespace: "audit-evidence/v1",
        format: "site-logbook.audit-jsonl/v1",
      },
      initialState: "pending",
    });
    expect(intent.integrity.intentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(canonicalAuditChainRecordJson(record))).toEqual(record);
    expect(JSON.parse(canonicalAuditExportIntentJson(intent))).toEqual(intent);
  });

  it("links every later sequence to the exact previous ledger digest", () => {
    const first = createAuditChainRecord(event(), null);
    const head = verifyAuditChainHead({
      streamId: AUDIT_CHAIN_STREAM_ID,
      sequence: first.sequence,
      ledgerSha256: first.integrity.ledgerSha256,
    });
    const second = createAuditChainRecord(
      event("018f6f8e-7c20-7a4b-8c4d-1234567890ac"),
      head,
    );

    expect(second.sequence).toBe("2");
    expect(second.previousLedgerSha256).toBe(first.integrity.ledgerSha256);
    expect(second.integrity.ledgerSha256).not.toBe(
      first.integrity.ledgerSha256,
    );
  });

  it("rejects chain, event, outbox, and genesis mutations", () => {
    const record = createAuditChainRecord(event(), null);
    const intent = createAuditExportIntent(record);

    expect(() =>
      verifyAuditChainRecord({ ...record, eventSha256: "c".repeat(64) }),
    ).toThrow(/digest/i);
    expect(() =>
      verifyAuditExportIntent({ ...intent, throughSequence: "2" }),
    ).toThrow(/digest/i);
    expect(() =>
      verifyAuditChainRecord({
        ...record,
        previousLedgerSha256: "d".repeat(64),
      }),
    ).toThrow(/first audit chain record/i);
    expect(() =>
      verifyAuditChainHead({
        streamId: AUDIT_CHAIN_STREAM_ID,
        sequence: "0",
        ledgerSha256: "e".repeat(64),
      }),
    ).toThrow(/empty audit chain/i);
    expect(() =>
      verifyAuditChainRecord({ ...record, legacyOccurredAt: "2020-01-01" }),
    ).toThrow();
  });

  it("writes event, ledger record, export intent, and head under one transaction interface", async () => {
    const transaction = new RecordingTransaction();
    const result = await appendAuditEventInTransaction(transaction, event());

    expect(transaction.calls).toEqual([
      "lock-head",
      "insert-event",
      "insert-ledger",
      "insert-export-intent",
      "advance-head",
    ]);
    expect(transaction.event).toEqual(result.event);
    expect(transaction.record).toEqual(result.ledgerRecord);
    expect(transaction.intent).toEqual(result.exportIntent);
    expect(transaction.transition).toEqual(result.headTransition);
    expect(result.headTransition.expected).toEqual({
      streamId: AUDIT_CHAIN_STREAM_ID,
      sequence: "0",
      ledgerSha256: null,
    });
    expect(result.headTransition.next.ledgerSha256).toBe(
      result.ledgerRecord.integrity.ledgerSha256,
    );
  });

  it("fails closed on a head race or any intermediate write failure", async () => {
    const headRace = new RecordingTransaction(null, false);
    await expect(
      appendAuditEventInTransaction(headRace, event()),
    ).rejects.toThrow(/transaction must roll back/i);
    expect(headRace.calls).toEqual([
      "lock-head",
      "insert-event",
      "insert-ledger",
      "insert-export-intent",
      "advance-head",
    ]);

    const eventFailure = new RecordingTransaction(null, true, "event");
    await expect(
      appendAuditEventInTransaction(eventFailure, event()),
    ).rejects.toThrow("event insert failed");
    expect(eventFailure.calls).toEqual(["lock-head", "insert-event"]);

    const intentFailure = new RecordingTransaction(null, true, "intent");
    await expect(
      appendAuditEventInTransaction(intentFailure, event()),
    ).rejects.toThrow("intent insert failed");
    expect(intentFailure.calls).toEqual([
      "lock-head",
      "insert-event",
      "insert-ledger",
      "insert-export-intent",
    ]);
  });
});
