import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  createAccountingVersionRelation,
  verifyAccountingCorrectionChainBinding,
  verifyAccountingLifecycleEventBinding,
  type AccountingLifecycleEventV1,
  type AccountingVersionRelationV1,
} from "./accounting-lifecycle-event-contract";
import {
  buildApprovedCostDocumentAccountingEvidence,
  type BuildApprovedCostDocumentAccountingEvidenceInput,
} from "./accounting-cost-document-approval-evidence";
import {
  deterministicAccountingUuid,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";
import {
  createAccountingReasonArtifact,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";

const FEATURE_FLAG = "ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED";
const REOPEN_DOMAIN = "site-logbook.cost-document-review-reopen/v1";
const REOPEN_REASON_DOMAIN =
  "site-logbook.cost-document-review-reopen-reason/v1";
const CORRECTION_DOMAIN = "site-logbook.cost-document-correction/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type CostDocumentReviewReopenEvidence = {
  event: AccountingLifecycleEventV1;
  reasonArtifact: AccountingReasonArtifactV1;
  normalizedReason: string;
  reasonDetailSha256: string;
  reopenEvidenceSha256: string;
};

export type CostDocumentCorrectionEvidence = {
  correctionVersion: AccountingDocumentVersionV1;
  targetVersion: AccountingDocumentVersionV1;
  relation: AccountingVersionRelationV1;
  event: AccountingLifecycleEventV1;
  correctionEvidenceSha256: string;
};

export function isAccountingCostDocumentCorrectionDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

export function normalizeCostDocumentCorrectionReason(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 3 || normalized.length > 1_000) {
    throw new Error(
      "Correction reason must contain between 3 and 1000 characters.",
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(
      "Correction reason contains unsupported control characters.",
    );
  }
  return normalized;
}

function assertCurrentIncomingVersion(
  version: AccountingDocumentVersionV1,
): void {
  if (
    version.aggregate.kind !== "incoming-cost-document" ||
    version.snapshot.kind !== "incoming-cost-document" ||
    !new Set(["approved", "correction"]).has(version.purpose)
  ) {
    throw new Error(
      "Cost-document correction requires a native approved or correction version.",
    );
  }
}

export function buildCostDocumentReviewReopenEvidence(input: {
  currentVersion: AccountingDocumentVersionV1;
  nextLifecycleSequence: bigint;
  previousLifecycleEventSha256: string;
  actor: { userId: number | null; name: string };
  reason: string;
  recordedAt: Date;
}): CostDocumentReviewReopenEvidence {
  assertCurrentIncomingVersion(input.currentVersion);
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Review-reopen actor user ID",
  );
  if (input.nextLifecycleSequence <= 0n) {
    throw new Error("Review-reopen lifecycle sequence must follow approval.");
  }
  if (!SHA256_PATTERN.test(input.previousLifecycleEventSha256)) {
    throw new Error("Previous lifecycle event digest is invalid.");
  }
  const normalizedReason = normalizeCostDocumentCorrectionReason(input.reason);
  const reasonDetailSha256 = sha256Hex(
    `${REOPEN_REASON_DOMAIN}\0${canonicalEvidenceJson({ reason: normalizedReason })}`,
  );
  const recordedAt = input.recordedAt.toISOString();
  const reopenEvidenceSha256 = sha256Hex(
    `${REOPEN_DOMAIN}\0${canonicalEvidenceJson({
      action: "review-reopened",
      actorUserId: actorId,
      aggregate: input.currentVersion.aggregate,
      currentVersionId: input.currentVersion.versionId,
      currentVersionSha256: input.currentVersion.integrity.versionSha256,
      reasonDetailSha256,
      recordedAt,
    })}`,
  );
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("cost-document-review-reopened", {
      versionId: input.currentVersion.versionId,
      sequence: String(input.nextLifecycleSequence),
      recordedAt,
      reopenEvidenceSha256,
    }),
    aggregate: {
      ...input.currentVersion.aggregate,
      versionId: input.currentVersion.versionId,
    },
    sequence: String(input.nextLifecycleSequence),
    previousEventSha256: input.previousLifecycleEventSha256,
    eventType: "review_reopened",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: "review_reopened",
    reasonDetailSha256,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: reopenEvidenceSha256,
  });
  verifyAccountingLifecycleEventBinding(event, input.currentVersion);
  const reasonArtifact = createAccountingReasonArtifact({
    artifactId: deterministicAccountingUuid(
      "cost-document-review-reopen-reason-artifact",
      {
        lifecycleEventId: event.eventId,
        reasonDetailSha256,
      },
    ),
    lifecycleEvent: event,
    reasonText: normalizedReason,
    digestDomain: REOPEN_REASON_DOMAIN,
  });
  return {
    event,
    reasonArtifact,
    normalizedReason,
    reasonDetailSha256,
    reopenEvidenceSha256,
  };
}

export function buildCorrectedCostDocumentAccountingEvidence(
  input: BuildApprovedCostDocumentAccountingEvidenceInput & {
    targetVersion: AccountingDocumentVersionV1;
    reopenEvent: AccountingLifecycleEventV1;
  },
): CostDocumentCorrectionEvidence {
  assertCurrentIncomingVersion(input.targetVersion);
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Correction-approval actor user ID",
  );
  const documentId = requiredPositiveAccountingId(
    input.document.id,
    "Cost document ID",
  );
  if (
    input.targetVersion.aggregate.id !== String(documentId) ||
    input.reopenEvent.eventType !== "review_reopened" ||
    input.reopenEvent.aggregate.kind !== "incoming-cost-document" ||
    input.reopenEvent.aggregate.id !== String(documentId) ||
    input.reopenEvent.aggregate.versionId !== input.targetVersion.versionId ||
    input.reopenEvent.reasonDetailSha256 === null
  ) {
    throw new Error(
      "Correction approval is not bound to the current review-reopen event.",
    );
  }
  verifyAccountingLifecycleEventBinding(input.reopenEvent, input.targetVersion);

  const approvedMaterial = buildApprovedCostDocumentAccountingEvidence(input);
  const { snapshot, artifacts } = approvedMaterial.version;
  const recordedAt = input.document.reviewedAt!.toISOString();
  const correctionEvidenceSha256 = sha256Hex(
    `${CORRECTION_DOMAIN}\0${canonicalEvidenceJson({
      action: "correction-approved",
      actorUserId: actorId,
      aggregate: input.targetVersion.aggregate,
      targetVersionId: input.targetVersion.versionId,
      targetVersionSha256: input.targetVersion.integrity.versionSha256,
      reopenEventId: input.reopenEvent.eventId,
      reopenEventSha256: input.reopenEvent.integrity.entrySha256,
      reasonDetailSha256: input.reopenEvent.reasonDetailSha256,
      recordedAt,
      snapshot,
      artifacts,
    })}`,
  );
  const correctionVersionId = deterministicAccountingUuid(
    "corrected-cost-document-version",
    {
      targetVersionId: input.targetVersion.versionId,
      recordedAt,
      correctionEvidenceSha256,
    },
  );
  const correctionVersion = createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: correctionVersionId,
    aggregate: input.targetVersion.aggregate,
    version: String(BigInt(input.targetVersion.version) + 1n),
    purpose: "correction",
    supersedesVersionId: input.targetVersion.versionId,
    historicalCompleteness: "complete",
    effectiveAt: recordedAt,
    recordedAt,
    snapshot,
    artifacts,
    provenance: {
      captureMode: "native",
      sourceMode: "human",
      recordedBy: { kind: "user", id: actorId, authentication: "session" },
      approvalEvidenceSha256: correctionEvidenceSha256,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "human",
        actorRef: `user:${actorId}`,
        sourceEvidenceSha256: correctionEvidenceSha256,
        extractionRunId: null,
        recordedAt,
      }),
    },
  });
  const relation = createAccountingVersionRelation({
    schemaVersion: "site-logbook.accounting-version-relation/v1",
    relationId: deterministicAccountingUuid("cost-document-supersedes", {
      sourceVersionId: correctionVersion.versionId,
      targetVersionId: input.targetVersion.versionId,
      reopenEventId: input.reopenEvent.eventId,
    }),
    relationType: "supersedes",
    source: {
      ...correctionVersion.aggregate,
      versionId: correctionVersion.versionId,
    },
    target: {
      ...input.targetVersion.aggregate,
      versionId: input.targetVersion.versionId,
    },
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: "correction_approved",
    reasonDetailSha256: input.reopenEvent.reasonDetailSha256,
    recordedAt,
    evidenceSha256: correctionEvidenceSha256,
  });
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("cost-document-correction-linked", {
      correctionVersionId,
      relationId: relation.relationId,
      sequence: String(BigInt(input.reopenEvent.sequence) + 1n),
    }),
    aggregate: {
      ...correctionVersion.aggregate,
      versionId: correctionVersion.versionId,
    },
    sequence: String(BigInt(input.reopenEvent.sequence) + 1n),
    previousEventSha256: input.reopenEvent.integrity.entrySha256,
    eventType: "correction_linked",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: "correction_approved",
    reasonDetailSha256: input.reopenEvent.reasonDetailSha256,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: correctionEvidenceSha256,
  });
  verifyAccountingCorrectionChainBinding(
    relation,
    event,
    correctionVersion,
    input.targetVersion,
  );
  return {
    correctionVersion,
    targetVersion: input.targetVersion,
    relation,
    event,
    correctionEvidenceSha256,
  };
}
