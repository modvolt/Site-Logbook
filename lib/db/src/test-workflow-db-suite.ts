/**
 * Runs the DB-backed workflow tests in a generated temporary database.
 *
 * DATABASE_URL supplies only the isolated PostgreSQL server and credentials.
 * The named database in that URL is never migrated or passed to Vitest.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "./migrate.js";

const { Client } = pg;

const workflowDbTests = [
  "test/job-create-atomic-db.test.ts",
  "test/job-status-db.test.ts",
  "test/quote-job-group-invoice-db.test.ts",
] as const;

function requireSafeEnvironment(): URL {
  if (process.env.WORKFLOW_DB_SUITE_ENABLED !== "true") {
    throw new Error(
      "Refusing to run: set WORKFLOW_DB_SUITE_ENABLED=true explicitly.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run workflow DB tests in NODE_ENV=production.");
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

async function runDbTests(repoRoot: string, testDbUrl: string): Promise<void> {
  const apiDir = path.join(repoRoot, "artifacts", "api-server");
  const vitestEntrypoint = path.join(
    apiDir,
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  const args = [
    vitestEntrypoint,
    "run",
    ...workflowDbTests,
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--testTimeout=30000",
    "--hookTimeout=30000",
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: apiDir,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: testDbUrl,
        SESSION_SECRET: "workflow-db-suite-test-only-session-secret",
        ATOMIC_JOB_DB_TEST_ENABLED: "true",
        JOB_STATUS_DB_TEST_ENABLED: "true",
        BACKUP_ENABLED: "false",
        OPENAI_DOCUMENT_EXTRACTION_ENABLED: "false",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Workflow DB test child failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const sourceUrl = requireSafeEnvironment();
  const suffix = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const testDbName = `test_workflow_suite_${suffix}`;
  const adminUrl = databaseUrl(sourceUrl, "postgres");
  const testDbUrl = databaseUrl(sourceUrl, testDbName);
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  let databaseCreated = false;

  try {
    const adminClient = new Client({ connectionString: adminUrl });
    try {
      await adminClient.connect();
      await adminClient.query(`CREATE DATABASE "${testDbName}"`);
      databaseCreated = true;
      console.log(`[test:workflow-db] Created temporary database ${testDbName}.`);
    } finally {
      await adminClient.end().catch((error) => {
        console.warn("[test:workflow-db] Failed to close create connection:", error);
      });
    }

    const migration = await runMigrations(testDbUrl);
    console.log(
      `[test:workflow-db] Applied ${migration.newlyApplied} migration(s); ` +
        `${migration.appliedAfter}/${migration.expectedCount} present.`,
    );
    if (migration.appliedAfter !== migration.expectedCount) {
      throw new Error("Temporary database is not at migration parity.");
    }

    await runDbTests(repoRoot, testDbUrl);
    console.log("[test:workflow-db] All isolated workflow DB tests passed.");
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
        console.log(`[test:workflow-db] Dropped temporary database ${testDbName}.`);
      } finally {
        await cleanupClient.end().catch((error) => {
          console.warn("[test:workflow-db] Failed to close cleanup connection:", error);
        });
      }
    }
  }
}

main().catch((error) => {
  console.error("[test:workflow-db] Failed:", error);
  process.exit(1);
});
