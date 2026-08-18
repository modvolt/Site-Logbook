import { z } from "zod/v4";

export type CostDocumentDispositionMode =
  | "early_discard"
  | "reviewed_rejection";

export type CostDocumentDispositionReasonCode =
  | "invalid_upload"
  | "not_a_document"
  | "duplicate_document"
  | "invalid_document";

export const CostDocumentDispositionInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("early_discard"),
      reasonCode: z.enum(["invalid_upload", "not_a_document"]),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      mode: z.literal("reviewed_rejection"),
      reasonCode: z.enum(["duplicate_document", "invalid_document"]),
      reason: z.string().min(3).max(1_000),
    })
    .strict(),
]);

export type CostDocumentDispositionInput = z.infer<
  typeof CostDocumentDispositionInputSchema
>;

export type CostDocumentDispositionFacts = {
  status: string;
  reviewedAtPresent: boolean;
  reviewedByPresent: boolean;
  aiExtractionPresent: boolean;
  documentTypeDecisionPresent: boolean;
  domainLinkPresent: boolean;
  mergeDecisionPresent: boolean;
  lineCount: number;
  referenceCount: number;
  accountingHeadPresent: boolean;
  warehousePriceHistoryPresent: boolean;
  invoicedLinePresent: boolean;
  sourceArtifactCount: number;
};

export type CostDocumentDispositionDecision =
  | { allowed: true; retentionClass: "operational-limited" | "accounting" }
  | { allowed: false; code: string; message: string };

function rejected(
  code: string,
  message: string,
): CostDocumentDispositionDecision {
  return { allowed: false, code, message };
}

export function evaluateCostDocumentDisposition(
  mode: CostDocumentDispositionMode,
  reasonCode: CostDocumentDispositionReasonCode,
  facts: CostDocumentDispositionFacts,
): CostDocumentDispositionDecision {
  if (facts.accountingHeadPresent) {
    return rejected(
      "accounting_head_present",
      "An existing accounting evidence head requires a later append-only correction flow.",
    );
  }
  if (facts.warehousePriceHistoryPresent || facts.invoicedLinePresent) {
    return rejected(
      "downstream_accounting_use",
      "A document already used by warehouse or billing cannot be discarded or rejected.",
    );
  }

  if (mode === "early_discard") {
    if (!new Set(["invalid_upload", "not_a_document"]).has(reasonCode)) {
      return rejected(
        "reason_mode_mismatch",
        "Early discard requires an operational upload reason code.",
      );
    }
    if (facts.status !== "uploaded") {
      return rejected(
        "not_early_upload",
        "Early discard is limited to an untouched uploaded document.",
      );
    }
    if (
      facts.reviewedAtPresent ||
      facts.reviewedByPresent ||
      facts.aiExtractionPresent ||
      facts.documentTypeDecisionPresent ||
      facts.domainLinkPresent ||
      facts.mergeDecisionPresent ||
      facts.lineCount !== 0 ||
      facts.referenceCount !== 0
    ) {
      return rejected(
        "review_boundary_crossed",
        "The document crossed the extraction, review or domain-link boundary and requires immutable reviewed-rejection evidence.",
      );
    }
    return { allowed: true, retentionClass: "operational-limited" };
  }

  if (!new Set(["duplicate_document", "invalid_document"]).has(reasonCode)) {
    return rejected(
      "reason_mode_mismatch",
      "Reviewed rejection requires a registered accounting reason code.",
    );
  }
  if (!new Set(["needs_review", "reviewed"]).has(facts.status)) {
    return rejected(
      "not_reviewable",
      "Reviewed rejection requires an open review-state document.",
    );
  }
  if (facts.sourceArtifactCount < 1) {
    return rejected(
      "source_artifact_missing",
      "Reviewed rejection requires at least one immutable source artifact.",
    );
  }
  return { allowed: true, retentionClass: "accounting" };
}
