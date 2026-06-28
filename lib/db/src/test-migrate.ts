/**
 * CI-style migration smoke test.
 *
 * Creates a fresh temporary Postgres database, applies every committed
 * migration via runMigrations(), then asserts that every table and column
 * declared in the latest Drizzle snapshot actually exists in the live DB.
 *
 * Journal integrity violations (duplicate idx or duplicate when) and snapshot
 * parity failures are treated as hard errors so this test fails fast.
 *
 * Usage:
 *   DATABASE_URL=<url> pnpm --filter @workspace/db run test:migrate
 */

import pg from "pg";
import { runMigrations, MigrationParityError } from "./migrate.js";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Client, Pool } = pg;

// ---------------------------------------------------------------------------
// Snapshot-derived expected schema
// ---------------------------------------------------------------------------

interface SnapshotColumn {
  name: string;
  type: string;
}

interface SnapshotTable {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
}

interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
}

interface TableExpectation {
  table: string;
  columns: string[];
}

/**
 * Read the latest snapshot file (matching the last journal entry's tag) and
 * extract every { table, columns[] } pair from the public schema.
 */
function loadExpectedSchema(migrationsFolder: string): TableExpectation[] {
  // Find the latest snapshot: highest-numbered file in meta/
  const metaDir = path.join(migrationsFolder, "meta");
  const snapFiles = readdirSync(metaDir)
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .sort(); // lexicographic sort is fine for zero-padded names

  if (snapFiles.length === 0) {
    throw new Error(`No snapshot files found in ${metaDir}`);
  }

  const latestSnap = snapFiles[snapFiles.length - 1];
  const snapPath = path.join(metaDir, latestSnap);
  const snap: Snapshot = JSON.parse(readFileSync(snapPath, "utf8"));

  const expectations: TableExpectation[] = [];
  for (const tableEntry of Object.values(snap.tables)) {
    if (tableEntry.schema !== "public" && tableEntry.schema !== "") continue;
    expectations.push({
      table: tableEntry.name,
      columns: Object.keys(tableEntry.columns),
    });
  }
  return expectations;
}

// ---------------------------------------------------------------------------
// Journal integrity check (hard failure)
// ---------------------------------------------------------------------------

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function checkJournalIntegrity(migrationsFolder: string): void {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const entries = journal.entries;
  const errors: string[] = [];

  const seenWhen = new Map<number, string>();
  const seenIdx = new Map<number, string>();

  for (const e of entries) {
    if (seenWhen.has(e.when)) {
      errors.push(
        `Duplicate 'when' value ${e.when} in journal: "${seenWhen.get(e.when)}" and "${e.tag}"`,
      );
    } else {
      seenWhen.set(e.when, e.tag);
    }

    if (seenIdx.has(e.idx)) {
      errors.push(
        `Duplicate 'idx' value ${e.idx} in journal: "${seenIdx.get(e.idx)}" and "${e.tag}"`,
      );
    } else {
      seenIdx.set(e.idx, e.tag);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Journal integrity check failed:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

async function checkSchema(
  pool: pg.Pool,
  expectations: TableExpectation[],
): Promise<string[]> {
  const failures: string[] = [];

  // Fetch all columns in one round-trip
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`,
  );

  const existing = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (!existing.has(row.table_name)) {
      existing.set(row.table_name, new Set());
    }
    existing.get(row.table_name)!.add(row.column_name);
  }

  for (const { table, columns } of expectations) {
    const tableCols = existing.get(table);
    if (!tableCols) {
      failures.push(`Table "${table}" does not exist`);
      continue;
    }
    for (const col of columns) {
      if (!tableCols.has(col)) {
        failures.push(`Column "${table}"."${col}" does not exist`);
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to run this test.");
  }

  const testDbName = `test_migrate_${Date.now()}`;

  // Build an admin URL pointing to the "postgres" maintenance database so we
  // can CREATE / DROP the isolated test database.
  const adminUrl = databaseUrl.replace(/\/([^/?]+)(\?.*)?$/, "/postgres$2");
  const testDbUrl = databaseUrl.replace(/\/([^/?]+)(\?.*)?$/, `/${testDbName}$2`);

  const migrationsFolder = process.env.MIGRATIONS_DIR
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

  // --- Check journal integrity (hard failure before creating any DB) ---
  console.log("[test:migrate] Checking journal integrity...");
  checkJournalIntegrity(migrationsFolder);
  console.log("[test:migrate] Journal OK.");

  // --- Load expected schema from latest snapshot ---
  const expectations = loadExpectedSchema(migrationsFolder);
  console.log(
    `[test:migrate] Loaded ${expectations.length} table expectations from latest snapshot.`,
  );

  // --- Create test database ---
  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${testDbName}"`);
    console.log(`[test:migrate] Created temporary database: ${testDbName}`);
  } finally {
    await adminClient.end();
  }

  let passed = true;

  try {
    // --- Run migrations on the fresh database ---
    console.log("[test:migrate] Running migrations...");
    const summary = await runMigrations(testDbUrl);
    console.log(
      `[test:migrate] Applied ${summary.newlyApplied} migration(s) ` +
        `(${summary.appliedAfter}/${summary.expectedCount} total, ` +
        `latest: ${summary.latestExpectedTag ?? "none"})`,
    );

    // --- Verify every table and column from the snapshot ---
    console.log("[test:migrate] Verifying schema against latest snapshot...");
    const checkPool = new Pool({ connectionString: testDbUrl });
    try {
      const failures = await checkSchema(checkPool, expectations);
      if (failures.length > 0) {
        console.error(`\n[test:migrate] SCHEMA CHECK FAILED (${failures.length} issue(s)):`);
        for (const f of failures) console.error(`  ✗  ${f}`);
        passed = false;
      } else {
        console.log(
          `[test:migrate] All ${expectations.length} tables and their columns verified. ✓`,
        );
      }
    } finally {
      await checkPool.end();
    }
  } catch (err) {
    if (err instanceof MigrationParityError) {
      console.error("[test:migrate] Migration parity check failed:", err.message);
    } else {
      console.error("[test:migrate] Unexpected error:", err);
    }
    passed = false;
  } finally {
    // --- Drop test database ---
    const cleanupClient = new Client({ connectionString: adminUrl });
    await cleanupClient.connect();
    try {
      // Terminate any lingering connections before dropping
      await cleanupClient.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDbName],
      );
      await cleanupClient.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      console.log(`[test:migrate] Dropped temporary database: ${testDbName}`);
    } finally {
      await cleanupClient.end();
    }
  }

  if (!passed) {
    process.exit(1);
  }

  console.log("\n[test:migrate] All checks passed.");
}

main().catch((err) => {
  console.error("[test:migrate] Fatal error:", err);
  process.exit(1);
});
