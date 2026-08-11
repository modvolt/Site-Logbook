import type { CostDocumentStatusInput } from "@workspace/api-client-react";

export const COST_DOCUMENT_CORRECTION_REASON_MIN_LENGTH = 3;
export const COST_DOCUMENT_CORRECTION_REASON_MAX_LENGTH = 1_000;

export function normalizeCostDocumentCorrectionReason(
  value: string,
): string | null {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < COST_DOCUMENT_CORRECTION_REASON_MIN_LENGTH ||
    normalized.length > COST_DOCUMENT_CORRECTION_REASON_MAX_LENGTH
  ) {
    return null;
  }
  return normalized;
}

export function buildReturnCostDocumentToReviewInput(
  reason: string,
): CostDocumentStatusInput | null {
  const normalizedReason = normalizeCostDocumentCorrectionReason(reason);
  return normalizedReason === null
    ? null
    : { status: "needs_review", reason: normalizedReason };
}
