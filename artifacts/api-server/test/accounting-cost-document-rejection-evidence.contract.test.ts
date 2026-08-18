import { describe, expect, it } from "vitest";
import type { BillingDocument, BillingDocumentFile } from "@workspace/db";
import {
  buildReviewedCostDocumentRejectionEvidence,
  isAccountingCostDocumentRejectionDualWriteEnabled,
} from "../src/lib/accounting-cost-document-rejection-evidence";
import { verifyAccountingLifecycleEventBinding } from "../src/lib/accounting-lifecycle-event-contract";
import { verifyAccountingReasonArtifactBinding } from "../src/lib/accounting-reason-artifact-contract";

const RECORDED_AT = new Date("2042-12-01T10:00:00.000Z");
const HASH = "a".repeat(64);

function document(): BillingDocument {
  return {
    id: 88,
    status: "needs_review",
    docType: "unknown",
    declaredDocType: null,
    detectedDocType: null,
    detectedDocTypeConfidence: null,
    docTypeSource: "unknown",
    docTypeConfirmedByUserId: null,
    docTypeConfirmedAt: null,
    source: "manual",
    sourceRef: null,
    objectPath: "/objects/cost/88.pdf",
    fileName: "unreadable.pdf",
    contentType: "application/pdf",
    fileSize: 2048,
    sha256: HASH,
    supplierName: null,
    supplierIc: null,
    supplierDic: null,
    supplierAddress: null,
    documentNumber: null,
    variableSymbol: null,
    issueDate: null,
    taxableSupplyDate: null,
    dueDate: null,
    currency: "CZK",
    subtotalWithoutVat: null,
    totalVat: null,
    totalWithVat: null,
    deliveryNoteNumber: null,
    summaryDeliveryNoteNumber: null,
    deliveryNumber: null,
    orderNumber: null,
    supplierOrderNumber: null,
    deliveryNoteResolution: "unknown",
    deliveryNoteResolutionReason: null,
    deliveryNoteResolutionByUserId: null,
    deliveryNoteResolutionAt: null,
    constantSymbol: null,
    specificSymbol: null,
    bankAccount: null,
    iban: null,
    bic: null,
    isdocUuid: null,
    mergeGroupId: null,
    uploadGroupToken: null,
    uploadCompletedAt: null,
    primaryDocumentId: null,
    sourcePriority: "manual",
    parsedBy: null,
    extractionVersion: 1,
    customerId: null,
    jobId: null,
    notes: null,
    warnings: "Unreadable source",
    aiRawJson: null,
    aiConfidence: null,
    aiModel: null,
    aiExtractedAt: null,
    createdByUserId: 7,
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: new Date("2042-12-01T09:00:00.000Z"),
    updatedAt: new Date("2042-12-01T09:00:00.000Z"),
  };
}

function file(): BillingDocumentFile {
  return {
    id: 1,
    documentId: 88,
    role: "primary",
    originalFileName: "unreadable.pdf",
    mimeType: "application/pdf",
    objectPath: "/objects/cost/88.pdf",
    sha256Hash: HASH,
    pageIndex: null,
    sizeBytes: 2048,
    createdAt: RECORDED_AT,
  };
}

describe("reviewed cost-document rejection evidence", () => {
  it("is default-dark and builds a complete observation of an incomplete source", () => {
    expect(isAccountingCostDocumentRejectionDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingCostDocumentRejectionDualWriteEnabled({
        ACCOUNTING_COST_DOCUMENT_REJECTION_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);

    const evidence = buildReviewedCostDocumentRejectionEvidence({
      document: document(),
      lines: [],
      files: [file()],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
      reasonCode: "invalid_document",
      reasonText: "Soubor je nečitelný a nelze jej účetně posoudit",
      recordedAt: RECORDED_AT,
    });
    expect(evidence.version).toMatchObject({
      version: "1",
      purpose: "discarded_observation",
      historicalCompleteness: "complete",
      snapshot: {
        kind: "incoming-cost-document",
        document: { documentType: "unknown" },
        supplier: { name: null },
        lines: [],
        sourceTrace: {
          capturePolicy: "human-reviewed-rejection-state/v1",
        },
      },
      provenance: {
        captureMode: "native-rejection",
        rejectionEvidenceSha256: evidence.rejectionEvidenceSha256,
      },
    });
    expect(evidence.event).toMatchObject({
      eventType: "ignored",
      reasonCode: "invalid_document",
      reasonDetailSha256: evidence.reasonArtifact.reason.textSha256,
    });
    expect(
      verifyAccountingLifecycleEventBinding(evidence.event, evidence.version),
    ).toBeDefined();
    expect(
      verifyAccountingReasonArtifactBinding(
        evidence.reasonArtifact,
        evidence.event,
      ),
    ).toEqual(evidence.reasonArtifact);
  });

  it("rejects missing source evidence and secret-bearing reasons", () => {
    const base = {
      document: document(),
      lines: [],
      references: [],
      latestCompletedExtractionJobId: null,
      actor: { userId: 7, name: "Reviewer" },
      reasonCode: "invalid_document" as const,
      recordedAt: RECORDED_AT,
    };
    expect(() =>
      buildReviewedCostDocumentRejectionEvidence({
        ...base,
        files: [],
        reasonText: "Neplatný doklad",
      }),
    ).toThrow(/source file/i);
    expect(() =>
      buildReviewedCostDocumentRejectionEvidence({
        ...base,
        files: [file()],
        reasonText: `ghp_${"A".repeat(32)}`,
      }),
    ).toThrow(/secret/i);
  });
});
