import { describe, expect, it } from "vitest";
import {
  canonicalAccountingWarehousePriceParityReportJson,
  createAccountingWarehousePriceParityReport,
  verifyAccountingWarehousePriceParityReport,
  verifyCanonicalAccountingWarehousePriceParityReportJsonBytes,
  type AccountingWarehousePriceParityReportV1,
} from "../src/lib/accounting-warehouse-price-parity";
import {
  createAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import { createAccountingWarehousePriceProjectionHead } from "../src/lib/accounting-warehouse-price-projection-head";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";
import {
  databaseNameFromParityPostgresUrl,
  parseWarehousePriceParityAuditOptions,
  WAREHOUSE_PRICE_PARITY_BEGIN_SQL,
} from "../src/scripts/warehouse-price-parity-audit-policy";

const TARGET = "d".repeat(64);
const LIMITS = {
  maxItems: 20,
  maxObservations: 50,
  maxLegacyRows: 50,
};

function observed(input: {
  id: string;
  item: string;
  price: string;
}): AccountingWarehousePriceObservationV1 {
  return createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId: input.id,
    warehouseItemId: input.item,
    sequence: "0",
    previousObservationSha256: null,
    supersedesObservationId: null,
    transition: "observed",
    source: {
      aggregateId: input.item,
      accountingVersionId: "11111111-1111-4111-8111-111111111111",
      accountingVersionSha256: "a".repeat(64),
      lifecycleEventId: "22222222-2222-4222-8222-222222222222",
      lifecycleEventSha256: "b".repeat(64),
      sourceLineId: "501",
    },
    purchasePrice: input.price,
    currency: "CZK",
    warehouseMatch: { mode: "code", evidenceSha256: "c".repeat(64) },
    actor: { kind: "user", id: "7", authentication: "step-up" },
    reasonCode: "document_approved",
    reasonDetailSha256: null,
    effectiveAt: "2042-10-01T10:00:00.000Z",
    recordedAt: "2042-10-01T10:00:00.000Z",
  });
}

function report() {
  const nativeUnbound = observed({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    item: "3",
    price: "10",
  });
  const nativeMatch = observed({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    item: "4",
    price: "12",
  });
  return createAccountingWarehousePriceParityReport({
    targetFingerprint: TARGET,
    observedAt: "2042-10-01T11:00:00.000Z",
    limits: LIMITS,
    items: [
      {
        warehouseItemId: "1",
        storedPurchasePrice: null,
        observations: [],
        projectionHead: null,
        legacyRows: [],
      },
      {
        warehouseItemId: "2",
        storedPurchasePrice: "9.00",
        observations: [],
        projectionHead: null,
        legacyRows: [
          {
            legacyRowId: "20",
            warehouseItemId: "2",
            billingDocumentId: "42",
            billingDocumentLineId: "501",
            purchasePrice: "9.00",
            currency: "CZK",
            recordedAt: "2042-09-01T09:00:00.000Z",
          },
        ],
      },
      {
        warehouseItemId: "3",
        storedPurchasePrice: "10.00",
        observations: [nativeUnbound],
        projectionHead: null,
        legacyRows: [],
      },
      {
        warehouseItemId: "4",
        storedPurchasePrice: "12.00",
        observations: [nativeMatch],
        projectionHead: createAccountingWarehousePriceProjectionHead({
          warehouseItemId: "4",
          observations: [nativeMatch],
        }),
        legacyRows: [],
      },
      {
        warehouseItemId: "5",
        storedPurchasePrice: "7.00",
        observations: [],
        projectionHead: null,
        legacyRows: [],
      },
    ],
  });
}

function rehash(value: AccountingWarehousePriceParityReportV1) {
  const unsigned = {
    ...value,
    integrity: { ...value.integrity, reportSha256: null },
  };
  return {
    ...value,
    integrity: {
      ...value.integrity,
      reportSha256: sha256Hex(
        `site-logbook.warehouse-price-parity-report/v2\0${canonicalEvidenceJson(unsigned)}`,
      ),
    },
  };
}

describe("accounting warehouse-price parity report", () => {
  it("classifies empty, legacy, currency-unbound, matching and unproven items", () => {
    const value = report();
    expect(value.summary).toMatchObject({
      decision: "BLOCK",
      itemCount: 5,
      observationCount: 2,
      legacyRowCount: 1,
      classificationCounts: {
        empty: 1,
        legacy_only: 1,
        native_projection_missing: 1,
        native_match: 1,
        unproven_current_price: 1,
      },
    });
    expect(value.items.map((item) => item.classification)).toEqual([
      "empty",
      "legacy_only",
      "native_projection_missing",
      "native_match",
      "unproven_current_price",
    ]);
    expect(value.items[1]?.legacyRows[0]).toMatchObject({
      historicalCompleteness: "unknown",
      purchasePrice: "9",
    });
  });

  it("round-trips exact canonical bytes and rejects semantic reclassification", () => {
    const value = report();
    const canonical = canonicalAccountingWarehousePriceParityReportJson(value);
    expect(
      verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(canonical),
    ).toEqual(value);

    const changed = structuredClone(value);
    changed.items[2]!.classification = "native_match";
    changed.summary.classificationCounts.native_projection_missing -= 1;
    changed.summary.classificationCounts.native_match += 1;
    expect(() =>
      verifyAccountingWarehousePriceParityReport(rehash(changed)),
    ).toThrow(/semantics/i);

    const changedLegacy = structuredClone(value);
    changedLegacy.items[1]!.legacyRows[0]!.purchasePrice = "10";
    expect(() =>
      verifyAccountingWarehousePriceParityReport(rehash(changedLegacy)),
    ).toThrow(/semantics/i);
    expect(() =>
      verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(
        `${canonical}\n`,
      ),
    ).toThrow(/canonical JSON/i);
  });

  it("fails closed when approved inventory limits are exceeded", () => {
    expect(() =>
      createAccountingWarehousePriceParityReport({
        targetFingerprint: TARGET,
        observedAt: "2042-10-01T11:00:00.000Z",
        limits: { ...LIMITS, maxItems: 1 },
        items: report().items.map((item) => ({
          warehouseItemId: item.warehouseItemId,
          storedPurchasePrice: item.storedPurchasePrice,
          observations: item.observations,
          projectionHead: item.projectionHead,
          legacyRows: item.legacyRows.map(
            ({
              rowSha256: _hash,
              historicalCompleteness: _completeness,
              ...row
            }) => row,
          ),
        })),
      }),
    ).toThrow(/exceeds approved limits/i);
  });
});

describe("warehouse-price parity read-only CLI policy", () => {
  const args = [
    "--database=site_logbook_staging",
    `--target-fingerprint=${TARGET}`,
    "--max-items=5000",
    "--max-observations=50000",
    "--max-legacy-rows=50000",
  ];

  it("requires an exact bounded target contract and read-only SQL", () => {
    expect(parseWarehousePriceParityAuditOptions(args)).toEqual({
      database: "site_logbook_staging",
      targetFingerprint: TARGET,
      maxItems: 5000,
      maxObservations: 50000,
      maxLegacyRows: 50000,
    });
    expect(WAREHOUSE_PRICE_PARITY_BEGIN_SQL).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(
      databaseNameFromParityPostgresUrl(
        "postgresql://user:pass@127.0.0.1:5432/site_logbook_staging",
      ),
    ).toBe("site_logbook_staging");
  });

  it("rejects mutation flags, unknown args, missing caps and excessive caps", () => {
    expect(() =>
      parseWarehousePriceParityAuditOptions([...args, "--apply"]),
    ).toThrow(/forbidden/i);
    expect(() =>
      parseWarehousePriceParityAuditOptions([...args, "--format=pretty"]),
    ).toThrow(/unsupported/i);
    expect(() =>
      parseWarehousePriceParityAuditOptions(
        args.filter((value) => !value.startsWith("--max-items=")),
      ),
    ).toThrow(/exactly one --max-items/i);
    expect(() =>
      parseWarehousePriceParityAuditOptions(
        args.map((value) =>
          value.startsWith("--max-items=") ? "--max-items=20001" : value,
        ),
      ),
    ).toThrow(/hard maximum/i);
  });
});
