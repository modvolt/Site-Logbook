/**
 * Stamps all committed migrations as applied in the drizzle tracking table
 * WITHOUT running the SQL. Safe to run on a database that was provisioned via
 * `drizzle-kit push` (schema already matches but tracking table is empty).
 *
 * Idempotent: entries already present in the tracking table are skipped.
 * Only inserts entries whose `created_at` (= journal `when`) is not yet
 * recorded, so running this on a properly-migrated database is a no-op.
 */
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import { readMigrationFiles } from "drizzle-orm/migrator";

const { Pool } = pg;

async function stampMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to stamp migrations.");
  }

  const migrationsFolder =
    process.env.MIGRATIONS_DIR ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "migrations",
    );

  const migrations = readMigrationFiles({ migrationsFolder });

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id   SERIAL PRIMARY KEY,
        hash text   NOT NULL,
        created_at bigint
      );
    `);

    // Reset the SERIAL sequence to max(id) so inserts never collide with rows
    // that were added by a prior push-provisioned or copied database where the
    // sequence was left behind.
    await pool.query(`
      SELECT setval(
        pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'),
        COALESCE((SELECT MAX(id) FROM drizzle.__drizzle_migrations), 0),
        true
      );
    `);

    const { rows: existing } = await pool.query<{ created_at: string }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations`,
    );
    const existingSet = new Set(existing.map((r) => String(r.created_at)));

    let stamped = 0;
    for (const migration of migrations) {
      if (!existingSet.has(String(migration.folderMillis))) {
        await pool.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
        stamped++;
      }
    }

    if (stamped > 0) {
      console.log(
        `Stamped ${stamped} of ${migrations.length} migrations as applied` +
          ` (push-provisioned database baseline).`,
      );
    } else {
      console.log(
        `All ${migrations.length} migrations already recorded — nothing to stamp.`,
      );
    }
  } finally {
    await pool.end();
  }
}

stampMigrations().catch((err) => {
  console.error("Stamp failed:", err);
  process.exit(1);
});
