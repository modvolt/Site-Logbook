import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const backupSource = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/backup.ts"),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = backupSource.indexOf(startMarker);
  const end = backupSource.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return backupSource.slice(start, end);
}

describe("automatic backup trigger lock contract", () => {
  it("owns the cross-replica advisory lock at the public trigger boundary", () => {
    const trigger = section(
      "export async function triggerAutoBackupIfDue",
      "// ─── Restore-test failure notification",
    );

    expect(trigger).toContain(
      "tryAcquireSchedulerLock(SCHEDULER_LOCK_KEYS.backupAuto",
    );
    expect(trigger).toContain("await reserveAutoBackupIfDue(lease, signal)");
    expect(trigger).toContain("if (!result.triggered) await lease.release()");
  });

  it("persists the running reservation before scheduling expensive work", () => {
    const reserve = section(
      "async function reserveAutoBackupIfDue",
      "export async function triggerAutoBackupIfDue",
    );
    const reservationIndex = reserve.indexOf(
      'await reserveBackupAttempt({ trigger: "auto" })',
    );
    const scheduleIndex = reserve.indexOf("setImmediate(");

    expect(reservationIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleIndex).toBeGreaterThan(reservationIndex);
    expect(reserve).toContain("executeReservedBackup(attempt, lease)");
    expect(reserve).toMatch(/await\s+lease\s*\.\s*release\(\)\s*\.\s*catch/);
  });

  it("does not release and reacquire a second lock in the fallback scheduler", () => {
    const scheduler = section(
      "export function startBackupScheduler",
      "export function startRestoreTestScheduler",
    );

    expect(scheduler).toContain(
      "triggerAutoBackupIfDue(abortController.signal).catch",
    );
    expect(scheduler).not.toContain("withSchedulerLock(");
  });

  it("holds the shared execution lease through a manual backup", () => {
    const manual = section(
      "export async function createBackup",
      "// ─── Restore (destructive)",
    );

    expect(manual).toContain(
      "tryAcquireSchedulerLock(SCHEDULER_LOCK_KEYS.backupAuto",
    );
    expect(manual).toContain("await reconcileAbandonedRunningBackups()");
    expect(manual).toContain("await executeReservedBackup(attempt, lease)");
    expect(manual).toContain("boundedBackupCleanup(");
    expect(manual).toContain("lease.release().then(() => true)");
    expect(manual).toContain("throw new BackupAlreadyRunningError()");
  });

  it("reconciles only aged running rows while the execution lease is owned", () => {
    const reconciliation = section(
      "async function reconcileAbandonedRunningBackups",
      "async function reserveBackupAttempt",
    );

    expect(reconciliation).toContain("staleRunningBackupHours()");
    expect(reconciliation).toContain('eq(backupLogTable.status, "running")');
    expect(reconciliation).toContain("lte(backupLogTable.createdAt, cutoff)");
    expect(reconciliation).toContain('status: "failed"');
  });

  it("uses a random UUID so concurrent attempts cannot share an object key", () => {
    const reservation = section(
      "async function reserveBackupAttempt",
      "async function executeReservedBackup",
    );

    expect(reservation).toContain("randomUUID()");
    expect(reservation).toContain("const objectPath");
  });

  it("fences both final states by lease validity and running-row CAS", () => {
    const success = section(
      "export async function persistBackupCreationSuccess",
      "type BackupCreationSuccessMetadata",
    );
    const failure = section(
      "export async function resolveBackupCreationFailure",
      "export type CreatedBackupLog",
    );
    const execution = section(
      "async function executeReservedBackup",
      "export async function createBackup",
    );

    expect(
      execution.match(/lease\.isValid\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(execution).toContain("BackupExecutionLeaseLostError");
    expect(success).toContain("WHERE id = $1 AND status = 'running'");
    expect(success).toContain("clock_timestamp() <= $7::timestamptz");
    expect(failure).toContain("WHERE id = $1 AND status = 'running'");
    expect(failure).toContain("AND object_path = $2 AND size_bytes = $3");
    const resolutionIndex = execution.indexOf("resolveBackupCreationFailure({");
    const deleteIndex = execution.indexOf(
      "objectStorage.deletePrivateObject(objectPath)",
    );
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(resolutionIndex);
    expect(execution).toContain(
      'if (resolution === "failed" && uploadStarted)',
    );
    expect(execution).toContain(
      'if (resolution === "success" && successMetadata)',
    );
  });

  it("terminates a timed-out restore process before forced database cleanup", () => {
    const restore = section(
      "export async function testBackupRestore",
      "// ─── Backup settings",
    );

    expect(restore).toContain('child.kill("SIGTERM")');
    expect(restore).toContain('child.kill("SIGKILL")');
    expect(restore).toContain("await stopActiveRestoreProcess()");
    expect(restore).toContain("restoreOperation.catch(() => undefined)");
    expect(restore).toContain("WITH (FORCE)");
  });
});
