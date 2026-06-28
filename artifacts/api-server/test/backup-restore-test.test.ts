import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, backupLogTable } from "@workspace/db";
import { createBackup, testBackupRestore, backupsEnabled } from "../src/lib/backup";
import type { BackupLog } from "@workspace/db";

/**
 * End-to-end integration test for testBackupRestore().
 *
 * Exercises the full non-destructive restore-test path:
 *   create backup → download from object storage → CREATE DATABASE →
 *   pg_restore → verify table row counts → DROP DATABASE → assert result
 *
 * Guards:
 *   BACKUP_RESTORE_TEST_ENABLED=true  — must be explicitly opted in
 *   DATABASE_URL                       — required for pg operations
 *   Object storage configured          — needed to store/retrieve the dump
 *
 * Without all three the entire suite is skipped (no failures reported).
 *
 * Set a per-test timeout of 3 minutes; real-database backup + restore can
 * take tens of seconds depending on database size and storage latency.
 */

const ENABLED = process.env.BACKUP_RESTORE_TEST_ENABLED === "true";
const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_STORAGE = backupsEnabled();

const shouldRun = ENABLED && HAS_DB && HAS_STORAGE;

describe.runIf(shouldRun)(
  "testBackupRestore – full end-to-end integration",
  { timeout: 3 * 60 * 1000 },
  () => {
    let backupId: number;
    let restoreResult: BackupLog;

    beforeAll(async () => {
      // Create a fresh backup so the test owns its own fixture and doesn't
      // depend on a pre-existing backup being present in the environment.
      const backup = await createBackup({ trigger: "manual", actor: "vitest-restore-test" });
      backupId = backup.id;

      // Run the restore test against the backup we just created.
      restoreResult = await testBackupRestore(backupId);
    });

    afterAll(async () => {
      // Clean up the backup log row we created. The temp database used during
      // the test is always dropped by testBackupRestore() itself (in its
      // finally block), so no extra cleanup is needed here.
      if (backupId) {
        await db.delete(backupLogTable).where(eq(backupLogTable.id, backupId));
      }
    });

    it("returns restoreStatus=ok", () => {
      expect(restoreResult.restoreStatus).toBe("ok");
    });

    it("populates restoreVerifiedTables with all expected table names", () => {
      const tables = restoreResult.restoreVerifiedTables as Record<string, number>;
      expect(tables).toBeTruthy();
      const expectedTables = [
        "jobs",
        "customers",
        "users",
        "people",
        "materials",
        "activities",
      ] as const;
      for (const tableName of expectedTables) {
        expect(
          Object.keys(tables),
          `restoreVerifiedTables should contain "${tableName}"`,
        ).toContain(tableName);
        expect(
          typeof tables[tableName],
          `count for "${tableName}" should be a number`,
        ).toBe("number");
      }
    });

    it("records a positive duration and a restoreTestedAt timestamp", () => {
      expect(restoreResult.restoreDurationMs).toBeGreaterThan(0);
      expect(restoreResult.restoreTestedAt).toBeInstanceOf(Date);
    });

    it("leaves restoreError null on success", () => {
      expect(restoreResult.restoreError).toBeNull();
    });

    it("persists the result to the backup_log row in the database", async () => {
      const [row] = await db
        .select()
        .from(backupLogTable)
        .where(eq(backupLogTable.id, backupId));

      expect(row, "backup_log row should still exist").toBeTruthy();
      expect(row.restoreStatus).toBe("ok");
      expect(row.restoreTestedAt).toBeInstanceOf(Date);
      expect(row.restoreDurationMs).toBeGreaterThan(0);
      const tables = row.restoreVerifiedTables as Record<string, number>;
      expect(tables).toBeTruthy();
      expect(Object.keys(tables)).toContain("users");
    });
  },
);

describe.skipIf(shouldRun)(
  "testBackupRestore – skipped (missing guards)",
  () => {
    it("is skipped when BACKUP_RESTORE_TEST_ENABLED, DATABASE_URL, or object storage is not configured", () => {
      const missing: string[] = [];
      if (!ENABLED) missing.push("BACKUP_RESTORE_TEST_ENABLED=true");
      if (!HAS_DB) missing.push("DATABASE_URL");
      if (!HAS_STORAGE) missing.push("object storage (S3_* or PRIVATE_OBJECT_DIR)");
      // This test always passes — it documents why the real suite was skipped.
      expect(missing.length).toBeGreaterThan(0);
    });
  },
);
