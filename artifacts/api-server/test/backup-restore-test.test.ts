import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  activitiesTable,
  backupLogTable,
  customersTable,
  db,
  jobsTable,
  materialsTable,
  peopleTable,
  usersTable,
} from "@workspace/db";
import { createBackup, testBackupRestore, backupsEnabled } from "../src/lib/backup";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  DB_BACKED_PRIVATE_OBJECT_PREFIXES,
  TYPED_ONLY_PRIVATE_OBJECT_PREFIXES,
} from "../src/lib/private-object-policy";
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
const ISOLATION_CONFIRMED = process.env.BACKUP_RESTORE_TEST_CONFIRM_ISOLATED === "true";
const FULL_OBJECT_DRILL = process.env.FULL_OBJECT_RESTORE_TEST_ENABLED === "true";
const RESTORE_OPERATION_TIMEOUT_MS =
  Number(process.env.BACKUP_RESTORE_TEST_TIMEOUT_MS) || 10 * 60 * 1_000;
const SETUP_HOOK_TIMEOUT_MS = RESTORE_OPERATION_TIMEOUT_MS + 2 * 60 * 1_000;
const CLEANUP_HOOK_TIMEOUT_MS = 2 * 60 * 1_000;
const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_STORAGE = backupsEnabled();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function safeRestoreEnvironment(): boolean {
  if (process.env.NODE_ENV !== "test" || !ISOLATION_CONFIRMED) return false;
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    const storageUrl = new URL(process.env.S3_ENDPOINT ?? "");
    const databaseName = databaseUrl.pathname.slice(1).toLowerCase();
    const bucket = (process.env.S3_BUCKET ?? "").toLowerCase();
    return (
      isLoopbackHostname(databaseUrl.hostname) &&
      isLoopbackHostname(storageUrl.hostname) &&
      databaseName.includes("test") &&
      bucket.includes("test") &&
      process.env.S3_FORCE_PATH_STYLE === "true"
    );
  } catch {
    return false;
  }
}

const SAFE_ENVIRONMENT = safeRestoreEnvironment();
if (ENABLED && !SAFE_ENVIRONMENT) {
  throw new Error(
    "Backup restore test refused to run: require NODE_ENV=test, " +
      "BACKUP_RESTORE_TEST_CONFIRM_ISOLATED=true, loopback PostgreSQL/S3 endpoints, " +
      "a database and bucket containing 'test', and S3_FORCE_PATH_STYLE=true.",
  );
}

const shouldRun = ENABLED && HAS_DB && HAS_STORAGE && SAFE_ENVIRONMENT;

function isolatedS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const objectStorage = new ObjectStorageService();
const ALL_PRIVATE_PREFIXES = [
  ...DB_BACKED_PRIVATE_OBJECT_PREFIXES,
  ...TYPED_ONLY_PRIVATE_OBJECT_PREFIXES,
] as const;

type TableCounts = Record<"jobs" | "customers" | "users" | "people" | "materials" | "activities", number>;

async function currentTableCounts(): Promise<TableCounts> {
  const [jobs, customers, users, people, materials, activities] = await Promise.all([
    db.select({ value: count() }).from(jobsTable),
    db.select({ value: count() }).from(customersTable),
    db.select({ value: count() }).from(usersTable),
    db.select({ value: count() }).from(peopleTable),
    db.select({ value: count() }).from(materialsTable),
    db.select({ value: count() }).from(activitiesTable),
  ]);
  return {
    jobs: Number(jobs[0]?.value ?? 0),
    customers: Number(customers[0]?.value ?? 0),
    users: Number(users[0]?.value ?? 0),
    people: Number(people[0]?.value ?? 0),
    materials: Number(materials[0]?.value ?? 0),
    activities: Number(activities[0]?.value ?? 0),
  };
}

describe.runIf(shouldRun)(
  "testBackupRestore – full end-to-end integration",
  { timeout: 3 * 60 * 1000 },
  () => {
    let backupId: number;
    let backupObjectPath: string | null = null;
    let createdBackups: BackupLog[] = [];
    let concurrentReservationProof = { fulfilled: 0, rejected: 0, rows: 0 };
    let staleReconciliationProof = { freshBlocked: false, staleFailed: false };
    let restoreResult: BackupLog;
    let sourceCounts: TableCounts;
    let userId = 0;
    let customerId = 0;
    let personId = 0;
    let jobId = 0;
    let materialId = 0;
    let activityId = 0;
    const canaryPaths: string[] = [];
    let objectProof = { manifestEntries: 0, missingAfterLoss: 0, restoredWithMatchingHash: 0 };
    const s3 = isolatedS3Client();
    const testBucket = process.env.S3_BUCKET!;
    let bucketCreated = false;

    beforeAll(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: testBucket }));
      bucketCreated = true;
      const tag = `restore-drill-${randomUUID()}`;
      const [user] = await db
        .insert(usersTable)
        .values({ username: tag, passwordHash: "test-only", name: tag, role: "admin" })
        .returning();
      userId = user.id;
      const [customer] = await db
        .insert(customersTable)
        .values({ companyName: tag })
        .returning();
      customerId = customer.id;
      const [person] = await db.insert(peopleTable).values({ name: tag }).returning();
      personId = person.id;
      const [job] = await db
        .insert(jobsTable)
        .values({ title: tag, date: "2042-01-02", customerId })
        .returning();
      jobId = job.id;
      const [material] = await db
        .insert(materialsTable)
        .values({ jobId, name: tag, quantity: "1", unit: "ks", pricePerUnit: "1", done: true })
        .returning();
      materialId = material.id;
      const [activity] = await db
        .insert(activitiesTable)
        .values({ name: tag, customerId, completedAt: new Date() })
        .returning();
      activityId = activity.id;
      sourceCounts = await currentTableCounts();

      if (FULL_OBJECT_DRILL) {
        for (const prefix of ALL_PRIVATE_PREFIXES) {
          const objectPath = `/objects/${prefix}/${tag}.canary`;
          canaryPaths.push(objectPath);
          await objectStorage.putPrivateObject(
            objectPath,
            Buffer.from(`modvolt-full-restore-canary:${prefix}:${tag}`, "utf8"),
            "application/octet-stream",
          );
        }
      }

      // Create a fresh backup so the test owns its own fixture and doesn't
      // depend on a pre-existing backup being present in the environment.
      const backupActor = `vitest-concurrent-backup-${randomUUID()}`;
      const [freshRunning] = await db
        .insert(backupLogTable)
        .values({
          filename: `fresh-running-${randomUUID()}.pgcustom`,
          status: "running",
          trigger: "manual",
          createdBy: backupActor,
        })
        .returning();
      staleReconciliationProof.freshBlocked =
        (await Promise.allSettled([
          createBackup({ trigger: "manual", actor: backupActor }),
        ]))[0]?.status === "rejected";
      const [freshAfter] = await db
        .select({ status: backupLogTable.status })
        .from(backupLogTable)
        .where(eq(backupLogTable.id, freshRunning.id));
      if (freshAfter?.status !== "running") {
        throw new Error("A fresh running backup attempt was reconciled unexpectedly.");
      }
      await db.delete(backupLogTable).where(eq(backupLogTable.id, freshRunning.id));

      const [staleRunning] = await db
        .insert(backupLogTable)
        .values({
          filename: `stale-running-${randomUUID()}.pgcustom`,
          status: "running",
          trigger: "manual",
          createdBy: backupActor,
          createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000),
        })
        .returning();
      const attempts = await Promise.allSettled([
        createBackup({ trigger: "manual", actor: backupActor }),
        createBackup({ trigger: "manual", actor: backupActor }),
      ]);
      const [staleAfter] = await db
        .select({ status: backupLogTable.status, error: backupLogTable.error })
        .from(backupLogTable)
        .where(eq(backupLogTable.id, staleRunning.id));
      staleReconciliationProof.staleFailed =
        staleAfter?.status === "failed" &&
        staleAfter.error ===
          "Backup process ended before completion; stale attempt reconciled.";
      createdBackups = attempts.flatMap((attempt) =>
        attempt.status === "fulfilled" ? [attempt.value] : [],
      );
      const reservationRows = await db
        .select()
        .from(backupLogTable)
        .where(
          and(
            eq(backupLogTable.createdBy, backupActor),
            eq(backupLogTable.status, "success"),
          ),
        );
      concurrentReservationProof = {
        fulfilled: createdBackups.length,
        rejected: attempts.filter((attempt) => attempt.status === "rejected").length,
        rows: reservationRows.length,
      };
      if (createdBackups.length !== 1 || reservationRows.length !== 1) {
        throw new Error("Concurrent backup reservation did not produce exactly one attempt.");
      }
      const backup = createdBackups[0];
      backupId = backup.id;
      backupObjectPath = backup.objectPath;

      if (FULL_OBJECT_DRILL) {
        if (!backupObjectPath) throw new Error("Backup object path was not recorded.");
        const paths = [...canaryPaths, backupObjectPath];
        const recoveryDir = await mkdtemp(join(tmpdir(), "modvolt-object-recovery-"));
        const manifest: Array<{
          objectPath: string;
          filename: string;
          sha256: string;
          size: number;
        }> = [];
        try {
          for (const [index, objectPath] of paths.entries()) {
            const body = await objectStorage.getPrivateObjectBuffer(objectPath);
            const filename = `${String(index).padStart(2, "0")}.bin`;
            await writeFile(join(recoveryDir, filename), body);
            manifest.push({
              objectPath,
              filename,
              sha256: createHash("sha256").update(body).digest("hex"),
              size: body.length,
            });
          }
          await writeFile(join(recoveryDir, "manifest.json"), JSON.stringify(manifest, null, 2));
          objectProof.manifestEntries = manifest.length;

          await Promise.all(paths.map((objectPath) => objectStorage.deletePrivateObject(objectPath)));
          for (const objectPath of paths) {
            try {
              await objectStorage.getPrivateObjectBuffer(objectPath);
            } catch {
              objectProof.missingAfterLoss += 1;
            }
          }

          const storedManifest = JSON.parse(
            await readFile(join(recoveryDir, "manifest.json"), "utf8"),
          ) as typeof manifest;
          for (const entry of storedManifest) {
            const body = await readFile(join(recoveryDir, entry.filename));
            const snapshotHash = createHash("sha256").update(body).digest("hex");
            if (snapshotHash !== entry.sha256 || body.length !== entry.size) {
              throw new Error(`Recovery bundle integrity failed for ${entry.objectPath}.`);
            }
            await objectStorage.putPrivateObject(entry.objectPath, body, "application/octet-stream");
            const restored = await objectStorage.getPrivateObjectBuffer(entry.objectPath);
            if (createHash("sha256").update(restored).digest("hex") === entry.sha256) {
              objectProof.restoredWithMatchingHash += 1;
            }
          }
        } finally {
          await rm(recoveryDir, { recursive: true, force: true });
        }
      }

      // Run the restore test against the backup we just created.
      restoreResult = await testBackupRestore(backupId);
    }, SETUP_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      // Clean up the backup log row we created. The temp database used during
      // the test is always dropped by testBackupRestore() itself (in its
      // finally block), so no extra cleanup is needed here.
      const backupIds = createdBackups.map((backup) => backup.id);
      if (backupIds.length > 0) {
        await db.delete(backupLogTable).where(inArray(backupLogTable.id, backupIds));
      }
      await db
        .delete(backupLogTable)
        .where(eq(backupLogTable.createdBy, createdBackups[0]?.createdBy ?? "__none__"));
      await Promise.all(
        [
          ...canaryPaths,
          ...createdBackups.flatMap((backup) =>
            backup.objectPath ? [backup.objectPath] : [],
          ),
        ].map((objectPath) =>
          objectStorage.deletePrivateObject(objectPath).catch(() => undefined),
        ),
      );
      if (activityId) await db.delete(activitiesTable).where(eq(activitiesTable.id, activityId));
      if (materialId) await db.delete(materialsTable).where(eq(materialsTable.id, materialId));
      if (jobId) await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
      if (personId) await db.delete(peopleTable).where(eq(peopleTable.id, personId));
      if (customerId) await db.delete(customersTable).where(eq(customersTable.id, customerId));
      if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
      if (bucketCreated) {
        await s3.send(new DeleteBucketCommand({ Bucket: testBucket }));
      }
      s3.destroy();
    }, CLEANUP_HOOK_TIMEOUT_MS);

    it("returns restoreStatus=ok", () => {
      expect(restoreResult.restoreStatus).toBe("ok");
    });

    it("allows exactly one row and one execution for concurrent reservations", () => {
      expect(concurrentReservationProof).toEqual({
        fulfilled: 1,
        rejected: 1,
        rows: 1,
      });
      expect(createdBackups[0]?.filename).toMatch(
        /^stavba-.*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pgcustom$/,
      );
    });

    it("blocks a fresh running attempt and reconciles an abandoned aged attempt", () => {
      expect(staleReconciliationProof).toEqual({
        freshBlocked: true,
        staleFailed: true,
      });
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
        expect(tables[tableName], `count for "${tableName}" should match the source snapshot`).toBe(
          sourceCounts[tableName],
        );
        expect(tables[tableName], `fixture for "${tableName}" must make the check meaningful`).toBeGreaterThan(0);
      }
    });

    it.runIf(FULL_OBJECT_DRILL)("restores every protected object class and the encrypted DB dump from a verified recovery bundle", () => {
      const expected = ALL_PRIVATE_PREFIXES.length + 1;
      expect(objectProof.manifestEntries).toBe(expected);
      expect(objectProof.missingAfterLoss).toBe(expected);
      expect(objectProof.restoredWithMatchingHash).toBe(expected);
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
      if (!ISOLATION_CONFIRMED) missing.push("BACKUP_RESTORE_TEST_CONFIRM_ISOLATED=true");
      if (!HAS_DB) missing.push("DATABASE_URL");
      if (!HAS_STORAGE) missing.push("object storage (S3_* or PRIVATE_OBJECT_DIR)");
      if (!SAFE_ENVIRONMENT) missing.push("loopback test DB/S3 environment");
      // This test always passes — it documents why the real suite was skipped.
      expect(missing.length).toBeGreaterThan(0);
    });
  },
);
