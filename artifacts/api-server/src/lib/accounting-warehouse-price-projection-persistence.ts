import {
  canonicalAccountingWarehousePriceProjectionHeadJson,
  createAccountingWarehousePriceProjectionHead,
  type AccountingWarehousePriceProjectionHeadV1,
} from "./accounting-warehouse-price-projection-head";
import type { AccountingWarehousePriceStreamEntryV1 } from "./accounting-warehouse-price-stream-contract";
import type { AccountingDocumentVersionV1 } from "./accounting-document-version-contract";
import type { AccountingLifecycleEventV1 } from "./accounting-lifecycle-event-contract";
import {
  appendAccountingWarehousePriceObservationInTransaction,
  type AccountingWarehousePricePersistenceTransactionV1,
} from "./accounting-warehouse-price-persistence";

/**
 * Transaction-owned shadow-projection port. The implementation must lock the
 * warehouse item before reading the complete immutable stream so the first
 * insert and every later CAS advance share the observation writer's lock.
 */
export interface AccountingWarehousePriceProjectionPersistenceTransactionV1 {
  lockAndLoadWarehousePriceObservationStreamForProjection(
    warehouseItemId: string,
  ): Promise<AccountingWarehousePriceStreamEntryV1[]>;
  loadWarehousePriceProjectionHeadForUpdate(
    warehouseItemId: string,
  ): Promise<AccountingWarehousePriceProjectionHeadV1 | null>;
  insertWarehousePriceProjectionHead(
    head: AccountingWarehousePriceProjectionHeadV1,
  ): Promise<void>;
  compareAndAdvanceWarehousePriceProjectionHead(
    expectedProjectionSha256: string,
    next: AccountingWarehousePriceProjectionHeadV1,
  ): Promise<boolean>;
}

export async function refreshAccountingWarehousePriceProjectionInTransaction(
  transaction: AccountingWarehousePriceProjectionPersistenceTransactionV1,
  warehouseItemId: string,
): Promise<{
  head: AccountingWarehousePriceProjectionHeadV1;
  replay: boolean;
  initialized: boolean;
}> {
  const observations =
    await transaction.lockAndLoadWarehousePriceObservationStreamForProjection(
      warehouseItemId,
    );
  const next = createAccountingWarehousePriceProjectionHead({
    warehouseItemId,
    observations,
  });
  const current =
    await transaction.loadWarehousePriceProjectionHeadForUpdate(
      warehouseItemId,
    );
  if (current === null) {
    await transaction.insertWarehousePriceProjectionHead(next);
    return { head: next, replay: false, initialized: true };
  }
  if (
    canonicalAccountingWarehousePriceProjectionHeadJson(current) ===
    canonicalAccountingWarehousePriceProjectionHeadJson(next)
  ) {
    return { head: current, replay: true, initialized: false };
  }
  if (
    BigInt(next.streamHead.sequence) !==
    BigInt(current.streamHead.sequence) + 1n
  ) {
    throw new Error(
      "Warehouse-price projection must advance exactly one observation; use a separately reviewed bootstrap for gaps.",
    );
  }
  if (
    !(await transaction.compareAndAdvanceWarehousePriceProjectionHead(
      current.integrity.projectionSha256,
      next,
    ))
  ) {
    throw new Error("Warehouse-price projection CAS lost its locked head.");
  }
  return { head: next, replay: false, initialized: false };
}

/**
 * Preferred caller seam: immutable observation, archive intent and the
 * explicit-currency shadow projection all share the caller's transaction.
 */
export async function appendAccountingWarehousePriceWithProjectionInTransaction(
  transaction: AccountingWarehousePricePersistenceTransactionV1 &
    AccountingWarehousePriceProjectionPersistenceTransactionV1,
  observationValue: unknown,
  versionValue: AccountingDocumentVersionV1,
  lifecycleEventValue: AccountingLifecycleEventV1,
) {
  const appended = await appendAccountingWarehousePriceObservationInTransaction(
    transaction,
    observationValue,
    versionValue,
    lifecycleEventValue,
  );
  const projection =
    await refreshAccountingWarehousePriceProjectionInTransaction(
      transaction,
      appended.observation.warehouseItemId,
    );
  return { ...appended, projection };
}
