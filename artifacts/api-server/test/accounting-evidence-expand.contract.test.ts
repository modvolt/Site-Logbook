import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sqlTemplate = readFileSync(
  resolve(ROOT, "docs/audit/17-f-r13-accounting-evidence-expand.template.sql"),
  "utf8",
);
const MIGRATION_TAG = "0106_graceful_frog_thor";
const migrationSql = readFileSync(
  resolve(ROOT, `lib/db/migrations/${MIGRATION_TAG}.sql`),
  "utf8",
);
const rollbackSql = readFileSync(
  resolve(ROOT, `lib/db/rollbacks/${MIGRATION_TAG}.down.sql`),
  "utf8",
);
const TRIGGER_TAIL_MARKER =
  "CREATE OR REPLACE FUNCTION deny_accounting_evidence_mutation()";
const schemaSource = readFileSync(
  resolve(ROOT, "lib/db/src/schema/accounting-evidence.ts"),
  "utf8",
);
const adapterSource = readFileSync(
  resolve(
    ROOT,
    "artifacts/api-server/src/lib/accounting-persistence-db-adapter.ts",
  ),
  "utf8",
);
const archiveStoreSource = readFileSync(
  resolve(ROOT, "artifacts/api-server/src/lib/accounting-archive-db-store.ts"),
  "utf8",
);

const TABLES = [
  "accounting_document_versions",
  "accounting_lifecycle_events",
  "accounting_reason_artifacts",
  "accounting_warehouse_price_observations",
  "accounting_warehouse_price_projection_heads",
  "accounting_payment_events",
  "accounting_version_relations",
  "accounting_export_outbox",
  "accounting_aggregate_heads",
] as const;

describe("R13 accounting evidence expand artifacts", () => {
  it("keeps the numbered migration, audited trigger tail and Drizzle schema in exact parity", () => {
    for (const table of TABLES) {
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
      expect(schemaSource).toContain(`"${table}"`);
    }
    expect(sqlTemplate).toContain("intentionally not a numbered");
    expect(sqlTemplate).toContain("Migration 0100 remains excluded");
    const migrationFiles = readdirSync(resolve(ROOT, "lib/db/migrations"));
    expect(migrationFiles).toContain(`${MIGRATION_TAG}.sql`);
    expect(migrationFiles.some((file) => file.startsWith("0100_"))).toBe(false);
    expect(
      migrationSql.slice(migrationSql.indexOf(TRIGGER_TAIL_MARKER)).trim(),
    ).toBe(sqlTemplate.slice(sqlTemplate.indexOf(TRIGGER_TAIL_MARKER)).trim());
    expect(rollbackSql).toContain(
      "0106 rollback blocked: a later migration or accounting evidence exists; use roll-forward recovery",
    );
    expect(rollbackSql).toContain("pg_advisory_xact_lock(911072468)");
    expect(rollbackSql).toContain(
      "LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE",
    );
    expect(rollbackSql).toContain("later.id > exact_migration_id");
    expect(rollbackSql).toContain("later.created_at >= 1786459128910");
    expect(rollbackSql).toContain(
      "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
    );
    for (const table of TABLES) {
      expect(rollbackSql).toContain(`DROP TABLE ${table};`);
    }
  });

  it("requires immutable evidence, root binding, exact CAS and guarded outbox transitions", () => {
    for (const trigger of [
      "accounting_document_versions_immutable_trg",
      "accounting_lifecycle_events_immutable_trg",
      "accounting_reason_artifacts_immutable_trg",
      "accounting_reason_artifacts_binding_trg",
      "accounting_payment_events_immutable_trg",
      "accounting_version_relations_immutable_trg",
      "accounting_warehouse_price_observations_immutable_trg",
      "accounting_warehouse_price_projection_heads_guard_trg",
      "accounting_export_outbox_guard_trg",
      "accounting_aggregate_heads_guard_trg",
    ]) {
      expect(migrationSql).toContain(trigger);
    }
    expect(migrationSql).toContain(
      "accounting aggregate head must advance the same root by exactly one revision",
    );
    expect(migrationSql).toContain(
      "lifecycle event root does not match its document version",
    );
    expect(migrationSql).toContain(
      "payment correction must reference an earlier event from the same invoice",
    );
    expect(migrationSql).toContain(
      "accounting export intent evidence is immutable",
    );
    expect(migrationSql).toContain(
      "first warehouse-price observation cannot be a withdrawal",
    );
    expect(migrationSql).toContain(
      "observed warehouse price must supersede the previous item head",
    );
    expect(migrationSql).not.toContain(
      "first warehouse-price observation must be observed",
    );
    expect(migrationSql).toContain(
      "terminal accounting export outbox rows are immutable",
    );
    expect(migrationSql).toContain(
      "accounting export claim must increment attempt count exactly once",
    );
    for (const constraint of [
      "accounting_document_versions_canonical_binding_chk",
      "accounting_lifecycle_events_canonical_binding_chk",
      "accounting_reason_artifacts_canonical_shape_chk",
      "accounting_reason_artifacts_canonical_binding_chk",
      "accounting_payment_events_canonical_binding_chk",
      "accounting_version_relations_canonical_binding_chk",
      "accounting_export_outbox_canonical_binding_chk",
      "accounting_export_outbox_receipt_binding_chk",
      "accounting_export_outbox_failure_category_chk",
      "accounting_warehouse_price_canonical_shape_chk",
      "accounting_warehouse_price_canonical_binding_chk",
      "accounting_warehouse_price_legacy_semantics_chk",
      "accounting_warehouse_price_projection_canonical_shape_chk",
      "accounting_warehouse_price_projection_canonical_binding_chk",
    ]) {
      expect(migrationSql).toContain(constraint);
      expect(schemaSource).toContain(constraint);
    }
    for (const receiptColumn of [
      "manifest_object_key",
      "manifest_version_id",
      "manifest_sha256",
      "bundle_sha256",
      "checksum_sha256",
    ]) {
      expect(migrationSql).toContain(`\"${receiptColumn}\"`);
      expect(schemaSource).toContain(`\"${receiptColumn}\"`);
    }
  });

  it("keeps the adapter transaction-owned and binds every canonical evidence write", () => {
    expect(adapterSource).toMatch(
      /createAccountingPersistenceDbAdapter\(\s*tx: Tx,?\s*\)/,
    );
    expect(adapterSource).not.toMatch(/db\.transaction\s*\(/);
    for (const marker of [
      "canonicalAccountingDocumentVersionJson",
      "canonicalAccountingLifecycleEntryJson",
      "canonicalAccountingExportIntentJson",
      "canonicalAccountingWarehousePriceObservationJson",
      "canonicalAccountingWarehousePriceProjectionHeadJson",
      "canonicalAccountingReasonArtifactJson",
      "loadReasonArtifactById",
      "insertReasonArtifact",
      "lockWarehousePriceStreamForUpdate",
      "lockAndLoadWarehousePriceObservationStreamForProjection",
      "compareAndAdvanceWarehousePriceProjectionHead",
      "loadExportIntentById",
      "compareAndAdvanceAggregateState",
      '.for("update")',
    ]) {
      expect(adapterSource).toContain(marker);
    }
  });

  it("claims archive work with SKIP LOCKED and CAS-binds a full immutable receipt", () => {
    expect(archiveStoreSource).toContain("for update skip locked");
    expect(archiveStoreSource).toContain(
      "attempt_count = outbox.attempt_count + 1",
    );
    expect(archiveStoreSource).toContain(
      'eq(accountingExportOutboxTable.state, "exporting")',
    );
    expect(archiveStoreSource).toContain(
      "gt(accountingExportOutboxTable.leaseExpiresAt, input.exportedAt)",
    );
    expect(archiveStoreSource).toContain(
      "accountingWarehousePriceObservationsTable.canonicalJson",
    );
    expect(archiveStoreSource).toContain(
      "accountingReasonArtifactsTable.canonicalJson",
    );
    expect(
      archiveStoreSource.match(
        /gt\(\s*accountingExportOutboxTable\.leaseExpiresAt,/g,
      ),
    ).toHaveLength(2);
    for (const receiptField of [
      "manifestObjectKey",
      "manifestVersionId",
      "manifestSha256",
      "bundleSha256",
      "checksumSha256",
    ]) {
      expect(archiveStoreSource).toContain(receiptField);
    }
  });
});
