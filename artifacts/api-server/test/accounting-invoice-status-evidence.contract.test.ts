import { describe, expect, it } from "vitest";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  type AccountingSnapshotV1,
} from "../src/lib/accounting-document-version-contract";
import {
  verifyAccountingLifecycleEventBinding,
  verifyAccountingPaymentEventBinding,
} from "../src/lib/accounting-lifecycle-event-contract";
import {
  buildInvoicePaymentAccountingEvidence,
  buildInvoiceSentAccountingEvidence,
  isAccountingBankPaymentDualWriteEnabled,
  isAccountingInvoiceStatusDualWriteEnabled,
} from "../src/lib/accounting-invoice-status-evidence";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const AT = new Date("2042-03-04T10:00:00.000Z");
const actor = { userId: 7, name: "Accounting Status Test" };

function issuedVersion(purpose: "issued" | "legacy_observation" = "issued") {
  const snapshot: Extract<AccountingSnapshotV1, { kind: "outgoing-invoice" }> =
    {
      kind: "outgoing-invoice",
      invoice: {
        id: "42",
        invoiceNumber: "FV-2042-0042",
        documentType: "invoice",
        issueDate: "2042-03-01",
        taxableSupplyDate: "2042-03-01",
        dueDate: "2042-03-15",
        currency: "CZK",
        paymentMethod: "bank_transfer",
        variableSymbol: "20420042",
        constantSymbol: null,
        specificSymbol: null,
        vatModeDefault: "standard",
        materialDisplayMode: "detailed",
        notes: null,
      },
      customer: {
        customerId: "9",
        name: "Customer s.r.o.",
        ic: null,
        dic: null,
        address: null,
        email: null,
        phone: null,
      },
      supplier: {
        name: "MODVOLT s.r.o.",
        ic: null,
        dic: null,
        address: null,
        email: null,
        phone: null,
        bankAccount: null,
        iban: null,
        bic: null,
        vatPayer: true,
      },
      lines: [
        {
          position: 1,
          sourceLineId: "1",
          sourceType: "manual",
          sourceId: null,
          jobId: null,
          activityId: null,
          description: "Servis",
          quantity: "1",
          unit: "ks",
          unitPriceWithoutVat: "100",
          discountPercent: null,
          vatRate: "21",
          vatMode: "standard",
          totalWithoutVat: "100",
          totalVat: "21",
          totalWithVat: "121",
        },
      ],
      sourceLinks: [],
      totals: {
        subtotalWithoutVat: "100",
        totalVat: "21",
        totalWithVat: "121",
      },
      legacyPaymentObservation:
        purpose === "legacy_observation"
          ? {
              paidDate: null,
              paidAmount: null,
              historicalCompleteness: "unknown",
            }
          : null,
    };
  return createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: "11111111-1111-4111-8111-111111111111",
    aggregate: { kind: "outgoing-invoice", id: "42" },
    version: "1",
    purpose,
    supersedesVersionId: null,
    historicalCompleteness: purpose === "issued" ? "complete" : "unknown",
    effectiveAt: purpose === "issued" ? "2042-03-01T08:00:00.000Z" : null,
    recordedAt: "2042-03-01T08:00:00.000Z",
    snapshot,
    artifacts: [
      {
        artifactId: "22222222-2222-4222-8222-222222222222",
        role: "rendered-pdf",
        mediaType: "application/pdf",
        contentSha256: HASH_A,
        sizeBytes: "1024",
        objectLocationSha256: HASH_B,
        rendererVersion: "invoice-pdf/v1",
      },
    ],
    provenance:
      purpose === "issued"
        ? {
            captureMode: "native",
            sourceMode: "system",
            recordedBy: {
              kind: "user",
              id: "7",
              authentication: "session",
            },
            approvalEvidenceSha256: HASH_C,
            fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
              source: "system",
              actorRef: "system:invoice-issuer",
              sourceEvidenceSha256: HASH_C,
              extractionRunId: null,
              recordedAt: "2042-03-01T08:00:00.000Z",
            }),
          }
        : {
            captureMode: "legacy-observation",
            sourceMode: "legacy_unknown",
            recordedBy: {
              kind: "system",
              id: "accounting-backfill",
              authentication: "migration",
            },
            approvalEvidenceSha256: null,
            fieldProvenance: [],
          },
  });
}

describe("invoice status accounting evidence", () => {
  it("keeps both rollout flags exact and default-dark", () => {
    expect(isAccountingInvoiceStatusDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingInvoiceStatusDualWriteEnabled({
        ACCOUNTING_INVOICE_STATUS_DUAL_WRITE_ENABLED: "TRUE",
      }),
    ).toBe(false);
    expect(
      isAccountingInvoiceStatusDualWriteEnabled({
        ACCOUNTING_INVOICE_STATUS_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
    expect(isAccountingBankPaymentDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingBankPaymentDualWriteEnabled({
        ACCOUNTING_BANK_PAYMENT_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("creates a deterministic sent event bound to the current issued version", () => {
    const version = issuedVersion();
    const input = {
      version,
      actor,
      recordedAt: AT,
      nextLifecycleSequence: 1n,
      previousLifecycleEventSha256: HASH_A,
    };
    const first = buildInvoiceSentAccountingEvidence(input);
    const second = buildInvoiceSentAccountingEvidence(input);
    expect(first).toEqual(second);
    expect(first.event).toMatchObject({
      eventType: "sent",
      sequence: "1",
      previousEventSha256: HASH_A,
      reasonCode: "delivery_confirmed",
      evidenceSha256: first.evidenceSha256,
    });
    expect(() =>
      verifyAccountingLifecycleEventBinding(first.event, version),
    ).not.toThrow();
  });

  it("separates manual and bank-import payment provenance without raw bank fields", () => {
    const version = issuedVersion();
    const manual = buildInvoicePaymentAccountingEvidence({
      version,
      actor,
      recordedAt: AT,
      occurredOn: "2042-03-04",
      amount: "121.00",
      currency: "CZK",
      source: "manual",
      bankSourceReference: null,
      nextPaymentSequence: 0n,
      previousPaymentEventSha256: null,
    });
    expect(manual.event).toMatchObject({
      eventType: "received",
      amountDelta: "121",
      source: "manual",
      sourceRefSha256: null,
      reasonCode: "payment_received",
    });

    const bank = buildInvoicePaymentAccountingEvidence({
      version,
      actor,
      recordedAt: AT,
      occurredOn: "2042-03-04",
      amount: "121",
      currency: "CZK",
      source: "bank_import",
      bankSourceReference: {
        amount: "121.00",
        currency: "CZK",
        occurredOn: "2042-03-04",
        variableSymbol: "20420042",
        counterparty: "Customer s.r.o.",
      },
      nextPaymentSequence: 0n,
      previousPaymentEventSha256: null,
    });
    expect(bank.event).toMatchObject({
      eventType: "received",
      amountDelta: "121",
      source: "bank_import",
      sourceRefSha256: bank.sourceRefSha256,
      reasonCode: "payment_imported",
    });
    expect(bank.sourceRefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(bank.event)).not.toContain("Customer s.r.o.");
    expect(JSON.stringify(bank.event)).not.toContain("20420042");
    expect(() =>
      verifyAccountingPaymentEventBinding(bank.event, version),
    ).not.toThrow();
  });

  it("rejects fabricated legacy evidence, invalid actors, chain positions and payment data", () => {
    expect(() =>
      buildInvoiceSentAccountingEvidence({
        version: issuedVersion("legacy_observation"),
        actor,
        recordedAt: AT,
        nextLifecycleSequence: 1n,
        previousLifecycleEventSha256: HASH_A,
      }),
    ).toThrow(/native issued version/i);
    expect(() =>
      buildInvoiceSentAccountingEvidence({
        version: issuedVersion(),
        actor: { userId: null, name: "System" },
        recordedAt: AT,
        nextLifecycleSequence: 1n,
        previousLifecycleEventSha256: HASH_A,
      }),
    ).toThrow(/actor user ID is required/i);
    expect(() =>
      buildInvoiceSentAccountingEvidence({
        version: issuedVersion(),
        actor,
        recordedAt: AT,
        nextLifecycleSequence: 2n,
        previousLifecycleEventSha256: "bad",
      }),
    ).toThrow(/digest/i);
    expect(() =>
      buildInvoicePaymentAccountingEvidence({
        version: issuedVersion(),
        actor,
        recordedAt: AT,
        occurredOn: "2042-03-04",
        amount: "0",
        currency: "CZK",
        source: "manual",
        nextPaymentSequence: 0n,
        previousPaymentEventSha256: null,
      }),
    ).toThrow(/positive/i);
    expect(() =>
      buildInvoicePaymentAccountingEvidence({
        version: issuedVersion(),
        actor,
        recordedAt: AT,
        occurredOn: "2042-03-04",
        amount: "121",
        currency: "CZK",
        source: "bank_import",
        bankSourceReference: {
          amount: "120",
          currency: "CZK",
          occurredOn: "2042-03-04",
          variableSymbol: null,
          counterparty: null,
        },
        nextPaymentSequence: 0n,
        previousPaymentEventSha256: null,
      }),
    ).toThrow(/does not match/i);
  });
});
