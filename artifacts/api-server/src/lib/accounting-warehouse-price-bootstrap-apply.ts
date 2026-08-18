import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  canonicalAccountingExportIntentJson,
  createAccountingWarehousePriceLegacyExportIntent,
  type AccountingExportIntentV1,
} from "./accounting-persistence-contract";
import {
  verifyAccountingWarehousePriceBootstrapPlanBinding,
  verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes,
  type AccountingWarehousePriceBootstrapPlanV1,
} from "./accounting-warehouse-price-bootstrap-plan";
import {
  canonicalAccountingWarehousePriceLegacyObservationJson,
  verifyAccountingWarehousePriceLegacyObservation,
  type AccountingWarehousePriceLegacyObservationV1,
} from "./accounting-warehouse-price-legacy-observation-contract";
import {
  createAccountingWarehousePriceParityItem,
  verifyCanonicalAccountingWarehousePriceParityReportJsonBytes,
  type AccountingWarehousePriceParityItemInputV1,
} from "./accounting-warehouse-price-parity";
import {
  canonicalAccountingWarehousePriceProjectionHeadJson,
  createAccountingWarehousePriceProjectionHead,
  type AccountingWarehousePriceProjectionHeadV1,
} from "./accounting-warehouse-price-projection-head";
import type { AccountingWarehousePriceProjectionPersistenceTransactionV1 } from "./accounting-warehouse-price-projection-persistence";
import type { AccountingWarehousePriceStreamEntryV1 } from "./accounting-warehouse-price-stream-contract";
import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const AUTHORIZATION_SCHEMA =
  "site-logbook.warehouse-price-bootstrap-apply-authorization/v1" as const;
const CONFIRMATION =
  "APPLY_EXACT_WAREHOUSE_PRICE_LEGACY_OBSERVATIONS_NO_HISTORY_FABRICATION" as const;
const CANONICALIZATION = "site-logbook-cjson/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const bodyShape = {
  schemaVersion: z.literal(AUTHORIZATION_SCHEMA),
  operation: z.literal("warehouse-price-legacy-bootstrap"),
  plan: z
    .object({
      planSha256: sha256Schema,
      planFileSha256: sha256Schema,
      parityReportSha256: sha256Schema,
      parityReportFileSha256: sha256Schema,
      targetFingerprint: sha256Schema,
      candidateCount: z.number().int().positive().max(20_000),
    })
    .strict(),
  approval: z
    .object({
      decision: z.literal("approved"),
      confirmation: z.literal(CONFIRMATION),
      approvedAt: timestampSchema,
      approvedByUserId: z.string().regex(POSITIVE_DECIMAL_PATTERN),
      approvalEvidenceSha256: sha256Schema,
      unknownHistoryAccepted: z.literal(true),
      sourceCurrencyNoFxAccepted: z.literal(true),
    })
    .strict(),
  executionBoundary: z
    .object({
      callerOwnedTransactionRequired: z.literal(true),
      candidateLocksAscending: z.literal(true),
      exactReplayOnly: z.literal(true),
      numberedMigrationIncluded: z.literal(false),
      runtimeActivationIncluded: z.literal(false),
      readCutoverIncluded: z.literal(false),
      providerWriteIncluded: z.literal(false),
    })
    .strict(),
};
const bodySchema = z.object(bodyShape).strict();
const authorizationSchema = z
  .object({
    ...bodyShape,
    integrity: z
      .object({
        canonicalization: z.literal(CANONICALIZATION),
        hashAlgorithm: z.literal("sha256"),
        hashDomain: z.literal(AUTHORIZATION_SCHEMA),
        authorizationSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

type AuthorizationBodyV1 = z.infer<typeof bodySchema>;
export type AccountingWarehousePriceBootstrapApplyAuthorizationV1 = z.infer<
  typeof authorizationSchema
>;

export interface AccountingWarehousePriceBootstrapApplyTransactionV1 extends AccountingWarehousePriceProjectionPersistenceTransactionV1 {
  readWarehousePriceBootstrapTargetFingerprint(): Promise<string>;
  lockAndLoadWarehousePriceBootstrapItemForUpdate(
    warehouseItemId: string,
  ): Promise<AccountingWarehousePriceParityItemInputV1>;
  loadWarehousePriceObservationById(
    observationId: string,
  ): Promise<AccountingWarehousePriceStreamEntryV1 | null>;
  insertWarehousePriceLegacyObservation(
    observation: AccountingWarehousePriceLegacyObservationV1,
  ): Promise<void>;
  loadExportIntentById(
    intentId: string,
  ): Promise<AccountingExportIntentV1 | null>;
  insertExportIntent(intent: AccountingExportIntentV1): Promise<void>;
  loadWarehousePriceProjectionHeadForUpdate(
    warehouseItemId: string,
  ): Promise<AccountingWarehousePriceProjectionHeadV1 | null>;
}

function safeEqualHex(left: string, right: string): boolean {
  return (
    SHA256_PATTERN.test(left) &&
    SHA256_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function authorizationSha256(
  value: AccountingWarehousePriceBootstrapApplyAuthorizationV1,
): string {
  return sha256Hex(
    `${AUTHORIZATION_SCHEMA}\0${canonicalEvidenceJson({
      ...value,
      integrity: { ...value.integrity, authorizationSha256: null },
    })}`,
  );
}

export function createAccountingWarehousePriceBootstrapApplyAuthorization(
  input: AuthorizationBodyV1,
): AccountingWarehousePriceBootstrapApplyAuthorizationV1 {
  const body = bodySchema.parse(input);
  const candidate = authorizationSchema.parse({
    ...body,
    integrity: {
      canonicalization: CANONICALIZATION,
      hashAlgorithm: "sha256",
      hashDomain: AUTHORIZATION_SCHEMA,
      authorizationSha256: "0".repeat(64),
    },
  });
  return verifyAccountingWarehousePriceBootstrapApplyAuthorization({
    ...candidate,
    integrity: {
      ...candidate.integrity,
      authorizationSha256: authorizationSha256(candidate),
    },
  });
}

export function verifyAccountingWarehousePriceBootstrapApplyAuthorization(
  value: unknown,
): AccountingWarehousePriceBootstrapApplyAuthorizationV1 {
  const authorization = authorizationSchema.parse(value);
  if (
    !safeEqualHex(
      authorization.integrity.authorizationSha256,
      authorizationSha256(authorization),
    )
  ) {
    throw new Error("Warehouse-price bootstrap authorization digest mismatch.");
  }
  return authorization;
}

export function canonicalAccountingWarehousePriceBootstrapApplyAuthorizationJson(
  value: unknown,
): string {
  return canonicalEvidenceJson(
    verifyAccountingWarehousePriceBootstrapApplyAuthorization(value),
  );
}

export function verifyCanonicalAccountingWarehousePriceBootstrapApplyAuthorizationJsonBytes(
  value: string | Buffer,
): AccountingWarehousePriceBootstrapApplyAuthorizationV1 {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const authorization =
    verifyAccountingWarehousePriceBootstrapApplyAuthorization(JSON.parse(text));
  if (canonicalEvidenceJson(authorization) !== text) {
    throw new Error(
      "Warehouse-price bootstrap authorization bytes are not canonical JSON.",
    );
  }
  return authorization;
}

function compareIds(left: string, right: string): number {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}

function assertAuthorizationBinding(input: {
  authorization: AccountingWarehousePriceBootstrapApplyAuthorizationV1;
  plan: AccountingWarehousePriceBootstrapPlanV1;
  planBytes: Buffer;
  reportBytes: Buffer;
}): void {
  const { authorization, plan, planBytes, reportBytes } = input;
  if (
    plan.summary.decision !== "REVIEW" ||
    plan.summary.blockedItemCount !== 0 ||
    plan.candidates.length === 0 ||
    authorization.plan.planSha256 !== plan.integrity.planSha256 ||
    authorization.plan.planFileSha256 !== sha256Hex(planBytes) ||
    authorization.plan.parityReportSha256 !== plan.sourceReport.reportSha256 ||
    authorization.plan.parityReportFileSha256 !== sha256Hex(reportBytes) ||
    authorization.plan.targetFingerprint !==
      plan.sourceReport.targetFingerprint ||
    authorization.plan.candidateCount !== plan.candidates.length
  ) {
    throw new Error(
      "Warehouse-price bootstrap authorization does not bind the exact eligible plan.",
    );
  }
}

export async function applyAccountingWarehousePriceBootstrapInTransaction(
  transaction: AccountingWarehousePriceBootstrapApplyTransactionV1,
  input: {
    authorizationBytes: string | Buffer;
    planBytes: string | Buffer;
    parityReportBytes: string | Buffer;
  },
): Promise<{
  mode: "applied" | "exact-replay";
  observationCount: number;
  observationIds: string[];
}> {
  const authorization =
    verifyCanonicalAccountingWarehousePriceBootstrapApplyAuthorizationJsonBytes(
      input.authorizationBytes,
    );
  const planRaw = Buffer.isBuffer(input.planBytes)
    ? Buffer.from(input.planBytes)
    : Buffer.from(input.planBytes, "utf8");
  const reportRaw = Buffer.isBuffer(input.parityReportBytes)
    ? Buffer.from(input.parityReportBytes)
    : Buffer.from(input.parityReportBytes, "utf8");
  const plan =
    verifyCanonicalAccountingWarehousePriceBootstrapPlanJsonBytes(planRaw);
  const report =
    verifyCanonicalAccountingWarehousePriceParityReportJsonBytes(reportRaw);
  verifyAccountingWarehousePriceBootstrapPlanBinding(plan, reportRaw);
  assertAuthorizationBinding({
    authorization,
    plan,
    planBytes: planRaw,
    reportBytes: reportRaw,
  });
  const liveTargetFingerprint =
    await transaction.readWarehousePriceBootstrapTargetFingerprint();
  if (
    !safeEqualHex(liveTargetFingerprint, authorization.plan.targetFingerprint)
  ) {
    throw new Error("Warehouse-price bootstrap target fingerprint changed.");
  }

  const candidates = [...plan.candidates].sort((left, right) =>
    compareIds(left.warehouseItemId, right.warehouseItemId),
  );
  const sourceItems = new Map(
    report.items.map((item) => [item.warehouseItemId, item] as const),
  );
  const prepared: Array<{
    observation: AccountingWarehousePriceLegacyObservationV1;
    intent: AccountingExportIntentV1;
    replay: boolean;
  }> = [];

  // Lock and validate every candidate before the first insert. This prevents a
  // later stale item from creating a partially applied multi-item bootstrap.
  for (const candidateValue of candidates) {
    const observation =
      verifyAccountingWarehousePriceLegacyObservation(candidateValue);
    const sourceItem = sourceItems.get(observation.warehouseItemId);
    if (!sourceItem || sourceItem.classification !== "legacy_only") {
      throw new Error(
        "Warehouse-price bootstrap candidate is missing its legacy-only source item.",
      );
    }
    const live = createAccountingWarehousePriceParityItem(
      await transaction.lockAndLoadWarehousePriceBootstrapItemForUpdate(
        observation.warehouseItemId,
      ),
    );
    const existing = await transaction.loadWarehousePriceObservationById(
      observation.observationId,
    );
    const intent =
      createAccountingWarehousePriceLegacyExportIntent(observation);
    const existingIntent = await transaction.loadExportIntentById(
      intent.intentId,
    );
    if (existing === null) {
      if (
        existingIntent !== null ||
        canonicalEvidenceJson(live) !== canonicalEvidenceJson(sourceItem)
      ) {
        throw new Error(
          "Warehouse-price bootstrap live snapshot is stale or partially persisted.",
        );
      }
      prepared.push({ observation, intent, replay: false });
      continue;
    }
    if (
      canonicalAccountingWarehousePriceLegacyObservationJson(existing) !==
        canonicalAccountingWarehousePriceLegacyObservationJson(observation) ||
      existingIntent === null ||
      canonicalAccountingExportIntentJson(existingIntent) !==
        canonicalAccountingExportIntentJson(intent) ||
      live.classification !== "legacy_bootstrap_match" ||
      live.observations.length !== 1
    ) {
      throw new Error(
        "Warehouse-price bootstrap replay does not match the complete persisted bundle.",
      );
    }
    const expectedHead = createAccountingWarehousePriceProjectionHead({
      warehouseItemId: observation.warehouseItemId,
      observations: [observation],
    });
    if (
      live.projectionHead === null ||
      canonicalAccountingWarehousePriceProjectionHeadJson(
        live.projectionHead,
      ) !== canonicalAccountingWarehousePriceProjectionHeadJson(expectedHead)
    ) {
      throw new Error(
        "Warehouse-price bootstrap replay is missing its exact shadow projection.",
      );
    }
    prepared.push({ observation, intent, replay: true });
  }

  const replayCount = prepared.filter((entry) => entry.replay).length;
  if (replayCount !== 0 && replayCount !== prepared.length) {
    throw new Error(
      "Warehouse-price bootstrap contains a forbidden partial-application state.",
    );
  }
  if (replayCount === prepared.length) {
    return {
      mode: "exact-replay",
      observationCount: prepared.length,
      observationIds: prepared.map((entry) => entry.observation.observationId),
    };
  }

  for (const entry of prepared) {
    await transaction.insertWarehousePriceLegacyObservation(entry.observation);
    await transaction.insertExportIntent(entry.intent);
    const head = createAccountingWarehousePriceProjectionHead({
      warehouseItemId: entry.observation.warehouseItemId,
      observations: [entry.observation],
    });
    await transaction.insertWarehousePriceProjectionHead(head);
  }
  return {
    mode: "applied",
    observationCount: prepared.length,
    observationIds: prepared.map((entry) => entry.observation.observationId),
  };
}

export const ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_APPLY_CONFIRMATION =
  CONFIRMATION;
