import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION_TAG = "0107_canonical_audit_evidence";
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const migrationSql = read(`lib/db/migrations/${MIGRATION_TAG}.sql`);
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = read(`lib/db/rollbacks/${MIGRATION_TAG}.down.sql`);
const schemaSource = read("lib/db/src/schema/audit-evidence.ts");
const contractSource = read(
  "artifacts/api-server/src/lib/audit-chain-contract.ts",
);
const adapterSource = read(
  "artifacts/api-server/src/lib/audit-chain-db-adapter.ts",
);

describe("R09 canonical audit evidence expand artifacts", () => {
  it("keeps generated 0107 lineage exact while 0100 remains excluded", () => {
    const journal = JSON.parse(
      read("lib/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const migrationFiles = readdirSync(resolve(ROOT, "lib/db/migrations"));
    expect(journal.entries.at(-2)).toMatchObject({
      idx: 106,
      when: 1786459128910,
      tag: "0106_graceful_frog_thor",
    });
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 107,
      when: 1786484628859,
      tag: MIGRATION_TAG,
    });
    expect(migrationFiles).toContain(`${MIGRATION_TAG}.sql`);
    expect(migrationFiles).toContain("meta");
    expect(migrationFiles.some((file) => file.startsWith("0100_"))).toBe(false);
    expect(migrationSql).not.toContain("$1");
  });

  it("binds one immutable event+ledger row, singleton head and durable outbox", () => {
    for (const table of [
      "audit_events",
      "audit_chain_heads",
      "audit_export_outbox",
    ]) {
      expect(schemaSource).toContain(`"${table}"`);
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const constraint of [
      "audit_events_event_binding_chk",
      "audit_events_ledger_binding_chk",
      "audit_chain_heads_state_chk",
      "audit_export_outbox_canonical_binding_chk",
      "audit_export_outbox_terminal_chk",
      "audit_export_outbox_receipt_binding_chk",
    ]) {
      expect(schemaSource).toContain(constraint);
      expect(migrationSql).toContain(constraint);
    }
    for (const trigger of [
      "audit_events_immutable_trg",
      "audit_events_insert_guard_trg",
      "audit_chain_heads_guard_trg",
      "audit_export_outbox_guard_trg",
      "audit_events_commit_binding_trg",
    ]) {
      expect(migrationSql).toContain(trigger);
    }
    expect(migrationSql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migrationSql).toContain("audit_canonical_json");
    expect(migrationSql).toContain("audit_domain_sha256");
    expect(migrationSql).toContain("audit_event_core_semantics_are_valid");
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "audit_events_event_hash_uq"',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "audit_events_ledger_hash_uq"',
    );
    expect(migrationSql).toMatch(/\) IS TRUE/g);
    expect(migrationSql).toContain(
      "audit event or ledger domain-separated digest mismatch",
    );
    expect(migrationSql).toContain(
      "audit event must be the exact successor of the locked singleton head",
    );
    expect(migrationSql).toContain(
      "canonical audit event requires its exact export intent",
    );
    expect(migrationSql).toContain(
      "canonical audit event requires an advanced durable chain head",
    );
    expect(migrationSql).toContain(
      "VALUES ('site-logbook:audit:global:v1', 0, NULL)",
    );
  });

  it("uses one atomic event+ledger repository operation in a caller-owned tx", () => {
    expect(contractSource).toContain("insertEventAndLedger(");
    expect(contractSource).not.toContain("insertEventEnvelope(");
    expect(contractSource).not.toContain("insertLedgerRecord(");
    expect(adapterSource).toContain("createAuditChainDbAdapter(tx: Tx)");
    expect(adapterSource).toContain("canonicalAuditEventJson");
    expect(adapterSource).toContain("canonicalAuditChainRecordJson");
    expect(adapterSource).toContain("canonicalAuditExportIntentJson");
    expect(adapterSource).toContain("verifyAuditEventEnvelope(eventValue)");
    expect(adapterSource).toContain("verifyAuditChainRecord(recordValue)");
    expect(adapterSource).toContain("verifyAuditExportIntent(intentValue)");
    expect(adapterSource).toContain('.for("update")');
    expect(adapterSource).not.toMatch(/db\.transaction\s*\(/);
  });

  it("permits rollback only for the exact unused genesis schema", () => {
    const guardAt = rollbackSql.indexOf("IF EXISTS");
    const firstDropAt = rollbackSql.search(/\bDROP\b/i);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstDropAt).toBeGreaterThan(guardAt);
    expect(rollbackSql).toContain("SELECT 1 FROM audit_events");
    expect(rollbackSql).toContain("SELECT 1 FROM audit_export_outbox");
    expect(rollbackSql).toContain("sequence = 0");
    expect(rollbackSql).toContain("ledger_sha256 IS NULL");
    expect(rollbackSql).toContain(
      "LOCK TABLE audit_chain_heads, audit_events, audit_export_outbox",
    );
    expect(rollbackSql).toContain("pg_advisory_xact_lock(911072468)");
    expect(rollbackSql.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      rollbackSql.indexOf("LOCK TABLE"),
    );
    expect(rollbackSql.indexOf("LOCK TABLE")).toBeLessThan(guardAt);
    expect(rollbackSql).toContain("0107 rollback blocked");
    expect(rollbackSql).toContain("created_at = 1786484628859");
    expect(rollbackSql.match(new RegExp(migrationHash, "g"))).toHaveLength(3);
    expect(rollbackSql).not.toMatch(/\bCASCADE\b/i);
  });
});
