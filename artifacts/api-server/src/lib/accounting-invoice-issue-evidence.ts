import type { BillingSettings, Invoice, InvoiceLine } from "@workspace/db";
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
  accountingDecimalToScaled,
  accountingObjectLocationSha256,
  accountingScaledToDecimal,
  canonicalAccountingDecimal,
  canonicalAccountingSort,
  deterministicAccountingUuid,
  positiveAccountingId,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const APPROVAL_DOMAIN = "site-logbook.invoice-issue-approval/v1";
const FEATURE_FLAG = "ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED";
const OUTGOING_LINE_SOURCE_TYPES = new Set([
  "job",
  "activity",
  "activity_work",
  "activity_material",
  "material",
  "billing_document_line",
  "work_session",
  "quote_item",
  "transport",
  "parking",
  "fine",
  "manual",
  "correction",
] as const);

type OutgoingSnapshot = Extract<
  AccountingSnapshotV1,
  { kind: "outgoing-invoice" }
>;
type OutgoingLineSourceType = OutgoingSnapshot["lines"][number]["sourceType"];
type OutgoingSourceLink = OutgoingSnapshot["sourceLinks"][number];

export type InvoiceIssueEvidenceSourceLink = {
  jobId: number | null;
  activityId: number | null;
  amountWithoutVat: string;
};

export type InvoiceIssueEvidenceWorkSessionLink = {
  sessionId: number;
  amountWithoutVatSnapshot: string;
};

export type InvoiceIssueEvidenceActor = {
  userId: number | null;
  name: string;
};

export type BuildIssuedInvoiceAccountingEvidenceInput = {
  invoice: Invoice;
  lines: InvoiceLine[];
  invoiceSourceLinks: InvoiceIssueEvidenceSourceLink[];
  workSessionLinks: InvoiceIssueEvidenceWorkSessionLink[];
  settings: BillingSettings;
  actor: InvoiceIssueEvidenceActor;
  pdfBuffer: Buffer;
  objectPath: string;
};

export type IssuedInvoiceAccountingEvidence = {
  version: AccountingDocumentVersionV1;
  event: AccountingLifecycleEventV1;
  approvalEvidenceSha256: string;
  pdfContentSha256: string;
  objectLocationSha256: string;
};

export function isAccountingIssueInvoiceDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

function lineSourceType(value: string): OutgoingLineSourceType {
  if (!OUTGOING_LINE_SOURCE_TYPES.has(value as OutgoingLineSourceType)) {
    throw new Error(`Unsupported issued-invoice source type: ${value}`);
  }
  return value as OutgoingLineSourceType;
}

function buildSourceLinks(
  invoiceSourceLinks: InvoiceIssueEvidenceSourceLink[],
  workSessionLinks: InvoiceIssueEvidenceWorkSessionLink[],
  lines: InvoiceLine[],
): OutgoingSourceLink[] {
  const totals = new Map<string, bigint>();
  const add = (
    sourceType: OutgoingSourceLink["sourceType"],
    sourceId: number | null,
    amount: string,
  ) => {
    const id = positiveAccountingId(sourceId, `${sourceType} source ID`);
    if (id === null) return;
    const key = `${sourceType}:${id}`;
    totals.set(
      key,
      (totals.get(key) ?? 0n) + accountingDecimalToScaled(amount),
    );
  };

  for (const link of invoiceSourceLinks) {
    add("job", link.jobId, link.amountWithoutVat);
    add("activity", link.activityId, link.amountWithoutVat);
  }
  for (const link of workSessionLinks) {
    add("work_session", link.sessionId, link.amountWithoutVatSnapshot);
  }
  for (const line of lines) {
    if (line.sourceType === "billing_document_line") {
      add("billing_document_line", line.sourceId, line.totalWithoutVat);
    }
  }

  return canonicalAccountingSort(
    [...totals.entries()].map(([key, amountWithoutVat]) => {
      const separator = key.indexOf(":");
      return {
        sourceType: key.slice(0, separator) as OutgoingSourceLink["sourceType"],
        sourceId: key.slice(separator + 1),
        amountWithoutVat: accountingScaledToDecimal(amountWithoutVat),
      };
    }),
  );
}

export function buildIssuedInvoiceAccountingEvidence(
  input: BuildIssuedInvoiceAccountingEvidenceInput,
): IssuedInvoiceAccountingEvidence {
  const actorId = requiredPositiveAccountingId(
    input.actor.userId,
    "Issuing actor user ID",
  );
  const invoiceId = requiredPositiveAccountingId(
    input.invoice.id,
    "Invoice ID",
  );
  if (!input.invoice.issuedAt) {
    throw new Error("Issued invoice evidence requires issuedAt.");
  }
  if (!input.invoice.invoiceNumber) {
    throw new Error("Issued invoice evidence requires an invoice number.");
  }
  if (
    !input.invoice.issueDate ||
    !input.invoice.taxableSupplyDate ||
    !input.invoice.dueDate
  ) {
    throw new Error("Issued invoice evidence requires all accounting dates.");
  }
  if (input.pdfBuffer.length === 0) {
    throw new Error(
      "Issued invoice evidence requires a non-empty rendered PDF.",
    );
  }

  const recordedAt = input.invoice.issuedAt.toISOString();
  const snapshot: OutgoingSnapshot = {
    kind: "outgoing-invoice",
    invoice: {
      id: invoiceId,
      invoiceNumber: input.invoice.invoiceNumber,
      documentType: "invoice",
      issueDate: input.invoice.issueDate,
      taxableSupplyDate: input.invoice.taxableSupplyDate,
      dueDate: input.invoice.dueDate,
      currency: input.invoice.currency,
      paymentMethod: input.invoice.paymentMethod,
      variableSymbol: input.invoice.variableSymbol,
      constantSymbol: input.invoice.constantSymbol,
      specificSymbol: input.invoice.specificSymbol,
      vatModeDefault: input.invoice
        .vatModeDefault as OutgoingSnapshot["invoice"]["vatModeDefault"],
      materialDisplayMode: input.invoice
        .materialDisplayMode as OutgoingSnapshot["invoice"]["materialDisplayMode"],
      notes: input.invoice.notes,
    },
    customer: {
      customerId: positiveAccountingId(input.invoice.customerId, "Customer ID"),
      name: input.invoice.customerName ?? "",
      ic: input.invoice.customerIc,
      dic: input.invoice.customerDic,
      address: input.invoice.customerAddress,
      email: input.invoice.customerEmail,
      phone: null,
    },
    supplier: {
      name: input.settings.supplierName,
      ic: input.settings.supplierIc,
      dic: input.settings.supplierDic,
      address: input.settings.supplierAddress,
      email: input.settings.supplierEmail,
      phone: input.settings.supplierPhone,
      bankAccount: input.settings.bankAccount,
      iban: input.settings.iban,
      bic: input.settings.bic,
      vatPayer: input.settings.vatPayer,
    },
    lines: input.lines.map((line, index) => ({
      position: index + 1,
      sourceLineId: requiredPositiveAccountingId(line.id, "Invoice line ID"),
      sourceType: lineSourceType(line.sourceType),
      sourceId: positiveAccountingId(line.sourceId, "Invoice line source ID"),
      jobId: positiveAccountingId(line.jobId, "Invoice line job ID"),
      activityId: positiveAccountingId(
        line.activityId,
        "Invoice line activity ID",
      ),
      description: line.description,
      quantity: canonicalAccountingDecimal(line.quantity),
      unit: line.unit,
      unitPriceWithoutVat: canonicalAccountingDecimal(line.unitPriceWithoutVat),
      discountPercent:
        line.discountPercent === null
          ? null
          : canonicalAccountingDecimal(line.discountPercent),
      vatRate:
        line.vatRate === null ? null : canonicalAccountingDecimal(line.vatRate),
      vatMode: line.vatMode as OutgoingSnapshot["lines"][number]["vatMode"],
      totalWithoutVat: canonicalAccountingDecimal(line.totalWithoutVat),
      totalVat: canonicalAccountingDecimal(line.totalVat),
      totalWithVat: canonicalAccountingDecimal(line.totalWithVat),
    })),
    sourceLinks: buildSourceLinks(
      input.invoiceSourceLinks,
      input.workSessionLinks,
      input.lines,
    ),
    totals: {
      subtotalWithoutVat: canonicalAccountingDecimal(
        input.invoice.subtotalWithoutVat,
      ),
      totalVat: canonicalAccountingDecimal(input.invoice.totalVat),
      totalWithVat: canonicalAccountingDecimal(input.invoice.totalWithVat),
    },
    legacyPaymentObservation: null,
  };

  const pdfContentSha256 = sha256Hex(input.pdfBuffer);
  const objectLocationSha256 = accountingObjectLocationSha256(input.objectPath);
  const artifactId = deterministicAccountingUuid("rendered-pdf", {
    invoiceId,
    pdfContentSha256,
    objectLocationSha256,
  });
  const approvalEvidenceSha256 = sha256Hex(
    `${APPROVAL_DOMAIN}\0${canonicalEvidenceJson({
      action: "issue",
      actorUserId: actorId,
      aggregate: { kind: "outgoing-invoice", id: invoiceId },
      recordedAt,
      snapshot,
      renderedPdf: { pdfContentSha256, objectLocationSha256 },
    })}`,
  );
  const versionId = deterministicAccountingUuid("issued-version", {
    invoiceId,
    recordedAt,
    approvalEvidenceSha256,
  });
  const version = createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId,
    aggregate: { kind: "outgoing-invoice", id: invoiceId },
    version: "1",
    purpose: "issued",
    supersedesVersionId: null,
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
        sizeBytes: String(input.pdfBuffer.length),
        objectLocationSha256,
        rendererVersion: "invoice-pdf/v1",
      },
    ],
    provenance: {
      captureMode: "native",
      sourceMode: "system",
      recordedBy: { kind: "user", id: actorId, authentication: "session" },
      approvalEvidenceSha256,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "system",
        actorRef: "system:invoice-issuer",
        sourceEvidenceSha256: approvalEvidenceSha256,
        extractionRunId: null,
        recordedAt,
      }),
    },
  });
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("issued-event", {
      invoiceId,
      versionId,
      recordedAt,
      approvalEvidenceSha256,
    }),
    aggregate: {
      kind: "outgoing-invoice",
      id: invoiceId,
      versionId,
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "issued",
    actor: { kind: "user", id: actorId, authentication: "session" },
    reasonCode: "document_issued",
    reasonDetailSha256: null,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256: approvalEvidenceSha256,
  });

  return {
    version,
    event,
    approvalEvidenceSha256,
    pdfContentSha256,
    objectLocationSha256,
  };
}
