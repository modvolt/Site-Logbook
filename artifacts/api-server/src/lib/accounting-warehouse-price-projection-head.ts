import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  deriveAccountingWarehousePriceProjection,
  type AccountingWarehousePriceProjectionV1,
} from "./accounting-warehouse-price-projection";
import {
  accountingWarehousePriceStreamEntryRecordedAt,
  verifyAccountingWarehousePriceStreamEntry,
} from "./accounting-warehouse-price-stream-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const SCHEMA = "site-logbook.warehouse-price-projection-head/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const PRICE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const priceSchema = z.string().regex(PRICE_PATTERN);
const bodyShape = {
  schemaVersion: z.literal(SCHEMA),
  warehouseItemId: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  streamHead: z
    .object({
      observationId: z.string().uuid(),
      observationSha256: sha256Schema,
      sequence: z.string().regex(SEQUENCE_PATTERN),
    })
    .strict(),
  effectivePrice: z
    .object({
      observationId: z.string().uuid(),
      observationSha256: sha256Schema,
      purchasePrice: priceSchema,
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict()
    .nullable(),
  valuationPolicy: z
    .object({
      mode: z.literal("source-currency"),
      fxConversionApplied: z.literal(false),
    })
    .strict(),
  projectedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine((value) => new Date(value).toISOString() === value),
};

const projectionHeadSchema = z
  .object({
    ...bodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(SCHEMA),
        projectionSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type AccountingWarehousePriceProjectionHeadV1 = z.infer<
  typeof projectionHeadSchema
>;

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function projectionSha256(
  value: AccountingWarehousePriceProjectionHeadV1,
): string {
  return sha256Hex(
    `${SCHEMA}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...value.integrity, projectionSha256: null },
    })}`,
  );
}

function toBody(
  projection: AccountingWarehousePriceProjectionV1,
  projectedAt: string,
) {
  if (
    projection.streamHeadObservationId === null ||
    projection.streamHeadObservationSha256 === null ||
    projection.streamHeadSequence === null
  ) {
    throw new Error(
      "Warehouse-price projection head requires a non-empty observation stream.",
    );
  }
  const effectivePrice =
    projection.effectiveObservationId === null ||
    projection.effectiveObservationSha256 === null ||
    projection.purchasePrice === null ||
    projection.currency === null
      ? null
      : {
          observationId: projection.effectiveObservationId,
          observationSha256: projection.effectiveObservationSha256,
          purchasePrice: projection.purchasePrice,
          currency: projection.currency,
        };
  if (
    effectivePrice === null &&
    (projection.effectiveObservationId !== null ||
      projection.effectiveObservationSha256 !== null ||
      projection.purchasePrice !== null ||
      projection.currency !== null)
  ) {
    throw new Error("Warehouse-price effective-price tuple is incomplete.");
  }
  return {
    schemaVersion: SCHEMA,
    warehouseItemId: projection.warehouseItemId,
    streamHead: {
      observationId: projection.streamHeadObservationId,
      observationSha256: projection.streamHeadObservationSha256,
      sequence: projection.streamHeadSequence,
    },
    effectivePrice,
    valuationPolicy: {
      mode: "source-currency" as const,
      fxConversionApplied: false as const,
    },
    projectedAt,
  };
}

export function createAccountingWarehousePriceProjectionHead(input: {
  warehouseItemId: string;
  observations: unknown[];
}): AccountingWarehousePriceProjectionHeadV1 {
  const observations = input.observations.map((value) =>
    verifyAccountingWarehousePriceStreamEntry(value),
  );
  const streamHead = observations.at(-1);
  if (!streamHead) {
    throw new Error(
      "Warehouse-price projection head requires a non-empty observation stream.",
    );
  }
  const body = toBody(
    deriveAccountingWarehousePriceProjection({
      warehouseItemId: input.warehouseItemId,
      observations,
    }),
    accountingWarehousePriceStreamEntryRecordedAt(streamHead),
  );
  const candidate = projectionHeadSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: SCHEMA,
      projectionSha256: "0".repeat(64),
    },
  });
  return projectionHeadSchema.parse({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      projectionSha256: projectionSha256(candidate),
    },
  });
}

export function verifyAccountingWarehousePriceProjectionHead(
  value: unknown,
): AccountingWarehousePriceProjectionHeadV1 {
  const head = projectionHeadSchema.parse(value);
  if (!safeEqualHex(head.integrity.projectionSha256, projectionSha256(head))) {
    throw new Error("Warehouse-price projection-head digest does not match.");
  }
  return head;
}

export function verifyAccountingWarehousePriceProjectionHeadBinding(
  value: unknown,
  observations: unknown[],
): AccountingWarehousePriceProjectionHeadV1 {
  const head = verifyAccountingWarehousePriceProjectionHead(value);
  const expected = createAccountingWarehousePriceProjectionHead({
    warehouseItemId: head.warehouseItemId,
    observations,
  });
  if (canonicalEvidenceJson(head) !== canonicalEvidenceJson(expected)) {
    throw new Error(
      "Warehouse-price projection head does not match immutable observations.",
    );
  }
  return head;
}

export function canonicalAccountingWarehousePriceProjectionHeadJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceProjectionHead(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceProjectionHeadV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const head = verifyAccountingWarehousePriceProjectionHead(JSON.parse(text));
  if (canonicalEvidenceJson(head) !== text) {
    throw new Error(
      "Warehouse-price projection-head bytes are not canonical JSON.",
    );
  }
  return head;
}
