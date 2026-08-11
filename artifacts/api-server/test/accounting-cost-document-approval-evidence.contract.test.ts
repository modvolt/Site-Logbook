import { describe, expect, it } from "vitest";
import type {
  BillingDocument,
  BillingDocumentFile,
  BillingDocumentLine,
  BillingDocumentReference,
} from "@workspace/db";
import {
  buildApprovedCostDocumentAccountingEvidence,
  isAccountingApproveDocumentDualWriteEnabled,
} from "../src/lib/accounting-cost-document-approval-evidence";
import {
  buildCorrectedCostDocumentAccountingEvidence,
  buildCostDocumentReviewReopenEvidence,
  isAccountingCostDocumentCorrectionDualWriteEnabled,
  normalizeCostDocumentCorrectionReason,
} from "../src/lib/accounting-cost-document-correction-evidence";
import {
  canonicalAccountingDocumentVersionJson,
  verifyAccountingDocumentVersion,
} from "../src/lib/accounting-document-version-contract";
import {
  canonicalAccountingLifecycleEntryJson,
  verifyAccountingCorrectionChainBinding,
  verifyAccountingLifecycleEventBinding,
} from "../src/lib/accounting-lifecycle-event-contract";

const APPROVED_AT = new Date("2042-05-06T12:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function document(overrides: Partial<BillingDocument> = {}): BillingDocument {
  return {
    id: 88,
    status: "approved",
    docType: "invoice",
    declaredDocType: "invoice",
    detectedDocType: null,
    detectedDocTypeConfidence: null,
    docTypeSource: "user",
    docTypeConfirmedByUserId: 7,
    docTypeConfirmedAt: new Date("2042-05-06T11:00:00.000Z"),
    source: "manual",
    sourceRef: null,
    objectPath: "/objects/cost/88.pdf",
    fileName: "invoice.pdf",
    contentType: "application/pdf",
    fileSize: 2048,
    sha256: HASH_A,
    supplierName: "Supplier s.r.o.",
    supplierIc: "12345678",
    supplierDic: "CZ12345678",
    supplierAddress: "Dlouhá 1, Praha",
    documentNumber: "PF-2042-88",
    variableSymbol: "204288",
    issueDate: "2042-05-01",
    taxableSupplyDate: "2042-05-01",
    dueDate: "2042-05-15",
    currency: "CZK",
    subtotalWithoutVat: "100.00",
    totalVat: "21.00",
    totalWithVat: "121.00",
    deliveryNoteNumber: null,
    summaryDeliveryNoteNumber: null,
    deliveryNumber: null,
    orderNumber: null,
    supplierOrderNumber: null,
    deliveryNoteResolution: "not_required",
    deliveryNoteResolutionReason: "Dodavatel dodací list nevystavuje",
    deliveryNoteResolutionByUserId: 7,
    deliveryNoteResolutionAt: APPROVED_AT,
    constantSymbol: null,
    specificSymbol: null,
    bankAccount: "123456789/0100",
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
    notes: "Human-confirmed final state",
    warnings: null,
    aiRawJson: null,
    aiConfidence: null,
    aiModel: null,
    aiExtractedAt: null,
    createdByUserId: 7,
    reviewedByUserId: 7,
    reviewedAt: APPROVED_AT,
    createdAt: new Date("2042-05-01T08:00:00.000Z"),
    updatedAt: APPROVED_AT,
    ...overrides,
  };
}

function line(
  overrides: Partial<BillingDocumentLine> = {},
): BillingDocumentLine {
  return {
    id: 501,
    documentId: 88,
    parentLineId: null,
    lineType: "material",
    description: "Kabel",
    quantity: "10.00",
    unit: "m",
    originalUnit: "10m",
    unitPriceWithoutVat: "10.00",
    vatRate: "21.00",
    vatMode: "standard",
    totalWithoutVat: "100.00",
    totalVat: "21.00",
    totalWithVat: "121.00",
    supplierSku: "KABEL-1",
    ean: null,
    manufacturer: null,
    discountPercent: null,
    listPriceWithoutVat: null,
    priceBeforeDiscount: null,
    priceAfterDiscount: null,
    priceBaseQuantity: null,
    priceBaseUnit: null,
    feeType: null,
    isEnvironmentalFee: 0,
    environmentalFee: null,
    recyclingFee: null,
    relatedLineId: null,
    deliveryNoteNumber: null,
    orderNumber: null,
    supplierOrderNumber: null,
    sourceLineNumber: "1",
    confidence: null,
    jobId: null,
    activityId: null,
    allocationType: "internal",
    matchConfidence: null,
    matchConfirmed: 1,
    approved: 0,
    warehouseState: null,
    invoicedInvoiceId: null,
    sortOrder: 0,
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
    ...overrides,
  };
}

function file(
  id: number,
  role: string,
  hash: string,
  overrides: Partial<BillingDocumentFile> = {},
): BillingDocumentFile {
  return {
    id,
    documentId: 88,
    role,
    originalFileName:
      role === "structured_isdoc" ? "invoice.isdoc" : "invoice.pdf",
    mimeType:
      role === "structured_isdoc" ? "application/xml" : "application/pdf",
    objectPath: `/objects/cost/88-${id}`,
    sha256Hash: hash,
    pageIndex: null,
    sizeBytes: 2048 + id,
    createdAt: APPROVED_AT,
    ...overrides,
  };
}

function reference(
  id: number,
  type: string,
  number: string,
  overrides: Partial<BillingDocumentReference> = {},
): BillingDocumentReference {
  return {
    id,
    documentId: 88,
    referenceType: type,
    referenceNumber: number,
    source: "manual",
    confidence: null,
    matchedJobId: null,
    matchedDocumentId: null,
    matchedAttachmentId: null,
    matchConfidence: null,
    matchConfirmed: 1,
    rejected: 0,
    notes: null,
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
    ...overrides,
  };
}

function input() {
  return {
    document: document(),
    lines: [line()],
    files: [file(2, "structured_isdoc", HASH_B), file(1, "primary", HASH_A)],
    references: [
      reference(2, "order", "OBJ-2", { matchedJobId: 9 }),
      reference(1, "delivery_note", "DL-1", {
        matchedDocumentId: 33,
        matchedAttachmentId: 44,
      }),
    ],
    latestCompletedExtractionJobId: null,
    actor: { userId: 7, name: "Reviewer" },
  };
}

describe("approved cost-document accounting evidence", () => {
  it("keeps the cutover gate exact and dark by default", () => {
    expect(isAccountingApproveDocumentDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingApproveDocumentDualWriteEnabled({
        ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED: " true ",
      }),
    ).toBe(false);
    expect(
      isAccountingApproveDocumentDualWriteEnabled({
        ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("builds deterministic approved version, event, sources and field provenance", () => {
    const first = buildApprovedCostDocumentAccountingEvidence(input());
    const second = buildApprovedCostDocumentAccountingEvidence(input());
    expect(second).toEqual(first);
    expect(() => verifyAccountingDocumentVersion(first.version)).not.toThrow();
    expect(() =>
      verifyAccountingLifecycleEventBinding(first.event, first.version),
    ).not.toThrow();
    expect(first.event).toMatchObject({
      eventType: "approved",
      reasonCode: "document_approved",
      evidenceSha256: first.approvalEvidenceSha256,
    });
    expect(first.version.snapshot).toMatchObject({
      kind: "incoming-cost-document",
      document: { id: "88", source: "manual", sourceRefSha256: null },
      sourceTrace: {
        capturePolicy: "human-approved-final-state/v1",
        originalSource: "manual",
        documentTypeSource: "user",
        aiEvidence: null,
      },
    });
    if (first.version.snapshot.kind !== "incoming-cost-document") {
      throw new Error("Expected incoming cost-document snapshot.");
    }
    expect(first.version.snapshot.fileRefs).toEqual(
      [...first.version.snapshot.fileRefs].sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
      ),
    );
    expect(first.version.snapshot.references[0]?.matchedEntityRef).toBe(
      "attachment:44|document:33",
    );
    expect(first.version.provenance.captureMode).toBe("native");
    if (first.version.provenance.captureMode !== "native") {
      throw new Error("Expected native provenance.");
    }
    expect(first.version.provenance.sourceMode).toBe("human");
    expect(
      first.version.provenance.fieldProvenance.every(
        (entry) => entry.source === "human",
      ),
    ).toBe(true);
  });

  it("hashes AI/import metadata without persisting raw source or model payload", () => {
    const raw = '{"supplier":"secret payload"}';
    const sourceRef = "mailbox-message-id-123";
    const aiInput = input();
    aiInput.document = document({
      source: "isdoc",
      sourceRef,
      parsedBy: "isdoc",
      docTypeSource: "ai",
      aiRawJson: raw,
      aiConfidence: "0.87",
      aiModel: "gpt-evidence-model",
      aiExtractedAt: new Date("2042-05-06T10:00:00.000Z"),
    });
    aiInput.latestCompletedExtractionJobId = 19;
    const evidence = buildApprovedCostDocumentAccountingEvidence(aiInput);
    if (evidence.version.snapshot.kind !== "incoming-cost-document") {
      throw new Error("Expected incoming cost-document snapshot.");
    }
    expect(evidence.version.snapshot.sourceTrace.aiEvidence).toMatchObject({
      extractionRunId: "19",
      model: "gpt-evidence-model",
      confidence: "0.87",
    });
    const canonical = canonicalAccountingDocumentVersionJson(evidence.version);
    expect(canonical).not.toContain(raw);
    expect(canonical).not.toContain(sourceRef);
    expect(evidence.version.snapshot.document.sourceRefSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      evidence.version.snapshot.sourceTrace.aiEvidence?.rawResponseSha256,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on missing identity, source file and incomplete AI provenance", () => {
    expect(() =>
      buildApprovedCostDocumentAccountingEvidence({
        ...input(),
        actor: { userId: null, name: "Unknown" },
      }),
    ).toThrow(/actor user ID is required/i);
    expect(() =>
      buildApprovedCostDocumentAccountingEvidence({ ...input(), files: [] }),
    ).toThrow(/source file/i);
    const incompleteAi = input();
    incompleteAi.document = document({
      docTypeSource: "ai",
      aiRawJson: "{}",
      aiModel: "model",
      aiExtractedAt: APPROVED_AT,
    });
    expect(() =>
      buildApprovedCostDocumentAccountingEvidence(incompleteAi),
    ).toThrow(/AI provenance metadata is incomplete/i);
    expect(() =>
      buildApprovedCostDocumentAccountingEvidence({
        ...input(),
        document: document({ docTypeConfirmedAt: null }),
      }),
    ).toThrow(/confirmation actor and time/i);
  });
});

describe("cost-document review reopen and correction evidence", () => {
  it("keeps the correction cutover exact and dark by default", () => {
    expect(isAccountingCostDocumentCorrectionDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingCostDocumentCorrectionDualWriteEnabled({
        ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED: " true ",
      }),
    ).toBe(false);
    expect(
      isAccountingCostDocumentCorrectionDualWriteEnabled({
        ACCOUNTING_COST_DOCUMENT_CORRECTION_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("builds a deterministic reopen event and stores only the reason digest", () => {
    const initial = buildApprovedCostDocumentAccountingEvidence(input());
    const reason = "  Chybně přiřazená zakázka  ";
    const first = buildCostDocumentReviewReopenEvidence({
      currentVersion: initial.version,
      nextLifecycleSequence: 1n,
      previousLifecycleEventSha256: initial.event.integrity.entrySha256,
      actor: { userId: 7, name: "Reviewer" },
      reason,
      recordedAt: new Date("2042-05-07T09:00:00.000Z"),
    });
    const second = buildCostDocumentReviewReopenEvidence({
      currentVersion: initial.version,
      nextLifecycleSequence: 1n,
      previousLifecycleEventSha256: initial.event.integrity.entrySha256,
      actor: { userId: 7, name: "Reviewer" },
      reason,
      recordedAt: new Date("2042-05-07T09:00:00.000Z"),
    });
    expect(second).toEqual(first);
    expect(first.normalizedReason).toBe("Chybně přiřazená zakázka");
    expect(first.event).toMatchObject({
      eventType: "review_reopened",
      reasonCode: "review_reopened",
      sequence: "1",
      previousEventSha256: initial.event.integrity.entrySha256,
      reasonDetailSha256: first.reasonDetailSha256,
    });
    expect(() =>
      verifyAccountingLifecycleEventBinding(first.event, initial.version),
    ).not.toThrow();
    expect(canonicalAccountingLifecycleEntryJson(first.event)).not.toContain(
      first.normalizedReason,
    );
  });

  it("creates version N+1 with an atomic supersedes relation and correction event", () => {
    const initialInput = input();
    const initial = buildApprovedCostDocumentAccountingEvidence(initialInput);
    const reopen = buildCostDocumentReviewReopenEvidence({
      currentVersion: initial.version,
      nextLifecycleSequence: 1n,
      previousLifecycleEventSha256: initial.event.integrity.entrySha256,
      actor: { userId: 7, name: "Reviewer" },
      reason: "Oprava nesprávné zakázky",
      recordedAt: new Date("2042-05-07T09:00:00.000Z"),
    });
    const correctedInput = input();
    correctedInput.document = document({
      notes: "Opravené přiřazení",
      reviewedAt: new Date("2042-05-08T10:00:00.000Z"),
      updatedAt: new Date("2042-05-08T10:00:00.000Z"),
    });
    const correction = buildCorrectedCostDocumentAccountingEvidence({
      ...correctedInput,
      targetVersion: initial.version,
      reopenEvent: reopen.event,
    });
    expect(correction.correctionVersion).toMatchObject({
      version: "2",
      purpose: "correction",
      supersedesVersionId: initial.version.versionId,
    });
    expect(correction.relation).toMatchObject({
      relationType: "supersedes",
      reasonCode: "correction_approved",
      reasonDetailSha256: reopen.reasonDetailSha256,
    });
    expect(correction.event).toMatchObject({
      eventType: "correction_linked",
      sequence: "2",
      previousEventSha256: reopen.event.integrity.entrySha256,
      reasonDetailSha256: reopen.reasonDetailSha256,
    });
    expect(() =>
      verifyAccountingCorrectionChainBinding(
        correction.relation,
        correction.event,
        correction.correctionVersion,
        initial.version,
      ),
    ).not.toThrow();
  });

  it("rejects blank, oversized and control-character reasons", () => {
    expect(() => normalizeCostDocumentCorrectionReason("  ")).toThrow(
      /between 3 and 1000/i,
    );
    expect(() =>
      normalizeCostDocumentCorrectionReason("x".repeat(1001)),
    ).toThrow(/between 3 and 1000/i);
    expect(() =>
      normalizeCostDocumentCorrectionReason("bad\u0000reason"),
    ).toThrow(/control characters/i);
  });
});
