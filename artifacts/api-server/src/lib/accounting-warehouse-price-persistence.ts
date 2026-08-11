import {
  canonicalAccountingWarehousePriceObservationJson,
  verifyAccountingWarehousePriceObservation,
  verifyAccountingWarehousePriceSourceBinding,
  type AccountingWarehousePriceObservationV1,
} from "./accounting-warehouse-price-observation-contract";
import {
  canonicalAccountingWarehousePriceStreamEntryJson,
  verifyAccountingWarehousePriceStreamStep,
  type AccountingWarehousePriceStreamEntryV1,
} from "./accounting-warehouse-price-stream-contract";
import type { AccountingDocumentVersionV1 } from "./accounting-document-version-contract";
import type { AccountingLifecycleEventV1 } from "./accounting-lifecycle-event-contract";
import {
  canonicalAccountingExportIntentJson,
  createAccountingWarehousePriceExportIntent,
  type AccountingExportIntentV1,
} from "./accounting-persistence-contract";

/**
 * Persistence surface for an already-open domain transaction.
 *
 * `lockWarehousePriceStreamForUpdate` must lock the owning warehouse item row
 * even when the stream is empty. This serializes the first observation as well
 * as every later append without relying on an observation row already existing.
 */
export interface AccountingWarehousePricePersistenceTransactionV1 {
  lockWarehousePriceStreamForUpdate(
    warehouseItemId: string,
  ): Promise<AccountingWarehousePriceStreamEntryV1 | null>;
  loadWarehousePriceObservationById(
    observationId: string,
  ): Promise<AccountingWarehousePriceStreamEntryV1 | null>;
  insertWarehousePriceObservation(
    observation: AccountingWarehousePriceObservationV1,
  ): Promise<void>;
  loadExportIntentById(
    intentId: string,
  ): Promise<AccountingExportIntentV1 | null>;
  insertExportIntent(intent: AccountingExportIntentV1): Promise<void>;
}

export async function appendAccountingWarehousePriceObservationInTransaction(
  transaction: AccountingWarehousePricePersistenceTransactionV1,
  observationValue: unknown,
  versionValue: AccountingDocumentVersionV1,
  lifecycleEventValue: AccountingLifecycleEventV1,
): Promise<{
  observation: AccountingWarehousePriceObservationV1;
  intent: AccountingExportIntentV1;
  replay: boolean;
}> {
  const observation = verifyAccountingWarehousePriceSourceBinding(
    observationValue,
    versionValue,
    lifecycleEventValue,
  );
  const current = await transaction.lockWarehousePriceStreamForUpdate(
    observation.warehouseItemId,
  );
  const existing = await transaction.loadWarehousePriceObservationById(
    observation.observationId,
  );
  const intent = createAccountingWarehousePriceExportIntent(observation);
  const existingIntent = await transaction.loadExportIntentById(
    intent.intentId,
  );
  if (existing !== null) {
    if (
      canonicalAccountingWarehousePriceStreamEntryJson(existing) !==
      canonicalAccountingWarehousePriceObservationJson(observation)
    ) {
      throw new Error(
        "Warehouse-price observation replay does not match persisted canonical evidence.",
      );
    }
    if (
      existingIntent === null ||
      canonicalAccountingExportIntentJson(existingIntent) !==
        canonicalAccountingExportIntentJson(intent)
    ) {
      throw new Error(
        "Warehouse-price observation replay is missing its exact export intent.",
      );
    }
    return {
      observation: verifyAccountingWarehousePriceObservation(existing),
      intent: existingIntent,
      replay: true,
    };
  }
  if (existingIntent !== null) {
    throw new Error(
      "Warehouse-price export intent exists without its observation.",
    );
  }

  if (current === null) {
    if (observation.sequence !== "0") {
      throw new Error("Warehouse-price stream must begin with sequence zero.");
    }
  } else {
    const supersededId = observation.supersedesObservationId;
    if (supersededId === null) {
      throw new Error(
        "Warehouse-price successor must identify the superseded observation.",
      );
    }
    const superseded =
      await transaction.loadWarehousePriceObservationById(supersededId);
    if (superseded === null) {
      throw new Error(
        "Warehouse-price successor references an observation that is not persisted.",
      );
    }
    verifyAccountingWarehousePriceStreamStep(current, observation, superseded);
  }

  await transaction.insertWarehousePriceObservation(
    verifyAccountingWarehousePriceObservation(observation),
  );
  await transaction.insertExportIntent(intent);
  return { observation, intent, replay: false };
}
