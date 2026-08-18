import {
  canonicalAccountingWarehousePriceLegacyObservationJson,
  verifyAccountingWarehousePriceLegacyObservation,
  verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  canonicalAccountingWarehousePriceObservationJson,
  verifyAccountingWarehousePriceChainStep,
  verifyAccountingWarehousePriceObservation,
  verifyCanonicalAccountingWarehousePriceObservationJsonBytes,
  type AccountingWarehousePriceObservationV1,
} from "./accounting-warehouse-price-observation-contract";

export type AccountingWarehousePriceStreamEntryV1 =
  | AccountingWarehousePriceLegacyObservationV1
  | AccountingWarehousePriceObservationV1;

export function isAccountingWarehousePriceLegacyObservation(
  value: AccountingWarehousePriceStreamEntryV1,
): value is AccountingWarehousePriceLegacyObservationV1 {
  return (
    value.schemaVersion === "site-logbook.warehouse-price-legacy-observation/v1"
  );
}

export function verifyAccountingWarehousePriceStreamEntry(
  value: unknown,
): AccountingWarehousePriceStreamEntryV1 {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === "site-logbook.warehouse-price-legacy-observation/v1"
  ) {
    return verifyAccountingWarehousePriceLegacyObservation(value);
  }
  return verifyAccountingWarehousePriceObservation(value);
}

export function canonicalAccountingWarehousePriceStreamEntryJson(
  value: unknown,
): string {
  const entry = verifyAccountingWarehousePriceStreamEntry(value);
  return isAccountingWarehousePriceLegacyObservation(entry)
    ? canonicalAccountingWarehousePriceLegacyObservationJson(entry)
    : canonicalAccountingWarehousePriceObservationJson(entry);
}

export function verifyCanonicalAccountingWarehousePriceStreamEntryJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceStreamEntryV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Warehouse-price stream entry is not valid JSON.");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed &&
    parsed.schemaVersion ===
      "site-logbook.warehouse-price-legacy-observation/v1"
  ) {
    return verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes(
      text,
    );
  }
  return verifyCanonicalAccountingWarehousePriceObservationJsonBytes(text);
}

/**
 * Verifies one successor in the item-local stream. A legacy observation can
 * exist only as sequence zero. Its first native successor must explicitly
 * supersede it; withdrawals can never target the unknown-history legacy row.
 */
export function verifyAccountingWarehousePriceStreamStep(
  previousValue: unknown,
  currentValue: unknown,
  supersededValue: unknown,
): AccountingWarehousePriceStreamEntryV1 {
  const previous = verifyAccountingWarehousePriceStreamEntry(previousValue);
  const current = verifyAccountingWarehousePriceStreamEntry(currentValue);
  const superseded = verifyAccountingWarehousePriceStreamEntry(supersededValue);
  if (isAccountingWarehousePriceLegacyObservation(current)) {
    throw new Error(
      "Warehouse-price legacy observation can only initialize an empty stream.",
    );
  }
  if (isAccountingWarehousePriceLegacyObservation(previous)) {
    if (
      !isAccountingWarehousePriceLegacyObservation(superseded) ||
      current.warehouseItemId !== previous.warehouseItemId ||
      current.sequence !== "1" ||
      current.previousObservationSha256 !== previous.integrity.entrySha256 ||
      current.supersedesObservationId !== previous.observationId ||
      current.transition === "withdrawn"
    ) {
      throw new Error(
        "The first native warehouse-price observation does not exactly supersede the legacy head.",
      );
    }
    return current;
  }
  if (isAccountingWarehousePriceLegacyObservation(superseded)) {
    throw new Error(
      "A later native warehouse-price transition cannot target legacy evidence.",
    );
  }
  return verifyAccountingWarehousePriceChainStep(previous, current, superseded);
}

export function accountingWarehousePriceStreamEntryRecordedAt(
  entry: AccountingWarehousePriceStreamEntryV1,
): string {
  return isAccountingWarehousePriceLegacyObservation(entry)
    ? entry.provenance.capturedAt
    : entry.recordedAt;
}
