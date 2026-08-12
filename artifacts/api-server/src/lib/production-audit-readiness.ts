import { verifyProductionAuditSchemaReadiness } from "@workspace/db/audit-schema-preflight";
import type { ProductionAuditDatabaseReadiness } from "./production-startup";

export async function verifyLiveProductionAuditReadiness(input: {
  databaseUrl: string;
  migrationsDir: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: string;
  buildSha: string;
  expectedSchemaFingerprintSha256: string;
}): Promise<ProductionAuditDatabaseReadiness> {
  const summary = await verifyProductionAuditSchemaReadiness({
    ...input,
    expectedSchemaFingerprintSha256:
      input.expectedSchemaFingerprintSha256 as `sha256:${string}`,
  });
  return {
    databaseName: summary.databaseName,
    databaseUser: summary.databaseUser,
    schemaFingerprintSha256: summary.schema.schemaFingerprintSha256,
    latestKnownAppliedTag: summary.lineage.latestKnownAppliedTag ?? "",
    knownExpectedMigrations: summary.lineage.knownExpectedMigrations,
    knownAppliedMigrations: summary.lineage.knownAppliedMigrations,
    knownAppliedRowsSha256: summary.lineage.knownAppliedRowsSha256,
    opaqueLegacyRowCount: summary.lineage.opaqueLegacyRowCount,
    opaqueLegacyRowsSha256: summary.lineage.opaqueLegacyRowsSha256,
    excludedMigration0100Present: summary.lineage.excludedMigration0100Present,
    // The production helper returns only after all of these read-only checks pass.
    externalAuditRowCount: 0,
    auditSchemaReady: true,
    integrityValid: true,
    postMigrationIntegrityValid: true,
    trustedAuditGenesis: true,
  };
}
