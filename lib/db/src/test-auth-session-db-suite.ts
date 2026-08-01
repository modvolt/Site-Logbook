/**
 * Runs the isolated authorization DB proofs in a generated temporary database.
 * TEST_DATABASE_URL supplies only an explicitly enabled local PostgreSQL server.
 * The named source database is never migrated or passed to Vitest.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "./migrate.js";

const { Client, Pool } = pg;
const SESSION_MIGRATION_WHEN = 1785604750584;

function requireSafeEnvironment(): URL {
  if (process.env.AUTH_DB_SUITE_ENABLED !== "true") {
    throw new Error("Refusing to run: set AUTH_DB_SUITE_ENABLED=true explicitly.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run auth DB tests in NODE_ENV=production.");
  }
  if (process.env.DATABASE_URL) {
    throw new Error("Refusing ambient DATABASE_URL; use TEST_DATABASE_URL only.");
  }

  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) {
    throw new Error("TEST_DATABASE_URL must point to an isolated local PostgreSQL server.");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)) {
    throw new Error("Refusing non-loopback PostgreSQL for auth DB tests.");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL database name must contain a separate test or ci segment.");
  }
  return url;
}

function databaseUrl(base: URL, databaseName: string): string {
  const copy = new URL(base.toString());
  copy.pathname = `/${databaseName}`;
  return copy.toString();
}

async function assertColumn(pool: pg.Pool, expected: boolean): Promise<void> {
  const result = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'session_generation'
        AND is_nullable = 'NO'
        AND column_default = '1'
    ) AS present
  `);
  if (result.rows[0]?.present !== expected) {
    throw new Error(`session_generation column presence was ${String(result.rows[0]?.present)}, expected ${expected}.`);
  }
}

async function runAuthorizationTests(repoRoot: string, testDbUrl: string): Promise<void> {
  const apiDir = path.join(repoRoot, "artifacts", "api-server");
  const vitestEntrypoint = path.join(apiDir, "node_modules", "vitest", "vitest.mjs");
  const testFiles = [
    "test/auth-session-generation.db.test.ts",
    "test/vault-authorization.db.test.ts",
  ];

  for (const testFile of testFiles) {
    const args = [
      vitestEntrypoint,
      "run",
      testFile,
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--testTimeout=30000",
      "--hookTimeout=30000",
    ];
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      CI: process.env.CI,
      NODE_ENV: "test",
      DATABASE_URL: testDbUrl,
      SESSION_SECRET: "isolated-auth-db-suite-secret-not-for-production",
      BACKUP_TRIGGER_SECRET: "isolated-backup-trigger-secret-not-for-production",
      AUTH_DB_TEST_ENABLED: "true",
      AUTHORIZATION_DB_TEST_ENABLED: "true",
      BACKUP_ENABLED: "false",
      OPENAI_DOCUMENT_EXTRACTION_ENABLED: "false",
    };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: apiDir,
        stdio: "inherit",
        windowsHide: true,
        env: childEnv,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Authorization DB test child failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
      });
    });
  }
}

async function main(): Promise<void> {
  const sourceUrl = requireSafeEnvironment();
  const suffix = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const testDbName = `test_auth_session_${suffix}`;
  const adminUrl = databaseUrl(sourceUrl, "postgres");
  const testDbUrl = databaseUrl(sourceUrl, testDbName);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const migrationsFolder = path.join(repoRoot, "lib", "db", "migrations");
  const rollbackSql = readFileSync(
    path.join(repoRoot, "lib", "db", "rollbacks", "0096_daffy_puppet_master.down.sql"),
    "utf8",
  );
  let databaseCreated = false;

  try {
    const adminClient = new Client({ connectionString: adminUrl });
    try {
      await adminClient.connect();
      await adminClient.query(`CREATE DATABASE "${testDbName}"`);
      databaseCreated = true;
      console.log(`[test:auth-db] Created temporary database ${testDbName}.`);
    } finally {
      await adminClient.end();
    }

    const firstMigration = await runMigrations(testDbUrl);
    if (firstMigration.appliedAfter !== firstMigration.expectedCount) {
      throw new Error("Temporary auth database is not at migration parity.");
    }

    const verificationPool = new Pool({ connectionString: testDbUrl });
    try {
      await assertColumn(verificationPool, true);
      await verificationPool.query(rollbackSql);
      await assertColumn(verificationPool, false);
      const journal = await verificationPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [SESSION_MIGRATION_WHEN],
      );
      if (journal.rows[0]?.count !== "0") throw new Error("Rollback left migration 0096 stamped.");
    } finally {
      await verificationPool.end();
    }

    const forwardFix = await runMigrations(testDbUrl);
    if (forwardFix.newlyApplied !== 1) {
      throw new Error(`Expected one forward-fix migration, applied ${forwardFix.newlyApplied}.`);
    }
    const forwardPool = new Pool({ connectionString: testDbUrl });
    try {
      await assertColumn(forwardPool, true);
    } finally {
      await forwardPool.end();
    }
    console.log("[test:auth-db] Migration forward/down/forward cycle passed.");

    await runAuthorizationTests(repoRoot, testDbUrl);
    console.log("[test:auth-db] All isolated authorization DB tests passed.");

    const rollbackGuardPool = new Pool({ connectionString: testDbUrl });
    try {
      let blocked = false;
      try {
        await rollbackGuardPool.query(rollbackSql);
      } catch (error) {
        blocked = String(error).includes("session generations have already advanced");
        await rollbackGuardPool.query("ROLLBACK").catch(() => undefined);
      }
      if (!blocked) {
        throw new Error("Rollback 0096 was not blocked after a session generation advanced.");
      }
      await assertColumn(rollbackGuardPool, true);
    } finally {
      await rollbackGuardPool.end();
    }
    console.log("[test:auth-db] Used-generation rollback guard passed.");
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
        console.log(`[test:auth-db] Dropped temporary database ${testDbName}.`);
      } finally {
        await cleanupClient.end();
      }
    }
  }
}

main().catch((error) => {
  console.error("[test:auth-db] Failed:", error);
  process.exit(1);
});
