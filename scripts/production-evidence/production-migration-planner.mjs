import {
  PRODUCTION_MIGRATION_BASELINE,
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_INTENT_PERSISTENCE_SCHEMA,
  PRODUCTION_MIGRATION_INTENT_SCHEMA,
  PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA,
  PRODUCTION_MIGRATION_PLAN_SCHEMA,
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_MIGRATION_STEPS,
  PRODUCTION_MIGRATION_TARGET,
  PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  exactDigest,
  exactObject,
  exactProductionMigrationDatabase,
  exactSourceSha,
  exactString,
  exactTimestamp,
  frozenStateSummary,
  parseCanonicalProductionMigrationArtifact,
  parseProductionMigrationLiveIdentity,
  productionMigrationFail,
  productionMigrationSha256,
  validateProductionMigrationInventory,
} from "./production-migration-contract.mjs";
import { parseProductionExact0096BackupPlan } from "./production-exact-0096-backup-planner.mjs";
import {
  parseProductionExact0096BackupExecutorTrace,
  parseProductionExact0096BackupReceipt,
} from "./production-exact-0096-backup-receipt.mjs";
import {
  PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_SCHEMA,
  parseProductionExact0096BackupSignatureEnvelope,
} from "./production-exact-0096-backup-signature.mjs";

const INTENT_ID = /^[0-9a-f]{64}$/;

function databaseIdentity(value, field = "database") {
  return exactProductionMigrationDatabase(value, field);
}

function exactStep(value, index, field) {
  const step = exactObject(
    value,
    [
      "sequence",
      "idx",
      "when",
      "tag",
      "sqlSha256",
      "knownCountBefore",
      "knownCountAfter",
      "knownRowsSha256Before",
      "knownRowsSha256After",
    ],
    field,
  );
  const expected = PRODUCTION_MIGRATION_STEPS[index];
  if (
    canonicalProductionMigrationJson(step) !==
    canonicalProductionMigrationJson(expected)
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_STEP_INVALID",
      `${field} is not the exact reviewed migration step.`,
    );
  }
  return expected;
}

function parseRolePrecondition(canonical, expected) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "rolePrecondition",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "database",
      "migrationRole",
      "runtimeRole",
      "rolePlanCanonical",
      "rolePlanSha256",
      "preProjectionCanonical",
      "preProjectionSha256",
      "capturedAt",
      "migrationRoleCanApplyMigrations",
      "runtimeRoleCanApplyMigrations",
      "authorizesApplicationStart",
    ],
    "rolePrecondition",
  );
  const projection = parseCanonicalProductionMigrationArtifact(
    value.preProjectionCanonical,
    "rolePrecondition.preProjectionCanonical",
  );
  const rolePlan = parseCanonicalProductionMigrationArtifact(
    value.rolePlanCanonical,
    "rolePrecondition.rolePlanCanonical",
  );
  const projectionValue = projection.value;
  const rolePlanValue = rolePlan.value;
  if (
    !projectionValue ||
    typeof projectionValue !== "object" ||
    Array.isArray(projectionValue) ||
    projectionValue.schemaVersion !==
      "site-logbook.production-db-role-separation/v1" ||
    projectionValue.migration !== "0107_canonical_audit_evidence" ||
    projectionValue.migrationSha256 !==
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122" ||
    projectionValue.databaseName !== expected.database.name ||
    projectionValue.runtimeRole?.name !== value.runtimeRole ||
    projectionValue.migratorRole?.name !== value.migrationRole ||
    !rolePlanValue ||
    typeof rolePlanValue !== "object" ||
    Array.isArray(rolePlanValue) ||
    rolePlanValue.schemaVersion !==
      "site-logbook.production-db-role-separation-plan/v1" ||
    rolePlanValue.executionDefault !== "disabled" ||
    rolePlanValue.migration !== "0107_canonical_audit_evidence" ||
    rolePlanValue.migrationSha256 !==
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122" ||
    rolePlanValue.databaseName !== expected.database.name ||
    rolePlanValue.runtimeRole !== value.runtimeRole ||
    rolePlanValue.migratorRole !== value.migrationRole ||
    rolePlanValue.planSha256 !== value.rolePlanSha256 ||
    value.schemaVersion !== PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA ||
    value.kind !== "site-logbook-production-migration-role-precondition" ||
    value.sourceSha !== expected.sourceSha ||
    canonicalProductionMigrationJson(
      databaseIdentity(value.database, "rolePrecondition.database"),
    ) !== canonicalProductionMigrationJson(expected.database) ||
    value.migrationRole !== expected.database.currentUser ||
    value.runtimeRole === expected.database.sessionUser ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(String(value.runtimeRole)) ||
    value.runtimeRole === value.migrationRole ||
    !/^[0-9a-f]{64}$/.test(String(value.rolePlanSha256)) ||
    value.preProjectionSha256 !==
      createHash("sha256").update(projection.canonical).digest("hex") ||
    value.migrationRoleCanApplyMigrations !== true ||
    value.runtimeRoleCanApplyMigrations !== false ||
    value.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID",
      "Role precondition is not bound to the reviewed baseline projection and migration/runtime separation.",
    );
  }
  const capturedAt = exactTimestamp(
    value.capturedAt,
    "rolePrecondition.capturedAt",
  );
  return Object.freeze({ artifact, value, projection, rolePlan, capturedAt });
}

export function parseProductionMigrationBackupBinding(value, expected) {
  const backupPlan = parseProductionExact0096BackupPlan(
    value.backupPlanCanonical,
  );
  const backupTrace = parseProductionExact0096BackupExecutorTrace(
    value.backupExecutorTraceCanonical,
    value.backupPlanCanonical,
  );
  const backupReceipt = parseProductionExact0096BackupReceipt(
    value.backupReceiptCanonical,
    value.backupPlanCanonical,
    value.backupExecutorTraceCanonical,
  );
  const backupSignature = parseProductionExact0096BackupSignatureEnvelope(
    value.backupSignatureEnvelopeCanonical,
    {
      planCanonical: value.backupPlanCanonical,
      executorTraceCanonical: value.backupExecutorTraceCanonical,
      receiptCanonical: value.backupReceiptCanonical,
    },
  );
  let detachedSignature;
  try {
    detachedSignature = Buffer.from(
      exactString(
        value.backupDetachedSignatureB64,
        "plan.backupDetachedSignatureB64",
        128,
      ),
      "base64",
    );
  } catch {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_BACKUP_EVIDENCE_INVALID",
      "Detached backup signature is not canonical base64.",
    );
  }
  const signatureCanonical = detachedSignature.toString("base64");
  const liveSource = backupPlan.value.liveSource;
  const executor = backupPlan.value.executor;
  const producer = backupTrace.value.producer;
  const signatureEnvelope = backupSignature.value;
  if (
    signatureCanonical !== value.backupDetachedSignatureB64 ||
    detachedSignature.length !== 64 ||
    value.backupPlanSha256 !== backupPlan.sha256 ||
    value.backupExecutorTraceSha256 !== backupTrace.sha256 ||
    value.backupReceiptSha256 !== backupReceipt.sha256 ||
    value.backupSignatureEnvelopeSha256 !== backupSignature.sha256 ||
    value.backupDetachedSignatureSha256 !==
      productionMigrationSha256(detachedSignature) ||
    liveSource.sha !== expected.sourceSha ||
    liveSource.imageRef !== expected.applicationImageRef ||
    executor.buildSha === liveSource.sha ||
    executor.imageRef === liveSource.imageRef ||
    producer.buildSha !== executor.buildSha ||
    producer.executorImageRef !== executor.imageRef ||
    producer.buildSha === liveSource.sha ||
    producer.executorImageRef === liveSource.imageRef ||
    signatureEnvelope.schemaVersion !==
      PRODUCTION_EXACT_0096_BACKUP_SIGNATURE_SCHEMA ||
    signatureEnvelope.liveSourceSha !== liveSource.sha ||
    signatureEnvelope.liveSourceImageRef !== liveSource.imageRef ||
    signatureEnvelope.executorBuildSha !== executor.buildSha ||
    signatureEnvelope.executorImageRef !== executor.imageRef ||
    backupPlan.value.sourceDatabase.name !== expected.database.name ||
    backupPlan.value.sourceDatabase.user !== expected.database.currentUser ||
    backupPlan.value.baseline.knownAppliedRowsSha256 !==
      PRODUCTION_MIGRATION_PREFIX_STATES[0].knownAppliedRowsSha256 ||
    backupPlan.value.runtimeBindingSha256 !== expected.runtimeBindingSha256 ||
    backupPlan.value.runtimeBinding.postgresImageRef !==
      expected.postgresImageRef ||
    backupReceipt.value.decision !== "PASS" ||
    backupReceipt.value.authorizesProductionMigration !== false ||
    value.backupIntegritySha256 !== backupReceipt.sha256
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_BACKUP_EVIDENCE_INVALID",
      "Exact-0096 backup plan, signed trace and PASS receipt are not cross-bound to the live baseline.",
    );
  }
  return Object.freeze({
    backupPlan,
    backupTrace,
    backupReceipt,
    backupSignature,
    liveSource,
    executor,
    producer,
    signatureEnvelope,
  });
}

export function validateProductionMigrationPlan(value) {
  const plan = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "targetEvidenceCanonical",
      "targetEvidenceSha256",
      "baselineLiveIdentityCanonical",
      "baselineLiveIdentitySha256",
      "database",
      "baseline",
      "target",
      "backupPlanCanonical",
      "backupPlanSha256",
      "backupExecutorTraceCanonical",
      "backupExecutorTraceSha256",
      "backupReceiptCanonical",
      "backupReceiptSha256",
      "backupSignatureEnvelopeCanonical",
      "backupSignatureEnvelopeSha256",
      "backupDetachedSignatureB64",
      "backupDetachedSignatureSha256",
      "backupIntegritySha256",
      "rolePreconditionCanonical",
      "rolePreconditionSha256",
      "steps",
      "stepsSha256",
      "confirmation",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "plan",
  );
  if (
    plan.schemaVersion !== PRODUCTION_MIGRATION_PLAN_SCHEMA ||
    plan.kind !== "site-logbook-production-migration-plan" ||
    plan.confirmation !== PRODUCTION_MIGRATION_CONFIRMATION ||
    plan.productionTargetsTouched !== true ||
    plan.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_PLAN_INVALID",
      "Plan boundary or authorization fields are invalid.",
    );
  }
  exactSourceSha(plan.sourceSha, "plan.sourceSha");
  const targetEvidence = parseCanonicalProductionMigrationArtifact(
    plan.targetEvidenceCanonical,
    "plan.targetEvidenceCanonical",
  );
  if (plan.targetEvidenceSha256 !== targetEvidence.sha256) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TARGET_EVIDENCE_INVALID",
      "Plan target evidence digest does not match canonical bytes.",
    );
  }
  const target = exactObject(
    targetEvidence.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "database",
      "inventory",
      "capturedAt",
      "authorizesProductionMigration",
    ],
    "plan.targetEvidence",
  );
  if (
    target.schemaVersion !==
      "site-logbook.production-migration-target-evidence/v1" ||
    target.kind !== "site-logbook-production-migration-target-evidence" ||
    target.sourceSha !== plan.sourceSha ||
    canonicalProductionMigrationJson(
      databaseIdentity(target.database, "plan.targetEvidence.database"),
    ) !==
      canonicalProductionMigrationJson(
        databaseIdentity(plan.database, "plan.database"),
      ) ||
    validateProductionMigrationInventory(target.inventory).stateIndex !== 0 ||
    target.authorizesProductionMigration !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TARGET_EVIDENCE_INVALID",
      "Plan target evidence is not the exact baseline binding.",
    );
  }
  exactTimestamp(target.capturedAt, "plan.targetEvidence.capturedAt");
  const database = databaseIdentity(plan.database, "plan.database");
  const live = parseProductionMigrationLiveIdentity(
    plan.baselineLiveIdentityCanonical,
    "plan.baselineLiveIdentityCanonical",
  );
  if (
    plan.baselineLiveIdentitySha256 !== live.artifact.sha256 ||
    live.value.sourceSha !== plan.sourceSha ||
    live.state.stateIndex !== 0 ||
    canonicalProductionMigrationJson(live.database) !==
      canonicalProductionMigrationJson(database) ||
    live.observedAt !== exactTimestamp(target.capturedAt, "target.capturedAt")
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_LIVE_IDENTITY_INVALID",
      "Plan baseline live identity must equal the exact target observation.",
    );
  }
  parseProductionMigrationBackupBinding(plan, {
    sourceSha: plan.sourceSha,
    database,
    runtimeBindingSha256: live.value.runtimeBindingSha256,
    applicationImageRef: live.value.applicationImageRef,
    postgresImageRef: live.value.postgresImageRef,
  });
  exactDigest(plan.backupIntegritySha256, "plan.backupIntegritySha256");
  const role = parseRolePrecondition(plan.rolePreconditionCanonical, {
    sourceSha: plan.sourceSha,
    database,
  });
  if (
    plan.rolePreconditionSha256 !== role.artifact.sha256 ||
    role.capturedAt < live.observedAt
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID",
      "Role precondition digest or chronology is invalid.",
    );
  }
  if (
    canonicalProductionMigrationJson(plan.baseline) !==
      canonicalProductionMigrationJson(
        frozenStateSummary(PRODUCTION_MIGRATION_PREFIX_STATES[0]),
      ) ||
    canonicalProductionMigrationJson(plan.target) !==
      canonicalProductionMigrationJson(
        frozenStateSummary(PRODUCTION_MIGRATION_PREFIX_STATES.at(-1)),
      )
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_PLAN_INVALID",
      "Plan baseline or target is not frozen 97+2 to 107+2 lineage.",
    );
  }
  if (!Array.isArray(plan.steps) || plan.steps.length !== 10) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_PLAN_INVALID",
      "Plan must contain exactly ten ordered steps.",
    );
  }
  plan.steps.forEach((step, index) =>
    exactStep(step, index, `plan.steps[${index}]`),
  );
  const expectedStepsSha256 = productionMigrationSha256(
    canonicalProductionMigrationJson(PRODUCTION_MIGRATION_STEPS),
  );
  if (plan.stepsSha256 !== expectedStepsSha256) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_PLAN_INVALID",
      "Plan steps digest does not bind the exact ordered transition.",
    );
  }
  return plan;
}

export function createProductionMigrationPlan({
  sourceSha,
  targetEvidenceCanonical,
  baselineLiveIdentityCanonical,
  database,
  backupPlanCanonical,
  backupExecutorTraceCanonical,
  backupReceiptCanonical,
  backupSignatureEnvelopeCanonical,
  backupDetachedSignatureB64,
  rolePreconditionCanonical,
  baselineInventory,
}) {
  const baseline = validateProductionMigrationInventory(baselineInventory);
  if (baseline.stateIndex !== 0) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_BASELINE_INVALID",
      "A new production plan may start only at exact 97-known/0096 plus two opaque rows.",
    );
  }
  const targetEvidence = parseCanonicalProductionMigrationArtifact(
    targetEvidenceCanonical,
    "targetEvidence",
  );
  const target = exactObject(
    targetEvidence.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "database",
      "inventory",
      "capturedAt",
      "authorizesProductionMigration",
    ],
    "targetEvidence",
  );
  const normalizedSourceSha = exactSourceSha(sourceSha);
  const normalizedDatabase = databaseIdentity(database);
  if (
    target.schemaVersion !==
      "site-logbook.production-migration-target-evidence/v1" ||
    target.kind !== "site-logbook-production-migration-target-evidence" ||
    target.sourceSha !== normalizedSourceSha ||
    canonicalProductionMigrationJson(
      databaseIdentity(target.database, "targetEvidence.database"),
    ) !== canonicalProductionMigrationJson(normalizedDatabase) ||
    validateProductionMigrationInventory(target.inventory).stateIndex !== 0 ||
    target.authorizesProductionMigration !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TARGET_EVIDENCE_INVALID",
      "Target evidence is not the exact read-only production baseline binding.",
    );
  }
  exactTimestamp(target.capturedAt, "targetEvidence.capturedAt");
  const live = parseProductionMigrationLiveIdentity(
    baselineLiveIdentityCanonical,
    "baselineLiveIdentity",
  );
  if (
    live.value.sourceSha !== normalizedSourceSha ||
    live.state.stateIndex !== 0 ||
    canonicalProductionMigrationJson(live.database) !==
      canonicalProductionMigrationJson(normalizedDatabase) ||
    live.observedAt !== exactTimestamp(target.capturedAt, "target.capturedAt")
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_LIVE_IDENTITY_INVALID",
      "Baseline live identity is not the exact target observation.",
    );
  }
  const role = parseRolePrecondition(rolePreconditionCanonical, {
    sourceSha: normalizedSourceSha,
    database: normalizedDatabase,
  });
  if (role.capturedAt < live.observedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Role precondition predates the live target observation.",
    );
  }
  const plan = {
    schemaVersion: PRODUCTION_MIGRATION_PLAN_SCHEMA,
    kind: "site-logbook-production-migration-plan",
    sourceSha: normalizedSourceSha,
    targetEvidenceCanonical: targetEvidence.canonical,
    targetEvidenceSha256: targetEvidence.sha256,
    baselineLiveIdentityCanonical: live.artifact.canonical,
    baselineLiveIdentitySha256: live.artifact.sha256,
    database: normalizedDatabase,
    baseline: frozenStateSummary(baseline),
    target: frozenStateSummary(PRODUCTION_MIGRATION_PREFIX_STATES.at(-1)),
    backupPlanCanonical,
    backupPlanSha256:
      parseProductionExact0096BackupPlan(backupPlanCanonical).sha256,
    backupExecutorTraceCanonical,
    backupExecutorTraceSha256: parseProductionExact0096BackupExecutorTrace(
      backupExecutorTraceCanonical,
      backupPlanCanonical,
    ).sha256,
    backupReceiptCanonical,
    backupReceiptSha256: parseProductionExact0096BackupReceipt(
      backupReceiptCanonical,
      backupPlanCanonical,
      backupExecutorTraceCanonical,
    ).sha256,
    backupSignatureEnvelopeCanonical,
    backupSignatureEnvelopeSha256:
      parseProductionExact0096BackupSignatureEnvelope(
        backupSignatureEnvelopeCanonical,
        {
          planCanonical: backupPlanCanonical,
          executorTraceCanonical: backupExecutorTraceCanonical,
          receiptCanonical: backupReceiptCanonical,
        },
      ).sha256,
    backupDetachedSignatureB64: exactString(
      backupDetachedSignatureB64,
      "backupDetachedSignatureB64",
      128,
    ),
    backupDetachedSignatureSha256: productionMigrationSha256(
      Buffer.from(backupDetachedSignatureB64, "base64"),
    ),
    backupIntegritySha256: parseProductionExact0096BackupReceipt(
      backupReceiptCanonical,
      backupPlanCanonical,
      backupExecutorTraceCanonical,
    ).sha256,
    rolePreconditionCanonical: role.artifact.canonical,
    rolePreconditionSha256: role.artifact.sha256,
    steps: PRODUCTION_MIGRATION_STEPS,
    stepsSha256: productionMigrationSha256(
      canonicalProductionMigrationJson(PRODUCTION_MIGRATION_STEPS),
    ),
    confirmation: PRODUCTION_MIGRATION_CONFIRMATION,
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  };
  validateProductionMigrationPlan(plan);
  return createProductionMigrationArtifact(plan);
}

export function validateProductionMigrationIntent(
  value,
  expectedPlanCanonical,
) {
  const planArtifact = parseCanonicalProductionMigrationArtifact(
    expectedPlanCanonical,
    "plan",
  );
  const plan = validateProductionMigrationPlan(planArtifact.value);
  const intent = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "intentId",
      "planSha256",
      "sourceSha",
      "targetEvidenceSha256",
      "baselineLiveIdentitySha256",
      "database",
      "backupPlanSha256",
      "backupReceiptSha256",
      "backupSignatureEnvelopeSha256",
      "backupDetachedSignatureSha256",
      "backupIntegritySha256",
      "rolePreconditionSha256",
      "stepsSha256",
      "createdAt",
      "operator",
      "confirmation",
      "persistencePolicy",
      "recoveryPolicy",
      "opaqueLegacyRowsSha256",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "intent",
  );
  if (
    intent.schemaVersion !== PRODUCTION_MIGRATION_INTENT_SCHEMA ||
    intent.kind !== "site-logbook-production-migration-intent" ||
    !INTENT_ID.test(String(intent.intentId)) ||
    intent.planSha256 !== planArtifact.sha256 ||
    intent.sourceSha !== plan.sourceSha ||
    intent.targetEvidenceSha256 !== plan.targetEvidenceSha256 ||
    intent.baselineLiveIdentitySha256 !== plan.baselineLiveIdentitySha256 ||
    canonicalProductionMigrationJson(intent.database) !==
      canonicalProductionMigrationJson(plan.database) ||
    intent.backupPlanSha256 !== plan.backupPlanSha256 ||
    intent.backupReceiptSha256 !== plan.backupReceiptSha256 ||
    intent.backupSignatureEnvelopeSha256 !==
      plan.backupSignatureEnvelopeSha256 ||
    intent.backupDetachedSignatureSha256 !==
      plan.backupDetachedSignatureSha256 ||
    intent.backupIntegritySha256 !== plan.backupIntegritySha256 ||
    intent.rolePreconditionSha256 !== plan.rolePreconditionSha256 ||
    intent.stepsSha256 !== plan.stepsSha256 ||
    intent.confirmation !== PRODUCTION_MIGRATION_CONFIRMATION ||
    intent.persistencePolicy !== "durable-before-first-database-write" ||
    intent.recoveryPolicy !== "receipt-backed-prefix-only-no-blind-retry" ||
    intent.opaqueLegacyRowsSha256 !== PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 ||
    intent.productionTargetsTouched !== true ||
    intent.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_INTENT_INVALID",
      "Intent does not preserve the exact plan and durable recovery boundary.",
    );
  }
  const intentCreatedAt = exactTimestamp(intent.createdAt, "intent.createdAt");
  const targetEvidence = parseCanonicalProductionMigrationArtifact(
    plan.targetEvidenceCanonical,
    "plan.targetEvidenceCanonical",
  );
  const backupReceipt = parseProductionExact0096BackupReceipt(
    plan.backupReceiptCanonical,
    plan.backupPlanCanonical,
    plan.backupExecutorTraceCanonical,
  );
  const role = parseRolePrecondition(plan.rolePreconditionCanonical, {
    sourceSha: plan.sourceSha,
    database: plan.database,
  });
  if (
    intentCreatedAt <
      exactTimestamp(
        targetEvidence.value.capturedAt,
        "plan.targetEvidence.capturedAt",
      ) ||
    intentCreatedAt <
      exactTimestamp(
        backupReceipt.value.completedAt,
        "plan.backupReceipt.completedAt",
      ) ||
    intentCreatedAt < role.capturedAt
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Intent predates its target or backup evidence.",
    );
  }
  exactString(intent.operator, "intent.operator");
  return intent;
}

export function createProductionMigrationIntent({
  planCanonical,
  intentId,
  createdAt,
  operator,
  confirmation,
}) {
  const planArtifact = parseCanonicalProductionMigrationArtifact(
    planCanonical,
    "plan",
  );
  const plan = validateProductionMigrationPlan(planArtifact.value);
  if (confirmation !== PRODUCTION_MIGRATION_CONFIRMATION) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_CONFIRMATION_INVALID",
      "The exact production migration confirmation is required.",
    );
  }
  const intent = {
    schemaVersion: PRODUCTION_MIGRATION_INTENT_SCHEMA,
    kind: "site-logbook-production-migration-intent",
    intentId: exactString(intentId, "intentId"),
    planSha256: planArtifact.sha256,
    sourceSha: plan.sourceSha,
    targetEvidenceSha256: plan.targetEvidenceSha256,
    baselineLiveIdentitySha256: plan.baselineLiveIdentitySha256,
    database: plan.database,
    backupPlanSha256: plan.backupPlanSha256,
    backupReceiptSha256: plan.backupReceiptSha256,
    backupSignatureEnvelopeSha256: plan.backupSignatureEnvelopeSha256,
    backupDetachedSignatureSha256: plan.backupDetachedSignatureSha256,
    backupIntegritySha256: plan.backupIntegritySha256,
    rolePreconditionSha256: plan.rolePreconditionSha256,
    stepsSha256: plan.stepsSha256,
    createdAt: new Date(exactTimestamp(createdAt, "createdAt")).toISOString(),
    operator: exactString(operator, "operator"),
    confirmation,
    persistencePolicy: "durable-before-first-database-write",
    recoveryPolicy: "receipt-backed-prefix-only-no-blind-retry",
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  };
  validateProductionMigrationIntent(intent, planCanonical);
  return createProductionMigrationArtifact(intent);
}

export function createProductionMigrationIntentPersistenceReceipt({
  planCanonical,
  intentCanonical,
  persistedCanonical,
  persistedAt,
  storageId,
}) {
  const plan = parseCanonicalProductionMigrationArtifact(planCanonical, "plan");
  validateProductionMigrationPlan(plan.value);
  const intent = parseCanonicalProductionMigrationArtifact(
    intentCanonical,
    "intent",
  );
  validateProductionMigrationIntent(intent.value, planCanonical);
  if (persistedCanonical !== intentCanonical) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_INTENT_NOT_DURABLE",
      "Durable read-back bytes do not exactly match the intent.",
    );
  }
  const receipt = {
    schemaVersion: PRODUCTION_MIGRATION_INTENT_PERSISTENCE_SCHEMA,
    kind: "site-logbook-production-migration-intent-persistence-receipt",
    planSha256: plan.sha256,
    intentSha256: intent.sha256,
    storageId: exactString(storageId, "storageId", 128),
    persistenceMode: "exclusive-create-durable-readback",
    persistedCanonical,
    persistedCanonicalSha256: productionMigrationSha256(persistedCanonical),
    persistedAt: new Date(
      exactTimestamp(persistedAt, "persistedAt"),
    ).toISOString(),
    productionTargetsTouched: false,
    authorizesApplicationStart: false,
  };
  if (
    exactTimestamp(receipt.persistedAt, "persistedAt") <
    exactTimestamp(intent.value.createdAt, "intent.createdAt")
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Intent persistence predates intent creation.",
    );
  }
  return createProductionMigrationArtifact(receipt);
}

export function validateProductionMigrationIntentPersistenceReceipt(
  receiptCanonical,
  planCanonical,
  intentCanonical,
) {
  const plan = parseCanonicalProductionMigrationArtifact(planCanonical, "plan");
  validateProductionMigrationPlan(plan.value);
  const intent = parseCanonicalProductionMigrationArtifact(
    intentCanonical,
    "intent",
  );
  validateProductionMigrationIntent(intent.value, planCanonical);
  const receipt = parseCanonicalProductionMigrationArtifact(
    receiptCanonical,
    "intentPersistenceReceipt",
  );
  const value = exactObject(
    receipt.value,
    [
      "schemaVersion",
      "kind",
      "planSha256",
      "intentSha256",
      "storageId",
      "persistenceMode",
      "persistedCanonical",
      "persistedCanonicalSha256",
      "persistedAt",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "intentPersistenceReceipt",
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_INTENT_PERSISTENCE_SCHEMA ||
    value.kind !==
      "site-logbook-production-migration-intent-persistence-receipt" ||
    value.planSha256 !== plan.sha256 ||
    value.intentSha256 !== intent.sha256 ||
    value.persistenceMode !== "exclusive-create-durable-readback" ||
    value.persistedCanonical !== intentCanonical ||
    value.persistedCanonicalSha256 !== intent.sha256 ||
    value.productionTargetsTouched !== false ||
    value.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_INTENT_NOT_DURABLE",
      "Intent persistence receipt is not exact and bound.",
    );
  }
  exactString(value.storageId, "intentPersistenceReceipt.storageId", 128);
  if (
    exactTimestamp(value.persistedAt, "intentPersistenceReceipt.persistedAt") <
    exactTimestamp(intent.value.createdAt, "intent.createdAt")
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Intent persistence predates intent creation.",
    );
  }
  return receipt;
}

export const PRODUCTION_MIGRATION_EXECUTOR_INTERFACE = Object.freeze({
  version: "site-logbook.production-migration-executor-di/v1",
  methods: Object.freeze([
    "persistIntentExclusive(intentCanonical)",
    "readPersistedIntentCanonical(storageId)",
    "persistIntentReceiptExclusive(receiptCanonical)",
    "readInventoryReadOnly()",
    "applyExactStepTransaction(step, expectedBeforeState, advisoryLockKey) -> transactionEvidenceCanonical",
    "persistReceiptExclusive(receiptCanonical)",
  ]),
  constraints: Object.freeze([
    "intent-must-be-durable-before-first-write",
    "one-advisory-locked-transaction-per-step",
    "no-generic-migrate-fallback",
    "no-blind-retry",
    "no-journal-edit-or-opaque-row-write",
    "no-application-start-authorization",
  ]),
  advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  baseline: PRODUCTION_MIGRATION_BASELINE,
  target: PRODUCTION_MIGRATION_TARGET,
});
import { createHash } from "node:crypto";
