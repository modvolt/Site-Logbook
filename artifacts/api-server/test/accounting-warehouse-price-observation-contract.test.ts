import { describe, expect, it } from "vitest";
import type {
  BillingDocument,
  BillingDocumentFile,
  BillingDocumentLine,
} from "@workspace/db";
import { buildApprovedCostDocumentAccountingEvidence } from "../src/lib/accounting-cost-document-approval-evidence";
import {
  buildCorrectedCostDocumentAccountingEvidence,
  buildCostDocumentReviewReopenEvidence,
} from "../src/lib/accounting-cost-document-correction-evidence";
import {
  canonicalAccountingWarehousePriceObservationJson,
  createAccountingWarehousePriceObservation,
  verifyAccountingWarehousePriceChainStep,
  verifyAccountingWarehousePriceObservation,
  verifyAccountingWarehousePriceSourceBinding,
  verifyCanonicalAccountingWarehousePriceObservationJsonBytes,
  type AccountingWarehousePriceObservationV1,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import {
  appendAccountingWarehousePriceObservationInTransaction,
  type AccountingWarehousePricePersistenceTransactionV1,
} from "../src/lib/accounting-warehouse-price-persistence";
import type { AccountingDocumentVersionV1 } from "../src/lib/accounting-document-version-contract";
import type { AccountingLifecycleEventV1 } from "../src/lib/accounting-lifecycle-event-contract";
import {
  canonicalAccountingExportIntentJson,
  createAccountingWarehousePriceExportIntent,
  verifyAccountingExportIntent,
  verifyCanonicalAccountingExportIntentJsonBytes,
  type AccountingExportIntentV1,
} from "../src/lib/accounting-persistence-contract";

const INITIAL_AT = new Date("2042-07-01T10:00:00.000Z");
const REOPENED_AT = new Date("2042-07-02T09:00:00.000Z");
const CORRECTED_AT = new Date("2042-07-03T11:00:00.000Z");
const SOURCE_HASH = "a".repeat(64);
const MATCH_HASH = "b".repeat(64);

function document(overrides: Partial<BillingDocument> = {}): BillingDocument {
  return {
    id: 88,
    status: "approved",
    docType: "receipt",
    declaredDocType: "receipt",
    detectedDocType: null,
    detectedDocTypeConfidence: null,
    docTypeSource: "admin",
    docTypeConfirmedByUserId: 7,
    docTypeConfirmedAt: new Date("2042-07-01T09:00:00.000Z"),
    source: "manual",
    sourceRef: null,
    objectPath: "/objects/cost/88.pdf",
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    fileSize: 2048,
    sha256: SOURCE_HASH,
    supplierName: "Supplier s.r.o.",
    supplierIc: "12345678",
    supplierDic: null,
    supplierAddress: "Dlouhá 1, Praha",
    documentNumber: "PD-2042-88",
    variableSymbol: null,
    issueDate: "2042-07-01",
    taxableSupplyDate: "2042-07-01",
    dueDate: null,
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
    deliveryNoteResolutionReason: "Dodací list není vyžadován",
    deliveryNoteResolutionByUserId: 7,
    deliveryNoteResolutionAt: INITIAL_AT,
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
    warnings: null,
    aiRawJson: null,
    aiConfidence: null,
    aiModel: null,
    aiExtractedAt: null,
    createdByUserId: 7,
    reviewedByUserId: 7,
    reviewedAt: INITIAL_AT,
    createdAt: new Date("2042-07-01T08:00:00.000Z"),
    updatedAt: INITIAL_AT,
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
    originalUnit: null,
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
    allocationType: "stock",
    matchConfidence: null,
    matchConfirmed: 1,
    approved: 1,
    warehouseState: "assigned_to_stock",
    invoicedInvoiceId: null,
    sortOrder: 0,
    createdAt: INITIAL_AT,
    updatedAt: INITIAL_AT,
    ...overrides,
  };
}

function file(): BillingDocumentFile {
  return {
    id: 1,
    documentId: 88,
    role: "primary",
    originalFileName: "receipt.pdf",
    mimeType: "application/pdf",
    objectPath: "/objects/cost/88.pdf",
    sha256Hash: SOURCE_HASH,
    pageIndex: null,
    sizeBytes: 2048,
    createdAt: INITIAL_AT,
  };
}

function approvalInput(
  overrides: {
    document?: Partial<BillingDocument>;
    line?: Partial<BillingDocumentLine>;
  } = {},
) {
  return {
    document: document(overrides.document),
    lines: [line(overrides.line)],
    files: [file()],
    references: [],
    latestCompletedExtractionJobId: null,
    actor: { userId: 7, name: "Reviewer" },
  };
}

function observation(input: {
  id: string;
  sequence: number;
  previous: AccountingWarehousePriceObservationV1 | null;
  supersedes: AccountingWarehousePriceObservationV1 | null;
  transition: "observed" | "corrected" | "withdrawn";
  version: AccountingDocumentVersionV1;
  event: AccountingLifecycleEventV1;
  price: string | null;
}) {
  return createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId: input.id,
    warehouseItemId: "41",
    sequence: String(input.sequence),
    previousObservationSha256: input.previous?.integrity.entrySha256 ?? null,
    supersedesObservationId: input.supersedes?.observationId ?? null,
    transition: input.transition,
    source: {
      aggregateId: input.version.aggregate.id,
      accountingVersionId: input.version.versionId,
      accountingVersionSha256: input.version.integrity.versionSha256,
      lifecycleEventId: input.event.eventId,
      lifecycleEventSha256: input.event.integrity.entrySha256,
      sourceLineId: "501",
    },
    purchasePrice: input.price,
    currency: "CZK",
    warehouseMatch:
      input.transition === "withdrawn"
        ? null
        : { mode: "code", evidenceSha256: MATCH_HASH },
    actor: input.event.actor,
    reasonCode: input.event.reasonCode as
      | "document_approved"
      | "correction_approved"
      | "review_reopened",
    reasonDetailSha256: input.event.reasonDetailSha256,
    effectiveAt: input.event.effectiveAt,
    recordedAt: input.event.recordedAt,
  });
}

function chain() {
  const initial = buildApprovedCostDocumentAccountingEvidence(approvalInput());
  const observed = observation({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: 0,
    previous: null,
    supersedes: null,
    transition: "observed",
    version: initial.version,
    event: initial.event,
    price: "10",
  });
  const reopen = buildCostDocumentReviewReopenEvidence({
    currentVersion: initial.version,
    nextLifecycleSequence: 1n,
    previousLifecycleEventSha256: initial.event.integrity.entrySha256,
    actor: { userId: 7, name: "Reviewer" },
    reason: "Oprava nákupní ceny",
    recordedAt: REOPENED_AT,
  });
  const withdrawn = observation({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 1,
    previous: observed,
    supersedes: observed,
    transition: "withdrawn",
    version: initial.version,
    event: reopen.event,
    price: null,
  });
  const corrected = buildCorrectedCostDocumentAccountingEvidence({
    ...approvalInput({
      document: {
        subtotalWithoutVat: "120.00",
        totalVat: "25.20",
        totalWithVat: "145.20",
        reviewedAt: CORRECTED_AT,
        updatedAt: CORRECTED_AT,
      },
      line: {
        unitPriceWithoutVat: "12.00",
        totalWithoutVat: "120.00",
        totalVat: "25.20",
        totalWithVat: "145.20",
        updatedAt: CORRECTED_AT,
      },
    }),
    targetVersion: initial.version,
    reopenEvent: reopen.event,
  });
  const correctedObservation = observation({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sequence: 2,
    previous: withdrawn,
    supersedes: withdrawn,
    transition: "corrected",
    version: corrected.correctionVersion,
    event: corrected.event,
    price: "12",
  });
  return {
    initial,
    observed,
    reopen,
    withdrawn,
    corrected,
    correctedObservation,
  };
}

class FakeWarehousePriceTransaction implements AccountingWarehousePricePersistenceTransactionV1 {
  readonly operations: string[] = [];
  readonly observations = new Map<
    string,
    AccountingWarehousePriceObservationV1
  >();
  readonly intents = new Map<string, AccountingExportIntentV1>();
  failInsert = false;
  failIntentInsert = false;

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  seed(...observations: AccountingWarehousePriceObservationV1[]) {
    for (const observation of observations) {
      this.observations.set(observation.observationId, this.clone(observation));
    }
  }

  async lockWarehousePriceStreamForUpdate(warehouseItemId: string) {
    this.operations.push(`lock-item:${warehouseItemId}`);
    const matches = [...this.observations.values()]
      .filter((value) => value.warehouseItemId === warehouseItemId)
      .sort((left, right) =>
        BigInt(left.sequence) < BigInt(right.sequence) ? 1 : -1,
      );
    return this.clone(matches[0] ?? null);
  }

  async loadWarehousePriceObservationById(observationId: string) {
    this.operations.push(`load-observation:${observationId}`);
    return this.clone(this.observations.get(observationId) ?? null);
  }

  async insertWarehousePriceObservation(
    observationValue: AccountingWarehousePriceObservationV1,
  ) {
    this.operations.push(
      `insert-observation:${observationValue.observationId}`,
    );
    if (this.failInsert)
      throw new Error("injected warehouse-price insert fault");
    this.observations.set(
      observationValue.observationId,
      this.clone(observationValue),
    );
  }

  async loadExportIntentById(intentId: string) {
    this.operations.push(`load-intent:${intentId}`);
    return this.clone(this.intents.get(intentId) ?? null);
  }

  async insertExportIntent(intent: AccountingExportIntentV1) {
    this.operations.push(`insert-intent:${intent.intentId}`);
    if (this.failIntentInsert) {
      throw new Error("injected warehouse-price export-intent fault");
    }
    this.intents.set(intent.intentId, this.clone(intent));
  }
}

describe("accounting warehouse-price observation contract", () => {
  it("binds an initial price to the approved version and lifecycle event", () => {
    const { initial, observed } = chain();
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        observed,
        initial.version,
        initial.event,
      ),
    ).not.toThrow();
    const canonical =
      canonicalAccountingWarehousePriceObservationJson(observed);
    expect(
      verifyCanonicalAccountingWarehousePriceObservationJsonBytes(canonical),
    ).toEqual(observed);
  });

  it("models reopen withdrawal and corrected price as contiguous append-only steps", () => {
    const {
      initial,
      observed,
      reopen,
      withdrawn,
      corrected,
      correctedObservation,
    } = chain();
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        withdrawn,
        initial.version,
        reopen.event,
      ),
    ).not.toThrow();
    expect(() =>
      verifyAccountingWarehousePriceChainStep(observed, withdrawn, observed),
    ).not.toThrow();
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        correctedObservation,
        corrected.correctionVersion,
        corrected.event,
      ),
    ).not.toThrow();
    expect(() =>
      verifyAccountingWarehousePriceChainStep(
        withdrawn,
        correctedObservation,
        withdrawn,
      ),
    ).not.toThrow();
  });

  it("rejects source-price, event and chain substitutions", () => {
    const {
      initial,
      observed,
      reopen,
      withdrawn,
      corrected,
      correctedObservation,
    } = chain();
    const { integrity: _observedIntegrity, ...observedBody } = observed;
    const wrongPrice = createAccountingWarehousePriceObservation({
      ...observedBody,
      purchasePrice: "11",
    });
    const wrongCurrency = createAccountingWarehousePriceObservation({
      ...observedBody,
      currency: "EUR",
    });
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        wrongPrice,
        initial.version,
        initial.event,
      ),
    ).toThrow(/purchase price/i);
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        wrongCurrency,
        initial.version,
        initial.event,
      ),
    ).toThrow(/currency/i);
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        observed,
        initial.version,
        reopen.event,
      ),
    ).toThrow(/source event|lifecycle event/i);
    expect(() =>
      verifyAccountingWarehousePriceChainStep(
        observed,
        correctedObservation,
        withdrawn,
      ),
    ).toThrow(/chain step/i);
    expect(() =>
      verifyAccountingWarehousePriceChainStep(
        withdrawn,
        correctedObservation,
        observed,
      ),
    ).toThrow(/supersede|chain step/i);

    const {
      integrity: _correctedObservationIntegrity,
      ...correctedObservationBody
    } = correctedObservation;
    const wrongWarehouseItem = createAccountingWarehousePriceObservation({
      ...correctedObservationBody,
      warehouseItemId: "42",
    });
    expect(() =>
      verifyAccountingWarehousePriceChainStep(
        withdrawn,
        wrongWarehouseItem,
        withdrawn,
      ),
    ).toThrow(/chain step/i);

    const wrongPreviousDigest = createAccountingWarehousePriceObservation({
      ...correctedObservationBody,
      previousObservationSha256: "0".repeat(64),
    });
    expect(() =>
      verifyAccountingWarehousePriceChainStep(
        withdrawn,
        wrongPreviousDigest,
        withdrawn,
      ),
    ).toThrow(/chain step/i);
    expect(corrected.correctionVersion.version).toBe("2");
  });

  it("rejects non-material source lines", () => {
    const initial = buildApprovedCostDocumentAccountingEvidence(
      approvalInput({ line: { lineType: "work" } }),
    );
    const observed = observation({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sequence: 0,
      previous: null,
      supersedes: null,
      transition: "observed",
      version: initial.version,
      event: initial.event,
      price: "10",
    });
    expect(() =>
      verifyAccountingWarehousePriceSourceBinding(
        observed,
        initial.version,
        initial.event,
      ),
    ).toThrow(/not material/i);
  });

  it("rejects semantic, integrity, extra-key and noncanonical-byte mutations", () => {
    const { observed } = chain();
    const { integrity: _observedIntegrity, ...observedBody } = observed;
    expect(() =>
      createAccountingWarehousePriceObservation({
        ...observedBody,
        transition: "withdrawn",
      }),
    ).toThrow(/reason|amount|match/i);
    expect(
      createAccountingWarehousePriceObservation({
        ...observedBody,
        transition: "corrected",
        reasonCode: "correction_approved",
        reasonDetailSha256: SOURCE_HASH,
      }).transition,
    ).toBe("corrected");
    expect(() =>
      createAccountingWarehousePriceObservation({
        ...observedBody,
        transition: "withdrawn",
        purchasePrice: null,
        warehouseMatch: null,
        reasonCode: "review_reopened",
        reasonDetailSha256: SOURCE_HASH,
      }),
    ).toThrow(/first.*withdrawal/i);

    const tampered = structuredClone(observed);
    tampered.purchasePrice = "11";
    expect(() => verifyAccountingWarehousePriceObservation(tampered)).toThrow(
      /integrity/i,
    );
    expect(() =>
      verifyAccountingWarehousePriceObservation({ ...observed, extra: true }),
    ).toThrow();
    expect(() =>
      verifyCanonicalAccountingWarehousePriceObservationJsonBytes(
        `${canonicalAccountingWarehousePriceObservationJson(observed)}\n`,
      ),
    ).toThrow(/canonical JSON/i);
  });

  it("creates one exact canonical export intent for each observation", () => {
    const { observed } = chain();
    const intent = createAccountingWarehousePriceExportIntent(observed);
    expect(intent).toMatchObject({
      intentId: observed.observationId,
      operation: "warehouse-price-observation",
      affectedAggregates: [
        {
          kind: "incoming-cost-document",
          id: observed.source.aggregateId,
        },
      ],
      entries: [
        {
          kind: "warehouse-price-observation",
          id: observed.observationId,
          sha256: observed.integrity.entrySha256,
        },
      ],
      recordedAt: observed.recordedAt,
    });
    expect(
      verifyCanonicalAccountingExportIntentJsonBytes(
        canonicalAccountingExportIntentJson(intent),
      ),
    ).toEqual(intent);
    expect(() =>
      verifyAccountingExportIntent({
        ...intent,
        entries: [],
      }),
    ).toThrow(/entries|atomic accounting operation|too small/i);
    expect(() =>
      verifyAccountingExportIntent({
        ...intent,
        entries: [
          {
            ...intent.entries[0],
            kind: "lifecycle-event",
          },
        ],
      }),
    ).toThrow(/entry kind|operation|count/i);
  });
});

describe("accounting warehouse-price transaction persistence", () => {
  it("serializes initial, withdrawal and correction appends and treats exact replay as a no-op", async () => {
    const {
      initial,
      observed,
      reopen,
      withdrawn,
      corrected,
      correctedObservation,
    } = chain();
    const transaction = new FakeWarehousePriceTransaction();

    const first = await appendAccountingWarehousePriceObservationInTransaction(
      transaction,
      observed,
      initial.version,
      initial.event,
    );
    expect(first).toMatchObject({
      replay: false,
      intent: {
        operation: "warehouse-price-observation",
        entries: [{ kind: "warehouse-price-observation" }],
      },
    });
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        transaction,
        observed,
        initial.version,
        initial.event,
      ),
    ).resolves.toMatchObject({ replay: true });
    await appendAccountingWarehousePriceObservationInTransaction(
      transaction,
      withdrawn,
      initial.version,
      reopen.event,
    );
    await appendAccountingWarehousePriceObservationInTransaction(
      transaction,
      correctedObservation,
      corrected.correctionVersion,
      corrected.event,
    );

    expect(transaction.observations.size).toBe(3);
    expect(transaction.intents.size).toBe(3);
    expect(
      transaction.operations.filter((operation) =>
        operation.startsWith("insert-observation:"),
      ),
    ).toHaveLength(3);
    expect(
      transaction.operations.filter((operation) =>
        operation.startsWith("insert-intent:"),
      ),
    ).toHaveLength(3);
  });

  it("rejects missing predecessors, mismatched replay bytes and insert faults", async () => {
    const { initial, observed, corrected, correctedObservation } = chain();
    const missingPredecessor = new FakeWarehousePriceTransaction();
    missingPredecessor.seed(observed);
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        missingPredecessor,
        correctedObservation,
        corrected.correctionVersion,
        corrected.event,
      ),
    ).rejects.toThrow(/not persisted/i);

    const { integrity: _integrity, ...observedBody } = observed;
    const differentExisting = createAccountingWarehousePriceObservation({
      ...observedBody,
      warehouseMatch: { mode: "manual", evidenceSha256: MATCH_HASH },
    });
    const mismatchedReplay = new FakeWarehousePriceTransaction();
    mismatchedReplay.seed(differentExisting);
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        mismatchedReplay,
        observed,
        initial.version,
        initial.event,
      ),
    ).rejects.toThrow(/replay.*canonical evidence/i);

    const failedInsert = new FakeWarehousePriceTransaction();
    failedInsert.failInsert = true;
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        failedInsert,
        observed,
        initial.version,
        initial.event,
      ),
    ).rejects.toThrow(/injected warehouse-price insert fault/i);
    expect(failedInsert.observations.size).toBe(0);

    const missingIntentReplay = new FakeWarehousePriceTransaction();
    missingIntentReplay.seed(observed);
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        missingIntentReplay,
        observed,
        initial.version,
        initial.event,
      ),
    ).rejects.toThrow(/missing.*export intent/i);

    const orphanIntent = new FakeWarehousePriceTransaction();
    const intent = createAccountingWarehousePriceExportIntent(observed);
    orphanIntent.intents.set(intent.intentId, intent);
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        orphanIntent,
        observed,
        initial.version,
        initial.event,
      ),
    ).rejects.toThrow(/intent exists without.*observation/i);

    const failedIntentInsert = new FakeWarehousePriceTransaction();
    failedIntentInsert.failIntentInsert = true;
    await expect(
      appendAccountingWarehousePriceObservationInTransaction(
        failedIntentInsert,
        observed,
        initial.version,
        initial.event,
      ),
    ).rejects.toThrow(/export-intent fault/i);
    expect(failedIntentInsert.operations.at(-1)).toBe(
      `insert-intent:${observed.observationId}`,
    );
  });
});
