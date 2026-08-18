import { describe, expect, it } from "vitest";
import {
  CostDocumentDispositionInputSchema,
  evaluateCostDocumentDisposition,
  type CostDocumentDispositionFacts,
} from "../src/lib/cost-document-disposition-policy";

function facts(
  overrides: Partial<CostDocumentDispositionFacts> = {},
): CostDocumentDispositionFacts {
  return {
    status: "uploaded",
    reviewedAtPresent: false,
    reviewedByPresent: false,
    aiExtractionPresent: false,
    documentTypeDecisionPresent: false,
    domainLinkPresent: false,
    mergeDecisionPresent: false,
    lineCount: 0,
    referenceCount: 0,
    accountingHeadPresent: false,
    warehousePriceHistoryPresent: false,
    invoicedLinePresent: false,
    sourceArtifactCount: 1,
    ...overrides,
  };
}

describe("cost-document disposition boundary", () => {
  it("keeps early and reviewed request shapes mutually exclusive and strict", () => {
    expect(
      CostDocumentDispositionInputSchema.parse({
        mode: "early_discard",
        reasonCode: "not_a_document",
        confirmed: true,
      }),
    ).toMatchObject({ mode: "early_discard" });
    expect(
      CostDocumentDispositionInputSchema.parse({
        mode: "reviewed_rejection",
        reasonCode: "invalid_document",
        reason: "Doklad po kontrole neodpovídá účetnímu zdroji.",
      }),
    ).toMatchObject({ mode: "reviewed_rejection" });
    for (const invalid of [
      {
        mode: "early_discard",
        reasonCode: "not_a_document",
        confirmed: true,
        reason: "must not be accepted",
      },
      {
        mode: "reviewed_rejection",
        reasonCode: "invalid_document",
      },
      {
        mode: "reviewed_rejection",
        reasonCode: "invalid_upload",
        reason: "wrong reason class",
      },
    ]) {
      expect(
        CostDocumentDispositionInputSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it("allows only untouched uploads into retention-limited early discard", () => {
    expect(
      evaluateCostDocumentDisposition(
        "early_discard",
        "invalid_upload",
        facts(),
      ),
    ).toEqual({ allowed: true, retentionClass: "operational-limited" });

    for (const drift of [
      { status: "needs_review" },
      { reviewedAtPresent: true },
      { aiExtractionPresent: true },
      { documentTypeDecisionPresent: true },
      { domainLinkPresent: true },
      { mergeDecisionPresent: true },
      { lineCount: 1 },
      { referenceCount: 1 },
    ]) {
      expect(
        evaluateCostDocumentDisposition(
          "early_discard",
          "invalid_upload",
          facts(drift),
        ),
      ).toMatchObject({ allowed: false });
    }
  });

  it("routes reviewed sources to accounting retention and registered reasons", () => {
    expect(
      evaluateCostDocumentDisposition(
        "reviewed_rejection",
        "invalid_document",
        facts({ status: "needs_review", aiExtractionPresent: true }),
      ),
    ).toEqual({ allowed: true, retentionClass: "accounting" });
    expect(
      evaluateCostDocumentDisposition(
        "reviewed_rejection",
        "invalid_upload",
        facts({ status: "reviewed" }),
      ),
    ).toMatchObject({ allowed: false, code: "reason_mode_mismatch" });
    expect(
      evaluateCostDocumentDisposition(
        "reviewed_rejection",
        "duplicate_document",
        facts({ status: "needs_review", sourceArtifactCount: 0 }),
      ),
    ).toMatchObject({ allowed: false, code: "source_artifact_missing" });
  });

  it("blocks both modes after accounting or downstream use", () => {
    for (const drift of [
      { accountingHeadPresent: true },
      { warehousePriceHistoryPresent: true },
      { invoicedLinePresent: true },
    ]) {
      expect(
        evaluateCostDocumentDisposition(
          "reviewed_rejection",
          "invalid_document",
          facts({ status: "reviewed", ...drift }),
        ),
      ).toMatchObject({ allowed: false });
    }
  });
});
