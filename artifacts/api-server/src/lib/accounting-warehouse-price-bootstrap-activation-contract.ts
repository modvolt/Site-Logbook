import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  verifyCanonicalAccountingWarehousePriceBootstrapApplyAuthorizationJsonBytes,
  type AccountingWarehousePriceBootstrapApplyAuthorizationV1,
} from "./accounting-warehouse-price-bootstrap-apply";
import {
  verifyAccountingWarehousePriceBootstrapPlanBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes,
  type AccountingWarehousePriceBootstrapPlanV1,
} from "./accounting-warehouse-price-bootstrap-plan";
import {
  createAccountingWarehousePriceParityItem,
  verifyCanonicalAccountingWarehousePriceParityReportJsonBytes,
  type AccountingWarehousePriceParityReportV1,
} from "./accounting-warehouse-price-parity";
import {
  canonicalAccountingWarehousePriceProjectionHeadJson,
  createAccountingWarehousePriceProjectionHead,
} from "./accounting-warehouse-price-projection-head";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const APPROVAL_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-approval/v1" as const;
const PREFLIGHT_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-activation-preflight/v1" as const;
const RECEIPT_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-execution-receipt/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const LOGICAL_ENVIRONMENT = "site-logbook-staging" as const;
const MAX_PAYLOAD_BYTES = 268_435_456 as const;
const MAX_CANDIDATES = 20_000 as const;
const APPROVAL_CONFIRMATION =
  "APPROVE_EXACT_WAREHOUSE_PRICE_LEGACY_BOOTSTRAP_UNKNOWN_HISTORY_NO_FX" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const MIGRATION_TAG_PATTERN = /^(?!0100_)[0-9]{4}_[a-z0-9_]+$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const sourceShaSchema = z.string().regex(SOURCE_SHA_PATTERN);
const positiveIdSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const emptyStringArraySchema = z.array(z.string()).length(0);

const approvalBodyShape = {
  schemaVersion: z.literal(APPROVAL_SCHEMA),
  operation: z.literal("warehouse-price-legacy-bootstrap"),
  binding: z
    .object({
      targetFingerprint: sha256Schema,
      parityReportSha256: sha256Schema,
      parityReportFileSha256: sha256Schema,
      planSha256: sha256Schema,
      planFileSha256: sha256Schema,
      candidateCount: z.number().int().positive().max(MAX_CANDIDATES),
    })
    .strict(),
  approval: z
    .object({
      decision: z.literal("approved"),
      confirmation: z.literal(APPROVAL_CONFIRMATION),
      approvedAt: timestampSchema,
      approvedByUserId: positiveIdSchema,
      unknownHistoryAccepted: z.literal(true),
      sourceCurrencyNoFxAccepted: z.literal(true),
    })
    .strict(),
  boundary: z
    .object({
      stagingOnly: z.literal(true),
      activationPreflightRequired: z.literal(true),
      databaseWriteAuthorized: z.literal(false),
      migrationAuthorized: z.literal(false),
      deployAuthorized: z.literal(false),
      productionTargetsTouched: z.literal(false),
    })
    .strict(),
};
const approvalBodySchema = z.object(approvalBodyShape).strict();
const approvalSchema = z
  .object({
    ...approvalBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(APPROVAL_SCHEMA),
        approvalSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const stagingEvidenceSchema = z
  .object({
    strictReleaseEvidenceVerified: z.literal(true),
    releaseEvidenceFileSha256: sha256Schema,
    releaseVerificationFileSha256: sha256Schema,
    releaseVerificationSchemaVersion: z.literal(4),
    releaseVerificationDecision: z.literal("PASS"),
    provisioningArtifactSha256: sha256Schema,
    deploymentInputsArtifactSha256: sha256Schema,
    sourceSha: sourceShaSchema,
    logicalEnvironment: z.literal(LOGICAL_ENVIRONMENT),
    targetFingerprint: sha256Schema,
    productionTargetsTouched: z.literal(false),
  })
  .strict();

const migrationLineageSchema = z
  .object({
    lineageEvidenceFileSha256: sha256Schema,
    sourceSha: sourceShaSchema,
    publicMainIntegrated: z.literal(true),
    productionCopySourceJournalSha256: sha256Schema,
    knownCodeTagsSha256: sha256Schema,
    appliedKnownTagsSha256: sha256Schema,
    knownCodeMigrationCount: z.number().int().positive(),
    appliedKnownMigrationCount: z.number().int().positive(),
    latestKnownMigrationTag: z.string().regex(MIGRATION_TAG_PATTERN),
    missingKnownTags: emptyStringArraySchema,
    unexpectedKnownTags: emptyStringArraySchema,
    opaqueLegacyRows: z
      .array(
        z
          .object({
            identitySha256: sha256Schema,
          })
          .strict(),
      )
      .length(2),
    opaqueLegacyRowCount: z.literal(2),
    opaqueLegacyMeaningInferred: z.literal(false),
    excludedMigrationTags: z.tuple([z.literal("0100")]),
    plannedAccountingMigration: z
      .object({
        tag: z.string().regex(MIGRATION_TAG_PATTERN),
        sqlSha256: sha256Schema,
        includedInCode: z.literal(true),
        appliedToTarget: z.literal(true),
        schemaExpanded: z.literal(true),
      })
      .strict(),
  })
  .strict();

const backupEvidenceSchema = z
  .object({
    backupEvidenceFileSha256: sha256Schema,
    backupEvidenceId: positiveIdSchema,
    targetFingerprint: sha256Schema,
    productionTargetsTouched: z.literal(false),
    status: z.literal("completed"),
    restoreStatus: z.literal("passed"),
    encryptedBackupSha256: sha256Schema,
    sourceExecutionSha256: sha256Schema,
    sizeBytes: z.number().int().positive().max(MAX_PAYLOAD_BYTES),
    maxPayloadBytes: z.literal(MAX_PAYLOAD_BYTES),
    createdAt: timestampSchema,
    restoreTestedAt: timestampSchema,
    checkedAt: timestampSchema,
    maxRestoreAgeHours: z.number().int().positive().max(168),
  })
  .strict();

export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MIGRATION_LINEAGE_ZOD_SCHEMA_V1 =
  migrationLineageSchema;
export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_BACKUP_EVIDENCE_ZOD_SCHEMA_V1 =
  backupEvidenceSchema;

const preflightBodyShape = {
  schemaVersion: z.literal(PREFLIGHT_SCHEMA),
  operation: z.literal("warehouse-price-legacy-bootstrap-activation"),
  decision: z.literal("READY"),
  preparedAt: timestampSchema,
  sourceSha: sourceShaSchema,
  targetFingerprint: sha256Schema,
  logicalEnvironment: z.literal(LOGICAL_ENVIRONMENT),
  productionTargetsTouched: z.literal(false),
  artifacts: z
    .object({
      approvalSha256: sha256Schema,
      approvalFileSha256: sha256Schema,
      authorizationSha256: sha256Schema,
      authorizationFileSha256: sha256Schema,
      planSha256: sha256Schema,
      planFileSha256: sha256Schema,
      parityReportSha256: sha256Schema,
      parityReportFileSha256: sha256Schema,
    })
    .strict(),
  stagingEvidence: stagingEvidenceSchema,
  migrationLineage: migrationLineageSchema,
  backupEvidence: backupEvidenceSchema,
  executionBoundary: z
    .object({
      candidateCount: z.number().int().positive().max(MAX_CANDIDATES),
      maxCandidatesPerTransaction: z
        .number()
        .int()
        .positive()
        .max(MAX_CANDIDATES),
      callerOwnedSingleTransactionRequired: z.literal(true),
      candidateLocksAscending: z.literal(true),
      exactReplayOnly: z.literal(true),
      beforeAndAfterParityRequired: z.literal(true),
      partialResumeAllowed: z.literal(false),
      applyRunnerIncluded: z.literal(false),
      deploymentIncluded: z.literal(false),
      migrationExecutionIncluded: z.literal(false),
      productionWriteIncluded: z.literal(false),
    })
    .strict(),
};
const preflightBodySchema = z.object(preflightBodyShape).strict();
const preflightSchema = z
  .object({
    ...preflightBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(PREFLIGHT_SCHEMA),
        preflightSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const receiptBodyShape = {
  schemaVersion: z.literal(RECEIPT_SCHEMA),
  operation: z.literal("warehouse-price-legacy-bootstrap"),
  result: z.literal("PASS"),
  sourceSha: sourceShaSchema,
  targetFingerprint: sha256Schema,
  logicalEnvironment: z.literal(LOGICAL_ENVIRONMENT),
  productionTargetsTouched: z.literal(false),
  bindings: z
    .object({
      preflightSha256: sha256Schema,
      preflightFileSha256: sha256Schema,
      approvalSha256: sha256Schema,
      approvalFileSha256: sha256Schema,
      authorizationSha256: sha256Schema,
      authorizationFileSha256: sha256Schema,
      planSha256: sha256Schema,
      planFileSha256: sha256Schema,
      sourceParityReportSha256: sha256Schema,
      sourceParityReportFileSha256: sha256Schema,
      beforeParityReportSha256: sha256Schema,
      beforeParityReportFileSha256: sha256Schema,
      afterParityReportSha256: sha256Schema,
      afterParityReportFileSha256: sha256Schema,
      backupEvidenceFileSha256: sha256Schema,
      migrationLineageEvidenceFileSha256: sha256Schema,
      accountingMigrationTag: z.string().regex(MIGRATION_TAG_PATTERN),
      accountingMigrationSqlSha256: sha256Schema,
    })
    .strict(),
  execution: z
    .object({
      mode: z.enum(["applied", "exact-replay"]),
      observationCount: z.number().int().positive().max(MAX_CANDIDATES),
      observationIds: z.array(z.string().uuid()).min(1).max(MAX_CANDIDATES),
      startedAt: timestampSchema,
      completedAt: timestampSchema,
      callerTransactionCommitted: z.literal(true),
    })
    .strict(),
  verification: z
    .object({
      candidateCount: z.number().int().positive().max(MAX_CANDIDATES),
      candidateItemIds: z.array(positiveIdSchema).min(1).max(MAX_CANDIDATES),
      beforeState: z.enum(["source-plan-match", "exact-replay-match"]),
      afterTargetMatched: z.literal(true),
      nonCandidateItemsUnchanged: z.literal(true),
      candidateItemsLegacyBootstrapMatched: z.literal(true),
      storedPricesUnchanged: z.literal(true),
      legacyRowsUnchanged: z.literal(true),
      afterDecision: z.literal("PASS"),
      partialApplicationDetected: z.literal(false),
    })
    .strict(),
};
const receiptBodySchema = z.object(receiptBodyShape).strict();
const receiptSchema = z
  .object({
    ...receiptBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(RECEIPT_SCHEMA),
        receiptSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

type ApprovalBodyV1 = z.infer<typeof approvalBodySchema>;
type PreflightBodyV1 = z.infer<typeof preflightBodySchema>;
type ReceiptBodyV1 = z.infer<typeof receiptBodySchema>;
export type AccountingWarehousePriceBootstrapApprovalV1 = z.infer<
  typeof approvalSchema
>;
export type AccountingWarehousePriceBootstrapActivationPreflightV1 = z.infer<
  typeof preflightSchema
>;
export type AccountingWarehousePriceBootstrapExecutionReceiptV1 = z.infer<
  typeof receiptSchema
>;

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function rawBytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, "utf8");
}

function integrityHash(
  schema: string,
  value: Record<string, unknown>,
  key: string,
) {
  const integrity = value.integrity as Record<string, unknown>;
  return sha256Hex(
    `${schema}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...integrity, [key]: null },
    })}`,
  );
}

function comparePositiveIds(left: string, right: string): number {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}

function assertUniqueSorted(values: string[], label: string): void {
  const sorted = [...new Set(values)].sort(comparePositiveIds);
  if (canonicalEvidenceJson(values) !== canonicalEvidenceJson(sorted)) {
    throw new Error(`${label} must be unique and sorted in ascending order.`);
  }
}

function assertApprovalPlanBinding(input: {
  approval: AccountingWarehousePriceBootstrapApprovalV1;
  authorization: AccountingWarehousePriceBootstrapApplyAuthorizationV1;
  plan: AccountingWarehousePriceBootstrapPlanV1;
  report: AccountingWarehousePriceParityReportV1;
  approvalBytes: Buffer;
  authorizationBytes: Buffer;
  planBytes: Buffer;
  reportBytes: Buffer;
}): void {
  const { approval, authorization, plan, report } = input;
  if (
    plan.summary.decision !== "REVIEW" ||
    plan.summary.blockedItemCount !== 0 ||
    plan.candidates.length === 0 ||
    approval.binding.targetFingerprint !== report.targetFingerprint ||
    approval.binding.parityReportSha256 !== report.integrity.reportSha256 ||
    approval.binding.parityReportFileSha256 !== sha256Hex(input.reportBytes) ||
    approval.binding.planSha256 !== plan.integrity.planSha256 ||
    approval.binding.planFileSha256 !== sha256Hex(input.planBytes) ||
    approval.binding.candidateCount !== plan.candidates.length ||
    authorization.plan.planSha256 !== plan.integrity.planSha256 ||
    authorization.plan.planFileSha256 !== sha256Hex(input.planBytes) ||
    authorization.plan.parityReportSha256 !== report.integrity.reportSha256 ||
    authorization.plan.parityReportFileSha256 !==
      sha256Hex(input.reportBytes) ||
    authorization.plan.targetFingerprint !== report.targetFingerprint ||
    authorization.plan.candidateCount !== plan.candidates.length ||
    authorization.approval.approvalEvidenceSha256 !==
      sha256Hex(input.approvalBytes) ||
    authorization.approval.approvedAt !== approval.approval.approvedAt ||
    authorization.approval.approvedByUserId !==
      approval.approval.approvedByUserId
  ) {
    throw new Error(
      "Warehouse-price activation artifacts do not bind the same approved plan.",
    );
  }
}

function readCoreArtifacts(input: {
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  planBytes: string | Buffer;
  parityReportBytes: string | Buffer;
}) {
  const approvalBytes = rawBytes(input.approvalBytes);
  const authorizationBytes = rawBytes(input.authorizationBytes);
  const planBytes = rawBytes(input.planBytes);
  const reportBytes = rawBytes(input.parityReportBytes);
  const approval =
    verifyCanonicalAccountingWarehousePriceBootstrapApprovalJsonBytes(
      approvalBytes,
    );
  const authorization =
    verifyCanonicalAccountingWarehousePriceBootstrapApplyAuthorizationJsonBytes(
      authorizationBytes,
    );
  const plan =
    verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(planBytes);
  const report =
    verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(reportBytes);
  verifyAccountingWarehousePriceBootstrapPlanBinding(plan, reportBytes);
  assertApprovalPlanBinding({
    approval,
    authorization,
    plan,
    report,
    approvalBytes,
    authorizationBytes,
    planBytes,
    reportBytes,
  });
  return {
    approval,
    authorization,
    plan,
    report,
    approvalBytes,
    authorizationBytes,
    planBytes,
    reportBytes,
  };
}

export function createAccountingWarehousePriceBootstrapApproval(
  input: ApprovalBodyV1,
): AccountingWarehousePriceBootstrapApprovalV1 {
  const body = approvalBodySchema.parse(input);
  const candidate = approvalSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: APPROVAL_SCHEMA,
      approvalSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapApproval({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      approvalSha256: integrityHash(
        APPROVAL_SCHEMA,
        candidate,
        "approvalSha256",
      ),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapApproval(
  value: unknown,
): AccountingWarehousePriceBootstrapApprovalV1 {
  const approval = approvalSchema.parse(value);
  if (
    !safeEqualHex(
      approval.integrity.approvalSha256,
      integrityHash(APPROVAL_SCHEMA, approval, "approvalSha256"),
    )
  ) {
    throw new Error("Warehouse-price bootstrap approval digest mismatch.");
  }
  return approval;
}

export function canonicalAccountingWarehousePriceBootstrapApprovalJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapApproval(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapApprovalJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapApprovalV1 {
  const text = rawBytes(value).toString("utf8");
  const approval = verifyAccountingWarehousePriceBootstrapApproval(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(approval) !== text) {
    throw new Error(
      "Warehouse-price bootstrap approval bytes are not canonical JSON.",
    );
  }
  return approval;
}

function validatePreflightSemantics(
  preflight: AccountingWarehousePriceBootstrapActivationPreflightV1,
): void {
  const lineage = preflight.migrationLineage;
  const backup = preflight.backupEvidence;
  const opaqueDigests = lineage.opaqueLegacyRows.map(
    (row) => row.identitySha256,
  );
  if (
    lineage.knownCodeMigrationCount !== lineage.appliedKnownMigrationCount ||
    !safeEqualHex(
      lineage.knownCodeTagsSha256,
      lineage.appliedKnownTagsSha256,
    ) ||
    lineage.opaqueLegacyRowCount !== lineage.opaqueLegacyRows.length ||
    new Set(opaqueDigests).size !== opaqueDigests.length ||
    canonicalEvidenceJson(opaqueDigests) !==
      canonicalEvidenceJson([...opaqueDigests].sort()) ||
    lineage.latestKnownMigrationTag !==
      lineage.plannedAccountingMigration.tag ||
    lineage.plannedAccountingMigration.tag.startsWith("0100_") ||
    preflight.executionBoundary.maxCandidatesPerTransaction <
      preflight.executionBoundary.candidateCount ||
    preflight.sourceSha !== lineage.sourceSha ||
    preflight.sourceSha !== preflight.stagingEvidence.sourceSha ||
    preflight.targetFingerprint !== backup.targetFingerprint ||
    preflight.targetFingerprint !== preflight.stagingEvidence.targetFingerprint
  ) {
    throw new Error(
      "Warehouse-price activation preflight contains a cross-binding mismatch.",
    );
  }
  const createdAt = Date.parse(backup.createdAt);
  const restoredAt = Date.parse(backup.restoreTestedAt);
  const checkedAt = Date.parse(backup.checkedAt);
  const preparedAt = Date.parse(preflight.preparedAt);
  if (
    createdAt > restoredAt ||
    restoredAt > checkedAt ||
    checkedAt > preparedAt ||
    (preparedAt - restoredAt) / 3_600_000 > backup.maxRestoreAgeHours
  ) {
    throw new Error(
      "Warehouse-price activation preflight backup is stale or chronologically invalid.",
    );
  }
}

export function createAccountingWarehousePriceBootstrapActivationPreflight(input: {
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  planBytes: string | Buffer;
  parityReportBytes: string | Buffer;
  preparedAt: string;
  sourceSha: string;
  stagingEvidence: z.input<typeof stagingEvidenceSchema>;
  migrationLineage: z.input<typeof migrationLineageSchema>;
  backupEvidence: z.input<typeof backupEvidenceSchema>;
  maxCandidatesPerTransaction: number;
}): AccountingWarehousePriceBootstrapActivationPreflightV1 {
  const artifacts = readCoreArtifacts(input);
  if (
    Date.parse(artifacts.report.observedAt) >
      Date.parse(artifacts.approval.approval.approvedAt) ||
    Date.parse(artifacts.approval.approval.approvedAt) >
      Date.parse(input.preparedAt)
  ) {
    throw new Error(
      "Warehouse-price activation approval chronology is invalid.",
    );
  }
  const body = preflightBodySchema.parse({
    schemaVersion: PREFLIGHT_SCHEMA,
    operation: "warehouse-price-legacy-bootstrap-activation",
    decision: "READY",
    preparedAt: input.preparedAt,
    sourceSha: input.sourceSha,
    targetFingerprint: artifacts.report.targetFingerprint,
    logicalEnvironment: LOGICAL_ENVIRONMENT,
    productionTargetsTouched: false,
    artifacts: {
      approvalSha256: artifacts.approval.integrity.approvalSha256,
      approvalFileSha256: sha256Hex(artifacts.approvalBytes),
      authorizationSha256:
        artifacts.authorization.integrity.authorizationSha256,
      authorizationFileSha256: sha256Hex(artifacts.authorizationBytes),
      planSha256: artifacts.plan.integrity.planSha256,
      planFileSha256: sha256Hex(artifacts.planBytes),
      parityReportSha256: artifacts.report.integrity.reportSha256,
      parityReportFileSha256: sha256Hex(artifacts.reportBytes),
    },
    stagingEvidence: input.stagingEvidence,
    migrationLineage: input.migrationLineage,
    backupEvidence: input.backupEvidence,
    executionBoundary: {
      candidateCount: artifacts.plan.candidates.length,
      maxCandidatesPerTransaction: input.maxCandidatesPerTransaction,
      callerOwnedSingleTransactionRequired: true,
      candidateLocksAscending: true,
      exactReplayOnly: true,
      beforeAndAfterParityRequired: true,
      partialResumeAllowed: false,
      applyRunnerIncluded: false,
      deploymentIncluded: false,
      migrationExecutionIncluded: false,
      productionWriteIncluded: false,
    },
  });
  const candidate = preflightSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: PREFLIGHT_SCHEMA,
      preflightSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapActivationPreflight({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      preflightSha256: integrityHash(
        PREFLIGHT_SCHEMA,
        candidate,
        "preflightSha256",
      ),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapActivationPreflight(
  value: unknown,
): AccountingWarehousePriceBootstrapActivationPreflightV1 {
  const preflight = preflightSchema.parse(value);
  validatePreflightSemantics(preflight);
  if (
    !safeEqualHex(
      preflight.integrity.preflightSha256,
      integrityHash(PREFLIGHT_SCHEMA, preflight, "preflightSha256"),
    )
  ) {
    throw new Error("Warehouse-price activation preflight digest mismatch.");
  }
  return preflight;
}

export function canonicalAccountingWarehousePriceBootstrapActivationPreflightJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapActivationPreflight(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapActivationPreflightJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapActivationPreflightV1 {
  const text = rawBytes(value).toString("utf8");
  const preflight = verifyAccountingWarehousePriceBootstrapActivationPreflight(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(preflight) !== text) {
    throw new Error(
      "Warehouse-price activation preflight bytes are not canonical JSON.",
    );
  }
  return preflight;
}

export function verifyAccountingWarehousePriceBootstrapActivationPreflightBinding(input: {
  preflightBytes: string | Buffer;
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  planBytes: string | Buffer;
  parityReportBytes: string | Buffer;
}): AccountingWarehousePriceBootstrapActivationPreflightV1 {
  const preflight =
    verifyCanonicalAccountingWarehousePriceBootstrapActivationPreflightJsonBytes(
      input.preflightBytes,
    );
  const rebuilt = createAccountingWarehousePriceBootstrapActivationPreflight({
    approvalBytes: input.approvalBytes,
    authorizationBytes: input.authorizationBytes,
    planBytes: input.planBytes,
    parityReportBytes: input.parityReportBytes,
    preparedAt: preflight.preparedAt,
    sourceSha: preflight.sourceSha,
    stagingEvidence: preflight.stagingEvidence,
    migrationLineage: preflight.migrationLineage,
    backupEvidence: preflight.backupEvidence,
    maxCandidatesPerTransaction:
      preflight.executionBoundary.maxCandidatesPerTransaction,
  });
  if (canonicalEvidenceJson(rebuilt) !== canonicalEvidenceJson(preflight)) {
    throw new Error(
      "Warehouse-price activation preflight does not bind its canonical raw artifacts.",
    );
  }
  return preflight;
}

function expectedAfterItem(
  beforeItem: AccountingWarehousePriceParityReportV1["items"][number],
  candidate: AccountingWarehousePriceBootstrapPlanV1["candidates"][number],
) {
  const head = createAccountingWarehousePriceProjectionHead({
    warehouseItemId: candidate.warehouseItemId,
    observations: [candidate],
  });
  const rebuilt = createAccountingWarehousePriceParityItem({
    warehouseItemId: beforeItem.warehouseItemId,
    storedPurchasePrice: beforeItem.storedPurchasePrice,
    observations: [candidate],
    projectionHead: head,
    legacyRows: beforeItem.legacyRows.map(
      ({
        rowSha256: _rowSha256,
        historicalCompleteness: _completeness,
        ...row
      }) => row,
    ),
  });
  if (
    rebuilt.projectionHead === null ||
    canonicalAccountingWarehousePriceProjectionHeadJson(
      rebuilt.projectionHead,
    ) !== canonicalAccountingWarehousePriceProjectionHeadJson(head)
  ) {
    throw new Error("Warehouse-price bootstrap after projection is invalid.");
  }
  return rebuilt;
}

function validateAfterReport(input: {
  plan: AccountingWarehousePriceBootstrapPlanV1;
  before: AccountingWarehousePriceParityReportV1;
  after: AccountingWarehousePriceParityReportV1;
}): string[] {
  const { plan, before, after } = input;
  if (
    before.targetFingerprint !== after.targetFingerprint ||
    canonicalEvidenceJson(before.limits) !==
      canonicalEvidenceJson(after.limits) ||
    after.summary.decision !== "PASS" ||
    before.items.length !== after.items.length
  ) {
    throw new Error(
      "Warehouse-price bootstrap after parity boundary mismatch.",
    );
  }
  const beforeItems = new Map(
    before.items.map((item) => [item.warehouseItemId, item] as const),
  );
  const afterItems = new Map(
    after.items.map((item) => [item.warehouseItemId, item] as const),
  );
  if (
    canonicalEvidenceJson([...beforeItems.keys()]) !==
    canonicalEvidenceJson([...afterItems.keys()])
  ) {
    throw new Error("Warehouse-price bootstrap changed the item inventory.");
  }
  const candidates = new Map(
    plan.candidates.map((candidate) => [candidate.warehouseItemId, candidate]),
  );
  for (const [itemId, beforeItem] of beforeItems) {
    const afterItem = afterItems.get(itemId);
    if (!afterItem) {
      throw new Error("Warehouse-price bootstrap lost an inventory item.");
    }
    const candidate = candidates.get(itemId);
    const expected = candidate
      ? expectedAfterItem(beforeItem, candidate)
      : beforeItem;
    if (canonicalEvidenceJson(expected) !== canonicalEvidenceJson(afterItem)) {
      throw new Error(
        `Warehouse-price bootstrap after parity drifted for item ${itemId}.`,
      );
    }
  }
  return [...candidates.keys()].sort(comparePositiveIds);
}

function validateSourceEquivalentReport(input: {
  source: AccountingWarehousePriceParityReportV1;
  before: AccountingWarehousePriceParityReportV1;
}): void {
  if (
    input.source.targetFingerprint !== input.before.targetFingerprint ||
    canonicalEvidenceJson(input.source.limits) !==
      canonicalEvidenceJson(input.before.limits) ||
    canonicalEvidenceJson(input.source.summary) !==
      canonicalEvidenceJson(input.before.summary) ||
    canonicalEvidenceJson(input.source.items) !==
      canonicalEvidenceJson(input.before.items) ||
    Date.parse(input.before.observedAt) < Date.parse(input.source.observedAt)
  ) {
    throw new Error(
      "Warehouse-price bootstrap pre-apply parity no longer matches the approved source state.",
    );
  }
}

export function createAccountingWarehousePriceBootstrapExecutionReceipt(input: {
  preflightBytes: string | Buffer;
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  planBytes: string | Buffer;
  sourceParityReportBytes: string | Buffer;
  beforeParityReportBytes: string | Buffer;
  afterParityReportBytes: string | Buffer;
  applyResult: {
    mode: "applied" | "exact-replay";
    observationCount: number;
    observationIds: string[];
  };
  startedAt: string;
  completedAt: string;
}): AccountingWarehousePriceBootstrapExecutionReceiptV1 {
  const preflightBytes = rawBytes(input.preflightBytes);
  const preflight =
    verifyAccountingWarehousePriceBootstrapActivationPreflightBinding({
      preflightBytes,
      approvalBytes: input.approvalBytes,
      authorizationBytes: input.authorizationBytes,
      planBytes: input.planBytes,
      parityReportBytes: input.sourceParityReportBytes,
    });
  const core = readCoreArtifacts({
    approvalBytes: input.approvalBytes,
    authorizationBytes: input.authorizationBytes,
    planBytes: input.planBytes,
    parityReportBytes: input.sourceParityReportBytes,
  });
  const beforeBytes = rawBytes(input.beforeParityReportBytes);
  const before =
    verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(beforeBytes);
  const afterBytes = rawBytes(input.afterParityReportBytes);
  const after =
    verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(afterBytes);
  const candidateItemIds = validateAfterReport({
    plan: core.plan,
    before: core.report,
    after,
  });
  if (input.applyResult.mode === "applied") {
    validateSourceEquivalentReport({ source: core.report, before });
  } else {
    validateAfterReport({
      plan: core.plan,
      before: core.report,
      after: before,
    });
  }
  const expectedObservationIds = core.plan.candidates.map(
    (candidate) => candidate.observationId,
  );
  const actualObservationIds = input.applyResult.observationIds;
  if (
    preflight.artifacts.approvalFileSha256 !== sha256Hex(core.approvalBytes) ||
    preflight.artifacts.approvalSha256 !==
      core.approval.integrity.approvalSha256 ||
    preflight.artifacts.authorizationFileSha256 !==
      sha256Hex(core.authorizationBytes) ||
    preflight.artifacts.authorizationSha256 !==
      core.authorization.integrity.authorizationSha256 ||
    preflight.artifacts.planFileSha256 !== sha256Hex(core.planBytes) ||
    preflight.artifacts.planSha256 !== core.plan.integrity.planSha256 ||
    preflight.artifacts.parityReportFileSha256 !==
      sha256Hex(core.reportBytes) ||
    preflight.artifacts.parityReportSha256 !==
      core.report.integrity.reportSha256 ||
    preflight.targetFingerprint !== core.report.targetFingerprint ||
    input.applyResult.observationCount !== core.plan.candidates.length ||
    canonicalEvidenceJson(actualObservationIds) !==
      canonicalEvidenceJson(expectedObservationIds) ||
    new Set(input.applyResult.observationIds).size !==
      input.applyResult.observationIds.length
  ) {
    throw new Error(
      "Warehouse-price bootstrap execution does not match its approved preflight.",
    );
  }
  const startedAt = timestampSchema.parse(input.startedAt);
  const completedAt = timestampSchema.parse(input.completedAt);
  if (
    Date.parse(startedAt) < Date.parse(preflight.preparedAt) ||
    Date.parse(before.observedAt) < Date.parse(core.report.observedAt) ||
    Date.parse(before.observedAt) > Date.parse(startedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(after.observedAt) < Date.parse(completedAt)
  ) {
    throw new Error(
      "Warehouse-price bootstrap execution chronology is invalid.",
    );
  }
  const body = receiptBodySchema.parse({
    schemaVersion: RECEIPT_SCHEMA,
    operation: "warehouse-price-legacy-bootstrap",
    result: "PASS",
    sourceSha: preflight.sourceSha,
    targetFingerprint: preflight.targetFingerprint,
    logicalEnvironment: LOGICAL_ENVIRONMENT,
    productionTargetsTouched: false,
    bindings: {
      preflightSha256: preflight.integrity.preflightSha256,
      preflightFileSha256: sha256Hex(preflightBytes),
      approvalSha256: core.approval.integrity.approvalSha256,
      approvalFileSha256: sha256Hex(core.approvalBytes),
      authorizationSha256: core.authorization.integrity.authorizationSha256,
      authorizationFileSha256: sha256Hex(core.authorizationBytes),
      planSha256: core.plan.integrity.planSha256,
      planFileSha256: sha256Hex(core.planBytes),
      sourceParityReportSha256: core.report.integrity.reportSha256,
      sourceParityReportFileSha256: sha256Hex(core.reportBytes),
      beforeParityReportSha256: before.integrity.reportSha256,
      beforeParityReportFileSha256: sha256Hex(beforeBytes),
      afterParityReportSha256: after.integrity.reportSha256,
      afterParityReportFileSha256: sha256Hex(afterBytes),
      backupEvidenceFileSha256:
        preflight.backupEvidence.backupEvidenceFileSha256,
      migrationLineageEvidenceFileSha256:
        preflight.migrationLineage.lineageEvidenceFileSha256,
      accountingMigrationTag:
        preflight.migrationLineage.plannedAccountingMigration.tag,
      accountingMigrationSqlSha256:
        preflight.migrationLineage.plannedAccountingMigration.sqlSha256,
    },
    execution: {
      mode: input.applyResult.mode,
      observationCount: input.applyResult.observationCount,
      observationIds: input.applyResult.observationIds,
      startedAt,
      completedAt,
      callerTransactionCommitted: true,
    },
    verification: {
      candidateCount: core.plan.candidates.length,
      candidateItemIds,
      beforeState:
        input.applyResult.mode === "applied"
          ? "source-plan-match"
          : "exact-replay-match",
      afterTargetMatched: true,
      nonCandidateItemsUnchanged: true,
      candidateItemsLegacyBootstrapMatched: true,
      storedPricesUnchanged: true,
      legacyRowsUnchanged: true,
      afterDecision: "PASS",
      partialApplicationDetected: false,
    },
  });
  const candidate = receiptSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: RECEIPT_SCHEMA,
      receiptSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapExecutionReceipt({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      receiptSha256: integrityHash(RECEIPT_SCHEMA, candidate, "receiptSha256"),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapExecutionReceipt(
  value: unknown,
): AccountingWarehousePriceBootstrapExecutionReceiptV1 {
  const receipt = receiptSchema.parse(value);
  assertUniqueSorted(
    receipt.verification.candidateItemIds,
    "Candidate item IDs",
  );
  if (
    receipt.execution.observationCount !==
      receipt.execution.observationIds.length ||
    receipt.execution.observationCount !==
      receipt.verification.candidateCount ||
    receipt.verification.candidateCount !==
      receipt.verification.candidateItemIds.length ||
    (receipt.execution.mode === "applied" &&
      receipt.verification.beforeState !== "source-plan-match") ||
    (receipt.execution.mode === "exact-replay" &&
      receipt.verification.beforeState !== "exact-replay-match") ||
    new Set(receipt.execution.observationIds).size !==
      receipt.execution.observationIds.length ||
    Date.parse(receipt.execution.completedAt) <
      Date.parse(receipt.execution.startedAt)
  ) {
    throw new Error("Warehouse-price bootstrap receipt semantics are invalid.");
  }
  if (
    !safeEqualHex(
      receipt.integrity.receiptSha256,
      integrityHash(RECEIPT_SCHEMA, receipt, "receiptSha256"),
    )
  ) {
    throw new Error("Warehouse-price bootstrap receipt digest mismatch.");
  }
  return receipt;
}

export function canonicalAccountingWarehousePriceBootstrapExecutionReceiptJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapExecutionReceipt(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapExecutionReceiptJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapExecutionReceiptV1 {
  const text = rawBytes(value).toString("utf8");
  const receipt = verifyAccountingWarehousePriceBootstrapExecutionReceipt(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(receipt) !== text) {
    throw new Error(
      "Warehouse-price bootstrap receipt bytes are not canonical JSON.",
    );
  }
  return receipt;
}

export function verifyAccountingWarehousePriceBootstrapExecutionReceiptBinding(input: {
  receiptBytes: string | Buffer;
  preflightBytes: string | Buffer;
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  planBytes: string | Buffer;
  sourceParityReportBytes: string | Buffer;
  beforeParityReportBytes: string | Buffer;
  afterParityReportBytes: string | Buffer;
}): AccountingWarehousePriceBootstrapExecutionReceiptV1 {
  const receipt =
    verifyCanonicalAccountingWarehousePriceBootstrapExecutionReceiptJsonBytes(
      input.receiptBytes,
    );
  const rebuilt = createAccountingWarehousePriceBootstrapExecutionReceipt({
    preflightBytes: input.preflightBytes,
    approvalBytes: input.approvalBytes,
    authorizationBytes: input.authorizationBytes,
    planBytes: input.planBytes,
    sourceParityReportBytes: input.sourceParityReportBytes,
    beforeParityReportBytes: input.beforeParityReportBytes,
    afterParityReportBytes: input.afterParityReportBytes,
    applyResult: {
      mode: receipt.execution.mode,
      observationCount: receipt.execution.observationCount,
      observationIds: receipt.execution.observationIds,
    },
    startedAt: receipt.execution.startedAt,
    completedAt: receipt.execution.completedAt,
  });
  if (canonicalEvidenceJson(rebuilt) !== canonicalEvidenceJson(receipt)) {
    throw new Error(
      "Warehouse-price bootstrap receipt does not bind its canonical raw evidence chain.",
    );
  }
  return receipt;
}

export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPROVAL_CONFIRMATION =
  APPROVAL_CONFIRMATION;
export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MAX_PAYLOAD_BYTES =
  MAX_PAYLOAD_BYTES;
