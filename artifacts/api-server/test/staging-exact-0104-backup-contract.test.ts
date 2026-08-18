import type { BackupLog } from "@workspace/db";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExternalSchemaInventoryEnvironment } from "@workspace/db/external-schema-preflight";
import { ObjectStorageService } from "../src/lib/objectStorage";

let runStagingExact0104Backup: typeof import("../src/external-schema-exact-0104-backup").runStagingExact0104Backup;
let STAGING_EXACT_0104_BACKUP_ACTION: string;
let STAGING_EXACT_0104_BACKUP_CONFIRMATION: string;
let STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES: number;

beforeAll(async () => {
  process.env.DATABASE_URL =
    "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging";
  const module = await import("../src/external-schema-exact-0104-backup");
  runStagingExact0104Backup = module.runStagingExact0104Backup;
  STAGING_EXACT_0104_BACKUP_ACTION = module.STAGING_EXACT_0104_BACKUP_ACTION;
  STAGING_EXACT_0104_BACKUP_CONFIRMATION =
    module.STAGING_EXACT_0104_BACKUP_CONFIRMATION;
  STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES =
    module.STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES;
}, 30_000);

const SHA = "a".repeat(40);

function env(): NodeJS.ProcessEnv {
  return {
    STAGING_EXACT_0104_BACKUP_ACTION,
    STAGING_EXACT_0104_BACKUP_CONFIRMATION,
    STAGING_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    BACKUP_ENABLED: "true",
  };
}

function inventory(backupEvidenceId: number) {
  return {
    decision: "READY_0104" as const,
    appliedMigrations: 104,
    predecessorMigrations: 104,
    latestAppliedTag: "0104_thin_sheva_callister",
    missingToPredecessor: 0,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    backupEvidenceId,
    backupRestoreAgeHours: 0,
  };
}

function backup(overrides: Partial<BackupLog> = {}): BackupLog {
  return {
    id: 72,
    filename: "staging.pgcustom",
    objectPath: "/objects/backups/staging.pgcustom.enc",
    sizeBytes: 4096,
    status: "success",
    trigger: "manual",
    error: null,
    createdBy: "staging-exact-0104-backup",
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    sha256: "b".repeat(64),
    encryptionFormat: "mve1",
    encryptionKeyId: "staging-backup-2026-08",
    restoredAt: null,
    restoreTestedAt: new Date("2026-08-10T12:01:00.000Z"),
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
    .mockResolvedValueOnce(inventory(71))
    .mockResolvedValueOnce(inventory(72));
  return {
    readEnvironment: vi.fn(
      () => ({ backupEvidenceId: 71 }) as ExternalSchemaInventoryEnvironment,
    ),
    inventory: inventoryRead,
    create,
    restoreTest,
    ...overrides,
  };
}

describe("exact-0104 backup one-shot", () => {
  it("creates and restore-tests exactly one newer backup without pruning", async () => {
    const deps = dependencies();
    const result = await runStagingExact0104Backup(env(), deps);

    expect(result.decision).toBe("CREATED_AND_RESTORE_VERIFIED");
    expect(result.previousBackupId).toBe(71);
    expect(result.backupId).toBe(72);
    expect(result.retentionPruned).toBe(false);
    expect(result.authorizes0105).toBe(false);
    expect(deps.create).toHaveBeenCalledWith({
      trigger: "manual",
      actor: "staging-exact-0104-backup",
      skipRetentionPrune: true,
      maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
    });
    expect(deps.restoreTest).toHaveBeenCalledWith(72, {
      maxPayloadBytes: STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
    });
    expect(result.maxPayloadBytes).toBe(
      STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES,
    );
    expect(deps.inventory).toHaveBeenCalledTimes(2);
    expect(deps.inventory.mock.calls[1]?.[0]).toMatchObject({
      backupEvidenceId: 72,
    });
  });

  it("rejects an unsafe action or an already-0105 database before backup", async () => {
    await expect(
      runStagingExact0104Backup(
        { ...env(), STAGING_EXACT_0104_BACKUP_CONFIRMATION: "wrong" },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      code: "EXACT_0104_BACKUP_CONFIRMATION_INVALID",
    });

    const deps = dependencies({
      inventory: vi.fn(async () => ({
        ...inventory(71),
        decision: "ALREADY_0105" as const,
        appliedMigrations: 105,
      })),
    });
    await expect(runStagingExact0104Backup(env(), deps)).rejects.toMatchObject({
      code: "EXACT_0104_BACKUP_INVENTORY_INVALID",
    });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("rejects a different, destructive or unverified restore result", async () => {
    for (const invalid of [
      backup({ id: 73 }),
      backup({ restoredAt: new Date("2026-08-10T12:01:00.000Z") }),
      backup({ restoreStatus: "failed" }),
      backup({ restoreVerifiedTables: {} }),
    ]) {
      const deps = dependencies({ restoreTest: vi.fn(async () => invalid) });
      await expect(
        runStagingExact0104Backup(env(), deps),
      ).rejects.toMatchObject({
        code: "EXACT_0104_BACKUP_RESTORE_INVALID",
      });
    }
  });
});

describe("exact-0104 recovery payload ceiling", () => {
  it("stops a streamed object before buffering bytes beyond the approved ceiling", async () => {
    const storage = new ObjectStorageService();
    vi.spyOn(storage, "openPrivateObjectRecoveryStream").mockResolvedValue({
      body: Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
      contentType: "application/octet-stream",
    });

    await expect(
      storage.readPrivateObjectForRecovery("/objects/backups/test.enc", {
        maxBytes: 7,
      }),
    ).rejects.toThrow("exceeds the approved 7-byte ceiling");
  });
});
