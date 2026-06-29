/**
 * DB-level advisory locks for background schedulers.
 *
 * Uses PostgreSQL session-level advisory locks (pg_try_advisory_lock /
 * pg_advisory_unlock) so that when two API instances run the same scheduler
 * tick at the same time, only the first one that wins the lock actually
 * executes the work. The second one sees "acquired = false" and skips the
 * tick entirely.
 *
 * Session-level (not transaction-level) locks are used because a scheduler
 * tick typically spans multiple independent DB operations and should hold the
 * lock for the full tick, not just one transaction. The lock is always
 * released in a finally block — including when fn() throws.
 *
 * Each scheduler must use a unique, stable integer key from SCHEDULER_LOCK_KEYS.
 */
import pg from "pg";
import { logger } from "./logger";

let _lockPool: pg.Pool | null = null;

function getLockPool(): pg.Pool {
  if (!_lockPool) {
    _lockPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
    });
    _lockPool.on("error", (err) => {
      logger.warn({ err }, "[scheduler-lock] Pool error");
    });
  }
  return _lockPool;
}

/**
 * Stable advisory lock keys for each scheduler. These integers must be globally
 * unique within the database — they carry no semantic meaning beyond identity.
 */
export const SCHEDULER_LOCK_KEYS = {
  recurringInvoices: 1_001,
  backupAuto: 1_002,
  backupRestoreTest: 1_003,
  emailImport: 1_004,
  invoiceReminders: 1_005,
  ppeOverdue: 1_006,
} as const;

/**
 * Acquire a PostgreSQL session-level advisory lock, run fn(), then release.
 *
 * Returns true when fn() ran (regardless of whether it threw).
 * Returns false when another instance already holds the lock — fn() is skipped.
 *
 * Throws only if pool.connect() or the lock-query itself fails (infrastructure
 * error, not a business-logic error from fn()).
 */
export async function withSchedulerLock(
  lockKey: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const pool = getLockPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockKey],
    );
    const acquired = rows[0]?.acquired ?? false;
    if (!acquired) return false;
    try {
      await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
    }
    return true;
  } finally {
    client.release();
  }
}
