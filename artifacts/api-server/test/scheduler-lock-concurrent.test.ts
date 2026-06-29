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
import { withSchedulerLock, SCHEDULER_LOCK_KEYS } from "../src/lib/scheduler-lock";

// Use an arbitrary lock key that doesn't collide with real schedulers.
// We pick one beyond the defined keys to avoid any real scheduler interference.
const TEST_LOCK_KEY = 9_999;

describe("withSchedulerLock – concurrent-instance protection", () => {
  it("runs fn() exactly once when two callers race for the same lock", async () => {
    const callCount = { value: 0 };
    const log: string[] = [];

    // Both callers start at the same time. The winner increments the counter
    // inside a slow async operation; the loser must skip entirely.
    const slow = async () => {
      log.push("start");
      // Yield control so both "instances" can race
      await new Promise<void>((r) => setImmediate(r));
      callCount.value += 1;
      log.push("end");
    };

    const [ran1, ran2] = await Promise.all([
      withSchedulerLock(TEST_LOCK_KEY, slow),
      withSchedulerLock(TEST_LOCK_KEY, slow),
    ]);

    // Exactly one instance won the lock and ran fn().
    expect(callCount.value).toBe(1);
    // One returned true (ran), the other returned false (skipped).
    const trueCount = [ran1, ran2].filter(Boolean).length;
    expect(trueCount).toBe(1);
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
    // Simulate two concurrent instances racing to run the same scheduler work.
    // Both call withSchedulerLock with the real recurring-invoices key —
    // only one should execute fn(), proving at-most-once execution.
    const executed: number[] = [];

    const task = () =>
      withSchedulerLock(SCHEDULER_LOCK_KEYS.recurringInvoices, async () => {
        executed.push(Date.now());
        // Simulate the time a real tick takes (DB queries, etc.)
        await new Promise<void>((r) => setTimeout(r, 10));
      });

    await Promise.all([task(), task()]);

    // Only one instance should have run the fn().
    expect(executed.length).toBe(1);
  });
});
