import { describe, expect, it } from "vitest";
import {
  canonicalAccountingWarehousePriceProjectionHeadJson,
  createAccountingWarehousePriceProjectionHead,
  verifyAccountingWarehousePriceProjectionHead,
  verifyAccountingWarehousePriceProjectionHeadBinding,
  verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes,
} from "../src/lib/accounting-warehouse-price-projection-head";
import {
  createAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";

function observation(input: {
  id: string;
  sequence: string;
  previous: string | null;
  supersedes: string | null;
  transition: "observed" | "withdrawn" | "corrected";
  price: string | null;
  currency?: string;
  recordedAt: string;
}): AccountingWarehousePriceObservationV1 {
  return createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId: input.id,
    warehouseItemId: "41",
    sequence: input.sequence,
    previousObservationSha256: input.previous,
    supersedesObservationId: input.supersedes,
    transition: input.transition,
    source: {
      aggregateId: input.transition === "corrected" ? "8" : "7",
      accountingVersionId:
        input.transition === "corrected"
          ? "22222222-2222-4222-8222-222222222222"
          : "11111111-1111-4111-8111-111111111111",
      accountingVersionSha256: "a".repeat(64),
      lifecycleEventId:
        input.transition === "observed"
          ? "33333333-3333-4333-8333-333333333333"
          : "44444444-4444-4444-8444-444444444444",
      lifecycleEventSha256: "b".repeat(64),
      sourceLineId: "501",
    },
    purchasePrice: input.price,
    currency: input.currency ?? "CZK",
    warehouseMatch:
      input.transition === "withdrawn"
        ? null
        : { mode: "manual", evidenceSha256: "c".repeat(64) },
    actor: { kind: "user", id: "7", authentication: "step-up" },
    reasonCode:
      input.transition === "observed"
        ? "document_approved"
        : input.transition === "withdrawn"
          ? "review_reopened"
          : "correction_approved",
    reasonDetailSha256: input.transition === "observed" ? null : "d".repeat(64),
    effectiveAt: input.recordedAt,
    recordedAt: input.recordedAt,
  });
}

function stream() {
  const first = observation({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: "0",
    previous: null,
    supersedes: null,
    transition: "observed",
    price: "10",
    recordedAt: "2042-11-01T10:00:00.000Z",
  });
  const second = observation({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: "1",
    previous: first.integrity.entrySha256,
    supersedes: first.observationId,
    transition: "observed",
    price: "12",
    currency: "EUR",
    recordedAt: "2042-11-01T11:00:00.000Z",
  });
  return [first, second];
}

describe("accounting warehouse-price projection head", () => {
  it("binds the current amount to its explicit source currency without FX", () => {
    const head = createAccountingWarehousePriceProjectionHead({
      warehouseItemId: "41",
      observations: stream(),
    });
    expect(head).toMatchObject({
      warehouseItemId: "41",
      streamHead: {
        observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sequence: "1",
      },
      effectivePrice: {
        observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        purchasePrice: "12",
        currency: "EUR",
      },
      valuationPolicy: {
        mode: "source-currency",
        fxConversionApplied: false,
      },
      projectedAt: "2042-11-01T11:00:00.000Z",
    });
    const canonical = canonicalAccountingWarehousePriceProjectionHeadJson(head);
    expect(
      verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(canonical),
    ).toEqual(head);
    expect(
      verifyAccountingWarehousePriceProjectionHeadBinding(head, stream()),
    ).toEqual(head);
  });

  it("preserves an empty effective tuple after withdrawing the only price", () => {
    const [first] = stream();
    const withdrawn = observation({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sequence: "1",
      previous: first!.integrity.entrySha256,
      supersedes: first!.observationId,
      transition: "withdrawn",
      price: null,
      recordedAt: "2042-11-01T12:00:00.000Z",
    });
    expect(
      createAccountingWarehousePriceProjectionHead({
        warehouseItemId: "41",
        observations: [first, withdrawn],
      }).effectivePrice,
    ).toBeNull();
  });

  it("rejects FX, currency and observation-binding mutations even when rehashed", () => {
    const observations = stream();
    const head = createAccountingWarehousePriceProjectionHead({
      warehouseItemId: "41",
      observations,
    });
    expect(() =>
      verifyAccountingWarehousePriceProjectionHead({
        ...head,
        valuationPolicy: {
          mode: "source-currency",
          fxConversionApplied: true,
        },
      }),
    ).toThrow();

    const changed = structuredClone(head);
    changed.effectivePrice!.currency = "CZK";
    const unsigned = {
      ...changed,
      integrity: { ...changed.integrity, projectionSha256: null },
    };
    changed.integrity.projectionSha256 = sha256Hex(
      `site-logbook.warehouse-price-projection-head/v1\0${canonicalEvidenceJson(unsigned)}`,
    );
    expect(() =>
      verifyAccountingWarehousePriceProjectionHeadBinding(
        changed,
        observations,
      ),
    ).toThrow(/does not match immutable observations/i);
  });

  it("rejects empty streams and noncanonical bytes", () => {
    expect(() =>
      createAccountingWarehousePriceProjectionHead({
        warehouseItemId: "41",
        observations: [],
      }),
    ).toThrow(/non-empty/i);
    const canonical = canonicalAccountingWarehousePriceProjectionHeadJson(
      createAccountingWarehousePriceProjectionHead({
        warehouseItemId: "41",
        observations: stream(),
      }),
    );
    expect(() =>
      verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
        `${canonical}\n`,
      ),
    ).toThrow(/canonical JSON/i);
  });
});
