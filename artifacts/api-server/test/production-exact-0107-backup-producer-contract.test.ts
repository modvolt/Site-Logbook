import type { BackupLog } from "@workspace/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BackupSourceSnapshotEvidence,
  CreatedBackupLog,
} from "../src/lib/backup";

let runProductionExact0107Backup: typeof import("../src/production-exact-0107-backup-producer").runProductionExact0107Backup;
let target: Readonly<Record<string, unknown>>;
let opaqueRows: readonly Readonly<{ createdAt: number; hash: string }>[];

beforeAll(async () => {
  process.env.DATABASE_URL =
    "postgres://site_logbook_migrator_login:test@postgres:5432/site_logbook";
  ({ runProductionExact0107Backup } =
    await import("../src/production-exact-0107-backup-producer"));
  // @ts-ignore -- source-reviewed repository evidence module.
  const contract =
    await import("../../../scripts/production-evidence/production-migration-contract.mjs");
  target = contract.PRODUCTION_MIGRATION_TARGET;
  opaqueRows = contract.PRODUCTION_OPAQUE_LEGACY_ROWS;
}, 30_000);

const SOURCE_SHA = "1".repeat(40);
const TABLE_COUNTS = Object.freeze({
  "drizzle.__drizzle_migrations": 109,
  "public.backup_log": 4,
  "public.invoices": 7,
});
const TABLE_COUNTS_SHA256 = `sha256:${"3".repeat(64)}`;
const SNAPSHOT: BackupSourceSnapshotEvidence = Object.freeze({
  schemaVersion: "site-logbook.backup-source-table-counts/v1",
  tableNames: Object.freeze(Object.keys(TABLE_COUNTS)),
  tableCounts: TABLE_COUNTS,
  tableCountsSha256: TABLE_COUNTS_SHA256,
});

function config() {
  return {
    sourceSha: SOURCE_SHA,
    migrationsDirectory: "/app/migrations",
    evidenceDirectory: "/evidence",
    databaseName: "site_logbook",
    sessionUser: "site_logbook_migrator_login",
    migratorRole: "site_logbook_migrator",
    runtimeRole: "site_logbook_runtime",
  };
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    knownAppliedMigrations: target.knownAppliedMigrations,
    knownAppliedRowsSha256: target.knownAppliedRowsSha256,
    latestKnownAppliedTag: target.latestKnownAppliedTag,
    missingKnownMigrationTags: [],
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: opaqueRows,
    excludedMigration0100Present: false,
    totalJournalRows: target.totalJournalRows,
    ...overrides,
  };
}

function backup(overrides: Partial<BackupLog> = {}): BackupLog {
  return {
    id: 41,
    filename: "site-logbook-backup.pgcustom",
    objectPath: "/objects/backups/site-logbook-backup.pgcustom.mve1",
    sizeBytes: 8192,
    status: "success",
    trigger: "manual",
    error: null,
    createdBy: "production-exact-0107-invoice-backup",
    createdAt: new Date("2026-08-23T10:01:00.000Z"),
    sha256: "2".repeat(64),
    encryptionFormat: "mve1",
    encryptionKeyId: "production-backup-key",
    restoredAt: null,
    restoreTestedAt: new Date("2026-08-23T10:05:00.000Z"),
    restoreStatus: "ok",
    restoreError: null,
    restoreDurationMs: 120_000,
    restoreVerifiedTables: { ...TABLE_COUNTS },
    ...overrides,
  };
}

function created(overrides: Partial<CreatedBackupLog> = {}): CreatedBackupLog {
  return {
    ...backup(),
    restoreTestedAt: null,
    restoreStatus: null,
    restoreDurationMs: null,
    restoreVerifiedTables: null,
    sourceSnapshotEvidence: SNAPSHOT,
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const persistExclusive = vi.fn(async () => undefined);
  const assertWritersStopped = vi
    .fn()
    .mockResolvedValueOnce({
      observedAt: "2026-08-23T10:00:00.000Z",
      runtimeRole: "site_logbook_runtime",
      activeRuntimeSessions: 0,
      uninspectableClientSessions: 0,
    })
    .mockResolvedValueOnce({
      observedAt: "2026-08-23T10:06:00.000Z",
      runtimeRole: "site_logbook_runtime",
      activeRuntimeSessions: 0,
      uninspectableClientSessions: 0,
    });
  return {
    readInventory: vi.fn(async () => inventory()),
    assertWritersStopped,
    create: vi.fn(async () => created()),
    restoreTest: vi.fn(async () => backup()),
    readBackup: vi.fn(async () => backup()),
    persistExclusive,
    now: () => new Date("2026-08-23T10:02:00.000Z"),
    ...overrides,
  };
}

describe("production exact-0107 backup producer", () => {
  it("persists receipt then reference only after encrypted all-table disposable restore", async () => {
    const deps = dependencies();
    const result = await runProductionExact0107Backup(config(), deps);

    expect(result.decision).toBe(
      "EXACT_0107_BACKUP_AND_DISPOSABLE_RESTORE_VERIFIED",
    );
    expect(result.authorizesProductionMigration).toBe(false);
    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        skipRetentionPrune: true,
        captureSourceSnapshotTableCounts: true,
      }),
    );
    expect(deps.restoreTest).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ expectedSourceSnapshotEvidence: SNAPSHOT }),
    );
    expect(deps.persistExclusive.mock.calls.map(([name]) => name)).toEqual([
      "exact-0107-backup-restore-receipt.json",
      "exact-0107-backup-restore-reference.json",
    ]);
    const receipt = JSON.parse(deps.persistExclusive.mock.calls[0][1]);
    expect(receipt.runtimeRole).toBe("site_logbook_runtime");
    expect(receipt.backupEncryptionFormat).toBe("mve1");
    expect(receipt.sourceTableCountsSha256).toBe(TABLE_COUNTS_SHA256);
    expect(receipt.productionRestorePerformed).toBe(false);
  });

  it("fails before backup if the exact-0107 inventory or stopped-writer proof drifts", async () => {
    const driftedInventory = dependencies({
      readInventory: vi.fn(async () =>
        inventory({ knownAppliedMigrations: 106 }),
      ),
    });
    await expect(
      runProductionExact0107Backup(config(), driftedInventory),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_BACKUP_INVENTORY_INVALID",
    });
    expect(driftedInventory.create).not.toHaveBeenCalled();

    const writersRunning = dependencies({
      assertWritersStopped: vi.fn(async () => ({
        observedAt: "2026-08-23T10:00:00.000Z",
        runtimeRole: "site_logbook_runtime",
        activeRuntimeSessions: 1,
        uninspectableClientSessions: 0,
      })),
    });
    await expect(
      runProductionExact0107Backup(config(), writersRunning),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_BACKUP_WRITERS_RUNNING",
    });
    expect(writersRunning.create).not.toHaveBeenCalled();
  });

  it("does not persist evidence for a restore count mismatch", async () => {
    const deps = dependencies({
      restoreTest: vi.fn(async () =>
        backup({
          restoreVerifiedTables: {
            ...TABLE_COUNTS,
            "public.invoices": 6,
          },
        }),
      ),
    });
    await expect(
      runProductionExact0107Backup(config(), deps),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_BACKUP_RESTORE_INVALID",
    });
    expect(deps.persistExclusive).not.toHaveBeenCalled();
  });
});
