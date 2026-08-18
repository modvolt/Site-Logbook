import type { BackupLog } from "@workspace/db";
import type { AccountingSchemaEnvironment } from "@workspace/db/accounting-schema-preflight";
import { beforeAll, describe, expect, it, vi } from "vitest";

let runStagingExact0105Backup: typeof import("../src/accounting-schema-exact-0105-backup").runStagingExact0105Backup;
let STAGING_EXACT_0105_BACKUP_ACTION: string;
let STAGING_EXACT_0105_BACKUP_CONFIRMATION: string;
let STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES: number;

beforeAll(async () => {
  process.env.DATABASE_URL =
    "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging";
  const module = await import("../src/accounting-schema-exact-0105-backup");
  runStagingExact0105Backup = module.runStagingExact0105Backup;
  STAGING_EXACT_0105_BACKUP_ACTION = module.STAGING_EXACT_0105_BACKUP_ACTION;
  STAGING_EXACT_0105_BACKUP_CONFIRMATION =
    module.STAGING_EXACT_0105_BACKUP_CONFIRMATION;
  STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES =
    module.STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES;
}, 30_000);

const SHA = "a".repeat(40);

function env(): NodeJS.ProcessEnv {
  return {
    STAGING_EXACT_0105_BACKUP_ACTION,
    STAGING_EXACT_0105_BACKUP_CONFIRMATION,
    STAGING_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    BACKUP_ENABLED: "true",
  };
}

function inventory(backupEvidenceId: number) {
  return {
    decision: "READY_0105" as const,
    appliedMigrations: 105,
    predecessorMigrations: 105,
    latestAppliedTag: "0105_smooth_nitro",
    missingToPredecessor: 0,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    backupEvidenceId,
    backupRestoreAgeHours: 0,
    externalStateRows: 0,
  };
}

function backup(overrides: Partial<BackupLog> = {}): BackupLog {
  return {
    id: 82,
    filename: "staging-0105.pgcustom",
    objectPath: "/objects/backups/staging-0105.pgcustom.enc",
    sizeBytes: 4096,
    status: "success",
    trigger: "manual",
    error: null,
    createdBy: "staging-exact-0105-accounting-backup",
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    sha256: "b".repeat(64),
    encryptionFormat: "mve1",
    encryptionKeyId: "staging-backup-2026-08",
    restoredAt: null,
    restoreTestedAt: new Date("2026-08-11T12:01:00.000Z"),
    restoreStatus: "ok",
    restoreError: null,
    restoreDurationMs: 60_000,
    restoreVerifiedTables: { users: 10 },
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const create = vi.fn(async () => backup());
  const restoreTest = vi.fn(async () => backup());
  const inventoryRead = vi
    .fn()
    .mockResolvedValueOnce(inventory(81))
    .mockResolvedValueOnce(inventory(82));
  return {
    readEnvironment: vi.fn(
      () => ({ backupEvidenceId: 81 }) as AccountingSchemaEnvironment,
    ),
    inventory: inventoryRead,
    create,
    restoreTest,
    ...overrides,
  };
}

describe("exact-0105 accounting backup one-shot", () => {
  it("creates and restore-tests one bounded newer backup without pruning or 0106 authorization", async () => {
    const deps = dependencies();
    const result = await runStagingExact0105Backup(env(), deps);

    expect(result).toMatchObject({
      decision: "CREATED_AND_RESTORE_VERIFIED",
      expectedMigrations: 105,
      latestExpectedTag: "0105_smooth_nitro",
      previousBackupId: 81,
      backupId: 82,
      accountingEvidenceRows: 0,
      externalStateRows: 0,
      retentionPruned: false,
      authorizes0106: false,
    });
    expect(deps.create).toHaveBeenCalledWith({
      trigger: "manual",
      actor: "staging-exact-0105-accounting-backup",
      skipRetentionPrune: true,
      maxPayloadBytes: STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
    });
    expect(deps.restoreTest).toHaveBeenCalledWith(82, {
      maxPayloadBytes: STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES,
    });
    expect(deps.inventory.mock.calls[1]?.[0]).toMatchObject({
      backupEvidenceId: 82,
    });
  });

  it("rejects unsafe confirmation and an already-0106 database before backup", async () => {
    await expect(
      runStagingExact0105Backup(
        { ...env(), STAGING_EXACT_0105_BACKUP_CONFIRMATION: "wrong" },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      code: "EXACT_0105_BACKUP_CONFIRMATION_INVALID",
    });

    const deps = dependencies({
      inventory: vi.fn(async () => ({
        ...inventory(81),
        decision: "ALREADY_0106" as const,
        appliedMigrations: 106,
        latestAppliedTag: "0106_graceful_frog_thor",
        backupEvidenceId: null,
        backupRestoreAgeHours: null,
      })),
    });
    await expect(runStagingExact0105Backup(env(), deps)).rejects.toMatchObject({
      code: "EXACT_0105_BACKUP_INVENTORY_INVALID",
    });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("rejects a different, destructive or unverified restore result", async () => {
    for (const invalid of [
      backup({ id: 83 }),
      backup({ restoredAt: new Date("2026-08-11T12:01:00.000Z") }),
      backup({ restoreStatus: "failed" }),
      backup({ restoreVerifiedTables: {} }),
    ]) {
      const deps = dependencies({ restoreTest: vi.fn(async () => invalid) });
      await expect(
        runStagingExact0105Backup(env(), deps),
      ).rejects.toMatchObject({ code: "EXACT_0105_BACKUP_RESTORE_INVALID" });
    }
  });

  it("rejects create and restore payloads above the 256 MiB ceiling", async () => {
    const tooLarge = STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES + 1;
    const createDeps = dependencies({
      create: vi.fn(async () => backup({ sizeBytes: tooLarge })),
    });
    await expect(
      runStagingExact0105Backup(env(), createDeps),
    ).rejects.toMatchObject({ code: "EXACT_0105_BACKUP_PAYLOAD_TOO_LARGE" });
    expect(createDeps.restoreTest).not.toHaveBeenCalled();

    const restoreDeps = dependencies({
      restoreTest: vi.fn(async () => backup({ sizeBytes: tooLarge })),
    });
    await expect(
      runStagingExact0105Backup(env(), restoreDeps),
    ).rejects.toMatchObject({ code: "EXACT_0105_BACKUP_PAYLOAD_TOO_LARGE" });
  });
});
