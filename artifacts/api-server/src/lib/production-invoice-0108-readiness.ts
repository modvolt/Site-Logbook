import { verifyProductionInvoice0108SchemaReadiness } from "@workspace/db/invoice-0108-schema-preflight";

import type { ProductionAuditDatabaseReadiness } from "./production-startup";

export async function verifyLiveProductionInvoice0108Readiness(input: {
  databaseUrl: string;
  migrationsDir: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: string;
  buildSha: string;
  expectedSchemaFingerprintSha256: string;
}): Promise<ProductionAuditDatabaseReadiness> {
  const summary = await verifyProductionInvoice0108SchemaReadiness({
    ...input,
    expectedSchemaFingerprintSha256:
      input.expectedSchemaFingerprintSha256 as `sha256:${string}`,
  });
  return {
    databaseName: summary.databaseName,
    databaseUser: summary.databaseUser,
    schemaFingerprintSha256: summary.schemaFingerprintSha256,
    invoiceSchemaProjectionSha256: summary.invoiceSchemaProjectionSha256,
    latestKnownAppliedTag: summary.latestKnownAppliedTag,
    knownExpectedMigrations: summary.knownExpectedMigrations,
    knownAppliedMigrations: summary.knownAppliedMigrations,
    knownAppliedRowsSha256: summary.knownAppliedRowsSha256,
    opaqueLegacyRowCount: summary.opaqueLegacyRowCount,
    opaqueLegacyRowsSha256: summary.opaqueLegacyRowsSha256,
    excludedMigration0100Present: summary.excludedMigration0100Present,
    externalAuditRowCount: summary.externalAuditRowCount,
    auditSchemaReady: summary.auditSchemaReady,
    integrityValid: summary.integrityValid,
    postMigrationIntegrityValid: summary.postMigrationIntegrityValid,
    trustedAuditGenesis: summary.trustedAuditGenesis,
    invoice0108Ready: true,
    roleDeltaReady: summary.roleDeltaReady,
  };
}
