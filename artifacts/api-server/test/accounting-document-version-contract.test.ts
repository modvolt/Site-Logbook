import { describe, expect, it } from "vitest";
import {
  accountingSnapshotLeafPointers,
  buildUniformAccountingFieldProvenance,
  canonicalAccountingDocumentVersionJson,
  createAccountingDocumentVersion,
  verifyAccountingDocumentVersion,
  verifyCanonicalAccountingDocumentVersionJsonBytes,
  type AccountingDocumentVersionV1,
  type AccountingSnapshotV1,
  type CreateAccountingDocumentVersionInputV1,
} from "../src/lib/accounting-document-version-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const AT = "2042-03-04T10:00:00.000Z";
const RECORDED_AT = "2042-03-04T10:01:00.000Z";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PDF_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

function party(name: string) {
  return {
    name,
    ic: "12345678",
    dic: "CZ12345678",
    address: "Dlouhá 1, Praha",
    email: "office@example.test",
    phone: "+420123456789",
  } as const;
}

function invoiceSnapshot(
  input: {
    id?: string;
    documentType?:
      | "invoice"
      | "credit_note"
      | "correction_invoice"
      | "cancellation_notice";
    totalWithoutVat?: string;
    totalVat?: string;
    totalWithVat?: string;
    legacyPayment?: boolean;
  } = {},
): AccountingSnapshotV1 {
  const totalWithoutVat = input.totalWithoutVat ?? "100";
  const totalVat = input.totalVat ?? "21";
  const totalWithVat = input.totalWithVat ?? "121";
  return {
    kind: "outgoing-invoice",
    invoice: {
      id: input.id ?? "42",
      invoiceNumber: "FV-2042-001",
      documentType: input.documentType ?? "invoice",
      issueDate: "2042-03-04",
      taxableSupplyDate: "2042-03-04",
      dueDate: "2042-03-18",
      currency: "CZK",
      paymentMethod: "bank_transfer",
      variableSymbol: "2042001",
      constantSymbol: null,
      specificSymbol: null,
      vatModeDefault: "standard",
      materialDisplayMode: "detailed",
      notes: null,
    },
    customer: { ...party("Customer s.r.o."), customerId: "9" },
    supplier: {
      ...party("MODVOLT s.r.o."),
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
        unitPriceWithoutVat: totalWithoutVat,
        discountPercent: null,
        vatRate: "21",
        vatMode: "standard",
        totalWithoutVat,
        totalVat,
        totalWithVat,
      },
    ],
    sourceLinks: [
      {
        sourceType: "job",
        sourceId: "77",
        amountWithoutVat: totalWithoutVat,
      },
    ],
    totals: { subtotalWithoutVat: totalWithoutVat, totalVat, totalWithVat },
    legacyPaymentObservation: input.legacyPayment
      ? {
          paidDate: "2042-03-10",
          paidAmount: "121",
          historicalCompleteness: "unknown",
        }
      : null,
  };
}

function costSnapshot(): AccountingSnapshotV1 {
  return {
    kind: "incoming-cost-document",
    document: {
      id: "88",
      documentType: "invoice",
      source: "manual",
      sourceRefSha256: null,
      documentNumber: "PF-2042-88",
      issueDate: "2042-03-01",
      taxableSupplyDate: "2042-03-01",
      dueDate: "2042-03-15",
      currency: "CZK",
      variableSymbol: "204288",
      constantSymbol: null,
      specificSymbol: null,
      bankAccount: "987654321/0100",
      iban: null,
      bic: null,
      deliveryNoteResolution: "not_required",
      deliveryNoteResolutionReason: "Dodavatel dodací list nevystavuje",
      customerId: null,
      jobId: "77",
      notes: null,
    },
    supplier: party("Supplier s.r.o."),
    lines: [
      {
        position: 1,
        sourceLineId: "1",
        lineType: "material",
        description: "Kabel",
        quantity: "10",
        unit: "m",
        originalUnit: "10m",
        unitPriceWithoutVat: "10",
        vatRate: "21",
        vatMode: "standard",
        totalWithoutVat: "100",
        totalVat: "21",
        totalWithVat: "121",
        supplierSku: "KABEL-1",
        ean: null,
        manufacturer: null,
        discountPercent: null,
        listPriceWithoutVat: null,
        priceBeforeDiscount: null,
        priceAfterDiscount: null,
        feeType: null,
        environmentalFee: null,
        recyclingFee: null,
        deliveryNoteNumber: null,
        orderNumber: null,
        supplierOrderNumber: null,
        sourceLineNumber: "1",
        jobId: "77",
        activityId: null,
        allocationType: "rebill",
        matchConfirmed: true,
      },
    ],
    totals: {
      subtotalWithoutVat: "100",
      totalVat: "21",
      totalWithVat: "121",
    },
    fileRefs: [{ artifactId: SOURCE_ID, role: "primary", pageIndex: null }],
    references: [],
    sourceTrace: {
      capturePolicy: "human-approved-final-state/v1" as const,
      originalSource: "manual" as const,
      parsedBy: null,
      extractionVersion: 1,
      documentTypeSource: "user" as const,
      documentTypeConfirmedByUserId: "7",
      documentTypeConfirmedAt: AT,
      aiEvidence: null,
    },
  };
}

function nativeProvenance(snapshot: AccountingSnapshotV1) {
  return {
    captureMode: "native" as const,
    sourceMode: "human" as const,
    recordedBy: {
      kind: "user" as const,
      id: "7",
      authentication: "step-up" as const,
    },
    approvalEvidenceSha256: HASH_D,
    fieldProvenance: buildUniformAccountingFieldProvenance(snapshot, {
      source: "human",
      actorRef: "user:7",
      sourceEvidenceSha256: null,
      extractionRunId: null,
      recordedAt: AT,
    }),
  };
}

function pdfArtifact() {
  return {
    artifactId: PDF_ID,
    role: "rendered-pdf" as const,
    mediaType: "application/pdf",
    contentSha256: HASH_A,
    sizeBytes: "4096",
    objectLocationSha256: HASH_B,
    rendererVersion: "invoice-pdf/v1",
  };
}

function sourceArtifact() {
  return {
    artifactId: SOURCE_ID,
    role: "original-source" as const,
    mediaType: "application/pdf",
    contentSha256: HASH_B,
    sizeBytes: "2048",
    objectLocationSha256: HASH_C,
    rendererVersion: null,
  };
}

function nativeInvoiceInput(
  overrides: Partial<CreateAccountingDocumentVersionInputV1> = {},
): CreateAccountingDocumentVersionInputV1 {
  const snapshot = invoiceSnapshot();
  return {
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: VERSION_ID,
    aggregate: { kind: "outgoing-invoice", id: "42" },
    version: "1",
    purpose: "issued",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    effectiveAt: AT,
    recordedAt: RECORDED_AT,
    snapshot,
    artifacts: [pdfArtifact()],
    provenance: nativeProvenance(snapshot),
    ...overrides,
  } as CreateAccountingDocumentVersionInputV1;
}

function costInput(
  overrides: Partial<CreateAccountingDocumentVersionInputV1> = {},
): CreateAccountingDocumentVersionInputV1 {
  const snapshot = costSnapshot();
  return {
    schemaVersion: "site-logbook.accounting-document-version/v1",
    versionId: "44444444-4444-4444-8444-444444444444",
    aggregate: { kind: "incoming-cost-document", id: "88" },
    version: "1",
    purpose: "approved",
    supersedesVersionId: null,
    historicalCompleteness: "complete",
    effectiveAt: AT,
    recordedAt: RECORDED_AT,
    snapshot,
    artifacts: [sourceArtifact()],
    provenance: nativeProvenance(snapshot),
    ...overrides,
  } as CreateAccountingDocumentVersionInputV1;
}

function recreateWithSnapshot(
  input: CreateAccountingDocumentVersionInputV1,
  snapshot: AccountingSnapshotV1,
): CreateAccountingDocumentVersionInputV1 {
  return {
    ...input,
    snapshot,
    aggregate: {
      ...input.aggregate,
      id:
        snapshot.kind === "outgoing-invoice"
          ? snapshot.invoice.id
          : snapshot.document.id,
    },
    provenance: nativeProvenance(snapshot),
  };
}

describe("accounting document version contract", () => {
  it("creates a canonical complete invoice snapshot with artifact and leaf provenance hashes", () => {
    const version = createAccountingDocumentVersion(nativeInvoiceInput());
    expect(version.integrity.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version.integrity.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version.integrity.versionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      version.provenance.fieldProvenance.map((entry) => entry.jsonPointer),
    ).toEqual(accountingSnapshotLeafPointers(version.snapshot));
    expect(verifyAccountingDocumentVersion(version)).toEqual(version);
    const canonical = canonicalAccountingDocumentVersionJson(version);
    expect(
      verifyCanonicalAccountingDocumentVersionJsonBytes(canonical),
    ).toEqual(version);
  });

  it("rejects snapshot, artifact, and integrity tampering", () => {
    const version = createAccountingDocumentVersion(nativeInvoiceInput());
    expect(() =>
      verifyAccountingDocumentVersion({
        ...version,
        snapshot: {
          ...version.snapshot,
          totals: { ...version.snapshot.totals, totalWithVat: "122" },
        },
      }),
    ).toThrow();
    expect(() =>
      verifyAccountingDocumentVersion({
        ...version,
        artifacts: [{ ...version.artifacts[0]!, contentSha256: HASH_C }],
      }),
    ).toThrow(/integrity/i);
    expect(() =>
      verifyAccountingDocumentVersion({
        ...version,
        integrity: { ...version.integrity, versionSha256: HASH_C },
      }),
    ).toThrow(/integrity/i);
  });

  it("requires complete, unique, canonically ordered field-level provenance", () => {
    const input = nativeInvoiceInput();
    const fieldProvenance = [...(input.provenance as any).fieldProvenance];
    expect(() =>
      createAccountingDocumentVersion({
        ...input,
        provenance: {
          ...(input.provenance as any),
          fieldProvenance: fieldProvenance.slice(1),
        },
      } as never),
    ).toThrow(/every snapshot leaf/i);
    expect(() =>
      createAccountingDocumentVersion({
        ...input,
        provenance: {
          ...(input.provenance as any),
          fieldProvenance: [
            fieldProvenance[1],
            fieldProvenance[0],
            ...fieldProvenance.slice(2),
          ],
        },
      } as never),
    ).toThrow(/canonical order/i);
  });

  it("rejects unknown raw AI payloads and noncanonical JSON bytes", () => {
    const version = createAccountingDocumentVersion(nativeInvoiceInput());
    expect(() =>
      createAccountingDocumentVersion({
        ...nativeInvoiceInput(),
        snapshot: { ...invoiceSnapshot(), aiRawJson: "raw model output" },
      } as never),
    ).toThrow();
    expect(() =>
      verifyCanonicalAccountingDocumentVersionJsonBytes(
        `${canonicalAccountingDocumentVersionJson(version)}\n`,
      ),
    ).toThrow(/not canonical/i);
  });

  it("rejects invoice total, sign, date, purpose, and source-link drift", () => {
    const base = nativeInvoiceInput();
    const wrongTotal = invoiceSnapshot({ totalWithVat: "120" });
    expect(() =>
      createAccountingDocumentVersion(recreateWithSnapshot(base, wrongTotal)),
    ).toThrow(/do not add up|does not match/i);

    const credit = invoiceSnapshot({
      documentType: "credit_note",
      totalWithoutVat: "100",
      totalVat: "21",
      totalWithVat: "121",
    });
    expect(() =>
      createAccountingDocumentVersion(
        recreateWithSnapshot({ ...base, purpose: "credit" }, credit),
      ),
    ).toThrow(/total sign/i);

    const lateIssue = invoiceSnapshot() as Extract<
      AccountingSnapshotV1,
      { kind: "outgoing-invoice" }
    >;
    lateIssue.invoice.dueDate = "2042-03-01";
    expect(() =>
      createAccountingDocumentVersion(recreateWithSnapshot(base, lateIssue)),
    ).toThrow(/due date/i);

    expect(() =>
      createAccountingDocumentVersion({ ...base, purpose: "correction" }),
    ).toThrow(/purpose/i);

    const duplicateSource = invoiceSnapshot() as Extract<
      AccountingSnapshotV1,
      { kind: "outgoing-invoice" }
    >;
    duplicateSource.sourceLinks = [
      ...duplicateSource.sourceLinks,
      { ...duplicateSource.sourceLinks[0]!, amountWithoutVat: "99" },
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
    expect(() =>
      createAccountingDocumentVersion(
        recreateWithSnapshot(base, duplicateSource),
      ),
    ).toThrow(/source links/i);
  });

  it("creates an approved cost-document version bound to its original source", () => {
    const version = createAccountingDocumentVersion(costInput());
    expect(version).toMatchObject({
      aggregate: { kind: "incoming-cost-document", id: "88" },
      purpose: "approved",
      historicalCompleteness: "complete",
    });
    expect(version.artifacts[0]?.role).toBe("original-source");
  });

  it("keeps AI and human field provenance explicit at leaf level", () => {
    const snapshot = costSnapshot();
    const fieldProvenance = buildUniformAccountingFieldProvenance(snapshot, {
      source: "ai",
      actorRef: "system:document-extractor",
      sourceEvidenceSha256: HASH_A,
      extractionRunId: "73",
      recordedAt: AT,
    }).map((entry) =>
      entry.jsonPointer === "/document/documentType"
        ? {
            ...entry,
            source: "human" as const,
            actorRef: "user:7",
            sourceEvidenceSha256: null,
            extractionRunId: null,
          }
        : entry,
    );
    const version = createAccountingDocumentVersion({
      ...costInput(),
      provenance: {
        captureMode: "native",
        sourceMode: "ai-assisted",
        recordedBy: {
          kind: "user",
          id: "7",
          authentication: "step-up",
        },
        approvalEvidenceSha256: HASH_D,
        fieldProvenance,
      },
    });
    expect(
      version.provenance.captureMode === "native"
        ? version.provenance.fieldProvenance.find(
            (entry) => entry.jsonPointer === "/document/documentType",
          )?.source
        : null,
    ).toBe("human");
    expect(() =>
      buildUniformAccountingFieldProvenance(snapshot, {
        source: "ai",
        actorRef: "system:document-extractor",
        sourceEvidenceSha256: null,
        extractionRunId: "73",
        recordedAt: AT,
      }),
    ).toThrow(/AI provenance/i);
  });

  it("rejects cost source, file-role, resolution, total-sign, and date contradictions", () => {
    const base = costInput();
    const importedWithoutRef = costSnapshot() as Extract<
      AccountingSnapshotV1,
      { kind: "incoming-cost-document" }
    >;
    importedWithoutRef.document.source = "email";
    expect(() =>
      createAccountingDocumentVersion(
        recreateWithSnapshot(base, importedWithoutRef),
      ),
    ).toThrow(/digest reference/i);

    const wrongResolution = costSnapshot() as Extract<
      AccountingSnapshotV1,
      { kind: "incoming-cost-document" }
    >;
    wrongResolution.document.deliveryNoteResolution = "required";
    expect(() =>
      createAccountingDocumentVersion(
        recreateWithSnapshot(base, wrongResolution),
      ),
    ).toThrow(/resolution reason/i);

    expect(() =>
      createAccountingDocumentVersion({
        ...base,
        artifacts: [{ ...sourceArtifact(), role: "structured-isdoc" }],
      } as never),
    ).toThrow(/file roles/i);

    const negativeInvoice = costSnapshot() as Extract<
      AccountingSnapshotV1,
      { kind: "incoming-cost-document" }
    >;
    negativeInvoice.lines[0] = {
      ...negativeInvoice.lines[0]!,
      totalWithoutVat: "-100",
      totalVat: "-21",
      totalWithVat: "-121",
    };
    negativeInvoice.totals = {
      subtotalWithoutVat: "-100",
      totalVat: "-21",
      totalWithVat: "-121",
    };
    expect(() =>
      createAccountingDocumentVersion(
        recreateWithSnapshot(base, negativeInvoice),
      ),
    ).toThrow(/total sign/i);
  });

  it("requires native output artifacts and strict version predecessor semantics", () => {
    expect(() =>
      createAccountingDocumentVersion({
        ...nativeInvoiceInput(),
        artifacts: [],
      }),
    ).toThrow(/rendered PDF/i);
    expect(() =>
      createAccountingDocumentVersion({ ...costInput(), artifacts: [] }),
    ).toThrow();
    expect(() =>
      createAccountingDocumentVersion({
        ...nativeInvoiceInput(),
        version: "2",
        supersedesVersionId: null,
      }),
    ).toThrow(/version one/i);
  });

  it("records one explicitly unknown legacy observation without fabricated event provenance", () => {
    const snapshot = invoiceSnapshot({ legacyPayment: true });
    const legacy = createAccountingDocumentVersion({
      schemaVersion: "site-logbook.accounting-document-version/v1",
      versionId: "55555555-5555-4555-8555-555555555555",
      aggregate: { kind: "outgoing-invoice", id: "42" },
      version: "1",
      purpose: "legacy_observation",
      supersedesVersionId: null,
      historicalCompleteness: "unknown",
      effectiveAt: null,
      recordedAt: RECORDED_AT,
      snapshot,
      artifacts: [pdfArtifact()],
      provenance: {
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
    expect(legacy.snapshot).toMatchObject({
      legacyPaymentObservation: { historicalCompleteness: "unknown" },
    });
    expect(legacy.provenance).toMatchObject({
      captureMode: "legacy-observation",
      fieldProvenance: [],
    });

    expect(() =>
      createAccountingDocumentVersion({
        ...nativeInvoiceInput(),
        snapshot: invoiceSnapshot({ legacyPayment: true }),
      } as never),
    ).toThrow(/legacy version/i);
    expect(() =>
      createAccountingDocumentVersion({
        ...legacy,
        effectiveAt: AT,
        provenance: nativeProvenance(snapshot),
      } as never),
    ).toThrow();
  });

  it("rejects aggregate identity drift and semantic rehash attempts at creation", () => {
    expect(() =>
      createAccountingDocumentVersion({
        ...nativeInvoiceInput(),
        aggregate: { kind: "outgoing-invoice", id: "43" },
      }),
    ).toThrow(/IDs must match/i);
    const version = createAccountingDocumentVersion(nativeInvoiceInput());
    expect(() =>
      verifyAccountingDocumentVersion({
        ...version,
        unexpected: true,
      }),
    ).toThrow();
  });
});
