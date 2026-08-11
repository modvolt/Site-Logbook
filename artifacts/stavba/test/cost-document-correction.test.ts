import { describe, expect, it } from "vitest";
import {
  buildReturnCostDocumentToReviewInput,
  normalizeCostDocumentCorrectionReason,
} from "../src/lib/cost-document-correction";

describe("cost-document correction input", () => {
  it("normalizes and binds the mandatory reason", () => {
    expect(
      buildReturnCostDocumentToReviewInput("  Chybně přiřazená zakázka  "),
    ).toEqual({
      status: "needs_review",
      reason: "Chybně přiřazená zakázka",
    });
  });

  it("rejects blank, too-short and oversized reasons", () => {
    expect(normalizeCostDocumentCorrectionReason("  ")).toBeNull();
    expect(normalizeCostDocumentCorrectionReason("ab")).toBeNull();
    expect(normalizeCostDocumentCorrectionReason("x".repeat(1_001))).toBeNull();
  });
});
