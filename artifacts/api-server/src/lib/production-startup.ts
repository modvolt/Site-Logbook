import {
  createProductionRuntimeBinding,
  readProductionEvidenceInput,
  validateProductionAudit0107ReleaseEvidence,
  type ProductionReleaseSummary,
  type ProductionRuntimeBinding,
} from "./production-startup-evidence";
import type { ProductionObservedRunnerBinding } from "./production-evidence-runner";
import { requireProductionHetznerObjectStorageConfiguration } from "./production-object-storage-config";
import {
  PRODUCTION_RUNTIME_DATABASE_USER,
  validateProductionRuntimeDatabaseUrl,
} from "./production-runtime-database";

export interface ProductionAuditDatabaseReadiness {
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  latestKnownAppliedTag: string;
  knownExpectedMigrations: number;
  knownAppliedMigrations: number;
  knownAppliedRowsSha256: string;
  opaqueLegacyRowCount: number;
  opaqueLegacyRowsSha256: string;
  excludedMigration0100Present: boolean;
  externalAuditRowCount: number;
  auditSchemaReady: boolean;
  integrityValid: boolean;
  postMigrationIntegrityValid: boolean;
  trustedAuditGenesis: boolean;
}

export interface ProductionStartupDependencies {
  verifyObservedHostRunner(
    input: ProductionObservedRunnerBinding,
  ): Promise<unknown>;
  verifyDatabase(input: {
    databaseUrl: string;
    migrationsDir: string;
    expectedDatabaseName: string;
    expectedDatabaseUser: string;
    buildSha: string;
    expectedSchemaFingerprintSha256: string;
  }): Promise<ProductionAuditDatabaseReadiness>;
}

export interface ProductionStartupResult {
  binding: ProductionRuntimeBinding;
  refreshLiveReadiness: () => Promise<boolean>;
}

export type ProductionActivationRuntimeDependencies = Pick<
  ProductionStartupDependencies,
  "verifyDatabase"
>;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PRODUCTION_STARTUP_ENV_MISSING: ${key} is required.`);
  }
  return value;
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(
      `PRODUCTION_DATABASE_READINESS_INVALID: ${field} does not match approved evidence.`,
    );
  }
}

async function verifyRuntimeDatabaseAndCreateResult(
  env: NodeJS.ProcessEnv,
  embeddedBuildSha: string,
  release: ProductionReleaseSummary,
  verifyDatabase: ProductionStartupDependencies["verifyDatabase"],
): Promise<ProductionStartupResult> {
  const databaseUrl = required(env, "DATABASE_URL");
  const databaseUrlIdentity = validateProductionRuntimeDatabaseUrl(
    databaseUrl,
    release.databaseName,
  );
  requireEqual(
    databaseUrlIdentity.databaseUser,
    PRODUCTION_RUNTIME_DATABASE_USER,
    "DATABASE_URL databaseUser",
  );
  requireEqual(
    release.databaseUser,
    PRODUCTION_RUNTIME_DATABASE_USER,
    "release databaseUser",
  );
  const readinessInput = {
    databaseUrl,
    migrationsDir: required(env, "MIGRATIONS_DIR"),
    expectedDatabaseName: release.databaseName,
    expectedDatabaseUser: release.databaseUser,
    buildSha: embeddedBuildSha,
    expectedSchemaFingerprintSha256: release.schemaFingerprintSha256,
  };
  const lineage = release.lineage;
  const verifyLiveReadiness = async (): Promise<boolean> => {
    const database = await verifyDatabase(readinessInput);
    requireEqual(database.databaseName, release.databaseName, "databaseName");
    requireEqual(database.databaseUser, release.databaseUser, "databaseUser");
    requireEqual(
      database.schemaFingerprintSha256,
      release.schemaFingerprintSha256,
      "schemaFingerprintSha256",
    );
    for (const field of [
      "latestKnownAppliedTag",
      "knownExpectedMigrations",
      "knownAppliedMigrations",
      "knownAppliedRowsSha256",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
      "excludedMigration0100Present",
    ] as const) {
      requireEqual(database[field], lineage[field], field);
    }
    requireEqual(database.externalAuditRowCount, 0, "externalAuditRowCount");
    requireEqual(database.auditSchemaReady, true, "auditSchemaReady");
    requireEqual(database.integrityValid, true, "integrityValid");
    requireEqual(
      database.postMigrationIntegrityValid,
      true,
      "postMigrationIntegrityValid",
    );
    requireEqual(database.trustedAuditGenesis, true, "trustedAuditGenesis");
    return true;
  };

  await verifyLiveReadiness();
  return Object.freeze({
    binding: createProductionRuntimeBinding(release),
    refreshLiveReadiness: async () => {
      try {
        return await verifyLiveReadiness();
      } catch {
        return false;
      }
    },
  });
}

/**
 * Completes the fresh database gate after the signed v2 activation chain has
 * already been parsed and cross-bound. It deliberately accepts the verifier's
 * in-memory authority, never reconstructed legacy env/B64 artifacts.
 */
export async function runProductionActivationRuntimePreflight(
  env: NodeJS.ProcessEnv,
  embeddedBuildSha: string,
  release: ProductionReleaseSummary,
  dependencies: ProductionActivationRuntimeDependencies,
): Promise<ProductionStartupResult> {
  requireEqual(
    env.EXTERNAL_ACCOUNTS_ENABLED,
    "false",
    "EXTERNAL_ACCOUNTS_ENABLED",
  );
  requireEqual(
    required(env, "BUILD_SHA").toLowerCase(),
    embeddedBuildSha,
    "BUILD_SHA",
  );
  requireEqual(release.sourceSha, embeddedBuildSha, "activation sourceSha");
  requireProductionHetznerObjectStorageConfiguration(env);
  return verifyRuntimeDatabaseAndCreateResult(
    env,
    embeddedBuildSha,
    release,
    dependencies.verifyDatabase,
  );
}

export async function runProductionStartupPreflight(
  env: NodeJS.ProcessEnv,
  embeddedBuildSha: string,
  dependencies: ProductionStartupDependencies,
): Promise<ProductionStartupResult> {
  requireEqual(
    env.EXTERNAL_ACCOUNTS_ENABLED,
    "false",
    "EXTERNAL_ACCOUNTS_ENABLED",
  );
  requireEqual(
    required(env, "BUILD_SHA").toLowerCase(),
    embeddedBuildSha,
    "BUILD_SHA",
  );
  requireProductionHetznerObjectStorageConfiguration(env);

  const evidenceInput = readProductionEvidenceInput(env);
  requireEqual(
    evidenceInput.expectedSourceSha.toLowerCase(),
    embeddedBuildSha,
    "PRODUCTION_EXPECTED_SOURCE_SHA",
  );
  const release = validateProductionAudit0107ReleaseEvidence(evidenceInput);
  await dependencies.verifyObservedHostRunner({
    sourceSha: release.sourceSha,
    targetEvidenceSha256: release.targetEvidenceSha256,
    releaseEvidenceSha256: release.releaseEvidenceSha256,
    activationApprovalSha256: release.activationApprovalSha256,
    apiImage: release.apiImage,
    postgresImage: release.postgresImage,
    deployedConfigSha256: release.deployedConfigSha256,
    desiredConfigSha256: release.desiredConfigSha256,
    resolvedComposeSha256: release.resolvedComposeSha256,
    livePostgresTargetSha256: release.livePostgresTargetSha256,
    databaseName: release.databaseName,
    databaseUser: release.databaseUser,
    schemaFingerprintSha256: release.schemaFingerprintSha256,
  });

  return verifyRuntimeDatabaseAndCreateResult(
    env,
    embeddedBuildSha,
    release,
    dependencies.verifyDatabase,
  );
}
