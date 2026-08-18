import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  ACCOUNTING_ACTOR_SCHEMA_V1,
  verifyAccountingDocumentVersion,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const LIFECYCLE_SCHEMA = "site-logbook.accounting-lifecycle-event/v1" as const;
const PAYMENT_SCHEMA = "site-logbook.accounting-payment-event/v1" as const;
const RELATION_SCHEMA = "site-logbook.accounting-version-relation/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const LIFECYCLE_HASH_DOMAIN =
  "site-logbook.accounting-lifecycle-event/v1" as const;
const PAYMENT_HASH_DOMAIN = "site-logbook.accounting-payment-event/v1" as const;
const RELATION_HASH_DOMAIN =
  "site-logbook.accounting-version-relation/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const positiveDecimalSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const sequenceSchema = z.string().regex(SEQUENCE_PATTERN);

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }, "Calendar date is invalid.");

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  }, "Timestamp must be a real UTC millisecond instant.");

const signedAmountSchema = z
  .string()
  .regex(CANONICAL_DECIMAL_PATTERN)
  .superRefine((value, context) => {
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const [integer, fraction] = unsigned.split(".");
    if (fraction && fraction.length > 4) {
      context.addIssue({
        code: "custom",
        message: "Amount scale exceeds four decimal places.",
      });
    }
    if (fraction?.endsWith("0")) {
      context.addIssue({
        code: "custom",
        message: "Amount must not contain trailing fractional zeroes.",
      });
    }
    if (
      value.startsWith("-") &&
      /^0(?:\.0+)?$/.test(`${integer}${fraction ? `.${fraction}` : ""}`)
    ) {
      context.addIssue({
        code: "custom",
        message: "Negative zero is not canonical.",
      });
    }
  });

const aggregateRefSchema = z
  .object({
    kind: z.enum(["outgoing-invoice", "incoming-cost-document"]),
    id: positiveDecimalSchema,
    versionId: uuidSchema,
  })
  .strict();

const chainIntegrityShape = (hashDomain: string) =>
  z
    .object({
      canonicalization: z.literal(CANONICALIZATION),
      hashAlgorithm: z.literal("sha256"),
      hashDomain: z.literal(hashDomain),
      entrySha256: sha256Schema,
    })
    .strict();

const lifecycleBodyShape = {
  schemaVersion: z.literal(LIFECYCLE_SCHEMA),
  eventId: uuidSchema,
  aggregate: aggregateRefSchema,
  sequence: sequenceSchema,
  previousEventSha256: sha256Schema.nullable(),
  eventType: z.enum([
    "issued",
    "sent",
    "cancellation_requested",
    "void_confirmed",
    "credit_linked",
    "correction_linked",
    "approved",
    "review_reopened",
    "ignored",
  ]),
  actor: ACCOUNTING_ACTOR_SCHEMA_V1,
  reasonCode: z.enum([
    "document_issued",
    "delivery_confirmed",
    "customer_complaint",
    "incorrect_job",
    "billing_error",
    "duplicate_invoice",
    "order_cancelled",
    "correction_approved",
    "credit_approved",
    "document_approved",
    "review_reopened",
    "duplicate_document",
    "invalid_document",
  ]),
  reasonDetailSha256: sha256Schema.nullable(),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  evidenceSha256: sha256Schema,
};

const lifecycleBodySchema = z
  .object(lifecycleBodyShape)
  .strict()
  .superRefine(validateLifecycleBody);

const lifecycleSchema = z
  .object({
    ...lifecycleBodyShape,
    integrity: chainIntegrityShape(LIFECYCLE_HASH_DOMAIN),
  })
  .strict()
  .superRefine(validateLifecycleBody);

const paymentBodyShape = {
  schemaVersion: z.literal(PAYMENT_SCHEMA),
  paymentEventId: uuidSchema,
  invoiceId: positiveDecimalSchema,
  invoiceVersionId: uuidSchema,
  sequence: sequenceSchema,
  previousEventSha256: sha256Schema.nullable(),
  eventType: z.enum(["received", "corrected", "refunded", "reversed"]),
  amountDelta: signedAmountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredOn: dateSchema,
  recordedAt: timestampSchema,
  source: z.enum(["manual", "bank_import", "payment_provider"]),
  sourceRefSha256: sha256Schema.nullable(),
  correctsPaymentEventId: uuidSchema.nullable(),
  actor: ACCOUNTING_ACTOR_SCHEMA_V1,
  reasonCode: z.enum([
    "payment_received",
    "payment_imported",
    "payment_correction_approved",
    "refund_approved",
    "payment_reversal_confirmed",
  ]),
  reasonDetailSha256: sha256Schema.nullable(),
  evidenceSha256: sha256Schema,
};

const paymentBodySchema = z
  .object(paymentBodyShape)
  .strict()
  .superRefine(validatePaymentBody);

const paymentSchema = z
  .object({
    ...paymentBodyShape,
    integrity: chainIntegrityShape(PAYMENT_HASH_DOMAIN),
  })
  .strict()
  .superRefine(validatePaymentBody);

const relationBodyShape = {
  schemaVersion: z.literal(RELATION_SCHEMA),
  relationId: uuidSchema,
  relationType: z.enum(["supersedes", "corrects", "credits", "voids"]),
  source: aggregateRefSchema,
  target: aggregateRefSchema,
  actor: ACCOUNTING_ACTOR_SCHEMA_V1,
  reasonCode: z.enum([
    "correction_approved",
    "customer_complaint",
    "incorrect_job",
    "billing_error",
    "duplicate_invoice",
    "order_cancelled",
    "refund_approved",
  ]),
  reasonDetailSha256: sha256Schema,
  recordedAt: timestampSchema,
  evidenceSha256: sha256Schema,
};

const relationBodySchema = z
  .object(relationBodyShape)
  .strict()
  .superRefine(validateRelationBody);

const relationSchema = z
  .object({
    ...relationBodyShape,
    integrity: chainIntegrityShape(RELATION_HASH_DOMAIN),
  })
  .strict()
  .superRefine(validateRelationBody);

export type CreateAccountingLifecycleEventInputV1 = z.infer<
  typeof lifecycleBodySchema
>;
export type AccountingLifecycleEventV1 = z.infer<typeof lifecycleSchema>;
export type CreateAccountingPaymentEventInputV1 = z.infer<
  typeof paymentBodySchema
>;
export type AccountingPaymentEventV1 = z.infer<typeof paymentSchema>;
export type CreateAccountingVersionRelationInputV1 = z.infer<
  typeof relationBodySchema
>;
export type AccountingVersionRelationV1 = z.infer<typeof relationSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateChainPosition(
  value: { sequence: string; previousEventSha256: string | null },
  context: z.RefinementCtx,
): void {
  const first = value.sequence === "0";
  if (first !== (value.previousEventSha256 === null)) {
    addIssue(
      context,
      ["previousEventSha256"],
      "Only sequence zero may omit its previous event digest.",
    );
  }
}

function validateLifecycleBody(value: any, context: z.RefinementCtx): void {
  validateChainPosition(value, context);
  if (value.effectiveAt > value.recordedAt) {
    addIssue(
      context,
      ["effectiveAt"],
      "Lifecycle effective instant cannot postdate recording.",
    );
  }

  const outgoingTypes = new Set([
    "issued",
    "sent",
    "cancellation_requested",
    "void_confirmed",
    "credit_linked",
    "correction_linked",
  ]);
  const incomingTypes = new Set([
    "approved",
    "review_reopened",
    "correction_linked",
    "ignored",
  ]);
  const allowedTypes =
    value.aggregate.kind === "outgoing-invoice" ? outgoingTypes : incomingTypes;
  if (!allowedTypes.has(value.eventType)) {
    addIssue(
      context,
      ["eventType"],
      "Event type is not valid for this accounting aggregate.",
    );
  }

  const exactReasons: Record<string, readonly string[]> = {
    issued: ["document_issued"],
    sent: ["delivery_confirmed"],
    cancellation_requested: [
      "customer_complaint",
      "incorrect_job",
      "billing_error",
      "duplicate_invoice",
      "order_cancelled",
    ],
    void_confirmed: [
      "customer_complaint",
      "incorrect_job",
      "billing_error",
      "duplicate_invoice",
      "order_cancelled",
    ],
    credit_linked: ["credit_approved"],
    correction_linked: ["correction_approved"],
    approved: ["document_approved"],
    review_reopened: ["review_reopened"],
    ignored: ["duplicate_document", "invalid_document"],
  };
  if (!exactReasons[value.eventType]?.includes(value.reasonCode)) {
    addIssue(
      context,
      ["reasonCode"],
      "Reason code is not registered for this event type.",
    );
  }

  const requiresDetail = new Set([
    "cancellation_requested",
    "void_confirmed",
    "credit_linked",
    "correction_linked",
    "review_reopened",
    "ignored",
  ]).has(value.eventType);
  if (requiresDetail !== (value.reasonDetailSha256 !== null)) {
    addIssue(
      context,
      ["reasonDetailSha256"],
      "Lifecycle reason-detail evidence does not match the event policy.",
    );
  }
}

function isZero(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function validatePaymentBody(value: any, context: z.RefinementCtx): void {
  validateChainPosition(value, context);
  const negative =
    value.amountDelta.startsWith("-") && !isZero(value.amountDelta);
  const positive =
    !value.amountDelta.startsWith("-") && !isZero(value.amountDelta);
  if (
    (value.eventType === "received" && !positive) ||
    (new Set(["refunded", "reversed"]).has(value.eventType) && !negative) ||
    (value.eventType === "corrected" && isZero(value.amountDelta))
  ) {
    addIssue(
      context,
      ["amountDelta"],
      "Payment delta sign does not match its append-only event type.",
    );
  }

  const derived = value.eventType !== "received";
  if (derived !== (value.correctsPaymentEventId !== null)) {
    addIssue(
      context,
      ["correctsPaymentEventId"],
      "Only a derived payment event must reference the corrected event.",
    );
  }
  if (derived !== (value.reasonDetailSha256 !== null)) {
    addIssue(
      context,
      ["reasonDetailSha256"],
      "Derived payment events require hashed reason detail.",
    );
  }
  if (
    new Set(["bank_import", "payment_provider"]).has(value.source) !==
    (value.sourceRefSha256 !== null)
  ) {
    addIssue(
      context,
      ["sourceRefSha256"],
      "External payment sources require a hashed provider reference.",
    );
  }

  const exactReasons: Record<string, readonly string[]> = {
    received: ["payment_received", "payment_imported"],
    corrected: ["payment_correction_approved"],
    refunded: ["refund_approved"],
    reversed: ["payment_reversal_confirmed"],
  };
  if (!exactReasons[value.eventType]?.includes(value.reasonCode)) {
    addIssue(
      context,
      ["reasonCode"],
      "Payment reason is not registered for this event type.",
    );
  }
  if (
    (value.source === "manual" && value.reasonCode === "payment_imported") ||
    (value.source !== "manual" && value.reasonCode === "payment_received")
  ) {
    addIssue(
      context,
      ["reasonCode"],
      "Payment reason and source contradict each other.",
    );
  }
}

function sameReference(left: any, right: any): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.versionId === right.versionId
  );
}

function validateRelationBody(value: any, context: z.RefinementCtx): void {
  if (sameReference(value.source, value.target)) {
    addIssue(
      context,
      ["target"],
      "An accounting relation cannot point to the same version.",
    );
  }
  const sameKind = value.source.kind === value.target.kind;
  if (!sameKind) {
    addIssue(
      context,
      ["target", "kind"],
      "Accounting correction relations cannot cross document kinds.",
    );
  }
  if (
    value.relationType === "supersedes" &&
    value.source.id !== value.target.id
  ) {
    addIssue(
      context,
      ["target", "id"],
      "Supersedes must remain within one aggregate.",
    );
  }
  if (
    new Set(["credits", "voids"]).has(value.relationType) &&
    (value.source.kind !== "outgoing-invoice" ||
      value.target.kind !== "outgoing-invoice")
  ) {
    addIssue(
      context,
      ["relationType"],
      "Credits and voids apply only to outgoing invoices.",
    );
  }

  const exactReasons: Record<string, readonly string[]> = {
    supersedes: ["correction_approved"],
    corrects: [
      "correction_approved",
      "customer_complaint",
      "incorrect_job",
      "billing_error",
    ],
    credits: [
      "refund_approved",
      "customer_complaint",
      "incorrect_job",
      "billing_error",
    ],
    voids: [
      "customer_complaint",
      "incorrect_job",
      "billing_error",
      "duplicate_invoice",
      "order_cancelled",
    ],
  };
  if (!exactReasons[value.relationType]?.includes(value.reasonCode)) {
    addIssue(
      context,
      ["reasonCode"],
      "Relation reason is not registered for its type.",
    );
  }
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\0${canonicalEvidenceJson(value)}`);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function createEntry<TBody extends Record<string, unknown>, TEntry>(
  body: TBody,
  hashDomain: string,
  verify: (value: unknown) => TEntry,
): TEntry {
  const unsigned = {
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain,
      entrySha256: null,
    },
  };
  return verify({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain,
      entrySha256: domainHash(hashDomain, unsigned),
    },
  });
}

function verifyEntry<TEntry extends { integrity: { entrySha256: string } }>(
  value: unknown,
  schema: z.ZodType<TEntry>,
  hashDomain: string,
): TEntry {
  const parsed = schema.parse(value);
  const { integrity: _integrity, ...body } = parsed;
  const unsigned = {
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain,
      entrySha256: null,
    },
  };
  const expected = domainHash(hashDomain, unsigned);
  if (!safeEqualHex(parsed.integrity.entrySha256, expected)) {
    throw new Error(
      "Accounting lifecycle entry integrity verification failed.",
    );
  }
  return parsed;
}

export function createAccountingLifecycleEvent(
  input: CreateAccountingLifecycleEventInputV1,
): AccountingLifecycleEventV1 {
  const body = lifecycleBodySchema.parse(input);
  return createEntry(
    body,
    LIFECYCLE_HASH_DOMAIN,
    verifyAccountingLifecycleEvent,
  );
}

export function verifyAccountingLifecycleEvent(
  value: unknown,
): AccountingLifecycleEventV1 {
  return verifyEntry(value, lifecycleSchema, LIFECYCLE_HASH_DOMAIN);
}

export function createAccountingPaymentEvent(
  input: CreateAccountingPaymentEventInputV1,
): AccountingPaymentEventV1 {
  const body = paymentBodySchema.parse(input);
  return createEntry(body, PAYMENT_HASH_DOMAIN, verifyAccountingPaymentEvent);
}

export function verifyAccountingPaymentEvent(
  value: unknown,
): AccountingPaymentEventV1 {
  return verifyEntry(value, paymentSchema, PAYMENT_HASH_DOMAIN);
}

export function createAccountingVersionRelation(
  input: CreateAccountingVersionRelationInputV1,
): AccountingVersionRelationV1 {
  const body = relationBodySchema.parse(input);
  return createEntry(
    body,
    RELATION_HASH_DOMAIN,
    verifyAccountingVersionRelation,
  );
}

export function verifyAccountingVersionRelation(
  value: unknown,
): AccountingVersionRelationV1 {
  return verifyEntry(value, relationSchema, RELATION_HASH_DOMAIN);
}

function versionReference(version: AccountingDocumentVersionV1) {
  return {
    kind: version.aggregate.kind,
    id: version.aggregate.id,
    versionId: version.versionId,
  };
}

export function verifyAccountingLifecycleEventBinding(
  eventValue: unknown,
  versionValue: unknown,
): { event: AccountingLifecycleEventV1; version: AccountingDocumentVersionV1 } {
  const event = verifyAccountingLifecycleEvent(eventValue);
  const version = verifyAccountingDocumentVersion(versionValue);
  if (!sameReference(event.aggregate, versionReference(version))) {
    throw new Error(
      "Accounting lifecycle event is not bound to the supplied version.",
    );
  }
  const exactPurpose: Partial<
    Record<AccountingLifecycleEventV1["eventType"], string>
  > = {
    issued: "issued",
    credit_linked: "credit",
    correction_linked: "correction",
    approved: "approved",
    ignored: "discarded_observation",
  };
  const requiredPurpose = exactPurpose[event.eventType];
  if (requiredPurpose && version.purpose !== requiredPurpose) {
    throw new Error(
      "Accounting lifecycle event does not match the version purpose.",
    );
  }
  return { event, version };
}

export function verifyAccountingPaymentEventBinding(
  eventValue: unknown,
  versionValue: unknown,
): { event: AccountingPaymentEventV1; version: AccountingDocumentVersionV1 } {
  const event = verifyAccountingPaymentEvent(eventValue);
  const version = verifyAccountingDocumentVersion(versionValue);
  if (
    version.aggregate.kind !== "outgoing-invoice" ||
    version.aggregate.id !== event.invoiceId ||
    version.versionId !== event.invoiceVersionId ||
    version.snapshot.kind !== "outgoing-invoice" ||
    version.snapshot.invoice.currency !== event.currency ||
    !new Set(["issued", "correction", "legacy_observation"]).has(
      version.purpose,
    )
  ) {
    throw new Error(
      "Accounting payment event is not bound to the supplied invoice version.",
    );
  }
  return { event, version };
}

export function verifyAccountingVersionRelationBinding(
  relationValue: unknown,
  sourceValue: unknown,
  targetValue: unknown,
): {
  relation: AccountingVersionRelationV1;
  source: AccountingDocumentVersionV1;
  target: AccountingDocumentVersionV1;
} {
  const relation = verifyAccountingVersionRelation(relationValue);
  const source = verifyAccountingDocumentVersion(sourceValue);
  const target = verifyAccountingDocumentVersion(targetValue);
  if (
    !sameReference(relation.source, versionReference(source)) ||
    !sameReference(relation.target, versionReference(target))
  ) {
    throw new Error(
      "Accounting relation is not bound to the supplied versions.",
    );
  }
  if (source.purpose === "legacy_observation") {
    throw new Error(
      "A legacy observation cannot originate a correction relation.",
    );
  }
  const requiredPurpose = {
    supersedes: "correction",
    corrects: "correction",
    credits: "credit",
    voids: "cancellation_notice",
  } as const;
  if (source.purpose !== requiredPurpose[relation.relationType]) {
    throw new Error(
      "Accounting relation does not match the source version purpose.",
    );
  }
  if (
    relation.relationType === "supersedes" &&
    source.supersedesVersionId !== target.versionId
  ) {
    throw new Error(
      "Supersedes relation does not match the version predecessor.",
    );
  }
  return { relation, source, target };
}

export function verifyAccountingCorrectionChainBinding(
  relationValue: unknown,
  eventValue: unknown,
  sourceValue: unknown,
  targetValue: unknown,
): {
  relation: AccountingVersionRelationV1;
  event: AccountingLifecycleEventV1;
  source: AccountingDocumentVersionV1;
  target: AccountingDocumentVersionV1;
} {
  const { relation, source, target } = verifyAccountingVersionRelationBinding(
    relationValue,
    sourceValue,
    targetValue,
  );
  const event = verifyAccountingLifecycleEvent(eventValue);
  const expectedVersion = relation.relationType === "voids" ? target : source;
  verifyAccountingLifecycleEventBinding(event, expectedVersion);
  const expectedEventType = {
    supersedes: "correction_linked",
    corrects: "correction_linked",
    credits: "credit_linked",
    voids: "void_confirmed",
  } as const;
  if (event.eventType !== expectedEventType[relation.relationType]) {
    throw new Error(
      "Accounting correction event type does not match its relation.",
    );
  }
  if (
    event.reasonDetailSha256 !== relation.reasonDetailSha256 ||
    event.evidenceSha256 !== relation.evidenceSha256 ||
    event.recordedAt !== relation.recordedAt ||
    canonicalEvidenceJson(event.actor) !== canonicalEvidenceJson(relation.actor)
  ) {
    throw new Error(
      "Accounting correction event and relation evidence are not atomic-equivalent.",
    );
  }
  if (
    new Set(["supersedes", "voids"]).has(relation.relationType) &&
    event.reasonCode !== relation.reasonCode
  ) {
    throw new Error(
      "Accounting correction event and relation reason do not match.",
    );
  }
  return { relation, event, source, target };
}

export function verifyAccountingLifecycleEventChain(
  values: readonly unknown[],
): AccountingLifecycleEventV1[] {
  if (values.length === 0) {
    throw new Error("Accounting lifecycle chain cannot be empty.");
  }
  const events = values.map(verifyAccountingLifecycleEvent);
  const first = events[0]!;
  const ids = new Set<string>();
  events.forEach((event, index) => {
    if (ids.has(event.eventId)) {
      throw new Error(
        "Accounting lifecycle chain contains a duplicate event ID.",
      );
    }
    ids.add(event.eventId);
    if (event.sequence !== String(index)) {
      throw new Error(
        "Accounting lifecycle chain sequence is not contiguous from zero.",
      );
    }
    if (
      index > 0 &&
      event.previousEventSha256 !== events[index - 1]!.integrity.entrySha256
    ) {
      throw new Error(
        "Accounting lifecycle chain previous digest does not match.",
      );
    }
    if (
      event.aggregate.kind !== first.aggregate.kind ||
      event.aggregate.id !== first.aggregate.id
    ) {
      throw new Error("Accounting lifecycle chain crosses aggregate identity.");
    }
    if (index > 0 && event.recordedAt < events[index - 1]!.recordedAt) {
      throw new Error(
        "Accounting lifecycle chain recording time moved backwards.",
      );
    }
  });
  return events;
}

export function verifyAccountingPaymentEventChain(
  values: readonly unknown[],
): AccountingPaymentEventV1[] {
  if (values.length === 0) {
    throw new Error("Accounting payment chain cannot be empty.");
  }
  const events = values.map(verifyAccountingPaymentEvent);
  const first = events[0]!;
  const ids = new Set<string>();
  events.forEach((event, index) => {
    if (ids.has(event.paymentEventId)) {
      throw new Error(
        "Accounting payment chain contains a duplicate event ID.",
      );
    }
    if (event.sequence !== String(index)) {
      throw new Error(
        "Accounting payment chain sequence is not contiguous from zero.",
      );
    }
    if (
      index > 0 &&
      event.previousEventSha256 !== events[index - 1]!.integrity.entrySha256
    ) {
      throw new Error(
        "Accounting payment chain previous digest does not match.",
      );
    }
    if (
      event.invoiceId !== first.invoiceId ||
      event.currency !== first.currency
    ) {
      throw new Error(
        "Accounting payment chain crosses invoice or currency identity.",
      );
    }
    if (index > 0 && event.recordedAt < events[index - 1]!.recordedAt) {
      throw new Error(
        "Accounting payment chain recording time moved backwards.",
      );
    }
    if (
      event.correctsPaymentEventId !== null &&
      !ids.has(event.correctsPaymentEventId)
    ) {
      throw new Error(
        "Derived payment event must reference an earlier event in its chain.",
      );
    }
    ids.add(event.paymentEventId);
  });
  return events;
}

export function canonicalAccountingLifecycleEntryJson(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === PAYMENT_SCHEMA
  ) {
    return canonicalEvidenceJson(verifyAccountingPaymentEvent(value));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === RELATION_SCHEMA
  ) {
    return canonicalEvidenceJson(verifyAccountingVersionRelation(value));
  }
  return canonicalEvidenceJson(verifyAccountingLifecycleEvent(value));
}

export function verifyCanonicalAccountingLifecycleEntryJsonBytes(
  value: Buffer | string,
):
  | AccountingLifecycleEventV1
  | AccountingPaymentEventV1
  | AccountingVersionRelationV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const parsed = JSON.parse(text) as unknown;
  const canonical = canonicalAccountingLifecycleEntryJson(parsed);
  if (canonical !== text) {
    throw new Error("Accounting lifecycle entry bytes are not canonical JSON.");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === PAYMENT_SCHEMA
  ) {
    return verifyAccountingPaymentEvent(parsed);
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === RELATION_SCHEMA
  ) {
    return verifyAccountingVersionRelation(parsed);
  }
  return verifyAccountingLifecycleEvent(parsed);
}
