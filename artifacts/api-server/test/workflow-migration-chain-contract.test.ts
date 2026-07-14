import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const migrations = [
  {
    index: 86,
    tag: "0086_quick_imperial_guard",
    when: 1783979822106,
    blocker: "archived_at",
  },
  {
    index: 87,
    tag: "0087_chief_marvel_apes",
    when: 1783981467968,
    blocker: '"done" = false',
  },
  {
    index: 88,
    tag: "0088_abandoned_wendell_vaughn",
    when: 1783984064694,
    blocker: '"start_time" IS NOT NULL OR "end_time" IS NOT NULL',
  },
  {
    index: 89,
    tag: "0089_thin_robin_chapel",
    when: 1783986815471,
    blocker: '"converted_to_job_group_id" IS NOT NULL',
  },
  {
    index: 90,
    tag: "0090_secret_killmonger",
    when: 1783988026596,
    blocker: 'SELECT 1 FROM "quote_invoice_links"',
  },
] as const;

describe("workflow migration and rollback chain", () => {
  it("keeps journal entries, snapshots and files in strict forward order", () => {
    const journal = JSON.parse(
      read("lib/db/migrations/meta/_journal.json"),
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    for (const migration of migrations) {
      expect(
        journal.entries.find((entry) => entry.idx === migration.index),
      ).toMatchObject({
        idx: migration.index,
        when: migration.when,
        tag: migration.tag,
      });
      expect(() =>
        read(`lib/db/migrations/${migration.tag}.sql`),
      ).not.toThrow();
      expect(() =>
        read(`lib/db/migrations/meta/00${migration.index}_snapshot.json`),
      ).not.toThrow();
    }
    expect(migrations.map((migration) => migration.index)).toEqual([
      86, 87, 88, 89, 90,
    ]);
  });

  it("allows only the documented legacy-material backfill to mutate rows", () => {
    for (const migration of migrations) {
      const sql = read(`lib/db/migrations/${migration.tag}.sql`);
      const dml = sql.match(/^\s*(?:UPDATE|DELETE|INSERT)\s+/gim) ?? [];
      if (migration.index === 87) {
        expect(dml).toHaveLength(1);
        expect(sql).toContain('UPDATE "materials"');
        expect(sql).toContain('WHERE "done" = false OR "consumed_at" IS NULL');
      } else {
        expect(dml).toHaveLength(0);
      }
    }
  });

  it("guards every destructive rollback before dropping schema", () => {
    for (const migration of migrations) {
      const sql = read(`lib/db/rollbacks/${migration.tag}.down.sql`);
      const guardAt = sql.indexOf("IF EXISTS");
      const firstDropAt = sql.search(/\b(?:DROP|ALTER\s+TABLE.+DROP)\b/i);
      expect(sql).toContain("BEGIN;");
      expect(sql).toContain("COMMIT;");
      expect(sql).toContain(`Rollback 00${migration.index} blocked`);
      expect(sql).toContain(migration.blocker);
      expect(sql).toContain("DELETE FROM drizzle.__drizzle_migrations");
      expect(sql).toContain(`created_at = ${migration.when}`);
      expect(guardAt).toBeGreaterThan(0);
      expect(firstDropAt).toBeGreaterThan(guardAt);
      expect(sql).not.toMatch(/\bCASCADE\b/i);
    }
  });

  it("provides a read-only preflight covering every rollback blocker", () => {
    const sql = read("lib/db/rollbacks/preflight_0086_0090.sql");
    expect(sql).toContain("migration_journal_missing");
    expect(sql).toContain("0090_quote_invoice_history");
    expect(sql).toContain("0089_quote_group_links");
    expect(sql).toContain("0088_visit_specific_times");
    expect(sql).toContain("0087_planned_materials");
    expect(sql).toContain("0087_nonlegacy_consumption_audit");
    expect(sql).toContain("0086_archived_jobs");
    expect(sql).not.toMatch(/^\s*(?:UPDATE|DELETE|INSERT|DROP|ALTER)\s+/gim);
  });

  it("protects all archive and non-legacy consumption audit metadata", () => {
    const archiveRollback = read(
      "lib/db/rollbacks/0086_quick_imperial_guard.down.sql",
    );
    expect(archiveRollback).toContain('"archived_at" IS NOT NULL');
    expect(archiveRollback).toContain('"archived_by_user_id" IS NOT NULL');
    expect(archiveRollback).toContain('"status_before_archive" IS NOT NULL');

    const materialRollback = read(
      "lib/db/rollbacks/0087_chief_marvel_apes.down.sql",
    );
    expect(materialRollback).toContain('"consumed_by_user_id" IS NOT NULL');
    expect(materialRollback).toContain(
      '"consumed_at" IS DISTINCT FROM "created_at"',
    );
    expect(materialRollback).toContain(
      "Rollback 0087 blocked: non-legacy consumption audit exists",
    );
  });

  it("documents reverse-only database rollback and application-first recovery", () => {
    const runbook = read(
      "docs/implementation-stages/09-deployment-rollback-runbook.md",
    );
    expect(runbook).toContain("0090 -> 0089 -> 0088 -> 0087 -> 0086");
    expect(runbook).toContain("Aplikacni rollback");
    expect(runbook).toContain("preflight_0086_0090.sql");
    expect(runbook).toContain("Nikdy automaticky neopravovat");
    expect(runbook).toContain("izolovane PostgreSQL");
  });

  it("provides an opt-in isolated forward/down/forward integration test", () => {
    const runner = read("lib/db/src/test-workflow-rollback.ts");
    const packageJson = JSON.parse(read("lib/db/package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:workflow-rollback"]).toContain(
      "test-workflow-rollback.ts",
    );
    expect(runner).toContain('WORKFLOW_ROLLBACK_TEST_ENABLED !== "true"');
    expect(runner).toContain('process.env.NODE_ENV === "production"');
    expect(runner).toContain('ALLOW_REMOTE_ISOLATED_DB_TEST !== "true"');
    expect(runner).toContain("test_workflow_rollback_");
    expect(runner).toContain("const downOrder = [...workflowMigrations].reverse()");
    expect(runner.match(/runMigrations\(testDbUrl\)/g)).toHaveLength(3);
    expect(runner).not.toContain("runMigrations(sourceUrl");
    expect(runner).toContain('DROP DATABASE IF EXISTS "${testDbName}"');
    expect(runner).toContain("assertCleanPreflight");
    expect(runner).toContain("assertWorkflowSchema(pool, false)");
    expect(runner).toContain("secondForward.newlyApplied !== workflowMigrations.length");
    expect(runner).toContain("idempotentRun.newlyApplied !== 0");
    const guardAt = runner.indexOf("let databaseCreated = false");
    expect(runner.indexOf("try {", guardAt)).toBeLessThan(
      runner.indexOf("const adminClient", guardAt),
    );
    expect(runner).toContain("Failed to close create connection");
    expect(runner).toContain("Failed to close cleanup connection");
  });
});
