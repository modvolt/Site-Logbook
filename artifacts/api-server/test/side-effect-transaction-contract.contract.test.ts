import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialSideEffectProjection,
  createSideEffectIntent,
  transitionSideEffectProjection,
  type CreateSideEffectIntentInputV1,
  type SideEffectProjectionV1,
} from "../src/lib/side-effect-lifecycle-contract";
import {
  appendSideEffectTransitionInTransaction,
  initializeSideEffectInTransaction,
  type SideEffectTransactionV1,
} from "../src/lib/side-effect-transaction-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2042-03-04T10:00:00.000Z";
const LATER = "2042-03-04T10:01:00.000Z";

function deliveryInput(): CreateSideEffectIntentInputV1 {
  return {
    kind: "delivery",
    operationId: OPERATION_ID,
    idempotencyKeySha256: HASH_A,
    payloadReferenceSha256: HASH_B,
    createdAt: AT,
    attributes: {
      channel: "email",
      purpose: "invoice",
      messageIdSha256: HASH_C,
      recipientSetSha256: HASH_D,
    },
  };
}

function initialProjection(): SideEffectProjectionV1 {
  return createInitialSideEffectProjection(
    createSideEffectIntent(deliveryInput()),
  );
}

function transaction(
  overrides: Partial<SideEffectTransactionV1> = {},
): SideEffectTransactionV1 {
  return {
    insertIntent: vi.fn(async () => undefined),
    insertInitialProjection: vi.fn(async () => undefined),
    lockProjectionForUpdate: vi.fn(async () => initialProjection()),
    insertTransitionEvent: vi.fn(async () => undefined),
    compareAndAdvanceProjection: vi.fn(async () => true),
    ...overrides,
  };
}

describe("side-effect transaction contract", () => {
  it("initializes intent before projection inside the caller transaction", async () => {
    const calls: string[] = [];
    const tx = transaction({
      insertIntent: vi.fn(async () => {
        calls.push("intent");
      }),
      insertInitialProjection: vi.fn(async () => {
        calls.push("projection");
      }),
    });

    const result = await initializeSideEffectInTransaction(tx, deliveryInput());

    expect(calls).toEqual(["intent", "projection"]);
    expect(result.projection).toMatchObject({
      operationId: result.intent.operationId,
      state: "pending",
      revision: "0",
    });
  });

  it("does not insert the projection when intent insertion fails", async () => {
    const insertInitialProjection = vi.fn(async () => undefined);
    const tx = transaction({
      insertIntent: vi.fn(async () => {
        throw new Error("intent insert failed");
      }),
      insertInitialProjection,
    });

    await expect(
      initializeSideEffectInTransaction(tx, deliveryInput()),
    ).rejects.toThrow("intent insert failed");
    expect(insertInitialProjection).not.toHaveBeenCalled();
  });

  it("propagates projection insertion failure to force caller rollback", async () => {
    const tx = transaction({
      insertInitialProjection: vi.fn(async () => {
        throw new Error("projection insert failed");
      }),
    });

    await expect(
      initializeSideEffectInTransaction(tx, deliveryInput()),
    ).rejects.toThrow("projection insert failed");
  });

  it("locks, appends the immutable event, then compare-and-advances", async () => {
    const calls: string[] = [];
    const tx = transaction({
      lockProjectionForUpdate: vi.fn(async () => {
        calls.push("lock");
        return initialProjection();
      }),
      insertTransitionEvent: vi.fn(async () => {
        calls.push("event");
      }),
      compareAndAdvanceProjection: vi.fn(async () => {
        calls.push("advance");
        return true;
      }),
    });

    const result = await appendSideEffectTransitionInTransaction(
      tx,
      OPERATION_ID,
      {
        transitionId: "22222222-2222-4222-8222-222222222222",
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: {
          tokenSha256: HASH_A,
          expiresAt: "2042-03-04T10:10:00.000Z",
        },
      },
    );

    expect(calls).toEqual(["lock", "event", "advance"]);
    expect(result.projection).toMatchObject({
      state: "delivering",
      revision: "1",
      attemptCount: "1",
    });
    expect(result.transition).toEqual({
      expected: expect.objectContaining({ state: "pending", revision: "0" }),
      next: result.projection,
    });
  });

  it("rejects an invalid operation ID before any database lookup", async () => {
    const lockProjectionForUpdate = vi.fn(async () => initialProjection());
    const tx = transaction({ lockProjectionForUpdate });

    await expect(
      appendSideEffectTransitionInTransaction(tx, "not-a-uuid", {
        transitionId: "22222222-2222-4222-8222-222222222222",
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: {
          tokenSha256: HASH_A,
          expiresAt: "2042-03-04T10:10:00.000Z",
        },
      }),
    ).rejects.toThrow(/operation ID is invalid/i);
    expect(lockProjectionForUpdate).not.toHaveBeenCalled();
  });

  it("does not append or advance when the projection is missing", async () => {
    const insertTransitionEvent = vi.fn(async () => undefined);
    const compareAndAdvanceProjection = vi.fn(async () => true);
    const tx = transaction({
      lockProjectionForUpdate: vi.fn(async () => null),
      insertTransitionEvent,
      compareAndAdvanceProjection,
    });

    await expect(
      appendSideEffectTransitionInTransaction(tx, OPERATION_ID, {
        transitionId: "22222222-2222-4222-8222-222222222222",
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: {
          tokenSha256: HASH_A,
          expiresAt: "2042-03-04T10:10:00.000Z",
        },
      }),
    ).rejects.toThrow(/not found/i);
    expect(insertTransitionEvent).not.toHaveBeenCalled();
    expect(compareAndAdvanceProjection).not.toHaveBeenCalled();
  });

  it("rejects a locked projection with a different identity", async () => {
    const insertTransitionEvent = vi.fn(async () => undefined);
    const tx = transaction({
      lockProjectionForUpdate: vi.fn(async () => initialProjection()),
      insertTransitionEvent,
    });

    await expect(
      appendSideEffectTransitionInTransaction(
        tx,
        "99999999-9999-4999-8999-999999999999",
        {
          transitionId: "22222222-2222-4222-8222-222222222222",
          toState: "delivering",
          trigger: "worker",
          reasonCode: "attempt_started",
          recordedAt: LATER,
          nextLease: {
            tokenSha256: HASH_A,
            expiresAt: "2042-03-04T10:10:00.000Z",
          },
        },
      ),
    ).rejects.toThrow(/identity does not match/i);
    expect(insertTransitionEvent).not.toHaveBeenCalled();
  });

  it("never advances when immutable event insertion fails", async () => {
    const compareAndAdvanceProjection = vi.fn(async () => true);
    const tx = transaction({
      insertTransitionEvent: vi.fn(async () => {
        throw new Error("event insert failed");
      }),
      compareAndAdvanceProjection,
    });

    await expect(
      appendSideEffectTransitionInTransaction(tx, OPERATION_ID, {
        transitionId: "22222222-2222-4222-8222-222222222222",
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: {
          tokenSha256: HASH_A,
          expiresAt: "2042-03-04T10:10:00.000Z",
        },
      }),
    ).rejects.toThrow("event insert failed");
    expect(compareAndAdvanceProjection).not.toHaveBeenCalled();
  });

  it("throws after a lost compare-and-advance so the event cannot commit alone", async () => {
    const tx = transaction({
      compareAndAdvanceProjection: vi.fn(async () => false),
    });

    await expect(
      appendSideEffectTransitionInTransaction(tx, OPERATION_ID, {
        transitionId: "22222222-2222-4222-8222-222222222222",
        toState: "delivering",
        trigger: "worker",
        reasonCode: "attempt_started",
        recordedAt: LATER,
        nextLease: {
          tokenSha256: HASH_A,
          expiresAt: "2042-03-04T10:10:00.000Z",
        },
      }),
    ).rejects.toThrow(/caller transaction must roll back/i);
    expect(tx.insertTransitionEvent).toHaveBeenCalledOnce();
  });

  it("rejects automatic retry from unknown before writing a new event", async () => {
    const initial = initialProjection();
    const active = transitionSideEffectProjection(initial, {
      transitionId: "22222222-2222-4222-8222-222222222221",
      toState: "delivering",
      trigger: "worker",
      reasonCode: "attempt_started",
      recordedAt: LATER,
      nextLease: {
        tokenSha256: HASH_A,
        expiresAt: "2042-03-04T10:10:00.000Z",
      },
    }).projection;
    const unknown = transitionSideEffectProjection(active, {
      transitionId: "22222222-2222-4222-8222-222222222222",
      toState: "unknown",
      trigger: "worker",
      reasonCode: "provider_result_unknown",
      outcomeEvidenceSha256: HASH_B,
      recordedAt: "2042-03-04T10:02:00.000Z",
    }).projection;
    const insertTransitionEvent = vi.fn(async () => undefined);
    const tx = transaction({
      lockProjectionForUpdate: vi.fn(async () => unknown),
      insertTransitionEvent,
    });

    await expect(
      appendSideEffectTransitionInTransaction(tx, OPERATION_ID, {
        transitionId: "22222222-2222-4222-8222-222222222223",
        toState: "pending",
        trigger: "worker",
        reasonCode: "automatic_retry",
        recordedAt: "2042-03-04T10:03:00.000Z",
      }),
    ).rejects.toThrow(/operator evidence/i);
    expect(insertTransitionEvent).not.toHaveBeenCalled();
  });

  it("exposes no commit, rollback, generic DB, or provider side-effect surface", () => {
    const source = readFileSync(
      new URL(
        "../src/lib/side-effect-transaction-contract.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\.(?:commit|rollback)\s*\(/);
    expect(source).not.toMatch(/\bdb\s*\./);
    expect(source).not.toMatch(
      /\.(?:sendMail|putPrivateObject|deletePrivateObject)\s*\(/,
    );
  });
});
