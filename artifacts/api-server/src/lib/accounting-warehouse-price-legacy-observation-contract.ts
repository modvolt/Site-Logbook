import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

export const ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_SCHEMA_V1 =
  "site-logbook.warehouse-price-legacy-observation/v1" as const;
const HASH_DOMAIN = ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_SCHEMA_V1;
const LEGACY_ROWS_HASH_DOMAIN =
  "site-logbook.warehouse-price-legacy-rows/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const PRICE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const positiveIdSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const priceSchema = z
  .string()
  .regex(PRICE_PATTERN)
  .superRefine((value, context) => {
    const fraction = value.split(".")[1];
    if (fraction && fraction.length > 4) {
      context.addIssue({
        code: "custom",
        message: "Legacy purchase-price scale exceeds four decimal places.",
      });
    }
    if (fraction?.endsWith("0")) {
      context.addIssue({
        code: "custom",
        message: "Legacy purchase price must not contain trailing zeroes.",
      });
    }
  });

const latestLegacyRowSchema = z
  .object({
    legacyRowId: positiveIdSchema,
    rowSha256: sha256Schema,
    observedBillingDocumentId: positiveIdSchema.nullable(),
    observedBillingDocumentLineId: positiveIdSchema.nullable(),
    purchasePrice: priceSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    sourceRecordedAt: timestampSchema,
    referenceConfidence: z.literal("unverified-legacy-reference"),
  })
  .strict();

const bodyShape = {
  schemaVersion: z.literal(
    ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_SCHEMA_V1,
  ),
  observationId: z.string().uuid(),
  warehouseItemId: positiveIdSchema,
  sequence: z.literal("0"),
  previousObservationSha256: z.null(),
  supersedesObservationId: z.null(),
  transition: z.literal("legacy_observation"),
  source: z
    .object({
      parityReportSha256: sha256Schema,
      parityReportFileSha256: sha256Schema,
      legacyRowsSha256: sha256Schema,
      legacyRowCount: z.number().int().positive().max(500_000),
      latestLegacyRow: latestLegacyRowSchema,
    })
    .strict(),
  purchasePrice: priceSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  valuationPolicy: z
    .object({
      mode: z.literal("source-currency"),
      fxConversionApplied: z.literal(false),
    })
    .strict(),
  provenance: z
    .object({
      captureMode: z.literal("legacy-observation"),
      capturedAt: timestampSchema,
      historicalCompleteness: z.literal("unknown"),
      actorKnown: z.literal(false),
      effectiveAtKnown: z.literal(false),
      eventHistoryFabricated: z.literal(false),
      accountingVersionId: z.null(),
      lifecycleEventId: z.null(),
    })
    .strict(),
};

const bodySchema = z.object(bodyShape).strict();

export const ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_ZOD_SCHEMA_V1 = z
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
  .strict();

type LegacyObservationBodyV1 = z.infer<typeof bodySchema>;
export type AccountingWarehousePriceLegacyObservationV1 = z.infer<
  typeof ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_ZOD_SCHEMA_V1
>;

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function entrySha256(body: LegacyObservationBodyV1): string {
  return sha256Hex(`${HASH_DOMAIN}\0${canonicalEvidenceJson(body)}`);
}

export function createAccountingWarehousePriceLegacyObservation(
  input: LegacyObservationBodyV1,
): AccountingWarehousePriceLegacyObservationV1 {
  const body = bodySchema.parse(input);
  return verifyAccountingWarehousePriceLegacyObservation({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: HASH_DOMAIN,
      entrySha256: entrySha256(body),
    },
  });
}

export function verifyAccountingWarehousePriceLegacyObservation(
  value: unknown,
): AccountingWarehousePriceLegacyObservationV1 {
  const observation =
    ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_ZOD_SCHEMA_V1.parse(value);
  const { integrity: _integrity, ...body } = observation;
  if (!safeEqualHex(observation.integrity.entrySha256, entrySha256(body))) {
    throw new Error(
      "Warehouse-price legacy observation integrity verification failed.",
    );
  }
  if (
    observation.purchasePrice !==
      observation.source.latestLegacyRow.purchasePrice ||
    observation.currency !== observation.source.latestLegacyRow.currency
  ) {
    throw new Error(
      "Warehouse-price legacy observation does not match its latest legacy row.",
    );
  }
  if (
    observation.source.latestLegacyRow.sourceRecordedAt >
    observation.provenance.capturedAt
  ) {
    throw new Error(
      "Warehouse-price legacy observation was captured before its source row.",
    );
  }
  return observation;
}

export function canonicalAccountingWarehousePriceLegacyObservationJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceLegacyObservation(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceLegacyObservationJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceLegacyObservationV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const observation = verifyAccountingWarehousePriceLegacyObservation(
    JSON.parse(text),
  );
  if (canonicalEvidenceJson(observation) !== text) {
    throw new Error(
      "Warehouse-price legacy observation bytes are not exact canonical JSON.",
    );
  }
  return observation;
}

export function accountingWarehousePriceLegacyRowsSha256(
  rows: ReadonlyArray<{ legacyRowId: string; rowSha256: string }>,
): string {
  const normalized = rows
    .map((row) => ({
      legacyRowId: positiveIdSchema.parse(row.legacyRowId),
      rowSha256: sha256Schema.parse(row.rowSha256),
    }))
    .sort((left, right) =>
      BigInt(left.legacyRowId) < BigInt(right.legacyRowId)
        ? -1
        : BigInt(left.legacyRowId) > BigInt(right.legacyRowId)
          ? 1
          : 0,
    );
  if (
    new Set(normalized.map((row) => row.legacyRowId)).size !== normalized.length
  ) {
    throw new Error("Warehouse-price legacy rows contain duplicate IDs.");
  }
  return sha256Hex(
    `${LEGACY_ROWS_HASH_DOMAIN}\0${canonicalEvidenceJson(normalized)}`,
  );
}
