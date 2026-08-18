import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  ACCOUNTING_ACTOR_SCHEMA_V1,
  verifyAccountingDocumentVersion,
  type AccountingActorV1,
  type AccountingDocumentVersionV1,
} from "./accounting-document-version-contract";
import {
  verifyAccountingLifecycleEventBinding,
  type AccountingLifecycleEventV1,
} from "./accounting-lifecycle-event-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const SCHEMA = "site-logbook.warehouse-price-observation/v1" as const;
const HASH_DOMAIN = "site-logbook.warehouse-price-observation/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const positiveDecimalSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const sequenceSchema = z.string().regex(SEQUENCE_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  }, "Timestamp must be a real UTC millisecond instant.");
const priceSchema = z
  .string()
  .regex(CANONICAL_DECIMAL_PATTERN)
  .superRefine((value, context) => {
    const fraction = value.split(".")[1];
    if (fraction && fraction.length > 4) {
      context.addIssue({
        code: "custom",
        message: "Purchase-price scale exceeds four decimal places.",
      });
    }
    if (fraction?.endsWith("0")) {
      context.addIssue({
        code: "custom",
        message: "Purchase price must not contain trailing fractional zeroes.",
      });
    }
  });

const sourceSchema = z
  .object({
    aggregateId: positiveDecimalSchema,
    accountingVersionId: uuidSchema,
    accountingVersionSha256: sha256Schema,
    lifecycleEventId: uuidSchema,
    lifecycleEventSha256: sha256Schema,
    sourceLineId: positiveDecimalSchema,
  })
  .strict();

const matchSchema = z
  .object({
    mode: z.enum(["code", "name", "created", "manual"]),
    evidenceSha256: sha256Schema,
  })
  .strict();

const bodyShape = {
  schemaVersion: z.literal(SCHEMA),
  observationId: uuidSchema,
  warehouseItemId: positiveDecimalSchema,
  sequence: sequenceSchema,
  previousObservationSha256: sha256Schema.nullable(),
  supersedesObservationId: uuidSchema.nullable(),
  transition: z.enum(["observed", "corrected", "withdrawn"]),
  source: sourceSchema,
  purchasePrice: priceSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  warehouseMatch: matchSchema.nullable(),
  actor: ACCOUNTING_ACTOR_SCHEMA_V1,
  reasonCode: z.enum([
    "document_approved",
    "correction_approved",
    "review_reopened",
  ]),
  reasonDetailSha256: sha256Schema.nullable(),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
};

const bodySchema = z.object(bodyShape).strict().superRefine(validateBody);

const observationSchema = z
  .object({
    ...bodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(HASH_DOMAIN),
        entrySha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine(validateBody);

type ObservationBody = z.infer<typeof bodySchema>;
export type AccountingWarehousePriceObservationV1 = z.infer<
  typeof observationSchema
>;

export type CreateAccountingWarehousePriceObservationInputV1 = {
  schemaVersion: typeof SCHEMA;
  observationId: string;
  warehouseItemId: string;
  sequence: string;
  previousObservationSha256: string | null;
  supersedesObservationId: string | null;
  transition: "observed" | "corrected" | "withdrawn";
  source: {
    aggregateId: string;
    accountingVersionId: string;
    accountingVersionSha256: string;
    lifecycleEventId: string;
    lifecycleEventSha256: string;
    sourceLineId: string;
  };
  purchasePrice: string | null;
  currency: string;
  warehouseMatch: {
    mode: "code" | "name" | "created" | "manual";
    evidenceSha256: string;
  } | null;
  actor: AccountingActorV1;
  reasonCode: "document_approved" | "correction_approved" | "review_reopened";
  reasonDetailSha256: string | null;
  effectiveAt: string;
  recordedAt: string;
};

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateBody(value: any, context: z.RefinementCtx): void {
  const first = value.sequence === "0";
  if (first && value.transition === "withdrawn") {
    addIssue(
      context,
      ["transition"],
      "The first warehouse-price observation cannot be a withdrawal.",
    );
  }
  if (first !== (value.previousObservationSha256 === null)) {
    addIssue(
      context,
      ["previousObservationSha256"],
      "Only the first warehouse-price observation may omit its previous digest.",
    );
  }
  if (first !== (value.supersedesObservationId === null)) {
    addIssue(
      context,
      ["supersedesObservationId"],
      "Only the first warehouse-price observation may omit its superseded observation.",
    );
  }
  if (value.effectiveAt > value.recordedAt) {
    addIssue(
      context,
      ["effectiveAt"],
      "Effective instant cannot postdate the recording instant.",
    );
  }

  const expected = {
    observed: {
      reasonCode: "document_approved",
      detail: false,
      price: true,
      warehouseMatch: true,
    },
    corrected: {
      reasonCode: "correction_approved",
      detail: true,
      price: true,
      warehouseMatch: true,
    },
    withdrawn: {
      reasonCode: "review_reopened",
      detail: true,
      price: false,
      warehouseMatch: false,
    },
  } as const;
  const policy = expected[value.transition as keyof typeof expected];
  if (!policy) return;
  if (value.reasonCode !== policy.reasonCode) {
    addIssue(
      context,
      ["reasonCode"],
      "Warehouse-price reason does not match its transition.",
    );
  }
  if ((value.reasonDetailSha256 !== null) !== policy.detail) {
    addIssue(
      context,
      ["reasonDetailSha256"],
      "Warehouse-price reason-detail evidence does not match its transition.",
    );
  }
  if ((value.purchasePrice !== null) !== policy.price) {
    addIssue(
      context,
      ["purchasePrice"],
      "Warehouse-price amount does not match its transition.",
    );
  }
  if ((value.warehouseMatch !== null) !== policy.warehouseMatch) {
    addIssue(
      context,
      ["warehouseMatch"],
      "Warehouse match evidence does not match its transition.",
    );
  }
}

function entrySha256(body: ObservationBody): string {
  return sha256Hex(`${HASH_DOMAIN}\0${canonicalEvidenceJson(body)}`);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createAccountingWarehousePriceObservation(
  input: CreateAccountingWarehousePriceObservationInputV1,
): AccountingWarehousePriceObservationV1 {
  const body = bodySchema.parse(input);
  return verifyAccountingWarehousePriceObservation({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: HASH_DOMAIN,
      entrySha256: entrySha256(body),
    },
  });
}

export function verifyAccountingWarehousePriceObservation(
  value: unknown,
): AccountingWarehousePriceObservationV1 {
  const parsed = observationSchema.parse(value);
  const { integrity: _integrity, ...body } = parsed;
  if (!safeEqualHex(parsed.integrity.entrySha256, entrySha256(body))) {
    throw new Error(
      "Warehouse-price observation integrity verification failed.",
    );
  }
  return parsed;
}

export function canonicalAccountingWarehousePriceObservationJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceObservation(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceObservationJsonBytes(
  value: Buffer | string,
): AccountingWarehousePriceObservationV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const parsed = verifyAccountingWarehousePriceObservation(JSON.parse(text));
  if (canonicalAccountingWarehousePriceObservationJson(parsed) !== text) {
    throw new Error(
      "Warehouse-price observation bytes are not exact canonical JSON.",
    );
  }
  return parsed;
}

function sameActor(left: AccountingActorV1, right: AccountingActorV1): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

export function verifyAccountingWarehousePriceSourceBinding(
  observationValue: unknown,
  versionValue: unknown,
  lifecycleEventValue: unknown,
): AccountingWarehousePriceObservationV1 {
  const observation =
    verifyAccountingWarehousePriceObservation(observationValue);
  const version = verifyAccountingDocumentVersion(versionValue);
  const event = lifecycleEventValue as AccountingLifecycleEventV1;
  verifyAccountingLifecycleEventBinding(event, version);
  if (
    version.aggregate.kind !== "incoming-cost-document" ||
    version.snapshot.kind !== "incoming-cost-document"
  ) {
    throw new Error(
      "Warehouse-price observations require an incoming cost-document version.",
    );
  }
  if (
    observation.source.aggregateId !== version.aggregate.id ||
    observation.source.accountingVersionId !== version.versionId ||
    observation.source.accountingVersionSha256 !==
      version.integrity.versionSha256 ||
    observation.source.lifecycleEventId !== event.eventId ||
    observation.source.lifecycleEventSha256 !== event.integrity.entrySha256 ||
    observation.effectiveAt !== event.effectiveAt ||
    observation.recordedAt !== event.recordedAt ||
    observation.reasonCode !== event.reasonCode ||
    observation.reasonDetailSha256 !== event.reasonDetailSha256 ||
    !sameActor(observation.actor, event.actor)
  ) {
    throw new Error(
      "Warehouse-price observation is not bound to its accounting source event.",
    );
  }

  const expectedEvent = {
    observed: "approved",
    corrected: "correction_linked",
    withdrawn: "review_reopened",
  } as const;
  if (event.eventType !== expectedEvent[observation.transition]) {
    throw new Error(
      "Warehouse-price transition does not match its accounting lifecycle event.",
    );
  }
  const allowedPurpose = {
    observed: new Set(["approved"]),
    corrected: new Set(["correction"]),
    withdrawn: new Set(["approved", "correction"]),
  } as const;
  if (!allowedPurpose[observation.transition].has(version.purpose as never)) {
    throw new Error(
      "Warehouse-price transition does not match its accounting version purpose.",
    );
  }

  const sourceLine = version.snapshot.lines.find(
    (line) => line.sourceLineId === observation.source.sourceLineId,
  );
  if (!sourceLine || sourceLine.lineType !== "material") {
    throw new Error(
      "Warehouse-price observation source line is missing or is not material.",
    );
  }
  if (observation.currency !== version.snapshot.document.currency) {
    throw new Error(
      "Warehouse-price currency does not match the accounting version.",
    );
  }
  if (
    observation.transition !== "withdrawn" &&
    observation.purchasePrice !== sourceLine.unitPriceWithoutVat
  ) {
    throw new Error(
      "Warehouse purchase price does not match the accounting source line.",
    );
  }
  return observation;
}

export function verifyAccountingWarehousePriceChainStep(
  previousValue: unknown,
  currentValue: unknown,
  supersededValue: unknown,
): AccountingWarehousePriceObservationV1 {
  const previous = verifyAccountingWarehousePriceObservation(previousValue);
  const current = verifyAccountingWarehousePriceObservation(currentValue);
  const superseded = verifyAccountingWarehousePriceObservation(supersededValue);
  if (
    current.warehouseItemId !== previous.warehouseItemId ||
    current.warehouseItemId !== superseded.warehouseItemId ||
    BigInt(current.sequence) !== BigInt(previous.sequence) + 1n ||
    current.previousObservationSha256 !== previous.integrity.entrySha256 ||
    current.supersedesObservationId !== superseded.observationId ||
    BigInt(superseded.sequence) >= BigInt(current.sequence)
  ) {
    throw new Error("Warehouse-price observation chain step is invalid.");
  }
  if (
    current.transition === "observed" &&
    current.supersedesObservationId !== previous.observationId
  ) {
    throw new Error(
      "A later observed warehouse price must supersede the previous item head.",
    );
  }
  if (
    current.transition === "withdrawn" &&
    (superseded.transition === "withdrawn" ||
      current.source.aggregateId !== superseded.source.aggregateId ||
      current.source.accountingVersionId !==
        superseded.source.accountingVersionId ||
      current.source.sourceLineId !== superseded.source.sourceLineId)
  ) {
    throw new Error(
      "Warehouse-price withdrawal does not target its active source observation.",
    );
  }
  if (
    current.transition === "corrected" &&
    current.supersedesObservationId !== previous.observationId &&
    (superseded.transition !== "withdrawn" ||
      current.source.aggregateId !== superseded.source.aggregateId)
  ) {
    throw new Error(
      "Corrected warehouse price must supersede either the previous item head or a withdrawal from the same document aggregate.",
    );
  }
  return current;
}
