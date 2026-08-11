import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  verifyAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
  type AccountingSnapshotV1,
} from "./accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  createAccountingVersionRelation,
  verifyAccountingCorrectionChainBinding,
  type AccountingLifecycleEventV1,
  type AccountingVersionRelationV1,
} from "./accounting-lifecycle-event-contract";
import {
  accountingObjectLocationSha256,
  deterministicAccountingUuid,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";
import { generateInvoicePdf, type InvoicePdfData } from "./invoice-pdf";

const FEATURE_FLAG = "ACCOUNTING_CANCEL_INVOICE_DUAL_WRITE_ENABLED";
const CANCELLATION_DOMAIN = "site-logbook.invoice-cancellation/v1";
const CANCELLATION_REASON_DOMAIN =
  "site-logbook.invoice-cancellation-reason/v1";
const CANCELLATION_REASONS = new Set<AccountingCancellationReasonCode>([
  "customer_complaint",
  "incorrect_job",
  "billing_error",
  "duplicate_invoice",
  "order_cancelled",
]);

type OutgoingSnapshot = Extract<
  AccountingSnapshotV1,
  { kind: "outgoing-invoice" }
>;

export type AccountingCancellationReasonCode =
  | "customer_complaint"
  | "incorrect_job"
  | "billing_error"
  | "duplicate_invoice"
  | "order_cancelled";

export type BuildInvoiceCancellationAccountingEvidenceInput = {
  targetVersion: AccountingDocumentVersionV1;
  actor: { userId: number | null; name: string };
  reasonCode: AccountingCancellationReasonCode;
  recordedAt: Date;
  nextLifecycleSequence: bigint;
  previousLifecycleEventSha256: string;
  objectPath: string;
};

export type InvoiceCancellationAccountingEvidence = {
  cancellationVersion: AccountingDocumentVersionV1;
  targetVersion: AccountingDocumentVersionV1;
  relation: AccountingVersionRelationV1;
  event: AccountingLifecycleEventV1;
  pdfBuffer: Buffer;
  pdfContentSha256: string;
  objectLocationSha256: string;
  cancellationEvidenceSha256: string;
};

const REASON_LABELS: Record<AccountingCancellationReasonCode, string> = {
  customer_complaint: "reklamace zákazníka",
  incorrect_job: "chybná zakázka nebo plnění",
  billing_error: "chyba ve fakturačních údajích",
  duplicate_invoice: "duplicitní faktura",
  order_cancelled: "zrušená zakázka",
};

export function isAccountingCancelInvoiceDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

export function invoiceCancellationObjectPath(input: {
  invoiceNumber: string;
  nextVersion: bigint;
  targetVersionId: string;
  reasonCode: AccountingCancellationReasonCode;
  recordedAt: Date;
}): string {
  const operationKey = sha256Hex(
    canonicalEvidenceJson({
      targetVersionId: input.targetVersionId,
      reasonCode: input.reasonCode,
      recordedAt: input.recordedAt.toISOString(),
    }),
  ).slice(0, 24);
  return `/objects/invoices/${input.invoiceNumber}.cancellation-v${input.nextVersion}-${operationKey}.pdf`;
}

function cancellationSnapshot(
  target: OutgoingSnapshot,
  reasonCode: AccountingCancellationReasonCode,
  recordedAt: string,
): OutgoingSnapshot {
  const originalNumber = target.invoice.invoiceNumber;
  return {
    ...target,
    invoice: {
      ...target.invoice,
      invoiceNumber: `${originalNumber}-STORNO`,
      documentType: "cancellation_notice",
      issueDate: recordedAt.slice(0, 10),
      taxableSupplyDate: recordedAt.slice(0, 10),
      dueDate: recordedAt.slice(0, 10),
      paymentMethod: null,
      variableSymbol: null,
      constantSymbol: null,
      specificSymbol: null,
      notes: `Storno faktury ${originalNumber}; důvod: ${REASON_LABELS[reasonCode]}; původní částka: ${target.totals.totalWithVat} ${target.invoice.currency}.`,
    },
    lines: target.lines.map((line) => ({
      ...line,
      unitPriceWithoutVat: "0",
      discountPercent: null,
      totalWithoutVat: "0",
      totalVat: "0",
      totalWithVat: "0",
    })),
    sourceLinks: target.sourceLinks.map((link) => ({
      ...link,
      amountWithoutVat: "0",
    })),
    totals: {
      subtotalWithoutVat: "0",
      totalVat: "0",
      totalWithVat: "0",
    },
    legacyPaymentObservation: null,
  };
}

function cancellationPdfData(
  snapshot: OutgoingSnapshot,
  recordedAt: string,
): InvoicePdfData {
  return {
    invoiceNumber: snapshot.invoice.invoiceNumber,
    status: "cancelled",
    documentTitle: "OZNÁMENÍ O STORNU FAKTURY",
    amountLabel: "Zůstatek storna:",
    showPaymentDetails: false,
    deterministicFileId: sha256Hex(
      canonicalEvidenceJson({ snapshot, recordedAt }),
    ).slice(0, 32),
    deterministicCreatedAt: recordedAt,
    customerName: snapshot.customer.name,
    customerIc: snapshot.customer.ic,
    customerDic: snapshot.customer.dic,
    customerAddress: snapshot.customer.address,
    customerEmail: snapshot.customer.email,
    issueDate: snapshot.invoice.issueDate,
    taxableSupplyDate: snapshot.invoice.taxableSupplyDate,
    dueDate: snapshot.invoice.dueDate,
    currency: snapshot.invoice.currency,
    paymentMethod: null,
    variableSymbol: null,
    constantSymbol: null,
    specificSymbol: null,
    vatModeDefault: snapshot.invoice.vatModeDefault,
    notes: snapshot.invoice.notes,
    lines: snapshot.lines.map((line) => ({
      description: line.description,
      unit: line.unit,
      quantity: Number(line.quantity),
      unitPriceWithoutVat: Number(line.unitPriceWithoutVat),
      discountPercent:
        line.discountPercent === null ? null : Number(line.discountPercent),
      vatMode: line.vatMode,
      vatRate: line.vatRate === null ? null : Number(line.vatRate),
      totalWithoutVat: Number(line.totalWithoutVat),
      totalVat: Number(line.totalVat),
      totalWithVat: Number(line.totalWithVat),
    })),
    subtotalWithoutVat: 0,
    totalVat: 0,
    totalWithVat: 0,
    supplier: {
      name: snapshot.supplier.name,
      ic: snapshot.supplier.ic,
      dic: snapshot.supplier.dic,
      address: snapshot.supplier.address,
      email: snapshot.supplier.email,
      phone: snapshot.supplier.phone,
      bankAccount: null,
      iban: null,
      bic: null,
      footerNote: null,
      vatPayer: snapshot.supplier.vatPayer,
    },
    paymentQrDataUrl: null,
  };
}

export function buildInvoiceCancellationAccountingEvidence(
  input: BuildInvoiceCancellationAccountingEvidenceInput,
): InvoiceCancellationAccountingEvidence {
  const targetVersion = verifyAccountingDocumentVersion(input.targetVersion);
  if (
    targetVersion.aggregate.kind !== "outgoing-invoice" ||
    targetVersion.snapshot.kind !== "outgoing-invoice" ||
    !new Set(["issued", "correction"]).has(targetVersion.purpose) ||
    targetVersion.snapshot.invoice.documentType === "cancellation_notice"
  ) {
    throw new Error("Invoice cancellation requires a current issued version.");
  }
  if (!CANCELLATION_REASONS.has(input.reasonCode)) {
    throw new Error("Invoice cancellation reason is not registered.");
  }
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Cancellation actor user ID",
  );
  if (input.nextLifecycleSequence <= 0n) {
    throw new Error("Cancellation lifecycle sequence must follow issuance.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.previousLifecycleEventSha256)) {
    throw new Error("Previous lifecycle event digest is invalid.");
  }
  const recordedAt = input.recordedAt.toISOString();
  const snapshot = cancellationSnapshot(
    targetVersion.snapshot,
    input.reasonCode,
    recordedAt,
  );
  const pdfBuffer = generateInvoicePdf(
    cancellationPdfData(snapshot, recordedAt),
  );
  const pdfContentSha256 = sha256Hex(pdfBuffer);
  const objectLocationSha256 = accountingObjectLocationSha256(input.objectPath);
  const cancellationEvidenceSha256 = sha256Hex(
    `${CANCELLATION_DOMAIN}\0${canonicalEvidenceJson({
      actorUserId: actorId,
      reasonCode: input.reasonCode,
      recordedAt,
      targetVersionId: targetVersion.versionId,
      targetVersionSha256: targetVersion.integrity.versionSha256,
      snapshot,
      renderedPdf: { pdfContentSha256, objectLocationSha256 },
    })}`,
  );
  const reasonDetailSha256 = sha256Hex(
    `${CANCELLATION_REASON_DOMAIN}\0${canonicalEvidenceJson({
      reasonCode: input.reasonCode,
      targetVersionId: targetVersion.versionId,
    })}`,
  );
  const cancellationVersionId = deterministicAccountingUuid(
    "invoice-cancellation-version",
    {
      targetVersionId: targetVersion.versionId,
      recordedAt,
      cancellationEvidenceSha256,
    },
  );
  const artifactId = deterministicAccountingUuid("invoice-cancellation-pdf", {
    cancellationVersionId,
    pdfContentSha256,
    objectLocationSha256,
  });
  const cancellationVersion = createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: cancellationVersionId,
    aggregate: targetVersion.aggregate,
    version: String(BigInt(targetVersion.version) + 1n),
    purpose: "cancellation_notice",
    supersedesVersionId: targetVersion.versionId,
    historicalCompleteness: "complete",
    effectiveAt: recordedAt,
    recordedAt,
    snapshot,
    artifacts: [
      {
        artifactId,
        role: "rendered-pdf",
        mediaType: "application/pdf",
        contentSha256: pdfContentSha256,
        sizeBytes: String(pdfBuffer.length),
        objectLocationSha256,
        rendererVersion: "invoice-cancellation-pdf/v1",
      },
    ],
    provenance: {
      captureMode: "native",
      sourceMode: "system",
      recordedBy: { kind: "user", id: actorId, authentication: "session" },
      approvalEvidenceSha256: cancellationEvidenceSha256,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "system",
        actorRef: "system:invoice-cancellation",
        sourceEvidenceSha256: cancellationEvidenceSha256,
        extractionRunId: null,
        recordedAt,
      }),
    },
  });
  const relation = createAccountingVersionRelation({
    schemaVersion: "site-logbook.accounting-version-relation/v1",
    relationId: deterministicAccountingUuid("invoice-cancellation-relation", {
      targetVersionId: targetVersion.versionId,
      cancellationVersionId,
      input: { reasonCode: input.reasonCode, recordedAt },
    }),
    relationType: "voids",
    source: {
      ...cancellationVersion.aggregate,
      versionId: cancellationVersion.versionId,
    },
    target: {
      ...targetVersion.aggregate,
      versionId: targetVersion.versionId,
    },
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: input.reasonCode,
    reasonDetailSha256,
    recordedAt,
    evidenceSha256: cancellationEvidenceSha256,
  });
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("invoice-void-confirmed-event", {
      targetVersionId: targetVersion.versionId,
      relationId: relation.relationId,
      sequence: String(input.nextLifecycleSequence),
    }),
    aggregate: {
      ...targetVersion.aggregate,
      versionId: targetVersion.versionId,
    },
    sequence: String(input.nextLifecycleSequence),
    previousEventSha256: input.previousLifecycleEventSha256,
    eventType: "void_confirmed",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: input.reasonCode,
    reasonDetailSha256,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: cancellationEvidenceSha256,
  });
  verifyAccountingCorrectionChainBinding(
    relation,
    event,
    cancellationVersion,
    targetVersion,
  );

  return {
    cancellationVersion,
    targetVersion,
    relation,
    event,
    pdfBuffer,
    pdfContentSha256,
    objectLocationSha256,
    cancellationEvidenceSha256,
  };
}
