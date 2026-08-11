import { describe, expect, it } from "vitest";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";
import {
  canonicalSideEffectIntentJson,
  createInitialSideEffectProjection,
  createSideEffectIntent,
  transitionSideEffectProjection,
  verifySideEffectIntent,
  verifySideEffectProjection,
  verifySideEffectTransitionEvent,
} from "../src/lib/side-effect-lifecycle-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const AT = "2042-03-04T10:00:00.000Z";
const LATER = "2042-03-04T10:01:00.000Z";
const LEASE = {
  tokenSha256: HASH_D,
  expiresAt: "2042-03-04T10:10:00.000Z",
};

function deliveryIntent() {
  return createSideEffectIntent({
    kind: "delivery",
    operationId: "11111111-1111-4111-8111-111111111111",
    idempotencyKeySha256: HASH_A,
    payloadReferenceSha256: HASH_B,
    createdAt: AT,
    attributes: {
      channel: "email",
      purpose: "invoice",
      messageIdSha256: HASH_C,
      recipientSetSha256: HASH_D,
    },
  });
}

function transitionId(index: number): string {
  return `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
}

function rehashEvent(value: Record<string, any>) {
  const unsigned = {
    ...value,
    integrity: { ...value.integrity, eventSha256: null },
  };
  return {
    ...value,
    integrity: {
      ...value.integrity,
      eventSha256: sha256Hex(
        `site-logbook.side-effect-transition/v1\0${canonicalEvidenceJson(unsigned)}`,
      ),
    },
  };
}

describe("side-effect lifecycle contract", () => {
  it("creates a canonical secret-free delivery intent and initial projection", () => {
    const intent = deliveryIntent();
    expect(intent.initialState).toBe("pending");
    expect(intent.payloadProtection).toBe("mve1");
    expect(intent.integrity.intentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSideEffectIntentJson(intent)).toBe(
      canonicalSideEffectIntentJson(JSON.parse(JSON.stringify(intent))),
    );
    expect(createInitialSideEffectProjection(intent)).toEqual({
      schemaVersion: "site-logbook.side-effect-projection/v1",
      kind: "delivery",
      operationId: intent.operationId,
      managedObjectOperation: null,
      state: "pending",
      revision: "0",
      attemptCount: "0",
      lease: null,
      updatedAt: AT,
    });
    expect(JSON.stringify(intent)).not.toMatch(/@|\/objects\/|password|token/i);
  });

  it("rejects intent tampering and unknown fields", () => {
    const intent = deliveryIntent();
    expect(() =>
      verifySideEffectIntent({
        ...intent,
        payloadReferenceSha256: HASH_C,
      }),
    ).toThrow(/digest/i);
    expect(() =>
      verifySideEffectIntent({ ...intent, secret: "value" }),
    ).toThrow();
  });

  it("requires content evidence only for managed-object writes", () => {
    const write = createSideEffectIntent({
      kind: "managed-object",
      operationId: "33333333-3333-4333-8333-333333333333",
      idempotencyKeySha256: HASH_A,
      payloadReferenceSha256: HASH_B,
      createdAt: AT,
      attributes: {
        operation: "write",
        objectLocationSha256: HASH_C,
        contentSha256: HASH_D,
        contentSizeBytes: "1024",
      },
    });
    expect(write.initialState).toBe("planned");
    expect(() =>
      createSideEffectIntent({
        ...write,
        attributes: {
          operation: "delete",
          objectLocationSha256: HASH_C,
          contentSha256: HASH_D,
          contentSizeBytes: "1024",
        },
      } as never),
    ).toThrow(/delete intents/i);
  });

  it("creates an inbox reservation intent without provider message contents", () => {
    const intent = createSideEffectIntent({
      kind: "inbox-message",
      operationId: "44444444-4444-4444-8444-444444444444",
      idempotencyKeySha256: HASH_A,
      payloadReferenceSha256: HASH_B,
      createdAt: AT,
      attributes: {
        provider: "imap",
        mailboxSha256: HASH_C,
        providerMessageSha256: HASH_D,
      },
    });
    expect(intent.initialState).toBe("discovered");
  });

  it("advances delivery attempts and makes accepted delivery terminal", () => {
    let projection = createInitialSideEffectProjection(deliveryIntent());
    const started = transitionSideEffectProjection(projection, {
      transitionId: transitionId(1),
      toState: "delivering",
      trigger: "worker",
      reasonCode: "attempt_started",
      recordedAt: LATER,
      nextLease: LEASE,
    });
    expect(started.projection).toMatchObject({
      state: "delivering",
      revision: "1",
      attemptCount: "1",
      lease: LEASE,
    });
    expect(verifySideEffectTransitionEvent(started.event)).toEqual(
      started.event,
    );
    projection = started.projection;

    const delivered = transitionSideEffectProjection(projection, {
      transitionId: transitionId(2),
      toState: "delivered",
      trigger: "worker",
      reasonCode: "provider_accepted",
      outcomeEvidenceSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
    });
    expect(delivered.projection).toMatchObject({
      state: "delivered",
      revision: "2",
      attemptCount: "1",
      lease: null,
    });
    expect(() =>
      transitionSideEffectProjection(delivered.projection, {
        transitionId: transitionId(3),
        toState: "delivering",
        trigger: "worker",
        reasonCode: "retry_started",
        recordedAt: "2042-03-04T10:03:00.000Z",
        nextLease: LEASE,
      }),
    ).toThrow(/terminal/i);
  });

  it("never retries an unknown delivery without operator evidence", () => {
    const initial = createInitialSideEffectProjection(deliveryIntent());
    const active = transitionSideEffectProjection(initial, {
      transitionId: transitionId(4),
      toState: "delivering",
      trigger: "worker",
      reasonCode: "attempt_started",
      recordedAt: LATER,
      nextLease: LEASE,
    }).projection;
    const unknown = transitionSideEffectProjection(active, {
      transitionId: transitionId(5),
      toState: "unknown",
      trigger: "worker",
      reasonCode: "provider_result_unknown",
      outcomeEvidenceSha256: HASH_B,
      recordedAt: "2042-03-04T10:02:00.000Z",
    }).projection;

    expect(() =>
      transitionSideEffectProjection(unknown, {
        transitionId: transitionId(6),
        toState: "pending",
        trigger: "worker",
        reasonCode: "automatic_retry",
        recordedAt: "2042-03-04T10:03:00.000Z",
      }),
    ).toThrow(/operator evidence/i);
    const reconciled = transitionSideEffectProjection(unknown, {
      transitionId: transitionId(7),
      toState: "pending",
      trigger: "operator",
      reasonCode: "provider_absence_verified",
      outcomeEvidenceSha256: HASH_B,
      resolutionEvidenceSha256: HASH_A,
      recordedAt: "2042-03-04T10:03:00.000Z",
    });
    expect(reconciled.projection.state).toBe("pending");
    expect(reconciled.projection.attemptCount).toBe("1");
  });

  it("requires a future bounded lease for every active state", () => {
    const initial = createInitialSideEffectProjection(deliveryIntent());
    expect(() =>
      transitionSideEffectProjection(initial, {
        transitionId: transitionId(8),
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
      }),
    ).toThrow(/lease/i);
    expect(() =>
      transitionSideEffectProjection(initial, {
        transitionId: transitionId(9),
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: { ...LEASE, expiresAt: AT },
      }),
    ).toThrow(/expire/i);
  });

  it("rejects rehashed revision and outcome-evidence forgeries", () => {
    const initial = createInitialSideEffectProjection(deliveryIntent());
    const started = transitionSideEffectProjection(initial, {
      transitionId: transitionId(10),
      toState: "delivering",
      trigger: "worker",
      reasonCode: "attempt_started",
      recordedAt: LATER,
      nextLease: LEASE,
    });
    expect(() =>
      verifySideEffectTransitionEvent(
        rehashEvent({ ...started.event, nextRevision: "7" }),
      ),
    ).toThrow(/revision/i);

    const delivered = transitionSideEffectProjection(started.projection, {
      transitionId: transitionId(11),
      toState: "delivered",
      trigger: "worker",
      reasonCode: "provider_accepted",
      outcomeEvidenceSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
    });
    expect(() =>
      verifySideEffectTransitionEvent(
        rehashEvent({ ...delivered.event, outcomeEvidenceSha256: null }),
      ),
    ).toThrow(/outcome evidence/i);
  });

  it("rejects cross-lifecycle and revision-zero forged projections", () => {
    const initial = createInitialSideEffectProjection(deliveryIntent());
    expect(() =>
      verifySideEffectProjection({ ...initial, state: "writing" }),
    ).toThrow(/not valid/i);
    expect(() =>
      verifySideEffectProjection({ ...initial, state: "delivered" }),
    ).toThrow(/revision zero/i);
  });

  it("keeps managed-object write and delete operations in separate lifecycles", () => {
    const intent = createSideEffectIntent({
      kind: "managed-object",
      operationId: "55555555-5555-4555-8555-555555555555",
      idempotencyKeySha256: HASH_A,
      payloadReferenceSha256: HASH_B,
      createdAt: AT,
      attributes: {
        operation: "write",
        objectLocationSha256: HASH_C,
        contentSha256: HASH_D,
        contentSizeBytes: "2048",
      },
    });
    let projection = createInitialSideEffectProjection(intent);
    const steps = [
      ["writing", LEASE],
      ["stored_unbound", null],
      ["bound", null],
    ] as const;
    steps.forEach(([toState, nextLease], index) => {
      projection = transitionSideEffectProjection(projection, {
        transitionId: transitionId(20 + index),
        toState,
        trigger: "worker",
        reasonCode: `object_step_${index}`,
        outcomeEvidenceSha256: nextLease ? null : HASH_A,
        recordedAt: `2042-03-04T10:0${index + 1}:00.000Z`,
        nextLease,
      }).projection;
    });
    expect(projection).toMatchObject({
      state: "bound",
      revision: "3",
      managedObjectOperation: "write",
    });
    expect(() =>
      transitionSideEffectProjection(projection, {
        transitionId: transitionId(25),
        toState: "delete_pending",
        trigger: "system",
        reasonCode: "delete_requested",
        recordedAt: "2042-03-04T10:05:00.000Z",
      }),
    ).toThrow(/not allowed/i);

    const deleteIntent = createSideEffectIntent({
      kind: "managed-object",
      operationId: "77777777-7777-4777-8777-777777777777",
      idempotencyKeySha256: HASH_A,
      payloadReferenceSha256: HASH_B,
      createdAt: AT,
      attributes: {
        operation: "delete",
        objectLocationSha256: HASH_C,
        contentSha256: null,
        contentSizeBytes: null,
      },
    });
    let deletion = createInitialSideEffectProjection(deleteIntent);
    expect(deletion).toMatchObject({
      state: "delete_pending",
      managedObjectOperation: "delete",
    });
    expect(() =>
      transitionSideEffectProjection(deletion, {
        transitionId: transitionId(26),
        toState: "writing",
        trigger: "worker",
        reasonCode: "wrong_operation",
        recordedAt: LATER,
        nextLease: LEASE,
      }),
    ).toThrow(/not allowed/i);
    deletion = transitionSideEffectProjection(deletion, {
      transitionId: transitionId(27),
      toState: "deleting",
      trigger: "worker",
      reasonCode: "delete_started",
      recordedAt: LATER,
      nextLease: LEASE,
    }).projection;
    deletion = transitionSideEffectProjection(deletion, {
      transitionId: transitionId(28),
      toState: "deleted",
      trigger: "worker",
      reasonCode: "delete_observed_absent",
      outcomeEvidenceSha256: HASH_A,
      recordedAt: "2042-03-04T10:02:00.000Z",
    }).projection;
    expect(deletion.state).toBe("deleted");
  });

  it("requires inbox reservation before processing", () => {
    const intent = createSideEffectIntent({
      kind: "inbox-message",
      operationId: "66666666-6666-4666-8666-666666666666",
      idempotencyKeySha256: HASH_A,
      payloadReferenceSha256: HASH_B,
      createdAt: AT,
      attributes: {
        provider: "gmail",
        mailboxSha256: HASH_C,
        providerMessageSha256: HASH_D,
      },
    });
    const projection = createInitialSideEffectProjection(intent);
    expect(() =>
      transitionSideEffectProjection(projection, {
        transitionId: transitionId(30),
        toState: "processing",
        trigger: "worker",
        reasonCode: "ingest_started",
        recordedAt: LATER,
        nextLease: LEASE,
      }),
    ).toThrow(/not allowed/i);
    const reserved = transitionSideEffectProjection(projection, {
      transitionId: transitionId(31),
      toState: "reserved",
      trigger: "worker",
      reasonCode: "provider_message_reserved",
      outcomeEvidenceSha256: HASH_A,
      recordedAt: LATER,
    }).projection;
    expect(reserved.state).toBe("reserved");
  });
});
