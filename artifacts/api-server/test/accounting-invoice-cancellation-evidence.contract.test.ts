import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  buildInvoiceCancellationAccountingEvidence,
  invoiceCancellationObjectPath,
  isAccountingCancelInvoiceDualWriteEnabled,
} from "../src/lib/accounting-invoice-cancellation-evidence";
import {
  buildUniformAccountingFieldProvenance,
  createAccountingDocumentVersion,
  verifyAccountingDocumentVersion,
  type AccountingSnapshotV1,
} from "../src/lib/accounting-document-version-contract";
import { verifyAccountingCorrectionChainBinding } from "../src/lib/accounting-lifecycle-event-contract";

const ISSUED_AT = "2042-03-04T10:00:00.000Z";
const CANCELLED_AT = new Date("2042-03-05T11:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const TARGET_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

function issuedSnapshot(): AccountingSnapshotV1 {
  return {
    kind: "outgoing-invoice",
    invoice: {
      id: "42",
      invoiceNumber: "FV20420042",
      documentType: "invoice",
      issueDate: "2042-03-04",
      taxableSupplyDate: "2042-03-04",
      dueDate: "2042-03-18",
      currency: "CZK",
      paymentMethod: "bank",
      variableSymbol: "20420042",
      constantSymbol: "0308",
      specificSymbol: null,
      vatModeDefault: "standard",
      materialDisplayMode: "detailed",
      notes: null,
    },
    customer: {
      customerId: "9",
      name: "Customer s.r.o.",
      ic: "12345678",
      dic: "CZ12345678",
      address: "Dlouhá 1, Praha",
      email: "office@example.test",
      phone: null,
    },
    supplier: {
      name: "MODVOLT s.r.o.",
      ic: "87654321",
      dic: "CZ87654321",
      address: "Krátká 2, Brno",
      email: "billing@modvolt.example",
      phone: "+420123456789",
      bankAccount: "123456789/0100",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
      vatPayer: true,
    },
    lines: [
      {
        position: 1,
        sourceLineId: "501",
        sourceType: "job",
        sourceId: "77",
        jobId: "77",
        activityId: null,
        description: "Montáž rozvaděče",
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
    sourceLinks: [
      { sourceType: "job", sourceId: "77", amountWithoutVat: "100" },
    ],
    totals: {
      subtotalWithoutVat: "100",
      totalVat: "21",
      totalWithVat: "121",
    },
    legacyPaymentObservation: null,
  };
}

function issuedVersion() {
  const snapshot = issuedSnapshot();
  return createAccountingDocumentVersion({
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: TARGET_VERSION_ID,
    aggregate: { kind: "outgoing-invoice", id: "42" },
    version: "1",
    purpose: "issued",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    effectiveAt: ISSUED_AT,
    recordedAt: ISSUED_AT,
    snapshot,
    artifacts: [
      {
        artifactId: TARGET_ARTIFACT_ID,
        role: "rendered-pdf",
        mediaType: "application/pdf",
        contentSha256: HASH_A,
        sizeBytes: "2048",
        objectLocationSha256: HASH_B,
        rendererVersion: "invoice-pdf/v1",
      },
    ],
    provenance: {
      captureMode: "native",
      sourceMode: "system",
      recordedBy: { kind: "user", id: "7", authentication: "session" },
      approvalEvidenceSha256: HASH_C,
      fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
        source: "system",
        actorRef: "system:invoice-issuer",
        sourceEvidenceSha256: HASH_C,
        extractionRunId: null,
        recordedAt: ISSUED_AT,
      }),
    },
  });
}

function input() {
  return {
    targetVersion: issuedVersion(),
    actor: { userId: 7, name: "Reviewer" },
    reasonCode: "incorrect_job" as const,
    recordedAt: CANCELLED_AT,
    nextLifecycleSequence: 1n,
    previousLifecycleEventSha256: HASH_C,
    objectPath: "/objects/invoices/FV20420042.cancellation-v2.pdf",
  };
}

async function pdfText(buffer: Buffer): Promise<string> {
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
}

describe("invoice cancellation accounting evidence", () => {
  it("keeps the cutover gate exact and dark by default", () => {
    expect(isAccountingCancelInvoiceDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingCancelInvoiceDualWriteEnabled({
        ACCOUNTING_CANCEL_INVOICE_DUAL_WRITE_ENABLED: " true ",
      }),
    ).toBe(false);
    expect(
      isAccountingCancelInvoiceDualWriteEnabled({
        ACCOUNTING_CANCEL_INVOICE_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("builds a deterministic version-two cancellation artifact and atomic void chain", async () => {
    const first = buildInvoiceCancellationAccountingEvidence(input());
    const second = buildInvoiceCancellationAccountingEvidence(input());
    expect(second).toEqual(first);
    expect(() =>
      verifyAccountingDocumentVersion(first.cancellationVersion),
    ).not.toThrow();
    expect(() =>
      verifyAccountingCorrectionChainBinding(
        first.relation,
        first.event,
        first.cancellationVersion,
        first.targetVersion,
      ),
    ).not.toThrow();
    expect(first.cancellationVersion).toMatchObject({
      aggregate: { kind: "outgoing-invoice", id: "42" },
      version: "2",
      purpose: "cancellation_notice",
      supersedesVersionId: TARGET_VERSION_ID,
      snapshot: {
        kind: "outgoing-invoice",
        invoice: {
          documentType: "cancellation_notice",
          invoiceNumber: "FV20420042-STORNO",
        },
        totals: {
          subtotalWithoutVat: "0",
          totalVat: "0",
          totalWithVat: "0",
        },
      },
    });
    expect(first.relation).toMatchObject({
      relationType: "voids",
      reasonCode: "incorrect_job",
      evidenceSha256: first.cancellationEvidenceSha256,
    });
    expect(first.event).toMatchObject({
      eventType: "void_confirmed",
      sequence: "1",
      previousEventSha256: HASH_C,
      evidenceSha256: first.cancellationEvidenceSha256,
    });
    expect(first.cancellationVersion.artifacts[0]).toMatchObject({
      role: "rendered-pdf",
      contentSha256: first.pdfContentSha256,
      objectLocationSha256: first.objectLocationSha256,
      rendererVersion: "invoice-cancellation-pdf/v1",
    });
    const text = await pdfText(first.pdfBuffer);
    expect(text).toContain("OZNÁMENÍ O STORNU FAKTURY");
    expect(text).toContain("FV20420042-STORNO");
    expect(text).toContain("chybná zakázka nebo plnění");
  });

  it("does not mutate the supplied issued version and fails closed on bad inputs", () => {
    const target = issuedVersion();
    const before = structuredClone(target);
    buildInvoiceCancellationAccountingEvidence({
      ...input(),
      targetVersion: target,
    });
    expect(target).toEqual(before);
    expect(() =>
      buildInvoiceCancellationAccountingEvidence({
        ...input(),
        actor: { userId: null, name: "Unknown" },
      }),
    ).toThrow(/actor user ID is required/i);
    expect(() =>
      buildInvoiceCancellationAccountingEvidence({
        ...input(),
        nextLifecycleSequence: 0n,
      }),
    ).toThrow(/must follow issuance/i);
    expect(() =>
      buildInvoiceCancellationAccountingEvidence({
        ...input(),
        previousLifecycleEventSha256: "bad",
      }),
    ).toThrow(/digest is invalid/i);
    expect(
      invoiceCancellationObjectPath({
        invoiceNumber: "FV20420042",
        nextVersion: 2n,
        targetVersionId: TARGET_VERSION_ID,
        reasonCode: "incorrect_job",
        recordedAt: CANCELLED_AT,
      }),
    ).toMatch(
      /^\/objects\/invoices\/FV20420042\.cancellation-v2-[0-9a-f]{24}\.pdf$/,
    );
  });
});
