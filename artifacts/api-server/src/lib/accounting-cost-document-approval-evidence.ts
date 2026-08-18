import type {
  BillingDocument,
  BillingDocumentFile,
  BillingDocumentLine,
  BillingDocumentReference,
} from "@workspace/db";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
  type AccountingSnapshotV1,
} from "./accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  type AccountingLifecycleEventV1,
} from "./accounting-lifecycle-event-contract";
import {
  accountingObjectLocationSha256,
  canonicalAccountingDecimal,
  canonicalAccountingSort,
  deterministicAccountingUuid,
  positiveAccountingId,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const FEATURE_FLAG = "ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED";
const APPROVAL_DOMAIN = "site-logbook.cost-document-approval/v1";
const SOURCE_REF_DOMAIN = "site-logbook.accounting-source-ref/v1";
const AI_RESPONSE_DOMAIN = "site-logbook.accounting-ai-response/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/;

type CostSnapshot = Extract<
  AccountingSnapshotV1,
  { kind: "incoming-cost-document" }
>;
type CostDocumentType = CostSnapshot["document"]["documentType"];
type CostDocumentSource = CostSnapshot["document"]["source"];
type CostLine = CostSnapshot["lines"][number];
type CostReference = CostSnapshot["references"][number];
type CostFileRef = CostSnapshot["fileRefs"][number];
type CostArtifact = AccountingDocumentVersionV1["artifacts"][number];

const DOCUMENT_TYPES = new Set<CostDocumentType>([
  "unknown",
  "receipt",
  "delivery_note",
  "invoice",
  "credit_note",
]);
const DOCUMENT_SOURCES = new Set<CostDocumentSource>([
  "manual",
  "job_attachment",
  "isdoc",
  "email",
]);
const DOCUMENT_TYPE_SOURCES = new Set<
  CostSnapshot["sourceTrace"]["documentTypeSource"]
>(["admin", "user", "ai", "unknown"]);
const LINE_TYPES = new Set<CostLine["lineType"]>([
  "material",
  "work",
  "transport",
  "other",
]);
const VAT_MODES = new Set<CostLine["vatMode"]>([
  "standard",
  "reverse_charge",
  "zero",
  "non_vat",
]);
const ALLOCATION_TYPES = new Set<CostLine["allocationType"]>([
  "rebill",
  "internal",
  "stock",
  "not_rebilled",
]);
const FILE_ROLES = new Set<CostFileRef["role"]>([
  "primary",
  "visual_pdf",
  "structured_isdoc",
  "attachment",
  "original_email_attachment",
]);
const REFERENCE_TYPES = new Set<CostReference["referenceType"]>([
  "delivery_note",
  "summary_delivery_note",
  "delivery",
  "order",
  "supplier_order",
  "project",
  "invoice",
  "credit_note",
  "other",
]);
const REFERENCE_SOURCES = new Set<CostReference["source"]>([
  "isdoc",
  "pdf_text",
  "ai",
  "manual",
  "supplier_profile",
  "automatic_match",
]);
const DELIVERY_NOTE_RESOLUTIONS = new Set<
  CostSnapshot["document"]["deliveryNoteResolution"]
>(["unknown", "required", "not_required", "waived"]);

export type CostDocumentApprovalActor = {
  userId: number | null;
  name: string;
};

export type BuildApprovedCostDocumentAccountingEvidenceInput = {
  document: BillingDocument;
  lines: BillingDocumentLine[];
  files: BillingDocumentFile[];
  references: BillingDocumentReference[];
  latestCompletedExtractionJobId: number | null;
  actor: CostDocumentApprovalActor;
};

export type ApprovedCostDocumentAccountingEvidence = {
  version: AccountingDocumentVersionV1;
  event: AccountingLifecycleEventV1;
  approvalEvidenceSha256: string;
};

export function isAccountingApproveDocumentDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

function optionalText(value: string | null): string | null {
  if (value === null) return null;
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(
      "Accounting evidence text must be non-empty and free of surrounding whitespace.",
    );
  }
  return value;
}

function requiredText(value: string | null, label: string): string {
  const normalized = optionalText(value);
  if (normalized === null) throw new Error(`${label} is required.`);
  return normalized;
}

function member<T extends string>(
  value: string,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (!allowed.has(value as T))
    throw new Error(`Unsupported ${label}: ${value}`);
  return value as T;
}

function nullableDecimal(value: string | null): string | null {
  return value === null ? null : canonicalAccountingDecimal(value);
}

function matchedEntityRef(reference: BillingDocumentReference): string | null {
  const refs = [
    reference.matchedAttachmentId === null
      ? null
      : `attachment:${requiredPositiveAccountingId(reference.matchedAttachmentId, "Matched attachment ID")}`,
    reference.matchedDocumentId === null
      ? null
      : `document:${requiredPositiveAccountingId(reference.matchedDocumentId, "Matched document ID")}`,
    reference.matchedJobId === null
      ? null
      : `job:${requiredPositiveAccountingId(reference.matchedJobId, "Matched job ID")}`,
  ].filter((value): value is string => value !== null);
  return refs.length ? refs.sort().join("|") : null;
}

function buildArtifacts(files: BillingDocumentFile[]): {
  artifacts: CostArtifact[];
  fileRefs: CostFileRef[];
} {
  if (files.length === 0) {
    throw new Error("Approved cost-document evidence requires a source file.");
  }
  const rows = files.map((file) => {
    const fileId = requiredPositiveAccountingId(file.id, "Document file ID");
    const role = member(file.role, FILE_ROLES, "document file role");
    const contentSha256 = requiredText(
      file.sha256Hash,
      "Document file SHA-256",
    );
    if (!SHA256_PATTERN.test(contentSha256)) {
      throw new Error("Document file SHA-256 is invalid.");
    }
    const objectPath = requiredText(
      file.objectPath,
      "Document file object path",
    );
    const mediaType = requiredText(
      file.mimeType,
      "Document file media type",
    ).toLowerCase();
    if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
      throw new Error("Document file media type is invalid.");
    }
    if (!Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes ?? 0) <= 0) {
      throw new Error("Document file size must be a positive safe integer.");
    }
    if (
      file.pageIndex !== null &&
      (!Number.isSafeInteger(file.pageIndex) || file.pageIndex < 0)
    ) {
      throw new Error(
        "Document file page index must be a non-negative safe integer.",
      );
    }
    const objectLocationSha256 = accountingObjectLocationSha256(objectPath);
    const artifactId = deterministicAccountingUuid("cost-document-source", {
      fileId,
      contentSha256,
      objectLocationSha256,
      role,
    });
    return {
      artifact: {
        artifactId,
        role:
          role === "structured_isdoc" ? "structured-isdoc" : "original-source",
        mediaType,
        contentSha256,
        sizeBytes: String(file.sizeBytes),
        objectLocationSha256,
        rendererVersion: null,
      } satisfies CostArtifact,
      fileRef: {
        artifactId,
        role,
        pageIndex: file.pageIndex,
      } satisfies CostFileRef,
    };
  });
  return {
    artifacts: canonicalAccountingSort(rows.map((row) => row.artifact)),
    fileRefs: canonicalAccountingSort(rows.map((row) => row.fileRef)),
  };
}

function buildSourceTrace(
  document: BillingDocument,
  latestCompletedExtractionJobId: number | null,
  capturePolicy:
    | "human-approved-final-state/v1"
    | "human-reviewed-rejection-state/v1" = "human-approved-final-state/v1",
): CostSnapshot["sourceTrace"] {
  const confirmationActor = positiveAccountingId(
    document.docTypeConfirmedByUserId,
    "Document-type confirmation actor ID",
  );
  const confirmationTime = document.docTypeConfirmedAt?.toISOString() ?? null;
  if ((confirmationActor === null) !== (confirmationTime === null)) {
    throw new Error("Document-type confirmation actor and time must coexist.");
  }
  const hasAiPayload = document.aiRawJson !== null;
  const hasAiMetadata =
    hasAiPayload ||
    document.aiConfidence !== null ||
    document.aiModel !== null ||
    document.aiExtractedAt !== null;
  if (
    hasAiMetadata &&
    (!hasAiPayload ||
      optionalText(document.aiModel) === null ||
      document.aiExtractedAt === null ||
      latestCompletedExtractionJobId === null)
  ) {
    throw new Error("AI provenance metadata is incomplete.");
  }
  if (document.docTypeSource === "ai" && !hasAiMetadata) {
    throw new Error("AI document-type provenance requires AI evidence.");
  }
  if (
    !Number.isSafeInteger(document.extractionVersion) ||
    document.extractionVersion <= 0
  ) {
    throw new Error("Extraction version must be a positive safe integer.");
  }
  return {
    capturePolicy,
    originalSource: member(
      document.source,
      DOCUMENT_SOURCES,
      "document source",
    ),
    parsedBy: optionalText(document.parsedBy),
    extractionVersion: document.extractionVersion,
    documentTypeSource: member(
      document.docTypeSource,
      DOCUMENT_TYPE_SOURCES,
      "document-type source",
    ),
    documentTypeConfirmedByUserId: confirmationActor,
    documentTypeConfirmedAt: confirmationTime,
    aiEvidence: hasAiMetadata
      ? {
          extractionRunId: requiredPositiveAccountingId(
            latestCompletedExtractionJobId,
            "Completed extraction job ID",
          ),
          rawResponseSha256: sha256Hex(
            `${AI_RESPONSE_DOMAIN}\0${document.aiRawJson!}`,
          ),
          model: requiredText(document.aiModel, "AI model"),
          confidence: nullableDecimal(document.aiConfidence),
          extractedAt: document.aiExtractedAt!.toISOString(),
        }
      : null,
  };
}

export function buildCostDocumentAccountingSnapshotMaterial(
  input: BuildApprovedCostDocumentAccountingEvidenceInput,
  options: {
    capturePolicy:
      | "human-approved-final-state/v1"
      | "human-reviewed-rejection-state/v1";
    supplierNameRequired: boolean;
  },
): { snapshot: CostSnapshot; artifacts: CostArtifact[] } {
  const documentId = requiredPositiveAccountingId(
    input.document.id,
    "Cost document ID",
  );
  const { artifacts, fileRefs } = buildArtifacts(input.files);
  const source = member(
    input.document.source,
    DOCUMENT_SOURCES,
    "document source",
  );
  const sourceRefSha256 =
    source === "manual"
      ? null
      : sha256Hex(
          `${SOURCE_REF_DOMAIN}\0${requiredText(input.document.sourceRef, "Imported document source reference")}`,
        );
  const sortedLines = [...input.lines].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id - right.id,
  );
  const snapshot: CostSnapshot = {
    kind: "incoming-cost-document",
    document: {
      id: documentId,
      documentType: member(
        input.document.docType,
        DOCUMENT_TYPES,
        "document type",
      ),
      source,
      sourceRefSha256,
      documentNumber: optionalText(input.document.documentNumber),
      issueDate: input.document.issueDate,
      taxableSupplyDate: input.document.taxableSupplyDate,
      dueDate: input.document.dueDate,
      currency: input.document.currency,
      variableSymbol: optionalText(input.document.variableSymbol),
      constantSymbol: optionalText(input.document.constantSymbol),
      specificSymbol: optionalText(input.document.specificSymbol),
      bankAccount: optionalText(input.document.bankAccount),
      iban: optionalText(input.document.iban),
      bic: optionalText(input.document.bic),
      deliveryNoteResolution: member(
        input.document.deliveryNoteResolution,
        DELIVERY_NOTE_RESOLUTIONS,
        "delivery-note resolution",
      ),
      deliveryNoteResolutionReason: optionalText(
        input.document.deliveryNoteResolutionReason,
      ),
      customerId: positiveAccountingId(
        input.document.customerId,
        "Customer ID",
      ),
      jobId: positiveAccountingId(input.document.jobId, "Job ID"),
      notes: optionalText(input.document.notes),
    },
    supplier: {
      name: options.supplierNameRequired
        ? requiredText(input.document.supplierName, "Supplier name")
        : optionalText(input.document.supplierName),
      ic: optionalText(input.document.supplierIc),
      dic: optionalText(input.document.supplierDic),
      address: optionalText(input.document.supplierAddress),
      email: null,
      phone: null,
    },
    lines: sortedLines.map((line, index) => ({
      position: index + 1,
      sourceLineId: positiveAccountingId(line.id, "Cost-document line ID"),
      lineType: member(line.lineType, LINE_TYPES, "cost-document line type"),
      description: requiredText(
        line.description,
        "Cost-document line description",
      ),
      quantity: canonicalAccountingDecimal(line.quantity),
      unit: optionalText(line.unit),
      originalUnit: optionalText(line.originalUnit),
      unitPriceWithoutVat: canonicalAccountingDecimal(line.unitPriceWithoutVat),
      vatRate: nullableDecimal(line.vatRate),
      vatMode: member(line.vatMode, VAT_MODES, "cost-document VAT mode"),
      totalWithoutVat: canonicalAccountingDecimal(line.totalWithoutVat),
      totalVat: canonicalAccountingDecimal(line.totalVat),
      totalWithVat: canonicalAccountingDecimal(line.totalWithVat),
      supplierSku: optionalText(line.supplierSku),
      ean: optionalText(line.ean),
      manufacturer: optionalText(line.manufacturer),
      discountPercent: nullableDecimal(line.discountPercent),
      listPriceWithoutVat: nullableDecimal(line.listPriceWithoutVat),
      priceBeforeDiscount: nullableDecimal(line.priceBeforeDiscount),
      priceAfterDiscount: nullableDecimal(line.priceAfterDiscount),
      feeType: optionalText(line.feeType),
      environmentalFee: nullableDecimal(line.environmentalFee),
      recyclingFee: nullableDecimal(line.recyclingFee),
      deliveryNoteNumber: optionalText(line.deliveryNoteNumber),
      orderNumber: optionalText(line.orderNumber),
      supplierOrderNumber: optionalText(line.supplierOrderNumber),
      sourceLineNumber: optionalText(line.sourceLineNumber),
      jobId: positiveAccountingId(line.jobId, "Line job ID"),
      activityId: positiveAccountingId(line.activityId, "Line activity ID"),
      allocationType: member(
        line.allocationType,
        ALLOCATION_TYPES,
        "cost-document allocation type",
      ),
      matchConfirmed: line.matchConfirmed === 1,
    })),
    totals: {
      subtotalWithoutVat: nullableDecimal(input.document.subtotalWithoutVat),
      totalVat: nullableDecimal(input.document.totalVat),
      totalWithVat: nullableDecimal(input.document.totalWithVat),
    },
    fileRefs,
    references: canonicalAccountingSort(
      input.references.map((reference) => ({
        referenceType: member(
          reference.referenceType,
          REFERENCE_TYPES,
          "cost-document reference type",
        ),
        referenceNumber: requiredText(
          reference.referenceNumber,
          "cost-document reference number",
        ),
        source: member(
          reference.source,
          REFERENCE_SOURCES,
          "cost-document reference source",
        ),
        matchedEntityRef: matchedEntityRef(reference),
        matchConfirmed: reference.matchConfirmed === 1,
        rejected: reference.rejected === 1,
      })),
    ),
    sourceTrace: buildSourceTrace(
      input.document,
      input.latestCompletedExtractionJobId,
      options.capturePolicy,
    ),
  };
  return { snapshot, artifacts };
}

export function buildApprovedCostDocumentAccountingEvidence(
  input: BuildApprovedCostDocumentAccountingEvidenceInput,
): ApprovedCostDocumentAccountingEvidence {
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Approving actor user ID",
  );
  const documentId = requiredPositiveAccountingId(
    input.document.id,
    "Cost document ID",
  );
  if (input.document.status !== "approved" || !input.document.reviewedAt) {
    throw new Error(
      "Approved cost-document evidence requires approval state and time.",
    );
  }
  if (input.lines.length === 0) {
    throw new Error(
      "Approved cost-document evidence requires at least one line.",
    );
  }

  const { artifacts, fileRefs } = buildArtifacts(input.files);
  const source = member(
    input.document.source,
    DOCUMENT_SOURCES,
    "document source",
  );
  const sourceRefSha256 =
    source === "manual"
      ? null
      : sha256Hex(
          `${SOURCE_REF_DOMAIN}\0${requiredText(input.document.sourceRef, "Imported document source reference")}`,
        );
  const sortedLines = [...input.lines].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id - right.id,
  );
  const snapshot: CostSnapshot = {
    kind: "incoming-cost-document",
    document: {
      id: documentId,
      documentType: member(
        input.document.docType,
        DOCUMENT_TYPES,
        "document type",
      ),
      source,
      sourceRefSha256,
      documentNumber: optionalText(input.document.documentNumber),
      issueDate: input.document.issueDate,
      taxableSupplyDate: input.document.taxableSupplyDate,
      dueDate: input.document.dueDate,
      currency: input.document.currency,
      variableSymbol: optionalText(input.document.variableSymbol),
      constantSymbol: optionalText(input.document.constantSymbol),
      specificSymbol: optionalText(input.document.specificSymbol),
      bankAccount: optionalText(input.document.bankAccount),
      iban: optionalText(input.document.iban),
      bic: optionalText(input.document.bic),
      deliveryNoteResolution: member(
        input.document.deliveryNoteResolution,
        DELIVERY_NOTE_RESOLUTIONS,
        "delivery-note resolution",
      ),
      deliveryNoteResolutionReason: optionalText(
        input.document.deliveryNoteResolutionReason,
      ),
      customerId: positiveAccountingId(
        input.document.customerId,
        "Customer ID",
      ),
      jobId: positiveAccountingId(input.document.jobId, "Job ID"),
      notes: optionalText(input.document.notes),
    },
    supplier: {
      name: requiredText(input.document.supplierName, "Supplier name"),
      ic: optionalText(input.document.supplierIc),
      dic: optionalText(input.document.supplierDic),
      address: optionalText(input.document.supplierAddress),
      email: null,
      phone: null,
    },
    lines: sortedLines.map((line, index) => ({
      position: index + 1,
      sourceLineId: positiveAccountingId(line.id, "Cost-document line ID"),
      lineType: member(line.lineType, LINE_TYPES, "cost-document line type"),
      description: requiredText(
        line.description,
        "Cost-document line description",
      ),
      quantity: canonicalAccountingDecimal(line.quantity),
      unit: optionalText(line.unit),
      originalUnit: optionalText(line.originalUnit),
      unitPriceWithoutVat: canonicalAccountingDecimal(line.unitPriceWithoutVat),
      vatRate: nullableDecimal(line.vatRate),
      vatMode: member(line.vatMode, VAT_MODES, "cost-document VAT mode"),
      totalWithoutVat: canonicalAccountingDecimal(line.totalWithoutVat),
      totalVat: canonicalAccountingDecimal(line.totalVat),
      totalWithVat: canonicalAccountingDecimal(line.totalWithVat),
      supplierSku: optionalText(line.supplierSku),
      ean: optionalText(line.ean),
      manufacturer: optionalText(line.manufacturer),
      discountPercent: nullableDecimal(line.discountPercent),
      listPriceWithoutVat: nullableDecimal(line.listPriceWithoutVat),
      priceBeforeDiscount: nullableDecimal(line.priceBeforeDiscount),
      priceAfterDiscount: nullableDecimal(line.priceAfterDiscount),
      feeType: optionalText(line.feeType),
      environmentalFee: nullableDecimal(line.environmentalFee),
      recyclingFee: nullableDecimal(line.recyclingFee),
      deliveryNoteNumber: optionalText(line.deliveryNoteNumber),
      orderNumber: optionalText(line.orderNumber),
      supplierOrderNumber: optionalText(line.supplierOrderNumber),
      sourceLineNumber: optionalText(line.sourceLineNumber),
      jobId: positiveAccountingId(line.jobId, "Line job ID"),
      activityId: positiveAccountingId(line.activityId, "Line activity ID"),
      allocationType: member(
        line.allocationType,
        ALLOCATION_TYPES,
        "cost-document allocation type",
      ),
      matchConfirmed: line.matchConfirmed === 1,
    })),
    totals: {
      subtotalWithoutVat: nullableDecimal(input.document.subtotalWithoutVat),
      totalVat: nullableDecimal(input.document.totalVat),
      totalWithVat: nullableDecimal(input.document.totalWithVat),
    },
    fileRefs,
    references: canonicalAccountingSort(
      input.references.map((reference) => ({
        referenceType: member(
          reference.referenceType,
          REFERENCE_TYPES,
          "cost-document reference type",
        ),
        referenceNumber: requiredText(
          reference.referenceNumber,
          "Cost-document reference number",
        ),
        source: member(
          reference.source,
          REFERENCE_SOURCES,
          "cost-document reference source",
        ),
        matchedEntityRef: matchedEntityRef(reference),
        matchConfirmed: reference.matchConfirmed === 1,
        rejected: reference.rejected === 1,
      })),
    ),
    sourceTrace: buildSourceTrace(
      input.document,
      input.latestCompletedExtractionJobId,
    ),
  };

  const recordedAt = input.document.reviewedAt.toISOString();
  const approvalEvidenceSha256 = sha256Hex(
    `${APPROVAL_DOMAIN}\0${canonicalEvidenceJson({
      action: "approve",
      actorUserId: actorId,
      aggregate: { kind: "incoming-cost-document", id: documentId },
      recordedAt,
      snapshot,
      artifacts,
    })}`,
  );
  const versionId = deterministicAccountingUuid("approved-cost-version", {
    documentId,
    recordedAt,
    approvalEvidenceSha256,
  });
  const version = createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId,
    aggregate: { kind: "incoming-cost-document", id: documentId },
    version: "1",
    purpose: "approved",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    effectiveAt: recordedAt,
    recordedAt,
    snapshot,
    artifacts,
    provenance: {
      captureMode: "native",
      sourceMode: "human",
      recordedBy: { kind: "user", id: actorId, authentication: "session" },
      approvalEvidenceSha256,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "human",
        actorRef: `user:${actorId}`,
        sourceEvidenceSha256: approvalEvidenceSha256,
        extractionRunId: null,
        recordedAt,
      }),
    },
  });
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("approved-cost-event", {
      documentId,
      versionId,
      recordedAt,
      approvalEvidenceSha256,
    }),
    aggregate: {
      kind: "incoming-cost-document",
      id: documentId,
      versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "approved",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: "document_approved",
    reasonDetailSha256: null,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: approvalEvidenceSha256,
  });

  return { version, event, approvalEvidenceSha256 };
}
