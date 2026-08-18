import {
  createInitialSideEffectProjection,
  createSideEffectIntent,
  transitionSideEffectProjection,
  verifySideEffectProjection,
  type CreateSideEffectIntentInputV1,
  type SideEffectIntentV1,
  type SideEffectProjectionV1,
  type SideEffectTransitionEventV1,
  type TransitionSideEffectInputV1,
} from "./side-effect-lifecycle-contract";

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SideEffectProjectionTransitionV1 = {
  expected: SideEffectProjectionV1;
  next: SideEffectProjectionV1;
};

/**
 * Adapter surface for one already-open domain transaction.
 *
 * It intentionally exposes neither commit/rollback nor a generic DB client.
 * A concrete adapter must map all calls to the same transaction that owns the
 * associated domain mutation. Any thrown error must therefore abort that
 * caller transaction.
 */
export interface SideEffectTransactionV1 {
  insertIntent(intent: SideEffectIntentV1): Promise<void>;
  insertInitialProjection(projection: SideEffectProjectionV1): Promise<void>;
  lockProjectionForUpdate(
    operationId: string,
  ): Promise<SideEffectProjectionV1 | null>;
  insertTransitionEvent(event: SideEffectTransitionEventV1): Promise<void>;
  compareAndAdvanceProjection(
    transition: SideEffectProjectionTransitionV1,
  ): Promise<boolean>;
}

export async function initializeSideEffectInTransaction(
  transaction: SideEffectTransactionV1,
  input: CreateSideEffectIntentInputV1,
): Promise<{
  intent: SideEffectIntentV1;
  projection: SideEffectProjectionV1;
}> {
  const intent = createSideEffectIntent(input);
  const projection = createInitialSideEffectProjection(intent);
  await transaction.insertIntent(intent);
  await transaction.insertInitialProjection(projection);
  return { intent, projection };
}

export async function appendSideEffectTransitionInTransaction(
  transaction: SideEffectTransactionV1,
  operationId: string,
  input: TransitionSideEffectInputV1,
): Promise<{
  event: SideEffectTransitionEventV1;
  projection: SideEffectProjectionV1;
  transition: SideEffectProjectionTransitionV1;
}> {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Side-effect operation ID is invalid.");
  }
  const lockedValue = await transaction.lockProjectionForUpdate(operationId);
  if (!lockedValue) {
    throw new Error("Side-effect projection was not found.");
  }
  const expected = verifySideEffectProjection(lockedValue);
  if (expected.operationId !== operationId) {
    throw new Error("Locked side-effect projection identity does not match.");
  }

  const result = transitionSideEffectProjection(expected, input);
  const transition = { expected, next: result.projection };
  await transaction.insertTransitionEvent(result.event);
  const advanced = await transaction.compareAndAdvanceProjection(transition);
  if (!advanced) {
    throw new Error(
      "Side-effect projection changed concurrently; caller transaction must roll back.",
    );
  }
  return { event: result.event, projection: result.projection, transition };
}
