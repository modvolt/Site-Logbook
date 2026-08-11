import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Pool } from "pg";

const AUDIT_0107_ROLLBACK = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../lib/db/rollbacks/0107_canonical_audit_evidence.down.sql",
  ),
  "utf8",
);

const EXPECTED_TABLES = [
  "accounting_aggregate_heads",
  "accounting_document_versions",
  "accounting_export_outbox",
  "accounting_lifecycle_events",
  "accounting_payment_events",
  "accounting_reason_artifacts",
  "accounting_version_relations",
  "accounting_warehouse_price_observations",
  "accounting_warehouse_price_projection_heads",
] as const;

const EXPECTED_TRIGGERS = [
  "accounting_aggregate_heads_guard_trg",
  "accounting_document_versions_immutable_trg",
  "accounting_export_outbox_guard_trg",
  "accounting_lifecycle_events_binding_trg",
  "accounting_lifecycle_events_immutable_trg",
  "accounting_payment_events_binding_trg",
  "accounting_payment_events_immutable_trg",
  "accounting_reason_artifacts_binding_trg",
  "accounting_reason_artifacts_immutable_trg",
  "accounting_version_relations_immutable_trg",
  "accounting_warehouse_price_observations_binding_trg",
  "accounting_warehouse_price_observations_immutable_trg",
  "accounting_warehouse_price_projection_heads_guard_trg",
] as const;

const EXPECTED_FUNCTIONS = [
  "deny_accounting_evidence_mutation",
  "guard_accounting_aggregate_head_transition",
  "guard_accounting_evidence_insert_binding",
  "guard_accounting_outbox_transition",
  "guard_accounting_warehouse_price_projection_head",
] as const;

export async function assertAccountingEvidenceMigrationInstalled(
  pool: Pool,
): Promise<void> {
  const result = await pool.query<{
    tables: string[];
    triggers: string[];
    functions: string[];
  }>(`
    select
      array(
        select tablename::text
        from pg_tables
        where schemaname = 'public' and tablename like 'accounting_%'
        order by tablename
      ) as tables,
      array(
        select trigger_name::text
        from information_schema.triggers
        where trigger_schema = 'public' and event_object_table like 'accounting_%'
        group by trigger_name
        order by trigger_name
      ) as triggers,
      array(
        select distinct routine_name::text
        from information_schema.routines
        where routine_schema = 'public'
          and routine_name in (
            'deny_accounting_evidence_mutation',
            'guard_accounting_aggregate_head_transition',
            'guard_accounting_evidence_insert_binding',
            'guard_accounting_outbox_transition',
            'guard_accounting_warehouse_price_projection_head'
          )
        order by routine_name
      ) as functions
  `);
  const installed = result.rows[0];
  if (
    !installed ||
    JSON.stringify(installed.tables) !== JSON.stringify(EXPECTED_TABLES) ||
    JSON.stringify(installed.triggers) !== JSON.stringify(EXPECTED_TRIGGERS) ||
    JSON.stringify(installed.functions) !== JSON.stringify(EXPECTED_FUNCTIONS)
  ) {
    throw new Error(
      `R13 accounting evidence migration is incomplete: ${JSON.stringify(installed)}`,
    );
  }
}

export async function rollbackAuditEvidence0107ToExact0106(
  pool: Pool,
  migrationsDir = resolve(import.meta.dirname, "../../../lib/db/migrations"),
): Promise<void> {
  await pool.query(AUDIT_0107_ROLLBACK);
  await canonicalizeAppliedMigrationHashesForTest(pool, migrationsDir, 106);
  const expected = readExpectedMigrationTuples(migrationsDir, 106);
  const result = await pool.query<{
    created_at: string | null;
    hash: string;
  }>(`
    select created_at::text, hash::text
    from drizzle.__drizzle_migrations
    order by id
  `);
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new Error(
      `Failed to prepare exact 0106 test state: ${JSON.stringify(result.rows)}`,
    );
  }
}

export function createHistorical0106MigrationsDirectory(
  sourceDirectory: string,
): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(
    join(tmpdir(), "site-logbook-migrations-0106-"),
  );
  cpSync(sourceDirectory, directory, { recursive: true });
  const journalPath = join(directory, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 106);
  if (
    journal.entries.length !== 106 ||
    journal.entries.at(-1)?.tag !== "0106_graceful_frog_thor"
  ) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(
      "Failed to build an exact historical 0106 journal fixture.",
    );
  }
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  for (const name of readdirSync(directory)) {
    if (
      name.endsWith(".sql") &&
      !journal.entries.some((entry) => `${entry.tag}.sql` === name)
    ) {
      unlinkSync(join(directory, name));
      continue;
    }
    if (name.endsWith(".sql")) {
      const path = join(directory, name);
      writeFileSync(path, canonicalLf(readFileSync(path, "utf8")), "utf8");
    }
  }
  for (const snapshot of ["0105_snapshot.json", "0106_snapshot.json"]) {
    const path = join(directory, "meta", snapshot);
    writeFileSync(path, canonicalLf(readFileSync(path, "utf8")), "utf8");
  }
  const futureSnapshot = join(directory, "meta", "0107_snapshot.json");
  unlinkSync(futureSnapshot);
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function canonicalizeAppliedMigrationHashesForTest(
  pool: Pool,
  migrationsDir: string,
  expectedCount: number,
): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const expected = journal.entries.filter(
    (entry) => entry.idx <= expectedCount,
  );
  if (expected.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} migration fixtures.`);
  }
  for (const entry of expected) {
    const raw = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    const rawHash = sha256(raw);
    const canonicalHash = sha256(canonicalLf(raw));
    if (rawHash !== canonicalHash) {
      await pool.query(
        `update drizzle.__drizzle_migrations
           set hash = $1
         where created_at = $2
           and hash = $3`,
        [canonicalHash, entry.when, rawHash],
      );
    }
  }
}

function readExpectedMigrationTuples(
  migrationsDir: string,
  expectedCount: number,
): Array<{ created_at: string; hash: string }> {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const expected = journal.entries.filter(
    (entry) => entry.idx <= expectedCount,
  );
  if (expected.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} migration fixtures.`);
  }
  return expected.map((entry) => ({
    created_at: String(entry.when),
    hash: sha256(
      canonicalLf(
        readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"),
      ),
    ),
  }));
}

function canonicalLf(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
