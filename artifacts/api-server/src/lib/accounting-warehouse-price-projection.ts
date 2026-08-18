import {
  isAccountingWarehousePriceLegacyObservation,
  verifyAccountingWarehousePriceStreamEntry,
  verifyAccountingWarehousePriceStreamStep,
  type AccountingWarehousePriceStreamEntryV1,
} from "./accounting-warehouse-price-stream-contract";

const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const STORED_PRICE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export interface AccountingWarehousePriceProjectionV1 {
  warehouseItemId: string;
  streamHeadObservationId: string | null;
  streamHeadObservationSha256: string | null;
  streamHeadSequence: string | null;
  effectiveObservationId: string | null;
  effectiveObservationSha256: string | null;
  purchasePrice: string | null;
  currency: string | null;
}

function canonicalComparableDecimal(value: string): string {
  if (!STORED_PRICE_PATTERN.test(value)) {
    throw new Error(
      "Warehouse purchase-price projection is not a valid decimal.",
    );
  }
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Replays one complete item-local immutable stream. A withdrawal invalidates
 * only the price-bearing observation it names; this permits deterministic
 * fallback to the latest still-valid price from another document. A corrected
 * observation may start an empty item stream when a correction newly maps a
 * material line to that item.
 */
export function deriveAccountingWarehousePriceProjection(input: {
  warehouseItemId: string;
  observations: unknown[];
}): AccountingWarehousePriceProjectionV1 {
  if (!POSITIVE_DECIMAL_PATTERN.test(input.warehouseItemId)) {
    throw new Error("Warehouse item ID is invalid for price projection.");
  }
  const observations = input.observations.map((value) =>
    verifyAccountingWarehousePriceStreamEntry(value),
  );
  const byId = new Map<string, AccountingWarehousePriceStreamEntryV1>();
  const invalidatedPriceIds = new Set<string>();

  observations.forEach((observation, index) => {
    if (observation.warehouseItemId !== input.warehouseItemId) {
      throw new Error("Warehouse-price projection mixes warehouse items.");
    }
    if (byId.has(observation.observationId)) {
      throw new Error("Warehouse-price projection contains a duplicate ID.");
    }
    if (BigInt(observation.sequence) !== BigInt(index)) {
      throw new Error(
        "Warehouse-price projection requires a contiguous ordered stream.",
      );
    }
    if (index > 0) {
      const previous = observations[index - 1]!;
      const supersedesId = observation.supersedesObservationId;
      const superseded = supersedesId ? byId.get(supersedesId) : null;
      if (!superseded) {
        throw new Error(
          "Warehouse-price projection references a missing superseded observation.",
        );
      }
      verifyAccountingWarehousePriceStreamStep(
        previous,
        observation,
        superseded,
      );
    }
    if (observation.transition === "withdrawn") {
      const targetId = observation.supersedesObservationId;
      const target = targetId ? byId.get(targetId) : null;
      if (
        !target ||
        isAccountingWarehousePriceLegacyObservation(target) ||
        target.transition === "withdrawn" ||
        invalidatedPriceIds.has(target.observationId)
      ) {
        throw new Error(
          "Warehouse-price withdrawal does not target one active price observation.",
        );
      }
      invalidatedPriceIds.add(target.observationId);
    }
    byId.set(observation.observationId, observation);
  });

  const streamHead = observations.at(-1) ?? null;
  let effective: AccountingWarehousePriceStreamEntryV1 | null = null;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const candidate = observations[index]!;
    if (
      candidate.transition !== "withdrawn" &&
      !invalidatedPriceIds.has(candidate.observationId)
    ) {
      effective = candidate;
      break;
    }
  }
  return {
    warehouseItemId: input.warehouseItemId,
    streamHeadObservationId: streamHead?.observationId ?? null,
    streamHeadObservationSha256: streamHead?.integrity.entrySha256 ?? null,
    streamHeadSequence: streamHead?.sequence ?? null,
    effectiveObservationId: effective?.observationId ?? null,
    effectiveObservationSha256: effective?.integrity.entrySha256 ?? null,
    purchasePrice: effective?.purchasePrice ?? null,
    currency: effective?.currency ?? null,
  };
}

export function verifyAccountingWarehousePriceProjectionParity(input: {
  warehouseItemId: string;
  observations: unknown[];
  storedPurchasePrice: string | null;
  storedCurrency: string | null;
}): AccountingWarehousePriceProjectionV1 {
  const projection = deriveAccountingWarehousePriceProjection(input);
  if (projection.purchasePrice === null) {
    if (input.storedPurchasePrice !== null || input.storedCurrency !== null) {
      throw new Error(
        "Warehouse current-price projection should be empty for this observation stream.",
      );
    }
    return projection;
  }
  if (
    input.storedPurchasePrice === null ||
    input.storedCurrency !== projection.currency ||
    canonicalComparableDecimal(input.storedPurchasePrice) !==
      canonicalComparableDecimal(projection.purchasePrice)
  ) {
    throw new Error(
      "Warehouse current-price projection does not match immutable observations.",
    );
  }
  return projection;
}
