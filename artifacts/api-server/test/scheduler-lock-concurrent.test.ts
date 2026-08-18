/**
 * Integration tests for the DB advisory-lock scheduler coordination utility.
 *
 * Verifies two key invariants from task P1.2:
 *   1. Two concurrent withSchedulerLock() calls for the same key run fn()
 *      exactly ONCE — the second instance skips the tick rather than running
 *      in parallel.
 *   2. Sequential calls both run (the lock is properly released after fn()
 *      completes, regardless of whether fn() threw or succeeded).
 *
 * Uses the real database so the actual pg_try_advisory_lock / pg_advisory_unlock
 * round-trip is exercised. No mocking of DB internals.
 */
import { describe, it, expect } from "vitest";
import {
  tryAcquireSchedulerLock,
  withSchedulerLock,
  SCHEDULER_LOCK_KEYS,
} from "../src/lib/scheduler-lock";

// Use an arbitrary lock key that doesn't collide with real schedulers.
// We pick one beyond the defined keys to avoid any real scheduler interference.
const TEST_LOCK_KEY = 9_999;

describe("withSchedulerLock – concurrent-instance protection", () => {
  it("skips a second caller while the first caller holds the lock", async () => {
    const callCount = { value: 0 };
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });

    const first = withSchedulerLock(TEST_LOCK_KEY, async () => {
      callCount.value += 1;
      enteredResolve();
      await release;
    });

    // Do not rely on scheduler timing: prove the first callback is inside the
    // critical section before the second acquisition is attempted.
    await entered;
    const secondRan = await withSchedulerLock(TEST_LOCK_KEY, async () => {
      callCount.value += 1;
    });
    releaseResolve();
    const firstRan = await first;

    expect(callCount.value).toBe(1);
    expect(firstRan).toBe(true);
    expect(secondRan).toBe(false);
  });

  it("runs fn() for each sequential caller (lock is released after fn)", async () => {
    const results: number[] = [];

    await withSchedulerLock(TEST_LOCK_KEY, async () => {
      results.push(1);
    });
    await withSchedulerLock(TEST_LOCK_KEY, async () => {
      results.push(2);
    });

    expect(results).toEqual([1, 2]);
  });

  it("keeps an explicit lease locked until its idempotent release", async () => {
    const lease = await tryAcquireSchedulerLock(TEST_LOCK_KEY);
    expect(lease).not.toBeNull();
    expect(lease!.isValid()).toBe(true);

    const whileHeld = await tryAcquireSchedulerLock(TEST_LOCK_KEY);
    expect(whileHeld).toBeNull();

    await lease!.release();
    await lease!.release();
    expect(lease!.isValid()).toBe(false);

    const afterRelease = await tryAcquireSchedulerLock(TEST_LOCK_KEY);
    expect(afterRelease).not.toBeNull();
    await afterRelease!.release();
  });

  it("releases the lock even when fn() throws", async () => {
    let caught = false;
    try {
      await withSchedulerLock(TEST_LOCK_KEY, async () => {
        throw new Error("intentional error");
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);

    // Lock must be released — next caller should acquire it fine.
    const ran = await withSchedulerLock(TEST_LOCK_KEY, async () => {});
    expect(ran).toBe(true);
  });

  it("SCHEDULER_LOCK_KEYS has no duplicates", () => {
    const values = Object.values(SCHEDULER_LOCK_KEYS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("concurrent ticks for recurring invoice scheduler do not duplicate invoices", async () => {
    const executed: number[] = [];
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const first = withSchedulerLock(SCHEDULER_LOCK_KEYS.recurringInvoices, async () => {
      executed.push(Date.now());
      enteredResolve();
      await release;
    });

    await entered;
    const second = await withSchedulerLock(SCHEDULER_LOCK_KEYS.recurringInvoices, async () => {
      executed.push(Date.now());
    });
    releaseResolve();

    expect(await first).toBe(true);
    expect(second).toBe(false);
    expect(executed).toHaveLength(1);
  });
});
