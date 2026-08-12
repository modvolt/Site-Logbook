import type { BackupLog } from "@workspace/db";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  auditSchemaBackupRowBindingSha256,
  type AuditSchemaEnvironment,
} from "@workspace/db/audit-schema-preflight";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BackupSourceSnapshotEvidence,
  CreatedBackupLog,
} from "../src/lib/backup";

let runStagingExact0106Backup: typeof import("../src/audit-schema-exact-0106-backup").runStagingExact0106Backup;
let ACTION: string;
let CONFIRMATION: string;
let MAX_BYTES: number;
let withExportedBackupSnapshot: typeof import("../src/lib/backup").withExportedBackupSnapshot;
let readBackupDump: typeof import("../src/lib/backup").readBackupDump;
let readBackupSnapshotTableCounts: typeof import("../src/lib/backup").readBackupSnapshotTableCounts;
let runPgDump: typeof import("../src/lib/backup").runPgDump;
let raceBackupRestoreOperation: typeof import("../src/lib/backup").raceBackupRestoreOperation;
let persistBackupRestoreTestOutcome: typeof import("../src/lib/backup").persistBackupRestoreTestOutcome;
let persistBackupCreationSuccess: typeof import("../src/lib/backup").persistBackupCreationSuccess;
let resolveBackupCreationFailure: typeof import("../src/lib/backup").resolveBackupCreationFailure;

beforeAll(async () => {
  process.env.DATABASE_URL =
    "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging";
  const module = await import("../src/audit-schema-exact-0106-backup");
  runStagingExact0106Backup = module.runStagingExact0106Backup;
  ACTION = module.STAGING_EXACT_0106_BACKUP_ACTION;
  CONFIRMATION = module.STAGING_EXACT_0106_BACKUP_CONFIRMATION;
  MAX_BYTES = module.STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES;
  ({
    readBackupDump,
    readBackupSnapshotTableCounts,
    persistBackupRestoreTestOutcome,
    persistBackupCreationSuccess,
    resolveBackupCreationFailure,
    raceBackupRestoreOperation,
    runPgDump,
    withExportedBackupSnapshot,
  } = await import("../src/lib/backup"));
}, 30_000);

const SHA = "a".repeat(40);
const TABLE_COUNTS = Object.freeze({
  "drizzle.__drizzle_migrations": 106,
  "public.audit_backup_fixture": 0,
  "public.users": 10,
});
const TABLE_COUNTS_SHA256 =
  "sha256:2aefa85dd5e2a49d4fde1e3f75a2006b53af2e6a0070f722e9671a97edd928b3";
const SOURCE_SNAPSHOT: BackupSourceSnapshotEvidence = Object.freeze({
  schemaVersion: "site-logbook.backup-source-table-counts/v1",
  tableNames: Object.freeze(Object.keys(TABLE_COUNTS)),
  tableCounts: TABLE_COUNTS,
  tableCountsSha256: TABLE_COUNTS_SHA256,
});

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
      expectedSchemaFingerprintSha256: `sha256:${"d".repeat(64)}`,
      schemaFingerprintSha256: `sha256:${"d".repeat(64)}`,
    },
    backupIntegrity: backupEvidenceId === 92 ? backupIntegrity(backup()) : null,
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
    restoreVerifiedTables: { ...TABLE_COUNTS },
    ...overrides,
  };
}

function createdBackup(
  overrides: Partial<CreatedBackupLog> = {},
): CreatedBackupLog {
  return {
    ...backup(),
    restoreTestedAt: null,
    restoreStatus: null,
    restoreDurationMs: null,
    restoreVerifiedTables: null,
    sourceSnapshotEvidence: SOURCE_SNAPSHOT,
    ...overrides,
  };
}

function backupIntegrity(row: BackupLog) {
  return {
    schemaVersion: "site-logbook.audit-schema-backup-integrity/v1" as const,
    verifiedTableNames: Object.keys(TABLE_COUNTS),
    verifiedTableCounts: { ...TABLE_COUNTS },
    verifiedTableCountsSha256: TABLE_COUNTS_SHA256,
    backupRowBindingSha256: auditSchemaBackupRowBindingSha256({
      backupId: row.id,
      filename: row.filename,
      objectPath: row.objectPath ?? "",
      sizeBytes: Number(row.sizeBytes),
      encryptedBackupSha256: `sha256:${row.sha256}`,
      encryptionFormat: "mve1",
      encryptionKeyId: row.encryptionKeyId ?? "",
      status: "success",
      trigger: "manual",
      createdBy: "staging-exact-0106-audit-backup",
      createdAt: row.createdAt.toISOString(),
      restoreTestedAt: row.restoreTestedAt?.toISOString() ?? "",
      restoreDurationMs: Number(row.restoreDurationMs),
      restoreStatus: "ok",
      verifiedTableCountsSha256: TABLE_COUNTS_SHA256,
    }),
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const create = vi.fn(async () => createdBackup());
  const restoreTest = vi.fn(async () => backup());
  const readBackup = vi.fn(async () => backup());
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
    readBackup,
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
      captureSourceSnapshotTableCounts: true,
    });
    expect(deps.restoreTest).toHaveBeenCalledWith(92, {
      maxPayloadBytes: MAX_BYTES,
      expectedSourceSnapshotEvidence: SOURCE_SNAPSHOT,
    });
    expect(result).toMatchObject({
      verifiedTableNames: Object.keys(TABLE_COUNTS),
      sourceTableCounts: TABLE_COUNTS,
      restoredTableCounts: TABLE_COUNTS,
      verifiedTableCountsSha256: TABLE_COUNTS_SHA256,
      backupRowBindingSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
      backup({
        restoreVerifiedTables: {
          ...TABLE_COUNTS,
          "public.users": 9,
        },
      }),
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

  it("rejects source snapshot absence and mutable backup-log identity tamper", async () => {
    await expect(
      runStagingExact0106Backup(
        env(),
        dependencies({
          create: vi.fn(async () => ({
            ...createdBackup(),
            sourceSnapshotEvidence: undefined,
          })),
        }),
      ),
    ).rejects.toMatchObject({
      code: "EXACT_0106_BACKUP_SOURCE_SNAPSHOT_MISSING",
    });

    await expect(
      runStagingExact0106Backup(
        env(),
        dependencies({
          readBackup: vi.fn(async () => backup({ sha256: "c".repeat(64) })),
        }),
      ),
    ).rejects.toMatchObject({ code: "EXACT_0106_BACKUP_RESTORE_INVALID" });
  });
});

describe("exported backup snapshot coordination", () => {
  function fakeClient() {
    const commands: string[] = [];
    let ended = false;
    return {
      commands,
      get ended() {
        return ended;
      },
      client: {
        connect: vi.fn(async () => undefined),
        query: vi.fn(async (text: string) => {
          commands.push(text);
          if (text.includes("pg_export_snapshot")) {
            return { rows: [{ snapshot_id: "00000003-0000001B-1" }] };
          }
          if (text.includes("c.relkind IN ('p', 'm', 'f')")) {
            return { rows: [] };
          }
          if (text.includes("FROM pg_class")) {
            return {
              rows: [{ schema_name: "public", table_name: "users" }],
            };
          }
          if (text.includes("count(*)")) return { rows: [{ count: "10" }] };
          return { rows: [] };
        }),
        end: vi.fn(async () => {
          ended = true;
        }),
      },
    };
  }

  it("holds one repeatable-read exported snapshot through the dump operation", async () => {
    const fake = fakeClient();
    const result = await withExportedBackupSnapshot(
      "postgres://unused",
      async (snapshotId, evidence) => {
        expect(snapshotId).toBe("00000003-0000001B-1");
        expect(evidence).toMatchObject({
          tableNames: ["public.users"],
          tableCounts: { "public.users": 10 },
          tableCountsSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        return "dump-bytes";
      },
      { clientFactory: () => fake.client as never },
    );
    expect(result.value).toBe("dump-bytes");
    expect(fake.commands[0]).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(fake.commands.at(-1)).toBe("COMMIT");
    expect(fake.commands).not.toContain("ROLLBACK");
    expect(fake.ended).toBe(true);
  });

  it("rolls back and closes the snapshot holder when dump work fails", async () => {
    const fake = fakeClient();
    await expect(
      withExportedBackupSnapshot(
        "postgres://unused",
        async () => {
          throw new Error("pg_dump failed");
        },
        { clientFactory: () => fake.client as never },
      ),
    ).rejects.toThrow("pg_dump failed");
    expect(fake.commands.at(-1)).toBe("ROLLBACK");
    expect(fake.commands).not.toContain("COMMIT");
    expect(fake.ended).toBe(true);
  });

  it("aborts a hung source snapshot connection with bounded cleanup", async () => {
    const controller = new AbortController();
    const primary = new Error("source connect deadline");
    let ended = false;
    const operation = withExportedBackupSnapshot(
      "postgres://unused",
      async () => "unreachable",
      {
        signal: controller.signal,
        queryTimeoutMs: 100,
        clientFactory: () =>
          ({
            connect: vi.fn(() => new Promise(() => undefined)),
            query: vi.fn(),
            end: vi.fn(async () => {
              ended = true;
            }),
          }) as never,
      },
    );
    controller.abort(primary);
    await expect(operation).rejects.toBe(primary);
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it("closes the snapshot holder when source connection fails immediately", async () => {
    const primary = new Error("source connect refused");
    let ended = false;
    await expect(
      withExportedBackupSnapshot(
        "postgres://unused",
        async () => "unreachable",
        {
          clientFactory: () =>
            ({
              connect: vi.fn(async () => {
                throw primary;
              }),
              query: vi.fn(),
              end: vi.fn(async () => {
                ended = true;
              }),
            }) as never,
        },
      ),
    ).rejects.toBe(primary);
    expect(ended).toBe(true);
  });

  it("aborts a hung source snapshot count without invoking pg_dump", async () => {
    const controller = new AbortController();
    const primary = new Error("source count deadline");
    let ended = false;
    const dumpOperation = vi.fn(async () => "unreachable");
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_export_snapshot")) {
        return { rows: [{ snapshot_id: "00000003-0000001B-1" }] };
      }
      if (text.includes("c.relkind IN ('p', 'm', 'f')")) return { rows: [] };
      if (text.includes("FROM pg_class")) {
        return { rows: [{ schema_name: "public", table_name: "users" }] };
      }
      if (text.includes("count(*)")) return new Promise(() => undefined);
      return { rows: [] };
    });
    const pending = withExportedBackupSnapshot(
      "postgres://unused",
      dumpOperation,
      {
        signal: controller.signal,
        queryTimeoutMs: 100,
        clientFactory: () =>
          ({
            connect: vi.fn(async () => undefined),
            query,
            end: vi.fn(async () => {
              ended = true;
            }),
          }) as never,
      },
    );
    await vi.waitFor(() =>
      expect(
        query.mock.calls.some(([text]) => String(text).includes("count(*)")),
      ).toBe(true),
    );
    controller.abort(primary);
    await expect(pending).rejects.toBe(primary);
    expect(dumpOperation).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it.each([
    ["unlogged table", "r", "u", false],
    ["materialized view", "m", "p", false],
    ["partition", "r", "p", true],
  ])(
    "fails closed for an unsupported %s",
    async (_, kind, persistence, partition) => {
      const fake = fakeClient();
      fake.client.query = vi.fn(async (text: string) => {
        fake.commands.push(text);
        if (text.includes("pg_export_snapshot")) {
          return { rows: [{ snapshot_id: "00000003-0000001B-1" }] };
        }
        if (text.includes("c.relkind IN ('p', 'm', 'f')")) {
          return {
            rows: [
              {
                schema_name: "public",
                relation_name: "unsupported_relation",
                relation_kind: kind,
                persistence,
                is_partition: partition,
              },
            ],
          };
        }
        return { rows: [] };
      }) as never;
      await expect(
        withExportedBackupSnapshot(
          "postgres://unused",
          async () => "unreachable",
          { clientFactory: () => fake.client as never },
        ),
      ).rejects.toThrow(/does not support dump-backed/i);
      expect(fake.commands.at(-1)).toBe("ROLLBACK");
      expect(fake.ended).toBe(true);
    },
  );
});

function fakePgDumpProcess(
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[] = [],
  closeCode = 0,
  autoClose = true,
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    for (const chunk of stdoutChunks) child.stdout.emit("data", chunk);
    for (const chunk of stderrChunks) child.stderr.emit("data", chunk);
    if (autoClose) child.emit("close", closeCode);
  });
  return child;
}

describe("bounded pg_dump and restore operations", () => {
  it("threads AbortSignal through S3 and destroys GCS streams on abort", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/lib/objectStorage.ts"),
      "utf8",
    );
    expect(source).toContain(
      "abortSignal === undefined ? undefined : { abortSignal }",
    );
    expect(source).toContain("file.getMetadata(),");
    expect(source).toContain("() => body.destroy()");
    expect(source).toContain(
      "if (options.signal?.aborted) throw abortReason(options.signal);",
    );
  });

  it("passes the exact exported snapshot and accepts the exact byte ceiling", async () => {
    const child = fakePgDumpProcess([Buffer.from("1234"), Buffer.from("5678")]);
    const spawnProcess = vi.fn(() => child as never);
    await expect(
      runPgDump("postgres://unused", 8, "00000003-0000001B-1", {
        spawnProcess: spawnProcess as never,
      }),
    ).resolves.toEqual(Buffer.from("12345678"));
    const args = spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--snapshot=00000003-0000001B-1");
    expect(args).not.toContain("-f");
  });

  it("kills pg_dump while streaming one byte above the ceiling", async () => {
    const child = fakePgDumpProcess([Buffer.from("123456789")], [], 0, false);
    const operation = runPgDump("postgres://unused", 8, undefined, {
      spawnProcess: vi.fn(() => child as never) as never,
    });
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(operation).rejects.toThrow(
      /exceeds the approved 8-byte payload ceiling/i,
    );
  });

  it("kills and joins a hung pg_dump when the end-to-end signal aborts", async () => {
    const controller = new AbortController();
    const primary = new Error("source dump deadline");
    const child = fakePgDumpProcess([], [], 0, false);
    const operation = runPgDump("postgres://unused", 8, undefined, {
      signal: controller.signal,
      spawnProcess: vi.fn(() => child as never) as never,
    });
    controller.abort(primary);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(operation).rejects.toBe(primary);
  });

  it("caps pg_dump stderr before reporting a child failure", async () => {
    const child = fakePgDumpProcess([], [Buffer.alloc(96 * 1024, 0x78)], 1);
    const error = await runPgDump("postgres://unused", 8, undefined, {
      spawnProcess: vi.fn(() => child as never) as never,
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message.length).toBeLessThan(66 * 1024);
  });

  it("aborts a hung object download and propagates its primary deadline error", async () => {
    const controller = new AbortController();
    const primary = new Error("restore download deadline");
    const operation = readBackupDump(backup(), {
      signal: controller.signal,
      storage: {
        getPrivateObjectBuffer: vi.fn(
          () => new Promise<Buffer>(() => undefined),
        ),
      },
    });
    controller.abort(primary);
    await expect(operation).rejects.toBe(primary);
  });

  it("aborts a hung exact table-count query", async () => {
    const controller = new AbortController();
    const primary = new Error("restore count deadline");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ schema_name: "public", table_name: "users" }],
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const operation = readBackupSnapshotTableCounts({ query } as never, {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(primary);
    await expect(operation).rejects.toBe(primary);
  });

  it("aborts a hung restore child and invokes its termination callback", async () => {
    const controller = new AbortController();
    const primary = new Error("pg_restore deadline");
    const terminate = vi.fn();
    const operation = raceBackupRestoreOperation(
      new Promise<void>(() => undefined),
      controller.signal,
      terminate,
    );
    controller.abort(primary);
    await expect(operation).rejects.toBe(primary);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("prevents a late success CAS from overwriting timeout failure evidence", async () => {
    let status = "pending";
    let releaseSuccess!: () => void;
    const successGate = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    const poolFactory = (delay: boolean) => () => ({
      query: vi.fn(async (_text: string, values: readonly unknown[]) => {
        if (delay) await successGate;
        const outcome = String(values[1]);
        const allowed = values[6] as string[];
        if (!allowed.includes(status)) return { rows: [], rowCount: 0 };
        status = outcome;
        return { rows: [{ id: 92 }], rowCount: 1 };
      }),
      end: vi.fn(async () => undefined),
    });
    const common = {
      databaseUrl: "postgres://unused",
      backupId: 92,
      testedAt: new Date("2026-08-12T12:00:00.000Z"),
      durationMs: 5,
      deadlineAt: Date.now() + 1_000,
      timeoutMs: 1_000,
    };
    const lateSuccess = persistBackupRestoreTestOutcome(
      {
        ...common,
        outcome: "ok",
        verifiedTables: { "public.users": 10 },
        error: null,
      },
      { poolFactory: poolFactory(true) as never },
    );
    await Promise.resolve();
    await expect(
      persistBackupRestoreTestOutcome(
        {
          ...common,
          outcome: "failed",
          verifiedTables: null,
          error: "deadline",
          overrideTimedOutSuccess: true,
        },
        { poolFactory: poolFactory(false) as never },
      ),
    ).resolves.toBe(true);
    releaseSuccess();
    await expect(lateSuccess).resolves.toBe(false);
    expect(status).toBe("failed");
  });

  it("prevents a late backup-create success CAS after failure won the deadline", async () => {
    let status = "running";
    let releaseSuccess!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    const poolFactory = () => ({
      query: vi.fn(async () => {
        await gate;
        if (status !== "running") return { rows: [], rowCount: 0 };
        status = "success";
        return { rows: [{ id: 92 }], rowCount: 1 };
      }),
      end: vi.fn(async () => undefined),
    });
    const lateSuccess = persistBackupCreationSuccess(
      {
        databaseUrl: "postgres://unused",
        backupId: 92,
        objectPath: "/objects/backups/test.enc",
        sizeBytes: 10,
        sha256: "b".repeat(64),
        encryptionFormat: "mve1",
        encryptionKeyId: "test-key",
        deadlineAt: Date.now() + 1_000,
        timeoutMs: 1_000,
      },
      { poolFactory: poolFactory as never },
    );
    await Promise.resolve();
    status = "failed";
    releaseSuccess();
    await expect(lateSuccess).resolves.toBe(false);
    expect(status).toBe("failed");
  });

  it("keeps an exact success row authoritative when the deadline abort arrives late", async () => {
    const calls: string[] = [];
    const metadata = {
      objectPath: "/objects/backups/test.enc",
      sizeBytes: 10,
      sha256: "b".repeat(64),
      encryptionFormat: "mve1",
      encryptionKeyId: "test-key",
    };
    const poolFactory = () => ({
      query: vi.fn(async (text: string, values: readonly unknown[]) => {
        calls.push(text.trimStart().split(/\s+/, 1)[0] ?? "");
        if (text.includes("UPDATE backup_log")) {
          // The success commit won before the late abort handler could CAS.
          return { rows: [], rowCount: 0 };
        }
        expect(values).toEqual([
          92,
          metadata.objectPath,
          metadata.sizeBytes,
          metadata.sha256,
          metadata.encryptionFormat,
          metadata.encryptionKeyId,
        ]);
        return { rows: [{ id: 92 }], rowCount: 1 };
      }),
      end: vi.fn(async () => undefined),
    });

    await expect(
      resolveBackupCreationFailure(
        {
          databaseUrl: "postgres://unused",
          backupId: 92,
          error: "deadline",
          successMetadata: metadata,
          timeoutMs: 1_000,
        },
        { poolFactory: poolFactory as never },
      ),
    ).resolves.toBe("success");
    expect(calls).toEqual(["UPDATE", "SELECT"]);
  });

  it("threads one backup-create signal into snapshot, dump, upload and deadline CAS", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/lib/backup.ts"),
      "utf8",
    );
    const executeStart = source.indexOf("async function executeReservedBackup");
    const execute = source.slice(
      executeStart,
      source.indexOf("export async function createBackup", executeStart),
    );
    expect(execute).toContain("const abortController = new AbortController()");
    expect(execute).toContain("signal: abortController.signal");
    expect(execute).toContain(
      "queryTimeoutMs: Math.max(1, deadlineAt - Date.now())",
    );
    expect(execute).toContain("persistBackupCreationSuccess");
    expect(source).toContain("clock_timestamp() <= $7::timestamptz");
    expect(execute).toContain("objectStorage.deletePrivateObject(objectPath)");
    expect(execute).toContain('if (resolution === "failed" && uploadStarted)');
  });
});
