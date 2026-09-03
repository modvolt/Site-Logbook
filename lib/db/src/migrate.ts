import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const { Pool } = pg;

/**
 * Session-level advisory lock key used to serialize concurrent migration runs
 * (e.g. several API containers starting at once). Any constant works as long as
 * every runner uses the same value.
 */
const MIGRATION_LOCK_KEY = 911072468;

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
  const journal = JSON.parse(raw) as Journal;
  validateMigrationJournal(journal);
  return journal;
}

export class MigrationTransitionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MigrationTransitionError";
  }
}

/** idx order is authoritative; historical timestamps need not be increasing. */
export function validateMigrationJournal(value: unknown): asserts value is Journal {
  const entries = (value as Journal | null)?.entries;
  if (!Array.isArray(entries)) throw new MigrationTransitionError("INVALID_JOURNAL");
  const indexes = new Set<number>();
  const times = new Set<number>();
  const tags = new Set<string>();
  let previous = -1;
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.idx) || entry.idx <= previous ||
        indexes.has(entry.idx) || !Number.isSafeInteger(entry.when) ||
        entry.when <= 0 || times.has(entry.when) ||
        typeof entry.tag !== "string" || !entry.tag.trim() ||
        entry.tag !== entry.tag.trim() || tags.has(entry.tag)) {
      throw new MigrationTransitionError("INVALID_JOURNAL");
    }
    indexes.add(entry.idx);
    times.add(entry.when);
    tags.add(entry.tag);
    previous = entry.idx;
  }
}

export interface MigrationState {
  migrationsFolder: string;
  expectedCount: number;
  appliedCount: number;
  latestExpectedTag: string | null;
  currentAppliedTag: string | null;
  expectedTags: string[];
  pendingTags: string[];
  unknownAppliedMarkers: string[];
  nonContiguousHistory: boolean;
  databaseName: string;
  sessionUser: string;
  currentUser: string;
}

export interface MigrationGuard {
  expectedCurrentTag: string;
  expectedTargetTag: string;
  requireExactlyOnePending?: true;
  /** Optional for existing callers; the standard lane always supplies it. */
  expectedRole?: string;
}

export interface MigrationOptions {
  migrationsFolder?: string;
  guard?: MigrationGuard;
  failIfLockBusy?: boolean;
}

export function validateExpectedMigrationTransition(state: MigrationState, guard: MigrationGuard): void {
  const reject = (code: string): never => { throw new MigrationTransitionError(code); };
  if (state.appliedCount > state.expectedCount) reject("DATABASE_AHEAD");
  if (state.unknownAppliedMarkers.length) reject("UNKNOWN_APPLIED_MARKERS");
  if (state.nonContiguousHistory) reject("NON_CONTIGUOUS_HISTORY");
  if (guard.expectedRole && (state.sessionUser !== guard.expectedRole || state.currentUser !== guard.expectedRole)) {
    reject("ROLE_MISMATCH");
  }
  if (state.currentAppliedTag === guard.expectedTargetTag && state.pendingTags.length === 0) reject("ALREADY_APPLIED");
  if (state.currentAppliedTag !== guard.expectedCurrentTag) reject("CURRENT_MISMATCH");
  const currentIndex = state.expectedTags.indexOf(guard.expectedCurrentTag);
  if (currentIndex < 0 || state.expectedTags[currentIndex + 1] !== guard.expectedTargetTag) reject("TARGET_NOT_NEXT");
  if (state.pendingTags.length !== 1 || state.pendingTags[0] !== guard.expectedTargetTag) reject("TRANSITION_NOT_READY");
}

async function inspectOnConnection(client: Queryable, migrationsFolder: string, journal: Journal): Promise<MigrationState> {
  const identity = await client.query<{ databaseName: string; sessionUser: string; currentUser: string }>(
    'SELECT current_database() AS "databaseName", session_user AS "sessionUser", current_user AS "currentUser"',
  );
  const tracking = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  const rows = tracking.rows[0].present
    ? (await client.query<{ created_at: string | null }>("SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows
    : [];
  const expected = new Set(journal.entries.map((entry) => String(entry.when)));
  const applied = new Set<string>();
  const unknownAppliedMarkers: string[] = [];
  for (const row of rows) {
    const marker = String(row.created_at);
    if (!expected.has(marker) || applied.has(marker)) unknownAppliedMarkers.push(marker);
    applied.add(marker);
  }
  let gap = false;
  let nonContiguousHistory = false;
  let currentAppliedTag: string | null = null;
  const pendingTags: string[] = [];
  for (const entry of journal.entries) {
    if (applied.has(String(entry.when))) {
      if (gap) nonContiguousHistory = true;
      currentAppliedTag = entry.tag;
    } else {
      gap = true;
      pendingTags.push(entry.tag);
    }
  }
  return {
    migrationsFolder, expectedCount: journal.entries.length, appliedCount: rows.length,
    latestExpectedTag: journal.entries.at(-1)?.tag ?? null, currentAppliedTag,
    expectedTags: journal.entries.map((entry) => entry.tag), pendingTags,
    unknownAppliedMarkers, nonContiguousHistory, ...identity.rows[0],
  };
}

/** Consistent read-only snapshot; never creates schema/tracking or takes the migration lock. */
export async function inspectMigrationState(databaseUrl: string, options: Pick<MigrationOptions, "migrationsFolder"> = {}): Promise<MigrationState> {
  if (!databaseUrl) throw new MigrationTransitionError("CREDENTIAL_REQUIRED");
  const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);
  const pool = new Pool({ connectionString: databaseUrl });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const state = await inspectOnConnection(client, migrationsFolder, journal);
    await client.query("COMMIT");
    return state;
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    await pool.end();
  }
}

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Ensure drizzle's tracking table exists, using the exact same shape drizzle's
 * own migrator creates. Safe to call repeatedly (all `IF NOT EXISTS`).
 */
async function ensureTrackingTable(client: Queryable): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id   SERIAL PRIMARY KEY,
      hash text   NOT NULL,
      created_at bigint
    );
  `);
}

/**
 * Read the `created_at` (millis) of every migration drizzle has recorded as
 * applied in its tracking table (`drizzle.__drizzle_migrations`). Each value
 * equals the corresponding journal entry's `when`. Returns an empty array if
 * the tracking table does not exist yet.
 */
async function readAppliedMillis(client: Queryable): Promise<number[]> {
  const result = await client.query<{ created_at: string | number | null }>(
    `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  return result.rows
    .map((row) => Number(row.created_at))
    .filter((millis) => Number.isFinite(millis));
}

/**
 * Self-heal step run after drizzle's own `migrate()`.
 *
 * Drizzle's migrator reads the single highest `created_at` from the tracking
 * table once, then applies only journal entries whose `when` is strictly
 * greater than that value. A migration committed with an out-of-order (lower)
 * `when` than an already-applied one is therefore silently SKIPPED — leaving the
 * DB behind the bundled schema. This function closes that gap: it applies any
 * journal migration whose `when` is not yet recorded, in journal (array) order,
 * one transaction per migration. Identity is the `when`/`folderMillis`, exactly
 * as drizzle records it.
 *
 * On a fresh database or a normal incremental deploy there is nothing to
 * recover (drizzle already applied everything), so this is a no-op.
 */
async function recoverMissingMigrations(
  client: Queryable,
  migrationsFolder: string,
  expected: JournalEntry[],
  appliedSet: Set<number>,
): Promise<number> {
  const files = readMigrationFiles({ migrationsFolder });
  const byMillis = new Map(files.map((f) => [f.folderMillis, f]));

  let recovered = 0;
  for (const entry of expected) {
    if (appliedSet.has(entry.when)) continue;

    const file = byMillis.get(entry.when);
    if (!file) {
      throw new Error(
        `Cannot recover migration "${entry.tag}" (when=${entry.when}): ` +
          `no SQL file with a matching timestamp was found in "${migrationsFolder}".`,
      );
    }

    try {
      await client.query("BEGIN");
      for (const statement of file.sql) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [file.hash, file.folderMillis],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(
        `Failed to recover skipped migration "${entry.tag}" (when=${entry.when}): ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }

    appliedSet.add(entry.when);
    recovered++;
  }

  return recovered;
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
 * The whole run is serialized with a session-level advisory lock so concurrent
 * container starts can't race (the tracking table has no unique constraint on
 * `created_at`, so a race could double-apply DDL). After drizzle's own migrate
 * step we run {@link recoverMissingMigrations} to apply any migration drizzle
 * skipped due to an out-of-order `when`, then compare the migrations recorded in
 * drizzle's tracking table against the bundled `_journal.json`. If the DB is
 * still missing any expected migration we throw a {@link MigrationParityError}
 * so the caller can abort startup (non-zero exit) instead of serving 500s
 * against an out-of-date schema.
 */
export async function runMigrations(
  databaseUrl = process.env.DATABASE_URL,
  options: MigrationOptions = {},
): Promise<MigrationSummary> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to run database migrations.");
  }

  const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);
  const expected = journal.entries;

  const pool = new Pool({ connectionString: databaseUrl });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    // Serialize concurrent migration runs (e.g. several containers booting at
    // once). Session-level lock held until we explicitly unlock below.
    if (options.failIfLockBusy) {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_LOCK_KEY]);
      if (!lock.rows[0].locked) throw new MigrationTransitionError("MIGRATION_LOCK_BUSY");
    } else {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    }
    try {
      if (options.guard) {
        validateExpectedMigrationTransition(await inspectOnConnection(client, migrationsFolder, journal), options.guard);
      }
      await ensureTrackingTable(client);
      const appliedBefore = (await readAppliedMillis(client)).length;

      const db = drizzle(client);
      await migrate(db, { migrationsFolder });

      // Close the out-of-order `when` gap drizzle's migrator can leave behind.
      const appliedSet = new Set(await readAppliedMillis(client));
      await recoverMissingMigrations(client, migrationsFolder, expected, appliedSet);

      const appliedMillis = await readAppliedMillis(client);
      const appliedAfterSet = new Set(appliedMillis);

      const summary: MigrationSummary = {
        migrationsFolder,
        expectedCount: expected.length,
        appliedBefore,
        appliedAfter: appliedMillis.length,
        newlyApplied: appliedMillis.length - appliedBefore,
        latestExpectedTag: expected.at(-1)?.tag ?? null,
      };

      const missingTags = expected
        .filter((entry) => !appliedAfterSet.has(entry.when))
        .map((entry) => entry.tag);

      if (missingTags.length > 0) {
        throw new MigrationParityError(missingTags, summary);
      }

      return summary;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    client?.release();
    await pool.end();
  }
}
