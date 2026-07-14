/**
 * Destructive migration-cycle test for the workflow migrations 0086-0090.
 *
 * The supplied DATABASE_URL is used only to connect to the `postgres`
 * maintenance database. All migrations, DOWN scripts and assertions run in a
 * newly created database whose name starts with `test_workflow_rollback_`.
 *
 * Usage (local PostgreSQL):
 *   WORKFLOW_ROLLBACK_TEST_ENABLED=true DATABASE_URL=<url> \
 *     pnpm --filter @workspace/db run test:workflow-rollback
 *
 * A remote isolated PostgreSQL additionally requires:
 *   ALLOW_REMOTE_ISOLATED_DB_TEST=true
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "./migrate.js";

const { Client, Pool } = pg;

const workflowMigrations = [
  { tag: "0086_quick_imperial_guard", when: 1783979822106 },
  { tag: "0087_chief_marvel_apes", when: 1783981467968 },
  { tag: "0088_abandoned_wendell_vaughn", when: 1783984064694 },
  { tag: "0089_thin_robin_chapel", when: 1783986815471 },
  { tag: "0090_secret_killmonger", when: 1783988026596 },
] as const;

const downOrder = [...workflowMigrations].reverse();

function requireSafeEnvironment(): URL {
  if (process.env.WORKFLOW_ROLLBACK_TEST_ENABLED !== "true") {
    throw new Error(
      "Refusing to run: set WORKFLOW_ROLLBACK_TEST_ENABLED=true explicitly.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run workflow rollback tests in NODE_ENV=production.");
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error("DATABASE_URL must point to an isolated PostgreSQL server.");
  }

  const url = new URL(rawUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    !localHosts.has(url.hostname) &&
    process.env.ALLOW_REMOTE_ISOLATED_DB_TEST !== "true"
  ) {
    throw new Error(
      "Refusing remote PostgreSQL: set ALLOW_REMOTE_ISOLATED_DB_TEST=true only for an isolated test server.",
    );
  }

  return url;
}

function databaseUrl(base: URL, databaseName: string): string {
  const copy = new URL(base.toString());
  copy.pathname = `/${databaseName}`;
  return copy.toString();
}

async function assertCleanPreflight(
  pool: pg.Pool,
  rollbacksFolder: string,
): Promise<void> {
  const sql = readFileSync(
    path.join(rollbacksFolder, "preflight_0086_0090.sql"),
    "utf8",
  );
  const result = await pool.query<{
    check_name: string;
    blocker_count: string | number;
  }>(sql);
  const blocked = result.rows.filter((row) => Number(row.blocker_count) !== 0);
  if (blocked.length > 0) {
    throw new Error(
      `Fresh rollback preflight unexpectedly found blockers: ${blocked
        .map((row) => `${row.check_name}=${row.blocker_count}`)
        .join(", ")}`,
    );
  }
}

async function assertWorkflowSchema(pool: pg.Pool, present: boolean): Promise<void> {
  const tableResult = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.quote_invoice_links')::text AS table_name",
  );
  const tablePresent = tableResult.rows[0]?.table_name === "quote_invoice_links";
  if (tablePresent !== present) {
    throw new Error(
      `quote_invoice_links presence is ${tablePresent}, expected ${present}.`,
    );
  }

  const expectedColumns = [
    ["jobs", "archived_at"],
    ["jobs", "archived_by_user_id"],
    ["jobs", "status_before_archive"],
    ["materials", "consumed_at"],
    ["materials", "consumed_by_user_id"],
    ["job_visits", "start_time"],
    ["job_visits", "end_time"],
    ["job_visits", "updated_at"],
    ["quotes", "converted_to_job_group_id"],
  ] as const;

  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )`,
    [
      expectedColumns.map(([table]) => table),
      expectedColumns.map(([, column]) => column),
    ],
  );
  const found = new Set(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  for (const [table, column] of expectedColumns) {
    const columnPresent = found.has(`${table}.${column}`);
    if (columnPresent !== present) {
      throw new Error(
        `${table}.${column} presence is ${columnPresent}, expected ${present}.`,
      );
    }
  }
}

async function assertWorkflowJournal(pool: pg.Pool, present: boolean): Promise<void> {
  const result = await pool.query<{ created_at: string | number }>(
    `SELECT created_at
       FROM drizzle.__drizzle_migrations
      WHERE created_at = ANY($1::bigint[])`,
    [workflowMigrations.map((migration) => migration.when)],
  );
  const expectedCount = present ? workflowMigrations.length : 0;
  if (result.rows.length !== expectedCount) {
    throw new Error(
      `Workflow journal contains ${result.rows.length} rows, expected ${expectedCount}.`,
    );
  }
}

async function main(): Promise<void> {
  const sourceUrl = requireSafeEnvironment();
  const suffix = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const testDbName = `test_workflow_rollback_${suffix}`;
  const adminUrl = databaseUrl(sourceUrl, "postgres");
  const testDbUrl = databaseUrl(sourceUrl, testDbName);
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const rollbacksFolder = path.join(migrationsFolder, "..", "rollbacks");
  let databaseCreated = false;

  try {
    const adminClient = new Client({ connectionString: adminUrl });
    try {
      await adminClient.connect();
      await adminClient.query(`CREATE DATABASE "${testDbName}"`);
      databaseCreated = true;
      console.log(`[test:workflow-rollback] Created temporary database ${testDbName}.`);
    } finally {
      await adminClient.end().catch((error) => {
        console.warn(
          "[test:workflow-rollback] Failed to close create connection:",
          error,
        );
      });
    }

    const firstForward = await runMigrations(testDbUrl);
    console.log(
      `[test:workflow-rollback] Forward migration applied ${firstForward.newlyApplied} migration(s).`,
    );

    const pool = new Pool({ connectionString: testDbUrl });
    try {
      await assertWorkflowSchema(pool, true);
      await assertWorkflowJournal(pool, true);
      await assertCleanPreflight(pool, rollbacksFolder);

      for (const migration of downOrder) {
        const sql = readFileSync(
          path.join(rollbacksFolder, `${migration.tag}.down.sql`),
          "utf8",
        );
        await pool.query(sql);
        console.log(`[test:workflow-rollback] Applied DOWN ${migration.tag}.`);
      }

      await assertWorkflowSchema(pool, false);
      await assertWorkflowJournal(pool, false);
    } finally {
      await pool.end();
    }

    const secondForward = await runMigrations(testDbUrl);
    if (secondForward.newlyApplied !== workflowMigrations.length) {
      throw new Error(
        `Forward-after-DOWN applied ${secondForward.newlyApplied} migrations, expected ${workflowMigrations.length}.`,
      );
    }

    const verificationPool = new Pool({ connectionString: testDbUrl });
    try {
      await assertWorkflowSchema(verificationPool, true);
      await assertWorkflowJournal(verificationPool, true);
      await assertCleanPreflight(verificationPool, rollbacksFolder);
    } finally {
      await verificationPool.end();
    }

    const idempotentRun = await runMigrations(testDbUrl);
    if (idempotentRun.newlyApplied !== 0) {
      throw new Error(
        `Idempotent migration run applied ${idempotentRun.newlyApplied} unexpected migration(s).`,
      );
    }

    console.log("[test:workflow-rollback] Forward/DOWN/forward cycle passed.");
  } finally {
    if (databaseCreated) {
      const cleanupClient = new Client({ connectionString: adminUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [testDbName],
        );
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
        console.log(`[test:workflow-rollback] Dropped temporary database ${testDbName}.`);
      } finally {
        await cleanupClient.end().catch((error) => {
          console.warn(
            "[test:workflow-rollback] Failed to close cleanup connection:",
            error,
          );
        });
      }
    }
  }
}

main().catch((error) => {
  console.error("[test:workflow-rollback] Failed:", error);
  process.exit(1);
});
