import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  verifyAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  verifyAccountingCorrectionChainBinding,
  verifyAccountingLifecycleEvent,
  verifyAccountingLifecycleEventBinding,
  verifyAccountingPaymentEvent,
  verifyAccountingPaymentEventBinding,
  verifyAccountingVersionRelation,
  type AccountingLifecycleEventV1,
  type AccountingPaymentEventV1,
  type AccountingVersionRelationV1,
} from "./accounting-lifecycle-event-contract";
import {
  verifyAccountingWarehousePriceObservation,
  type AccountingWarehousePriceObservationV1,
} from "./accounting-warehouse-price-observation-contract";
import {
  verifyAccountingWarehousePriceLegacyObservation,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  verifyAccountingReasonArtifact,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const EXPORT_INTENT_SCHEMA =
  "site-logbook.accounting-export-intent/v1" as const;
const EXPORT_INTENT_HASH_DOMAIN =
  "site-logbook.accounting-export-intent/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const NONNEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const uuidSchema = z.string().regex(UUID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const positiveDecimalSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const sequenceSchema = z.string().regex(NONNEGATIVE_DECIMAL_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(
    (value) => {
      const parsed = new Date(value);
      return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
    },
    { message: "Timestamp must be a real UTC millisecond instant." },
  );

const aggregateSchema = z
  .object({
    kind: z.enum(["outgoing-invoice", "incoming-cost-document"]),
    id: positiveDecimalSchema,
  })
  .strict();

const exportAggregateSchema = z
  .object({
    kind: z.enum([
      "outgoing-invoice",
      "incoming-cost-document",
      "warehouse-item",
    ]),
    id: positiveDecimalSchema,
  })
  .strict();

const versionHeadSchema = z
  .object({
    version: positiveDecimalSchema,
    versionId: uuidSchema,
    versionSha256: sha256Schema,
  })
  .strict();

const lifecycleHeadSchema = z
  .object({
    sequence: sequenceSchema,
    eventId: uuidSchema,
    eventSha256: sha256Schema,
  })
  .strict();

const paymentHeadSchema = z
  .object({
    sequence: sequenceSchema,
    paymentEventId: uuidSchema,
    eventSha256: sha256Schema,
  })
  .strict();

const aggregateStateSchema = z
  .object({
    aggregate: aggregateSchema,
    revision: sequenceSchema,
    versionHead: versionHeadSchema.nullable(),
    lifecycleHead: lifecycleHeadSchema.nullable(),
    paymentHead: paymentHeadSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.aggregate.kind === "incoming-cost-document" &&
      value.paymentHead !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["paymentHead"],
        message: "Incoming cost documents cannot own invoice payment events.",
      });
    }
    if (value.versionHead === null && value.lifecycleHead !== null) {
      context.addIssue({
        code: "custom",
        path: ["lifecycleHead"],
        message: "Lifecycle evidence cannot exist before a document version.",
      });
    }
    if (value.versionHead === null && value.paymentHead !== null) {
      context.addIssue({
        code: "custom",
        path: ["paymentHead"],
        message: "Payment evidence cannot exist before an invoice version.",
      });
    }
  });

const exportEntrySchema = z
  .object({
    kind: z.enum([
      "document-version",
      "lifecycle-event",
      "payment-event",
      "version-relation",
      "warehouse-price-observation",
      "warehouse-price-legacy-observation",
      "reason-artifact",
    ]),
    id: uuidSchema,
    sha256: sha256Schema,
  })
  .strict();

const exportIntentBodyShape = {
  schemaVersion: z.literal(EXPORT_INTENT_SCHEMA),
  intentId: uuidSchema,
  operation: z.enum([
    "initial-version",
    "legacy-observation",
    "lifecycle-event",
    "payment-event",
    "correction-bundle",
    "warehouse-price-observation",
    "warehouse-price-legacy-observation",
    "reason-artifact",
  ]),
  affectedAggregates: z.array(exportAggregateSchema).min(1).max(2),
  entries: z.array(exportEntrySchema).min(1).max(3),
  recordedAt: timestampSchema,
  destination: z
    .object({
      kind: z.literal("versioned-object-storage"),
      namespace: z.enum([
        "accounting-evidence/v1",
        "accounting-evidence-restricted/v1",
      ]),
      format: z.literal("canonical-json-bundle/v1"),
    })
    .strict(),
  initialState: z.literal("pending"),
};

type ExportIntentBody = {
  schemaVersion: typeof EXPORT_INTENT_SCHEMA;
  intentId: string;
  operation:
    | "initial-version"
    | "legacy-observation"
    | "lifecycle-event"
    | "payment-event"
    | "correction-bundle"
    | "warehouse-price-observation"
    | "warehouse-price-legacy-observation"
    | "reason-artifact";
  affectedAggregates: AccountingExportAggregateRefV1[];
  entries: Array<z.infer<typeof exportEntrySchema>>;
  recordedAt: string;
  destination: {
    kind: "versioned-object-storage";
    namespace: "accounting-evidence/v1" | "accounting-evidence-restricted/v1";
    format: "canonical-json-bundle/v1";
  };
  initialState: "pending";
};

function exportIntentBodySchemaFactory() {
  return z
    .object(exportIntentBodyShape)
    .strict()
    .superRefine(validateIntentBody);
}

const exportIntentBodySchema = exportIntentBodySchemaFactory();

const exportIntentSchema = z
  .object({
    ...exportIntentBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(EXPORT_INTENT_HASH_DOMAIN),
        intentSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => validateIntentBody(value, context));

export type AccountingAggregateRefV1 = z.infer<typeof aggregateSchema>;
export type AccountingExportAggregateRefV1 = z.infer<
  typeof exportAggregateSchema
>;
export type AccountingAggregateStateV1 = z.infer<typeof aggregateStateSchema>;
export type AccountingExportIntentV1 = z.infer<typeof exportIntentSchema>;

export type AccountingAggregateStateTransitionV1 = {
  expected: AccountingAggregateStateV1;
  next: AccountingAggregateStateV1;
};

export function verifyAccountingAggregateState(
  value: unknown,
): AccountingAggregateStateV1 {
  return aggregateStateSchema.parse(value);
}

/**
 * Adapter surface for an already-open domain transaction.
 *
 * The root lock must lock the existing invoice or billing-document row. It is
 * intentionally separate from evidence rows so an empty evidence stream is
 * still serialized. Every method must use the same caller-owned transaction;
 * any thrown error therefore rolls the domain mutation and evidence back
 * together.
 */
export interface AccountingPersistenceTransactionV1 {
  lockAggregateForUpdate(
    aggregate: AccountingAggregateRefV1,
  ): Promise<AccountingAggregateStateV1 | null>;
  loadVersionById(
    versionId: string,
  ): Promise<AccountingDocumentVersionV1 | null>;
  loadPaymentEventById(
    paymentEventId: string,
  ): Promise<AccountingPaymentEventV1 | null>;
  insertDocumentVersion(version: AccountingDocumentVersionV1): Promise<void>;
  insertLifecycleEvent(event: AccountingLifecycleEventV1): Promise<void>;
  insertPaymentEvent(event: AccountingPaymentEventV1): Promise<void>;
  insertVersionRelation(relation: AccountingVersionRelationV1): Promise<void>;
  insertExportIntent(intent: AccountingExportIntentV1): Promise<void>;
  compareAndAdvanceAggregateState(
    transition: AccountingAggregateStateTransitionV1,
  ): Promise<boolean>;
}

function aggregateKey(value: AccountingExportAggregateRefV1): string {
  return `${value.kind}:${value.id}`;
}

function compareAggregates(
  left: AccountingExportAggregateRefV1,
  right: AccountingExportAggregateRefV1,
): number {
  const kindOrder = left.kind.localeCompare(right.kind);
  return kindOrder !== 0
    ? kindOrder
    : Number(BigInt(left.id) - BigInt(right.id));
}

function sameAggregate(
  left: AccountingAggregateRefV1,
  right: AccountingAggregateRefV1,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function equalSha256(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function entryKey(value: z.infer<typeof exportEntrySchema>): string {
  return `${value.kind}:${value.id}`;
}

function validateIntentBody(value: ExportIntentBody, context: z.RefinementCtx) {
  const aggregateKeys = value.affectedAggregates.map(aggregateKey);
  if (
    new Set(aggregateKeys).size !== aggregateKeys.length ||
    !value.affectedAggregates.every(
      (aggregate, index) =>
        index === 0 ||
        compareAggregates(value.affectedAggregates[index - 1]!, aggregate) < 0,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["affectedAggregates"],
      message: "Affected aggregates must be unique and canonically ordered.",
    });
  }
  const entryKeys = value.entries.map(entryKey);
  if (
    new Set(entryKeys).size !== entryKeys.length ||
    !entryKeys.every(
      (entry, index) => index === 0 || entryKeys[index - 1]! < entry,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "Export entries must be unique and canonically ordered.",
    });
  }

  const counts = new Map<string, number>();
  for (const entry of value.entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  const exactCounts: Record<
    ExportIntentBody["operation"],
    Record<string, number>
  > = {
    "initial-version": { "document-version": 1, "lifecycle-event": 1 },
    "legacy-observation": { "document-version": 1 },
    "lifecycle-event": { "lifecycle-event": 1 },
    "payment-event": { "payment-event": 1 },
    "correction-bundle": {
      "document-version": 1,
      "lifecycle-event": 1,
      "version-relation": 1,
    },
    "warehouse-price-observation": { "warehouse-price-observation": 1 },
    "warehouse-price-legacy-observation": {
      "warehouse-price-legacy-observation": 1,
    },
    "reason-artifact": { "reason-artifact": 1 },
  };
  if (
    !equalCanonical(Object.fromEntries(counts), exactCounts[value.operation])
  ) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "Export entries do not match the atomic accounting operation.",
    });
  }
  const expectedNamespace =
    value.operation === "reason-artifact"
      ? "accounting-evidence-restricted/v1"
      : "accounting-evidence/v1";
  if (value.destination.namespace !== expectedNamespace) {
    context.addIssue({
      code: "custom",
      path: ["destination", "namespace"],
      message: "Accounting export namespace does not match its operation.",
    });
  }
}

function unsignedIntent(value: AccountingExportIntentV1): unknown {
  return {
    ...value,
    integrity: { ...value.integrity, intentSha256: null },
  };
}

function intentSha256(value: AccountingExportIntentV1): string {
  return sha256Hex(
    `${EXPORT_INTENT_HASH_DOMAIN}\0${canonicalEvidenceJson(unsignedIntent(value))}`,
  );
}

export function verifyAccountingExportIntent(
  value: unknown,
): AccountingExportIntentV1 {
  const intent = exportIntentSchema.parse(value);
  if (!equalSha256(intent.integrity.intentSha256, intentSha256(intent))) {
    throw new Error("Accounting export intent digest does not match.");
  }
  return intent;
}

export function canonicalAccountingExportIntentJson(value: unknown): string {
  return canonicalEvidenceJson(verifyAccountingExportIntent(value));
}

export function verifyCanonicalAccountingExportIntentJsonBytes(
  bytes: string | Buffer,
): AccountingExportIntentV1 {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  if (text.charCodeAt(0) === 0xfeff || text.includes("\r")) {
    throw new Error(
      "Accounting export intent bytes are not canonical UTF-8 JSON.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Accounting export intent is not valid JSON.");
  }
  const intent = verifyAccountingExportIntent(parsed);
  if (canonicalEvidenceJson(intent) !== text) {
    throw new Error("Accounting export intent bytes are not canonical JSON.");
  }
  return intent;
}

function createExportIntent(input: {
  intentId: string;
  operation: ExportIntentBody["operation"];
  affectedAggregates: AccountingExportAggregateRefV1[];
  entries: z.infer<typeof exportEntrySchema>[];
  recordedAt: string;
}): AccountingExportIntentV1 {
  const body = exportIntentBodySchema.parse({
    schemaVersion: EXPORT_INTENT_SCHEMA,
    intentId: input.intentId,
    operation: input.operation,
    affectedAggregates: [...input.affectedAggregates].sort(compareAggregates),
    entries: [...input.entries].sort((left, right) =>
      entryKey(left).localeCompare(entryKey(right)),
    ),
    recordedAt: input.recordedAt,
    destination: {
      kind: "versioned-object-storage",
      namespace:
        input.operation === "reason-artifact"
          ? "accounting-evidence-restricted/v1"
          : "accounting-evidence/v1",
      format: "canonical-json-bundle/v1",
    },
    initialState: "pending",
  });
  const candidate = exportIntentSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: EXPORT_INTENT_HASH_DOMAIN,
      intentSha256: "0".repeat(64),
    },
  });
  return verifyAccountingExportIntent({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      intentSha256: intentSha256(candidate),
    },
  });
}

function versionEntry(version: AccountingDocumentVersionV1) {
  return {
    kind: "document-version" as const,
    id: version.versionId,
    sha256: version.integrity.versionSha256,
  };
}

function lifecycleEntry(event: AccountingLifecycleEventV1) {
  return {
    kind: "lifecycle-event" as const,
    id: event.eventId,
    sha256: event.integrity.entrySha256,
  };
}

function paymentEntry(event: AccountingPaymentEventV1) {
  return {
    kind: "payment-event" as const,
    id: event.paymentEventId,
    sha256: event.integrity.entrySha256,
  };
}

function relationEntry(relation: AccountingVersionRelationV1) {
  return {
    kind: "version-relation" as const,
    id: relation.relationId,
    sha256: relation.integrity.entrySha256,
  };
}

function warehousePriceEntry(
  observation: AccountingWarehousePriceObservationV1,
) {
  return {
    kind: "warehouse-price-observation" as const,
    id: observation.observationId,
    sha256: observation.integrity.entrySha256,
  };
}

function warehousePriceLegacyEntry(
  observation: AccountingWarehousePriceLegacyObservationV1,
) {
  return {
    kind: "warehouse-price-legacy-observation" as const,
    id: observation.observationId,
    sha256: observation.integrity.entrySha256,
  };
}

function reasonArtifactEntry(artifact: AccountingReasonArtifactV1) {
  return {
    kind: "reason-artifact" as const,
    id: artifact.artifactId,
    sha256: artifact.integrity.artifactSha256,
  };
}

export function createAccountingReasonArtifactExportIntent(
  artifactValue: unknown,
): AccountingExportIntentV1 {
  const artifact = verifyAccountingReasonArtifact(artifactValue);
  return createExportIntent({
    intentId: artifact.artifactId,
    operation: "reason-artifact",
    affectedAggregates: [
      {
        kind: artifact.aggregate.kind,
        id: artifact.aggregate.id,
      },
    ],
    entries: [reasonArtifactEntry(artifact)],
    recordedAt: artifact.recordedAt,
  });
}

export function createAccountingWarehousePriceExportIntent(
  observationValue: unknown,
): AccountingExportIntentV1 {
  const observation =
    verifyAccountingWarehousePriceObservation(observationValue);
  return createExportIntent({
    intentId: observation.observationId,
    operation: "warehouse-price-observation",
    affectedAggregates: [
      {
        kind: "incoming-cost-document",
        id: observation.source.aggregateId,
      },
    ],
    entries: [warehousePriceEntry(observation)],
    recordedAt: observation.recordedAt,
  });
}

export function createAccountingWarehousePriceLegacyExportIntent(
  observationValue: unknown,
): AccountingExportIntentV1 {
  const observation =
    verifyAccountingWarehousePriceLegacyObservation(observationValue);
  return createExportIntent({
    intentId: observation.observationId,
    operation: "warehouse-price-legacy-observation",
    affectedAggregates: [
      {
        kind: "warehouse-item",
        id: observation.warehouseItemId,
      },
    ],
    entries: [warehousePriceLegacyEntry(observation)],
    recordedAt: observation.provenance.capturedAt,
  });
}

function versionHead(version: AccountingDocumentVersionV1) {
  return {
    version: version.version,
    versionId: version.versionId,
    versionSha256: version.integrity.versionSha256,
  };
}

function lifecycleHead(event: AccountingLifecycleEventV1) {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventSha256: event.integrity.entrySha256,
  };
}

function paymentHead(event: AccountingPaymentEventV1) {
  return {
    sequence: event.sequence,
    paymentEventId: event.paymentEventId,
    eventSha256: event.integrity.entrySha256,
  };
}

function assertNextVersion(
  state: AccountingAggregateStateV1,
  version: AccountingDocumentVersionV1,
) {
  if (!sameAggregate(state.aggregate, version.aggregate)) {
    throw new Error(
      "Locked accounting aggregate does not match the new version.",
    );
  }
  if (state.versionHead === null) {
    if (version.version !== "1" || version.supersedesVersionId !== null) {
      throw new Error(
        "The first persisted accounting version must be version one.",
      );
    }
    return;
  }
  if (
    BigInt(version.version) !== BigInt(state.versionHead.version) + 1n ||
    version.supersedesVersionId !== state.versionHead.versionId
  ) {
    throw new Error(
      "Accounting version is not the exact successor of the locked head.",
    );
  }
}

function assertNextLifecycle(
  state: AccountingAggregateStateV1,
  event: AccountingLifecycleEventV1,
) {
  if (
    !sameAggregate(state.aggregate, {
      kind: event.aggregate.kind,
      id: event.aggregate.id,
    })
  ) {
    throw new Error(
      "Lifecycle event aggregate does not match the locked root.",
    );
  }
  const expectedSequence =
    state.lifecycleHead === null
      ? 0n
      : BigInt(state.lifecycleHead.sequence) + 1n;
  const expectedPrevious = state.lifecycleHead?.eventSha256 ?? null;
  if (
    BigInt(event.sequence) !== expectedSequence ||
    event.previousEventSha256 !== expectedPrevious
  ) {
    throw new Error(
      "Lifecycle event is not the exact successor of the locked head.",
    );
  }
}

function assertNextPayment(
  state: AccountingAggregateStateV1,
  event: AccountingPaymentEventV1,
) {
  if (
    state.aggregate.kind !== "outgoing-invoice" ||
    state.aggregate.id !== event.invoiceId
  ) {
    throw new Error("Payment event invoice does not match the locked root.");
  }
  const expectedSequence =
    state.paymentHead === null ? 0n : BigInt(state.paymentHead.sequence) + 1n;
  const expectedPrevious = state.paymentHead?.eventSha256 ?? null;
  if (
    BigInt(event.sequence) !== expectedSequence ||
    event.previousEventSha256 !== expectedPrevious
  ) {
    throw new Error(
      "Payment event is not the exact successor of the locked head.",
    );
  }
}

async function lockStates(
  transaction: AccountingPersistenceTransactionV1,
  refs: readonly AccountingAggregateRefV1[],
): Promise<Map<string, AccountingAggregateStateV1>> {
  const unique = Array.from(
    new Map(
      refs.map((ref) => [aggregateKey(ref), aggregateSchema.parse(ref)]),
    ).values(),
  ).sort(compareAggregates);
  const states = new Map<string, AccountingAggregateStateV1>();
  for (const ref of unique) {
    const value = await transaction.lockAggregateForUpdate(ref);
    if (value === null) {
      throw new Error(
        `Accounting aggregate root ${aggregateKey(ref)} was not found.`,
      );
    }
    const state = aggregateStateSchema.parse(value);
    if (!sameAggregate(state.aggregate, ref)) {
      throw new Error("Accounting adapter returned a mismatched locked root.");
    }
    states.set(aggregateKey(ref), state);
  }
  return states;
}

function stateFor(
  states: Map<string, AccountingAggregateStateV1>,
  aggregate: AccountingAggregateRefV1,
): AccountingAggregateStateV1 {
  const state = states.get(aggregateKey(aggregate));
  if (!state) throw new Error("Required accounting aggregate was not locked.");
  return state;
}

function nextAggregateState(
  expected: AccountingAggregateStateV1,
  updates: Partial<
    Pick<
      AccountingAggregateStateV1,
      "versionHead" | "lifecycleHead" | "paymentHead"
    >
  >,
): AccountingAggregateStateV1 {
  return aggregateStateSchema.parse({
    ...expected,
    ...updates,
    revision: (BigInt(expected.revision) + 1n).toString(),
  });
}

async function requireStoredVersion(
  transaction: AccountingPersistenceTransactionV1,
  expected: AccountingDocumentVersionV1,
) {
  const storedValue = await transaction.loadVersionById(expected.versionId);
  if (storedValue === null) {
    throw new Error("Referenced accounting version is not persisted.");
  }
  const stored = verifyAccountingDocumentVersion(storedValue);
  if (!equalCanonical(stored, expected)) {
    throw new Error(
      "Referenced accounting version bytes do not match storage.",
    );
  }
}

async function advanceStates(
  transaction: AccountingPersistenceTransactionV1,
  transitions: readonly AccountingAggregateStateTransitionV1[],
) {
  const sorted = [...transitions].sort((left, right) =>
    compareAggregates(left.expected.aggregate, right.expected.aggregate),
  );
  for (const transition of sorted) {
    aggregateStateSchema.parse(transition.expected);
    aggregateStateSchema.parse(transition.next);
    if (
      !sameAggregate(
        transition.expected.aggregate,
        transition.next.aggregate,
      ) ||
      BigInt(transition.next.revision) !==
        BigInt(transition.expected.revision) + 1n
    ) {
      throw new Error(
        "Accounting aggregate state must advance the same root by exactly one revision.",
      );
    }
    if (!(await transaction.compareAndAdvanceAggregateState(transition))) {
      throw new Error(
        "Accounting aggregate head changed concurrently; caller transaction must roll back.",
      );
    }
  }
}

export async function appendInitialAccountingVersionInTransaction(
  transaction: AccountingPersistenceTransactionV1,
  versionValue: unknown,
  lifecycleEventValue?: unknown,
) {
  const version = verifyAccountingDocumentVersion(versionValue);
  const states = await lockStates(transaction, [version.aggregate]);
  const expected = stateFor(states, version.aggregate);
  assertNextVersion(expected, version);
  if (expected.versionHead !== null) {
    throw new Error(
      "Initial accounting append found an existing version head.",
    );
  }

  let event: AccountingLifecycleEventV1 | null = null;
  let operation: ExportIntentBody["operation"];
  if (version.purpose === "legacy_observation") {
    if (lifecycleEventValue !== undefined) {
      throw new Error(
        "Legacy observation must not fabricate a lifecycle event.",
      );
    }
    operation = "legacy-observation";
  } else {
    if (
      !new Set(["issued", "approved", "discarded_observation"]).has(
        version.purpose,
      )
    ) {
      throw new Error(
        "Only issued, approved or discarded-observation native versions may open a stream.",
      );
    }
    if (lifecycleEventValue === undefined) {
      throw new Error("Native initial version requires its lifecycle event.");
    }
    event = verifyAccountingLifecycleEvent(lifecycleEventValue);
    verifyAccountingLifecycleEventBinding(event, version);
    assertNextLifecycle(expected, event);
    operation = "initial-version";
  }

  const next = nextAggregateState(expected, {
    versionHead: versionHead(version),
    lifecycleHead: event ? lifecycleHead(event) : expected.lifecycleHead,
  });
  const entries = [
    versionEntry(version),
    ...(event ? [lifecycleEntry(event)] : []),
  ];
  const intent = createExportIntent({
    intentId: version.versionId,
    operation,
    affectedAggregates: [version.aggregate],
    entries,
    recordedAt: event?.recordedAt ?? version.recordedAt,
  });

  await transaction.insertDocumentVersion(version);
  if (event) await transaction.insertLifecycleEvent(event);
  await transaction.insertExportIntent(intent);
  const transition = { expected, next };
  await advanceStates(transaction, [transition]);
  return { version, event, intent, transition };
}

export async function appendAccountingLifecycleEventInTransaction(
  transaction: AccountingPersistenceTransactionV1,
  eventValue: unknown,
  versionValue: unknown,
) {
  const event = verifyAccountingLifecycleEvent(eventValue);
  const version = verifyAccountingDocumentVersion(versionValue);
  verifyAccountingLifecycleEventBinding(event, version);
  if (
    new Set([
      "issued",
      "approved",
      "credit_linked",
      "correction_linked",
      "void_confirmed",
    ]).has(event.eventType)
  ) {
    throw new Error("This lifecycle event requires an atomic version bundle.");
  }
  const states = await lockStates(transaction, [version.aggregate]);
  const expected = stateFor(states, version.aggregate);
  if (expected.versionHead?.versionId !== version.versionId) {
    throw new Error(
      "Standalone lifecycle event must bind the current version head.",
    );
  }
  await requireStoredVersion(transaction, version);
  assertNextLifecycle(expected, event);
  const next = nextAggregateState(expected, {
    lifecycleHead: lifecycleHead(event),
  });
  const intent = createExportIntent({
    intentId: event.eventId,
    operation: "lifecycle-event",
    affectedAggregates: [version.aggregate],
    entries: [lifecycleEntry(event)],
    recordedAt: event.recordedAt,
  });
  await transaction.insertLifecycleEvent(event);
  await transaction.insertExportIntent(intent);
  const transition = { expected, next };
  await advanceStates(transaction, [transition]);
  return { event, version, intent, transition };
}

export async function appendAccountingPaymentEventInTransaction(
  transaction: AccountingPersistenceTransactionV1,
  eventValue: unknown,
  versionValue: unknown,
) {
  const event = verifyAccountingPaymentEvent(eventValue);
  const version = verifyAccountingDocumentVersion(versionValue);
  verifyAccountingPaymentEventBinding(event, version);
  const states = await lockStates(transaction, [version.aggregate]);
  const expected = stateFor(states, version.aggregate);
  if (expected.versionHead?.versionId !== version.versionId) {
    throw new Error(
      "Payment event must bind the current invoice version head.",
    );
  }
  await requireStoredVersion(transaction, version);
  assertNextPayment(expected, event);
  if (event.correctsPaymentEventId !== null) {
    const correctedValue = await transaction.loadPaymentEventById(
      event.correctsPaymentEventId,
    );
    if (correctedValue === null) {
      throw new Error("Corrected payment event is not persisted.");
    }
    const corrected = verifyAccountingPaymentEvent(correctedValue);
    if (
      corrected.invoiceId !== event.invoiceId ||
      BigInt(corrected.sequence) >= BigInt(event.sequence)
    ) {
      throw new Error(
        "Payment correction does not reference an earlier event.",
      );
    }
  }
  const next = nextAggregateState(expected, {
    paymentHead: paymentHead(event),
  });
  const intent = createExportIntent({
    intentId: event.paymentEventId,
    operation: "payment-event",
    affectedAggregates: [version.aggregate],
    entries: [paymentEntry(event)],
    recordedAt: event.recordedAt,
  });
  await transaction.insertPaymentEvent(event);
  await transaction.insertExportIntent(intent);
  const transition = { expected, next };
  await advanceStates(transaction, [transition]);
  return { event, version, intent, transition };
}

export async function appendAccountingCorrectionBundleInTransaction(
  transaction: AccountingPersistenceTransactionV1,
  input: {
    sourceVersion: unknown;
    targetVersion: unknown;
    relation: unknown;
    lifecycleEvent: unknown;
  },
) {
  const source = verifyAccountingDocumentVersion(input.sourceVersion);
  const target = verifyAccountingDocumentVersion(input.targetVersion);
  const relation = verifyAccountingVersionRelation(input.relation);
  const event = verifyAccountingLifecycleEvent(input.lifecycleEvent);
  verifyAccountingCorrectionChainBinding(relation, event, source, target);

  const states = await lockStates(transaction, [
    source.aggregate,
    target.aggregate,
  ]);
  const sourceExpected = stateFor(states, source.aggregate);
  const targetExpected = stateFor(states, target.aggregate);
  if (targetExpected.versionHead?.versionId !== target.versionId) {
    throw new Error(
      "Correction target must be the locked current version head.",
    );
  }
  await requireStoredVersion(transaction, target);
  assertNextVersion(sourceExpected, source);

  const eventAggregate = {
    kind: event.aggregate.kind,
    id: event.aggregate.id,
  } satisfies AccountingAggregateRefV1;
  const eventExpected = stateFor(states, eventAggregate);
  assertNextLifecycle(eventExpected, event);

  const nextByKey = new Map<string, AccountingAggregateStateV1>();
  nextByKey.set(
    aggregateKey(source.aggregate),
    aggregateStateSchema.parse({
      ...sourceExpected,
      versionHead: versionHead(source),
    }),
  );
  const eventKey = aggregateKey(eventAggregate);
  const eventBase = nextByKey.get(eventKey) ?? eventExpected;
  nextByKey.set(
    eventKey,
    aggregateStateSchema.parse({
      ...eventBase,
      lifecycleHead: lifecycleHead(event),
    }),
  );

  const intent = createExportIntent({
    intentId: relation.relationId,
    operation: "correction-bundle",
    affectedAggregates: [source.aggregate, target.aggregate].filter(
      (aggregate, index, all) =>
        all.findIndex((candidate) => sameAggregate(candidate, aggregate)) ===
        index,
    ),
    entries: [
      versionEntry(source),
      lifecycleEntry(event),
      relationEntry(relation),
    ],
    recordedAt: relation.recordedAt,
  });

  await transaction.insertDocumentVersion(source);
  await transaction.insertVersionRelation(relation);
  await transaction.insertLifecycleEvent(event);
  await transaction.insertExportIntent(intent);
  const transitions = [...nextByKey.entries()].map(([key, next]) => ({
    expected: states.get(key)!,
    next: nextAggregateState(states.get(key)!, {
      versionHead: next.versionHead,
      lifecycleHead: next.lifecycleHead,
      paymentHead: next.paymentHead,
    }),
  }));
  await advanceStates(transaction, transitions);
  return { source, target, relation, event, intent, transitions };
}
