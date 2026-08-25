// @ts-ignore -- canonical migration evidence parsers intentionally live outside the API rootDir.
import * as invoice0108Contract from "../../../../scripts/production-evidence/production-invoice-0108-contract.mjs";
const {
  PRODUCTION_INVOICE_0108_POST_STATE,
  parseProductionInvoice0108BackupReference,
  parseProductionInvoice0108Intent,
  parseProductionInvoice0108Plan,
  parseProductionInvoice0108Receipt,
  parseProductionInvoice0108RoleReceipt,
} = invoice0108Contract;
// @ts-ignore -- the frozen production-copy opaque digest intentionally lives with the migration control plane.
import { PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 } from "../../../../scripts/production-evidence/production-migration-contract.mjs";
import { createHash } from "node:crypto";

import {
  canonicalProductionActivationJson,
  ProductionActivationError,
  type JsonValue,
  type ProductionActivationBundleV3,
} from "./production-activation-hold";
import { verifyProductionInvoice0108PredecessorActivationContractV2 } from "./production-activation-contract";
import type { ProductionReleaseSummary } from "./production-startup-evidence";

export const PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA =
  "site-logbook.production-invoice-0108-activation-readiness/v1" as const;
export const PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA =
  "site-logbook.production-invoice-0108-activation-approval/v1" as const;
export const PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION =
  "AUTHORIZE_EXACT_SITE_LOGBOOK_PRODUCTION_INVOICE_0108_ACTIVATION_V3" as const;
export const PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION =
  "USE_PRODUCTION_ACTIVATION_0108_PREDECESSOR_TEST_VERIFIER_ONLY" as const;
export const PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA =
  "c0c848509cff3c109a6efeba54a5204f471f5ee4" as const;

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._@/-]{2,127}$/;

const READINESS_KEYS = [
  "schemaVersion",
  "kind",
  "decision",
  "sourceSha",
  "databaseName",
  "databaseUser",
  "schemaFingerprintSha256",
  "invoiceSchemaProjectionSha256",
  "migrationReceiptSha256",
  "roleReceiptSha256",
  "lineage",
  "checkedAt",
  "authorizesApplicationStart",
] as const;
const APPROVAL_KEYS = [
  "schemaVersion",
  "kind",
  "decision",
  "confirmation",
  "sourceSha",
  "apiImage",
  "nonce",
  "containerId",
  "schemaReadinessSha256",
  "migrationReceiptSha256",
  "roleReceiptSha256",
  "invoiceSchemaProjectionSha256",
  "approvedAt",
  "operator",
  "authorizesApplicationStart",
  "authorizesDeployment",
] as const;
const LINEAGE_KEYS = [
  "decision",
  "mode",
  "knownExpectedMigrations",
  "knownAppliedMigrations",
  "knownAppliedRowsSha256",
  "latestKnownAppliedTag",
  "missingKnownToPredecessor",
  "opaqueLegacyRowCount",
  "opaqueLegacyRowsSha256",
  "opaqueLegacyMeaningInferred",
  "excludedMigration0100Present",
] as const;

function fail(code: string, message: string): never {
  throw new ProductionActivationError(code, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_ACTIVATION_0108_SEMANTIC_INVALID",
      `${field} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const result = record(value, field);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_0108_SEMANTIC_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return result;
}

function exactString(value: unknown, field: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail("PRODUCTION_ACTIVATION_0108_SEMANTIC_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string") {
    fail(
      "PRODUCTION_ACTIVATION_0108_TIME_INVALID",
      `${field} is not a timestamp.`,
    );
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail(
      "PRODUCTION_ACTIVATION_0108_TIME_INVALID",
      `${field} is not canonical UTC.`,
    );
  }
  return millis;
}

function exactEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(
      "PRODUCTION_ACTIVATION_0108_BINDING_INVALID",
      `${field} differs from the previously verified 0108 evidence.`,
    );
  }
}

function sha256(canonical: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function artifactCanonical(
  parent: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const artifact = record(parent[key], `${field}.${key}`);
  const canonical = canonicalProductionActivationJson(
    artifact.payload as JsonValue,
  );
  exactEqual(
    artifact.sha256,
    sha256(canonical).slice("sha256:".length),
    `${field}.${key}.sha256`,
  );
  return canonical;
}

function parseCanonicalObject(
  canonical: string,
  field: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    fail(
      "PRODUCTION_ACTIVATION_0108_SEMANTIC_INVALID",
      `${field} is not JSON.`,
    );
  }
  if (canonicalProductionActivationJson(value as JsonValue) !== canonical) {
    fail(
      "PRODUCTION_ACTIVATION_0108_SEMANTIC_INVALID",
      `${field} is not canonical.`,
    );
  }
  return record(value, field);
}

export function parseProductionActivation0108Readiness(
  canonical: string,
): Readonly<Record<string, unknown>> {
  const value = exactRecord(
    parseCanonicalObject(canonical, "invoice0108Readiness"),
    READINESS_KEYS,
    "invoice0108Readiness",
  );
  const lineage = exactRecord(
    value.lineage,
    LINEAGE_KEYS,
    "invoice0108Readiness.lineage",
  );
  for (const [field, expected] of Object.entries({
    decision: "ALREADY_0108",
    mode: "production-copy-restricted",
    knownExpectedMigrations: 108,
    knownAppliedMigrations: 108,
    knownAppliedRowsSha256:
      PRODUCTION_INVOICE_0108_POST_STATE.knownAppliedRowsSha256,
    latestKnownAppliedTag:
      PRODUCTION_INVOICE_0108_POST_STATE.latestKnownAppliedTag,
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  })) {
    exactEqual(
      lineage[field],
      expected,
      `invoice0108Readiness.lineage.${field}`,
    );
  }
  if (
    value.schemaVersion !== PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA ||
    value.kind !==
      "site-logbook-production-invoice-0108-activation-readiness" ||
    value.decision !== "PASS" ||
    value.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_0108_READINESS_INVALID",
      "0108 readiness is not exact, PASS and non-authorizing.",
    );
  }
  exactString(value.sourceSha, "invoice0108Readiness.sourceSha", SOURCE_SHA);
  exactString(
    value.databaseName,
    "invoice0108Readiness.databaseName",
    IDENTIFIER,
  );
  exactString(
    value.databaseUser,
    "invoice0108Readiness.databaseUser",
    IDENTIFIER,
  );
  for (const field of [
    "schemaFingerprintSha256",
    "invoiceSchemaProjectionSha256",
    "migrationReceiptSha256",
    "roleReceiptSha256",
  ]) {
    exactString(value[field], `invoice0108Readiness.${field}`, SHA256);
  }
  exactTimestamp(value.checkedAt, "invoice0108Readiness.checkedAt");
  return Object.freeze({ ...value, lineage: Object.freeze({ ...lineage }) });
}

export function parseProductionActivation0108Approval(
  canonical: string,
): Readonly<Record<string, unknown>> {
  const value = exactRecord(
    parseCanonicalObject(canonical, "invoice0108Approval"),
    APPROVAL_KEYS,
    "invoice0108Approval",
  );
  if (
    value.schemaVersion !== PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA ||
    value.kind !== "site-logbook-production-invoice-0108-activation-approval" ||
    value.decision !== "APPROVE" ||
    value.confirmation !== PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION ||
    value.authorizesApplicationStart !== true ||
    value.authorizesDeployment !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_0108_APPROVAL_INVALID",
      "0108 activation approval is not exact and attended.",
    );
  }
  exactString(value.sourceSha, "invoice0108Approval.sourceSha", SOURCE_SHA);
  exactString(value.apiImage, "invoice0108Approval.apiImage", IMMUTABLE_IMAGE);
  exactString(value.nonce, "invoice0108Approval.nonce", /^[0-9a-f]{64}$/);
  exactString(
    value.containerId,
    "invoice0108Approval.containerId",
    /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/,
  );
  for (const field of [
    "schemaReadinessSha256",
    "migrationReceiptSha256",
    "roleReceiptSha256",
    "invoiceSchemaProjectionSha256",
  ]) {
    exactString(value[field], `invoice0108Approval.${field}`, SHA256);
  }
  exactTimestamp(value.approvedAt, "invoice0108Approval.approvedAt");
  exactString(value.operator, "invoice0108Approval.operator", OPERATOR);
  return Object.freeze({ ...value });
}

function predecessorBundle(
  bundle: ProductionActivationBundleV3,
): ProductionActivationBundleV3 {
  const activation = record(bundle.activation, "activation");
  const evidence = record(activation.evidence, "activation.evidence");
  const predecessorEvidence = { ...evidence };
  delete predecessorEvidence.migration0107To0108;
  return Object.freeze({
    ...bundle,
    activation: Object.freeze({
      ...activation,
      schemaVersion: 2,
      kind: "site-logbook-production-activation-bundle-v2",
      evidence: Object.freeze(predecessorEvidence),
    }),
    hostAttestation: Object.freeze({
      ...record(bundle.hostAttestation, "hostAttestation"),
      schemaVersion: 2,
      kind: "site-logbook-production-host-attestation-v2",
    }),
  }) as unknown as ProductionActivationBundleV3;
}

/**
 * Verifies the immutable 0096→0107 predecessor authority first, then binds the
 * exact one-step 0108 migration, least-privilege receipt, live schema readiness
 * and attended v3 approval into the runtime authority.
 */
async function verifyProductionActivationContractV3Core(
  bundle: ProductionActivationBundleV3,
  verifyPredecessor: (
    bundle: ProductionActivationBundleV3,
  ) => Promise<ProductionReleaseSummary>,
): Promise<ProductionReleaseSummary> {
  const base = await verifyPredecessor(predecessorBundle(bundle));
  const activation = record(bundle.activation, "activation");
  const evidence = record(activation.evidence, "activation.evidence");
  const invoice = exactRecord(
    evidence.migration0107To0108,
    [
      "activationApproval",
      "backupRestoreReference",
      "intent",
      "migrationReceipt",
      "plan",
      "roleReceipt",
      "schemaReadiness",
    ],
    "activation.evidence.migration0107To0108",
  );
  const backupCanonical = artifactCanonical(
    invoice,
    "backupRestoreReference",
    "migration0107To0108",
  );
  const planCanonical = artifactCanonical(
    invoice,
    "plan",
    "migration0107To0108",
  );
  const intentCanonical = artifactCanonical(
    invoice,
    "intent",
    "migration0107To0108",
  );
  const migrationReceiptCanonical = artifactCanonical(
    invoice,
    "migrationReceipt",
    "migration0107To0108",
  );
  const roleReceiptCanonical = artifactCanonical(
    invoice,
    "roleReceipt",
    "migration0107To0108",
  );
  const readinessCanonical = artifactCanonical(
    invoice,
    "schemaReadiness",
    "migration0107To0108",
  );
  const approvalCanonical = artifactCanonical(
    invoice,
    "activationApproval",
    "migration0107To0108",
  );
  const backup = parseProductionInvoice0108BackupReference(backupCanonical);
  const plan = parseProductionInvoice0108Plan(planCanonical);
  const intent = parseProductionInvoice0108Intent(
    intentCanonical,
    planCanonical,
  );
  const migrationReceipt = parseProductionInvoice0108Receipt(
    migrationReceiptCanonical,
    planCanonical,
    intentCanonical,
  );
  const roleReceipt = parseProductionInvoice0108RoleReceipt(
    roleReceiptCanonical,
    migrationReceiptCanonical,
  );
  const readiness = parseProductionActivation0108Readiness(readinessCanonical);
  const approval = parseProductionActivation0108Approval(approvalCanonical);

  for (const [field, actual, expected] of [
    [
      "backup.sourceSha",
      backup.value.sourceSha,
      PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
    ],
    [
      "plan.sourceSha",
      plan.value.sourceSha,
      PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
    ],
    ["approval.sourceSha", approval.sourceSha, activation.sourceSha],
    ["approval.apiImage", approval.apiImage, activation.apiImage],
    ["approval.nonce", approval.nonce, activation.nonce],
    ["approval.containerId", approval.containerId, activation.containerId],
    ["readiness.sourceSha", readiness.sourceSha, activation.sourceSha],
    ["readiness.databaseName", readiness.databaseName, base.databaseName],
    ["readiness.databaseUser", readiness.databaseUser, base.databaseUser],
    [
      "readiness.schemaFingerprintSha256",
      readiness.schemaFingerprintSha256,
      base.schemaFingerprintSha256,
    ],
    [
      "readiness.migrationReceiptSha256",
      readiness.migrationReceiptSha256,
      migrationReceipt.artifact.sha256,
    ],
    [
      "readiness.roleReceiptSha256",
      readiness.roleReceiptSha256,
      roleReceipt.artifact.sha256,
    ],
    [
      "approval.schemaReadinessSha256",
      approval.schemaReadinessSha256,
      sha256(readinessCanonical),
    ],
    [
      "approval.migrationReceiptSha256",
      approval.migrationReceiptSha256,
      migrationReceipt.artifact.sha256,
    ],
    [
      "approval.roleReceiptSha256",
      approval.roleReceiptSha256,
      roleReceipt.artifact.sha256,
    ],
    [
      "approval.invoiceSchemaProjectionSha256",
      approval.invoiceSchemaProjectionSha256,
      readiness.invoiceSchemaProjectionSha256,
    ],
  ] as const) {
    exactEqual(actual, expected, field);
  }
  exactEqual(
    plan.backup.artifact.sha256,
    backup.artifact.sha256,
    "plan.backupRestoreReferenceSha256",
  );

  const roleCompletedAt = exactTimestamp(
    roleReceipt.value.completedAt,
    "roleReceipt.completedAt",
  );
  const readinessAt = exactTimestamp(
    readiness.checkedAt,
    "readiness.checkedAt",
  );
  const observationTimes = Object.entries(
    exactRecord(
      evidence.finalObservations,
      ["coolify", "docker", "postgres"],
      "finalObservations",
    ),
  ).map(([key, wrapper]) => {
    const payload = record(
      record(wrapper, `finalObservations.${key}`).payload,
      `${key}.payload`,
    );
    return exactTimestamp(
      payload.observedAt,
      `finalObservations.${key}.observedAt`,
    );
  });
  const approvalAt = exactTimestamp(approval.approvedAt, "approval.approvedAt");
  const issuedAt = exactTimestamp(activation.issuedAt, "activation.issuedAt");
  if (
    roleCompletedAt > readinessAt ||
    observationTimes.some((observedAt) => readinessAt > observedAt) ||
    Math.max(...observationTimes) > approvalAt ||
    approvalAt > issuedAt
  ) {
    fail(
      "PRODUCTION_ACTIVATION_0108_CHRONOLOGY_INVALID",
      "0108 role receipt, readiness, observations, approval and activation are not ordered.",
    );
  }

  return Object.freeze({
    ...base,
    releaseEvidenceSha256: sha256(
      canonicalProductionActivationJson(evidence as JsonValue),
    ),
    activationApprovalSha256: sha256(approvalCanonical),
    invoiceSchemaProjectionSha256: String(
      readiness.invoiceSchemaProjectionSha256,
    ),
    invoice0108MigrationReceiptSha256: migrationReceipt.artifact.sha256,
    invoice0108RoleReceiptSha256: roleReceipt.artifact.sha256,
    lineage: readiness.lineage as ProductionReleaseSummary["lineage"],
  });
}

export async function verifyProductionActivationContractV3(
  bundle: ProductionActivationBundleV3,
): Promise<ProductionReleaseSummary> {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_ACTIVATION_0108_INPUT_INVALID",
      "The v3 verifier accepts only the signed transport bundle.",
    );
  }
  return verifyProductionActivationContractV3Core(
    bundle,
    verifyProductionInvoice0108PredecessorActivationContractV2,
  );
}

export function createProductionActivation0108ContractTestVerifier(
  confirmation: typeof PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
) {
  if (
    confirmation !== PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION ||
    (process.env.NODE_ENV !== "test" &&
      process.env.VITEST !== "true" &&
      process.env.NODE_TEST_CONTEXT === undefined)
  ) {
    fail(
      "PRODUCTION_ACTIVATION_0108_TEST_VERIFIER_FORBIDDEN",
      "The predecessor verifier seam is available to tests only.",
    );
  }
  return verifyProductionActivationContractV3Core;
}
