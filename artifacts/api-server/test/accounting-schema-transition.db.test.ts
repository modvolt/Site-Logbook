import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runAccountingSchemaInventory,
  runAccountingSchemaPreflight,
  runAccountingSchemaSteadyState,
  type AccountingSchemaEnvironment,
  type AccountingSchemaPreflightEnvironment,
} from "@workspace/db/accounting-schema-preflight";
import { runExternalSchemaSteadyState } from "@workspace/db/external-schema-preflight";
import { runMigrations } from "@workspace/db/migrate";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createHistorical0106MigrationsDirectory,
  rollbackAuditEvidence0107ToExact0106,
} from "./accounting-evidence-migration-helper";

const { Pool } = pg;

describe("accounting schema exact 0105 to 0106 transition", () => {
  it("proves exact post, guarded empty rollback, exact pre, one migration and steady state", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required.");
    const parsed = new URL(databaseUrl);
    const currentMigrationsDir = path.resolve(
      import.meta.dirname,
      "../../../lib/db/migrations",
    );
    const historical =
      createHistorical0106MigrationsDirectory(currentMigrationsDir);
    const migrationsDir = historical.directory;
    const rollbackSql = readFileSync(
      path.join(
        currentMigrationsDir,
        "../rollbacks/0106_graceful_frog_thor.down.sql",
      ),
      "utf8",
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await rollbackAuditEvidence0107ToExact0106(pool, currentMigrationsDir);
      const inserted = await pool.query<{
        id: number;
      }>(`INSERT INTO backup_log (
          filename, object_path, size_bytes, status, trigger, created_at, sha256,
          encryption_format, encryption_key_id, restore_tested_at, restore_status,
          restore_duration_ms, restore_verified_tables
        ) VALUES (
          'site-logbook-staging-0105-test.dump.mve1',
          'private/backups/site-logbook-staging-0105-test.dump.mve1',
          8192, 'success', 'manual', CURRENT_TIMESTAMP - INTERVAL '2 minutes',
          '${"c".repeat(64)}', 'mve1', 'test-key-id',
          CURRENT_TIMESTAMP - INTERVAL '1 minute', 'ok', 60000,
          '{"users":0,"jobs":0}'::jsonb
        ) RETURNING id`);
      const backupEvidenceId = inserted.rows[0]?.id;
      if (!backupEvidenceId) throw new Error("Backup evidence insert failed.");

      const common: AccountingSchemaEnvironment = {
        databaseUrl,
        migrationsDir,
        environmentId: "site-logbook-staging",
        expectedDatabaseHost: parsed.hostname,
        expectedDatabaseName: decodeURIComponent(
          parsed.pathname.replace(/^\//, ""),
        ),
        expectedDatabaseUser: decodeURIComponent(parsed.username),
        buildSha: "a".repeat(40),
        backupEvidenceId,
        backupRestoreMaxAgeHours: 24,
      };
      const preflight = (
        mode: "pre" | "post",
      ): AccountingSchemaPreflightEnvironment => ({
        ...common,
        mode,
      });

      const initialPost = await runAccountingSchemaPreflight(preflight("post"));
      expect(initialPost).toMatchObject({
        decision: "ALREADY_0106",
        expectedMigrations: 106,
        latestExpectedTag: "0106_graceful_frog_thor",
        accountingEvidenceRows: 0,
        externalStateRows: 0,
        backupEvidenceId,
      });

      await pool.query(rollbackSql);
      const pre = await runAccountingSchemaPreflight(preflight("pre"));
      expect(pre).toMatchObject({
        decision: "READY_0105",
        expectedMigrations: 106,
        accountingEvidenceRows: 0,
        externalStateRows: 0,
      });
      await expect(runAccountingSchemaInventory(common)).resolves.toMatchObject(
        {
          decision: "READY_0105",
          appliedMigrations: 105,
          predecessorMigrations: 105,
          latestAppliedTag: "0105_smooth_nitro",
        },
      );

      const previousMigrationsDir = process.env.MIGRATIONS_DIR;
      process.env.MIGRATIONS_DIR = migrationsDir;
      const migration = await runMigrations(databaseUrl).finally(() => {
        if (previousMigrationsDir === undefined) {
          delete process.env.MIGRATIONS_DIR;
        } else {
          process.env.MIGRATIONS_DIR = previousMigrationsDir;
        }
      });
      expect(migration).toMatchObject({
        expectedCount: 106,
        appliedBefore: 105,
        appliedAfter: 106,
        newlyApplied: 1,
        latestExpectedTag: "0106_graceful_frog_thor",
      });

      await expect(
        runAccountingSchemaPreflight(preflight("post")),
      ).resolves.toMatchObject({
        decision: "ALREADY_0106",
        accountingEvidenceRows: 0,
        externalStateRows: 0,
      });
      await expect(
        runAccountingSchemaSteadyState(common),
      ).resolves.toMatchObject({
        decision: "ALREADY_0106",
        expectedMigrations: 106,
        accountingEvidenceRows: 0,
        externalStateRows: 0,
      });
      await expect(
        runExternalSchemaSteadyState({
          ...common,
          externalAccountsEnabled: false,
        }),
      ).resolves.toMatchObject({
        decision: "ALREADY_0106",
        expectedMigrations: 106,
        latestExpectedTag: "0106_graceful_frog_thor",
        externalStateRows: 0,
      });
    } finally {
      historical.cleanup();
      await pool.end();
    }
  });
});
