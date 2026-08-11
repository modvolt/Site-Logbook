import {
  ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION,
  type AccountingSchemaInventorySummary,
  type AccountingSchemaPreflightEnvironment,
  type AccountingSchemaPreflightSummary,
  type AccountingSchemaSteadyStateSummary,
} from "@workspace/db/accounting-schema-preflight";
import { ExternalSchemaPreflightError } from "@workspace/db/external-schema-preflight";
import type { MigrationSummary } from "@workspace/db/migrate";
import { describe, expect, it, vi } from "vitest";
import { runAccountingSchemaGate } from "../src/accounting-schema-gate";

const SHA = "a".repeat(40);
const INPUT_SHA = "b".repeat(64);
const BACKUP_SHA = "9".repeat(64);

function environment(): NodeJS.ProcessEnv {
  return {
    STAGING_ACCOUNTING_SCHEMA_ACTION: "apply-0106",
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION,
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_ENVIRONMENT_ID: "site-logbook-staging",
    BUILD_SHA: SHA,
    STAGING_BUILD_SHA: SHA,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: SHA,
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    STAGING_BACKUP_EVIDENCE_ID: "81",
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "24",
    STAGING_ACCOUNTING_DEPLOYMENT_INPUTS_SHA256: INPUT_SHA,
    STAGING_EXACT_0105_BACKUP_EXECUTION_SHA256: BACKUP_SHA,
    STAGING_EXACT_0105_BACKUP_MAX_PAYLOAD_BYTES: String(256 * 1024 * 1024),
    STAGING_EXACT_0105_BACKUP_SIZE_BYTES: "8192",
    DATABASE_URL:
      "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
    MIGRATIONS_DIR: "lib/db/migrations",
  };
}

function postSummary(): AccountingSchemaPreflightSummary {
  return {
    decision: "ALREADY_0106",
    mode: "post",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    expectedMigrations: 106,
    latestExpectedTag: "0106_graceful_frog_thor",
    accountingEvidenceRows: 0,
    externalStateRows: 0,
    backupEvidenceId: 81,
    backupRestoreAgeHours: 0.1,
    backupEvidence: {
      id: 81,
      sizeBytes: 8192,
      encryptedBackupSha256: `sha256:${"c".repeat(64)}`,
      encryptionFormat: "mve1",
      encryptionKeyIdFingerprint: `sha256:${"d".repeat(64)}`,
      objectPathFingerprint: `sha256:${"e".repeat(64)}`,
      createdAt: "2026-08-11T10:00:00.000Z",
      restoreTestedAt: "2026-08-11T10:01:00.000Z",
      checkedAt: "2026-08-11T10:07:00.000Z",
      restoreAgeHours: 0.1,
      restoreDurationMs: 60_000,
      verifiedTableCount: 114,
      verifiedTablesSha256: `sha256:${"f".repeat(64)}`,
      destructiveRestorePerformed: false,
    },
  };
}

function ready0105(): AccountingSchemaInventorySummary {
  return {
    decision: "READY_0105",
    appliedMigrations: 105,
    predecessorMigrations: 105,
    latestAppliedTag: "0105_smooth_nitro",
    missingToPredecessor: 0,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    backupEvidenceId: 81,
    backupRestoreAgeHours: 0.05,
    externalStateRows: 0,
  };
}

function migration(newlyApplied: number): MigrationSummary {
  return {
    migrationsFolder: "lib/db/migrations",
    expectedCount: 106,
    appliedBefore: 106 - newlyApplied,
    appliedAfter: 106,
    newlyApplied,
    latestExpectedTag: "0106_graceful_frog_thor",
  };
}

describe("accounting schema 0106 gate", () => {
  it("applies exactly 0106 after post-noop, inventory and preflight checks", async () => {
    const modes: string[] = [];
    const preflight = vi.fn(
      async (config: AccountingSchemaPreflightEnvironment) => {
        modes.push(config.mode);
        if (modes.length === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "Database is exact 0105.",
          );
        }
        return postSummary();
      },
    );
    const result = await runAccountingSchemaGate(environment(), {
      inventory: vi.fn(async () => ready0105()),
      preflight,
      migrate: vi.fn(async () => migration(1)),
    });
    expect(result.mode).toBe("APPLIED");
    expect(modes).toEqual(["post", "pre", "post"]);
    expect(result.evidence).toMatchObject({
      schemaGate: {
        predecessorTag: "0105_smooth_nitro",
        latestExpectedTag: "0106_graceful_frog_thor",
        expectedMigrations: 106,
        accountingEvidenceRows: 0,
        inputSha256: `sha256:${INPUT_SHA}`,
        sourceBackupExecutionSha256: `sha256:${BACKUP_SHA}`,
        backupMaxPayloadBytes: 256 * 1024 * 1024,
        backupSizeBytes: 8192,
        migration: {
          idx: 106,
          when: 1786459128910,
          tag: "0106_graceful_frog_thor",
          sha256:
            "sha256:697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
        },
      },
    });
  });

  it("accepts a zero-apply race only after the exact post preflight", async () => {
    let calls = 0;
    const preflight = vi.fn(
      async (_config: AccountingSchemaPreflightEnvironment) => {
        calls += 1;
        if (calls === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "Database is exact 0105.",
          );
        }
        return postSummary();
      },
    );
    const result = await runAccountingSchemaGate(environment(), {
      inventory: vi.fn(async () => ready0105()),
      preflight,
      migrate: vi.fn(async () => migration(0)),
    });
    expect(result.mode).toBe("NOOP");
    expect(preflight).toHaveBeenCalledTimes(3);
  });

  it("fails closed on baseline, apply-count, backup and nonempty transition drift", async () => {
    const postMismatch = vi.fn(async () => {
      throw new ExternalSchemaPreflightError(
        "APPLIED_COUNT_MISMATCH",
        "Database is exact 0105.",
      );
    });
    await expect(
      runAccountingSchemaGate(environment(), {
        inventory: vi.fn(async () => ({
          ...ready0105(),
          decision: "BASELINE_0105_REQUIRED",
        })),
        preflight: postMismatch,
      }),
    ).rejects.toMatchObject({ code: "BASELINE_0105_REQUIRED" });

    let count = 0;
    await expect(
      runAccountingSchemaGate(environment(), {
        inventory: vi.fn(async () => ready0105()),
        preflight: vi.fn(async () => {
          count += 1;
          if (count === 1) {
            throw new ExternalSchemaPreflightError(
              "APPLIED_COUNT_MISMATCH",
              "Database is exact 0105.",
            );
          }
          return postSummary();
        }),
        migrate: vi.fn(async () => migration(2)),
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNTING_MIGRATION_APPLY_COUNT_INVALID",
    });

    await expect(
      runAccountingSchemaGate(
        { ...environment(), STAGING_EXACT_0105_BACKUP_SIZE_BYTES: "8193" },
        { preflight: vi.fn(async () => postSummary()) },
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNTING_BACKUP_EXECUTION_BINDING_INVALID",
    });

    await expect(
      runAccountingSchemaGate(environment(), {
        preflight: vi.fn(async () => ({
          ...postSummary(),
          accountingEvidenceRows: 1,
        })),
      }),
    ).rejects.toMatchObject({ code: "ACCOUNTING_TRANSITION_STATE_NOT_EMPTY" });
  });

  it("keeps steady-0106 read-only and permits existing accounting rows", async () => {
    const steady: AccountingSchemaSteadyStateSummary = {
      decision: "ALREADY_0106",
      environmentId: "site-logbook-staging",
      databaseName: "site_logbook_staging",
      databaseUser: "site_logbook_staging",
      buildSha: SHA,
      expectedMigrations: 106,
      latestExpectedTag: "0106_graceful_frog_thor",
      accountingEvidenceRows: 12,
      externalStateRows: 0,
    };
    const migrate = vi.fn(async () => migration(1));
    const result = await runAccountingSchemaGate(
      { ...environment(), STAGING_ACCOUNTING_SCHEMA_ACTION: "steady-0106" },
      { steadyState: vi.fn(async () => steady), migrate },
    );
    expect(result).toEqual({ mode: "NOOP", evidence: steady });
    expect(migrate).not.toHaveBeenCalled();
  });
});
