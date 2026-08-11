import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  verifyCanonicalAccountingWarehousePriceParityReportJsonBytes,
  type AccountingWarehousePriceParityClassification,
  type AccountingWarehousePriceParityReportV1,
} from "./accounting-warehouse-price-parity";
import {
  ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_ZOD_SCHEMA_V1,
  accountingWarehousePriceLegacyRowsSha256,
  createAccountingWarehousePriceLegacyObservation,
  verifyAccountingWarehousePriceLegacyObservation,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const PLAN_SCHEMA = "site-logbook.warehouse-price-bootstrap-plan/v1" as const;
const PLAN_KIND = "warehouse-price-legacy-bootstrap-dry-run" as const;
const PLAN_HASH_DOMAIN = PLAN_SCHEMA;
const LEGACY_OBSERVATION_ID_DOMAIN =
  "site-logbook.warehouse-price-legacy-observation-id/v1" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const positiveIdSchema = z.string().regex(POSITIVE_DECIMAL_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);

const blockedClassificationSchema = z.enum([
  "native_projection_missing",
  "native_price_mismatch",
  "native_legacy_overlap",
  "legacy_projection_mismatch",
  "unproven_current_price",
]);

const blockerSchema = z
  .object({
    warehouseItemId: positiveIdSchema,
    classification: blockedClassificationSchema,
  })
  .strict();

const planBodyShape = {
  schemaVersion: z.literal(PLAN_SCHEMA),
  kind: z.literal(PLAN_KIND),
  sourceReport: z
    .object({
      schemaVersion: z.literal("site-logbook.warehouse-price-parity-report/v2"),
      targetFingerprint: sha256Schema,
      observedAt: timestampSchema,
      reportSha256: sha256Schema,
      reportFileSha256: sha256Schema,
    })
    .strict(),
  executionBoundary: z
    .object({
      mode: z.literal("dry-run"),
      mutationsSupported: z.literal(false),
      applyCommandAvailable: z.literal(false),
      numberedMigrationIncluded: z.literal(false),
      runtimeActivationIncluded: z.literal(false),
      readCutoverIncluded: z.literal(false),
      explicitFutureApprovalRequired: z.literal(true),
    })
    .strict(),
  policy: z
    .object({
      oneObservationPerWarehouseItem: z.literal(true),
      historicalCompleteness: z.literal("unknown"),
      actorHistoryFabricated: z.literal(false),
      effectiveTimeFabricated: z.literal(false),
      lifecycleEventFabricated: z.literal(false),
      valuationMode: z.literal("source-currency"),
      fxConversionApplied: z.literal(false),
    })
    .strict(),
  limits: z
    .object({
      maxPlannedItems: z.number().int().positive(),
      sourceMaxItems: z.number().int().positive(),
      sourceMaxObservations: z.number().int().positive(),
      sourceMaxLegacyRows: z.number().int().positive(),
    })
    .strict(),
  summary: z
    .object({
      decision: z.enum(["PASS", "REVIEW", "BLOCK"]),
      inputItemCount: z.number().int().nonnegative(),
      candidateItemCount: z.number().int().nonnegative(),
      plannedObservationCount: z.number().int().nonnegative(),
      blockedItemCount: z.number().int().nonnegative(),
      noActionItemCount: z.number().int().nonnegative(),
    })
    .strict(),
  candidates: z.array(
    ACCOUNTING_WAREHOUSE_PRICE_LEGACY_OBSERVATION_ZOD_SCHEMA_V1,
  ),
  blockers: z.array(blockerSchema),
};

const planSchema = z
  .object({
    ...planBodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(PLAN_HASH_DOMAIN),
        planSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type { AccountingWarehousePriceLegacyObservationV1 };
export type AccountingWarehousePriceBootstrapPlanV1 = z.infer<
  typeof planSchema
>;

const NO_ACTION_CLASSIFICATIONS =
  new Set<AccountingWarehousePriceParityClassification>([
    "empty",
    "native_match",
    "native_match_empty",
    "legacy_bootstrap_match",
  ]);
const BLOCKED_CLASSIFICATIONS =
  new Set<AccountingWarehousePriceParityClassification>(
    blockedClassificationSchema.options,
  );

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function comparePositiveIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function deterministicUuidV5(seedSha256: string): string {
  const bytes = Buffer.from(seedSha256.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function observationId(input: {
  targetFingerprint: string;
  reportSha256: string;
  warehouseItemId: string;
  legacyRowsSha256: string;
}): string {
  return deterministicUuidV5(
    sha256Hex(
      `${LEGACY_OBSERVATION_ID_DOMAIN}\0${canonicalEvidenceJson(input)}`,
    ),
  );
}

function buildCandidate(input: {
  report: AccountingWarehousePriceParityReportV1;
  reportFileSha256: string;
  item: AccountingWarehousePriceParityReportV1["items"][number];
}): AccountingWarehousePriceLegacyObservationV1 {
  const orderedRows = [...input.item.legacyRows].sort((left, right) =>
    comparePositiveIds(left.legacyRowId, right.legacyRowId),
  );
  const latest = [...orderedRows]
    .sort((left, right) => {
      const byTime = left.recordedAt.localeCompare(right.recordedAt);
      return byTime !== 0
        ? byTime
        : comparePositiveIds(left.legacyRowId, right.legacyRowId);
    })
    .at(-1);
  if (!latest || input.item.classification !== "legacy_only") {
    throw new Error(
      "Warehouse-price bootstrap candidate requires a legacy-only item.",
    );
  }
  if (input.item.storedPurchasePrice !== latest.purchasePrice) {
    throw new Error(
      "Warehouse-price bootstrap candidate does not match the current legacy projection.",
    );
  }
  const rowsSha256 = accountingWarehousePriceLegacyRowsSha256(orderedRows);
  return createAccountingWarehousePriceLegacyObservation({
    schemaVersion: "site-logbook.warehouse-price-legacy-observation/v1",
    observationId: observationId({
      targetFingerprint: input.report.targetFingerprint,
      reportSha256: input.report.integrity.reportSha256,
      warehouseItemId: input.item.warehouseItemId,
      legacyRowsSha256: rowsSha256,
    }),
    warehouseItemId: input.item.warehouseItemId,
    sequence: "0",
    previousObservationSha256: null,
    supersedesObservationId: null,
    transition: "legacy_observation",
    source: {
      parityReportSha256: input.report.integrity.reportSha256,
      parityReportFileSha256: input.reportFileSha256,
      legacyRowsSha256: rowsSha256,
      legacyRowCount: orderedRows.length,
      latestLegacyRow: {
        legacyRowId: latest.legacyRowId,
        rowSha256: latest.rowSha256,
        observedBillingDocumentId: latest.billingDocumentId,
        observedBillingDocumentLineId: latest.billingDocumentLineId,
        purchasePrice: latest.purchasePrice,
        currency: latest.currency,
        sourceRecordedAt: latest.recordedAt,
        referenceConfidence: "unverified-legacy-reference",
      },
    },
    purchasePrice: latest.purchasePrice,
    currency: latest.currency,
    valuationPolicy: {
      mode: "source-currency",
      fxConversionApplied: false,
    },
    provenance: {
      captureMode: "legacy-observation",
      capturedAt: input.report.observedAt,
      historicalCompleteness: "unknown",
      actorKnown: false,
      effectiveAtKnown: false,
      eventHistoryFabricated: false,
      accountingVersionId: null,
      lifecycleEventId: null,
    },
  });
}

function planSha256(value: AccountingWarehousePriceBootstrapPlanV1): string {
  return sha256Hex(
    `${PLAN_HASH_DOMAIN}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...value.integrity, planSha256: null },
    })}`,
  );
}

function expectedDecision(input: {
  candidates: number;
  blockers: number;
}): "PASS" | "REVIEW" | "BLOCK" {
  if (input.blockers > 0) return "BLOCK";
  return input.candidates > 0 ? "REVIEW" : "PASS";
}

function validateInternalSemantics(
  plan: AccountingWarehousePriceBootstrapPlanV1,
): void {
  const candidateIds = plan.candidates.map((entry) => entry.warehouseItemId);
  const blockerIds = plan.blockers.map((entry) => entry.warehouseItemId);
  const allPlannedIds = [...candidateIds, ...blockerIds];
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error(
      "Warehouse-price bootstrap plan contains duplicate candidates.",
    );
  }
  if (new Set(blockerIds).size !== blockerIds.length) {
    throw new Error(
      "Warehouse-price bootstrap plan contains duplicate blockers.",
    );
  }
  if (new Set(allPlannedIds).size !== allPlannedIds.length) {
    throw new Error(
      "Warehouse-price bootstrap item cannot be both a candidate and a blocker.",
    );
  }
  const sortedCandidates = [...candidateIds].sort(comparePositiveIds);
  const sortedBlockers = [...blockerIds].sort(comparePositiveIds);
  if (
    canonicalEvidenceJson(candidateIds) !==
    canonicalEvidenceJson(sortedCandidates)
  ) {
    throw new Error("Warehouse-price bootstrap candidates are not ordered.");
  }
  if (
    canonicalEvidenceJson(blockerIds) !== canonicalEvidenceJson(sortedBlockers)
  ) {
    throw new Error("Warehouse-price bootstrap blockers are not ordered.");
  }
  if (plan.candidates.length > plan.limits.maxPlannedItems) {
    throw new Error(
      "Warehouse-price bootstrap candidates exceed the approved limit.",
    );
  }
  if (
    plan.summary.inputItemCount !==
      plan.summary.candidateItemCount +
        plan.summary.blockedItemCount +
        plan.summary.noActionItemCount ||
    plan.summary.candidateItemCount !== plan.candidates.length ||
    plan.summary.plannedObservationCount !== plan.candidates.length ||
    plan.summary.blockedItemCount !== plan.blockers.length
  ) {
    throw new Error("Warehouse-price bootstrap summary counts do not match.");
  }
  if (
    plan.summary.decision !==
    expectedDecision({
      candidates: plan.candidates.length,
      blockers: plan.blockers.length,
    })
  ) {
    throw new Error("Warehouse-price bootstrap decision does not match.");
  }
  for (const entry of plan.candidates) {
    if (
      entry.source.parityReportSha256 !== plan.sourceReport.reportSha256 ||
      entry.source.parityReportFileSha256 !==
        plan.sourceReport.reportFileSha256 ||
      entry.provenance.capturedAt !== plan.sourceReport.observedAt
    ) {
      throw new Error(
        "Warehouse-price bootstrap candidate is not bound to its source report.",
      );
    }
    verifyAccountingWarehousePriceLegacyObservation(entry);
    if (
      entry.observationId !==
      observationId({
        targetFingerprint: plan.sourceReport.targetFingerprint,
        reportSha256: plan.sourceReport.reportSha256,
        warehouseItemId: entry.warehouseItemId,
        legacyRowsSha256: entry.source.legacyRowsSha256,
      })
    ) {
      throw new Error(
        "Warehouse-price legacy observation ID is not deterministic.",
      );
    }
    if (
      entry.purchasePrice !== entry.source.latestLegacyRow.purchasePrice ||
      entry.currency !== entry.source.latestLegacyRow.currency
    ) {
      throw new Error(
        "Warehouse-price legacy observation does not match its latest legacy row.",
      );
    }
  }
}

export function createAccountingWarehousePriceBootstrapPlan(input: {
  parityReportBytes: string | Buffer;
  maxPlannedItems: number;
}): AccountingWarehousePriceBootstrapPlanV1 {
  if (!Number.isInteger(input.maxPlannedItems) || input.maxPlannedItems <= 0) {
    throw new Error(
      "Warehouse-price bootstrap limit must be a positive integer.",
    );
  }
  const reportBytes = Buffer.isBuffer(input.parityReportBytes)
    ? input.parityReportBytes
    : Buffer.from(input.parityReportBytes, "utf8");
  const report =
    verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(reportBytes);
  const reportFileSha256 = sha256Hex(reportBytes);
  const candidates = report.items
    .filter((item) => item.classification === "legacy_only")
    .map((item) => buildCandidate({ report, reportFileSha256, item }))
    .sort((left, right) =>
      comparePositiveIds(left.warehouseItemId, right.warehouseItemId),
    );
  if (candidates.length > input.maxPlannedItems) {
    throw new Error(
      `Warehouse-price bootstrap candidate count ${candidates.length} exceeds approved limit ${input.maxPlannedItems}.`,
    );
  }
  const blockers = report.items
    .filter((item) => BLOCKED_CLASSIFICATIONS.has(item.classification))
    .map((item) =>
      blockerSchema.parse({
        warehouseItemId: item.warehouseItemId,
        classification: item.classification,
      }),
    )
    .sort((left, right) =>
      comparePositiveIds(left.warehouseItemId, right.warehouseItemId),
    );
  const noActionItemCount = report.items.filter((item) =>
    NO_ACTION_CLASSIFICATIONS.has(item.classification),
  ).length;
  if (
    candidates.length + blockers.length + noActionItemCount !==
    report.items.length
  ) {
    throw new Error(
      "Warehouse-price bootstrap encountered an unclassified parity item.",
    );
  }
  const candidate = planSchema.parse({
    schemaVersion: PLAN_SCHEMA,
    kind: PLAN_KIND,
    sourceReport: {
      schemaVersion: report.schemaVersion,
      targetFingerprint: report.targetFingerprint,
      observedAt: report.observedAt,
      reportSha256: report.integrity.reportSha256,
      reportFileSha256,
    },
    executionBoundary: {
      mode: "dry-run",
      mutationsSupported: false,
      applyCommandAvailable: false,
      numberedMigrationIncluded: false,
      runtimeActivationIncluded: false,
      readCutoverIncluded: false,
      explicitFutureApprovalRequired: true,
    },
    policy: {
      oneObservationPerWarehouseItem: true,
      historicalCompleteness: "unknown",
      actorHistoryFabricated: false,
      effectiveTimeFabricated: false,
      lifecycleEventFabricated: false,
      valuationMode: "source-currency",
      fxConversionApplied: false,
    },
    limits: {
      maxPlannedItems: input.maxPlannedItems,
      sourceMaxItems: report.limits.maxItems,
      sourceMaxObservations: report.limits.maxObservations,
      sourceMaxLegacyRows: report.limits.maxLegacyRows,
    },
    summary: {
      decision: expectedDecision({
        candidates: candidates.length,
        blockers: blockers.length,
      }),
      inputItemCount: report.items.length,
      candidateItemCount: candidates.length,
      plannedObservationCount: candidates.length,
      blockedItemCount: blockers.length,
      noActionItemCount,
    },
    candidates,
    blockers,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: PLAN_HASH_DOMAIN,
      planSha256: "0".repeat(64),
    },
  });
  const plan = planSchema.parse({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      planSha256: planSha256(candidate),
    },
  });
  validateInternalSemantics(plan);
  return plan;
}

export function verifyAccountingWarehousePriceBootstrapPlan(
  value: unknown,
): AccountingWarehousePriceBootstrapPlanV1 {
  const plan = planSchema.parse(value);
  validateInternalSemantics(plan);
  if (!safeEqualHex(plan.integrity.planSha256, planSha256(plan))) {
    throw new Error("Warehouse-price bootstrap plan digest does not match.");
  }
  return plan;
}

export function canonicalAccountingWarehousePriceBootstrapPlanJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapPlan(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapPlanV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const plan = verifyAccountingWarehousePriceBootstrapPlan(JSON.parse(text));
  if (canonicalEvidenceJson(plan) !== text) {
    throw new Error(
      "Warehouse-price bootstrap plan bytes are not canonical JSON.",
    );
  }
  return plan;
}

export function verifyAccountingWarehousePriceBootstrapPlanBinding(
  planValue: unknown,
  parityReportBytes: string | Buffer,
): AccountingWarehousePriceBootstrapPlanV1 {
  const plan = verifyAccountingWarehousePriceBootstrapPlan(planValue);
  const rebuilt = createAccountingWarehousePriceBootstrapPlan({
    parityReportBytes,
    maxPlannedItems: plan.limits.maxPlannedItems,
  });
  if (canonicalEvidenceJson(rebuilt) !== canonicalEvidenceJson(plan)) {
    throw new Error(
      "Warehouse-price bootstrap plan does not match its canonical parity report.",
    );
  }
  return plan;
}
