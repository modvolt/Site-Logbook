import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  classifyAuditSchemaAppliedMigrations,
  loadAndValidateAuditSchemaMigrationBundle,
} from "@workspace/db/audit-schema-preflight";
import { rollbackInvoice0108ToExact0107IfPresent } from "./accounting-evidence-migration-helper";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationsDir = resolve(repositoryRoot, "lib/db/migrations");
const rollbackSql = readFileSync(
  resolve(
    repositoryRoot,
    "lib/db/rollbacks/0107_canonical_audit_evidence.down.sql",
  ),
  "utf8",
);

async function freezeDisposableJournalAtCanonical0107(): Promise<void> {
  await rollbackInvoice0108ToExact0107IfPresent(pool);
  const bundle = loadAndValidateAuditSchemaMigrationBundle(migrationsDir);
  expect(bundle.post).toHaveLength(107);
  expect(bundle.post.at(-1)).toEqual(AUDIT_SCHEMA_MIGRATIONS.target);

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    for (const migration of bundle.post) {
      const result = await client.query(
        "update drizzle.__drizzle_migrations set hash = $1 where created_at = $2",
        [migration.hash, migration.when],
      );
      expect(result.rowCount).toBe(1);
    }
    const applied = await client.query<{ created_at: string; hash: string }>(
      "select created_at, hash from drizzle.__drizzle_migrations order by created_at, id",
    );
    const classification = classifyAuditSchemaAppliedMigrations(
      applied.rows,
      bundle,
      "clean",
      [],
    );
    expect(classification).toMatchObject({
      decision: "ALREADY_0107",
      knownAppliedMigrations: 107,
      latestKnownAppliedTag: AUDIT_SCHEMA_MIGRATIONS.target.tag,
      knownAppliedRowsSha256: AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target,
    });
    await client.query("commit");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

describe("R09 unused 0107 rollback", () => {
  it("returns only the exact untouched genesis schema to 0106", async () => {
    // The generic Drizzle test migrator hashes checkout bytes. On Windows that
    // means CRLF identities, while the rollout contract deliberately pins LF.
    // Freeze this disposable journal from the validated bundle before testing
    // the exact rollback contract instead of weakening the rollback guard.
    await freezeDisposableJournalAtCanonical0107();
    await pool.query(rollbackSql);
    const objects = await pool.query<{
      events: string | null;
      heads: string | null;
      outbox: string | null;
    }>(`select
      to_regclass('public.audit_events')::text as events,
      to_regclass('public.audit_chain_heads')::text as heads,
      to_regclass('public.audit_export_outbox')::text as outbox`);
    expect(objects.rows[0]).toEqual({
      events: null,
      heads: null,
      outbox: null,
    });
    const journal = await pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(journal.rows[0]?.count).toBe("106");
  });
});
