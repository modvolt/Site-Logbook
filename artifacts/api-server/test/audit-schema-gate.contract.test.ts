import {
  AUDIT_SCHEMA_MIGRATIONS,
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION,
  type AuditSchemaInventorySummary,
  type AuditSchemaApplySummary,
  type AuditSchemaPreflightEnvironment,
  type AuditSchemaPreflightSummary,
  type AuditSchemaSteadyStateSummary,
} from "@workspace/db/audit-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";
import { describe, expect, it, vi } from "vitest";
import { runAuditSchemaGate } from "../src/audit-schema-gate";

const SHA = "a".repeat(40);
const INPUT_SHA = "b".repeat(64);
const BACKUP_SHA = "9".repeat(64);
const SCHEMA_SHA = `sha256:${"8".repeat(64)}`;
const OPAQUE_SHA =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function environment(): NodeJS.ProcessEnv {
  return {
    STAGING_AUDIT_SCHEMA_ACTION: "apply-0107",
    AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION,
    AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256: SCHEMA_SHA,
    AUDIT_SCHEMA_LINEAGE_MODE: "clean",
    AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON: "[]",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_ENVIRONMENT_ID: "site-logbook-staging",
    BUILD_SHA: SHA,
    STAGING_BUILD_SHA: SHA,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: SHA,
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    STAGING_BACKUP_EVIDENCE_ID: "91",
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "24",
    STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256: INPUT_SHA,
    STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256: BACKUP_SHA,
    STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES: String(256 * 1024 * 1024),
    STAGING_EXACT_0106_BACKUP_SIZE_BYTES: "8192",
    DATABASE_URL:
      "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
    MIGRATIONS_DIR: "lib/db/migrations",
  };
}

function lineage(decision: "READY_0106" | "ALREADY_0107", count: 106 | 107) {
  return {
    decision,
    knownAppliedMigrations: count,
    latestKnownAppliedTag:
      count === 106
        ? AUDIT_SCHEMA_MIGRATIONS.predecessor.tag
        : AUDIT_SCHEMA_MIGRATIONS.target.tag,
    missingKnownToPredecessor: 0,
    knownAppliedRowsSha256:
      count === 106
        ? AUDIT_SCHEMA_KNOWN_ROWS_SHA256.predecessor
        : AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target,
    opaqueLegacyRowCount: 0 as const,
    opaqueLegacyRowsSha256: OPAQUE_SHA,
    mode: "clean" as const,
    knownExpectedMigrations: 107 as const,
    opaqueLegacyMeaningInferred: false as const,
    excludedMigration0100Present: false as const,
  };
}

const genesisSchema = {
  targetTag: "0107_canonical_audit_evidence" as const,
  targetSqlSha256: `sha256:${AUDIT_SCHEMA_MIGRATIONS.target.hash}`,
  targetSnapshotSha256:
    "sha256:4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb",
  auditEventRows: 0,
  auditOutboxRows: 0,
  auditHeadRows: 1,
  expectedSchemaFingerprintSha256: SCHEMA_SHA,
  schemaFingerprintSha256: SCHEMA_SHA,
};

const backupIntegrity = {
  schemaVersion: "site-logbook.audit-schema-backup-integrity/v1" as const,
  verifiedTableNames: ["public.users"],
  verifiedTableCounts: { "public.users": 1 },
  verifiedTableCountsSha256: `sha256:${"f".repeat(64)}`,
  backupRowBindingSha256: `sha256:${"7".repeat(64)}`,
};

function postSummary(
  mode: "pre" | "post" = "post",
): AuditSchemaPreflightSummary {
  const isPre = mode === "pre";
  return {
    schemaVersion: "site-logbook.audit-schema-preflight/v1",
    kind: "audit-schema-preflight",
    decision: isPre ? "READY_0106" : "ALREADY_0107",
    mode,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineage(isPre ? "READY_0106" : "ALREADY_0107", isPre ? 106 : 107),
    schema: isPre ? { ...genesisSchema, auditHeadRows: 0 } : genesisSchema,
    backupEvidenceId: 91,
    backupRestoreAgeHours: 0.1,
    backupEvidence: {
      id: 91,
      sizeBytes: 8192,
      encryptedBackupSha256: `sha256:${"c".repeat(64)}`,
      encryptionFormat: "mve1",
      encryptionKeyIdFingerprint: `sha256:${"d".repeat(64)}`,
      objectPathFingerprint: `sha256:${"e".repeat(64)}`,
      createdAt: "2026-08-12T10:00:00.000Z",
      restoreTestedAt: "2026-08-12T10:01:00.000Z",
      checkedAt: "2026-08-12T10:07:00.000Z",
      restoreAgeHours: 0.1,
      restoreDurationMs: 60_000,
      verifiedTableCount: 117,
      verifiedTablesSha256: `sha256:${"f".repeat(64)}`,
      destructiveRestorePerformed: false,
    },
    backupIntegrity,
    authorizesApplicationStart: false,
  };
}

function ready0106(): AuditSchemaInventorySummary {
  return {
    schemaVersion: "site-logbook.audit-schema-inventory/v1",
    kind: "audit-schema-inventory",
    decision: "READY_0106",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineage("READY_0106", 106),
    schema: { ...genesisSchema, auditHeadRows: 0 },
    backupIntegrity,
    backupEvidenceId: 91,
    backupRestoreAgeHours: 0.05,
    authorizesApplicationStart: false,
  };
}

function steady(): AuditSchemaSteadyStateSummary {
  return {
    schemaVersion: "site-logbook.audit-schema-steady-state/v1",
    kind: "audit-schema-steady-state",
    decision: "ALREADY_0107",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineage("ALREADY_0107", 107),
    schema: genesisSchema,
    authorizesApplicationStart: true,
  };
}

function migration(newlyApplied: 0 | 1 | 2): AuditSchemaApplySummary {
  return {
    expectedCount: 107,
    latestExpectedTag: AUDIT_SCHEMA_MIGRATIONS.target.tag,
    newlyApplied: newlyApplied as 0 | 1,
    knownAppliedBefore: newlyApplied === 1 ? 106 : 107,
    knownAppliedAfter: 107,
    schemaFingerprintSha256: SCHEMA_SHA,
  } as AuditSchemaApplySummary;
}

describe("audit schema exact 0106 to 0107 gate", () => {
  it("applies only one target migration and emits bound start-authorizing evidence", async () => {
    const modes: string[] = [];
    const preflight = vi.fn(async (config: AuditSchemaPreflightEnvironment) => {
      modes.push(config.mode);
      if (modes.length === 1) {
        throw new ExternalSchemaPreflightError(
          "APPLIED_COUNT_MISMATCH",
          "Database is exact 0106.",
        );
      }
      return postSummary(config.mode);
    });
    const result = await runAuditSchemaGate(environment(), {
      inventory: vi.fn(async () => ready0106()),
      preflight,
      migrate: vi.fn(async () => migration(1)),
      steadyState: vi.fn(async () => steady()),
    });
    expect(modes).toEqual(["post", "pre", "post"]);
    expect(result.mode).toBe("APPLIED");
    expect(result.evidence).toMatchObject({
      schemaVersion: "site-logbook.audit-schema-gate/v1",
      kind: "audit-schema-gate",
      mode: "APPLIED",
      decision: "ALREADY_0107",
      newlyApplied: 1,
      migration: {
        idx: 107,
        when: 1786484628859,
        tag: "0107_canonical_audit_evidence",
        sha256:
          "sha256:c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
      },
      transition: {
        inputSha256: `sha256:${INPUT_SHA}`,
        sourceBackupExecutionSha256: `sha256:${BACKUP_SHA}`,
        backupSizeBytes: 8192,
      },
      authorizesApplicationStart: true,
    });
  });

  it("permits exact zero-apply race and exact already-0107 replay only after postflight", async () => {
    let calls = 0;
    const race = await runAuditSchemaGate(environment(), {
      inventory: vi.fn(async () => ready0106()),
      preflight: vi.fn(async (config) => {
        calls += 1;
        if (calls === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "0106",
          );
        }
        return postSummary(config.mode);
      }),
      migrate: vi.fn(async () => migration(0)),
      steadyState: vi.fn(async () => steady()),
    });
    expect(race.mode).toBe("NOOP");
    expect(race.evidence.before.knownAppliedMigrations).toBe(106);

    const migrate = vi.fn(async () => migration(1));
    const replay = await runAuditSchemaGate(environment(), {
      preflight: vi.fn(async () => postSummary()),
      steadyState: vi.fn(async () => steady()),
      migrate,
    });
    expect(replay.mode).toBe("NOOP");
    expect(replay.evidence.before.knownAppliedMigrations).toBe(107);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("fails closed on baseline, multi-apply, backup drift and non-genesis post-state", async () => {
    const postMismatch = vi.fn(async () => {
      throw new ExternalSchemaPreflightError("APPLIED_COUNT_MISMATCH", "0105");
    });
    await expect(
      runAuditSchemaGate(environment(), {
        inventory: vi.fn(async () => ({
          ...ready0106(),
          decision: "BASELINE_0106_REQUIRED",
          lineage: {
            ...ready0106().lineage,
            decision: "BASELINE_0106_REQUIRED",
            knownAppliedMigrations: 105,
            missingKnownToPredecessor: 1,
          },
        })),
        preflight: postMismatch,
      }),
    ).rejects.toMatchObject({ code: "BASELINE_0106_REQUIRED" });

    let count = 0;
    await expect(
      runAuditSchemaGate(environment(), {
        inventory: vi.fn(async () => ready0106()),
        preflight: vi.fn(async (config) => {
          count += 1;
          if (count === 1) {
            throw new ExternalSchemaPreflightError(
              "APPLIED_COUNT_MISMATCH",
              "0106",
            );
          }
          return postSummary(config.mode);
        }),
        migrate: vi.fn(async () => migration(2)),
      }),
    ).rejects.toMatchObject({ code: "AUDIT_MIGRATION_APPLY_COUNT_INVALID" });

    await expect(
      runAuditSchemaGate(
        { ...environment(), STAGING_EXACT_0106_BACKUP_SIZE_BYTES: "8193" },
        {
          preflight: vi.fn(async () => postSummary()),
          steadyState: vi.fn(async () => steady()),
        },
      ),
    ).rejects.toMatchObject({ code: "AUDIT_BACKUP_EXECUTION_BINDING_INVALID" });

    await expect(
      runAuditSchemaGate(environment(), {
        preflight: vi.fn(async () => ({
          ...postSummary(),
          schema: { ...genesisSchema, auditEventRows: 1 },
        })),
        steadyState: vi.fn(async () => ({
          ...steady(),
          schema: { ...genesisSchema, auditEventRows: 1 },
        })),
      }),
    ).rejects.toMatchObject({ code: "AUDIT_TRANSITION_STATE_NOT_GENESIS" });
  });

  it("keeps steady-0107 read-only with null transition and no migration", async () => {
    const migrate = vi.fn(async () => migration(1));
    const result = await runAuditSchemaGate(
      { ...environment(), STAGING_AUDIT_SCHEMA_ACTION: "steady-0107" },
      { steadyState: vi.fn(async () => steady()), migrate },
    );
    expect(result.evidence.transition).toBeNull();
    expect(result.evidence.authorizesApplicationStart).toBe(true);
    expect(migrate).not.toHaveBeenCalled();
  });
});
