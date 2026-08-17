import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
} from "../production-evidence/production-migration-contract.mjs";
import { createProductionExact0096BackupPlan } from "../production-evidence/production-exact-0096-backup-planner.mjs";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { runProductionExact0096BackupEvidenceExecutor } from "../production-evidence/production-exact-0096-backup-receipt.mjs";
import {
  createProductionExact0096BackupSignatureEnvelope,
  productionExact0096BackupSignaturePayload,
} from "../production-evidence/production-exact-0096-backup-signature.mjs";
import {
  fixtureExecutorDependencies,
  fixturePlanInput as fixtureBackupPlanInput,
} from "./production-exact-0096-backup-contract-fixtures.mjs";

export const fixtureDigest = (character) => `sha256:${character.repeat(64)}`;
export const fixtureSourceSha = "a".repeat(40);
export const fixtureIntentId = "b".repeat(64);
export const fixtureRunId = "c".repeat(64);

export function fixtureInventory(stateIndex = 0) {
  const state = PRODUCTION_MIGRATION_PREFIX_STATES[stateIndex];
  return structuredClone({
    knownAppliedMigrations: state.knownAppliedMigrations,
    knownAppliedRowsSha256: state.knownAppliedRowsSha256,
    latestKnownAppliedTag: state.latestKnownAppliedTag,
    missingKnownMigrationTags: state.missingKnownMigrationTags,
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: PRODUCTION_OPAQUE_LEGACY_ROWS,
    excludedMigration0100Present: false,
    totalJournalRows: state.totalJournalRows,
  });
}

async function buildFixturePlanInput(
  backupPlanInput = fixtureBackupPlanInput(),
) {
  const database = {
    name: "site_logbook",
    sessionUser: "site_logbook_executor",
    currentUser: "site_logbook_backup",
  };
  const targetEvidence = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-migration-target-evidence/v1",
    kind: "site-logbook-production-migration-target-evidence",
    sourceSha: fixtureSourceSha,
    database,
    inventory: fixtureInventory(0),
    capturedAt: "2026-08-12T09:55:00.000Z",
    authorizesProductionMigration: false,
  });
  const backupPlan = createProductionExact0096BackupPlan(backupPlanInput);
  const dependencies = fixtureExecutorDependencies(backupPlan);
  const executorIdentity = JSON.parse(
    await dependencies.observeExecutorIdentity(),
  );
  executorIdentity.buildSha = backupPlan.value.executor.buildSha;
  dependencies.observeExecutorIdentity = async () =>
    canonicalProductionExact0096BackupJson(executorIdentity);
  const backupExecution = await runProductionExact0096BackupEvidenceExecutor({
    planCanonical: backupPlan.canonical,
    dependencies,
  });
  const backupSignatureEnvelope =
    createProductionExact0096BackupSignatureEnvelope({
      planCanonical: backupPlan.canonical,
      executorTraceCanonical: backupExecution.trace.canonical,
      receiptCanonical: backupExecution.receipt.canonical,
      keyId: "ed25519:production-host-key-1",
    });
  const { privateKey } = generateKeyPairSync("ed25519");
  const backupDetachedSignatureB64 = sign(
    null,
    productionExact0096BackupSignaturePayload(
      backupSignatureEnvelope.canonical,
    ),
    privateKey,
  ).toString("base64");
  const live = createProductionMigrationLiveIdentity({
    sourceSha: fixtureSourceSha,
    database,
    applicationImageRef: backupPlan.value.liveSource.imageRef,
    postgresImageRef: backupPlan.value.runtimeBinding.postgresImageRef,
    runtimeBindingSha256: backupPlan.value.runtimeBindingSha256,
    inventory: fixtureInventory(0),
    observedAt: "2026-08-12T09:55:00.000Z",
  });
  const preProjectionCanonical = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-db-role-separation/v1",
    migration: "0107_canonical_audit_evidence",
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    databaseName: database.name,
    runtimeRole: { name: "site_logbook_runtime" },
    migratorRole: { name: database.currentUser },
  });
  const rolePlanBody = {
    schemaVersion: "site-logbook.production-db-role-separation-plan/v1",
    executionDefault: "disabled",
    migration: "0107_canonical_audit_evidence",
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    databaseName: database.name,
    runtimeRole: "site_logbook_runtime",
    migratorRole: database.currentUser,
    statements: ["fixture-only-authoritative-adapter-validates-full-plan"],
  };
  const rolePlanSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(rolePlanBody))
    .digest("hex");
  const rolePlan = createProductionMigrationArtifact({
    ...rolePlanBody,
    planSha256: rolePlanSha256,
  });
  const rolePrecondition = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-migration-role-precondition/v1",
    kind: "site-logbook-production-migration-role-precondition",
    sourceSha: fixtureSourceSha,
    database,
    migrationRole: database.currentUser,
    runtimeRole: "site_logbook_runtime",
    rolePlanCanonical: rolePlan.canonical,
    rolePlanSha256,
    preProjectionCanonical: preProjectionCanonical.canonical,
    preProjectionSha256: createHash("sha256")
      .update(preProjectionCanonical.canonical)
      .digest("hex"),
    capturedAt: "2026-08-12T09:56:00.000Z",
    migrationRoleCanApplyMigrations: true,
    runtimeRoleCanApplyMigrations: false,
    authorizesApplicationStart: false,
  });
  return {
    sourceSha: fixtureSourceSha,
    targetEvidenceCanonical: targetEvidence.canonical,
    baselineLiveIdentityCanonical: live.canonical,
    database,
    backupPlanCanonical: backupPlan.canonical,
    backupExecutorTraceCanonical: backupExecution.trace.canonical,
    backupReceiptCanonical: backupExecution.receipt.canonical,
    backupSignatureEnvelopeCanonical: backupSignatureEnvelope.canonical,
    backupDetachedSignatureB64,
    rolePreconditionCanonical: rolePrecondition.canonical,
    baselineInventory: fixtureInventory(0),
  };
}

const INTEGRATED_PLAN_INPUT = await buildFixturePlanInput();

export function fixturePlanInput() {
  return structuredClone(INTEGRATED_PLAN_INPUT);
}

export function fixturePlanInputForBackup(backupPlanInput) {
  return buildFixturePlanInput(structuredClone(backupPlanInput));
}

export function fixtureIntentInput(planCanonical) {
  return {
    planCanonical,
    intentId: fixtureIntentId,
    createdAt: "2026-08-12T11:00:00.000Z",
    operator: "production-owner",
    confirmation: PRODUCTION_MIGRATION_CONFIRMATION,
  };
}
