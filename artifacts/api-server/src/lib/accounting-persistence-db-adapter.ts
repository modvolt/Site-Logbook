import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  accountingAggregateHeadsTable,
  accountingDocumentVersionsTable,
  accountingExportOutboxTable,
  accountingLifecycleEventsTable,
  accountingPaymentEventsTable,
  accountingReasonArtifactsTable,
  accountingVersionRelationsTable,
  accountingWarehousePriceObservationsTable,
  accountingWarehousePriceProjectionHeadsTable,
  billingDocumentsTable,
  db,
  invoicesTable,
  warehousePriceHistoryTable,
  warehouseItemsTable,
  type AccountingAggregateHeadRow,
  type AccountingDocumentVersionRow,
  type AccountingPaymentEventRow,
  type AccountingReasonArtifactRow,
  type AccountingWarehousePriceObservationRow,
  type AccountingWarehousePriceProjectionHeadRow,
} from "@workspace/db";
import {
  canonicalAccountingDocumentVersionJson,
  verifyCanonicalAccountingDocumentVersionJsonBytes,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  canonicalAccountingLifecycleEntryJson,
  verifyAccountingPaymentEvent,
  type AccountingLifecycleEventV1,
  type AccountingPaymentEventV1,
  type AccountingVersionRelationV1,
} from "./accounting-lifecycle-event-contract";
import {
  canonicalAccountingExportIntentJson,
  verifyCanonicalAccountingExportIntentJsonBytes,
  verifyAccountingAggregateState,
  type AccountingAggregateRefV1,
  type AccountingAggregateStateTransitionV1,
  type AccountingAggregateStateV1,
  type AccountingExportIntentV1,
  type AccountingPersistenceTransactionV1,
} from "./accounting-persistence-contract";
import {
  canonicalAccountingWarehousePriceObservationJson,
  verifyCanonicalAccountingWarehousePriceObservationJsonBytes,
} from "./accounting-warehouse-price-observation-contract";
import {
  isAccountingWarehousePriceLegacyObservation,
  verifyCanonicalAccountingWarehousePriceStreamEntryJsonBytes,
  type AccountingWarehousePriceStreamEntryV1,
} from "./accounting-warehouse-price-stream-contract";
import type { AccountingWarehousePricePersistenceTransactionV1 } from "./accounting-warehouse-price-persistence";
import {
  canonicalAccountingWarehousePriceProjectionHeadJson,
  verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes,
  type AccountingWarehousePriceProjectionHeadV1,
} from "./accounting-warehouse-price-projection-head";
import type { AccountingWarehousePriceProjectionPersistenceTransactionV1 } from "./accounting-warehouse-price-projection-persistence";
import type { AccountingWarehousePriceBootstrapApplyTransactionV1 } from "./accounting-warehouse-price-bootstrap-apply";
import {
  canonicalAccountingWarehousePriceLegacyObservationJson,
  verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  canonicalAccountingReasonArtifactJson,
  verifyCanonicalAccountingReasonArtifactJsonBytes,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";
import type { AccountingReasonArtifactPersistenceTransactionV1 } from "./accounting-reason-artifact-persistence";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_DB_INTEGER = 2_147_483_647;

function databaseId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Accounting aggregate ID is not a positive decimal.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_DB_INTEGER) {
    throw new Error(
      "Accounting aggregate ID exceeds the database integer range.",
    );
  }
  return parsed;
}

function databaseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Accounting timestamp is not an exact UTC instant.");
  }
  return parsed;
}

function rootValues(aggregate: AccountingAggregateRefV1) {
  const id = databaseId(aggregate.id);
  return aggregate.kind === "outgoing-invoice"
    ? { invoiceId: id, billingDocumentId: null }
    : { invoiceId: null, billingDocumentId: id };
}

function rootWhere(aggregate: AccountingAggregateRefV1) {
  const id = databaseId(aggregate.id);
  return aggregate.kind === "outgoing-invoice"
    ? and(
        eq(accountingAggregateHeadsTable.invoiceId, id),
        isNull(accountingAggregateHeadsTable.billingDocumentId),
      )
    : and(
        eq(accountingAggregateHeadsTable.billingDocumentId, id),
        isNull(accountingAggregateHeadsTable.invoiceId),
      );
}

function aggregateFromRoot(row: {
  invoiceId: number | null;
  billingDocumentId: number | null;
}): AccountingAggregateRefV1 {
  if (row.invoiceId !== null && row.billingDocumentId === null) {
    return { kind: "outgoing-invoice", id: String(row.invoiceId) };
  }
  if (row.invoiceId === null && row.billingDocumentId !== null) {
    return {
      kind: "incoming-cost-document",
      id: String(row.billingDocumentId),
    };
  }
  throw new Error("Accounting evidence row has an invalid aggregate root.");
}

export function accountingStateFromHeadRow(
  row: AccountingAggregateHeadRow,
): AccountingAggregateStateV1 {
  return verifyAccountingAggregateState({
    aggregate: aggregateFromRoot(row),
    revision: row.revision.toString(),
    versionHead:
      row.versionHeadVersion === null ||
      row.versionHeadId === null ||
      row.versionHeadSha256 === null
        ? null
        : {
            version: row.versionHeadVersion.toString(),
            versionId: row.versionHeadId,
            versionSha256: row.versionHeadSha256,
          },
    lifecycleHead:
      row.lifecycleHeadSequence === null ||
      row.lifecycleHeadId === null ||
      row.lifecycleHeadSha256 === null
        ? null
        : {
            sequence: row.lifecycleHeadSequence.toString(),
            eventId: row.lifecycleHeadId,
            eventSha256: row.lifecycleHeadSha256,
          },
    paymentHead:
      row.paymentHeadSequence === null ||
      row.paymentHeadId === null ||
      row.paymentHeadSha256 === null
        ? null
        : {
            sequence: row.paymentHeadSequence.toString(),
            paymentEventId: row.paymentHeadId,
            eventSha256: row.paymentHeadSha256,
          },
  });
}

function assertDocumentRowBinding(
  row: AccountingDocumentVersionRow,
  version: AccountingDocumentVersionV1,
) {
  const aggregate = aggregateFromRoot(row);
  if (
    !isDeepStrictEqual(aggregate, version.aggregate) ||
    row.version.toString() !== version.version ||
    row.purpose !== version.purpose ||
    row.supersedesVersionId !== version.supersedesVersionId ||
    row.historicalCompleteness !== version.historicalCompleteness ||
    (row.effectiveAt?.toISOString() ?? null) !== version.effectiveAt ||
    row.recordedAt.toISOString() !== version.recordedAt ||
    row.snapshotSha256 !== version.integrity.snapshotSha256 ||
    row.artifactSetSha256 !== version.integrity.artifactSetSha256 ||
    row.versionSha256 !== version.integrity.versionSha256
  ) {
    throw new Error(
      "Stored accounting document version columns do not match canonical bytes.",
    );
  }
}

export function accountingVersionFromRow(
  row: AccountingDocumentVersionRow,
): AccountingDocumentVersionV1 {
  let version: AccountingDocumentVersionV1;
  try {
    version = verifyCanonicalAccountingDocumentVersionJsonBytes(
      row.canonicalJson,
    );
  } catch (error) {
    throw new Error(
      "Stored accounting document version canonical bytes are invalid.",
      { cause: error },
    );
  }
  assertDocumentRowBinding(row, version);
  return version;
}

function assertPaymentRowBinding(
  row: AccountingPaymentEventRow,
  event: AccountingPaymentEventV1,
) {
  if (
    String(row.invoiceId) !== event.invoiceId ||
    row.invoiceVersionId !== event.invoiceVersionId ||
    row.sequence.toString() !== event.sequence ||
    row.previousEventSha256 !== event.previousEventSha256 ||
    row.eventType !== event.eventType ||
    row.amountDelta !== event.amountDelta ||
    row.currency !== event.currency ||
    row.occurredOn !== event.occurredOn ||
    row.recordedAt.toISOString() !== event.recordedAt ||
    row.correctsPaymentEventId !== event.correctsPaymentEventId ||
    row.entrySha256 !== event.integrity.entrySha256
  ) {
    throw new Error(
      "Stored accounting payment event columns do not match canonical bytes.",
    );
  }
}

export function accountingPaymentEventFromRow(
  row: AccountingPaymentEventRow,
): AccountingPaymentEventV1 {
  let event: AccountingPaymentEventV1;
  try {
    event = verifyAccountingPaymentEvent(JSON.parse(row.canonicalJson));
  } catch (error) {
    throw new Error(
      "Stored accounting payment event canonical bytes are invalid.",
      { cause: error },
    );
  }
  if (canonicalAccountingLifecycleEntryJson(event) !== row.canonicalJson) {
    throw new Error("Stored accounting payment event is not canonical JSON.");
  }
  assertPaymentRowBinding(row, event);
  return event;
}

function assertWarehousePriceRowBinding(
  row: AccountingWarehousePriceObservationRow,
  observation: AccountingWarehousePriceStreamEntryV1,
) {
  if (isAccountingWarehousePriceLegacyObservation(observation)) {
    if (
      String(row.warehouseItemId) !== observation.warehouseItemId ||
      row.billingDocumentId !== null ||
      row.accountingVersionId !== null ||
      row.lifecycleEventId !== null ||
      row.sourceLineId !== null ||
      row.sequence.toString() !== "0" ||
      row.previousObservationSha256 !== null ||
      row.supersedesObservationId !== null ||
      row.transition !== "legacy_observation" ||
      row.purchasePrice !== observation.purchasePrice ||
      row.currency !== observation.currency ||
      row.warehouseMatchMode !== null ||
      row.warehouseMatchEvidenceSha256 !== null ||
      row.effectiveAt !== null ||
      row.recordedAt.toISOString() !== observation.provenance.capturedAt ||
      row.entrySha256 !== observation.integrity.entrySha256
    ) {
      throw new Error(
        "Stored legacy warehouse-price observation columns do not match canonical bytes.",
      );
    }
    return;
  }
  if (
    String(row.warehouseItemId) !== observation.warehouseItemId ||
    String(row.billingDocumentId) !== observation.source.aggregateId ||
    row.accountingVersionId !== observation.source.accountingVersionId ||
    row.lifecycleEventId !== observation.source.lifecycleEventId ||
    String(row.sourceLineId) !== observation.source.sourceLineId ||
    row.sequence.toString() !== observation.sequence ||
    row.previousObservationSha256 !== observation.previousObservationSha256 ||
    row.supersedesObservationId !== observation.supersedesObservationId ||
    row.transition !== observation.transition ||
    row.purchasePrice !== observation.purchasePrice ||
    row.currency !== observation.currency ||
    row.warehouseMatchMode !== (observation.warehouseMatch?.mode ?? null) ||
    row.warehouseMatchEvidenceSha256 !==
      (observation.warehouseMatch?.evidenceSha256 ?? null) ||
    row.effectiveAt?.toISOString() !== observation.effectiveAt ||
    row.recordedAt.toISOString() !== observation.recordedAt ||
    row.entrySha256 !== observation.integrity.entrySha256
  ) {
    throw new Error(
      "Stored warehouse-price observation columns do not match canonical bytes.",
    );
  }
}

export function accountingWarehousePriceObservationFromRow(
  row: AccountingWarehousePriceObservationRow,
): AccountingWarehousePriceStreamEntryV1 {
  let observation: AccountingWarehousePriceStreamEntryV1;
  try {
    observation = verifyCanonicalAccountingWarehousePriceStreamEntryJsonBytes(
      row.canonicalJson,
    );
  } catch (error) {
    throw new Error(
      "Stored warehouse-price observation canonical bytes are invalid.",
      { cause: error },
    );
  }
  assertWarehousePriceRowBinding(row, observation);
  return observation;
}

function assertWarehousePriceProjectionRowBinding(
  row: AccountingWarehousePriceProjectionHeadRow,
  head: AccountingWarehousePriceProjectionHeadV1,
) {
  if (
    String(row.warehouseItemId) !== head.warehouseItemId ||
    row.streamHeadObservationId !== head.streamHead.observationId ||
    row.streamHeadObservationSha256 !== head.streamHead.observationSha256 ||
    row.streamHeadSequence.toString() !== head.streamHead.sequence ||
    row.effectiveObservationId !==
      (head.effectivePrice?.observationId ?? null) ||
    row.effectiveObservationSha256 !==
      (head.effectivePrice?.observationSha256 ?? null) ||
    row.purchasePrice !== (head.effectivePrice?.purchasePrice ?? null) ||
    row.currency !== (head.effectivePrice?.currency ?? null) ||
    row.projectedAt.toISOString() !== head.projectedAt ||
    row.projectionSha256 !== head.integrity.projectionSha256
  ) {
    throw new Error(
      "Stored warehouse-price projection columns do not match canonical bytes.",
    );
  }
}

export function accountingWarehousePriceProjectionHeadFromRow(
  row: AccountingWarehousePriceProjectionHeadRow,
): AccountingWarehousePriceProjectionHeadV1 {
  let head: AccountingWarehousePriceProjectionHeadV1;
  try {
    head = verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
      row.canonicalJson,
    );
  } catch (error) {
    throw new Error(
      "Stored warehouse-price projection canonical bytes are invalid.",
      { cause: error },
    );
  }
  assertWarehousePriceProjectionRowBinding(row, head);
  return head;
}

function assertReasonArtifactRowBinding(
  row: AccountingReasonArtifactRow,
  artifact: AccountingReasonArtifactV1,
) {
  if (
    String(row.billingDocumentId) !== artifact.aggregate.id ||
    row.accountingVersionId !== artifact.aggregate.versionId ||
    row.lifecycleEventId !== artifact.lifecycleEvent.eventId ||
    row.lifecycleEventSha256 !== artifact.lifecycleEvent.eventSha256 ||
    row.reasonCode !== artifact.reason.code ||
    row.reasonDetailSha256 !== artifact.reason.textSha256 ||
    row.digestDomain !== artifact.reason.digestDomain ||
    row.reasonText !== artifact.reason.text ||
    row.recordedAt.toISOString() !== artifact.recordedAt ||
    row.artifactSha256 !== artifact.integrity.artifactSha256
  ) {
    throw new Error(
      "Stored accounting reason-artifact columns do not match canonical bytes.",
    );
  }
}

export function accountingReasonArtifactFromRow(
  row: AccountingReasonArtifactRow,
): AccountingReasonArtifactV1 {
  let artifact: AccountingReasonArtifactV1;
  try {
    artifact = verifyCanonicalAccountingReasonArtifactJsonBytes(
      row.canonicalJson,
    );
  } catch (error) {
    throw new Error("Stored accounting reason-artifact bytes are invalid.", {
      cause: error,
    });
  }
  assertReasonArtifactRowBinding(row, artifact);
  return artifact;
}

function headValues(state: AccountingAggregateStateV1) {
  return {
    revision: BigInt(state.revision),
    versionHeadVersion:
      state.versionHead === null ? null : BigInt(state.versionHead.version),
    versionHeadId: state.versionHead?.versionId ?? null,
    versionHeadSha256: state.versionHead?.versionSha256 ?? null,
    lifecycleHeadSequence:
      state.lifecycleHead === null
        ? null
        : BigInt(state.lifecycleHead.sequence),
    lifecycleHeadId: state.lifecycleHead?.eventId ?? null,
    lifecycleHeadSha256: state.lifecycleHead?.eventSha256 ?? null,
    paymentHeadSequence:
      state.paymentHead === null ? null : BigInt(state.paymentHead.sequence),
    paymentHeadId: state.paymentHead?.paymentEventId ?? null,
    paymentHeadSha256: state.paymentHead?.eventSha256 ?? null,
  };
}

function nullableHeadPredicates(state: AccountingAggregateStateV1) {
  return [
    state.versionHead === null
      ? and(
          isNull(accountingAggregateHeadsTable.versionHeadVersion),
          isNull(accountingAggregateHeadsTable.versionHeadId),
          isNull(accountingAggregateHeadsTable.versionHeadSha256),
        )
      : and(
          eq(
            accountingAggregateHeadsTable.versionHeadVersion,
            BigInt(state.versionHead.version),
          ),
          eq(
            accountingAggregateHeadsTable.versionHeadId,
            state.versionHead.versionId,
          ),
          eq(
            accountingAggregateHeadsTable.versionHeadSha256,
            state.versionHead.versionSha256,
          ),
        ),
    state.lifecycleHead === null
      ? and(
          isNull(accountingAggregateHeadsTable.lifecycleHeadSequence),
          isNull(accountingAggregateHeadsTable.lifecycleHeadId),
          isNull(accountingAggregateHeadsTable.lifecycleHeadSha256),
        )
      : and(
          eq(
            accountingAggregateHeadsTable.lifecycleHeadSequence,
            BigInt(state.lifecycleHead.sequence),
          ),
          eq(
            accountingAggregateHeadsTable.lifecycleHeadId,
            state.lifecycleHead.eventId,
          ),
          eq(
            accountingAggregateHeadsTable.lifecycleHeadSha256,
            state.lifecycleHead.eventSha256,
          ),
        ),
    state.paymentHead === null
      ? and(
          isNull(accountingAggregateHeadsTable.paymentHeadSequence),
          isNull(accountingAggregateHeadsTable.paymentHeadId),
          isNull(accountingAggregateHeadsTable.paymentHeadSha256),
        )
      : and(
          eq(
            accountingAggregateHeadsTable.paymentHeadSequence,
            BigInt(state.paymentHead.sequence),
          ),
          eq(
            accountingAggregateHeadsTable.paymentHeadId,
            state.paymentHead.paymentEventId,
          ),
          eq(
            accountingAggregateHeadsTable.paymentHeadSha256,
            state.paymentHead.eventSha256,
          ),
        ),
  ];
}

export function createAccountingPersistenceDbAdapter(
  tx: Tx,
): AccountingPersistenceTransactionV1 &
  AccountingWarehousePricePersistenceTransactionV1 &
  AccountingWarehousePriceProjectionPersistenceTransactionV1 &
  AccountingReasonArtifactPersistenceTransactionV1 {
  return {
    async lockAggregateForUpdate(aggregate) {
      const id = databaseId(aggregate.id);
      const roots =
        aggregate.kind === "outgoing-invoice"
          ? await tx
              .select({ id: invoicesTable.id })
              .from(invoicesTable)
              .where(eq(invoicesTable.id, id))
              .for("update")
          : await tx
              .select({ id: billingDocumentsTable.id })
              .from(billingDocumentsTable)
              .where(eq(billingDocumentsTable.id, id))
              .for("update");
      if (roots.length === 0) return null;

      await tx
        .insert(accountingAggregateHeadsTable)
        .values(rootValues(aggregate))
        .onConflictDoNothing();
      const [head] = await tx
        .select()
        .from(accountingAggregateHeadsTable)
        .where(rootWhere(aggregate))
        .for("update");
      if (!head) throw new Error("Accounting aggregate head was not created.");
      return accountingStateFromHeadRow(head);
    },

    async loadVersionById(versionId) {
      const [row] = await tx
        .select()
        .from(accountingDocumentVersionsTable)
        .where(eq(accountingDocumentVersionsTable.id, versionId))
        .limit(1);
      return row ? accountingVersionFromRow(row) : null;
    },

    async loadPaymentEventById(paymentEventId) {
      const [row] = await tx
        .select()
        .from(accountingPaymentEventsTable)
        .where(eq(accountingPaymentEventsTable.id, paymentEventId))
        .limit(1);
      return row ? accountingPaymentEventFromRow(row) : null;
    },

    async loadReasonArtifactById(artifactId) {
      const [row] = await tx
        .select()
        .from(accountingReasonArtifactsTable)
        .where(eq(accountingReasonArtifactsTable.id, artifactId))
        .limit(1);
      return row ? accountingReasonArtifactFromRow(row) : null;
    },

    async lockWarehousePriceStreamForUpdate(warehouseItemId) {
      const id = databaseId(warehouseItemId);
      const items = await tx
        .select({ id: warehouseItemsTable.id })
        .from(warehouseItemsTable)
        .where(eq(warehouseItemsTable.id, id))
        .for("update");
      if (items.length !== 1) {
        throw new Error(
          "Warehouse-price stream requires an existing warehouse item.",
        );
      }
      const [row] = await tx
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(accountingWarehousePriceObservationsTable.warehouseItemId, id),
        )
        .orderBy(desc(accountingWarehousePriceObservationsTable.sequence))
        .limit(1);
      return row ? accountingWarehousePriceObservationFromRow(row) : null;
    },

    async loadWarehousePriceObservationById(observationId) {
      const [row] = await tx
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(eq(accountingWarehousePriceObservationsTable.id, observationId))
        .limit(1);
      return row ? accountingWarehousePriceObservationFromRow(row) : null;
    },

    async lockAndLoadWarehousePriceObservationStreamForProjection(
      warehouseItemId,
    ) {
      const id = databaseId(warehouseItemId);
      const items = await tx
        .select({ id: warehouseItemsTable.id })
        .from(warehouseItemsTable)
        .where(eq(warehouseItemsTable.id, id))
        .for("update");
      if (items.length !== 1) {
        throw new Error(
          "Warehouse-price projection requires an existing warehouse item.",
        );
      }
      const rows = await tx
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(accountingWarehousePriceObservationsTable.warehouseItemId, id),
        )
        .orderBy(asc(accountingWarehousePriceObservationsTable.sequence));
      return rows.map(accountingWarehousePriceObservationFromRow);
    },

    async loadWarehousePriceProjectionHeadForUpdate(warehouseItemId) {
      const [row] = await tx
        .select()
        .from(accountingWarehousePriceProjectionHeadsTable)
        .where(
          eq(
            accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
            databaseId(warehouseItemId),
          ),
        )
        .for("update")
        .limit(1);
      return row ? accountingWarehousePriceProjectionHeadFromRow(row) : null;
    },

    async loadExportIntentById(intentId) {
      const [row] = await tx
        .select({ canonicalJson: accountingExportOutboxTable.canonicalJson })
        .from(accountingExportOutboxTable)
        .where(eq(accountingExportOutboxTable.intentId, intentId))
        .limit(1);
      return row
        ? verifyCanonicalAccountingExportIntentJsonBytes(row.canonicalJson)
        : null;
    },

    async insertDocumentVersion(versionValue) {
      const version = verifyCanonicalAccountingDocumentVersionJsonBytes(
        canonicalAccountingDocumentVersionJson(versionValue),
      );
      await tx.insert(accountingDocumentVersionsTable).values({
        id: version.versionId,
        ...rootValues(version.aggregate),
        version: BigInt(version.version),
        purpose: version.purpose,
        supersedesVersionId: version.supersedesVersionId,
        historicalCompleteness: version.historicalCompleteness,
        effectiveAt: databaseTimestamp(version.effectiveAt),
        recordedAt: databaseTimestamp(version.recordedAt)!,
        canonicalJson: canonicalAccountingDocumentVersionJson(version),
        snapshotSha256: version.integrity.snapshotSha256,
        artifactSetSha256: version.integrity.artifactSetSha256,
        versionSha256: version.integrity.versionSha256,
      });
    },

    async insertLifecycleEvent(eventValue: AccountingLifecycleEventV1) {
      const canonicalJson = canonicalAccountingLifecycleEntryJson(eventValue);
      await tx.insert(accountingLifecycleEventsTable).values({
        id: eventValue.eventId,
        ...rootValues(eventValue.aggregate),
        documentVersionId: eventValue.aggregate.versionId,
        sequence: BigInt(eventValue.sequence),
        previousEventSha256: eventValue.previousEventSha256,
        eventType: eventValue.eventType,
        effectiveAt: databaseTimestamp(eventValue.effectiveAt)!,
        recordedAt: databaseTimestamp(eventValue.recordedAt)!,
        canonicalJson,
        entrySha256: eventValue.integrity.entrySha256,
      });
    },

    async insertPaymentEvent(eventValue: AccountingPaymentEventV1) {
      const canonicalJson = canonicalAccountingLifecycleEntryJson(eventValue);
      await tx.insert(accountingPaymentEventsTable).values({
        id: eventValue.paymentEventId,
        invoiceId: databaseId(eventValue.invoiceId),
        invoiceVersionId: eventValue.invoiceVersionId,
        sequence: BigInt(eventValue.sequence),
        previousEventSha256: eventValue.previousEventSha256,
        eventType: eventValue.eventType,
        amountDelta: eventValue.amountDelta,
        currency: eventValue.currency,
        occurredOn: eventValue.occurredOn,
        recordedAt: databaseTimestamp(eventValue.recordedAt)!,
        correctsPaymentEventId: eventValue.correctsPaymentEventId,
        canonicalJson,
        entrySha256: eventValue.integrity.entrySha256,
      });
    },

    async insertReasonArtifact(artifactValue) {
      const canonicalJson =
        canonicalAccountingReasonArtifactJson(artifactValue);
      const artifact =
        verifyCanonicalAccountingReasonArtifactJsonBytes(canonicalJson);
      await tx.insert(accountingReasonArtifactsTable).values({
        id: artifact.artifactId,
        billingDocumentId: databaseId(artifact.aggregate.id),
        accountingVersionId: artifact.aggregate.versionId,
        lifecycleEventId: artifact.lifecycleEvent.eventId,
        lifecycleEventSha256: artifact.lifecycleEvent.eventSha256,
        reasonCode: artifact.reason.code,
        reasonDetailSha256: artifact.reason.textSha256,
        digestDomain: artifact.reason.digestDomain,
        reasonText: artifact.reason.text,
        recordedAt: databaseTimestamp(artifact.recordedAt)!,
        canonicalJson,
        artifactSha256: artifact.integrity.artifactSha256,
      });
    },

    async insertVersionRelation(relationValue: AccountingVersionRelationV1) {
      const canonicalJson =
        canonicalAccountingLifecycleEntryJson(relationValue);
      await tx.insert(accountingVersionRelationsTable).values({
        id: relationValue.relationId,
        relationType: relationValue.relationType,
        sourceVersionId: relationValue.source.versionId,
        targetVersionId: relationValue.target.versionId,
        recordedAt: databaseTimestamp(relationValue.recordedAt)!,
        canonicalJson,
        entrySha256: relationValue.integrity.entrySha256,
      });
    },

    async insertWarehousePriceObservation(observationValue) {
      const canonicalJson =
        canonicalAccountingWarehousePriceObservationJson(observationValue);
      const observation =
        verifyCanonicalAccountingWarehousePriceObservationJsonBytes(
          canonicalJson,
        );
      await tx.insert(accountingWarehousePriceObservationsTable).values({
        id: observation.observationId,
        warehouseItemId: databaseId(observation.warehouseItemId),
        billingDocumentId: databaseId(observation.source.aggregateId),
        accountingVersionId: observation.source.accountingVersionId,
        lifecycleEventId: observation.source.lifecycleEventId,
        sourceLineId: databaseId(observation.source.sourceLineId),
        sequence: BigInt(observation.sequence),
        previousObservationSha256: observation.previousObservationSha256,
        supersedesObservationId: observation.supersedesObservationId,
        transition: observation.transition,
        purchasePrice: observation.purchasePrice,
        currency: observation.currency,
        warehouseMatchMode: observation.warehouseMatch?.mode ?? null,
        warehouseMatchEvidenceSha256:
          observation.warehouseMatch?.evidenceSha256 ?? null,
        effectiveAt: databaseTimestamp(observation.effectiveAt)!,
        recordedAt: databaseTimestamp(observation.recordedAt)!,
        canonicalJson,
        entrySha256: observation.integrity.entrySha256,
      });
    },

    async insertWarehousePriceProjectionHead(headValue) {
      const canonicalJson =
        canonicalAccountingWarehousePriceProjectionHeadJson(headValue);
      const head =
        verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
          canonicalJson,
        );
      await tx.insert(accountingWarehousePriceProjectionHeadsTable).values({
        warehouseItemId: databaseId(head.warehouseItemId),
        streamHeadObservationId: head.streamHead.observationId,
        streamHeadObservationSha256: head.streamHead.observationSha256,
        streamHeadSequence: BigInt(head.streamHead.sequence),
        effectiveObservationId: head.effectivePrice?.observationId ?? null,
        effectiveObservationSha256:
          head.effectivePrice?.observationSha256 ?? null,
        purchasePrice: head.effectivePrice?.purchasePrice ?? null,
        currency: head.effectivePrice?.currency ?? null,
        projectedAt: databaseTimestamp(head.projectedAt)!,
        canonicalJson,
        projectionSha256: head.integrity.projectionSha256,
        updatedAt: new Date(),
      });
    },

    async compareAndAdvanceWarehousePriceProjectionHead(
      expectedProjectionSha256,
      nextValue,
    ) {
      const canonicalJson =
        canonicalAccountingWarehousePriceProjectionHeadJson(nextValue);
      const next =
        verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
          canonicalJson,
        );
      const rows = await tx
        .update(accountingWarehousePriceProjectionHeadsTable)
        .set({
          streamHeadObservationId: next.streamHead.observationId,
          streamHeadObservationSha256: next.streamHead.observationSha256,
          streamHeadSequence: BigInt(next.streamHead.sequence),
          effectiveObservationId: next.effectivePrice?.observationId ?? null,
          effectiveObservationSha256:
            next.effectivePrice?.observationSha256 ?? null,
          purchasePrice: next.effectivePrice?.purchasePrice ?? null,
          currency: next.effectivePrice?.currency ?? null,
          projectedAt: databaseTimestamp(next.projectedAt)!,
          canonicalJson,
          projectionSha256: next.integrity.projectionSha256,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(
              accountingWarehousePriceProjectionHeadsTable.warehouseItemId,
              databaseId(next.warehouseItemId),
            ),
            eq(
              accountingWarehousePriceProjectionHeadsTable.projectionSha256,
              expectedProjectionSha256,
            ),
          ),
        )
        .returning();
      if (rows.length === 0) return false;
      if (rows.length !== 1) {
        throw new Error(
          "Warehouse-price projection CAS updated multiple rows.",
        );
      }
      const stored = accountingWarehousePriceProjectionHeadFromRow(rows[0]!);
      if (
        canonicalAccountingWarehousePriceProjectionHeadJson(stored) !==
        canonicalJson
      ) {
        throw new Error(
          "Warehouse-price projection CAS stored an unexpected head.",
        );
      }
      return true;
    },

    async insertExportIntent(intentValue: AccountingExportIntentV1) {
      const canonicalJson = canonicalAccountingExportIntentJson(intentValue);
      await tx.insert(accountingExportOutboxTable).values({
        intentId: intentValue.intentId,
        operation: intentValue.operation,
        canonicalJson,
        intentSha256: intentValue.integrity.intentSha256,
      });
    },

    async compareAndAdvanceAggregateState(
      transition: AccountingAggregateStateTransitionV1,
    ) {
      const expected = verifyAccountingAggregateState(transition.expected);
      const next = verifyAccountingAggregateState(transition.next);
      if (
        !isDeepStrictEqual(expected.aggregate, next.aggregate) ||
        BigInt(next.revision) !== BigInt(expected.revision) + 1n
      ) {
        throw new Error("Accounting aggregate CAS transition is invalid.");
      }
      const rows = await tx
        .update(accountingAggregateHeadsTable)
        .set({ ...headValues(next), updatedAt: new Date() })
        .where(
          and(
            rootWhere(expected.aggregate),
            eq(
              accountingAggregateHeadsTable.revision,
              BigInt(expected.revision),
            ),
            ...nullableHeadPredicates(expected),
          ),
        )
        .returning();
      if (rows.length === 0) return false;
      if (rows.length !== 1) {
        throw new Error("Accounting aggregate CAS updated multiple rows.");
      }
      const stored = accountingStateFromHeadRow(rows[0]!);
      if (!isDeepStrictEqual(stored, next)) {
        throw new Error("Accounting aggregate CAS stored an unexpected state.");
      }
      return true;
    },
  };
}

/**
 * Locally prepared adapter for a future, separately authorized bootstrap.
 * Merely constructing it performs no query. The caller must own the surrounding
 * transaction and supply the independently reviewed target fingerprint.
 */
export function createAccountingWarehousePriceBootstrapDbAdapter(
  tx: Tx,
  targetFingerprint: string,
): AccountingWarehousePriceBootstrapApplyTransactionV1 {
  const base = createAccountingPersistenceDbAdapter(tx);
  return {
    ...base,

    async readWarehousePriceBootstrapTargetFingerprint() {
      return targetFingerprint;
    },

    async lockAndLoadWarehousePriceBootstrapItemForUpdate(warehouseItemId) {
      const id = databaseId(warehouseItemId);
      const [item] = await tx
        .select({
          id: warehouseItemsTable.id,
          purchasePrice: warehouseItemsTable.purchasePrice,
        })
        .from(warehouseItemsTable)
        .where(eq(warehouseItemsTable.id, id))
        .for("update");
      if (!item) {
        throw new Error(
          "Warehouse-price bootstrap requires an existing warehouse item.",
        );
      }
      const observationRows = await tx
        .select()
        .from(accountingWarehousePriceObservationsTable)
        .where(
          eq(accountingWarehousePriceObservationsTable.warehouseItemId, id),
        )
        .orderBy(asc(accountingWarehousePriceObservationsTable.sequence));
      const [projectionRow] = await tx
        .select()
        .from(accountingWarehousePriceProjectionHeadsTable)
        .where(
          eq(accountingWarehousePriceProjectionHeadsTable.warehouseItemId, id),
        )
        .limit(1);
      const legacyRows = await tx
        .select()
        .from(warehousePriceHistoryTable)
        .where(eq(warehousePriceHistoryTable.warehouseItemId, id))
        .orderBy(asc(warehousePriceHistoryTable.id));
      return {
        warehouseItemId: String(item.id),
        storedPurchasePrice: item.purchasePrice,
        observations: observationRows.map(
          accountingWarehousePriceObservationFromRow,
        ),
        projectionHead: projectionRow
          ? accountingWarehousePriceProjectionHeadFromRow(projectionRow)
          : null,
        legacyRows: legacyRows.map((row) => ({
          legacyRowId: String(row.id),
          warehouseItemId: String(row.warehouseItemId),
          billingDocumentId:
            row.billingDocumentId === null
              ? null
              : String(row.billingDocumentId),
          billingDocumentLineId:
            row.billingDocumentLineId === null
              ? null
              : String(row.billingDocumentLineId),
          purchasePrice: row.purchasePrice,
          currency: row.currency,
          recordedAt: row.createdAt.toISOString(),
        })),
      };
    },

    async insertWarehousePriceLegacyObservation(observationValue) {
      const canonicalJson =
        canonicalAccountingWarehousePriceLegacyObservationJson(
          observationValue,
        );
      const observation =
        verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes(
          canonicalJson,
        );
      await tx.insert(accountingWarehousePriceObservationsTable).values({
        id: observation.observationId,
        warehouseItemId: databaseId(observation.warehouseItemId),
        billingDocumentId: null,
        accountingVersionId: null,
        lifecycleEventId: null,
        sourceLineId: null,
        sequence: 0n,
        previousObservationSha256: null,
        supersedesObservationId: null,
        transition: "legacy_observation",
        purchasePrice: observation.purchasePrice,
        currency: observation.currency,
        warehouseMatchMode: null,
        warehouseMatchEvidenceSha256: null,
        effectiveAt: null,
        recordedAt: databaseTimestamp(observation.provenance.capturedAt)!,
        canonicalJson,
        entrySha256: observation.integrity.entrySha256,
      });
    },
  };
}
