import { describe, expect, it, vi } from "vitest";
import { GetAdminHealthResponse } from "@workspace/api-zod";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_OPAQUE_ROWS_SHA256,
} from "@workspace/db/audit-schema-preflight";
import {
  PRODUCTION_TARGET,
  canonicalProductionEvidenceJson,
  createCanonicalProductionEvidenceArtifact,
  productionEvidenceSha256,
  validateProductionAudit0107ReleaseEvidence,
} from "../src/lib/production-startup-evidence";
import {
  runProductionStartupPreflight,
  type ProductionAuditDatabaseReadiness,
} from "../src/lib/production-startup";
import { requireObservedProductionHostRunner } from "../src/lib/production-evidence-runner";
import {
  isImmutableBuildSha,
  requiresReleaseStartupGuard,
} from "../src/lib/build-provenance";
import {
  failProductionRuntimeReadiness,
  installProductionRuntimeBinding,
  readProductionRuntimeHealthProjection,
  readProductionRuntimeReadinessState,
  refreshProductionRuntimeReadiness,
  resetProductionRuntimeBindingForTest,
} from "../src/lib/production-runtime-state";

const SOURCE_SHA = "a".repeat(40);
const API_DIGEST = `sha256:${"b".repeat(64)}`;
const API_IMAGE = `ghcr.io/modvolt/site-logbook-production-api@${API_DIGEST}`;
const SCHEMA_SHA = `sha256:${"c".repeat(64)}`;
const BACKUP_SHA = `sha256:${"d".repeat(64)}`;
const TRANSITION_CHAIN_SHA = `sha256:${"e".repeat(64)}`;
const KNOWN_SHA = AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target;
const OPAQUE_SHA = AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.productionCopyRestricted;

function fixture() {
  const now = Date.now();
  const verifiedTableCounts = {
    "drizzle.__drizzle_migrations": 109,
    "public.activities": 20,
    "public.customers": 8,
    "public.jobs": 12,
    "public.users": 4,
  };
  const backupIntegrity = {
    schemaVersion: "site-logbook.audit-schema-backup-integrity/v1",
    verifiedTableNames: Object.keys(verifiedTableCounts),
    verifiedTableCounts,
    verifiedTableCountsSha256: productionEvidenceSha256(
      canonicalProductionEvidenceJson(verifiedTableCounts),
    ),
    backupRowBindingSha256: `sha256:${"7".repeat(64)}`,
  };
  const backupIntegritySha256 = productionEvidenceSha256(
    canonicalProductionEvidenceJson(backupIntegrity),
  );
  const postgresProjection = {
    containerId: "1".repeat(64),
    image: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
    imageId: `sha256:${"3".repeat(64)}`,
    networkId: "4".repeat(64),
    networkName: "coolify-production",
    volumeName: "site-logbook-production-pgdata",
  };
  const targetValue = {
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-target",
    logicalEnvironmentId: PRODUCTION_TARGET.logicalEnvironmentId,
    coolify: {
      projectId: PRODUCTION_TARGET.projectId,
      environmentId: PRODUCTION_TARGET.environmentId,
      environmentLabel: PRODUCTION_TARGET.environmentLabel,
      applicationId: PRODUCTION_TARGET.applicationId,
      pendingChanges: false,
      deployedConfigSha256: `sha256:${"5".repeat(64)}`,
      desiredConfigSha256: `sha256:${"5".repeat(64)}`,
      resolvedComposeSha256: `sha256:${"6".repeat(64)}`,
    },
    build: {
      sourceSha: SOURCE_SHA,
      provenanceSourceSha: SOURCE_SHA,
      provenanceEvidenceSha256: `sha256:${"8".repeat(64)}`,
      apiImage: API_IMAGE,
      apiImageDigest: API_DIGEST,
      imageProfile: "production",
      mutatingEntrypointsPresent: false,
    },
    database: { name: "site_logbook", user: "site_logbook_runtime" },
    livePostgresTarget: {
      ...postgresProjection,
      projectionSha256: productionEvidenceSha256(
        canonicalProductionEvidenceJson(postgresProjection),
      ),
    },
    schemaFingerprintSha256: SCHEMA_SHA,
    capturedAt: new Date(now - 5 * 60_000).toISOString(),
  };
  const target = createCanonicalProductionEvidenceArtifact(targetValue);
  const intent = createCanonicalProductionEvidenceArtifact({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-intent",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    expectedSchemaFingerprintSha256: SCHEMA_SHA,
    backupIntegrity,
    productionTargetsTouched: true,
    confirmation: "APPLY_0107_AUDIT_EVIDENCE_TO_EXACT_MODVOLT_PRODUCTION",
    authorizesApplicationStart: false,
  });
  const execution = createCanonicalProductionEvidenceArtifact({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-execution",
    decision: "PASS",
    operation: "verified-noop",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    intentEvidenceSha256: intent.sha256,
    expectedSchemaFingerprintSha256: SCHEMA_SHA,
    backupIntegrity,
    productionTargetsTouched: true,
    migration0107AppliedOrVerified: true,
    preMigrationBackupEvidenceSha256: BACKUP_SHA,
    transitionChainSha256: TRANSITION_CHAIN_SHA,
    completedAt: new Date(now - 4 * 60_000).toISOString(),
    authorizesApplicationStart: false,
  });
  const lineage = {
    decision: "ALREADY_0107",
    mode: "production-copy-restricted",
    knownExpectedMigrations: 107,
    knownAppliedMigrations: 107,
    knownAppliedRowsSha256: KNOWN_SHA,
    latestKnownAppliedTag: "0107_canonical_audit_evidence",
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: OPAQUE_SHA,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  };
  const steady = createCanonicalProductionEvidenceArtifact({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-steady",
    decision: "ALREADY_0107",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    productionTargetsTouched: true,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: SCHEMA_SHA,
    lineage,
    checkedAt: new Date(now - 3 * 60_000).toISOString(),
    authorizesApplicationStart: true,
  });
  const approvedAt = new Date(now - 2 * 60_000).toISOString();
  const operator = "modvolt-release-owner";
  const activationApproval = createCanonicalProductionEvidenceArtifact({
    schemaVersion: "site-logbook.production-activation-approval/v1",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    approvedAt,
    operator,
  });
  const release = createCanonicalProductionEvidenceArtifact({
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-release-evidence",
    sourceSha: SOURCE_SHA,
    targetEvidenceSha256: target.sha256,
    intentEvidenceSha256: intent.sha256,
    executionEvidenceSha256: execution.sha256,
    steadyEvidenceSha256: steady.sha256,
    confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    activationApprovalSha256: activationApproval.sha256,
    approvedAt,
    operator,
    productionTargetsTouched: true,
    authorizesApplicationStart: true,
  });
  const input = {
    expectedSourceSha: SOURCE_SHA,
    expectedApiImage: API_IMAGE,
    expectedDatabaseName: "site_logbook",
    expectedDatabaseUser: "site_logbook_runtime",
    expectedTargetSha256: target.sha256,
    expectedSchemaFingerprintSha256: SCHEMA_SHA,
    expectedPreMigrationBackupEvidenceSha256: BACKUP_SHA,
    expectedBackupIntegritySha256: backupIntegritySha256,
    expectedTransitionChainSha256: TRANSITION_CHAIN_SHA,
    expectedActivationApprovalSha256: activationApproval.sha256,
    activationApprovalEvidenceB64: activationApproval.base64,
    activationApprovalEvidenceSha256: activationApproval.sha256,
    targetEvidenceB64: target.base64,
    targetEvidenceSha256: target.sha256,
    intentEvidenceB64: intent.base64,
    intentEvidenceSha256: intent.sha256,
    executionEvidenceB64: execution.base64,
    executionEvidenceSha256: execution.sha256,
    steadyEvidenceB64: steady.base64,
    steadyEvidenceSha256: steady.sha256,
    releaseEvidenceB64: release.base64,
    releaseEvidenceSha256: release.sha256,
  };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    BUILD_SHA: SOURCE_SHA,
    DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5432/site_logbook`,
    MIGRATIONS_DIR: "/app/migrations",
    S3_ENDPOINT: "https://fsn1.your-objectstorage.com",
    S3_REGION: "fsn1",
    S3_BUCKET: "modvoltdata",
    S3_ACCESS_KEY_ID: "fixture-access-key",
    S3_SECRET_ACCESS_KEY: "fixture-secret-key",
    S3_FORCE_PATH_STYLE: "false",
    PRODUCTION_EXPECTED_SOURCE_SHA: input.expectedSourceSha,
    PRODUCTION_EXPECTED_API_IMAGE: input.expectedApiImage,
    PRODUCTION_EXPECTED_DATABASE_NAME: input.expectedDatabaseName,
    PRODUCTION_EXPECTED_DATABASE_USER: input.expectedDatabaseUser,
    PRODUCTION_EXPECTED_TARGET_SHA256: input.expectedTargetSha256,
    PRODUCTION_EXPECTED_AUDIT_SCHEMA_FINGERPRINT_SHA256:
      input.expectedSchemaFingerprintSha256,
    PRODUCTION_EXPECTED_PRE_MIGRATION_BACKUP_EVIDENCE_SHA256:
      input.expectedPreMigrationBackupEvidenceSha256,
    PRODUCTION_EXPECTED_BACKUP_INTEGRITY_SHA256:
      input.expectedBackupIntegritySha256,
    PRODUCTION_EXPECTED_0096_0107_TRANSITION_CHAIN_SHA256:
      input.expectedTransitionChainSha256,
    PRODUCTION_EXPECTED_ACTIVATION_APPROVAL_SHA256:
      input.expectedActivationApprovalSha256,
    PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_B64:
      input.activationApprovalEvidenceB64,
    PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_SHA256:
      input.activationApprovalEvidenceSha256,
    PRODUCTION_AUDIT_0107_TARGET_EVIDENCE_B64: input.targetEvidenceB64,
    PRODUCTION_AUDIT_0107_TARGET_EVIDENCE_SHA256: input.targetEvidenceSha256,
    PRODUCTION_AUDIT_0107_INTENT_EVIDENCE_B64: input.intentEvidenceB64,
    PRODUCTION_AUDIT_0107_INTENT_EVIDENCE_SHA256: input.intentEvidenceSha256,
    PRODUCTION_AUDIT_0107_EXECUTION_EVIDENCE_B64: input.executionEvidenceB64,
    PRODUCTION_AUDIT_0107_EXECUTION_EVIDENCE_SHA256:
      input.executionEvidenceSha256,
    PRODUCTION_AUDIT_0107_STEADY_EVIDENCE_B64: input.steadyEvidenceB64,
    PRODUCTION_AUDIT_0107_STEADY_EVIDENCE_SHA256: input.steadyEvidenceSha256,
    PRODUCTION_AUDIT_0107_RELEASE_EVIDENCE_B64: input.releaseEvidenceB64,
    PRODUCTION_AUDIT_0107_RELEASE_EVIDENCE_SHA256: input.releaseEvidenceSha256,
  };
  return { input, env, lineage, targetValue };
}

function liveReadiness(): ProductionAuditDatabaseReadiness {
  return {
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: SCHEMA_SHA,
    latestKnownAppliedTag: "0107_canonical_audit_evidence",
    knownExpectedMigrations: 107,
    knownAppliedMigrations: 107,
    knownAppliedRowsSha256: KNOWN_SHA,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: OPAQUE_SHA,
    excludedMigration0100Present: false,
    externalAuditRowCount: 0,
    auditSchemaReady: true,
    integrityValid: true,
    postMigrationIntegrityValid: true,
    trustedAuditGenesis: true,
  };
}

const acceptObservedHostRunner = async () => undefined;

describe("production startup evidence", () => {
  it("cannot downgrade an exact-SHA release bundle through NODE_ENV", () => {
    expect(isImmutableBuildSha(SOURCE_SHA)).toBe(true);
    expect(requiresReleaseStartupGuard(SOURCE_SHA, undefined)).toBe(true);
    expect(requiresReleaseStartupGuard(SOURCE_SHA, "development")).toBe(true);
    expect(requiresReleaseStartupGuard("dev", undefined)).toBe(false);
    expect(requiresReleaseStartupGuard("dev", "development")).toBe(false);
    expect(() => requiresReleaseStartupGuard("dev", "production")).toThrow(
      /PRODUCTION_BUILD_PROVENANCE_INVALID/,
    );
  });

  it("accepts only the exact production target and immutable release chain", () => {
    const { input } = fixture();
    const summary = validateProductionAudit0107ReleaseEvidence(input);
    expect(summary.sourceSha).toBe(SOURCE_SHA);
    expect(summary.apiImageDigest).toBe(API_DIGEST);
    expect(summary.schemaFingerprintSha256).toBe(SCHEMA_SHA);
  });

  it("rejects Coolify pending changes and staging target substitution", () => {
    for (const change of [
      { key: "pendingChanges", value: true },
      { key: "environmentId", value: "staging-environment" },
    ] as const) {
      const { input, targetValue } = fixture();
      targetValue.coolify[change.key] = change.value as never;
      const changed = createCanonicalProductionEvidenceArtifact(targetValue);
      expect(() =>
        validateProductionAudit0107ReleaseEvidence({
          ...input,
          targetEvidenceB64: changed.base64,
          targetEvidenceSha256: changed.sha256,
          expectedTargetSha256: changed.sha256,
        }),
      ).toThrow();
    }
  });

  it("rejects config drift and a control-plane or mutating API image", () => {
    const mutations: Array<
      (target: ReturnType<typeof fixture>["targetValue"]) => void
    > = [
      (target) => {
        target.coolify.desiredConfigSha256 = `sha256:${"8".repeat(64)}`;
      },
      (target) => {
        target.build.imageProfile = "control-plane";
      },
      (target) => {
        target.build.mutatingEntrypointsPresent = true;
      },
    ];
    for (const mutate of mutations) {
      const { input, targetValue } = fixture();
      mutate(targetValue);
      const changed = createCanonicalProductionEvidenceArtifact(targetValue);
      expect(() =>
        validateProductionAudit0107ReleaseEvidence({
          ...input,
          targetEvidenceB64: changed.base64,
          targetEvidenceSha256: changed.sha256,
          expectedTargetSha256: changed.sha256,
        }),
      ).toThrow();
    }
  });

  it("rejects backup-integrity tampering even when the changed execution is rehashed", () => {
    const { input } = fixture();
    const execution = JSON.parse(
      Buffer.from(input.executionEvidenceB64, "base64").toString("utf8"),
    );
    execution.backupIntegrity.verifiedTableCounts["public.jobs"] += 1;
    const changed = createCanonicalProductionEvidenceArtifact(execution);
    expect(() =>
      validateProductionAudit0107ReleaseEvidence({
        ...input,
        executionEvidenceB64: changed.base64,
        executionEvidenceSha256: changed.sha256,
      }),
    ).toThrow(/backupIntegrity/);
  });

  it("rejects a rehashed activation approval whose operator does not match the release", () => {
    const { input } = fixture();
    const approval = JSON.parse(
      Buffer.from(input.activationApprovalEvidenceB64, "base64").toString(
        "utf8",
      ),
    );
    approval.operator = "different-release-owner";
    const changedApproval = createCanonicalProductionEvidenceArtifact(approval);
    const release = JSON.parse(
      Buffer.from(input.releaseEvidenceB64, "base64").toString("utf8"),
    );
    release.activationApprovalSha256 = changedApproval.sha256;
    const changedRelease = createCanonicalProductionEvidenceArtifact(release);

    expect(() =>
      validateProductionAudit0107ReleaseEvidence({
        ...input,
        expectedActivationApprovalSha256: changedApproval.sha256,
        activationApprovalEvidenceB64: changedApproval.base64,
        activationApprovalEvidenceSha256: changedApproval.sha256,
        releaseEvidenceB64: changedRelease.base64,
        releaseEvidenceSha256: changedRelease.sha256,
      }),
    ).toThrow(/activationApprovalEvidence.operator/);
  });

  it("fails before DB access when external accounts or trusted evidence is absent", async () => {
    const { env } = fixture();
    const verifyDatabase = vi.fn(async () => liveReadiness());
    await expect(
      runProductionStartupPreflight(
        { ...env, EXTERNAL_ACCOUNTS_ENABLED: "true" },
        SOURCE_SHA,
        {
          verifyObservedHostRunner: acceptObservedHostRunner,
          verifyDatabase,
        },
      ),
    ).rejects.toThrow(/EXTERNAL_ACCOUNTS_ENABLED/);
    await expect(
      runProductionStartupPreflight(
        { ...env, PRODUCTION_EXPECTED_TARGET_SHA256: undefined },
        SOURCE_SHA,
        {
          verifyObservedHostRunner: acceptObservedHostRunner,
          verifyDatabase,
        },
      ),
    ).rejects.toThrow(/PRODUCTION_EXPECTED_TARGET_SHA256/);
    expect(verifyDatabase).not.toHaveBeenCalled();
  });

  it("rejects an admin, migrator, or credential-less API database URL before DB access", async () => {
    const { env } = fixture();
    const verifyDatabase = vi.fn(async () => liveReadiness());
    for (const changed of [
      {
        DATABASE_URL: `postgres://stavba:${"R".repeat(48)}@postgres:5432/site_logbook`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_migrator:${"R".repeat(48)}@postgres:5432/site_logbook`,
      },
      {
        DATABASE_URL:
          "postgres://site_logbook_runtime@postgres:5432/site_logbook",
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5432/site_logbook?user=stavba`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5432/site_logbook?password=admin-secret`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5432/site_logbook?host=other-postgres`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5432/site_logbook?port=6543`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@other-postgres:5432/site_logbook`,
      },
      {
        DATABASE_URL: `postgres://site_logbook_runtime:${"R".repeat(48)}@postgres:5433/site_logbook`,
      },
    ]) {
      await expect(
        runProductionStartupPreflight({ ...env, ...changed }, SOURCE_SHA, {
          verifyObservedHostRunner: acceptObservedHostRunner,
          verifyDatabase,
        }),
      ).rejects.toThrow(/PRODUCTION_RUNTIME_DATABASE_/);
    }
    expect(verifyDatabase).not.toHaveBeenCalled();
  });

  it("rejects MinIO, cross-region Hetzner and path-style production storage before DB access", async () => {
    const { env } = fixture();
    const verifyDatabase = vi.fn(async () => liveReadiness());
    for (const changed of [
      { S3_ENDPOINT: "http://minio:9000" },
      { S3_ENDPOINT: "https://nbg1.your-objectstorage.com" },
      {
        S3_ENDPOINT: "https://nbg1.your-objectstorage.com",
        S3_REGION: "nbg1",
      },
      { S3_BUCKET: "other-valid-bucket" },
      { S3_FORCE_PATH_STYLE: "true" },
    ]) {
      await expect(
        runProductionStartupPreflight({ ...env, ...changed }, SOURCE_SHA, {
          verifyObservedHostRunner: acceptObservedHostRunner,
          verifyDatabase,
        }),
      ).rejects.toThrow(/PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID/);
    }
    expect(verifyDatabase).not.toHaveBeenCalled();
  });

  it("turns a post-start database swap or schema drift into failed readiness", async () => {
    for (const drift of [
      { databaseName: "swapped_database" },
      { schemaFingerprintSha256: `sha256:${"9".repeat(64)}` },
    ]) {
      const { env } = fixture();
      let call = 0;
      const result = await runProductionStartupPreflight(env, SOURCE_SHA, {
        verifyObservedHostRunner: acceptObservedHostRunner,
        verifyDatabase: async () => {
          call += 1;
          return call === 1
            ? liveReadiness()
            : { ...liveReadiness(), ...drift };
        },
      });
      await expect(result.refreshLiveReadiness()).resolves.toBe(false);
    }
  });

  it("emits a schema-valid health projection without the internal lineage", async () => {
    resetProductionRuntimeBindingForTest();
    const { env } = fixture();
    const result = await runProductionStartupPreflight(env, SOURCE_SHA, {
      verifyObservedHostRunner: acceptObservedHostRunner,
      verifyDatabase: async () => liveReadiness(),
    });
    installProductionRuntimeBinding(
      result.binding,
      result.refreshLiveReadiness,
    );
    const projection = readProductionRuntimeHealthProjection();
    expect(projection).not.toBeNull();
    expect(projection).not.toHaveProperty("lineage");
    expect(
      GetAdminHealthResponse.shape.productionRuntimeBinding.safeParse(
        projection,
      ).success,
    ).toBe(true);
    resetProductionRuntimeBindingForTest();
  });

  it("keeps runtime readiness monotonic from uninstalled through ready to failed", async () => {
    resetProductionRuntimeBindingForTest();
    expect(readProductionRuntimeReadinessState()).toBe("uninstalled");
    expect(failProductionRuntimeReadiness()).toBe(false);
    expect(readProductionRuntimeReadinessState()).toBe("uninstalled");

    const { env } = fixture();
    const result = await runProductionStartupPreflight(env, SOURCE_SHA, {
      verifyObservedHostRunner: acceptObservedHostRunner,
      verifyDatabase: async () => liveReadiness(),
    });
    installProductionRuntimeBinding(
      result.binding,
      result.refreshLiveReadiness,
    );
    expect(readProductionRuntimeReadinessState()).toBe("ready");
    await expect(refreshProductionRuntimeReadiness()).resolves.toBe(true);

    expect(failProductionRuntimeReadiness()).toBe(true);
    expect(failProductionRuntimeReadiness()).toBe(false);
    expect(readProductionRuntimeReadinessState()).toBe("failed");
    await expect(refreshProductionRuntimeReadiness()).resolves.toBe(false);
    expect(() =>
      installProductionRuntimeBinding(
        result.binding,
        result.refreshLiveReadiness,
      ),
    ).toThrow(/PRODUCTION_RUNTIME_BINDING_ALREADY_INSTALLED/);
    resetProductionRuntimeBindingForTest();
  });

  it("keeps real production activation locked until a signed host attestation is supplied", async () => {
    const { input } = fixture();
    const summary = validateProductionAudit0107ReleaseEvidence(input);
    await expect(
      requireObservedProductionHostRunner({
        sourceSha: summary.sourceSha,
        targetEvidenceSha256: summary.targetEvidenceSha256,
        releaseEvidenceSha256: summary.releaseEvidenceSha256,
        activationApprovalSha256: summary.activationApprovalSha256,
        apiImage: summary.apiImage,
        postgresImage: summary.postgresImage,
        deployedConfigSha256: summary.deployedConfigSha256,
        desiredConfigSha256: summary.desiredConfigSha256,
        resolvedComposeSha256: summary.resolvedComposeSha256,
        livePostgresTargetSha256: summary.livePostgresTargetSha256,
        databaseName: summary.databaseName,
        databaseUser: summary.databaseUser,
        schemaFingerprintSha256: summary.schemaFingerprintSha256,
      }),
    ).rejects.toThrow(/PRODUCTION_HOST_ATTESTATION_ENV_MISSING/);
  });
});
