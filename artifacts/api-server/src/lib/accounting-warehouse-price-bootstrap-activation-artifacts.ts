import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_BACKUP_EVIDENCE_ZOD_SCHEMA_V1,
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MIGRATION_LINEAGE_ZOD_SCHEMA_V1,
  verifyAccountingWarehousePriceBootstrapActivationPreflightBinding,
  verifyAccountingWarehousePriceBootstrapExecutionReceiptBinding,
  type AccountingWarehousePriceBootstrapActivationPreflightV1,
  type AccountingWarehousePriceBootstrapExecutionReceiptV1,
} from "./accounting-warehouse-price-bootstrap-activation-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const LINEAGE_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-lineage-evidence/v1" as const;
const BACKUP_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-backup-evidence/v1" as const;
const VERIFICATION_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-offline-verification/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);

const lineageInputSchema =
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_MIGRATION_LINEAGE_ZOD_SCHEMA_V1.omit({
    lineageEvidenceFileSha256: true,
  });
const backupInputSchema =
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_BACKUP_EVIDENCE_ZOD_SCHEMA_V1.omit({
    backupEvidenceFileSha256: true,
  });

const lineageBodyShape = {
  schemaVersion: z.literal(LINEAGE_SCHEMA),
  lineage: lineageInputSchema,
};
const lineageBodySchema = z.object(lineageBodyShape).strict();
const lineageArtifactSchema = z
  .object({
    ...lineageBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(LINEAGE_SCHEMA),
        artifactSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const backupBodyShape = {
  schemaVersion: z.literal(BACKUP_SCHEMA),
  backup: backupInputSchema,
};
const backupBodySchema = z.object(backupBodyShape).strict();
const backupArtifactSchema = z
  .object({
    ...backupBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(BACKUP_SCHEMA),
        artifactSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

type LineageBodyV1 = z.infer<typeof lineageBodySchema>;
type BackupBodyV1 = z.infer<typeof backupBodySchema>;
export type AccountingWarehousePriceBootstrapLineageEvidenceV1 = z.infer<
  typeof lineageArtifactSchema
>;
export type AccountingWarehousePriceBootstrapBackupEvidenceV1 = z.infer<
  typeof backupArtifactSchema
>;

export interface AccountingWarehousePriceBootstrapPreflightArtifactBytesV1 {
  stagingReleaseEvidenceBytes: string | Buffer;
  stagingReleaseVerificationBytes: string | Buffer;
  lineageEvidenceBytes: string | Buffer;
  backupEvidenceBytes: string | Buffer;
  sourceParityReportBytes: string | Buffer;
  planBytes: string | Buffer;
  approvalBytes: string | Buffer;
  authorizationBytes: string | Buffer;
  preflightBytes: string | Buffer;
}

export interface AccountingWarehousePriceBootstrapReceiptArtifactBytesV1 extends AccountingWarehousePriceBootstrapPreflightArtifactBytesV1 {
  beforeParityReportBytes: string | Buffer;
  afterParityReportBytes: string | Buffer;
  receiptBytes: string | Buffer;
}

function rawBytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, "utf8");
}

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function artifactSha256(
  schema: string,
  value: Record<string, unknown>,
): string {
  const integrity = value.integrity as Record<string, unknown>;
  return sha256Hex(
    `${schema}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...integrity, artifactSha256: null },
    })}`,
  );
}

export function createAccountingWarehousePriceBootstrapLineageEvidence(
  input: LineageBodyV1,
): AccountingWarehousePriceBootstrapLineageEvidenceV1 {
  const body = lineageBodySchema.parse(input);
  const candidate = lineageArtifactSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: LINEAGE_SCHEMA,
      artifactSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapLineageEvidence({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      artifactSha256: artifactSha256(LINEAGE_SCHEMA, candidate),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapLineageEvidence(
  value: unknown,
): AccountingWarehousePriceBootstrapLineageEvidenceV1 {
  const artifact = lineageArtifactSchema.parse(value);
  if (
    !safeEqualHex(
      artifact.integrity.artifactSha256,
      artifactSha256(LINEAGE_SCHEMA, artifact),
    )
  ) {
    throw new Error("Warehouse-price lineage evidence digest mismatch.");
  }
  return artifact;
}

export function canonicalAccountingWarehousePriceBootstrapLineageEvidenceJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapLineageEvidence(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapLineageEvidenceJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapLineageEvidenceV1 {
  const text = rawBytes(value).toString("utf8");
  const artifact = verifyAccountingWarehousePriceBootstrapLineageEvidence(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(artifact) !== text) {
    throw new Error("Warehouse-price lineage evidence is not canonical JSON.");
  }
  return artifact;
}

export function createAccountingWarehousePriceBootstrapBackupEvidence(
  input: BackupBodyV1,
): AccountingWarehousePriceBootstrapBackupEvidenceV1 {
  const body = backupBodySchema.parse(input);
  const candidate = backupArtifactSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: BACKUP_SCHEMA,
      artifactSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapBackupEvidence({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      artifactSha256: artifactSha256(BACKUP_SCHEMA, candidate),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapBackupEvidence(
  value: unknown,
): AccountingWarehousePriceBootstrapBackupEvidenceV1 {
  const artifact = backupArtifactSchema.parse(value);
  if (
    !safeEqualHex(
      artifact.integrity.artifactSha256,
      artifactSha256(BACKUP_SCHEMA, artifact),
    )
  ) {
    throw new Error("Warehouse-price backup evidence digest mismatch.");
  }
  return artifact;
}

export function canonicalAccountingWarehousePriceBootstrapBackupEvidenceJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapBackupEvidence(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapBackupEvidenceJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapBackupEvidenceV1 {
  const text = rawBytes(value).toString("utf8");
  const artifact = verifyAccountingWarehousePriceBootstrapBackupEvidence(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(artifact) !== text) {
    throw new Error("Warehouse-price backup evidence is not canonical JSON.");
  }
  return artifact;
}

function verifySidecarBinding(
  preflight: AccountingWarehousePriceBootstrapActivationPreflightV1,
  input: AccountingWarehousePriceBootstrapPreflightArtifactBytesV1,
): void {
  const lineageBytes = rawBytes(input.lineageEvidenceBytes);
  const backupBytes = rawBytes(input.backupEvidenceBytes);
  const releaseBytes = rawBytes(input.stagingReleaseEvidenceBytes);
  const releaseVerificationBytes = rawBytes(
    input.stagingReleaseVerificationBytes,
  );
  const releaseVerification = z
    .object({
      schemaVersion: z.literal(4),
      environmentId: z.literal("site-logbook-staging"),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
      decision: z.literal("PASS"),
      releaseEvidenceFileSha256: sha256Schema,
    })
    .passthrough()
    .parse(JSON.parse(releaseVerificationBytes.toString("utf8")));
  const lineage =
    verifyCanonicalAccountingWarehousePriceBootstrapLineageEvidenceJsonBytes(
      lineageBytes,
    );
  const backup =
    verifyCanonicalAccountingWarehousePriceBootstrapBackupEvidenceJsonBytes(
      backupBytes,
    );
  const { lineageEvidenceFileSha256: _lineageFileSha256, ...preflightLineage } =
    preflight.migrationLineage;
  const { backupEvidenceFileSha256: _backupFileSha256, ...preflightBackup } =
    preflight.backupEvidence;
  if (
    !safeEqualHex(
      preflight.migrationLineage.lineageEvidenceFileSha256,
      sha256Hex(lineageBytes),
    ) ||
    canonicalEvidenceJson(preflightLineage) !==
      canonicalEvidenceJson(lineage.lineage) ||
    !safeEqualHex(
      preflight.backupEvidence.backupEvidenceFileSha256,
      sha256Hex(backupBytes),
    ) ||
    canonicalEvidenceJson(preflightBackup) !==
      canonicalEvidenceJson(backup.backup) ||
    !safeEqualHex(
      preflight.stagingEvidence.releaseEvidenceFileSha256,
      sha256Hex(releaseBytes),
    ) ||
    !safeEqualHex(
      preflight.stagingEvidence.releaseVerificationFileSha256,
      sha256Hex(releaseVerificationBytes),
    ) ||
    releaseVerification.schemaVersion !==
      preflight.stagingEvidence.releaseVerificationSchemaVersion ||
    releaseVerification.decision !==
      preflight.stagingEvidence.releaseVerificationDecision ||
    releaseVerification.commitSha !== preflight.sourceSha ||
    releaseVerification.releaseEvidenceFileSha256 !== sha256Hex(releaseBytes)
  ) {
    throw new Error(
      "Warehouse-price activation sidecar evidence does not match the preflight.",
    );
  }
}

export function verifyAccountingWarehousePriceBootstrapPreflightArtifactSet(
  input: AccountingWarehousePriceBootstrapPreflightArtifactBytesV1,
): AccountingWarehousePriceBootstrapActivationPreflightV1 {
  const preflight =
    verifyAccountingWarehousePriceBootstrapActivationPreflightBinding({
      preflightBytes: input.preflightBytes,
      approvalBytes: input.approvalBytes,
      authorizationBytes: input.authorizationBytes,
      planBytes: input.planBytes,
      parityReportBytes: input.sourceParityReportBytes,
    });
  verifySidecarBinding(preflight, input);
  return preflight;
}

export function verifyAccountingWarehousePriceBootstrapReceiptArtifactSet(
  input: AccountingWarehousePriceBootstrapReceiptArtifactBytesV1,
): {
  preflight: AccountingWarehousePriceBootstrapActivationPreflightV1;
  receipt: AccountingWarehousePriceBootstrapExecutionReceiptV1;
} {
  const preflight =
    verifyAccountingWarehousePriceBootstrapPreflightArtifactSet(input);
  const receipt =
    verifyAccountingWarehousePriceBootstrapExecutionReceiptBinding({
      receiptBytes: input.receiptBytes,
      preflightBytes: input.preflightBytes,
      approvalBytes: input.approvalBytes,
      authorizationBytes: input.authorizationBytes,
      planBytes: input.planBytes,
      sourceParityReportBytes: input.sourceParityReportBytes,
      beforeParityReportBytes: input.beforeParityReportBytes,
      afterParityReportBytes: input.afterParityReportBytes,
    });
  return { preflight, receipt };
}

export function createAccountingWarehousePriceBootstrapOfflineVerificationSummary(
  input:
    | {
        mode: "preflight";
        preflight: AccountingWarehousePriceBootstrapActivationPreflightV1;
        preflightFileSha256: string;
      }
    | {
        mode: "receipt";
        preflight: AccountingWarehousePriceBootstrapActivationPreflightV1;
        preflightFileSha256: string;
        receipt: AccountingWarehousePriceBootstrapExecutionReceiptV1;
        receiptFileSha256: string;
      },
) {
  const preflight = input.preflight;
  const summary = {
    schemaVersion: VERIFICATION_SCHEMA,
    verified: true as const,
    mode: input.mode,
    sourceSha: preflight.sourceSha,
    logicalEnvironment: preflight.logicalEnvironment,
    targetFingerprint: preflight.targetFingerprint,
    productionTargetsTouched: false as const,
    candidateCount: preflight.executionBoundary.candidateCount,
    preflightSha256: preflight.integrity.preflightSha256,
    preflightFileSha256: sha256Schema.parse(input.preflightFileSha256),
    approvalSha256: preflight.artifacts.approvalSha256,
    migration: {
      tag: preflight.migrationLineage.plannedAccountingMigration.tag,
      sqlSha256:
        preflight.migrationLineage.plannedAccountingMigration.sqlSha256,
      lineageEvidenceFileSha256:
        preflight.migrationLineage.lineageEvidenceFileSha256,
      excludedMigrationTags: preflight.migrationLineage.excludedMigrationTags,
    },
    backup: {
      backupEvidenceId: preflight.backupEvidence.backupEvidenceId,
      backupEvidenceFileSha256:
        preflight.backupEvidence.backupEvidenceFileSha256,
      encryptedBackupSha256: preflight.backupEvidence.encryptedBackupSha256,
      sourceExecutionSha256: preflight.backupEvidence.sourceExecutionSha256,
    },
    receipt:
      input.mode === "receipt"
        ? {
            result: input.receipt.result,
            mode: input.receipt.execution.mode,
            receiptSha256: input.receipt.integrity.receiptSha256,
            receiptFileSha256: sha256Schema.parse(input.receiptFileSha256),
            beforeState: input.receipt.verification.beforeState,
            afterDecision: input.receipt.verification.afterDecision,
          }
        : null,
  };
  return Object.freeze(summary);
}

export function canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson(
  value: ReturnType<
    typeof createAccountingWarehousePriceBootstrapOfflineVerificationSummary
  >,
): string {
  return canonicalEvidenceJson(value);
}

export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES =
  Object.freeze({
    stagingReleaseEvidence: "staging-release-evidence.json",
    stagingReleaseVerification: "staging-release-verification.json",
    lineageEvidence: "warehouse-price-bootstrap-lineage-evidence.json",
    backupEvidence: "warehouse-price-bootstrap-backup-evidence.json",
    sourceParityReport: "warehouse-price-parity-source.json",
    plan: "warehouse-price-bootstrap-plan.json",
    approval: "warehouse-price-bootstrap-approval.json",
    authorization: "warehouse-price-bootstrap-apply-authorization.json",
    preflight: "warehouse-price-bootstrap-activation-preflight.json",
    beforeParityReport: "warehouse-price-parity-before.json",
    afterParityReport: "warehouse-price-parity-after.json",
    receipt: "warehouse-price-bootstrap-execution-receipt.json",
  } as const);
