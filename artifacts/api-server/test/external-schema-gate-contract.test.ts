import {
  ExternalSchemaPreflightError,
  type ExternalSchemaInventorySummary,
  type ExternalSchemaPreflightEnvironment,
  type ExternalSchemaPreflightSummary,
} from "@workspace/db/external-schema-preflight";
import type { MigrationSummary } from "@workspace/db/migrate";
import { describe, expect, it, vi } from "vitest";
import { runExternalSchemaGate } from "../src/external-schema-gate";

const SHA = "a".repeat(40);
const INPUT_SHA = "b".repeat(64);

function environment(): NodeJS.ProcessEnv {
  return {
    STAGING_SCHEMA_ACTION: "apply-0105",
    EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION:
      "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_ENVIRONMENT_ID: "site-logbook-staging",
    BUILD_SHA: SHA,
    STAGING_BUILD_SHA: SHA,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: SHA,
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    STAGING_BACKUP_EVIDENCE_ID: "72",
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "24",
    STAGING_DEPLOYMENT_INPUTS_SHA256: INPUT_SHA,
    STAGING_EXACT_0104_BACKUP_EXECUTION_SHA256: "9".repeat(64),
    STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES: String(256 * 1024 * 1024),
    STAGING_EXACT_0104_BACKUP_SIZE_BYTES: "4096",
    DATABASE_URL:
      "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
    MIGRATIONS_DIR: "lib/db/migrations",
  };
}

function postSummary(): ExternalSchemaPreflightSummary {
  return {
    mode: "post",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    expectedMigrations: 105,
    latestExpectedTag: "0105_smooth_nitro",
    externalStateRows: 0,
    backupEvidenceId: 72,
    backupRestoreAgeHours: 0.1,
    backupEvidence: {
      id: 72,
      sizeBytes: 4096,
      encryptedBackupSha256: `sha256:${"c".repeat(64)}`,
      encryptionFormat: "mve1",
      encryptionKeyIdFingerprint: `sha256:${"d".repeat(64)}`,
      objectPathFingerprint: `sha256:${"e".repeat(64)}`,
      createdAt: "2026-08-10T10:00:00.000Z",
      restoreTestedAt: "2026-08-10T10:01:00.000Z",
      checkedAt: "2026-08-10T10:07:00.000Z",
      restoreAgeHours: 0.1,
      restoreDurationMs: 60_000,
      verifiedTableCount: 5,
      verifiedTablesSha256: `sha256:${"f".repeat(64)}`,
      destructiveRestorePerformed: false,
    },
  };
}

function migration(newlyApplied: number): MigrationSummary {
  return {
    migrationsFolder: "lib/db/migrations",
    expectedCount: 105,
    appliedBefore: 105 - newlyApplied,
    appliedAfter: 105,
    newlyApplied,
    latestExpectedTag: "0105_smooth_nitro",
  };
}

function exact0104Inventory(): ExternalSchemaInventorySummary {
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
    backupEvidenceId: 72,
    backupRestoreAgeHours: 0.05,
  };
}

describe("external schema gate migration classification", () => {
  it("classifies the process that applies 0105 as APPLIED", async () => {
    let preflightCall = 0;
    const preflight = vi.fn(
      async (_config: ExternalSchemaPreflightEnvironment) => {
        preflightCall += 1;
        if (preflightCall === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "The database is still exact 0104.",
          );
        }
        return postSummary();
      },
    );

    const result = await runExternalSchemaGate(environment(), {
      inventory: vi.fn(async () => exact0104Inventory()),
      preflight,
      migrate: vi.fn(async () => migration(1)),
    });

    expect(result.mode).toBe("APPLIED");
    expect(preflight).toHaveBeenCalledTimes(3);
  });

  it("classifies a concurrent migration race loser as NOOP after mandatory post preflight", async () => {
    const calls: string[] = [];
    const preflight = vi.fn(
      async (config: ExternalSchemaPreflightEnvironment) => {
        calls.push(`preflight:${config.mode}`);
        if (calls.length === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "The database is still exact 0104.",
          );
        }
        return postSummary();
      },
    );
    const migrate = vi.fn(async () => {
      calls.push("migrate");
      return migration(0);
    });

    const result = await runExternalSchemaGate(environment(), {
      inventory: vi.fn(async () => exact0104Inventory()),
      preflight,
      migrate,
    });

    expect(result.mode).toBe("NOOP");
    expect(calls).toEqual([
      "preflight:post",
      "preflight:pre",
      "migrate",
      "preflight:post",
    ]);
    expect(migrate).toHaveBeenCalledWith(
      "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
    );
    expect(result.evidence).toMatchObject({
      schemaGate: {
        decision: "APPLIED",
        expectedMigrations: 105,
        inputSha256: `sha256:${INPUT_SHA}`,
        sourceBackupExecutionSha256: `sha256:${"9".repeat(64)}`,
        backupMaxPayloadBytes: 256 * 1024 * 1024,
        backupSizeBytes: 4096,
      },
      backupEvidence: {
        sourceExecutionSha256: `sha256:${"9".repeat(64)}`,
        maxPayloadBytes: 256 * 1024 * 1024,
      },
    });
  });

  it("rejects backup execution or payload ceiling drift", async () => {
    await expect(
      runExternalSchemaGate(
        {
          ...environment(),
          STAGING_EXACT_0104_BACKUP_MAX_PAYLOAD_BYTES: String(
            256 * 1024 * 1024 + 1,
          ),
        },
        {
          inventory: vi.fn(async () => exact0104Inventory()),
          preflight: vi.fn(async () => postSummary()),
          migrate: vi.fn(async () => migration(1)),
        },
      ),
    ).rejects.toMatchObject({ code: "BACKUP_EXECUTION_BINDING_INVALID" });
  });

  it("rejects an unexpected apply count only after post preflight", async () => {
    const modes: string[] = [];
    const preflight = vi.fn(
      async (config: ExternalSchemaPreflightEnvironment) => {
        modes.push(config.mode);
        if (modes.length === 1) {
          throw new ExternalSchemaPreflightError(
            "APPLIED_COUNT_MISMATCH",
            "The database is still exact 0104.",
          );
        }
        return postSummary();
      },
    );

    await expect(
      runExternalSchemaGate(environment(), {
        inventory: vi.fn(async () => exact0104Inventory()),
        preflight,
        migrate: vi.fn(async () => migration(2)),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_APPLY_COUNT_INVALID" });
    expect(modes).toEqual(["post", "pre", "post"]);
  });
});
