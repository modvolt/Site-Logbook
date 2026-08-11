import { describe, expect, it } from "vitest";
import {
  createAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import {
  deriveAccountingWarehousePriceProjection,
  verifyAccountingWarehousePriceProjectionParity,
} from "../src/lib/accounting-warehouse-price-projection";

const HASH = "a".repeat(64);
const DETAIL_HASH = "b".repeat(64);
const MATCH_HASH = "c".repeat(64);

function observation(input: {
  id: string;
  item?: string;
  sequence: number;
  previous: AccountingWarehousePriceObservationV1 | null;
  supersedes: AccountingWarehousePriceObservationV1 | null;
  transition: "observed" | "corrected" | "withdrawn";
  aggregateId: string;
  versionId: string;
  eventId: string;
  price: string | null;
}): AccountingWarehousePriceObservationV1 {
  const detail = input.transition === "observed" ? null : DETAIL_HASH;
  return createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId: input.id,
    warehouseItemId: input.item ?? "17",
    sequence: String(input.sequence),
    previousObservationSha256: input.previous?.integrity.entrySha256 ?? null,
    supersedesObservationId: input.supersedes?.observationId ?? null,
    transition: input.transition,
    source: {
      aggregateId: input.aggregateId,
      accountingVersionId: input.versionId,
      accountingVersionSha256: HASH,
      lifecycleEventId: input.eventId,
      lifecycleEventSha256: HASH,
      sourceLineId: "501",
    },
    purchasePrice: input.price,
    currency: "CZK",
    warehouseMatch:
      input.transition === "withdrawn"
        ? null
        : { mode: "code", evidenceSha256: MATCH_HASH },
    actor: { kind: "user", id: "7", authentication: "step-up" },
    reasonCode:
      input.transition === "observed"
        ? "document_approved"
        : input.transition === "corrected"
          ? "correction_approved"
          : "review_reopened",
    reasonDetailSha256: detail,
    effectiveAt: "2042-09-01T10:00:00.000Z",
    recordedAt: "2042-09-01T10:00:00.000Z",
  });
}

function twoDocumentsThenWithdrawal() {
  const first = observation({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: 0,
    previous: null,
    supersedes: null,
    transition: "observed",
    aggregateId: "42",
    versionId: "11111111-1111-4111-8111-111111111111",
    eventId: "21111111-1111-4111-8111-111111111111",
    price: "10",
  });
  const second = observation({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 1,
    previous: first,
    supersedes: first,
    transition: "observed",
    aggregateId: "43",
    versionId: "12222222-2222-4222-8222-222222222222",
    eventId: "22222222-2222-4222-8222-222222222222",
    price: "12",
  });
  const withdrawn = observation({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sequence: 2,
    previous: second,
    supersedes: second,
    transition: "withdrawn",
    aggregateId: "43",
    versionId: second.source.accountingVersionId,
    eventId: "23333333-3333-4333-8333-333333333333",
    price: null,
  });
  return { first, second, withdrawn };
}

describe("accounting warehouse-price projection", () => {
  it("falls back to the latest still-valid price after another document is withdrawn", () => {
    const { first, second, withdrawn } = twoDocumentsThenWithdrawal();
    expect(
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [first, second, withdrawn],
      }),
    ).toMatchObject({
      streamHeadObservationId: withdrawn.observationId,
      streamHeadSequence: "2",
      effectiveObservationId: first.observationId,
      purchasePrice: "10",
      currency: "CZK",
    });
  });

  it("allows a correction-created price to start a previously empty item stream", () => {
    const corrected = observation({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      item: "18",
      sequence: 0,
      previous: null,
      supersedes: null,
      transition: "corrected",
      aggregateId: "44",
      versionId: "14444444-4444-4444-8444-444444444444",
      eventId: "24444444-4444-4444-8444-444444444444",
      price: "15",
    });
    expect(
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "18",
        observations: [corrected],
      }),
    ).toMatchObject({
      effectiveObservationId: corrected.observationId,
      purchasePrice: "15",
    });
  });

  it("projects a corrected price after the prior source observation is withdrawn", () => {
    const { first } = twoDocumentsThenWithdrawal();
    const withdrawn = observation({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sequence: 1,
      previous: first,
      supersedes: first,
      transition: "withdrawn",
      aggregateId: first.source.aggregateId,
      versionId: first.source.accountingVersionId,
      eventId: "25555555-5555-4555-8555-555555555555",
      price: null,
    });
    const corrected = observation({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sequence: 2,
      previous: withdrawn,
      supersedes: withdrawn,
      transition: "corrected",
      aggregateId: first.source.aggregateId,
      versionId: "16666666-6666-4666-8666-666666666666",
      eventId: "26666666-6666-4666-8666-666666666666",
      price: "11",
    });
    expect(
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [first, withdrawn, corrected],
      }).purchasePrice,
    ).toBe("11");
  });

  it("allows a correction to add or move a line onto an existing item stream", () => {
    const { first } = twoDocumentsThenWithdrawal();
    const corrected = observation({
      id: "19999999-9999-4999-8999-999999999999",
      sequence: 1,
      previous: first,
      supersedes: first,
      transition: "corrected",
      aggregateId: "46",
      versionId: "19999999-9999-4999-8999-999999999998",
      eventId: "29999999-9999-4999-8999-999999999999",
      price: "16",
    });
    expect(
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [first, corrected],
      }),
    ).toMatchObject({
      effectiveObservationId: corrected.observationId,
      purchasePrice: "16",
      currency: "CZK",
    });
  });

  it("verifies numeric parity while requiring an explicit matching currency", () => {
    const { first } = twoDocumentsThenWithdrawal();
    expect(
      verifyAccountingWarehousePriceProjectionParity({
        warehouseItemId: "17",
        observations: [first],
        storedPurchasePrice: "10.00",
        storedCurrency: "CZK",
      }).effectiveObservationId,
    ).toBe(first.observationId);
    expect(() =>
      verifyAccountingWarehousePriceProjectionParity({
        warehouseItemId: "17",
        observations: [first],
        storedPurchasePrice: "10.00",
        storedCurrency: null,
      }),
    ).toThrow(/does not match/i);
    expect(
      verifyAccountingWarehousePriceProjectionParity({
        warehouseItemId: "19",
        observations: [],
        storedPurchasePrice: null,
        storedCurrency: null,
      }).purchasePrice,
    ).toBeNull();
  });

  it("rejects gaps, item mixing, double withdrawal and observed supersession drift", () => {
    const { first, second, withdrawn } = twoDocumentsThenWithdrawal();
    expect(() =>
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [second, first],
      }),
    ).toThrow(/contiguous ordered/i);
    expect(() =>
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "99",
        observations: [first],
      }),
    ).toThrow(/mixes warehouse items/i);

    const doubleWithdrawal = observation({
      id: "17777777-7777-4777-8777-777777777777",
      sequence: 3,
      previous: withdrawn,
      supersedes: second,
      transition: "withdrawn",
      aggregateId: second.source.aggregateId,
      versionId: second.source.accountingVersionId,
      eventId: "27777777-7777-4777-8777-777777777777",
      price: null,
    });
    expect(() =>
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [first, second, withdrawn, doubleWithdrawal],
      }),
    ).toThrow(/one active price observation/i);

    const thirdObservedWrongTarget = observation({
      id: "18888888-8888-4888-8888-888888888888",
      sequence: 2,
      previous: second,
      supersedes: first,
      transition: "observed",
      aggregateId: "45",
      versionId: "18888888-8888-4888-8888-888888888889",
      eventId: "28888888-8888-4888-8888-888888888888",
      price: "14",
    });
    expect(() =>
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "17",
        observations: [first, second, thirdObservedWrongTarget],
      }),
    ).toThrow(/previous item head/i);
  });
});
