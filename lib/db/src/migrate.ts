import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

/**
 * Apply all pending SQL migrations non-interactively.
 *
 * This is the production-safe replacement for interactive `drizzle-kit push`.
 * Migration SQL files are produced by `pnpm --filter @workspace/db run generate`
 * and committed under `lib/db/migrations`. At runtime the folder is located via
 * the `MIGRATIONS_DIR` env var (set in the container image), falling back to the
 * source-tree location so the local `migrate` script works without extra config.
 */
export async function runMigrations(
  databaseUrl = process.env.DATABASE_URL,
): Promise<void> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to run database migrations.");
  }

  const migrationsFolder =
    process.env.MIGRATIONS_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
