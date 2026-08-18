import { describe, expect, it } from "vitest";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingSnapshotV1,
} from "../src/lib/accounting-document-version-contract";
import {
  canonicalAccountingLifecycleEntryJson,
  createAccountingLifecycleEvent,
  createAccountingPaymentEvent,
  createAccountingVersionRelation,
  verifyAccountingCorrectionChainBinding,
  verifyAccountingLifecycleEvent,
  verifyAccountingLifecycleEventBinding,
  verifyAccountingLifecycleEventChain,
  verifyAccountingPaymentEventBinding,
  verifyAccountingPaymentEventChain,
  verifyAccountingVersionRelation,
  verifyAccountingVersionRelationBinding,
  verifyCanonicalAccountingLifecycleEntryJsonBytes,
} from "../src/lib/accounting-lifecycle-event-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const AT = "2042-03-04T10:00:00.000Z";
const LATER = "2042-03-04T10:01:00.000Z";

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
  amount: "positive" | "negative" | "zero";
}): AccountingSnapshotV1 {
  const totals =
    input.amount === "positive"
      ? { subtotalWithoutVat: "100", totalVat: "21", totalWithVat: "121" }
      : input.amount === "negative"
        ? { subtotalWithoutVat: "-100", totalVat: "-21", totalWithVat: "-121" }
        : { subtotalWithoutVat: "0", totalVat: "0", totalWithVat: "0" };
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
        sourceType: "correction",
        sourceId: null,
        jobId: null,
        activityId: null,
        description: "Účetní položka",
        quantity: "1",
        unit: "ks",
        unitPriceWithoutVat: totals.subtotalWithoutVat,
        discountPercent: null,
        vatRate: input.amount === "zero" ? "0" : "21",
        vatMode: "standard",
        totalWithoutVat: totals.subtotalWithoutVat,
        totalVat: totals.totalVat,
        totalWithVat: totals.totalWithVat,
      },
    ],
    sourceLinks: [],
    totals,
    legacyPaymentObservation: null,
  };
}

function version(input: {
  id: string;
  versionId: string;
  purpose: "issued" | "credit" | "correction" | "cancellation_notice";
  documentType:
    | "invoice"
    | "credit_note"
    | "correction_invoice"
    | "cancellation_notice";
  amount: "positive" | "negative" | "zero";
  version?: string;
  supersedesVersionId?: string | null;
}) {
  const snapshot = invoiceSnapshot(input);
  return createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: input.versionId,
    aggregate: { kind: "outgoing-invoice", id: input.id },
    version: input.version ?? "1",
    purpose: input.purpose,
    supersedesVersionId: input.supersedesVersionId ?? null,
    historicalCompleteness: "complete",
    effectiveAt: AT,
    recordedAt: LATER,
    snapshot,
    artifacts: [
      {
        artifactId: `${input.versionId.slice(0, 24)}${input.versionId.slice(24)}`,
        role: "rendered-pdf",
        mediaType: "application/pdf",
        contentSha256: HASH_A,
        sizeBytes: "1024",
        objectLocationSha256: HASH_B,
        rendererVersion: "invoice-pdf/v1",
      },
    ],
    provenance: {
      captureMode: "native",
      sourceMode: "human",
      recordedBy: actor,
      approvalEvidenceSha256: HASH_C,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "human",
        actorRef: "user:7",
        sourceEvidenceSha256: null,
        extractionRunId: null,
        recordedAt: AT,
      }),
    },
  });
}

function issuedVersion() {
  return version({
    id: "42",
    versionId: "11111111-1111-4111-8111-111111111111",
    purpose: "issued",
    documentType: "invoice",
    amount: "positive",
  });
}

function issuedEvent() {
  const issued = issuedVersion();
  return createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: "22222222-2222-4222-8222-222222222222",
    aggregate: {
      kind: "outgoing-invoice",
      id: issued.aggregate.id,
      versionId: issued.versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "issued",
    actor,
    reasonCode: "document_issued",
    reasonDetailSha256: null,
    effectiveAt: AT,
    recordedAt: LATER,
    evidenceSha256: HASH_D,
  });
}

function lifecycleBody(
  event: ReturnType<typeof createAccountingLifecycleEvent>,
) {
  const { integrity: _integrity, ...body } = event;
  return body;
}

describe("accounting lifecycle event contract", () => {
  it("creates and binds a canonical issued event to its immutable version", () => {
    const issued = issuedVersion();
    const event = issuedEvent();
    expect(event.integrity.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAccountingLifecycleEventBinding(event, issued)).toEqual({
      event,
      version: issued,
    });
    const canonical = canonicalAccountingLifecycleEntryJson(event);
    expect(verifyCanonicalAccountingLifecycleEntryJsonBytes(canonical)).toEqual(
      event,
    );
  });

  it("verifies a contiguous hash-linked lifecycle chain", () => {
    const first = issuedEvent();
    const second = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "22222222-2222-4222-8222-222222222223",
      aggregate: first.aggregate,
      sequence: "1",
      previousEventSha256: first.integrity.entrySha256,
      eventType: "sent",
      actor: {
        kind: "system",
        id: "delivery-worker",
        authentication: "service",
      },
      reasonCode: "delivery_confirmed",
      reasonDetailSha256: null,
      effectiveAt: "2042-03-04T10:02:00.000Z",
      recordedAt: "2042-03-04T10:03:00.000Z",
      evidenceSha256: HASH_A,
    });
    expect(verifyAccountingLifecycleEventChain([first, second])).toEqual([
      first,
      second,
    ]);
    expect(() =>
      verifyAccountingLifecycleEventChain([
        first,
        createAccountingLifecycleEvent({
          ...lifecycleBody(second),
          eventId: "22222222-2222-4222-8222-222222222224",
          previousEventSha256: HASH_B,
        }),
      ]),
    ).toThrow(/previous digest/i);
  });

  it("rejects wrong aggregate event types, reason policy, detail policy, and time", () => {
    const first = issuedEvent();
    expect(() =>
      createAccountingLifecycleEvent({
        ...lifecycleBody(first),
        eventId: "22222222-2222-4222-8222-222222222225",
        aggregate: { ...first.aggregate, kind: "incoming-cost-document" },
        eventType: "issued",
      }),
    ).toThrow(/not valid/i);
    expect(() =>
      createAccountingLifecycleEvent({
        ...lifecycleBody(first),
        eventId: "22222222-2222-4222-8222-222222222226",
        reasonCode: "billing_error",
      }),
    ).toThrow(/not registered/i);
    expect(() =>
      createAccountingLifecycleEvent({
        ...lifecycleBody(first),
        eventId: "22222222-2222-4222-8222-222222222227",
        reasonDetailSha256: HASH_A,
      }),
    ).toThrow(/reason-detail/i);
    expect(() =>
      createAccountingLifecycleEvent({
        ...lifecycleBody(first),
        eventId: "22222222-2222-4222-8222-222222222228",
        effectiveAt: "2042-03-04T10:05:00.000Z",
      }),
    ).toThrow(/postdate/i);
  });

  it("accepts an incoming approval event but has no legacy-history event type", () => {
    const approved = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "22222222-2222-4222-8222-222222222229",
      aggregate: {
        kind: "incoming-cost-document",
        id: "88",
        versionId: "44444444-4444-4444-8444-444444444444",
      },
      sequence: "0",
      previousEventSha256: null,
      eventType: "approved",
      actor,
      reasonCode: "document_approved",
      reasonDetailSha256: null,
      effectiveAt: AT,
      recordedAt: LATER,
      evidenceSha256: HASH_A,
    });
    expect(approved.eventType).toBe("approved");
    expect(() =>
      createAccountingLifecycleEvent({
        ...lifecycleBody(approved),
        eventId: "22222222-2222-4222-8222-222222222230",
        eventType: "legacy_observation",
      } as never),
    ).toThrow();
  });

  it("records payment reception and refund as an append-only delta chain", () => {
    const issued = issuedVersion();
    const received = createAccountingPaymentEvent({
      schemaVersion: "site-logbook.accounting-payment-event/v1",
      paymentEventId: "33333333-3333-4333-8333-333333333331",
      invoiceId: issued.aggregate.id,
      invoiceVersionId: issued.versionId,
      sequence: "0",
      previousEventSha256: null,
      eventType: "received",
      amountDelta: "121",
      currency: "CZK",
      occurredOn: "2042-03-10",
      recordedAt: "2042-03-10T12:00:00.000Z",
      source: "bank_import",
      sourceRefSha256: HASH_A,
      correctsPaymentEventId: null,
      actor: { kind: "system", id: "bank-import", authentication: "service" },
      reasonCode: "payment_imported",
      reasonDetailSha256: null,
      evidenceSha256: HASH_B,
    });
    const refund = createAccountingPaymentEvent({
      schemaVersion: "site-logbook.accounting-payment-event/v1",
      paymentEventId: "33333333-3333-4333-8333-333333333332",
      invoiceId: issued.aggregate.id,
      invoiceVersionId: issued.versionId,
      sequence: "1",
      previousEventSha256: received.integrity.entrySha256,
      eventType: "refunded",
      amountDelta: "-121",
      currency: "CZK",
      occurredOn: "2042-03-12",
      recordedAt: "2042-03-12T12:00:00.000Z",
      source: "manual",
      sourceRefSha256: null,
      correctsPaymentEventId: received.paymentEventId,
      actor,
      reasonCode: "refund_approved",
      reasonDetailSha256: HASH_C,
      evidenceSha256: HASH_D,
    });
    expect(verifyAccountingPaymentEventChain([received, refund])).toEqual([
      received,
      refund,
    ]);
    expect(verifyAccountingPaymentEventBinding(received, issued)).toEqual({
      event: received,
      version: issued,
    });
  });

  it("rejects payment sign, source, correction-reference, and reason contradictions", () => {
    const base = {
      schemaVersion: "site-logbook.accounting-payment-event/v1" as const,
      paymentEventId: "33333333-3333-4333-8333-333333333333",
      invoiceId: "42",
      invoiceVersionId: issuedVersion().versionId,
      sequence: "0",
      previousEventSha256: null,
      eventType: "received" as const,
      amountDelta: "121",
      currency: "CZK",
      occurredOn: "2042-03-10",
      recordedAt: "2042-03-10T12:00:00.000Z",
      source: "manual" as const,
      sourceRefSha256: null,
      correctsPaymentEventId: null,
      actor,
      reasonCode: "payment_received" as const,
      reasonDetailSha256: null,
      evidenceSha256: HASH_A,
    };
    expect(() =>
      createAccountingPaymentEvent({ ...base, amountDelta: "-121" }),
    ).toThrow(/sign/i);
    expect(() =>
      createAccountingPaymentEvent({
        ...base,
        source: "bank_import",
        sourceRefSha256: null,
        reasonCode: "payment_imported",
      }),
    ).toThrow(/provider reference/i);
    expect(() =>
      createAccountingPaymentEvent({
        ...base,
        eventType: "refunded",
        amountDelta: "-1",
        correctsPaymentEventId: null,
        reasonCode: "refund_approved",
        reasonDetailSha256: HASH_A,
      }),
    ).toThrow(/corrected event/i);
  });

  it("rejects payment chains that reference future events or cross invoices", () => {
    const first = createAccountingPaymentEvent({
      schemaVersion: "site-logbook.accounting-payment-event/v1",
      paymentEventId: "33333333-3333-4333-8333-333333333334",
      invoiceId: "42",
      invoiceVersionId: issuedVersion().versionId,
      sequence: "0",
      previousEventSha256: null,
      eventType: "corrected",
      amountDelta: "1",
      currency: "CZK",
      occurredOn: "2042-03-10",
      recordedAt: "2042-03-10T12:00:00.000Z",
      source: "manual",
      sourceRefSha256: null,
      correctsPaymentEventId: "33333333-3333-4333-8333-333333333339",
      actor,
      reasonCode: "payment_correction_approved",
      reasonDetailSha256: HASH_A,
      evidenceSha256: HASH_B,
    });
    expect(() => verifyAccountingPaymentEventChain([first])).toThrow(
      /earlier event/i,
    );
  });

  it("binds an immutable credit artifact to the original invoice", () => {
    const target = issuedVersion();
    const source = version({
      id: "43",
      versionId: "44444444-4444-4444-8444-444444444444",
      purpose: "credit",
      documentType: "credit_note",
      amount: "negative",
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "55555555-5555-4555-8555-555555555555",
      relationType: "credits",
      source: {
        kind: source.aggregate.kind,
        id: source.aggregate.id,
        versionId: source.versionId,
      },
      target: {
        kind: target.aggregate.kind,
        id: target.aggregate.id,
        versionId: target.versionId,
      },
      actor,
      reasonCode: "customer_complaint",
      reasonDetailSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
      evidenceSha256: HASH_B,
    });
    expect(
      verifyAccountingVersionRelationBinding(relation, source, target),
    ).toEqual({
      relation,
      source,
      target,
    });
  });

  it("binds a cancellation notice for an approved business void without mutating the original", () => {
    const target = issuedVersion();
    const source = version({
      id: "44",
      versionId: "66666666-6666-4666-8666-666666666666",
      purpose: "cancellation_notice",
      documentType: "cancellation_notice",
      amount: "zero",
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "77777777-7777-4777-8777-777777777777",
      relationType: "voids",
      source: {
        kind: source.aggregate.kind,
        id: source.aggregate.id,
        versionId: source.versionId,
      },
      target: {
        kind: target.aggregate.kind,
        id: target.aggregate.id,
        versionId: target.versionId,
      },
      actor,
      reasonCode: "incorrect_job",
      reasonDetailSha256: HASH_C,
      recordedAt: "2042-03-04T10:02:00.000Z",
      evidenceSha256: HASH_D,
    });
    const event = createAccountingLifecycleEvent({
      schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
      eventId: "77777777-7777-4777-8777-777777777778",
      aggregate: {
        kind: target.aggregate.kind,
        id: target.aggregate.id,
        versionId: target.versionId,
      },
      sequence: "0",
      previousEventSha256: null,
      eventType: "void_confirmed",
      actor,
      reasonCode: "incorrect_job",
      reasonDetailSha256: HASH_C,
      effectiveAt: "2042-03-04T10:01:00.000Z",
      recordedAt: relation.recordedAt,
      evidenceSha256: HASH_D,
    });
    expect(
      verifyAccountingCorrectionChainBinding(relation, event, source, target)
        .target,
    ).toEqual(target);
    expect(() =>
      verifyAccountingCorrectionChainBinding(
        relation,
        createAccountingLifecycleEvent({
          ...lifecycleBody(event),
          eventId: "77777777-7777-4777-8777-777777777779",
          evidenceSha256: HASH_A,
        }),
        source,
        target,
      ),
    ).toThrow(/atomic-equivalent/i);
  });

  it("requires a real correction version for supersedes and exact predecessor binding", () => {
    const target = issuedVersion();
    const source = version({
      id: "42",
      versionId: "88888888-8888-4888-8888-888888888888",
      purpose: "correction",
      documentType: "correction_invoice",
      amount: "negative",
      version: "2",
      supersedesVersionId: target.versionId,
    });
    const relation = createAccountingVersionRelation({
      schemaVersion: "site-logbook.accounting-version-relation/v1",
      relationId: "99999999-9999-4999-8999-999999999999",
      relationType: "supersedes",
      source: {
        kind: source.aggregate.kind,
        id: source.aggregate.id,
        versionId: source.versionId,
      },
      target: {
        kind: target.aggregate.kind,
        id: target.aggregate.id,
        versionId: target.versionId,
      },
      actor,
      reasonCode: "correction_approved",
      reasonDetailSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
      evidenceSha256: HASH_B,
    });
    expect(
      verifyAccountingVersionRelationBinding(relation, source, target).source,
    ).toEqual(source);
    expect(() =>
      verifyAccountingVersionRelationBinding(
        relation,
        {
          ...source,
          supersedesVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        target,
      ),
    ).toThrow();
  });

  it("rejects relation identity, kind, reason, purpose, and hash tampering", () => {
    const target = issuedVersion();
    const source = version({
      id: "43",
      versionId: "44444444-4444-4444-8444-444444444444",
      purpose: "credit",
      documentType: "credit_note",
      amount: "negative",
    });
    const base = {
      schemaVersion: "site-logbook.accounting-version-relation/v1" as const,
      relationId: "55555555-5555-4555-8555-555555555556",
      relationType: "credits" as const,
      source: {
        kind: source.aggregate.kind,
        id: source.aggregate.id,
        versionId: source.versionId,
      },
      target: {
        kind: target.aggregate.kind,
        id: target.aggregate.id,
        versionId: target.versionId,
      },
      actor,
      reasonCode: "refund_approved" as const,
      reasonDetailSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
      evidenceSha256: HASH_B,
    };
    expect(() =>
      createAccountingVersionRelation({
        ...base,
        target: { ...base.source },
      }),
    ).toThrow(/same version/i);
    expect(() =>
      createAccountingVersionRelation({
        ...base,
        reasonCode: "order_cancelled",
      }),
    ).toThrow(/not registered/i);
    const relation = createAccountingVersionRelation(base);
    expect(() =>
      verifyAccountingVersionRelation({
        ...relation,
        integrity: { ...relation.integrity, entrySha256: HASH_C },
      }),
    ).toThrow(/integrity/i);
    expect(() =>
      verifyAccountingVersionRelationBinding(relation, target, source),
    ).toThrow(/not bound/i);
  });

  it("rejects noncanonical lifecycle bytes", () => {
    const event = issuedEvent();
    expect(() =>
      verifyCanonicalAccountingLifecycleEntryJsonBytes(
        `${canonicalAccountingLifecycleEntryJson(event)}\n`,
      ),
    ).toThrow(/not canonical/i);
    expect(verifyAccountingLifecycleEvent(event)).toEqual(event);
  });
});
