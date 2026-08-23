import {
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  exactDigest,
  exactObject,
  exactSourceSha,
  exactString,
  exactTimestamp,
  parseCanonicalProductionMigrationArtifact,
  productionMigrationFail,
  productionMigrationSha256,
  validateFrozenOpaqueRows,
} from "./production-migration-contract.mjs";

export const PRODUCTION_INVOICE_0108_PLAN_SCHEMA =
  "site-logbook.production-invoice-0108-plan/v1";
export const PRODUCTION_INVOICE_0108_INTENT_SCHEMA =
  "site-logbook.production-invoice-0108-intent/v1";
export const PRODUCTION_INVOICE_0108_RECEIPT_SCHEMA =
  "site-logbook.production-invoice-0108-receipt/v1";
export const PRODUCTION_INVOICE_0108_ROLE_RECEIPT_SCHEMA =
  "site-logbook.production-invoice-0108-role-delta-receipt/v1";
export const PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA =
  "site-logbook.production-exact-0107-backup-restore-reference/v1";

export const PRODUCTION_INVOICE_0108_CONFIRMATION =
  "APPLY_EXACT_0108_INVOICE_UPGRADE_TO_EXACT_0107_MODVOLT_PRODUCTION";
export const PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION =
  "APPLY_EXACT_0108_INVOICE_ROLE_DELTA_AFTER_DURABLE_MIGRATION_RECEIPT";
export const PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY = 91070108;
export const PRODUCTION_INVOICE_0108_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;

export const PRODUCTION_INVOICE_0108_MIGRATION = Object.freeze({
  idx: 108,
  when: 1786986729921,
  tag: "0108_invoice_source_allocations_and_advances",
  sqlSha256:
    "sha256:220a556f61fc9aed8c215965cd25e69b5e47d7fe171f57ecd6626fe2fd4f7814",
  snapshotId: "e9f2f052-b760-4025-aed2-4df306642b0f",
  snapshotPrevId: "b20520fc-59f2-4d34-9e2f-9d7ed565288a",
});

const INVENTORY_KEYS = [
  "knownAppliedMigrations",
  "knownAppliedRowsSha256",
  "latestKnownAppliedTag",
  "missingKnownMigrationTags",
  "unexpectedKnownMigrationTags",
  "opaqueLegacyRows",
  "excludedMigration0100Present",
  "totalJournalRows",
];

export const PRODUCTION_INVOICE_0108_PRE_STATE = Object.freeze({
  knownAppliedMigrations: 107,
  knownAppliedRowsSha256:
    "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
  latestKnownAppliedTag: "0107_canonical_audit_evidence",
  missingKnownMigrationTags: Object.freeze([
    PRODUCTION_INVOICE_0108_MIGRATION.tag,
  ]),
  totalJournalRows: 109,
});

export const PRODUCTION_INVOICE_0108_POST_STATE = Object.freeze({
  knownAppliedMigrations: 108,
  knownAppliedRowsSha256:
    "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281",
  latestKnownAppliedTag: PRODUCTION_INVOICE_0108_MIGRATION.tag,
  missingKnownMigrationTags: Object.freeze([]),
  totalJournalRows: 110,
});

const STORAGE_ID = /^[a-z0-9][a-z0-9._/-]{0,255}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(code, message) {
  productionMigrationFail(`PRODUCTION_INVOICE_0108_${code}`, message);
}

function exactBoolean(value, expected, field) {
  if (value !== expected) {
    fail("SCHEMA_INVALID", `${field} must be exactly ${expected}.`);
  }
}

function same(left, right) {
  return (
    canonicalProductionMigrationJson(left) ===
    canonicalProductionMigrationJson(right)
  );
}

export function canonicalProductionInvoice0108Sql(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(
      "SQL_INVALID",
      "0108 SQL must be non-empty UTF-8 text without NUL bytes.",
    );
  }
  const canonical = value.replace(/\r\n?/g, "\n");
  const digest = productionMigrationSha256(canonical);
  if (digest !== PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256) {
    fail(
      "SQL_DRIFT",
      "Canonical-LF 0108 SQL does not match the pinned digest.",
    );
  }
  return canonical;
}

export function validateProductionInvoice0108JournalIdentity(value) {
  const identity = exactObject(
    value,
    ["idx", "when", "tag", "sqlSha256", "snapshotId", "snapshotPrevId"],
    "migration",
  );
  exactDigest(identity.sqlSha256, "migration.sqlSha256");
  for (const field of ["snapshotId", "snapshotPrevId"]) {
    if (!UUID.test(String(identity[field]))) {
      fail("JOURNAL_INVALID", `migration.${field} must be a canonical UUID.`);
    }
  }
  if (!same(identity, PRODUCTION_INVOICE_0108_MIGRATION)) {
    fail(
      "JOURNAL_DRIFT",
      "0108 journal or snapshot identity differs from the reviewed target.",
    );
  }
  return Object.freeze({ ...identity });
}

export function validateProductionInvoice0108Inventory(
  inventory,
  phase = "either",
) {
  const value = exactObject(inventory, INVENTORY_KEYS, "inventory");
  exactDigest(value.knownAppliedRowsSha256, "inventory.knownAppliedRowsSha256");
  validateFrozenOpaqueRows(
    value.opaqueLegacyRows,
    "inventory.opaqueLegacyRows",
  );
  exactBoolean(
    value.excludedMigration0100Present,
    false,
    "inventory.excludedMigration0100Present",
  );
  if (
    !Array.isArray(value.unexpectedKnownMigrationTags) ||
    value.unexpectedKnownMigrationTags.length !== 0
  ) {
    fail("INVENTORY_DRIFT", "Unexpected known migration tags are forbidden.");
  }
  const summary = {
    knownAppliedMigrations: value.knownAppliedMigrations,
    knownAppliedRowsSha256: value.knownAppliedRowsSha256,
    latestKnownAppliedTag: value.latestKnownAppliedTag,
    missingKnownMigrationTags: value.missingKnownMigrationTags,
    totalJournalRows: value.totalJournalRows,
  };
  const isPre = same(summary, PRODUCTION_INVOICE_0108_PRE_STATE);
  const isPost = same(summary, PRODUCTION_INVOICE_0108_POST_STATE);
  if (
    (phase === "pre" && !isPre) ||
    (phase === "post" && !isPost) ||
    (phase === "either" && !isPre && !isPost)
  ) {
    fail(
      "INVENTORY_DRIFT",
      `Inventory is not the exact ${phase} 0107/0108 state.`,
    );
  }
  return Object.freeze({
    phase: isPre ? "pre" : "post",
    value: Object.freeze(structuredClone(value)),
  });
}

export function parseProductionInvoice0108BackupReference(
  canonical,
  { at } = {},
) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "backupRestoreReference",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "receiptStorageId",
      "receiptSha256",
      "sourceSha",
      "sourceInventorySha256",
      "backupCompletedAt",
      "restoreVerifiedAt",
      "decision",
      "productionRestorePerformed",
      "authorizesProductionMigration",
    ],
    "backupRestoreReference",
  );
  if (
    value.schemaVersion !== PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA ||
    value.kind !==
      "site-logbook-production-exact-0107-backup-restore-reference" ||
    value.decision !== "PASS" ||
    value.productionRestorePerformed !== false ||
    value.authorizesProductionMigration !== false
  ) {
    fail(
      "BACKUP_REFERENCE_INVALID",
      "Backup reference must prove a PASS disposable restore without authorizing migration.",
    );
  }
  const storageId = exactString(
    value.receiptStorageId,
    "backupRestoreReference.receiptStorageId",
    256,
  );
  if (!STORAGE_ID.test(storageId) || storageId.includes("..")) {
    fail(
      "BACKUP_REFERENCE_INVALID",
      "Backup receipt storage id is not a safe reviewed identifier.",
    );
  }
  exactDigest(value.receiptSha256, "backupRestoreReference.receiptSha256");
  exactSourceSha(value.sourceSha, "backupRestoreReference.sourceSha");
  exactDigest(
    value.sourceInventorySha256,
    "backupRestoreReference.sourceInventorySha256",
  );
  const backupAt = exactTimestamp(
    value.backupCompletedAt,
    "backupRestoreReference.backupCompletedAt",
  );
  const restoreAt = exactTimestamp(
    value.restoreVerifiedAt,
    "backupRestoreReference.restoreVerifiedAt",
  );
  if (restoreAt < backupAt) {
    fail(
      "BACKUP_REFERENCE_INVALID",
      "Disposable restore verification cannot predate backup completion.",
    );
  }
  if (at !== undefined) {
    const boundary =
      typeof at === "string"
        ? exactTimestamp(at, "backupReferenceBoundary")
        : at.getTime();
    if (
      !Number.isFinite(boundary) ||
      restoreAt > boundary ||
      boundary - restoreAt > PRODUCTION_INVOICE_0108_BACKUP_MAX_AGE_MS
    ) {
      fail(
        "BACKUP_REFERENCE_STALE",
        "Exact-0107 backup and disposable restore receipt is not fresh at execution time.",
      );
    }
  }
  return Object.freeze({ artifact, value: Object.freeze({ ...value }) });
}

export function createProductionInvoice0108Plan({
  sourceSha,
  backupRestoreReferenceCanonical,
  createdAt,
}) {
  const backup = parseProductionInvoice0108BackupReference(
    backupRestoreReferenceCanonical,
    { at: createdAt },
  );
  const pinnedSourceSha = exactSourceSha(sourceSha);
  if (
    backup.value.sourceSha !== pinnedSourceSha ||
    backup.value.sourceInventorySha256 !==
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256
  ) {
    fail(
      "BACKUP_REFERENCE_INVALID",
      "Backup reference must bind the same source SHA and exact-0107 inventory digest as the plan.",
    );
  }
  const value = {
    schemaVersion: PRODUCTION_INVOICE_0108_PLAN_SCHEMA,
    kind: "site-logbook-production-invoice-0108-plan",
    sourceSha: pinnedSourceSha,
    migration: PRODUCTION_INVOICE_0108_MIGRATION,
    requiredPreState: PRODUCTION_INVOICE_0108_PRE_STATE,
    requiredPostState: PRODUCTION_INVOICE_0108_POST_STATE,
    backupRestoreReferenceCanonical: backup.artifact.canonical,
    backupRestoreReferenceSha256: backup.artifact.sha256,
    advisoryLockKey: PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY,
    createdAt: new Date(
      exactTimestamp(createdAt, "plan.createdAt"),
    ).toISOString(),
    executionDefault: "disabled",
    authorizesApplicationStart: false,
  };
  return createProductionMigrationArtifact(value);
}

export function parseProductionInvoice0108Plan(canonical) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "invoice0108Plan",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "migration",
      "requiredPreState",
      "requiredPostState",
      "backupRestoreReferenceCanonical",
      "backupRestoreReferenceSha256",
      "advisoryLockKey",
      "createdAt",
      "executionDefault",
      "authorizesApplicationStart",
    ],
    "invoice0108Plan",
  );
  validateProductionInvoice0108JournalIdentity(value.migration);
  if (
    value.schemaVersion !== PRODUCTION_INVOICE_0108_PLAN_SCHEMA ||
    value.kind !== "site-logbook-production-invoice-0108-plan" ||
    !same(value.requiredPreState, PRODUCTION_INVOICE_0108_PRE_STATE) ||
    !same(value.requiredPostState, PRODUCTION_INVOICE_0108_POST_STATE) ||
    value.advisoryLockKey !== PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY ||
    value.executionDefault !== "disabled" ||
    value.authorizesApplicationStart !== false
  ) {
    fail("PLAN_INVALID", "Plan is not exact, pinned and default-dark.");
  }
  exactSourceSha(value.sourceSha);
  exactTimestamp(value.createdAt, "plan.createdAt");
  const backup = parseProductionInvoice0108BackupReference(
    value.backupRestoreReferenceCanonical,
  );
  if (
    backup.artifact.sha256 !== value.backupRestoreReferenceSha256 ||
    backup.value.sourceSha !== value.sourceSha ||
    backup.value.sourceInventorySha256 !==
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256
  )
    fail(
      "PLAN_INVALID",
      "Backup reference digest, source or exact-0107 inventory binding differs from the plan.",
    );
  return Object.freeze({
    artifact,
    value: Object.freeze({ ...value }),
    backup,
  });
}

export function createProductionInvoice0108Intent({
  planCanonical,
  intentId,
  operator,
  createdAt,
  confirmation,
}) {
  const plan = parseProductionInvoice0108Plan(planCanonical);
  if (
    !/^[0-9a-f]{64}$/.test(String(intentId)) ||
    confirmation !== PRODUCTION_INVOICE_0108_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_REQUIRED",
      "Intent requires an exact id and attended 0108 confirmation.",
    );
  }
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_INVOICE_0108_INTENT_SCHEMA,
    kind: "site-logbook-production-invoice-0108-intent",
    intentId,
    planSha256: plan.artifact.sha256,
    sourceSha: plan.value.sourceSha,
    backupRestoreReferenceSha256: plan.backup.artifact.sha256,
    operator: exactString(operator, "intent.operator", 256),
    createdAt: new Date(
      exactTimestamp(createdAt, "intent.createdAt"),
    ).toISOString(),
    confirmation,
    executionDefault: "disabled",
    authorizesApplicationStart: false,
  });
}

export function parseProductionInvoice0108Intent(canonical, planCanonical) {
  const plan = parseProductionInvoice0108Plan(planCanonical);
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "invoice0108Intent",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "intentId",
      "planSha256",
      "sourceSha",
      "backupRestoreReferenceSha256",
      "operator",
      "createdAt",
      "confirmation",
      "executionDefault",
      "authorizesApplicationStart",
    ],
    "invoice0108Intent",
  );
  if (
    value.schemaVersion !== PRODUCTION_INVOICE_0108_INTENT_SCHEMA ||
    value.kind !== "site-logbook-production-invoice-0108-intent" ||
    !/^[0-9a-f]{64}$/.test(String(value.intentId)) ||
    value.planSha256 !== plan.artifact.sha256 ||
    value.sourceSha !== plan.value.sourceSha ||
    value.backupRestoreReferenceSha256 !== plan.backup.artifact.sha256 ||
    value.confirmation !== PRODUCTION_INVOICE_0108_CONFIRMATION ||
    value.executionDefault !== "disabled" ||
    value.authorizesApplicationStart !== false
  )
    fail(
      "INTENT_INVALID",
      "Intent is not exactly bound to the durable reviewed plan.",
    );
  exactString(value.operator, "intent.operator", 256);
  exactTimestamp(value.createdAt, "intent.createdAt");
  return Object.freeze({ artifact, value: Object.freeze({ ...value }), plan });
}

export function createProductionInvoice0108Receipt({
  planCanonical,
  intentCanonical,
  before,
  after,
  transactionStartedAt,
  transactionCompletedAt,
}) {
  const intent = parseProductionInvoice0108Intent(
    intentCanonical,
    planCanonical,
  );
  validateProductionInvoice0108Inventory(before, "pre");
  validateProductionInvoice0108Inventory(after, "post");
  const startedAt = exactTimestamp(
    transactionStartedAt,
    "receipt.transactionStartedAt",
  );
  const completedAt = exactTimestamp(
    transactionCompletedAt,
    "receipt.transactionCompletedAt",
  );
  if (completedAt < startedAt) {
    fail(
      "RECEIPT_INVALID",
      "Transaction completion cannot predate transaction start.",
    );
  }
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_INVOICE_0108_RECEIPT_SCHEMA,
    kind: "site-logbook-production-invoice-0108-receipt",
    decision: "PASS",
    planSha256: intent.plan.artifact.sha256,
    intentSha256: intent.artifact.sha256,
    migration: PRODUCTION_INVOICE_0108_MIGRATION,
    before,
    after,
    advisoryLockKey: PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY,
    transactionCommitted: true,
    transactionStartedAt: new Date(startedAt).toISOString(),
    transactionCompletedAt: new Date(completedAt).toISOString(),
    productionTargetsTouched: true,
    roleDeltaApplied: false,
    authorizesApplicationStart: false,
  });
}

export function parseProductionInvoice0108Receipt(
  canonical,
  planCanonical,
  intentCanonical,
) {
  const expectedIntent = parseProductionInvoice0108Intent(
    intentCanonical,
    planCanonical,
  );
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "invoice0108Receipt",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "planSha256",
      "intentSha256",
      "migration",
      "before",
      "after",
      "advisoryLockKey",
      "transactionCommitted",
      "transactionStartedAt",
      "transactionCompletedAt",
      "productionTargetsTouched",
      "roleDeltaApplied",
      "authorizesApplicationStart",
    ],
    "invoice0108Receipt",
  );
  validateProductionInvoice0108JournalIdentity(value.migration);
  validateProductionInvoice0108Inventory(value.before, "pre");
  validateProductionInvoice0108Inventory(value.after, "post");
  if (
    value.schemaVersion !== PRODUCTION_INVOICE_0108_RECEIPT_SCHEMA ||
    value.kind !== "site-logbook-production-invoice-0108-receipt" ||
    value.decision !== "PASS" ||
    value.planSha256 !== expectedIntent.plan.artifact.sha256 ||
    value.intentSha256 !== expectedIntent.artifact.sha256 ||
    value.advisoryLockKey !== PRODUCTION_INVOICE_0108_ADVISORY_LOCK_KEY ||
    value.transactionCommitted !== true ||
    value.productionTargetsTouched !== true ||
    value.roleDeltaApplied !== false ||
    value.authorizesApplicationStart !== false
  )
    fail(
      "RECEIPT_INVALID",
      "Migration receipt is not exact and receipt-backed.",
    );
  const startedAt = exactTimestamp(
    value.transactionStartedAt,
    "receipt.transactionStartedAt",
  );
  const completedAt = exactTimestamp(
    value.transactionCompletedAt,
    "receipt.transactionCompletedAt",
  );
  if (completedAt < startedAt) {
    fail(
      "RECEIPT_INVALID",
      "Transaction completion cannot predate transaction start.",
    );
  }
  return Object.freeze({ artifact, value: Object.freeze({ ...value }) });
}

export function parseProductionInvoice0108RoleReceipt(
  canonical,
  migrationReceiptCanonical,
) {
  const migrationReceipt = parseCanonicalProductionMigrationArtifact(
    migrationReceiptCanonical,
    "migrationReceipt",
  );
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "roleDeltaReceipt",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "migration",
      "migrationSha256",
      "migrationReceiptSha256",
      "base0107PlanSha256",
      "deltaPlanSha256",
      "preProjectionSha256",
      "postProjectionSha256",
      "authoritySourceSha256",
      "transactionCommitted",
      "completedAt",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "roleDeltaReceipt",
  );
  for (const field of [
    "base0107PlanSha256",
    "deltaPlanSha256",
    "preProjectionSha256",
    "postProjectionSha256",
    "authoritySourceSha256",
  ])
    exactDigest(value[field], `roleDeltaReceipt.${field}`);
  if (
    value.schemaVersion !== PRODUCTION_INVOICE_0108_ROLE_RECEIPT_SCHEMA ||
    value.kind !== "site-logbook-production-invoice-0108-role-delta-receipt" ||
    value.decision !== "PASS" ||
    value.migration !== PRODUCTION_INVOICE_0108_MIGRATION.tag ||
    value.migrationSha256 !==
      PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7) ||
    value.migrationReceiptSha256 !== migrationReceipt.sha256 ||
    value.transactionCommitted !== true ||
    value.productionTargetsTouched !== true ||
    value.authorizesApplicationStart !== false
  )
    fail(
      "ROLE_RECEIPT_INVALID",
      "Role delta receipt is not exact or not bound to the durable migration receipt.",
    );
  exactTimestamp(value.completedAt, "roleDeltaReceipt.completedAt");
  return Object.freeze({ artifact, value: Object.freeze({ ...value }) });
}

export { productionMigrationSha256 };
