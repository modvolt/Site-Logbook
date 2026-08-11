import type { BackupLog } from "@workspace/db";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  type AuditSchemaEnvironment,
} from "@workspace/db/audit-schema-preflight";
import { beforeAll, describe, expect, it, vi } from "vitest";

let runStagingExact0106Backup: typeof import("../src/audit-schema-exact-0106-backup").runStagingExact0106Backup;
let ACTION: string;
let CONFIRMATION: string;
let MAX_BYTES: number;

beforeAll(async () => {
  process.env.DATABASE_URL =
    "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging";
  const module = await import("../src/audit-schema-exact-0106-backup");
  runStagingExact0106Backup = module.runStagingExact0106Backup;
  ACTION = module.STAGING_EXACT_0106_BACKUP_ACTION;
  CONFIRMATION = module.STAGING_EXACT_0106_BACKUP_CONFIRMATION;
  MAX_BYTES = module.STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES;
}, 30_000);

const SHA = "a".repeat(40);

function env(): NodeJS.ProcessEnv {
  return {
    STAGING_EXACT_0106_BACKUP_ACTION: ACTION,
    STAGING_EXACT_0106_BACKUP_CONFIRMATION: CONFIRMATION,
    STAGING_AUDIT_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    BACKUP_ENABLED: "true",
  };
}

function inventory(backupEvidenceId: number) {
  return {
    schemaVersion: "site-logbook.audit-schema-inventory/v1" as const,
    kind: "audit-schema-inventory" as const,
    decision: "READY_0106" as const,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: {
      decision: "READY_0106" as const,
      knownAppliedMigrations: 106,
      latestKnownAppliedTag: AUDIT_SCHEMA_MIGRATIONS.predecessor.tag,
      missingKnownToPredecessor: 0,
      knownAppliedRowsSha256: AUDIT_SCHEMA_KNOWN_ROWS_SHA256.predecessor,
      opaqueLegacyRowCount: 0 as const,
      opaqueLegacyRowsSha256:
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      mode: "clean" as const,
      knownExpectedMigrations: 107 as const,
      opaqueLegacyMeaningInferred: false as const,
      excludedMigration0100Present: false as const,
    },
    schema: {
      targetTag: "0107_canonical_audit_evidence" as const,
      targetSqlSha256: `sha256:${AUDIT_SCHEMA_MIGRATIONS.target.hash}`,
      targetSnapshotSha256:
        "sha256:4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb",
      auditEventRows: 0,
      auditOutboxRows: 0,
      auditHeadRows: 0,
    },
    backupEvidenceId,
    backupRestoreAgeHours: 0,
    authorizesApplicationStart: false as const,
  };
}

function backup(overrides: Partial<BackupLog> = {}): BackupLog {
  return {
    id: 92,
    filename: "staging-0106.pgcustom",
    objectPath: "/objects/backups/staging-0106.pgcustom.enc",
    sizeBytes: 4096,
    status: "success",
    trigger: "manual",
    error: null,
    createdBy: "staging-exact-0106-audit-backup",
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
    sha256: "b".repeat(64),
    encryptionFormat: "mve1",
    encryptionKeyId: "staging-backup-2026-08",
    restoredAt: null,
    restoreTestedAt: new Date("2026-08-12T12:01:00.000Z"),
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
    .mockResolvedValueOnce(inventory(91))
    .mockResolvedValueOnce(inventory(92));
  return {
    readEnvironment: vi.fn(
      () => ({ backupEvidenceId: 91 }) as AuditSchemaEnvironment,
    ),
    inventory: inventoryRead,
    create,
    restoreTest,
    ...overrides,
  };
}

describe("exact-0106 audit backup one-shot", () => {
  it("creates and restore-tests one bounded newer backup without pruning or 0107 authorization", async () => {
    const deps = dependencies();
    const result = await runStagingExact0106Backup(env(), deps);
    expect(result).toMatchObject({
      schemaVersion: "site-logbook.audit-schema-exact-0106-backup/v1",
      kind: "audit-schema-exact-0106-backup",
      decision: "CREATED_AND_RESTORE_VERIFIED",
      expectedMigrations: 106,
      latestExpectedTag: "0106_graceful_frog_thor",
      previousBackupId: 91,
      backupId: 92,
      encryptedBackupSha256: `sha256:${"b".repeat(64)}`,
      retentionPruned: false,
      authorizes0107: false,
      authorizesApplicationStart: false,
    });
    expect(deps.create).toHaveBeenCalledWith({
      trigger: "manual",
      actor: "staging-exact-0106-audit-backup",
      skipRetentionPrune: true,
      maxPayloadBytes: MAX_BYTES,
    });
    expect(deps.restoreTest).toHaveBeenCalledWith(92, {
      maxPayloadBytes: MAX_BYTES,
    });
  });

  it("rejects unsafe boundaries and any already-0107 inventory", async () => {
    await expect(
      runStagingExact0106Backup(
        { ...env(), STAGING_EXACT_0106_BACKUP_CONFIRMATION: "wrong" },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "EXACT_0106_BACKUP_CONFIRMATION_INVALID" });
    const deps = dependencies({
      inventory: vi.fn(async () => ({
        ...inventory(91),
        decision: "ALREADY_0107" as const,
      })),
    });
    await expect(runStagingExact0106Backup(env(), deps)).rejects.toMatchObject({
      code: "EXACT_0106_BACKUP_INVENTORY_INVALID",
    });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("rejects destructive, different, unverified and oversized restore results", async () => {
    for (const invalid of [
      backup({ id: 93 }),
      backup({ restoredAt: new Date("2026-08-12T12:01:00.000Z") }),
      backup({ restoreStatus: "failed" }),
      backup({ restoreVerifiedTables: {} }),
      backup({ sizeBytes: MAX_BYTES + 1 }),
    ]) {
      await expect(
        runStagingExact0106Backup(
          env(),
          dependencies({ restoreTest: vi.fn(async () => invalid) }),
        ),
      ).rejects.toMatchObject({
        code:
          invalid.sizeBytes === MAX_BYTES + 1
            ? "EXACT_0106_BACKUP_PAYLOAD_TOO_LARGE"
            : "EXACT_0106_BACKUP_RESTORE_INVALID",
      });
    }
  });
});
