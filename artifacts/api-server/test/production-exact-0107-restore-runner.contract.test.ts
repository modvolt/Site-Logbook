import type { BackupLog } from "@workspace/db";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

let runProductionExact0107Restore: typeof import("../src/production-exact-0107-restore-runner").runProductionExact0107Restore;
let productionRestoreProcessBoundary: typeof import("../src/lib/backup").productionRestoreProcessBoundary;
let createArtifact: (value: unknown) => {
  canonical: string;
  sha256: string;
};
let createReference: (input: {
  receiptStorageId: string;
  receiptCanonical: string;
}) => { canonical: string; sha256: string };
let opaqueRows: readonly Readonly<{ createdAt: number; hash: string }>[];
let roleContract: typeof import("../../../lib/db/src/production-role-separation-contract");
let canonicalStoppedWriters: (value: unknown) => string;

const SOURCE_SHA = "7e3e50ca10e3877d2f4ee3a098380a44565623c5";
const TABLE_COUNTS = Object.freeze({
  "drizzle.__drizzle_migrations": 109,
  "public.backup_log": 4,
  "public.invoices": 7,
});
const TABLE_COUNTS_SHA256 = `sha256:${createHash("sha256")
  .update(JSON.stringify(TABLE_COUNTS), "utf8")
  .digest("hex")}`;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://admin:test@postgres:5432/admin";
  ({ runProductionExact0107Restore } =
    await import("../src/production-exact-0107-restore-runner"));
  ({ productionRestoreProcessBoundary } = await import("../src/lib/backup"));
  // @ts-ignore -- source-reviewed repository evidence modules.
  const migrationContract =
    await import("../../../scripts/production-evidence/production-migration-contract.mjs");
  // @ts-ignore -- source-reviewed repository evidence modules.
  const backupAuthority =
    await import("../../../scripts/production-evidence/production-exact-0107-backup-authority.mjs");
  createArtifact = migrationContract.createProductionMigrationArtifact;
  createReference =
    backupAuthority.createProductionExact0107BackupRestoreReference;
  opaqueRows = migrationContract.PRODUCTION_OPAQUE_LEGACY_ROWS;
  roleContract =
    await import("../../../lib/db/src/production-role-separation-contract");
  // @ts-ignore -- source-reviewed repository evidence modules.
  const stoppedWriters =
    await import("../../../scripts/production-evidence/production-exact-0096-backup-contract.mjs");
  canonicalStoppedWriters =
    stoppedWriters.canonicalProductionExact0096BackupJson;
}, 30_000);

function rolePreconditionCanonical() {
  const plan = roleContract.buildProductionRolePlan({
    databaseName: "admin",
    runtimeRole: "site_logbook_runtime",
    migratorRole: "site_logbook_migrator",
  });
  const role = (name: string, login: boolean) => ({
    name,
    login,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  });
  const objects = [
    ...roleContract.REQUIRED_TABLE_GRANTS.map((grant) => ({
      kind: "table",
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...roleContract.REQUIRED_SEQUENCE_GRANTS.map((grant) => ({
      kind: "sequence",
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...roleContract.REQUIRED_FUNCTION_GRANTS.map((grant) => ({
      kind: "function",
      schema: grant.schema,
      name: grant.name,
      identityArguments: grant.identityArguments,
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: ["search_path=pg_catalog, public, pg_temp"],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
  ];
  const projection = {
    schemaVersion: roleContract.PRODUCTION_ROLE_CONTRACT_SCHEMA,
    migration: roleContract.ROLE_CONTRACT_MIGRATION,
    migrationSha256: roleContract.ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: plan.databaseName,
    databaseOwner: plan.migratorRole,
    databasePublicPrivileges: ["CONNECT"],
    databaseRuntimePrivileges: ["CONNECT"],
    databaseOtherGrants: [],
    runtimeRole: role(plan.runtimeRole, true),
    migratorRole: role(plan.migratorRole, false),
    runtimeMemberOf: [],
    migratorMemberOf: [],
    runtimeRoleMembers: [],
    migratorRoleMembers: [],
    runtimeGlobalSettings: [],
    runtimeDatabaseSettings: ["search_path=pg_catalog, public, pg_temp"],
    schemas: [
      {
        name: "public",
        owner: plan.migratorRole,
        publicPrivileges: ["USAGE"],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
      {
        name: "drizzle",
        owner: plan.migratorRole,
        publicPrivileges: [],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
    ],
    defaultPrivileges: ["public", "drizzle"].flatMap((schema) =>
      ["table", "sequence", "function"].map((kind) => ({
        schema,
        kind,
        owner: plan.migratorRole,
        publicPrivileges: [],
        runtimePrivileges: [],
        otherGrants: [],
      })),
    ),
    objects,
  };
  const rolePlanCanonical = roleContract.canonicalProductionRoleJson(plan);
  const preProjectionCanonical =
    roleContract.canonicalProductionRoleJson(projection);
  return roleContract.canonicalProductionRoleJson({
    schemaVersion: "site-logbook.production-migration-role-precondition/v1",
    kind: "site-logbook-production-migration-role-precondition",
    sourceSha: SOURCE_SHA,
    database: {
      name: "admin",
      sessionUser: "admin",
      currentUser: "site_logbook_migrator",
    },
    migrationRole: "site_logbook_migrator",
    runtimeRole: "site_logbook_runtime",
    rolePlanCanonical,
    rolePlanSha256: plan.planSha256,
    preProjectionCanonical,
    preProjectionSha256: roleContract.parseCanonicalProductionRoleArtifact(
      preProjectionCanonical,
    ).sha256,
    capturedAt: "2026-08-24T18:07:00.000Z",
    migrationRoleCanApplyMigrations: true,
    runtimeRoleCanApplyMigrations: false,
    authorizesApplicationStart: false,
  });
}

function stoppedWritersProofCanonical() {
  return canonicalStoppedWriters({
    schemaVersion: "site-logbook.production-stopped-writers-proof/v2",
    mode: "production-maintenance-stopped-writers",
    proofId: "a".repeat(64),
    maintenanceWindowId: "restore-0108-20260824",
    sourceSha: SOURCE_SHA,
    runtimeBindingSha256: `sha256:${"b".repeat(64)}`,
    databaseIdentitySha256: `sha256:${"c".repeat(64)}`,
    quiescentSince: "2026-08-24T18:08:00.000Z",
    observedAt: "2026-08-24T18:09:00.000Z",
    gracePeriodMs: 60_000,
    activeApplicationSessions: 0,
    activeWriteTransactions: 0,
    databaseWritesObserved: 0,
    runningWriterContainerIds: [],
  });
}

function inventory(phase: "pre" | "post") {
  return {
    knownAppliedMigrations: phase === "pre" ? 107 : 108,
    knownAppliedRowsSha256:
      phase === "pre"
        ? "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313"
        : "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281",
    latestKnownAppliedTag:
      phase === "pre"
        ? "0107_canonical_audit_evidence"
        : "0108_invoice_source_allocations_and_advances",
    missingKnownMigrationTags:
      phase === "pre" ? ["0108_invoice_source_allocations_and_advances"] : [],
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: opaqueRows,
    excludedMigration0100Present: false,
    totalJournalRows: phase === "pre" ? 109 : 110,
  };
}

function backupEvidence() {
  const receipt = createArtifact({
    schemaVersion:
      "site-logbook.production-exact-0107-backup-restore-receipt/v1",
    kind: "site-logbook-production-exact-0107-backup-restore-receipt",
    decision: "PASS",
    receiptStorageId: "exact-0107-backup-restore-receipt.json",
    sourceSha: SOURCE_SHA,
    sourceInventorySha256:
      "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
    backupArtifactStorageId: "objects/backups/exact-0107.pgcustom.enc",
    backupArtifactSha256: `sha256:${"2".repeat(64)}`,
    backupArtifactBytes: 8192,
    backupEncryptionFormat: "mve1",
    backupCompletedAt: "2026-08-24T18:00:00.000Z",
    restoreVerifiedAt: "2026-08-24T18:02:00.000Z",
    restoreInventorySha256:
      "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
    sourceTableCountsSha256: TABLE_COUNTS_SHA256,
    restoreTableCountsSha256: TABLE_COUNTS_SHA256,
    restoreDatabaseIsDisposable: true,
    runtimeRole: "site_logbook_runtime",
    writersStoppedBeforeAt: "2026-08-24T17:59:00.000Z",
    writersStoppedAfterAt: "2026-08-24T18:03:00.000Z",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
  const reference = createReference({
    receiptStorageId: "exact-0107-backup-restore-receipt.json",
    receiptCanonical: receipt.canonical,
  });
  return { receipt, reference };
}

function backup(overrides: Partial<BackupLog> = {}): BackupLog {
  return {
    id: 41,
    filename: "exact-0107.pgcustom",
    objectPath: "/objects/backups/exact-0107.pgcustom.enc",
    sizeBytes: 8192,
    status: "success",
    trigger: "manual",
    error: null,
    createdBy: "production-exact-0107-invoice-backup",
    createdAt: new Date("2026-08-24T18:00:00.000Z"),
    sha256: "2".repeat(64),
    encryptionFormat: "mve1",
    encryptionKeyId: "production-backup-key",
    restoredAt: null,
    restoreTestedAt: new Date("2026-08-24T18:02:00.000Z"),
    restoreStatus: "ok",
    restoreError: null,
    restoreDurationMs: 120_000,
    restoreVerifiedTables: { ...TABLE_COUNTS },
    ...overrides,
  };
}

function config(mode: "inspect" | "restore" = "restore") {
  const evidence = backupEvidence();
  return {
    mode,
    sourceSha: SOURCE_SHA,
    migrationsDirectory: "/app/migrations",
    evidenceDirectory: "/evidence",
    backupReceiptCanonical: evidence.receipt.canonical,
    backupReferenceCanonical: evidence.reference.canonical,
    rolePreconditionCanonical: rolePreconditionCanonical(),
    stoppedWritersProofCanonical: stoppedWritersProofCanonical(),
    backupId: 41,
    databaseName: "admin",
    sessionUser: "admin",
    migratorRole: "site_logbook_migrator",
    runtimeRole: "site_logbook_runtime",
    reason: "RESTORE_REQUIRED_0108_MIGRATION_COMMIT_OUTCOME_UNKNOWN",
    approvedAt: mode === "restore" ? "2026-08-24T18:10:00.000Z" : undefined,
  } as const;
}

function stopped(observedAt: string) {
  return {
    observedAt,
    runtimeRole: "site_logbook_runtime",
    otherClientSessions: 0 as const,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const restore = vi.fn(async () => undefined);
  const persistExclusive = vi.fn(async () => undefined);
  const readInventory = vi
    .fn()
    .mockResolvedValueOnce(inventory("post"))
    .mockResolvedValueOnce(inventory("pre"));
  const assertWritersStopped = vi
    .fn()
    .mockResolvedValueOnce(stopped("2026-08-24T18:09:00.000Z"))
    .mockResolvedValueOnce(stopped("2026-08-24T18:12:00.000Z"));
  const clock = [
    "2026-08-24T18:10:01.000Z",
    "2026-08-24T18:10:02.000Z",
    "2026-08-24T18:11:00.000Z",
  ];
  return {
    withMigrationLock: async <T>(
      operation: (lockBackendPid: number) => Promise<T>,
    ) => operation(321),
    readInventory,
    assertWritersStopped,
    readBackup: vi.fn(async () => backup()),
    sealApplicationDatabasePool: vi.fn(async () => undefined),
    restore,
    readPostRestoreTableCountsSha256: vi.fn(async () => TABLE_COUNTS_SHA256),
    readPostRestoreRoleProjectionCanonical: vi.fn(async () => "{}\n"),
    persistExclusive,
    now: vi.fn(() => new Date(clock.shift() ?? "2026-08-24T18:11:01.000Z")),
    ...overrides,
  };
}

describe("production exact-0107 attended restore runner", () => {
  it("keeps database credentials out of pg_restore argv and unrelated secrets out of its environment", () => {
    const boundary = productionRestoreProcessBoundary(
      "postgresql://admin:p%40ss@postgres:5432/admin?sslmode=require",
      "site_logbook_migrator",
      {
        PATH: "/reviewed/bin",
        DATABASE_URL: "postgresql://admin:do-not-copy@production/admin",
        S3_SECRET_ACCESS_KEY: "do-not-copy",
        BACKUP_ENCRYPTION_KEYRING: "do-not-copy",
      },
    );
    expect(boundary.databaseArgument).toBe(
      "postgresql://admin@postgres:5432/admin?sslmode=require",
    );
    expect(boundary.databaseArgument).not.toContain("p%40ss");
    expect(boundary.environment).toEqual({
      PATH: "/reviewed/bin",
      PGOPTIONS: "-c role=site_logbook_migrator",
      PGPASSWORD: "p@ss",
    });
    expect(boundary.environment).not.toHaveProperty("DATABASE_URL");
    expect(boundary.environment).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
    expect(boundary.environment).not.toHaveProperty(
      "BACKUP_ENCRYPTION_KEYRING",
    );
  });

  it("keeps inspection non-mutating and reports whether exact-0108 requires restore", async () => {
    const deps = dependencies();
    const result = await runProductionExact0107Restore(config("inspect"), deps);
    expect(result).toMatchObject({
      decision: "RESTORE_REQUIRED_EXACT_0108_OBSERVED",
      restoreRequired: true,
      authorizesProductionRestore: false,
      productionRestorePerformed: false,
      authorizesApplicationStart: false,
    });
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.persistExclusive).not.toHaveBeenCalled();
  });

  it("persists intent first, restores as the migrator owner, verifies exact-0107 and stores a non-start receipt", async () => {
    const deps = dependencies();
    const result = await runProductionExact0107Restore(config(), deps);
    expect(result).toMatchObject({
      decision: "EXACT_0107_PRODUCTION_RESTORE_RECEIPT_DURABLE",
      productionRestorePerformed: true,
      authorizesMigrationRetry: false,
      authorizesApplicationStart: false,
    });
    expect(deps.restore).toHaveBeenCalledWith(
      41,
      expect.objectContaining({
        restoreRole: "site_logbook_migrator",
        runtimeRole: "site_logbook_runtime",
        preRestoreCleanup: "invoice-0108",
        updateBackupLogAfterRestore: false,
        verifiedBackup: expect.objectContaining({ id: 41 }),
      }),
    );
    expect(deps.persistExclusive.mock.calls.map(([name]) => name)).toEqual([
      "exact-0107-attended-production-restore-intent.json",
      "exact-0107-attended-production-restore-receipt.json",
    ]);
    expect(deps.persistExclusive.mock.invocationCallOrder[0]).toBeLessThan(
      deps.restore.mock.invocationCallOrder[0],
    );
    const receipt = JSON.parse(deps.persistExclusive.mock.calls[1][1]);
    expect(receipt.postRestoreInventory.knownAppliedMigrations).toBe(107);
    expect(receipt.postRestoreTableCountsSha256).toBe(TABLE_COUNTS_SHA256);
    expect(receipt.productionRestorePerformed).toBe(true);
    expect(receipt.authorizesApplicationStart).toBe(false);
  });

  it("forbids destructive restore when live inventory is already exact-0107", async () => {
    const deps = dependencies({
      readInventory: vi.fn(async () => inventory("pre")),
    });
    await expect(
      runProductionExact0107Restore(config(), deps),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_RESTORE_NOT_REQUIRED",
    });
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.persistExclusive).not.toHaveBeenCalled();
  });

  it("rejects substituted backup custody before durable intent or restore", async () => {
    const deps = dependencies({
      readBackup: vi.fn(async () => backup({ sha256: "9".repeat(64) })),
    });
    await expect(
      runProductionExact0107Restore(config(), deps),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_RESTORE_BACKUP_INVALID",
    });
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.persistExclusive).not.toHaveBeenCalled();
  });

  it("rejects active runtime writers before durable intent or restore", async () => {
    const deps = dependencies({
      assertWritersStopped: vi.fn(async () => ({
        observedAt: "2026-08-24T18:09:00.000Z",
        runtimeRole: "site_logbook_runtime",
        otherClientSessions: 1,
      })),
    });
    await expect(
      runProductionExact0107Restore(config(), deps),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_RESTORE_WRITERS_RUNNING",
    });
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.persistExclusive).not.toHaveBeenCalled();
  });

  it("does not restore when the durable no-clobber intent cannot be stored", async () => {
    const persistExclusive = vi.fn(async () => {
      throw new Error("intent already exists");
    });
    const deps = dependencies({ persistExclusive });
    await expect(runProductionExact0107Restore(config(), deps)).rejects.toThrow(
      "intent already exists",
    );
    expect(persistExclusive).toHaveBeenCalledTimes(1);
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("fails terminally after restore if all-table post-state differs and does not emit PASS receipt", async () => {
    const deps = dependencies({
      readPostRestoreTableCountsSha256: vi.fn(
        async () => `sha256:${"8".repeat(64)}`,
      ),
    });
    await expect(
      runProductionExact0107Restore(config(), deps),
    ).rejects.toMatchObject({
      code: "PRODUCTION_EXACT_0107_RESTORE_TABLE_COUNTS_INVALID",
    });
    expect(deps.restore).toHaveBeenCalledTimes(1);
    expect(deps.persistExclusive.mock.calls.map(([name]) => name)).toEqual([
      "exact-0107-attended-production-restore-intent.json",
    ]);
  });
});
