import { describe, expect, it } from "vitest";
import type { BillingSettings, Invoice, InvoiceLine } from "@workspace/db";
import {
  buildIssuedInvoiceAccountingEvidence,
  isAccountingIssueInvoiceDualWriteEnabled,
} from "../src/lib/accounting-invoice-issue-evidence";
import { canonicalAccountingDecimal } from "../src/lib/accounting-evidence-build-utils";
import { verifyAccountingDocumentVersion } from "../src/lib/accounting-document-version-contract";
import { verifyAccountingLifecycleEventBinding } from "../src/lib/accounting-lifecycle-event-contract";

const ISSUED_AT = new Date("2042-03-04T10:00:00.000Z");

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 42,
    invoiceNumber: "FV20420042",
    status: "issued",
    customerId: 9,
    customerName: "Customer s.r.o.",
    customerIc: "12345678",
    customerDic: "CZ12345678",
    customerAddress: "Dlouhá 1, Praha",
    customerEmail: "office@example.test",
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
    subtotalWithoutVat: "200.00",
    totalVat: "42.00",
    totalWithVat: "242.00",
    notes: null,
    paidDate: null,
    paidAmount: null,
    pdfObjectPath: null,
    isdocObjectPath: null,
    createdByUserId: 7,
    issuedByUserId: 7,
    issuedAt: ISSUED_AT,
    cancelledAt: null,
    recurringTemplateId: null,
    createdAt: new Date("2042-03-01T09:00:00.000Z"),
    updatedAt: ISSUED_AT,
    ...overrides,
  };
}

function line(
  id: number,
  sourceType: string,
  subtotal: string,
  vat: string,
  total: string,
  overrides: Partial<InvoiceLine> = {},
): InvoiceLine {
  return {
    id,
    invoiceId: 42,
    sourceType,
    sourceId: id + 100,
    jobId: null,
    activityId: null,
    description: `Line ${id}`,
    quantity: "1.00",
    unit: "ks",
    unitPriceWithoutVat: subtotal,
    discountPercent: null,
    vatRate: "21.00",
    vatMode: "standard",
    totalWithoutVat: subtotal,
    totalVat: vat,
    totalWithVat: total,
    sortOrder: id,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    ...overrides,
  };
}

function settings(): BillingSettings {
  return {
    id: 1,
    supplierName: "MODVOLT s.r.o.",
    supplierIc: "87654321",
    supplierDic: "CZ87654321",
    supplierAddress: "Krátká 2, Brno",
    supplierEmail: "billing@modvolt.example",
    supplierPhone: "+420123456789",
    bankAccount: "123456789/0100",
    iban: "CZ6508000000192000145399",
    bic: "GIBACZPX",
    defaultDueDays: 14,
    defaultPaymentMethod: "bank",
    vatPayer: true,
    vatModeDefault: "standard",
    invoiceFooterNote: null,
    materialMarkupPercent: "0.00",
    transportRatePerKm: "0.00",
    marginAlertThresholdPercent: "0.00",
    numberPrefix: "FV",
    numberFormat: "{PREFIX}{YYYY}{SEQ4}",
    numberYear: 2042,
    numberNextSeq: 43,
    reminderEnabled: false,
    reminderDays: "3,14,30",
    quoteNumberPrefix: "NAB",
    quoteNumberNextSeq: 1,
    updatedAt: ISSUED_AT,
  };
}

function evidenceInput() {
  return {
    invoice: invoice(),
    lines: [
      line(1, "activity_work", "100.00", "21.00", "121.00"),
      line(2, "activity_material", "20.00", "4.20", "24.20"),
      line(3, "quote_item", "50.00", "10.50", "60.50"),
      line(4, "billing_document_line", "30.00", "6.30", "36.30"),
    ],
    invoiceSourceLinks: [
      { jobId: 11, activityId: null, amountWithoutVat: "100.00" },
      { jobId: 11, activityId: null, amountWithoutVat: "20.00" },
      { jobId: null, activityId: 12, amountWithoutVat: "50.00" },
    ],
    workSessionLinks: [
      { sessionId: 13, amountWithoutVatSnapshot: "10.00" },
      { sessionId: 13, amountWithoutVatSnapshot: "5.00" },
    ],
    settings: settings(),
    actor: { userId: 7, name: "Issuer" },
    pdfBuffer: Buffer.from("%PDF-1.7\nissued invoice\n"),
    objectPath: "/objects/invoices/FV20420042.pdf",
  };
}

describe("issued-invoice accounting evidence", () => {
  it("keeps the cutover gate exact and dark by default", () => {
    expect(isAccountingIssueInvoiceDualWriteEnabled({})).toBe(false);
    expect(
      isAccountingIssueInvoiceDualWriteEnabled({
        ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      isAccountingIssueInvoiceDualWriteEnabled({
        ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED: " true ",
      }),
    ).toBe(false);
    expect(
      isAccountingIssueInvoiceDualWriteEnabled({
        ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("normalizes fixed-scale database decimals without rounding", () => {
    expect(canonicalAccountingDecimal("100.00")).toBe("100");
    expect(canonicalAccountingDecimal("1.2300")).toBe("1.23");
    expect(canonicalAccountingDecimal("-0.00")).toBe("0");
    expect(() => canonicalAccountingDecimal("1.23456")).toThrow(/scale/i);
    expect(() => canonicalAccountingDecimal("1e2")).toThrow(/base-10/i);
  });

  it("builds deterministic version, event, artifact and full field provenance", () => {
    const first = buildIssuedInvoiceAccountingEvidence(evidenceInput());
    const second = buildIssuedInvoiceAccountingEvidence(evidenceInput());
    expect(second).toEqual(first);
    expect(() => verifyAccountingDocumentVersion(first.version)).not.toThrow();
    expect(() =>
      verifyAccountingLifecycleEventBinding(first.event, first.version),
    ).not.toThrow();
    expect(first.version.snapshot).toMatchObject({
      kind: "outgoing-invoice",
      invoice: { id: "42", documentType: "invoice" },
      totals: {
        subtotalWithoutVat: "200",
        totalVat: "42",
        totalWithVat: "242",
      },
    });
    if (first.version.snapshot.kind !== "outgoing-invoice") {
      throw new Error("Expected outgoing invoice snapshot.");
    }
    expect(
      first.version.snapshot.lines.map((entry) => entry.sourceType),
    ).toEqual([
      "activity_work",
      "activity_material",
      "quote_item",
      "billing_document_line",
    ]);
    expect(first.version.snapshot.sourceLinks).toEqual([
      { sourceType: "job", sourceId: "11", amountWithoutVat: "120" },
      { sourceType: "work_session", sourceId: "13", amountWithoutVat: "15" },
      {
        sourceType: "billing_document_line",
        sourceId: "104",
        amountWithoutVat: "30",
      },
      { sourceType: "activity", sourceId: "12", amountWithoutVat: "50" },
    ]);
    expect(first.version.provenance.captureMode).toBe("native");
    if (first.version.provenance.captureMode !== "native") {
      throw new Error("Expected native provenance.");
    }
    expect(first.version.provenance.fieldProvenance).toHaveLength(
      new Set(
        first.version.provenance.fieldProvenance.map(
          (entry) => entry.jsonPointer,
        ),
      ).size,
    );
    expect(first.event).toMatchObject({
      eventType: "issued",
      reasonCode: "document_issued",
      evidenceSha256: first.approvalEvidenceSha256,
    });
    expect(first.version.artifacts[0]).toMatchObject({
      role: "rendered-pdf",
      contentSha256: first.pdfContentSha256,
      objectLocationSha256: first.objectLocationSha256,
      rendererVersion: "invoice-pdf/v1",
    });
  });

  it("fails closed on missing actor identity and unknown line source types", () => {
    expect(() =>
      buildIssuedInvoiceAccountingEvidence({
        ...evidenceInput(),
        actor: { userId: null, name: "Unknown" },
      }),
    ).toThrow(/actor user ID is required/i);
    const input = evidenceInput();
    input.lines[0] = { ...input.lines[0]!, sourceType: "unregistered_source" };
    expect(() => buildIssuedInvoiceAccountingEvidence(input)).toThrow(
      /unsupported issued-invoice source type/i,
    );
  });
});
