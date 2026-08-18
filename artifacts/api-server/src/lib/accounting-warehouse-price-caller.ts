import type { AccountingDocumentVersionV1 } from "./accounting-document-version-contract";
import {
  deterministicAccountingUuid,
  requiredPositiveAccountingId,
} from "./accounting-evidence-build-utils";
import type { AccountingLifecycleEventV1 } from "./accounting-lifecycle-event-contract";
import {
  createAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "./accounting-warehouse-price-observation-contract";
import {
  isAccountingWarehousePriceLegacyObservation,
  type AccountingWarehousePriceStreamEntryV1,
} from "./accounting-warehouse-price-stream-contract";
import type { AccountingWarehousePricePersistenceTransactionV1 } from "./accounting-warehouse-price-persistence";
import {
  appendAccountingWarehousePriceWithProjectionInTransaction,
  type AccountingWarehousePriceProjectionPersistenceTransactionV1,
} from "./accounting-warehouse-price-projection-persistence";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const FEATURE_FLAG = "ACCOUNTING_WAREHOUSE_PRICE_DUAL_WRITE_ENABLED";
const MATCH_EVIDENCE_DOMAIN = "site-logbook.warehouse-price-match-evidence/v1";

export type AccountingWarehousePriceCallerTransactionV1 =
  AccountingWarehousePricePersistenceTransactionV1 &
    AccountingWarehousePriceProjectionPersistenceTransactionV1;

export type AccountingWarehousePriceMatchMode =
  | "code"
  | "name"
  | "created"
  | "manual";

export function isAccountingWarehousePriceDualWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[FEATURE_FLAG] === "true";
}

export function accountingWarehousePriceMatchEvidenceSha256(input: {
  accountingVersionId: string;
  sourceLineId: string;
  warehouseItemId: string;
  mode: AccountingWarehousePriceMatchMode;
}): string {
  return sha256Hex(
    `${MATCH_EVIDENCE_DOMAIN}\0${canonicalEvidenceJson({
      schemaVersion: MATCH_EVIDENCE_DOMAIN,
      accountingVersionId: input.accountingVersionId,
      sourceLineId: input.sourceLineId,
      warehouseItemId: input.warehouseItemId,
      mode: input.mode,
    })}`,
  );
}

function requireCostDocumentMaterialLine(
  version: AccountingDocumentVersionV1,
  sourceLineId: string,
) {
  const snapshot = version.snapshot;
  if (
    version.aggregate.kind !== "incoming-cost-document" ||
    snapshot.kind !== "incoming-cost-document"
  ) {
    throw new Error(
      "Warehouse-price caller requires an incoming cost-document version.",
    );
  }
  const line = snapshot.lines.find(
    (candidate) => candidate.sourceLineId === sourceLineId,
  );
  if (!line || line.lineType !== "material") {
    throw new Error(
      "Warehouse-price caller source line is missing or is not material.",
    );
  }
  return { line, currency: snapshot.document.currency };
}

function nextSequence(
  current: AccountingWarehousePriceStreamEntryV1 | null,
): string {
  return current === null ? "0" : String(BigInt(current.sequence) + 1n);
}

async function existingOrCurrent(input: {
  transaction: AccountingWarehousePriceCallerTransactionV1;
  warehouseItemId: string;
  observationId: string;
}) {
  const current = await input.transaction.lockWarehousePriceStreamForUpdate(
    input.warehouseItemId,
  );
  const existing = await input.transaction.loadWarehousePriceObservationById(
    input.observationId,
  );
  return { current, existing };
}

/**
 * Appends one price-bearing observation for an already-persisted approved or
 * correction version. The deterministic business ID makes an exact retry a
 * replay even if unrelated observations advanced the item stream afterwards.
 */
export async function appendAccountingWarehousePriceForVersionInTransaction(
  transaction: AccountingWarehousePriceCallerTransactionV1,
  input: {
    version: AccountingDocumentVersionV1;
    lifecycleEvent: AccountingLifecycleEventV1;
    warehouseItemId: number;
    sourceLineId: number;
    matchMode: AccountingWarehousePriceMatchMode;
    supersedesWithdrawal?: AccountingWarehousePriceObservationV1 | null;
  },
) {
  const warehouseItemId = requiredPositiveAccountingId(
    input.warehouseItemId,
    "Warehouse item ID",
  );
  const sourceLineId = requiredPositiveAccountingId(
    input.sourceLineId,
    "Cost-document line ID",
  );
  const { line, currency } = requireCostDocumentMaterialLine(
    input.version,
    sourceLineId,
  );
  const transition =
    input.version.purpose === "approved"
      ? "observed"
      : input.version.purpose === "correction"
        ? "corrected"
        : null;
  if (transition === null) {
    throw new Error(
      "Warehouse-price caller requires an approved or correction version.",
    );
  }
  const expectedEventType =
    transition === "observed" ? "approved" : "correction_linked";
  if (input.lifecycleEvent.eventType !== expectedEventType) {
    throw new Error(
      "Warehouse-price caller lifecycle event does not match the version purpose.",
    );
  }
  const observationId = deterministicAccountingUuid(
    "warehouse-price-observation",
    {
      accountingVersionId: input.version.versionId,
      lifecycleEventId: input.lifecycleEvent.eventId,
      sourceLineId,
      transition,
      warehouseItemId,
    },
  );
  const { current, existing } = await existingOrCurrent({
    transaction,
    warehouseItemId,
    observationId,
  });
  if (existing && isAccountingWarehousePriceLegacyObservation(existing)) {
    throw new Error(
      "Native warehouse-price observation ID collides with legacy evidence.",
    );
  }
  const matchEvidenceSha256 = accountingWarehousePriceMatchEvidenceSha256({
    accountingVersionId: input.version.versionId,
    sourceLineId,
    warehouseItemId,
    mode: input.matchMode,
  });
  if (
    existing &&
    (existing.transition !== transition ||
      existing.warehouseItemId !== warehouseItemId ||
      !existing.warehouseMatch ||
      existing.warehouseMatch.mode !== input.matchMode ||
      existing.warehouseMatch.evidenceSha256 !== matchEvidenceSha256)
  ) {
    throw new Error(
      "Warehouse-price caller replay does not match the reviewed warehouse match.",
    );
  }
  const superseded =
    transition === "corrected" && input.supersedesWithdrawal
      ? input.supersedesWithdrawal
      : current;
  const observation =
    existing ??
    createAccountingWarehousePriceObservation({
      schemaVersion: "site-logbook.warehouse-price-observation/v1",
      observationId,
      warehouseItemId,
      sequence: nextSequence(current),
      previousObservationSha256: current?.integrity.entrySha256 ?? null,
      supersedesObservationId: superseded?.observationId ?? null,
      transition,
      source: {
        aggregateId: input.version.aggregate.id,
        accountingVersionId: input.version.versionId,
        accountingVersionSha256: input.version.integrity.versionSha256,
        lifecycleEventId: input.lifecycleEvent.eventId,
        lifecycleEventSha256: input.lifecycleEvent.integrity.entrySha256,
        sourceLineId,
      },
      purchasePrice: line.unitPriceWithoutVat,
      currency,
      warehouseMatch: {
        mode: input.matchMode,
        evidenceSha256: matchEvidenceSha256,
      },
      actor: input.lifecycleEvent.actor,
      reasonCode:
        transition === "observed" ? "document_approved" : "correction_approved",
      reasonDetailSha256: input.lifecycleEvent.reasonDetailSha256,
      effectiveAt: input.lifecycleEvent.effectiveAt,
      recordedAt: input.lifecycleEvent.recordedAt,
    });
  return appendAccountingWarehousePriceWithProjectionInTransaction(
    transaction,
    observation,
    input.version,
    input.lifecycleEvent,
  );
}

/**
 * Withdraws one active price-bearing observation while preserving both its
 * immutable source identity and the review-reopen reason digest.
 */
export async function appendAccountingWarehousePriceWithdrawalInTransaction(
  transaction: AccountingWarehousePriceCallerTransactionV1,
  input: {
    version: AccountingDocumentVersionV1;
    lifecycleEvent: AccountingLifecycleEventV1;
    target: AccountingWarehousePriceObservationV1;
  },
) {
  if (input.lifecycleEvent.eventType !== "review_reopened") {
    throw new Error(
      "Warehouse-price withdrawal requires a review-reopened lifecycle event.",
    );
  }
  const observationId = deterministicAccountingUuid(
    "warehouse-price-withdrawal",
    {
      lifecycleEventId: input.lifecycleEvent.eventId,
      targetObservationId: input.target.observationId,
    },
  );
  const { current, existing } = await existingOrCurrent({
    transaction,
    warehouseItemId: input.target.warehouseItemId,
    observationId,
  });
  if (existing && isAccountingWarehousePriceLegacyObservation(existing)) {
    throw new Error(
      "Warehouse-price withdrawal ID collides with legacy evidence.",
    );
  }
  if (
    existing &&
    (existing.transition !== "withdrawn" ||
      existing.warehouseItemId !== input.target.warehouseItemId ||
      existing.supersedesObservationId !== input.target.observationId)
  ) {
    throw new Error(
      "Warehouse-price withdrawal replay does not match its target observation.",
    );
  }
  if (current === null && existing === null) {
    throw new Error(
      "Warehouse-price withdrawal cannot start an empty item stream.",
    );
  }
  const observation =
    existing ??
    createAccountingWarehousePriceObservation({
      schemaVersion: "site-logbook.warehouse-price-observation/v1",
      observationId,
      warehouseItemId: input.target.warehouseItemId,
      sequence: nextSequence(current),
      previousObservationSha256: current?.integrity.entrySha256 ?? null,
      supersedesObservationId: input.target.observationId,
      transition: "withdrawn",
      source: {
        aggregateId: input.version.aggregate.id,
        accountingVersionId: input.version.versionId,
        accountingVersionSha256: input.version.integrity.versionSha256,
        lifecycleEventId: input.lifecycleEvent.eventId,
        lifecycleEventSha256: input.lifecycleEvent.integrity.entrySha256,
        sourceLineId: input.target.source.sourceLineId,
      },
      purchasePrice: null,
      currency: input.target.currency,
      warehouseMatch: null,
      actor: input.lifecycleEvent.actor,
      reasonCode: "review_reopened",
      reasonDetailSha256: input.lifecycleEvent.reasonDetailSha256,
      effectiveAt: input.lifecycleEvent.effectiveAt,
      recordedAt: input.lifecycleEvent.recordedAt,
    });
  return appendAccountingWarehousePriceWithProjectionInTransaction(
    transaction,
    observation,
    input.version,
    input.lifecycleEvent,
  );
}
