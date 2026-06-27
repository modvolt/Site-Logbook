import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const { Pool } = pg;

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

/** A structured summary of a migration run, suitable for logging. */
export interface MigrationSummary {
  /** Absolute path of the migrations folder the build actually read. */
  migrationsFolder: string;
  /** Number of migrations the build ships with (entries in `_journal.json`). */
  expectedCount: number;
  /** Number of migrations the DB had recorded as applied before this run. */
  appliedBefore: number;
  /** Number of migrations the DB has recorded as applied after this run. */
  appliedAfter: number;
  /** Migrations applied during this run (`appliedAfter - appliedBefore`). */
  newlyApplied: number;
  /** Tag of the latest migration the build expects, or null if none. */
  latestExpectedTag: string | null;
}

/**
 * Thrown when, after running migrations, the live database is still missing one
 * or more migrations the running build ships with. This is a hard failure: the
 * process must refuse to start rather than serve traffic against an
 * out-of-date schema.
 */
export class MigrationParityError extends Error {
  readonly missingTags: string[];
  readonly summary: MigrationSummary;

  constructor(missingTags: string[], summary: MigrationSummary) {
    super(
      `DB is behind expected schema — aborting. ` +
        `${missingTags.length} migration(s) bundled in "${summary.migrationsFolder}" ` +
        `are not recorded as applied in the live database: ${missingTags.join(", ")}. ` +
        `The database has ${summary.appliedAfter} of ${summary.expectedCount} expected ` +
        `migrations. Refusing to start against an out-of-date schema.`,
    );
    this.name = "MigrationParityError";
    this.missingTags = missingTags;
    this.summary = summary;
  }
}

function resolveMigrationsFolder(): string {
  return (
    process.env.MIGRATIONS_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
  );
}

function readJournal(migrationsFolder: string): Journal {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const raw = readFileSync(journalPath, "utf8");
  return JSON.parse(raw) as Journal;
}

/**
 * Read the `created_at` (millis) of every migration drizzle has recorded as
 * applied in its tracking table (`drizzle.__drizzle_migrations`). Each value
 * equals the corresponding journal entry's `when`. Returns an empty array if
 * the tracking table does not exist yet.
 */
async function readAppliedMillis(pool: pg.Pool): Promise<number[]> {
  const result = await pool.query<{ created_at: string | number | null }>(
    `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  return result.rows
    .map((row) => Number(row.created_at))
    .filter((millis) => Number.isFinite(millis));
}

/**
 * Apply all pending SQL migrations non-interactively, then verify the live DB
 * is actually at the latest migration the build ships with.
 *
 * This is the production-safe replacement for interactive `drizzle-kit push`.
 * Migration SQL files are produced by `pnpm --filter @workspace/db run generate`
 * and committed under `lib/db/migrations`. At runtime the folder is located via
 * the `MIGRATIONS_DIR` env var (set in the container image), falling back to the
 * source-tree location so the local `migrate` script works without extra config.
 *
 * After migrating, the function compares the migrations recorded in drizzle's
 * tracking table against the bundled `_journal.json`. If the DB is still missing
 * any expected migration it throws a {@link MigrationParityError} so the caller
 * can abort startup (non-zero exit) instead of serving 500s against an
 * out-of-date schema.
 */
export async function runMigrations(
  databaseUrl = process.env.DATABASE_URL,
): Promise<MigrationSummary> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to run database migrations.");
  }

  const migrationsFolder = resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);
  const expected = journal.entries;

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Tracking table may not exist yet on a brand-new database; treat that as
    // "nothing applied" rather than an error.
    const appliedBefore = (await readAppliedMillis(pool).catch(() => [])).length;

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });

    const appliedMillis = await readAppliedMillis(pool);
    const appliedSet = new Set(appliedMillis);

    const summary: MigrationSummary = {
      migrationsFolder,
      expectedCount: expected.length,
      appliedBefore,
      appliedAfter: appliedMillis.length,
      newlyApplied: appliedMillis.length - appliedBefore,
      latestExpectedTag: expected.at(-1)?.tag ?? null,
    };

    const missingTags = expected
      .filter((entry) => !appliedSet.has(entry.when))
      .map((entry) => entry.tag);

    if (missingTags.length > 0) {
      throw new MigrationParityError(missingTags, summary);
    }

    return summary;
  } finally {
    await pool.end();
  }
}
