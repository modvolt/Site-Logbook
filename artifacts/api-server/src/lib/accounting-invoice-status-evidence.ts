import {
  verifyAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  createAccountingLifecycleEvent,
  createAccountingPaymentEvent,
  verifyAccountingLifecycleEventBinding,
  verifyAccountingPaymentEventBinding,
  type AccountingLifecycleEventV1,
  type AccountingPaymentEventV1,
} from "./accounting-lifecycle-event-contract";
import {
  canonicalAccountingDecimal,
  deterministicAccountingUuid,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const STATUS_FEATURE_FLAG =
  "ACCOUNTING_INVOICE_STATUS_DUAL_WRITE_ENABLED" as const;
const BANK_FEATURE_FLAG = "ACCOUNTING_BANK_PAYMENT_DUAL_WRITE_ENABLED" as const;
const DELIVERY_DOMAIN = "site-logbook.invoice-delivery-confirmation/v1";
const PAYMENT_DOMAIN = "site-logbook.invoice-payment-received/v1";
const PAYMENT_SOURCE_DOMAIN = "site-logbook.invoice-payment-source/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type EvidenceActor = { userId: number | null; name: string };
type PaymentSource = "manual" | "bank_import";

export type BankPaymentSourceReferenceV1 = {
  amount: string;
  currency: string;
  occurredOn: string;
  variableSymbol: string | null;
  counterparty: string | null;
};

export type BuildInvoiceSentAccountingEvidenceInput = {
  version: AccountingDocumentVersionV1;
  actor: EvidenceActor;
  recordedAt: Date;
  nextLifecycleSequence: bigint;
  previousLifecycleEventSha256: string;
};

export type BuildInvoicePaymentAccountingEvidenceInput = {
  version: AccountingDocumentVersionV1;
  actor: EvidenceActor;
  recordedAt: Date;
  occurredOn: string;
  amount: string;
  currency: string;
  source: PaymentSource;
  bankSourceReference?: BankPaymentSourceReferenceV1 | null;
  nextPaymentSequence: bigint;
  previousPaymentEventSha256: string | null;
};

export type InvoiceSentAccountingEvidence = {
  event: AccountingLifecycleEventV1;
  evidenceSha256: string;
};

export type InvoicePaymentAccountingEvidence = {
  event: AccountingPaymentEventV1;
  evidenceSha256: string;
  sourceRefSha256: string | null;
};

export function isAccountingInvoiceStatusDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[STATUS_FEATURE_FLAG] === "true";
}

export function isAccountingBankPaymentDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[BANK_FEATURE_FLAG] === "true";
}

function nativeInvoiceVersion(
  value: AccountingDocumentVersionV1,
): AccountingDocumentVersionV1 {
  const version = verifyAccountingDocumentVersion(value);
  if (
    version.aggregate.kind !== "outgoing-invoice" ||
    version.snapshot.kind !== "outgoing-invoice" ||
    !new Set(["issued", "correction"]).has(version.purpose)
  ) {
    throw new Error(
      "Invoice status evidence requires a current native issued version.",
    );
  }
  return version;
}

function actorId(actor: EvidenceActor): string {
  return requiredPositiveAccountingId(
    actor.userId,
    "Invoice status actor user ID",
  );
}

function assertSuccessor(
  sequence: bigint,
  previousEventSha256: string | null,
  label: string,
): void {
  if (sequence < 0n) {
    throw new Error(`${label} sequence cannot be negative.`);
  }
  const first = sequence === 0n;
  if (first !== (previousEventSha256 === null)) {
    throw new Error(`${label} previous digest does not match its sequence.`);
  }
  if (
    previousEventSha256 !== null &&
    !SHA256_PATTERN.test(previousEventSha256)
  ) {
    throw new Error(`${label} previous digest is invalid.`);
  }
}

export function buildInvoiceSentAccountingEvidence(
  input: BuildInvoiceSentAccountingEvidenceInput,
): InvoiceSentAccountingEvidence {
  const version = nativeInvoiceVersion(input.version);
  const userId = actorId(input.actor);
  if (input.nextLifecycleSequence <= 0n) {
    throw new Error("Invoice sent event must follow issuance.");
  }
  assertSuccessor(
    input.nextLifecycleSequence,
    input.previousLifecycleEventSha256,
    "Invoice lifecycle",
  );
  const recordedAt = input.recordedAt.toISOString();
  const evidenceSha256 = sha256Hex(
    `${DELIVERY_DOMAIN}\0${canonicalEvidenceJson({
      action: "delivery-confirmed",
      actorUserId: userId,
      invoiceId: version.aggregate.id,
      recordedAt,
      versionId: version.versionId,
      versionSha256: version.integrity.versionSha256,
    })}`,
  );
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: deterministicAccountingUuid("invoice-sent-event", {
      invoiceId: version.aggregate.id,
      versionId: version.versionId,
      sequence: String(input.nextLifecycleSequence),
      recordedAt,
      evidenceSha256,
    }),
    aggregate: { ...version.aggregate, versionId: version.versionId },
    sequence: String(input.nextLifecycleSequence),
    previousEventSha256: input.previousLifecycleEventSha256,
    eventType: "sent",
    actor: { kind: "user", id: userId, authentication: "session" },
    reasonCode: "delivery_confirmed",
    reasonDetailSha256: null,
    effectiveAt: recordedAt,
    recordedAt,
    evidenceSha256,
  });
  verifyAccountingLifecycleEventBinding(event, version);
  return { event, evidenceSha256 };
}

export function buildInvoicePaymentAccountingEvidence(
  input: BuildInvoicePaymentAccountingEvidenceInput,
): InvoicePaymentAccountingEvidence {
  const version = nativeInvoiceVersion(input.version);
  const userId = actorId(input.actor);
  assertSuccessor(
    input.nextPaymentSequence,
    input.previousPaymentEventSha256,
    "Invoice payment",
  );
  const amount = canonicalAccountingDecimal(input.amount);
  if (amount.startsWith("-") || amount === "0") {
    throw new Error("Received invoice payment must be positive.");
  }
  const recordedAt = input.recordedAt.toISOString();
  let sourceRefSha256: string | null = null;
  if (input.source === "bank_import") {
    if (!input.bankSourceReference) {
      throw new Error("Bank-import payment requires a source reference.");
    }
    const sourceReference = {
      ...input.bankSourceReference,
      amount: canonicalAccountingDecimal(input.bankSourceReference.amount),
      currency: input.bankSourceReference.currency,
      occurredOn: input.bankSourceReference.occurredOn,
    };
    if (
      sourceReference.amount !== amount ||
      sourceReference.currency !== input.currency ||
      sourceReference.occurredOn !== input.occurredOn
    ) {
      throw new Error(
        "Bank source reference does not match the persisted payment.",
      );
    }
    sourceRefSha256 = sha256Hex(
      `${PAYMENT_SOURCE_DOMAIN}\0${canonicalEvidenceJson(sourceReference)}`,
    );
  } else if (input.bankSourceReference != null) {
    throw new Error("Manual payment cannot carry a bank source reference.");
  }

  const evidenceSha256 = sha256Hex(
    `${PAYMENT_DOMAIN}\0${canonicalEvidenceJson({
      actorUserId: userId,
      amount,
      currency: input.currency,
      invoiceId: version.aggregate.id,
      occurredOn: input.occurredOn,
      recordedAt,
      source: input.source,
      sourceRefSha256,
      versionId: version.versionId,
      versionSha256: version.integrity.versionSha256,
    })}`,
  );
  const event = createAccountingPaymentEvent({
    schemaVersion: "site-logbook.accounting-payment-event/v1",
    paymentEventId: deterministicAccountingUuid("invoice-payment-event", {
      invoiceId: version.aggregate.id,
      versionId: version.versionId,
      sequence: String(input.nextPaymentSequence),
      recordedAt,
      evidenceSha256,
    }),
    invoiceId: version.aggregate.id,
    invoiceVersionId: version.versionId,
    sequence: String(input.nextPaymentSequence),
    previousEventSha256: input.previousPaymentEventSha256,
    eventType: "received",
    amountDelta: amount,
    currency: input.currency,
    occurredOn: input.occurredOn,
    recordedAt,
    source: input.source,
    sourceRefSha256,
    correctsPaymentEventId: null,
    actor: { kind: "user", id: userId, authentication: "session" },
    reasonCode:
      input.source === "manual" ? "payment_received" : "payment_imported",
    reasonDetailSha256: null,
    evidenceSha256,
  });
  verifyAccountingPaymentEventBinding(event, version);
  return { event, evidenceSha256, sourceRefSha256 };
}
