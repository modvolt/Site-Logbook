import { describe, expect, it } from "vitest";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
  type AccountingSnapshotV1,
} from "../src/lib/accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  createAccountingPaymentEvent,
  createAccountingVersionRelation,
  type AccountingPaymentEventV1,
} from "../src/lib/accounting-lifecycle-event-contract";
import {
  appendAccountingCorrectionBundleInTransaction,
  appendAccountingLifecycleEventInTransaction,
  appendAccountingPaymentEventInTransaction,
  appendInitialAccountingVersionInTransaction,
  canonicalAccountingExportIntentJson,
  verifyAccountingExportIntent,
  verifyCanonicalAccountingExportIntentJsonBytes,
  type AccountingAggregateRefV1,
  type AccountingAggregateStateTransitionV1,
  type AccountingAggregateStateV1,
  type AccountingExportIntentV1,
  type AccountingPersistenceTransactionV1,
} from "../src/lib/accounting-persistence-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const EFFECTIVE_AT = "2042-03-04T10:00:00.000Z";
const RECORDED_AT = "2042-03-04T10:01:00.000Z";
const LATER = "2042-03-04T10:02:00.000Z";
const actor = {
  kind: "user" as const,
  id: "7",
  authentication: "step-up" as const,
};

function invoiceSnapshot(input: {
  id: string;
  documentType:
    | "invoice"
    | "credit_note"
    | "correction_invoice"
    | "cancellation_notice";
  negative?: boolean;
  legacyPayment?: boolean;
}): AccountingSnapshotV1 {
  const sign = input.negative ? "-" : "";
  return {
    kind: "outgoing-invoice",
    invoice: {
      id: input.id,
      invoiceNumber: `FV-2042-${input.id}`,
      documentType: input.documentType,
      issueDate: "2042-03-04",
      taxableSupplyDate: "2042-03-04",
      dueDate: "2042-03-18",
      currency: "CZK",
      paymentMethod: "bank_transfer",
      variableSymbol: input.id,
      constantSymbol: null,
      specificSymbol: null,
      vatModeDefault: "standard",
      materialDisplayMode: "detailed",
      notes: null,
    },
    customer: {
      name: "Customer s.r.o.",
      ic: null,
      dic: null,
      address: null,
      email: null,
      phone: null,
      customerId: "9",
    },
    supplier: {
      name: "MODVOLT s.r.o.",
      ic: null,
      dic: null,
      address: null,
      email: null,
      phone: null,
      bankAccount: null,
      iban: null,
      bic: null,
      vatPayer: true,
    },
    lines: [
      {
        position: 1,
        sourceLineId: null,
        sourceType: "job",
        sourceId: "77",
        jobId: "77",
        activityId: null,
        description: "Accounting line",
        quantity: "1",
        unit: "ks",
        unitPriceWithoutVat: `${sign}100`,
        discountPercent: null,
        vatRate: "21",
        vatMode: "standard",
        totalWithoutVat: `${sign}100`,
        totalVat: `${sign}21`,
        totalWithVat: `${sign}121`,
      },
    ],
    sourceLinks: [],
    totals: {
      subtotalWithoutVat: `${sign}100`,
      totalVat: `${sign}21`,
      totalWithVat: `${sign}121`,
    },
    legacyPaymentObservation: input.legacyPayment
      ? {
          paidDate: "2042-03-05",
          paidAmount: "121",
          historicalCompleteness: "unknown",
        }
      : null,
  };
}

function version(
  input: {
    id?: string;
    versionId?: string;
    version?: string;
    purpose?:
      | "issued"
      | "credit"
      | "correction"
      | "cancellation_notice"
      | "legacy_observation";
    documentType?:
      | "invoice"
      | "credit_note"
      | "correction_invoice"
      | "cancellation_notice";
    supersedesVersionId?: string | null;
    negative?: boolean;
    legacy?: boolean;
  } = {},
): AccountingDocumentVersionV1 {
  const id = input.id ?? "42";
  const versionId = input.versionId ?? "11111111-1111-4111-8111-111111111111";
  const snapshot = invoiceSnapshot({
    id,
    documentType: input.documentType ?? "invoice",
    negative: input.negative,
    legacyPayment: input.legacy,
  });
  const legacy = input.legacy === true;
  return createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId,
    aggregate: { kind: "outgoing-invoice", id },
    version: input.version ?? "1",
    purpose: input.purpose ?? (legacy ? "legacy_observation" : "issued"),
    supersedesVersionId: input.supersedesVersionId ?? null,
    historicalCompleteness: legacy ? "unknown" : "complete",
    effectiveAt: legacy ? null : EFFECTIVE_AT,
    recordedAt: RECORDED_AT,
    snapshot,
    artifacts: [
      {
        artifactId: versionId,
        role: "rendered-pdf",
        mediaType: "application/pdf",
        contentSha256: HASH_A,
        sizeBytes: "1024",
        objectLocationSha256: HASH_B,
        rendererVersion: "invoice-pdf/v1",
      },
    ],
    provenance: legacy
      ? {
          captureMode: "legacy-observation",
          sourceMode: "legacy_unknown",
          recordedBy: {
            kind: "system",
            id: "accounting-backfill",
            authentication: "migration",
          },
          approvalEvidenceSha256: null,
          fieldProvenance: [],
        }
      : {
          captureMode: "native",
          sourceMode: "human",
          recordedBy: actor,
          approvalEvidenceSha256: HASH_C,
          fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
            source: "human",
            actorRef: "user:7",
            sourceEvidenceSha256: null,
            extractionRunId: null,
            recordedAt: EFFECTIVE_AT,
          }),
        },
  });
}

function initialEvent(documentVersion = version()) {
  return createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: "22222222-2222-4222-8222-222222222222",
    aggregate: {
      ...documentVersion.aggregate,
      versionId: documentVersion.versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "issued",
    actor,
    reasonCode: "document_issued",
    reasonDetailSha256: null,
    effectiveAt: EFFECTIVE_AT,
    recordedAt: RECORDED_AT,
    evidenceSha256: HASH_D,
  });
}

function emptyState(
  aggregate: AccountingAggregateRefV1,
): AccountingAggregateStateV1 {
  return {
    aggregate,
    revision: "0",
    versionHead: null,
    lifecycleHead: null,
    paymentHead: null,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeAccountingTransaction implements AccountingPersistenceTransactionV1 {
  readonly states = new Map<string, AccountingAggregateStateV1>();
  readonly versions = new Map<string, AccountingDocumentVersionV1>();
  readonly payments = new Map<string, AccountingPaymentEventV1>();
  readonly operations: string[] = [];
  readonly intents: AccountingExportIntentV1[] = [];
  compareResult = true;

  constructor(...states: AccountingAggregateStateV1[]) {
    for (const state of states)
      this.states.set(this.key(state.aggregate), clone(state));
  }

  private key(aggregate: AccountingAggregateRefV1) {
    return `${aggregate.kind}:${aggregate.id}`;
  }

  async lockAggregateForUpdate(aggregate: AccountingAggregateRefV1) {
    this.operations.push(`lock:${this.key(aggregate)}`);
    const state = this.states.get(this.key(aggregate));
    return state ? clone(state) : null;
  }

  async loadVersionById(versionId: string) {
    this.operations.push(`load-version:${versionId}`);
    return clone(this.versions.get(versionId) ?? null);
  }

  async loadPaymentEventById(paymentEventId: string) {
    this.operations.push(`load-payment:${paymentEventId}`);
    return clone(this.payments.get(paymentEventId) ?? null);
  }

  async insertDocumentVersion(documentVersion: AccountingDocumentVersionV1) {
    this.operations.push(`insert-version:${documentVersion.versionId}`);
    this.versions.set(documentVersion.versionId, clone(documentVersion));
  }

  async insertLifecycleEvent(event: ReturnType<typeof initialEvent>) {
    this.operations.push(`insert-lifecycle:${event.eventId}`);
  }

  async insertPaymentEvent(event: AccountingPaymentEventV1) {
    this.operations.push(`insert-payment:${event.paymentEventId}`);
    this.payments.set(event.paymentEventId, clone(event));
  }

  async insertVersionRelation(
    relation: ReturnType<typeof createAccountingVersionRelation>,
  ) {
    this.operations.push(`insert-relation:${relation.relationId}`);
  }

  async insertExportIntent(intent: AccountingExportIntentV1) {
    this.operations.push(`insert-intent:${intent.intentId}`);
    this.intents.push(clone(intent));
  }

  async compareAndAdvanceAggregateState(
    transition: AccountingAggregateStateTransitionV1,
  ) {
    this.operations.push(`advance:${this.key(transition.expected.aggregate)}`);
    if (!this.compareResult) return false;
    this.states.set(
      this.key(transition.expected.aggregate),
      clone(transition.next),
    );
    return true;
  }
}

describe("accounting persistence transaction contract", () => {
  it("atomically opens a native version, lifecycle, export intent, and head", async () => {
    const documentVersion = version();
    const event = initialEvent(documentVersion);
    const tx = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );

    const result = await appendInitialAccountingVersionInTransaction(
      tx,
      documentVersion,
      event,
    );

    expect(result.intent.operation).toBe("initial-version");
    expect(result.intent.entries.map((entry) => entry.kind)).toEqual([
      "document-version",
      "lifecycle-event",
    ]);
    expect(tx.operations).toEqual([
      "lock:outgoing-invoice:42",
      `insert-version:${documentVersion.versionId}`,
      `insert-lifecycle:${event.eventId}`,
      `insert-intent:${documentVersion.versionId}`,
      "advance:outgoing-invoice:42",
    ]);
    expect(tx.states.get("outgoing-invoice:42")).toEqual(
      result.transition.next,
    );
    expect(result.transition.next.revision).toBe("1");
  });

  it("stores one legacy observation without fabricating a lifecycle event", async () => {
    const legacy = version({ legacy: true });
    const tx = new FakeAccountingTransaction(emptyState(legacy.aggregate));
    const result = await appendInitialAccountingVersionInTransaction(
      tx,
      legacy,
    );
    expect(result.event).toBeNull();
    expect(result.intent.operation).toBe("legacy-observation");
    expect(
      tx.operations.some((entry) => entry.startsWith("insert-lifecycle")),
    ).toBe(false);
    await expect(
      appendInitialAccountingVersionInTransaction(
        new FakeAccountingTransaction(emptyState(legacy.aggregate)),
        legacy,
        initialEvent(version()),
      ),
    ).rejects.toThrow(/must not fabricate/i);
  });

  it("rejects an existing initial head and a failed compare-and-advance", async () => {
    const documentVersion = version();
    const event = initialEvent(documentVersion);
    const initialized = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );
    await appendInitialAccountingVersionInTransaction(
      initialized,
      documentVersion,
      event,
    );
    await expect(
      appendInitialAccountingVersionInTransaction(
        initialized,
        documentVersion,
        event,
      ),
    ).rejects.toThrow(/exact successor|existing version head/i);

    const failed = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );
    failed.compareResult = false;
    await expect(
      appendInitialAccountingVersionInTransaction(
        failed,
        documentVersion,
        event,
      ),
    ).rejects.toThrow(/must roll back/i);
    expect(failed.operations.at(-1)).toBe("advance:outgoing-invoice:42");
  });

  it("appends a standalone lifecycle event only to the exact stored current head", async () => {
    const documentVersion = version();
    const first = initialEvent(documentVersion);
    const tx = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );
    await appendInitialAccountingVersionInTransaction(
      tx,
      documentVersion,
      first,
    );
    const sent = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "22222222-2222-4222-8222-222222222223",
      aggregate: first.aggregate,
      sequence: "1",
      previousEventSha256: first.integrity.entrySha256,
      eventType: "sent",
      actor,
      reasonCode: "delivery_confirmed",
      reasonDetailSha256: null,
      effectiveAt: LATER,
      recordedAt: LATER,
      evidenceSha256: HASH_A,
    });
    const result = await appendAccountingLifecycleEventInTransaction(
      tx,
      sent,
      documentVersion,
    );
    expect(result.transition.next.revision).toBe("2");
    expect(result.intent.operation).toBe("lifecycle-event");
    expect(result.transition.next.lifecycleHead?.eventId).toBe(sent.eventId);

    const { integrity: _sentIntegrity, ...sentBody } = sent;
    const gap = createAccountingLifecycleEvent({
      ...sentBody,
      eventId: "22222222-2222-4222-8222-222222222224",
      sequence: "3",
      previousEventSha256: sent.integrity.entrySha256,
    });
    await expect(
      appendAccountingLifecycleEventInTransaction(tx, gap, documentVersion),
    ).rejects.toThrow(/exact successor/i);
  });

  it("appends payment deltas and requires a real earlier correction target", async () => {
    const documentVersion = version();
    const tx = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );
    await appendInitialAccountingVersionInTransaction(
      tx,
      documentVersion,
      initialEvent(documentVersion),
    );
    const received = createAccountingPaymentEvent({
      schemaVersion: "site-logbook.accounting-payment-event/v1",
      paymentEventId: "33333333-3333-4333-8333-333333333331",
      invoiceId: "42",
      invoiceVersionId: documentVersion.versionId,
      sequence: "0",
      previousEventSha256: null,
      eventType: "received",
      amountDelta: "121",
      currency: "CZK",
      occurredOn: "2042-03-04",
      recordedAt: RECORDED_AT,
      source: "manual",
      sourceRefSha256: null,
      correctsPaymentEventId: null,
      actor,
      reasonCode: "payment_received",
      reasonDetailSha256: null,
      evidenceSha256: HASH_A,
    });
    await appendAccountingPaymentEventInTransaction(
      tx,
      received,
      documentVersion,
    );
    const refund = createAccountingPaymentEvent({
      schemaVersion: "site-logbook.accounting-payment-event/v1",
      paymentEventId: "33333333-3333-4333-8333-333333333332",
      invoiceId: "42",
      invoiceVersionId: documentVersion.versionId,
      sequence: "1",
      previousEventSha256: received.integrity.entrySha256,
      eventType: "refunded",
      amountDelta: "-121",
      currency: "CZK",
      occurredOn: "2042-03-05",
      recordedAt: LATER,
      source: "manual",
      sourceRefSha256: null,
      correctsPaymentEventId: received.paymentEventId,
      actor,
      reasonCode: "refund_approved",
      reasonDetailSha256: HASH_B,
      evidenceSha256: HASH_C,
    });
    const result = await appendAccountingPaymentEventInTransaction(
      tx,
      refund,
      documentVersion,
    );
    expect(result.intent.operation).toBe("payment-event");
    expect(result.transition.next.paymentHead?.paymentEventId).toBe(
      refund.paymentEventId,
    );

    const missing = new FakeAccountingTransaction(
      clone(result.transition.expected),
    );
    missing.versions.set(documentVersion.versionId, documentVersion);
    await expect(
      appendAccountingPaymentEventInTransaction(
        missing,
        refund,
        documentVersion,
      ),
    ).rejects.toThrow(/not persisted/i);
  });

  it("locks correction roots deterministically and appends a three-entry bundle", async () => {
    const target = version({ id: "42" });
    const source = version({
      id: "7",
      versionId: "44444444-4444-4444-8444-444444444444",
      purpose: "credit",
      documentType: "credit_note",
      negative: true,
    });
    const tx = new FakeAccountingTransaction(
      emptyState(target.aggregate),
      emptyState(source.aggregate),
    );
    await appendInitialAccountingVersionInTransaction(
      tx,
      target,
      initialEvent(target),
    );
    tx.operations.length = 0;
    const event = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "55555555-5555-4555-8555-555555555555",
      aggregate: { ...source.aggregate, versionId: source.versionId },
      sequence: "0",
      previousEventSha256: null,
      eventType: "credit_linked",
      actor,
      reasonCode: "credit_approved",
      reasonDetailSha256: HASH_C,
      effectiveAt: LATER,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "66666666-6666-4666-8666-666666666666",
      relationType: "credits",
      source: { ...source.aggregate, versionId: source.versionId },
      target: { ...target.aggregate, versionId: target.versionId },
      actor,
      reasonCode: "refund_approved",
      reasonDetailSha256: HASH_C,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });
    const result = await appendAccountingCorrectionBundleInTransaction(tx, {
      sourceVersion: source,
      targetVersion: target,
      relation,
      lifecycleEvent: event,
    });
    expect(tx.operations.slice(0, 2)).toEqual([
      "lock:outgoing-invoice:7",
      "lock:outgoing-invoice:42",
    ]);
    expect(result.intent.operation).toBe("correction-bundle");
    expect(result.intent.entries.map((entry) => entry.kind)).toEqual([
      "document-version",
      "lifecycle-event",
      "version-relation",
    ]);
    expect(result.transitions).toHaveLength(1);
  });

  it("advances version and lifecycle heads together for a same-aggregate correction", async () => {
    const target = version();
    const tx = new FakeAccountingTransaction(emptyState(target.aggregate));
    const first = initialEvent(target);
    await appendInitialAccountingVersionInTransaction(tx, target, first);
    const source = version({
      versionId: "44444444-4444-4444-8444-444444444444",
      version: "2",
      purpose: "correction",
      documentType: "correction_invoice",
      supersedesVersionId: target.versionId,
    });
    const event = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "55555555-5555-4555-8555-555555555555",
      aggregate: { ...source.aggregate, versionId: source.versionId },
      sequence: "1",
      previousEventSha256: first.integrity.entrySha256,
      eventType: "correction_linked",
      actor,
      reasonCode: "correction_approved",
      reasonDetailSha256: HASH_C,
      effectiveAt: LATER,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "66666666-6666-4666-8666-666666666666",
      relationType: "supersedes",
      source: { ...source.aggregate, versionId: source.versionId },
      target: { ...target.aggregate, versionId: target.versionId },
      actor,
      reasonCode: "correction_approved",
      reasonDetailSha256: HASH_C,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });

    const result = await appendAccountingCorrectionBundleInTransaction(tx, {
      sourceVersion: source,
      targetVersion: target,
      relation,
      lifecycleEvent: event,
    });
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]!.next.versionHead?.versionId).toBe(
      source.versionId,
    );
    expect(result.transitions[0]!.next.lifecycleHead?.eventId).toBe(
      event.eventId,
    );
    expect(tx.states.get("outgoing-invoice:42")).toEqual(
      result.transitions[0]!.next,
    );
  });

  it("rejects a correction against a stale target before any new insert", async () => {
    const target = version({ id: "42" });
    const source = version({
      id: "7",
      versionId: "44444444-4444-4444-8444-444444444444",
      purpose: "credit",
      documentType: "credit_note",
      negative: true,
    });
    const staleState = emptyState(target.aggregate);
    staleState.versionHead = {
      version: "2",
      versionId: "77777777-7777-4777-8777-777777777777",
      versionSha256: HASH_A,
    };
    staleState.lifecycleHead = {
      sequence: "1",
      eventId: "88888888-8888-4888-8888-888888888888",
      eventSha256: HASH_B,
    };
    const tx = new FakeAccountingTransaction(
      staleState,
      emptyState(source.aggregate),
    );
    tx.versions.set(target.versionId, target);
    const event = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "55555555-5555-4555-8555-555555555555",
      aggregate: { ...source.aggregate, versionId: source.versionId },
      sequence: "0",
      previousEventSha256: null,
      eventType: "credit_linked",
      actor,
      reasonCode: "credit_approved",
      reasonDetailSha256: HASH_C,
      effectiveAt: LATER,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "66666666-6666-4666-8666-666666666666",
      relationType: "credits",
      source: { ...source.aggregate, versionId: source.versionId },
      target: { ...target.aggregate, versionId: target.versionId },
      actor,
      reasonCode: "refund_approved",
      reasonDetailSha256: HASH_C,
      recordedAt: LATER,
      evidenceSha256: HASH_D,
    });
    await expect(
      appendAccountingCorrectionBundleInTransaction(tx, {
        sourceVersion: source,
        targetVersion: target,
        relation,
        lifecycleEvent: event,
      }),
    ).rejects.toThrow(/current version head/i);
    expect(tx.operations.some((entry) => entry.startsWith("insert-"))).toBe(
      false,
    );
  });

  it("strictly verifies canonical export intent bytes and integrity", async () => {
    const documentVersion = version();
    const tx = new FakeAccountingTransaction(
      emptyState(documentVersion.aggregate),
    );
    const { intent } = await appendInitialAccountingVersionInTransaction(
      tx,
      documentVersion,
      initialEvent(documentVersion),
    );
    const canonical = canonicalAccountingExportIntentJson(intent);
    expect(verifyCanonicalAccountingExportIntentJsonBytes(canonical)).toEqual(
      intent,
    );
    expect(() =>
      verifyAccountingExportIntent({
        ...intent,
        integrity: { ...intent.integrity, intentSha256: HASH_A },
      }),
    ).toThrow(/digest/i);
    expect(() =>
      verifyCanonicalAccountingExportIntentJsonBytes(`${canonical}\n`),
    ).toThrow(/canonical/i);
  });
});
