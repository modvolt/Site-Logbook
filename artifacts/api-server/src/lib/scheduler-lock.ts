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
  healthWatchdog: 1_007,
  healthWatchdogPurge: 1_008,
} as const;

export interface SchedulerLockLease {
  isValid(): boolean;
  release(): Promise<void>;
}

/**
 * Try to acquire a session-level advisory lock and return an explicit lease.
 *
 * The caller owns the lease until release(). PostgreSQL also drops the lock if
 * the process or connection dies, which makes this suitable for work that is
 * scheduled after the request which reserved it has already returned.
 */
export async function tryAcquireSchedulerLock(
  lockKey: number,
): Promise<SchedulerLockLease | null> {
  const client = await getLockPool().connect();
  let released = false;
  let valid = true;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatPromise: Promise<unknown> | null = null;
  const onLeaseError = (error: Error): void => {
    valid = false;
    if (heartbeat) clearInterval(heartbeat);
    logger.warn(
      { errorName: error.name, lockKey },
      "Scheduler lock lease connection failed",
    );
  };
  // pg-pool removes its idle error handler while a client is checked out. A
  // long-lived lease therefore needs its own listener for the full checkout.
  client.on("error", onLeaseError);
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockKey],
    );
    if (!(rows[0]?.acquired ?? false)) {
      client.removeListener("error", onLeaseError);
      client.release();
      return null;
    }
    if (!valid) throw new Error("Scheduler lock connection failed during acquisition.");

    heartbeat = setInterval(() => {
      if (released || heartbeatPromise) return;
      heartbeatPromise = client
        .query("SELECT 1")
        .catch(() => {
          valid = false;
          if (heartbeat) clearInterval(heartbeat);
        })
        .finally(() => {
          heartbeatPromise = null;
        });
    }, 30_000);
    heartbeat.unref();

    return {
      isValid(): boolean {
        return valid && !released;
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        if (heartbeat) clearInterval(heartbeat);
        await heartbeatPromise?.catch(() => undefined);
        if (!valid) {
          client.removeListener("error", onLeaseError);
          client.release(true);
          return;
        }
        let destroyConnection = false;
        try {
          await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
        } catch (error) {
          // A pooled session must never be returned while it may still own an
          // advisory lock. Destroying it lets PostgreSQL release the lock.
          destroyConnection = true;
          throw error;
        } finally {
          client.removeListener("error", onLeaseError);
          client.release(destroyConnection);
        }
      },
    };
  } catch (error) {
    client.removeListener("error", onLeaseError);
    client.release(true);
    throw error;
  }
}

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
  const lease = await tryAcquireSchedulerLock(lockKey);
  if (!lease) return false;
  try {
    await fn();
    return true;
  } finally {
    await lease.release();
  }
}
