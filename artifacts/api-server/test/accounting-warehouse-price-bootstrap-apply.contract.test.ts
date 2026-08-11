import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareAccountingArchivePayload } from "../src/lib/accounting-archive-contract";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION,
  applyAccountingWarehousePriceBootstrapInTransaction,
  canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson,
  createAccountingWarehousePriceBootstrapApplyAuthorization,
  type AccountingWarehousePriceBootstrapApplyTransactionV1,
} from "../src/lib/accounting-warehouse-price-bootstrap-apply";
import {
  canonicalAccountingWarehousePriceBootstrapPlanJson,
  createAccountingWarehousePriceBootstrapPlan,
} from "../src/lib/accounting-warehouse-price-bootstrap-plan";
import {
  canonicalAccountingWarehousePriceParityReportJson,
  createAccountingWarehousePriceParityReport,
  type AccountingWarehousePriceParityItemInputV1,
} from "../src/lib/accounting-warehouse-price-parity";
import {
  canonicalAccountingExportIntentJson,
  type AccountingExportIntentV1,
} from "../src/lib/accounting-persistence-contract";
import {
  canonicalAccountingWarehousePriceLegacyObservationJson,
  type AccountingWarehousePriceLegacyObservationV1,
} from "../src/lib/accounting-warehouse-price-legacy-observation-contract";
import type { AccountingWarehousePriceProjectionHeadV1 } from "../src/lib/accounting-warehouse-price-projection-head";
import type { AccountingWarehousePriceStreamEntryV1 } from "../src/lib/accounting-warehouse-price-stream-contract";
import { sha256Hex } from "../src/lib/evidence-hash";
import { createAccountingWarehousePriceObservation } from "../src/lib/accounting-warehouse-price-observation-contract";
import { deriveAccountingWarehousePriceProjection } from "../src/lib/accounting-warehouse-price-projection";

const TARGET = "e".repeat(64);
const APPROVAL_DIGEST = "a".repeat(64);

function legacyItem(
  id: string,
  price: string,
): AccountingWarehousePriceParityItemInputV1 {
  return {
    warehouseItemId: id,
    storedPurchasePrice: price,
    observations: [],
    projectionHead: null,
    legacyRows: [
      {
        legacyRowId: String(Number(id) + 100),
        warehouseItemId: id,
        billingDocumentId: String(Number(id) + 200),
        billingDocumentLineId: String(Number(id) + 300),
        purchasePrice: price,
        currency: "CZK",
        recordedAt: "2042-10-01T09:00:00.000Z",
      },
    ],
  };
}

function artifacts(items = [legacyItem("9", "12.5"), legacyItem("4", "8")]) {
  const report = createAccountingWarehousePriceParityReport({
    targetFingerprint: TARGET,
    observedAt: "2042-10-01T11:00:00.000Z",
    limits: { maxItems: 10, maxObservations: 20, maxLegacyRows: 20 },
    items,
  });
  const reportBytes = canonicalAccountingWarehousePriceParityReportJson(report);
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
        parityReportSha256: report.integrity.reportSha256,
        parityReportFileSha256: sha256Hex(reportBytes),
        targetFingerprint: TARGET,
        candidateCount: plan.candidates.length,
      },
      approval: {
        decision: "approved",
        confirmation: ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION,
        approvedAt: "2042-10-01T12:00:00.000Z",
        approvedByUserId: "1",
        approvalEvidenceSha256: APPROVAL_DIGEST,
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
    report,
    reportBytes,
    plan,
    planBytes,
    authorization,
    authorizationBytes:
      canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson(
        authorization,
      ),
  };
}

class MemoryTransaction implements AccountingWarehousePriceBootstrapApplyTransactionV1 {
  readonly lockOrder: string[] = [];
  readonly items = new Map<string, AccountingWarehousePriceParityItemInputV1>();
  readonly observations = new Map<
    string,
    AccountingWarehousePriceStreamEntryV1
  >();
  readonly intents = new Map<string, AccountingExportIntentV1>();
  readonly heads = new Map<string, AccountingWarehousePriceProjectionHeadV1>();
  failIntentInsert = false;

  constructor(items: AccountingWarehousePriceParityItemInputV1[]) {
    for (const item of items)
      this.items.set(item.warehouseItemId, structuredClone(item));
  }

  async readWarehousePriceBootstrapTargetFingerprint() {
    return TARGET;
  }

  async lockAndLoadWarehousePriceBootstrapItemForUpdate(id: string) {
    this.lockOrder.push(id);
    const item = this.items.get(id);
    if (!item) throw new Error("missing item");
    return structuredClone(item);
  }

  async loadWarehousePriceObservationById(id: string) {
    return this.observations.get(id) ?? null;
  }

  async insertWarehousePriceLegacyObservation(
    observation: AccountingWarehousePriceLegacyObservationV1,
  ) {
    this.observations.set(observation.observationId, observation);
    const item = this.items.get(observation.warehouseItemId)!;
    item.observations = [observation];
  }

  async loadExportIntentById(id: string) {
    return this.intents.get(id) ?? null;
  }

  async insertExportIntent(intent: AccountingExportIntentV1) {
    if (this.failIntentInsert) throw new Error("injected outbox failure");
    this.intents.set(intent.intentId, intent);
  }

  async lockAndLoadWarehousePriceObservationStreamForProjection(id: string) {
    return [
      ...(this.items.get(id)?.observations ?? []),
    ] as AccountingWarehousePriceStreamEntryV1[];
  }

  async loadWarehousePriceProjectionHeadForUpdate(id: string) {
    return this.heads.get(id) ?? null;
  }

  async insertWarehousePriceProjectionHead(
    head: AccountingWarehousePriceProjectionHeadV1,
  ) {
    this.heads.set(head.warehouseItemId, head);
    this.items.get(head.warehouseItemId)!.projectionHead = head;
  }

  async compareAndAdvanceWarehousePriceProjectionHead() {
    throw new Error("bootstrap must initialize, not advance, projection heads");
  }
}

describe("accounting warehouse-price bootstrap apply transaction contract", () => {
  it("locks ascending, atomically prepares observation/outbox/head, archives, and exact-replays", async () => {
    const evidence = artifacts();
    const transaction = new MemoryTransaction([
      legacyItem("9", "12.5"),
      legacyItem("4", "8"),
    ]);
    const input = {
      authorizationBytes: evidence.authorizationBytes,
      planBytes: evidence.planBytes,
      parityReportBytes: evidence.reportBytes,
    };
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, input),
    ).resolves.toMatchObject({ mode: "applied", observationCount: 2 });
    expect(transaction.lockOrder).toEqual(["4", "9"]);
    expect(transaction.observations.size).toBe(2);
    expect(transaction.intents.size).toBe(2);
    expect(transaction.heads.size).toBe(2);

    const observation = evidence.plan.candidates[0]!;
    const intent = transaction.intents.get(observation.observationId)!;
    expect(
      prepareAccountingArchivePayload({
        canonicalIntentJson: canonicalAccountingExportIntentJson(intent),
        entries: [
          {
            kind: "warehouse-price-legacy-observation",
            id: observation.observationId,
            canonicalJson:
              canonicalAccountingWarehousePriceLegacyObservationJson(
                observation,
              ),
          },
        ],
      }).intent.operation,
    ).toBe("warehouse-price-legacy-observation");

    transaction.lockOrder.length = 0;
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, input),
    ).resolves.toMatchObject({ mode: "exact-replay", observationCount: 2 });
    expect(transaction.lockOrder).toEqual(["4", "9"]);
  });

  it("rejects a stale live snapshot before writing anything", async () => {
    const evidence = artifacts([legacyItem("4", "8")]);
    const stale = legacyItem("4", "9");
    const transaction = new MemoryTransaction([stale]);
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, {
        authorizationBytes: evidence.authorizationBytes,
        planBytes: evidence.planBytes,
        parityReportBytes: evidence.reportBytes,
      }),
    ).rejects.toThrow(/stale|partially persisted/i);
    expect(transaction.observations.size).toBe(0);
    expect(transaction.intents.size).toBe(0);
    expect(transaction.heads.size).toBe(0);
  });

  it("surfaces an outbox failure so the caller-owned database transaction can roll back", async () => {
    const evidence = artifacts([legacyItem("4", "8")]);
    const transaction = new MemoryTransaction([legacyItem("4", "8")]);
    transaction.failIntentInsert = true;
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, {
        authorizationBytes: evidence.authorizationBytes,
        planBytes: evidence.planBytes,
        parityReportBytes: evidence.reportBytes,
      }),
    ).rejects.toThrow(/injected outbox failure/i);
    expect(transaction.heads.size).toBe(0);
  });

  it("rejects tampered authorization and a mixed partial-application state", async () => {
    const evidence = artifacts();
    const tampered = JSON.parse(evidence.authorizationBytes);
    tampered.plan.candidateCount = 1;
    const transaction = new MemoryTransaction([
      legacyItem("9", "12.5"),
      legacyItem("4", "8"),
    ]);
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, {
        authorizationBytes: JSON.stringify(tampered),
        planBytes: evidence.planBytes,
        parityReportBytes: evidence.reportBytes,
      }),
    ).rejects.toThrow(/authorization digest/i);

    const first = evidence.plan.candidates[0]!;
    transaction.observations.set(first.observationId, first);
    transaction.items.get(first.warehouseItemId)!.observations = [first];
    await expect(
      applyAccountingWarehousePriceBootstrapInTransaction(transaction, {
        authorizationBytes: evidence.authorizationBytes,
        planBytes: evidence.planBytes,
        parityReportBytes: evidence.reportBytes,
      }),
    ).rejects.toThrow(/complete persisted bundle|partial/i);
  });

  it("allows one explicit native successor but never a withdrawal of unknown legacy history", () => {
    const evidence = artifacts([legacyItem("4", "8")]);
    const legacy = evidence.plan.candidates[0]!;
    const nativeBody = {
      schemaVersion: "site-logbook.warehouse-price-observation/v1" as const,
      observationId: "20000000-0000-4000-8000-000000000001",
      warehouseItemId: "4",
      sequence: "1",
      previousObservationSha256: legacy.integrity.entrySha256,
      supersedesObservationId: legacy.observationId,
      source: {
        aggregateId: "20",
        accountingVersionId: "20000000-0000-4000-8000-000000000002",
        accountingVersionSha256: "2".repeat(64),
        lifecycleEventId: "20000000-0000-4000-8000-000000000003",
        lifecycleEventSha256: "3".repeat(64),
        sourceLineId: "21",
      },
      currency: "CZK",
      actor: {
        kind: "user" as const,
        id: "1",
        authentication: "step-up" as const,
      },
      effectiveAt: "2042-10-02T09:00:00.000Z",
      recordedAt: "2042-10-02T09:00:00.000Z",
    };
    const observed = createAccountingWarehousePriceObservation({
      ...nativeBody,
      transition: "observed",
      purchasePrice: "9",
      warehouseMatch: { mode: "manual", evidenceSha256: "4".repeat(64) },
      reasonCode: "document_approved",
      reasonDetailSha256: null,
    });
    expect(
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "4",
        observations: [legacy, observed],
      }).purchasePrice,
    ).toBe("9");

    const invalidWithdrawal = createAccountingWarehousePriceObservation({
      ...nativeBody,
      transition: "withdrawn",
      purchasePrice: null,
      warehouseMatch: null,
      reasonCode: "review_reopened",
      reasonDetailSha256: "5".repeat(64),
    });
    expect(() =>
      deriveAccountingWarehousePriceProjection({
        warehouseItemId: "4",
        observations: [legacy, invalidWithdrawal],
      }),
    ).toThrow(/first native|legacy/i);
  });

  it("has no apply CLI, package script, route, runtime flag or provider client surface", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "artifacts/api-server/package.json"), "utf8"),
    );
    expect(
      Object.keys(packageJson.scripts).filter((name) =>
        /bootstrap.*apply|apply.*bootstrap/i.test(name),
      ),
    ).toEqual([]);
    const app = readFileSync(
      resolve(root, "artifacts/api-server/src/app.ts"),
      "utf8",
    );
    expect(app).not.toMatch(/warehouse-price-bootstrap-apply/i);
    const source = readFileSync(
      resolve(
        root,
        "artifacts/api-server/src/lib/accounting-warehouse-price-bootstrap-apply.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/@aws-sdk|PutObject|S3Client|DATABASE_URL/);
  });
});
