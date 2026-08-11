import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";
import {
  db,
  accountingExportOutboxTable,
  accountingWarehousePriceObservationsTable,
  accountingWarehousePriceProjectionHeadsTable,
  pool,
  warehouseItemsTable,
  warehousePriceHistoryTable,
} from "@workspace/db";
import { verifyCanonicalAccountingWarehousePriceParityReportJsonBytes } from "../src/lib/accounting-warehouse-price-parity";
import {
  canonicalAccountingWarehousePriceBootstrapPlanJson,
  createAccountingWarehousePriceBootstrapPlan,
  verifyAccountingWarehousePriceBootstrapPlanBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes,
} from "../src/lib/accounting-warehouse-price-bootstrap-plan";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION,
  applyAccountingWarehousePriceBootstrapInTransaction,
  canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson,
  createAccountingWarehousePriceBootstrapApplyAuthorization,
} from "../src/lib/accounting-warehouse-price-bootstrap-apply";
import { createAccountingWarehousePriceBootstrapDbAdapter } from "../src/lib/accounting-persistence-db-adapter";
import { createAccountingWarehousePriceLegacyObservation } from "../src/lib/accounting-warehouse-price-legacy-observation-contract";
import { eq } from "drizzle-orm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(
  ROOT,
  "artifacts/api-server/src/scripts/audit-warehouse-price-parity.ts",
);
const PLAN_CLI = resolve(
  ROOT,
  "artifacts/api-server/src/scripts/plan-warehouse-price-bootstrap.ts",
);
const TSX = resolve(ROOT, "scripts/node_modules/tsx/dist/cli.mjs");
const TARGET_FINGERPRINT = "e".repeat(64);

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
});

function databaseName(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required for the DB audit test.");
  return decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
}

function runAudit(maxItems: number) {
  return spawnSync(
    process.execPath,
    [
      TSX,
      CLI,
      `--database=${databaseName()}`,
      `--target-fingerprint=${TARGET_FINGERPRINT}`,
      `--max-items=${maxItems}`,
      "--max-observations=10",
      "--max-legacy-rows=10",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function runPlan(parityReportBytes: string, maxPlannedItems: number) {
  const directory = mkdtempSync(join(tmpdir(), "warehouse-price-db-plan-"));
  const reportPath = join(directory, "parity.json");
  writeFileSync(reportPath, parityReportBytes, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    return spawnSync(
      process.execPath,
      [
        TSX,
        PLAN_CLI,
        `--parity-report=${reportPath}`,
        `--expected-report-file-sha256=${sha256Hex(parityReportBytes)}`,
        `--max-planned-items=${maxPlannedItems}`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function applyArtifacts(reportBytes: string) {
  const plan = createAccountingWarehousePriceBootstrapPlan({
    parityReportBytes: reportBytes,
    maxPlannedItems: 10,
  });
  const planBytes = canonicalAccountingWarehousePriceBootstrapPlanJson(plan);
  const authorization =
    createAccountingWarehousePriceBootstrapApplyAuthorization({
      schemaVersion:
        "site-logbook.warehouse-price-bootstrap-apply-authorization/v1",
      operation: "warehouse-price-legacy-bootstrap",
      plan: {
        planSha256: plan.integrity.planSha256,
        planFileSha256: sha256Hex(planBytes),
        parityReportSha256: plan.sourceReport.reportSha256,
        parityReportFileSha256: sha256Hex(reportBytes),
        targetFingerprint: TARGET_FINGERPRINT,
        candidateCount: plan.candidates.length,
      },
      approval: {
        decision: "approved",
        confirmation: ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION,
        approvedAt: "2025-10-01T12:00:00.000Z",
        approvedByUserId: "1",
        approvalEvidenceSha256: "a".repeat(64),
        unknownHistoryAccepted: true,
        sourceCurrencyNoFxAccepted: true,
      },
      executionBoundary: {
        callerOwnedTransactionRequired: true,
        candidateLocksAscending: true,
        exactReplayOnly: true,
        numberedMigrationIncluded: false,
        runtimeActivationIncluded: false,
        readCutoverIncluded: false,
        providerWriteIncluded: false,
      },
    });
  return {
    plan,
    planBytes,
    authorizationBytes:
      canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson(
        authorization,
      ),
  };
}

async function mutableProjectionSnapshot(): Promise<string> {
  const result = await pool.query<{ snapshot: string }>(`
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(to_jsonb(item) order by item.id) from warehouse_items item), '[]'::jsonb),
      'legacy', coalesce((select jsonb_agg(to_jsonb(price) order by price.id) from warehouse_price_history price), '[]'::jsonb),
      'observations', coalesce((select jsonb_agg(to_jsonb(observation) order by observation.id) from accounting_warehouse_price_observations observation), '[]'::jsonb)
    )::text as snapshot
  `);
  return result.rows[0]!.snapshot;
}

describe("warehouse-price parity read-only PostgreSQL audit", () => {
  it("produces a bounded canonical review report without mutating or leaking legacy metadata", async () => {
    const [emptyItem, legacyItem] = await db
      .insert(warehouseItemsTable)
      .values([
        { name: `D9E-empty-${Date.now()}` },
        { name: `D9E-legacy-${Date.now()}`, purchasePrice: "9.00" },
      ])
      .returning({ id: warehouseItemsTable.id });
    await db.insert(warehousePriceHistoryTable).values({
      warehouseItemId: legacyItem!.id,
      purchasePrice: "9.00",
      currency: "CZK",
      supplierName: "PARITY_SECRET_SUPPLIER_MUST_NOT_LEAK",
      note: "PARITY_PRIVATE_NOTE_MUST_NOT_LEAK",
      createdAt: new Date("2025-10-01T10:00:00.000Z"),
    });

    const before = await mutableProjectionSnapshot();
    const result = runAudit(10);
    const after = await mutableProjectionSnapshot();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(after).toBe(before);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(false);
    expect(result.stdout).not.toContain("PARITY_SECRET_SUPPLIER_MUST_NOT_LEAK");
    expect(result.stdout).not.toContain("PARITY_PRIVATE_NOTE_MUST_NOT_LEAK");

    const report = verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(
      result.stdout.trimEnd(),
    );
    expect(report).toMatchObject({
      targetFingerprint: TARGET_FINGERPRINT,
      readBoundary: {
        transactionReadOnly: true,
        isolation: "repeatable read",
        mutationsSupported: false,
      },
      summary: {
        decision: "REVIEW",
        itemCount: 2,
        observationCount: 0,
        legacyRowCount: 1,
        classificationCounts: { empty: 1, legacy_only: 1 },
      },
    });
    expect(report.items).toEqual([
      expect.objectContaining({
        warehouseItemId: String(emptyItem!.id),
        classification: "empty",
      }),
      expect.objectContaining({
        warehouseItemId: String(legacyItem!.id),
        classification: "legacy_only",
        storedPurchasePrice: "9",
        storedCurrency: null,
        legacyRows: [
          expect.objectContaining({
            purchasePrice: "9",
            currency: "CZK",
            historicalCompleteness: "unknown",
          }),
        ],
      }),
    ]);

    const planResult = runPlan(result.stdout, 10);
    const afterPlan = await mutableProjectionSnapshot();
    expect(planResult.error).toBeUndefined();
    expect(planResult.status, planResult.stderr).toBe(2);
    expect(planResult.stderr).toBe("");
    expect(planResult.stdout.endsWith("\n")).toBe(false);
    expect(afterPlan).toBe(before);
    expect(planResult.stdout).not.toContain(
      "PARITY_SECRET_SUPPLIER_MUST_NOT_LEAK",
    );
    expect(planResult.stdout).not.toContain(
      "PARITY_PRIVATE_NOTE_MUST_NOT_LEAK",
    );
    const plan = verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(
      planResult.stdout,
    );
    expect(
      verifyAccountingWarehousePriceBootstrapPlanBinding(plan, result.stdout),
    ).toEqual(plan);
    expect(plan).toMatchObject({
      sourceReport: {
        targetFingerprint: TARGET_FINGERPRINT,
        reportSha256: report.integrity.reportSha256,
        reportFileSha256: sha256Hex(result.stdout),
      },
      executionBoundary: {
        mode: "dry-run",
        mutationsSupported: false,
        applyCommandAvailable: false,
      },
      policy: {
        oneObservationPerWarehouseItem: true,
        historicalCompleteness: "unknown",
        actorHistoryFabricated: false,
        effectiveTimeFabricated: false,
        lifecycleEventFabricated: false,
      },
      summary: {
        decision: "REVIEW",
        candidateItemCount: 1,
        plannedObservationCount: 1,
        blockedItemCount: 0,
      },
    });
    expect(plan.candidates[0]).toMatchObject({
      warehouseItemId: String(legacyItem!.id),
      transition: "legacy_observation",
      purchasePrice: "9",
      currency: "CZK",
      provenance: {
        historicalCompleteness: "unknown",
        actorKnown: false,
        effectiveAtKnown: false,
        eventHistoryFabricated: false,
      },
    });
  });

  it("aborts before inventory reads when the approved item cap is exceeded", () => {
    const result = runAudit(1);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/item count 2 exceeds approved limit 1/i);
  });

  it("atomically persists legacy observations, outbox and shadow heads, then exact-replays", async () => {
    const audit = runAudit(10);
    expect(audit.status, audit.stderr).toBe(2);
    const artifacts = applyArtifacts(audit.stdout);
    const input = {
      authorizationBytes: artifacts.authorizationBytes,
      planBytes: artifacts.planBytes,
      parityReportBytes: audit.stdout,
    };
    await expect(
      db.transaction((tx) =>
        applyAccountingWarehousePriceBootstrapInTransaction(
          createAccountingWarehousePriceBootstrapDbAdapter(
            tx,
            TARGET_FINGERPRINT,
          ),
          input,
        ),
      ),
    ).resolves.toMatchObject({
      mode: "applied",
      observationCount: artifacts.plan.candidates.length,
    });

    for (const candidate of artifacts.plan.candidates) {
      const [observation, intent, head] = await Promise.all([
        db
          .select()
          .from(accountingWarehousePriceObservationsTable)
          .where(
            eq(
              accountingWarehousePriceObservationsTable.id,
              candidate.observationId,
            ),
          ),
        db
          .select()
          .from(accountingExportOutboxTable)
          .where(
            eq(accountingExportOutboxTable.intentId, candidate.observationId),
          ),
        db
          .select()
          .from(accountingWarehousePriceProjectionHeadsTable)
          .where(
            eq(
              accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
              Number(candidate.warehouseItemId),
            ),
          ),
      ]);
      expect(observation).toHaveLength(1);
      expect(intent).toHaveLength(1);
      expect(head).toHaveLength(1);
    }

    await expect(
      db.transaction((tx) =>
        applyAccountingWarehousePriceBootstrapInTransaction(
          createAccountingWarehousePriceBootstrapDbAdapter(
            tx,
            TARGET_FINGERPRINT,
          ),
          input,
        ),
      ),
    ).resolves.toMatchObject({ mode: "exact-replay" });

    const after = runAudit(10);
    expect(after.status, after.stderr).toBe(0);
    const report = verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(
      after.stdout,
    );
    expect(report.summary.classificationCounts.legacy_bootstrap_match).toBe(
      artifacts.plan.candidates.length,
    );
  });

  it("rolls observation back when the same transaction cannot insert its outbox", async () => {
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `D9L-fault-${Date.now()}`, purchasePrice: "7.00" })
      .returning({ id: warehouseItemsTable.id });
    await db.insert(warehousePriceHistoryTable).values({
      warehouseItemId: item!.id,
      purchasePrice: "7.00",
      currency: "CZK",
      createdAt: new Date("2025-10-02T10:00:00.000Z"),
    });
    const audit = runAudit(10);
    expect(audit.status, audit.stderr).toBe(2);
    const artifacts = applyArtifacts(audit.stdout);
    const candidate = artifacts.plan.candidates.find(
      (entry) => entry.warehouseItemId === String(item!.id),
    )!;
    await expect(
      db.transaction(async (tx) => {
        const adapter = createAccountingWarehousePriceBootstrapDbAdapter(
          tx,
          TARGET_FINGERPRINT,
        );
        return applyAccountingWarehousePriceBootstrapInTransaction(
          {
            ...adapter,
            async insertExportIntent() {
              throw new Error("injected transactional outbox failure");
            },
          },
          {
            authorizationBytes: artifacts.authorizationBytes,
            planBytes: artifacts.planBytes,
            parityReportBytes: audit.stdout,
          },
        );
      }),
    ).rejects.toThrow(/injected transactional outbox failure/i);
    expect(
      await db
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(
            accountingWarehousePriceObservationsTable.id,
            candidate.observationId,
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(accountingExportOutboxTable)
        .where(
          eq(accountingExportOutboxTable.intentId, candidate.observationId),
        ),
    ).toHaveLength(0);
  });

  it("rejects a stale plan after the locked current price changes", async () => {
    const audit = runAudit(10);
    expect(audit.status, audit.stderr).toBe(2);
    const artifacts = applyArtifacts(audit.stdout);
    const candidate = artifacts.plan.candidates[0]!;
    await db
      .update(warehouseItemsTable)
      .set({ purchasePrice: "99.00" })
      .where(eq(warehouseItemsTable.id, Number(candidate.warehouseItemId)));
    await expect(
      db.transaction((tx) =>
        applyAccountingWarehousePriceBootstrapInTransaction(
          createAccountingWarehousePriceBootstrapDbAdapter(
            tx,
            TARGET_FINGERPRINT,
          ),
          {
            authorizationBytes: artifacts.authorizationBytes,
            planBytes: artifacts.planBytes,
            parityReportBytes: audit.stdout,
          },
        ),
      ),
    ).rejects.toThrow(/stale|partially persisted/i);
    expect(
      await db
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(
            accountingWarehousePriceObservationsTable.id,
            candidate.observationId,
          ),
        ),
    ).toHaveLength(0);
  });

  it("rejects direct-SQL legacy evidence that fabricates an actor", async () => {
    const [item] = await db
      .insert(warehouseItemsTable)
      .values({ name: `D9L-tamper-${Date.now()}`, purchasePrice: "11.00" })
      .returning({ id: warehouseItemsTable.id });
    const observation = createAccountingWarehousePriceLegacyObservation({
      schemaVersion: "site-logbook.warehouse-price-legacy-observation/v1",
      observationId: randomUUID(),
      warehouseItemId: String(item!.id),
      sequence: "0",
      previousObservationSha256: null,
      supersedesObservationId: null,
      transition: "legacy_observation",
      source: {
        parityReportSha256: "1".repeat(64),
        parityReportFileSha256: "2".repeat(64),
        legacyRowsSha256: "3".repeat(64),
        legacyRowCount: 1,
        latestLegacyRow: {
          legacyRowId: "1",
          rowSha256: "4".repeat(64),
          observedBillingDocumentId: null,
          observedBillingDocumentLineId: null,
          purchasePrice: "11",
          currency: "CZK",
          sourceRecordedAt: "2025-10-01T09:00:00.000Z",
          referenceConfidence: "unverified-legacy-reference",
        },
      },
      purchasePrice: "11",
      currency: "CZK",
      valuationPolicy: { mode: "source-currency", fxConversionApplied: false },
      provenance: {
        captureMode: "legacy-observation",
        capturedAt: "2025-10-02T09:00:00.000Z",
        historicalCompleteness: "unknown",
        actorKnown: false,
        effectiveAtKnown: false,
        eventHistoryFabricated: false,
        accountingVersionId: null,
        lifecycleEventId: null,
      },
    });
    const tampered = structuredClone(observation);
    (tampered.provenance as { actorKnown: boolean }).actorKnown = true;
    let rejected: unknown;
    try {
      await db.insert(accountingWarehousePriceObservationsTable).values({
        id: observation.observationId,
        warehouseItemId: item!.id,
        billingDocumentId: null,
        accountingVersionId: null,
        lifecycleEventId: null,
        sourceLineId: null,
        sequence: 0n,
        previousObservationSha256: null,
        supersedesObservationId: null,
        transition: "legacy_observation",
        purchasePrice: observation.purchasePrice,
        currency: observation.currency,
        warehouseMatchMode: null,
        warehouseMatchEvidenceSha256: null,
        effectiveAt: null,
        recordedAt: new Date(observation.provenance.capturedAt),
        canonicalJson: canonicalEvidenceJson(tampered),
        entrySha256: observation.integrity.entrySha256,
      });
    } catch (error) {
      rejected = error;
    }
    expect(
      (rejected as { cause?: { constraint?: string } })?.cause?.constraint,
    ).toBe("accounting_warehouse_price_legacy_semantics_chk");
    expect(
      await db
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(
            accountingWarehousePriceObservationsTable.id,
            observation.observationId,
          ),
        ),
    ).toHaveLength(0);
  });
});
