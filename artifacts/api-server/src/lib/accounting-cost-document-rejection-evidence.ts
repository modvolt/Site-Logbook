import {
  buildCostDocumentAccountingSnapshotMaterial,
  type BuildApprovedCostDocumentAccountingEvidenceInput,
} from "./accounting-cost-document-approval-evidence";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  verifyAccountingLifecycleEventBinding,
  type AccountingLifecycleEventV1,
} from "./accounting-lifecycle-event-contract";
import {
  deterministicAccountingUuid,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import {
  accountingReasonTextSha256,
  createAccountingReasonArtifact,
  normalizeAccountingReasonText,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const FEATURE_FLAG = "ACCOUNTING_COST_DOCUMENT_REJECTION_DUAL_WRITE_ENABLED";
const REJECTION_DOMAIN =
  "site-logbook.cost-document-reviewed-rejection/v1" as const;
const REASON_DOMAIN =
  "site-logbook.cost-document-reviewed-rejection-reason/v1" as const;

export type ReviewedCostDocumentRejectionReasonCode =
  | "duplicate_document"
  | "invalid_document";

export type ReviewedCostDocumentRejectionEvidence = {
  version: AccountingDocumentVersionV1;
  event: AccountingLifecycleEventV1;
  reasonArtifact: AccountingReasonArtifactV1;
  rejectionEvidenceSha256: string;
};

export function isAccountingCostDocumentRejectionDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

export function buildReviewedCostDocumentRejectionEvidence(
  input: BuildApprovedCostDocumentAccountingEvidenceInput & {
    reasonCode: ReviewedCostDocumentRejectionReasonCode;
    reasonText: string;
    recordedAt: Date;
  },
): ReviewedCostDocumentRejectionEvidence {
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Rejecting actor user ID",
  );
  const documentId = requiredPositiveAccountingId(
    input.document.id,
    "Rejected cost-document ID",
  );
  const recordedAt = input.recordedAt.toISOString();
  const normalizedReason = normalizeAccountingReasonText(input.reasonText);
  const reasonDetailSha256 = accountingReasonTextSha256(
    REASON_DOMAIN,
    normalizedReason,
  );
  const { snapshot, artifacts } = buildCostDocumentAccountingSnapshotMaterial(
    input,
    {
      capturePolicy: "human-reviewed-rejection-state/v1",
      supplierNameRequired: false,
    },
  );
  const rejectionEvidenceSha256 = sha256Hex(
    `${REJECTION_DOMAIN}\0${canonicalEvidenceJson({
      action: "reviewed-rejection",
      actorUserId: actorId,
      aggregate: { kind: "incoming-cost-document", id: documentId },
      reasonCode: input.reasonCode,
      reasonDetailSha256,
      recordedAt,
      snapshot,
      artifacts,
    })}`,
  );
  const versionId = deterministicAccountingUuid(
    "reviewed-cost-document-rejection-version",
    {
      documentId,
      recordedAt,
      reasonCode: input.reasonCode,
      rejectionEvidenceSha256,
    },
  );
  const version = createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId,
    aggregate: { kind: "incoming-cost-document", id: documentId },
    version: "1",
    purpose: "discarded_observation",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    effectiveAt: recordedAt,
    recordedAt,
    snapshot,
    artifacts,
    provenance: {
      captureMode: "native-rejection",
      sourceMode: "human",
      recordedBy: { kind: "user", id: actorId, authentication: "session" },
      rejectionEvidenceSha256,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "human",
        actorRef: `user:${actorId}`,
        sourceEvidenceSha256: rejectionEvidenceSha256,
        extractionRunId: null,
        recordedAt,
      }),
    },
  });
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid(
      "reviewed-cost-document-rejection-event",
      {
        documentId,
        versionId,
        reasonCode: input.reasonCode,
        rejectionEvidenceSha256,
      },
    ),
    aggregate: {
      kind: "incoming-cost-document",
      id: documentId,
      versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "ignored",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: input.reasonCode,
    reasonDetailSha256,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: rejectionEvidenceSha256,
  });
  verifyAccountingLifecycleEventBinding(event, version);
  const reasonArtifact = createAccountingReasonArtifact({
    artifactId: deterministicAccountingUuid(
      "reviewed-cost-document-rejection-reason-artifact",
      { eventId: event.eventId, reasonDetailSha256 },
    ),
    lifecycleEvent: event,
    reasonText: normalizedReason,
    digestDomain: REASON_DOMAIN,
  });
  return { version, event, reasonArtifact, rejectionEvidenceSha256 };
}
