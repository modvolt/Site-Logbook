import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  deriveAccountingWarehousePriceProjection,
  type AccountingWarehousePriceProjectionV1,
} from "./accounting-warehouse-price-projection";
import {
  verifyAccountingWarehousePriceProjectionHeadBinding,
  type AccountingWarehousePriceProjectionHeadV1,
} from "./accounting-warehouse-price-projection-head";
import {
  accountingWarehousePriceLegacyRowsSha256,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  isAccountingWarehousePriceLegacyObservation,
  verifyAccountingWarehousePriceStreamEntry,
} from "./accounting-warehouse-price-stream-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const SCHEMA = "site-logbook.warehouse-price-parity-report/v2" as const;
const HASH_DOMAIN = SCHEMA;
const LEGACY_ROW_HASH_DOMAIN =
  "site-logbook.warehouse-price-legacy-row/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const positiveIdSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const classificationSchema = z.enum([
  "empty",
  "native_match",
  "native_match_empty",
  "native_projection_missing",
  "native_price_mismatch",
  "native_legacy_overlap",
  "legacy_bootstrap_match",
  "legacy_only",
  "legacy_projection_mismatch",
  "unproven_current_price",
]);
const decisionSchema = z.enum(["PASS", "REVIEW", "BLOCK"]);

const projectionSchema = z
  .object({
    warehouseItemId: positiveIdSchema,
    streamHeadObservationId: z.string().uuid().nullable(),
    streamHeadObservationSha256: sha256Schema.nullable(),
    streamHeadSequence: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .nullable(),
    effectiveObservationId: z.string().uuid().nullable(),
    effectiveObservationSha256: sha256Schema.nullable(),
    purchasePrice: z.string().regex(DECIMAL_PATTERN).nullable(),
    currency: currencySchema.nullable(),
  })
  .strict();

const legacyRowBodySchema = z
  .object({
    legacyRowId: positiveIdSchema,
    warehouseItemId: positiveIdSchema,
    billingDocumentId: positiveIdSchema.nullable(),
    billingDocumentLineId: positiveIdSchema.nullable(),
    purchasePrice: z.string().regex(DECIMAL_PATTERN),
    currency: currencySchema,
    recordedAt: timestampSchema,
    historicalCompleteness: z.literal("unknown"),
  })
  .strict();
const legacyRowSchema = z
  .object({
    ...legacyRowBodySchema.shape,
    rowSha256: sha256Schema,
  })
  .strict();

const itemSchema = z
  .object({
    warehouseItemId: positiveIdSchema,
    storedPurchasePrice: z.string().regex(DECIMAL_PATTERN).nullable(),
    storedCurrency: currencySchema.nullable(),
    classification: classificationSchema,
    projection: projectionSchema,
    projectionHead: z.unknown().nullable(),
    observations: z.array(z.unknown()),
    legacyRows: z.array(legacyRowSchema),
  })
  .strict();

const reportBodyShape = {
  schemaVersion: z.literal(SCHEMA),
  targetFingerprint: sha256Schema,
  observedAt: timestampSchema,
  readBoundary: z
    .object({
      transactionReadOnly: z.literal(true),
      isolation: z.literal("repeatable read"),
      mutationsSupported: z.literal(false),
    })
    .strict(),
  limits: z
    .object({
      maxItems: z.number().int().positive(),
      maxObservations: z.number().int().positive(),
      maxLegacyRows: z.number().int().positive(),
    })
    .strict(),
  summary: z
    .object({
      decision: decisionSchema,
      itemCount: z.number().int().nonnegative(),
      observationCount: z.number().int().nonnegative(),
      legacyRowCount: z.number().int().nonnegative(),
      classificationCounts: z.record(
        classificationSchema,
        z.number().int().nonnegative(),
      ),
    })
    .strict(),
  items: z.array(itemSchema),
};

const reportSchema = z
  .object({
    ...reportBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(HASH_DOMAIN),
        reportSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type AccountingWarehousePriceParityClassification = z.infer<
  typeof classificationSchema
>;
export type AccountingWarehousePriceParityReportV1 = z.infer<
  typeof reportSchema
>;
export type AccountingWarehousePriceLegacyRowInputV1 = Omit<
  z.infer<typeof legacyRowSchema>,
  "rowSha256" | "historicalCompleteness"
>;

export interface AccountingWarehousePriceParityItemInputV1 {
  warehouseItemId: string;
  storedPurchasePrice: string | null;
  observations: unknown[];
  projectionHead?: unknown | null;
  legacyRows: AccountingWarehousePriceLegacyRowInputV1[];
}

const ALL_CLASSIFICATIONS = classificationSchema.options;

function canonicalDecimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error("Warehouse-price parity received an invalid decimal.");
  }
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function legacyRow(input: AccountingWarehousePriceLegacyRowInputV1) {
  const body = legacyRowBodySchema.parse({
    ...input,
    purchasePrice: canonicalDecimal(input.purchasePrice),
    historicalCompleteness: "unknown",
  });
  return legacyRowSchema.parse({
    ...body,
    rowSha256: sha256Hex(
      `${LEGACY_ROW_HASH_DOMAIN}\0${canonicalEvidenceJson(body)}`,
    ),
  });
}

function latestLegacyRow(
  rows: Array<z.infer<typeof legacyRowSchema>>,
): z.infer<typeof legacyRowSchema> | null {
  return (
    [...rows]
      .sort((left, right) => {
        const byTime = left.recordedAt.localeCompare(right.recordedAt);
        if (byTime !== 0) return byTime;
        return BigInt(left.legacyRowId) < BigInt(right.legacyRowId)
          ? -1
          : BigInt(left.legacyRowId) > BigInt(right.legacyRowId)
            ? 1
            : 0;
      })
      .at(-1) ?? null
  );
}

function legacyBootstrapMatches(
  observation: AccountingWarehousePriceLegacyObservationV1,
  rows: Array<z.infer<typeof legacyRowSchema>>,
): boolean {
  const latest = latestLegacyRow(rows);
  return (
    latest !== null &&
    observation.source.legacyRowCount === rows.length &&
    observation.source.legacyRowsSha256 ===
      accountingWarehousePriceLegacyRowsSha256(rows) &&
    observation.source.latestLegacyRow.legacyRowId === latest.legacyRowId &&
    observation.source.latestLegacyRow.rowSha256 === latest.rowSha256 &&
    observation.source.latestLegacyRow.observedBillingDocumentId ===
      latest.billingDocumentId &&
    observation.source.latestLegacyRow.observedBillingDocumentLineId ===
      latest.billingDocumentLineId &&
    observation.source.latestLegacyRow.purchasePrice === latest.purchasePrice &&
    observation.source.latestLegacyRow.currency === latest.currency &&
    observation.source.latestLegacyRow.sourceRecordedAt === latest.recordedAt
  );
}

function samePrice(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return canonicalDecimal(left) === canonicalDecimal(right);
}

function classify(input: {
  projection: AccountingWarehousePriceProjectionV1;
  projectionHead: AccountingWarehousePriceProjectionHeadV1 | null;
  storedPurchasePrice: string | null;
  storedCurrency: string | null;
  legacyRows: Array<z.infer<typeof legacyRowSchema>>;
  observations: unknown[];
}): AccountingWarehousePriceParityClassification {
  const observations = input.observations.map((entry) =>
    verifyAccountingWarehousePriceStreamEntry(entry),
  );
  const first = observations[0] ?? null;
  const hasStream = input.projection.streamHeadObservationId !== null;
  const hasBoundLegacyBootstrap =
    first !== null &&
    isAccountingWarehousePriceLegacyObservation(first) &&
    legacyBootstrapMatches(first, input.legacyRows);
  if (hasStream && input.legacyRows.length > 0 && !hasBoundLegacyBootstrap) {
    return "native_legacy_overlap";
  }
  if (hasStream) {
    if (input.projectionHead === null) return "native_projection_missing";
    if (!samePrice(input.projection.purchasePrice, input.storedPurchasePrice)) {
      return "native_price_mismatch";
    }
    if (input.projection.purchasePrice === null) {
      return input.storedCurrency === null
        ? "native_match_empty"
        : "native_price_mismatch";
    }
    if (input.storedCurrency !== input.projection.currency) {
      return "native_price_mismatch";
    }
    return observations.length === 1 && hasBoundLegacyBootstrap
      ? "legacy_bootstrap_match"
      : "native_match";
  }
  if (input.legacyRows.length > 0) {
    return samePrice(
      latestLegacyRow(input.legacyRows)?.purchasePrice ?? null,
      input.storedPurchasePrice,
    )
      ? "legacy_only"
      : "legacy_projection_mismatch";
  }
  return input.storedPurchasePrice === null && input.storedCurrency === null
    ? "empty"
    : "unproven_current_price";
}

export function createAccountingWarehousePriceParityItem(
  input: AccountingWarehousePriceParityItemInputV1,
) {
  if (!POSITIVE_DECIMAL_PATTERN.test(input.warehouseItemId)) {
    throw new Error("Warehouse-price parity item ID is invalid.");
  }
  const projection = deriveAccountingWarehousePriceProjection({
    warehouseItemId: input.warehouseItemId,
    observations: input.observations,
  });
  const storedPurchasePrice =
    input.storedPurchasePrice === null
      ? null
      : canonicalDecimal(input.storedPurchasePrice);
  const projectionHead =
    input.projectionHead == null
      ? null
      : verifyAccountingWarehousePriceProjectionHeadBinding(
          input.projectionHead,
          input.observations,
        );
  if (
    projectionHead !== null &&
    projectionHead.warehouseItemId !== input.warehouseItemId
  ) {
    throw new Error("Warehouse-price parity projection head mixes items.");
  }
  const storedCurrency =
    projectionHead?.effectivePrice?.currency == null
      ? null
      : currencySchema.parse(projectionHead.effectivePrice.currency);
  const legacyRows = input.legacyRows
    .map(legacyRow)
    .sort((left, right) =>
      BigInt(left.legacyRowId) < BigInt(right.legacyRowId)
        ? -1
        : BigInt(left.legacyRowId) > BigInt(right.legacyRowId)
          ? 1
          : 0,
    );
  if (
    new Set(legacyRows.map((row) => row.legacyRowId)).size !== legacyRows.length
  ) {
    throw new Error("Warehouse-price parity contains duplicate legacy rows.");
  }
  for (const row of legacyRows) {
    if (row.warehouseItemId !== input.warehouseItemId) {
      throw new Error("Warehouse-price parity mixes legacy warehouse items.");
    }
  }
  return itemSchema.parse({
    warehouseItemId: input.warehouseItemId,
    storedPurchasePrice,
    storedCurrency,
    classification: classify({
      projection,
      projectionHead,
      storedPurchasePrice,
      storedCurrency,
      legacyRows,
      observations: input.observations,
    }),
    projection,
    projectionHead,
    observations: input.observations,
    legacyRows,
  });
}

function reportDecision(
  counts: Record<AccountingWarehousePriceParityClassification, number>,
): "PASS" | "REVIEW" | "BLOCK" {
  const blocking =
    counts.native_projection_missing +
    counts.native_price_mismatch +
    counts.native_legacy_overlap +
    counts.legacy_projection_mismatch +
    counts.unproven_current_price;
  if (blocking > 0) return "BLOCK";
  return counts.legacy_only > 0 ? "REVIEW" : "PASS";
}

function reportSha256(value: AccountingWarehousePriceParityReportV1): string {
  return sha256Hex(
    `${HASH_DOMAIN}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...value.integrity, reportSha256: null },
    })}`,
  );
}

export function createAccountingWarehousePriceParityReport(input: {
  targetFingerprint: string;
  observedAt: string;
  limits: {
    maxItems: number;
    maxObservations: number;
    maxLegacyRows: number;
  };
  items: AccountingWarehousePriceParityItemInputV1[];
}): AccountingWarehousePriceParityReportV1 {
  const orderedItems = input.items
    .map(createAccountingWarehousePriceParityItem)
    .sort((left, right) =>
      BigInt(left.warehouseItemId) < BigInt(right.warehouseItemId) ? -1 : 1,
    );
  if (
    new Set(orderedItems.map((item) => item.warehouseItemId)).size !==
    orderedItems.length
  ) {
    throw new Error("Warehouse-price parity contains duplicate items.");
  }
  const limits = reportBodyShape.limits.parse(input.limits);
  const observationCount = orderedItems.reduce(
    (sum, item) => sum + item.observations.length,
    0,
  );
  const legacyRowCount = orderedItems.reduce(
    (sum, item) => sum + item.legacyRows.length,
    0,
  );
  if (
    orderedItems.length > limits.maxItems ||
    observationCount > limits.maxObservations ||
    legacyRowCount > limits.maxLegacyRows
  ) {
    throw new Error(
      "Warehouse-price parity inventory exceeds approved limits.",
    );
  }
  const classificationCounts = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<AccountingWarehousePriceParityClassification, number>;
  for (const item of orderedItems) {
    classificationCounts[item.classification] += 1;
  }
  const candidate = reportSchema.parse({
    schemaVersion: SCHEMA,
    targetFingerprint: input.targetFingerprint,
    observedAt: input.observedAt,
    readBoundary: {
      transactionReadOnly: true,
      isolation: "repeatable read",
      mutationsSupported: false,
    },
    limits,
    summary: {
      decision: reportDecision(classificationCounts),
      itemCount: orderedItems.length,
      observationCount,
      legacyRowCount,
      classificationCounts,
    },
    items: orderedItems,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: HASH_DOMAIN,
      reportSha256: "0".repeat(64),
    },
  });
  return reportSchema.parse({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      reportSha256: reportSha256(candidate),
    },
  });
}

export function canonicalAccountingWarehousePriceParityReportJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceParityReport(value),
  );
}

export function verifyAccountingWarehousePriceParityReport(
  value: unknown,
): AccountingWarehousePriceParityReportV1 {
  const report = reportSchema.parse(value);
  if (!safeEqualHex(report.integrity.reportSha256, reportSha256(report))) {
    throw new Error("Warehouse-price parity report digest does not match.");
  }
  const rebuilt = createAccountingWarehousePriceParityReport({
    targetFingerprint: report.targetFingerprint,
    observedAt: report.observedAt,
    limits: report.limits,
    items: report.items.map((item) => ({
      warehouseItemId: item.warehouseItemId,
      storedPurchasePrice: item.storedPurchasePrice,
      observations: item.observations,
      projectionHead: item.projectionHead,
      legacyRows: item.legacyRows.map(
        ({
          rowSha256: _rowSha256,
          historicalCompleteness: _completeness,
          ...row
        }) => row,
      ),
    })),
  });
  if (canonicalEvidenceJson(rebuilt) !== canonicalEvidenceJson(report)) {
    throw new Error("Warehouse-price parity report semantics do not match.");
  }
  return report;
}

export function verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceParityReportV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const report = verifyAccountingWarehousePriceParityReport(JSON.parse(text));
  if (canonicalEvidenceJson(report) !== text) {
    throw new Error(
      "Warehouse-price parity report bytes are not canonical JSON.",
    );
  }
  return report;
}
