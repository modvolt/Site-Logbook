import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  canonicalAccountingWarehousePriceBootstrapPlanJson,
  createAccountingWarehousePriceBootstrapPlan,
  verifyAccountingWarehousePriceBootstrapPlan,
  verifyAccountingWarehousePriceBootstrapPlanBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes,
} from "../src/lib/accounting-warehouse-price-bootstrap-plan";
import {
  canonicalAccountingWarehousePriceParityReportJson,
  createAccountingWarehousePriceParityReport,
} from "../src/lib/accounting-warehouse-price-parity";
import { sha256Hex } from "../src/lib/evidence-hash";
import {
  assertWarehousePriceBootstrapReportFileSize,
  parseWarehousePriceBootstrapPlanOptions,
  parseWarehousePriceBootstrapVerifyOptions,
  WAREHOUSE_PRICE_BOOTSTRAP_MAX_PLANNED_ITEMS,
  WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES,
} from "../src/scripts/warehouse-price-bootstrap-plan-policy";

const TARGET = "e".repeat(64);
const LIMITS = {
  maxItems: 20,
  maxObservations: 50,
  maxLegacyRows: 50,
};

function legacyItem(input: {
  warehouseItemId: string;
  currentPrice: string;
  currency?: string;
}) {
  return {
    warehouseItemId: input.warehouseItemId,
    storedPurchasePrice: input.currentPrice,
    observations: [],
    projectionHead: null,
    legacyRows: [
      {
        legacyRowId: "10",
        warehouseItemId: input.warehouseItemId,
        billingDocumentId: "40",
        billingDocumentLineId: "400",
        purchasePrice: "8.00",
        currency: input.currency ?? "CZK",
        recordedAt: "2042-09-01T09:00:00.000Z",
      },
      {
        legacyRowId: "12",
        warehouseItemId: input.warehouseItemId,
        billingDocumentId: "42",
        billingDocumentLineId: "501",
        purchasePrice: input.currentPrice,
        currency: input.currency ?? "CZK",
        recordedAt: "2042-10-01T09:00:00.000Z",
      },
    ],
  };
}

function parityBytes(input?: { includeBlocker?: boolean; noLegacy?: boolean }) {
  const items = [
    {
      warehouseItemId: "1",
      storedPurchasePrice: null,
      observations: [],
      projectionHead: null,
      legacyRows: [],
    },
  ];
  if (!input?.noLegacy) {
    items.push(
      legacyItem({
        warehouseItemId: "9",
        currentPrice: "12.50",
        currency: "EUR",
      }),
    );
  }
  if (input?.includeBlocker) {
    items.push({
      warehouseItemId: "11",
      storedPurchasePrice: "7.00",
      observations: [],
      projectionHead: null,
      legacyRows: [],
    });
  }
  const report = createAccountingWarehousePriceParityReport({
    targetFingerprint: TARGET,
    observedAt: "2042-10-01T11:00:00.000Z",
    limits: LIMITS,
    items,
  });
  return canonicalAccountingWarehousePriceParityReportJson(report);
}

describe("accounting warehouse-price bootstrap dry-run plan", () => {
  it("creates exactly one deterministic unknown-history observation per legacy item", () => {
    const sourceBytes = parityBytes();
    const plan = createAccountingWarehousePriceBootstrapPlan({
      parityReportBytes: sourceBytes,
      maxPlannedItems: 10,
    });

    expect(plan.summary).toEqual({
      decision: "REVIEW",
      inputItemCount: 2,
      candidateItemCount: 1,
      plannedObservationCount: 1,
      blockedItemCount: 0,
      noActionItemCount: 1,
    });
    expect(plan.executionBoundary).toEqual({
      mode: "dry-run",
      mutationsSupported: false,
      applyCommandAvailable: false,
      numberedMigrationIncluded: false,
      runtimeActivationIncluded: false,
      readCutoverIncluded: false,
      explicitFutureApprovalRequired: true,
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      warehouseItemId: "9",
      sequence: "0",
      previousObservationSha256: null,
      supersedesObservationId: null,
      transition: "legacy_observation",
      purchasePrice: "12.5",
      currency: "EUR",
      valuationPolicy: {
        mode: "source-currency",
        fxConversionApplied: false,
      },
      source: {
        legacyRowCount: 2,
        latestLegacyRow: {
          legacyRowId: "12",
          observedBillingDocumentId: "42",
          observedBillingDocumentLineId: "501",
          purchasePrice: "12.5",
          currency: "EUR",
          referenceConfidence: "unverified-legacy-reference",
        },
      },
      provenance: {
        captureMode: "legacy-observation",
        historicalCompleteness: "unknown",
        actorKnown: false,
        effectiveAtKnown: false,
        eventHistoryFabricated: false,
        accountingVersionId: null,
        lifecycleEventId: null,
      },
    });

    const second = createAccountingWarehousePriceBootstrapPlan({
      parityReportBytes: sourceBytes,
      maxPlannedItems: 10,
    });
    expect(second).toEqual(plan);
    expect(
      verifyAccountingWarehousePriceBootstrapPlanBinding(plan, sourceBytes),
    ).toEqual(plan);
  });

  it("emits a blocking manifest without disguising eligible or unsafe items", () => {
    const plan = createAccountingWarehousePriceBootstrapPlan({
      parityReportBytes: parityBytes({ includeBlocker: true }),
      maxPlannedItems: 10,
    });
    expect(plan.summary).toMatchObject({
      decision: "BLOCK",
      candidateItemCount: 1,
      blockedItemCount: 1,
      noActionItemCount: 1,
    });
    expect(plan.blockers).toEqual([
      {
        warehouseItemId: "11",
        classification: "unproven_current_price",
      },
    ]);
    expect(plan.executionBoundary.applyCommandAvailable).toBe(false);
  });

  it("returns PASS only when no legacy candidate or blocker exists", () => {
    const plan = createAccountingWarehousePriceBootstrapPlan({
      parityReportBytes: parityBytes({ noLegacy: true }),
      maxPlannedItems: 10,
    });
    expect(plan.summary).toEqual({
      decision: "PASS",
      inputItemCount: 1,
      candidateItemCount: 0,
      plannedObservationCount: 0,
      blockedItemCount: 0,
      noActionItemCount: 1,
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("strictly verifies canonical bytes, integrity and source-report binding", () => {
    const sourceBytes = parityBytes();
    const plan = createAccountingWarehousePriceBootstrapPlan({
      parityReportBytes: sourceBytes,
      maxPlannedItems: 10,
    });
    const canonical = canonicalAccountingWarehousePriceBootstrapPlanJson(plan);
    expect(
      verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(canonical),
    ).toEqual(plan);
    expect(() =>
      verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(
        `${canonical}\n`,
      ),
    ).toThrow(/canonical JSON/i);

    const tampered = structuredClone(plan);
    tampered.candidates[0]!.purchasePrice = "13";
    expect(() => verifyAccountingWarehousePriceBootstrapPlan(tampered)).toThrow(
      /legacy observation/i,
    );

    expect(() =>
      verifyAccountingWarehousePriceBootstrapPlanBinding(
        plan,
        parityBytes({ noLegacy: true }),
      ),
    ).toThrow(/does not match/i);
  });

  it("refuses to capture legacy source rows from the future", () => {
    const report = createAccountingWarehousePriceParityReport({
      targetFingerprint: TARGET,
      observedAt: "2042-08-01T09:00:00.000Z",
      limits: LIMITS,
      items: [legacyItem({ warehouseItemId: "9", currentPrice: "12.50" })],
    });
    expect(() =>
      createAccountingWarehousePriceBootstrapPlan({
        parityReportBytes:
          canonicalAccountingWarehousePriceParityReportJson(report),
        maxPlannedItems: 10,
      }),
    ).toThrow(/captured before its source row/i);
  });

  it("fails closed before planning more items than explicitly approved", () => {
    expect(() =>
      createAccountingWarehousePriceBootstrapPlan({
        parityReportBytes: parityBytes(),
        maxPlannedItems: 0,
      }),
    ).toThrow(/positive integer/i);
    expect(() =>
      createAccountingWarehousePriceBootstrapPlan({
        parityReportBytes: parityBytes(),
        maxPlannedItems: 1,
      }),
    ).not.toThrow();
  });
});

describe("warehouse-price bootstrap planner CLI policy", () => {
  const args = [
    "--parity-report=C:\\evidence\\warehouse-price-parity.json",
    `--expected-report-file-sha256=${"a".repeat(64)}`,
    "--max-planned-items=5000",
  ];

  it("accepts only exact bounded dry-run inputs", () => {
    expect(parseWarehousePriceBootstrapPlanOptions(args)).toEqual({
      parityReportPath: "C:\\evidence\\warehouse-price-parity.json",
      expectedReportFileSha256: "a".repeat(64),
      maxPlannedItems: 5000,
    });
    expect(() => assertWarehousePriceBootstrapReportFileSize(1)).not.toThrow();
    expect(() =>
      assertWarehousePriceBootstrapReportFileSize(
        WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES,
      ),
    ).not.toThrow();
    expect(
      parseWarehousePriceBootstrapVerifyOptions([
        "--plan=C:\\evidence\\warehouse-price-bootstrap-plan.json",
        `--expected-plan-file-sha256=${"b".repeat(64)}`,
        "--parity-report=C:\\evidence\\warehouse-price-parity.json",
        `--expected-report-file-sha256=${"a".repeat(64)}`,
      ]),
    ).toEqual({
      planPath: "C:\\evidence\\warehouse-price-bootstrap-plan.json",
      expectedPlanFileSha256: "b".repeat(64),
      parityReportPath: "C:\\evidence\\warehouse-price-parity.json",
      expectedReportFileSha256: "a".repeat(64),
    });
  });

  it("rejects every mutation alias, unknown input, duplicate and excessive cap", () => {
    for (const mutation of [
      "--apply",
      "--execute=true",
      "--backfill",
      "--update=yes",
      "--delete",
      "--write-database=site_logbook",
    ]) {
      expect(() =>
        parseWarehousePriceBootstrapPlanOptions([...args, mutation]),
      ).toThrow(/forbidden/i);
    }
    expect(() =>
      parseWarehousePriceBootstrapPlanOptions([...args, "--pretty"]),
    ).toThrow(/unsupported/i);
    expect(() =>
      parseWarehousePriceBootstrapPlanOptions([
        ...args,
        "--max-planned-items=10",
      ]),
    ).toThrow(/exactly one/i);
    expect(() =>
      parseWarehousePriceBootstrapPlanOptions(
        args.map((value) =>
          value.startsWith("--max-planned-items=")
            ? `--max-planned-items=${WAREHOUSE_PRICE_BOOTSTRAP_MAX_PLANNED_ITEMS + 1}`
            : value,
        ),
      ),
    ).toThrow(/hard maximum/i);
    expect(() => assertWarehousePriceBootstrapReportFileSize(0)).toThrow(
      /positive safe byte size/i,
    );
    expect(() =>
      assertWarehousePriceBootstrapReportFileSize(
        WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES + 1,
      ),
    ).toThrow(/hard maximum/i);
  });

  it("keeps both executable surfaces offline and free of database/provider clients", () => {
    const plannerSource = readFileSync(
      resolve(
        import.meta.dirname,
        "../src/scripts/plan-warehouse-price-bootstrap.ts",
      ),
      "utf8",
    );
    const verifierSource = readFileSync(
      resolve(
        import.meta.dirname,
        "../src/scripts/verify-warehouse-price-bootstrap-plan.ts",
      ),
      "utf8",
    );
    for (const source of [plannerSource, verifierSource]) {
      expect(source).not.toMatch(/DATABASE_URL|@workspace\/db|from ["']pg["']/);
      expect(source).not.toMatch(/\.query\s*\(|S3|PutObject|docker|coolify/i);
    }
  });

  it("writes exact canonical manifest bytes and exits REVIEW without any apply mode", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const cli = resolve(
      root,
      "artifacts/api-server/src/scripts/plan-warehouse-price-bootstrap.ts",
    );
    const verifyCli = resolve(
      root,
      "artifacts/api-server/src/scripts/verify-warehouse-price-bootstrap-plan.ts",
    );
    const tsx = resolve(root, "scripts/node_modules/tsx/dist/cli.mjs");
    const directory = mkdtempSync(join(tmpdir(), "warehouse-price-plan-"));
    const reportPath = join(directory, "parity.json");
    const planPath = join(directory, "plan.json");
    const sourceBytes = parityBytes();
    writeFileSync(reportPath, sourceBytes, { encoding: "utf8", flag: "wx" });
    try {
      const result = spawnSync(
        process.execPath,
        [
          tsx,
          cli,
          `--parity-report=${reportPath}`,
          `--expected-report-file-sha256=${sha256Hex(sourceBytes)}`,
          "--max-planned-items=10",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(false);
      expect(
        verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(
          result.stdout,
        ).summary.decision,
      ).toBe("REVIEW");
      writeFileSync(planPath, result.stdout, { encoding: "utf8", flag: "wx" });
      const planFileSha256 = sha256Hex(result.stdout);
      const verifyResult = spawnSync(
        process.execPath,
        [
          tsx,
          verifyCli,
          `--plan=${planPath}`,
          `--expected-plan-file-sha256=${planFileSha256}`,
          `--parity-report=${reportPath}`,
          `--expected-report-file-sha256=${sha256Hex(sourceBytes)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(verifyResult.error).toBeUndefined();
      expect(verifyResult.status, verifyResult.stderr).toBe(0);
      expect(verifyResult.stderr).toBe("");
      expect(verifyResult.stdout.endsWith("\n")).toBe(false);
      expect(JSON.parse(verifyResult.stdout)).toMatchObject({
        schemaVersion: "site-logbook.warehouse-price-bootstrap-verification/v1",
        verified: true,
        decision: "REVIEW",
        targetFingerprint: TARGET,
        parityReportFileSha256: sha256Hex(sourceBytes),
        planFileSha256,
      });

      const wrongDigest = spawnSync(
        process.execPath,
        [
          tsx,
          verifyCli,
          `--plan=${planPath}`,
          `--expected-plan-file-sha256=${"0".repeat(64)}`,
          `--parity-report=${reportPath}`,
          `--expected-report-file-sha256=${sha256Hex(sourceBytes)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(wrongDigest.status).toBe(1);
      expect(wrongDigest.stdout).toBe("");
      expect(wrongDigest.stderr).toMatch(/plan file digest/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
