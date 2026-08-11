export type AccountingWriteSymbol =
  | "issueInvoice"
  | "cancelInvoice"
  | "updateInvoiceStatus"
  | "confirmBankPayments"
  | "approveDocument"
  | "updateWarehousePricesFromDocument"
  | "disposeCostDocument"
  | "setDocumentStatus"
  | "updateDocument"
  | "updateLine"
  | "splitLine"
  | "deleteDocument"
  | "addReference"
  | "updateReference"
  | "deleteReference"
  | "setDocumentDeliveryNoteResolution"
  | "applyAiSuggestion";

export type AccountingWriteSeamV1 = {
  file: string;
  symbol: AccountingWriteSymbol;
  occurrences: number;
  aggregate: "outgoing-invoice" | "incoming-cost-document";
  boundary:
    | "issue-or-approve"
    | "lifecycle"
    | "payment"
    | "price"
    | "draft-content"
    | "draft-provenance";
  currentControl:
    | "contract-defined-not-persisted"
    | "feature-flagged-version-event-outbox"
    | "feature-flagged-lifecycle-event-outbox"
    | "feature-flagged-price-observation-outbox"
    | "mixed-feature-flagged-reopen-unpersisted-ignore"
    | "split-operational-discard-feature-flagged-reviewed-version-event-outbox"
    | "row-locked-approved-content-guard"
    | "row-locked-terminal-content-guard";
  requiredPersistence:
    | "version-event-outbox"
    | "version-relation-event-outbox"
    | "payment-event-outbox"
    | "lifecycle-event-outbox"
    | "lifecycle-or-payment-event-outbox"
    | "warehouse-price-observation-outbox"
    | "none-before-terminal-version";
};

/**
 * Exact R13-D1 inventory of every public accounting write seam.
 *
 * The drift test scans all API TypeScript callers. A new invocation of any
 * registered accounting writer fails until this policy is deliberately
 * updated. `contract-defined-not-persisted` is an explicit open gap, not a
 * claim that current audit_log rows satisfy the immutable accounting contract.
 */
export const ACCOUNTING_WRITE_SEAM_INVENTORY_V1 = [
  {
    file: "routes/billing.ts",
    symbol: "issueInvoice",
    occurrences: 1,
    aggregate: "outgoing-invoice",
    boundary: "issue-or-approve",
    currentControl: "feature-flagged-version-event-outbox",
    requiredPersistence: "version-event-outbox",
  },
  {
    file: "routes/billing.ts",
    symbol: "cancelInvoice",
    occurrences: 1,
    aggregate: "outgoing-invoice",
    boundary: "lifecycle",
    currentControl: "feature-flagged-version-event-outbox",
    requiredPersistence: "version-relation-event-outbox",
  },
  {
    file: "routes/billing.ts",
    symbol: "updateInvoiceStatus",
    occurrences: 1,
    aggregate: "outgoing-invoice",
    boundary: "lifecycle",
    currentControl: "feature-flagged-version-event-outbox",
    requiredPersistence: "lifecycle-or-payment-event-outbox",
  },
  {
    file: "routes/billing.ts",
    symbol: "confirmBankPayments",
    occurrences: 1,
    aggregate: "outgoing-invoice",
    boundary: "payment",
    currentControl: "feature-flagged-version-event-outbox",
    requiredPersistence: "payment-event-outbox",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "approveDocument",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "issue-or-approve",
    currentControl: "feature-flagged-version-event-outbox",
    requiredPersistence: "version-event-outbox",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "updateWarehousePricesFromDocument",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "price",
    currentControl: "feature-flagged-price-observation-outbox",
    requiredPersistence: "warehouse-price-observation-outbox",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "disposeCostDocument",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "lifecycle",
    currentControl:
      "split-operational-discard-feature-flagged-reviewed-version-event-outbox",
    requiredPersistence: "version-event-outbox",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "setDocumentStatus",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "lifecycle",
    currentControl: "mixed-feature-flagged-reopen-unpersisted-ignore",
    requiredPersistence: "lifecycle-event-outbox",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "updateDocument",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "updateLine",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "splitLine",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "deleteDocument",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "addReference",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "updateReference",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "deleteReference",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "routes/billing-documents.ts",
    symbol: "setDocumentDeliveryNoteResolution",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-content",
    currentControl: "row-locked-approved-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
  {
    file: "lib/extraction-worker.ts",
    symbol: "applyAiSuggestion",
    occurrences: 1,
    aggregate: "incoming-cost-document",
    boundary: "draft-provenance",
    currentControl: "row-locked-terminal-content-guard",
    requiredPersistence: "none-before-terminal-version",
  },
] as const satisfies readonly AccountingWriteSeamV1[];
