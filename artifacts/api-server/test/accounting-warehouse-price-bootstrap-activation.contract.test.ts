import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES,
  canonicalAccountingWarehousePriceBootstrapBackupEvidenceJson,
  canonicalAccountingWarehousePriceBootstrapLineageEvidenceJson,
  canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson,
  createAccountingWarehousePriceBootstrapBackupEvidence,
  createAccountingWarehousePriceBootstrapLineageEvidence,
  createAccountingWarehousePriceBootstrapOfflineVerificationSummary,
  verifyAccountingWarehousePriceBootstrapPreflightArtifactSet,
  verifyAccountingWarehousePriceBootstrapReceiptArtifactSet,
} from "../src/lib/accounting-warehouse-price-bootstrap-activation-artifacts";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPROVAL_CONFIRMATION,
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MAX_PAYLOAD_BYTES,
  canonicalAccountingWarehousePriceBootstrapActivationPreflightJson,
  canonicalAccountingWarehousePriceBootstrapApprovalJson,
  canonicalAccountingWarehousePriceBootstrapExecutionReceiptJson,
  createAccountingWarehousePriceBootstrapActivationPreflight,
  createAccountingWarehousePriceBootstrapApproval,
  createAccountingWarehousePriceBootstrapExecutionReceipt,
  verifyAccountingWarehousePriceBootstrapActivationPreflightBinding,
  verifyAccountingWarehousePriceBootstrapExecutionReceiptBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapActivationPreflightJsonBytes,
  verifyCanonicalAccountingWarehousePriceBootstrapApprovalJsonBytes,
  verifyCanonicalAccountingWarehousePriceBootstrapExecutionReceiptJsonBytes,
} from "../src/lib/accounting-warehouse-price-bootstrap-activation-contract";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION,
  canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson,
  createAccountingWarehousePriceBootstrapApplyAuthorization,
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
import { createAccountingWarehousePriceProjectionHead } from "../src/lib/accounting-warehouse-price-projection-head";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";
import {
  activationArtifactNames,
  assertActivationArtifactSize,
  assertExactActivationArtifactLayout,
  parseWarehousePriceBootstrapActivationVerifyOptions,
  WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_REPORT_BYTES,
} from "../src/scripts/warehouse-price-bootstrap-activation-verifier-policy";

const TARGET = "a".repeat(64);
const SOURCE_SHA = "b".repeat(40);

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

function emptyItem(id: string): AccountingWarehousePriceParityItemInputV1 {
  return {
    warehouseItemId: id,
    storedPurchasePrice: null,
    observations: [],
    projectionHead: null,
    legacyRows: [],
  };
}

function coreArtifacts() {
  const sourceItems = [legacyItem("9", "12.5"), emptyItem("2")];
  const report = createAccountingWarehousePriceParityReport({
    targetFingerprint: TARGET,
    observedAt: "2042-10-01T11:00:00.000Z",
    limits: { maxItems: 10, maxObservations: 20, maxLegacyRows: 20 },
    items: sourceItems,
  });
  const reportBytes = canonicalAccountingWarehousePriceParityReportJson(report);
  const plan = createAccountingWarehousePriceBootstrapPlan({
    parityReportBytes: reportBytes,
    maxPlannedItems: 10,
  });
  const planBytes = canonicalAccountingWarehousePriceBootstrapPlanJson(plan);
  const approval = createAccountingWarehousePriceBootstrapApproval({
    schemaVersion: "site-logbook.warehouse-price-bootstrap-approval/v1",
    operation: "warehouse-price-legacy-bootstrap",
    binding: {
      targetFingerprint: TARGET,
      parityReportSha256: report.integrity.reportSha256,
      parityReportFileSha256: sha256Hex(reportBytes),
      planSha256: plan.integrity.planSha256,
      planFileSha256: sha256Hex(planBytes),
      candidateCount: plan.candidates.length,
    },
    approval: {
      decision: "approved",
      confirmation: ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPROVAL_CONFIRMATION,
      approvedAt: "2042-10-01T12:00:00.000Z",
      approvedByUserId: "1",
      unknownHistoryAccepted: true,
      sourceCurrencyNoFxAccepted: true,
    },
    boundary: {
      stagingOnly: true,
      activationPreflightRequired: true,
      databaseWriteAuthorized: false,
      migrationAuthorized: false,
      deployAuthorized: false,
      productionTargetsTouched: false,
    },
  });
  const approvalBytes =
    canonicalAccountingWarehousePriceBootstrapApprovalJson(approval);
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
        approvedAt: approval.approval.approvedAt,
        approvedByUserId: approval.approval.approvedByUserId,
        approvalEvidenceSha256: sha256Hex(approvalBytes),
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
  const authorizationBytes =
    canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson(
      authorization,
    );
  return {
    sourceItems,
    report,
    reportBytes,
    plan,
    planBytes,
    approval,
    approvalBytes,
    authorization,
    authorizationBytes,
  };
}

function preflightInput(artifacts = coreArtifacts()) {
  return {
    approvalBytes: artifacts.approvalBytes,
    authorizationBytes: artifacts.authorizationBytes,
    planBytes: artifacts.planBytes,
    parityReportBytes: artifacts.reportBytes,
    preparedAt: "2042-10-01T13:00:00.000Z",
    sourceSha: SOURCE_SHA,
    stagingEvidence: {
      strictReleaseEvidenceVerified: true as const,
      releaseEvidenceFileSha256: "1".repeat(64),
      releaseVerificationFileSha256: "f".repeat(64),
      releaseVerificationSchemaVersion: 4 as const,
      releaseVerificationDecision: "PASS" as const,
      provisioningArtifactSha256: "2".repeat(64),
      deploymentInputsArtifactSha256: "3".repeat(64),
      sourceSha: SOURCE_SHA,
      logicalEnvironment: "site-logbook-staging" as const,
      targetFingerprint: TARGET,
      productionTargetsTouched: false as const,
    },
    migrationLineage: {
      lineageEvidenceFileSha256: "4".repeat(64),
      sourceSha: SOURCE_SHA,
      publicMainIntegrated: true as const,
      productionCopySourceJournalSha256: "5".repeat(64),
      knownCodeTagsSha256: "6".repeat(64),
      appliedKnownTagsSha256: "6".repeat(64),
      knownCodeMigrationCount: 106,
      appliedKnownMigrationCount: 106,
      latestKnownMigrationTag: "0999_test_only_accounting_expand",
      missingKnownTags: [] as string[],
      unexpectedKnownTags: [] as string[],
      opaqueLegacyRows: [
        { identitySha256: "7".repeat(64) },
        { identitySha256: "8".repeat(64) },
      ],
      opaqueLegacyRowCount: 2,
      opaqueLegacyMeaningInferred: false as const,
      excludedMigrationTags: ["0100"] as ["0100"],
      plannedAccountingMigration: {
        tag: "0999_test_only_accounting_expand",
        sqlSha256: "9".repeat(64),
        includedInCode: true as const,
        appliedToTarget: true as const,
        schemaExpanded: true as const,
      },
    },
    backupEvidence: {
      backupEvidenceFileSha256: "c".repeat(64),
      backupEvidenceId: "72",
      targetFingerprint: TARGET,
      productionTargetsTouched: false as const,
      status: "completed" as const,
      restoreStatus: "passed" as const,
      encryptedBackupSha256: "d".repeat(64),
      sourceExecutionSha256: "e".repeat(64),
      sizeBytes: 1024,
      maxPayloadBytes: ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MAX_PAYLOAD_BYTES,
      createdAt: "2042-10-01T10:00:00.000Z",
      restoreTestedAt: "2042-10-01T11:30:00.000Z",
      checkedAt: "2042-10-01T12:30:00.000Z",
      maxRestoreAgeHours: 2,
    },
    maxCandidatesPerTransaction: 10,
  };
}

function buildAfterReport(
  artifacts = coreArtifacts(),
  observedAt = "2042-10-01T13:12:00.000Z",
) {
  const candidates = new Map(
    artifacts.plan.candidates.map((entry) => [entry.warehouseItemId, entry]),
  );
  return createAccountingWarehousePriceParityReport({
    targetFingerprint: TARGET,
    observedAt,
    limits: artifacts.report.limits,
    items: artifacts.report.items.map((item) => {
      const candidate = candidates.get(item.warehouseItemId);
      if (!candidate) {
        return {
          warehouseItemId: item.warehouseItemId,
          storedPurchasePrice: item.storedPurchasePrice,
          observations: item.observations,
          projectionHead: item.projectionHead,
          legacyRows: item.legacyRows.map(
            ({
              rowSha256: _rowSha256,
              historicalCompleteness: _historicalCompleteness,
              ...row
            }) => row,
          ),
        };
      }
      return {
        warehouseItemId: item.warehouseItemId,
        storedPurchasePrice: item.storedPurchasePrice,
        observations: [candidate],
        projectionHead: createAccountingWarehousePriceProjectionHead({
          warehouseItemId: item.warehouseItemId,
          observations: [candidate],
        }),
        legacyRows: item.legacyRows.map(
          ({
            rowSha256: _rowSha256,
            historicalCompleteness: _historicalCompleteness,
            ...row
          }) => row,
        ),
      };
    }),
  });
}

function activationArtifactFixture() {
  const evidence = coreArtifacts();
  const base = preflightInput(evidence);
  const {
    lineageEvidenceFileSha256: _lineageEvidenceFileSha256,
    ...lineageInput
  } = base.migrationLineage;
  const lineageEvidence =
    createAccountingWarehousePriceBootstrapLineageEvidence({
      schemaVersion:
        "site-logbook.warehouse-price-bootstrap-lineage-evidence/v1",
      lineage: lineageInput,
    });
  const lineageEvidenceBytes =
    canonicalAccountingWarehousePriceBootstrapLineageEvidenceJson(
      lineageEvidence,
    );
  const {
    backupEvidenceFileSha256: _backupEvidenceFileSha256,
    ...backupInput
  } = base.backupEvidence;
  const backupEvidence = createAccountingWarehousePriceBootstrapBackupEvidence({
    schemaVersion: "site-logbook.warehouse-price-bootstrap-backup-evidence/v1",
    backup: backupInput,
  });
  const backupEvidenceBytes =
    canonicalAccountingWarehousePriceBootstrapBackupEvidenceJson(
      backupEvidence,
    );
  const stagingReleaseEvidenceBytes = canonicalEvidenceJson({
    schemaVersion: 4,
    kind: "test-only-staging-release-evidence",
    sourceSha: SOURCE_SHA,
  });
  const stagingReleaseVerificationBytes = canonicalEvidenceJson({
    schemaVersion: 4,
    environmentId: "site-logbook-staging",
    commitSha: SOURCE_SHA,
    decision: "PASS",
    releaseEvidenceFileSha256: sha256Hex(stagingReleaseEvidenceBytes),
  });
  const preflight = createAccountingWarehousePriceBootstrapActivationPreflight({
    ...base,
    stagingEvidence: {
      ...base.stagingEvidence,
      releaseEvidenceFileSha256: sha256Hex(stagingReleaseEvidenceBytes),
      releaseVerificationFileSha256: sha256Hex(stagingReleaseVerificationBytes),
    },
    migrationLineage: {
      ...base.migrationLineage,
      lineageEvidenceFileSha256: sha256Hex(lineageEvidenceBytes),
    },
    backupEvidence: {
      ...base.backupEvidence,
      backupEvidenceFileSha256: sha256Hex(backupEvidenceBytes),
    },
  });
  const preflightBytes =
    canonicalAccountingWarehousePriceBootstrapActivationPreflightJson(
      preflight,
    );
  const after = buildAfterReport(evidence);
  const afterParityReportBytes =
    canonicalAccountingWarehousePriceParityReportJson(after);
  const receipt = createAccountingWarehousePriceBootstrapExecutionReceipt({
    preflightBytes,
    approvalBytes: evidence.approvalBytes,
    authorizationBytes: evidence.authorizationBytes,
    planBytes: evidence.planBytes,
    sourceParityReportBytes: evidence.reportBytes,
    beforeParityReportBytes: evidence.reportBytes,
    afterParityReportBytes,
    applyResult: {
      mode: "applied",
      observationCount: evidence.plan.candidates.length,
      observationIds: evidence.plan.candidates.map(
        (candidate) => candidate.observationId,
      ),
    },
    startedAt: "2042-10-01T13:10:00.000Z",
    completedAt: "2042-10-01T13:11:00.000Z",
  });
  const receiptBytes =
    canonicalAccountingWarehousePriceBootstrapExecutionReceiptJson(receipt);
  const names = ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES;
  const common = {
    [names.stagingReleaseEvidence]: stagingReleaseEvidenceBytes,
    [names.stagingReleaseVerification]: stagingReleaseVerificationBytes,
    [names.lineageEvidence]: lineageEvidenceBytes,
    [names.backupEvidence]: backupEvidenceBytes,
    [names.sourceParityReport]: evidence.reportBytes,
    [names.plan]: evidence.planBytes,
    [names.approval]: evidence.approvalBytes,
    [names.authorization]: evidence.authorizationBytes,
    [names.preflight]: preflightBytes,
  };
  return {
    evidence,
    preflight,
    preflightBytes,
    receipt,
    receiptBytes,
    preflightArtifacts: common,
    receiptArtifacts: {
      ...common,
      [names.beforeParityReport]: evidence.reportBytes,
      [names.afterParityReport]: afterParityReportBytes,
      [names.receipt]: receiptBytes,
    },
    preflightArtifactSet: {
      stagingReleaseEvidenceBytes,
      stagingReleaseVerificationBytes,
      lineageEvidenceBytes,
      backupEvidenceBytes,
      sourceParityReportBytes: evidence.reportBytes,
      planBytes: evidence.planBytes,
      approvalBytes: evidence.approvalBytes,
      authorizationBytes: evidence.authorizationBytes,
      preflightBytes,
    },
    receiptArtifactSet: {
      stagingReleaseEvidenceBytes,
      stagingReleaseVerificationBytes,
      lineageEvidenceBytes,
      backupEvidenceBytes,
      sourceParityReportBytes: evidence.reportBytes,
      planBytes: evidence.planBytes,
      approvalBytes: evidence.approvalBytes,
      authorizationBytes: evidence.authorizationBytes,
      preflightBytes,
      beforeParityReportBytes: evidence.reportBytes,
      afterParityReportBytes,
      receiptBytes,
    },
  };
}

function writeActivationArtifactDirectory(
  artifacts: Readonly<Record<string, string>>,
): string {
  const directory = mkdtempSync(join(tmpdir(), "warehouse-price-activation-"));
  for (const [filename, bytes] of Object.entries(artifacts)) {
    writeFileSync(join(directory, filename), bytes, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  return directory;
}

describe("accounting warehouse-price bootstrap activation contract", () => {
  it("binds exact approval bytes, staging lineage, restored backup and a no-run READY preflight", () => {
    const evidence = coreArtifacts();
    const preflight =
      createAccountingWarehousePriceBootstrapActivationPreflight(
        preflightInput(evidence),
      );
    const bytes =
      canonicalAccountingWarehousePriceBootstrapActivationPreflightJson(
        preflight,
      );
    expect(
      verifyCanonicalAccountingWarehousePriceBootstrapActivationPreflightJsonBytes(
        bytes,
      ),
    ).toEqual(preflight);
    expect(preflight.decision).toBe("READY");
    expect(preflight.executionBoundary.applyRunnerIncluded).toBe(false);
    expect(preflight.executionBoundary.migrationExecutionIncluded).toBe(false);
    expect(preflight.productionTargetsTouched).toBe(false);
    expect(preflight.migrationLineage.opaqueLegacyRowCount).toBe(2);
    expect(
      verifyAccountingWarehousePriceBootstrapActivationPreflightBinding({
        preflightBytes: bytes,
        approvalBytes: evidence.approvalBytes,
        authorizationBytes: evidence.authorizationBytes,
        planBytes: evidence.planBytes,
        parityReportBytes: evidence.reportBytes,
      }),
    ).toEqual(preflight);
  });

  it("rejects noncanonical or authorization-unbound approval evidence", () => {
    const evidence = coreArtifacts();
    expect(() =>
      verifyCanonicalAccountingWarehousePriceBootstrapApprovalJsonBytes(
        `${evidence.approvalBytes}\n`,
      ),
    ).toThrow(/canonical/i);

    const { integrity: _integrity, ...approvalBody } = evidence.approval;
    const replacement = createAccountingWarehousePriceBootstrapApproval({
      ...approvalBody,
      approval: { ...approvalBody.approval, approvedByUserId: "2" },
    });
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...preflightInput(evidence),
        approvalBytes:
          canonicalAccountingWarehousePriceBootstrapApprovalJson(replacement),
      }),
    ).toThrow(/approved plan/i);
  });

  it("fails closed on lineage drift, 0100, opaque-history inference, stale backup, and candidate overflow", () => {
    const base = preflightInput();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        migrationLineage: {
          ...base.migrationLineage,
          appliedKnownTagsSha256: "f".repeat(64),
        },
      }),
    ).toThrow(/cross-binding/i);
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        migrationLineage: {
          ...base.migrationLineage,
          opaqueLegacyRows: [
            ...base.migrationLineage.opaqueLegacyRows,
            { identitySha256: "a".repeat(64) },
          ],
          opaqueLegacyRowCount: 3 as never,
        },
      }),
    ).toThrow();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        migrationLineage: {
          ...base.migrationLineage,
          missingKnownTags: ["0105_missing"],
        },
      }),
    ).toThrow();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        migrationLineage: {
          ...base.migrationLineage,
          latestKnownMigrationTag: "0100_forbidden",
          plannedAccountingMigration: {
            ...base.migrationLineage.plannedAccountingMigration,
            tag: "0100_forbidden",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        migrationLineage: {
          ...base.migrationLineage,
          opaqueLegacyMeaningInferred: true,
        },
      }),
    ).toThrow();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        backupEvidence: {
          ...base.backupEvidence,
          sizeBytes: ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MAX_PAYLOAD_BYTES + 1,
        },
      }),
    ).toThrow();
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        backupEvidence: {
          ...base.backupEvidence,
          restoreTestedAt: "2042-10-01T09:00:00.000Z",
        },
      }),
    ).toThrow(/stale|chronologically/i);
    expect(() =>
      createAccountingWarehousePriceBootstrapActivationPreflight({
        ...base,
        maxCandidatesPerTransaction: 0,
      }),
    ).toThrow();
  });

  it.each(["applied", "exact-replay"] as const)(
    "creates a canonical PASS execution receipt for %s",
    (mode) => {
      const evidence = coreArtifacts();
      const preflight =
        createAccountingWarehousePriceBootstrapActivationPreflight(
          preflightInput(evidence),
        );
      const preflightBytes =
        canonicalAccountingWarehousePriceBootstrapActivationPreflightJson(
          preflight,
        );
      const after = buildAfterReport(evidence);
      const beforeBytes =
        mode === "applied"
          ? evidence.reportBytes
          : canonicalAccountingWarehousePriceParityReportJson(
              buildAfterReport(evidence, "2042-10-01T13:05:00.000Z"),
            );
      const receipt = createAccountingWarehousePriceBootstrapExecutionReceipt({
        preflightBytes,
        approvalBytes: evidence.approvalBytes,
        authorizationBytes: evidence.authorizationBytes,
        planBytes: evidence.planBytes,
        sourceParityReportBytes: evidence.reportBytes,
        beforeParityReportBytes: beforeBytes,
        afterParityReportBytes:
          canonicalAccountingWarehousePriceParityReportJson(after),
        applyResult: {
          mode,
          observationCount: evidence.plan.candidates.length,
          observationIds: evidence.plan.candidates.map(
            (candidate) => candidate.observationId,
          ),
        },
        startedAt: "2042-10-01T13:10:00.000Z",
        completedAt: "2042-10-01T13:11:00.000Z",
      });
      const bytes =
        canonicalAccountingWarehousePriceBootstrapExecutionReceiptJson(receipt);
      expect(
        verifyCanonicalAccountingWarehousePriceBootstrapExecutionReceiptJsonBytes(
          bytes,
        ),
      ).toEqual(receipt);
      expect(receipt.execution.mode).toBe(mode);
      expect(receipt.verification.beforeState).toBe(
        mode === "applied" ? "source-plan-match" : "exact-replay-match",
      );
      expect(receipt.verification.afterDecision).toBe("PASS");
      expect(receipt.verification.nonCandidateItemsUnchanged).toBe(true);
      expect(
        verifyAccountingWarehousePriceBootstrapExecutionReceiptBinding({
          receiptBytes: bytes,
          preflightBytes,
          approvalBytes: evidence.approvalBytes,
          authorizationBytes: evidence.authorizationBytes,
          planBytes: evidence.planBytes,
          sourceParityReportBytes: evidence.reportBytes,
          beforeParityReportBytes: beforeBytes,
          afterParityReportBytes:
            canonicalAccountingWarehousePriceParityReportJson(after),
        }),
      ).toEqual(receipt);
    },
  );

  it("rejects an after-parity mutation, missing candidate transition, and wrong apply IDs", () => {
    const evidence = coreArtifacts();
    const preflightBytes =
      canonicalAccountingWarehousePriceBootstrapActivationPreflightJson(
        createAccountingWarehousePriceBootstrapActivationPreflight(
          preflightInput(evidence),
        ),
      );
    const validAfter = buildAfterReport(evidence);
    const base = {
      preflightBytes,
      approvalBytes: evidence.approvalBytes,
      authorizationBytes: evidence.authorizationBytes,
      planBytes: evidence.planBytes,
      sourceParityReportBytes: evidence.reportBytes,
      beforeParityReportBytes: evidence.reportBytes,
      applyResult: {
        mode: "applied" as const,
        observationCount: evidence.plan.candidates.length,
        observationIds: evidence.plan.candidates.map(
          (candidate) => candidate.observationId,
        ),
      },
      startedAt: "2042-10-01T13:10:00.000Z",
      completedAt: "2042-10-01T13:11:00.000Z",
    };
    const changedNonCandidate = createAccountingWarehousePriceParityReport({
      targetFingerprint: TARGET,
      observedAt: "2042-10-01T13:12:00.000Z",
      limits: validAfter.limits,
      items: validAfter.items.map((item) => ({
        warehouseItemId: item.warehouseItemId,
        storedPurchasePrice:
          item.warehouseItemId === "2" ? "1" : item.storedPurchasePrice,
        observations: item.observations,
        projectionHead: item.projectionHead,
        legacyRows: item.legacyRows.map(
          ({
            rowSha256: _rowSha256,
            historicalCompleteness: _historicalCompleteness,
            ...row
          }) => row,
        ),
      })),
    });
    expect(() =>
      createAccountingWarehousePriceBootstrapExecutionReceipt({
        ...base,
        afterParityReportBytes:
          canonicalAccountingWarehousePriceParityReportJson(
            changedNonCandidate,
          ),
      }),
    ).toThrow(/after parity|drifted/i);
    expect(() =>
      createAccountingWarehousePriceBootstrapExecutionReceipt({
        ...base,
        afterParityReportBytes: evidence.reportBytes,
      }),
    ).toThrow(/after parity/i);
    expect(() =>
      createAccountingWarehousePriceBootstrapExecutionReceipt({
        ...base,
        afterParityReportBytes:
          canonicalAccountingWarehousePriceParityReportJson(validAfter),
        applyResult: {
          ...base.applyResult,
          observationIds: ["00000000-0000-4000-8000-000000000000"],
        },
      }),
    ).toThrow(/approved preflight/i);
  });

  it("does not expose activation through package scripts, routes, app wiring, or a numbered migration", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const packageJson = readFileSync(
      resolve(root, "artifacts/api-server/package.json"),
      "utf8",
    );
    const app = readFileSync(
      resolve(root, "artifacts/api-server/src/app.ts"),
      "utf8",
    );
    const source = readFileSync(
      resolve(
        root,
        "artifacts/api-server/src/lib/accounting-warehouse-price-bootstrap-activation-contract.ts",
      ),
      "utf8",
    );
    const journal = readFileSync(
      resolve(root, "lib/db/migrations/meta/_journal.json"),
      "utf8",
    );
    expect(packageJson).not.toContain("warehouse-price:bootstrap-activate");
    expect(app).not.toContain("bootstrap-activation-contract");
    expect(source).not.toMatch(/\b(?:process\.env|DATABASE_URL|\.listen\s*\()/);
    expect(journal).not.toContain("warehouse_price_bootstrap");
    expect(journal).not.toContain('"tag": "0100_');
  });
});

describe("warehouse-price bootstrap activation offline artifact verifier", () => {
  it("strictly binds canonical lineage, backup, release, preflight and receipt artifacts", () => {
    const fixture = activationArtifactFixture();
    expect(
      verifyAccountingWarehousePriceBootstrapPreflightArtifactSet(
        fixture.preflightArtifactSet,
      ),
    ).toEqual(fixture.preflight);
    expect(
      verifyAccountingWarehousePriceBootstrapReceiptArtifactSet(
        fixture.receiptArtifactSet,
      ),
    ).toEqual({
      preflight: fixture.preflight,
      receipt: fixture.receipt,
    });
    const summary =
      createAccountingWarehousePriceBootstrapOfflineVerificationSummary({
        mode: "receipt",
        preflight: fixture.preflight,
        preflightFileSha256: sha256Hex(fixture.preflightBytes),
        receipt: fixture.receipt,
        receiptFileSha256: sha256Hex(fixture.receiptBytes),
      });
    expect(
      JSON.parse(
        canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson(
          summary,
        ),
      ),
    ).toMatchObject({
      schemaVersion:
        "site-logbook.warehouse-price-bootstrap-offline-verification/v1",
      verified: true,
      mode: "receipt",
      sourceSha: SOURCE_SHA,
      logicalEnvironment: "site-logbook-staging",
      productionTargetsTouched: false,
      receipt: {
        result: "PASS",
        mode: "applied",
        beforeState: "source-plan-match",
        afterDecision: "PASS",
      },
    });
  });

  it("rejects tampered sidecars, release verification drift, and a false pre-run state", () => {
    const fixture = activationArtifactFixture();
    expect(() =>
      verifyAccountingWarehousePriceBootstrapPreflightArtifactSet({
        ...fixture.preflightArtifactSet,
        lineageEvidenceBytes: `${fixture.preflightArtifactSet.lineageEvidenceBytes}\n`,
      }),
    ).toThrow(/canonical/i);
    expect(() =>
      verifyAccountingWarehousePriceBootstrapPreflightArtifactSet({
        ...fixture.preflightArtifactSet,
        stagingReleaseVerificationBytes: canonicalEvidenceJson({
          schemaVersion: 4,
          environmentId: "site-logbook-staging",
          commitSha: "c".repeat(40),
          decision: "PASS",
          releaseEvidenceFileSha256: sha256Hex(
            fixture.preflightArtifactSet.stagingReleaseEvidenceBytes,
          ),
        }),
      }),
    ).toThrow(/sidecar/i);
    expect(() =>
      verifyAccountingWarehousePriceBootstrapReceiptArtifactSet({
        ...fixture.receiptArtifactSet,
        beforeParityReportBytes:
          fixture.receiptArtifactSet.afterParityReportBytes,
      }),
    ).toThrow(/pre-apply parity/i);
  });

  it("accepts only an absolute, exact, bounded read-only verifier interface", () => {
    const absolute = resolve("C:\\evidence\\warehouse-price-activation");
    expect(
      parseWarehousePriceBootstrapActivationVerifyOptions([
        "--mode=preflight",
        `--artifact-dir=${absolute}`,
        `--expected-preflight-file-sha256=${"a".repeat(64)}`,
      ]),
    ).toEqual({
      mode: "preflight",
      artifactDirectory: absolute,
      expectedPreflightFileSha256: "a".repeat(64),
      expectedReceiptFileSha256: null,
    });
    expect(
      parseWarehousePriceBootstrapActivationVerifyOptions([
        "--mode=receipt",
        `--artifact-dir=${absolute}`,
        `--expected-preflight-file-sha256=${"a".repeat(64)}`,
        `--expected-receipt-file-sha256=${"b".repeat(64)}`,
      ]).mode,
    ).toBe("receipt");
    for (const forbidden of [
      "--apply",
      "--activate=yes",
      "--execute",
      "--migrate=0106",
      "--deploy",
      "--database=staging",
      "--write-database=staging",
      "--output=result.json",
    ]) {
      expect(() =>
        parseWarehousePriceBootstrapActivationVerifyOptions([
          "--mode=preflight",
          `--artifact-dir=${absolute}`,
          `--expected-preflight-file-sha256=${"a".repeat(64)}`,
          forbidden,
        ]),
      ).toThrow(/forbidden/i);
    }
    expect(() =>
      parseWarehousePriceBootstrapActivationVerifyOptions([
        "--mode=receipt",
        `--artifact-dir=${absolute}`,
        `--expected-preflight-file-sha256=${"a".repeat(64)}`,
      ]),
    ).toThrow(/requires.*receipt/i);
    expect(() =>
      parseWarehousePriceBootstrapActivationVerifyOptions([
        "--mode=preflight",
        "--artifact-dir=relative",
        `--expected-preflight-file-sha256=${"a".repeat(64)}`,
      ]),
    ).toThrow(/absolute/i);
    expect(() =>
      assertActivationArtifactSize(
        ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES.sourceParityReport,
        WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_REPORT_BYTES + 1,
      ),
    ).toThrow(/hard maximum/i);
    expect(() =>
      assertExactActivationArtifactLayout("preflight", [
        ...activationArtifactNames("preflight"),
        "unexpected.json",
      ]),
    ).toThrow(/layout mismatch/i);
  });

  it("verifies exact preflight and receipt directories without writing output files", () => {
    const fixture = activationArtifactFixture();
    const root = resolve(import.meta.dirname, "../../..");
    const cli = resolve(
      root,
      "artifacts/api-server/src/scripts/verify-warehouse-price-bootstrap-activation.ts",
    );
    const tsx = resolve(root, "scripts/node_modules/tsx/dist/cli.mjs");
    const preflightDirectory = writeActivationArtifactDirectory(
      fixture.preflightArtifacts,
    );
    const receiptDirectory = writeActivationArtifactDirectory(
      fixture.receiptArtifacts,
    );
    try {
      const preflightResult = spawnSync(
        process.execPath,
        [
          tsx,
          cli,
          "--mode=preflight",
          `--artifact-dir=${preflightDirectory}`,
          `--expected-preflight-file-sha256=${sha256Hex(fixture.preflightBytes)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(preflightResult.error).toBeUndefined();
      expect(preflightResult.status, preflightResult.stderr).toBe(0);
      expect(preflightResult.stderr).toBe("");
      expect(preflightResult.stdout.endsWith("\n")).toBe(false);
      expect(JSON.parse(preflightResult.stdout)).toMatchObject({
        verified: true,
        mode: "preflight",
        receipt: null,
      });

      const receiptResult = spawnSync(
        process.execPath,
        [
          tsx,
          cli,
          "--mode=receipt",
          `--artifact-dir=${receiptDirectory}`,
          `--expected-preflight-file-sha256=${sha256Hex(fixture.preflightBytes)}`,
          `--expected-receipt-file-sha256=${sha256Hex(fixture.receiptBytes)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(receiptResult.error).toBeUndefined();
      expect(receiptResult.status, receiptResult.stderr).toBe(0);
      expect(receiptResult.stderr).toBe("");
      expect(receiptResult.stdout.endsWith("\n")).toBe(false);
      expect(JSON.parse(receiptResult.stdout)).toMatchObject({
        verified: true,
        mode: "receipt",
        receipt: { result: "PASS", mode: "applied" },
      });

      writeFileSync(join(preflightDirectory, "unexpected.json"), "{}", {
        flag: "wx",
      });
      const extraFile = spawnSync(
        process.execPath,
        [
          tsx,
          cli,
          "--mode=preflight",
          `--artifact-dir=${preflightDirectory}`,
          `--expected-preflight-file-sha256=${sha256Hex(fixture.preflightBytes)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(extraFile.status).toBe(1);
      expect(extraFile.stdout).toBe("");
      expect(extraFile.stderr).toMatch(/layout mismatch/i);

      const wrongDigest = spawnSync(
        process.execPath,
        [
          tsx,
          cli,
          "--mode=receipt",
          `--artifact-dir=${receiptDirectory}`,
          `--expected-preflight-file-sha256=${"0".repeat(64)}`,
          `--expected-receipt-file-sha256=${sha256Hex(fixture.receiptBytes)}`,
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
      expect(wrongDigest.stderr).toMatch(/preflight file digest/i);
    } finally {
      rmSync(preflightDirectory, { recursive: true, force: true });
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps the verifier offline, read-only, and absent from app or route wiring", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const cliSource = readFileSync(
      resolve(
        root,
        "artifacts/api-server/src/scripts/verify-warehouse-price-bootstrap-activation.ts",
      ),
      "utf8",
    );
    const policySource = readFileSync(
      resolve(
        root,
        "artifacts/api-server/src/scripts/warehouse-price-bootstrap-activation-verifier-policy.ts",
      ),
      "utf8",
    );
    const app = readFileSync(
      resolve(root, "artifacts/api-server/src/app.ts"),
      "utf8",
    );
    for (const source of [cliSource, policySource]) {
      expect(source).not.toMatch(
        /DATABASE_URL|@workspace\/db|from ["']pg["']|S3|PutObject|docker|coolify|fetch\s*\(/i,
      );
      expect(source).not.toMatch(
        /writeFile|appendFile|unlink|rename|mkdir|rm\s*\(/,
      );
    }
    expect(app).not.toContain("verify-warehouse-price-bootstrap-activation");
  });

  it("keeps the capture runbook exact, no-go, and free of mutation commands", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const runbook = readFileSync(
      resolve(
        root,
        "docs/audit/17-ab-r13-d9o-warehouse-price-activation-capture-runbook.md",
      ),
      "utf8",
    );
    const packageJson = readFileSync(
      resolve(root, "artifacts/api-server/package.json"),
      "utf8",
    );
    for (const filename of activationArtifactNames("receipt")) {
      expect(runbook).toContain(`\`${filename}\``);
    }
    for (const boundary of [
      "--mode=preflight",
      "--mode=receipt",
      "--expected-preflight-file-sha256",
      "--expected-receipt-file-sha256",
      "Výsledek tx neznámý",
      "žádný blind retry",
      "committed-without-receipt",
      "0100` zůstává vyloučena",
      "Skutečný staging běh zůstává BLOCKED",
    ]) {
      expect(runbook).toContain(boundary);
    }
    expect(
      runbook.match(/accounting:warehouse-price:bootstrap-activation:verify/g),
    ).toHaveLength(2);
    expect(runbook).not.toMatch(
      /pnpm\.cmd[^\n]*(?:run migrate|bootstrap-apply|schema-transition)|docker\s+compose|\bpsql\b|\bcurl\b|Invoke-WebRequest/i,
    );
    expect(packageJson).toContain(
      '"accounting:warehouse-price:bootstrap-activation:verify": "tsx src/scripts/verify-warehouse-price-bootstrap-activation.ts"',
    );
  });
});
