import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EXTERNAL_SCHEMA_EXPECTED_OBJECTS,
  EXTERNAL_SCHEMA_MIGRATIONS,
  EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
  EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION,
  ExternalSchemaPreflightError,
  loadAndValidateExternalSchemaMigrationBundle,
  readExternalSchemaPreflightEnvironment,
  validateExactAppliedMigrationSet,
  validateExternalSchemaDatabaseState,
  validateExternalSchemaMigrationBundle,
  validateStagingBackupEvidence,
  type ExternalSchemaDatabaseState,
  type MigrationBundleInput,
  type StagingBackupEvidenceRow,
} from "./external-schema-preflight.js";

const migrationsDir = path.resolve(import.meta.dirname, "../migrations");
const fullSha = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ExternalSchemaPreflightError);
    assert.equal(error.code, code);
    return true;
  });
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    EXTERNAL_SCHEMA_PREFLIGHT_MODE: "pre",
    EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION,
    STAGING_ENVIRONMENT_ID: "site-logbook-staging",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    BUILD_SHA: fullSha,
    STAGING_BUILD_SHA: fullSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: fullSha,
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    DATABASE_URL:
      "postgres://site_logbook_staging:not-logged@postgres:5432/site_logbook_staging",
    MIGRATIONS_DIR: migrationsDir,
    STAGING_BACKUP_EVIDENCE_ID: "42",
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "24",
  };
}

function realBundleInput(): MigrationBundleInput {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: MigrationBundleInput["journalEntries"] };
  const migrationSqlFileNames = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/i.test(name))
    .sort();
  const sqlByTag = new Map(
    migrationSqlFileNames.map((file) => [
      file.slice(0, -4),
      readFileSync(path.join(migrationsDir, file), "utf8"),
    ]),
  );
  return {
    journalEntries: journal.entries,
    migrationSqlFileNames,
    sqlByTag,
    snapshot0104: JSON.parse(
      readFileSync(
        path.join(migrationsDir, "meta", "0104_snapshot.json"),
        "utf8",
      ),
    ) as { id?: unknown },
    snapshot0105: JSON.parse(
      readFileSync(
        path.join(migrationsDir, "meta", "0105_snapshot.json"),
        "utf8",
      ),
    ) as { prevId?: unknown },
  };
}

function emptyPreState(): ExternalSchemaDatabaseState {
  return {
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    tables: new Set(),
    hasAccountTypeColumn: false,
    functions: new Set(),
    indexes: new Set(),
    constraints: new Map(),
    triggers: new Map(),
    externalUsers: 0,
    nonInternalUsers: 0,
    externalAccounts: 0,
    externalScopes: 0,
    externalEvents: 0,
  };
}

function emptyPostState(): ExternalSchemaDatabaseState {
  return {
    ...emptyPreState(),
    hasAccountTypeColumn: true,
    tables: new Set(EXTERNAL_SCHEMA_EXPECTED_OBJECTS.tables),
    functions: new Set(EXTERNAL_SCHEMA_EXPECTED_OBJECTS.functions),
    indexes: new Set(EXTERNAL_SCHEMA_EXPECTED_OBJECTS.indexes),
    constraints: new Map(
      EXTERNAL_SCHEMA_EXPECTED_OBJECTS.constraints.map((name) => [name, true]),
    ),
    triggers: new Map(
      EXTERNAL_SCHEMA_EXPECTED_OBJECTS.triggers.map((name) => [name, "O"]),
    ),
  };
}

const stagingIdentity = {
  expectedDatabaseName: "site_logbook_staging",
  expectedDatabaseUser: "site_logbook_staging",
};

describe("external schema preflight environment", () => {
  it("requires an explicit dark, exact-SHA, staging-only identity", () => {
    const config = readExternalSchemaPreflightEnvironment(validEnv());
    assert.equal(config.mode, "pre");
    assert.equal(config.buildSha, fullSha);
    assert.equal(config.expectedDatabaseHost, "postgres");
    assert.equal(config.expectedDatabaseName, "site_logbook_staging");
  });

  it("fails closed for an enabled feature, SHA drift and URL identity drift", () => {
    expectCode("FEATURE_FLAG_NOT_DARK", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        EXTERNAL_ACCOUNTS_ENABLED: "true",
      }),
    );
    expectCode("BUILD_SHA_MISMATCH", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        STAGING_IMAGE_MANIFEST_SOURCE_SHA: "a".repeat(40),
      }),
    );
    expectCode("FEATURE_FLAG_NOT_DARK", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        EXTERNAL_ACCOUNTS_ENABLED: " false ",
      }),
    );
    expectCode("CONFIRMATION_INVALID", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: ` ${EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION}`,
      }),
    );
    expectCode("BUILD_SHA_INVALID", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        BUILD_SHA: `${fullSha} `,
      }),
    );
    expectCode("BUILD_SHA_INVALID", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        BUILD_SHA: fullSha.toUpperCase(),
      }),
    );
    expectCode("DATABASE_URL_IDENTITY_MISMATCH", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        DATABASE_URL:
          "postgres://site_logbook_staging:not-logged@production-db:5432/site_logbook_staging",
      }),
    );
  });
});

describe("external schema migration bundle", () => {
  it("pins the real 105-entry bundle, 0104 predecessor, 0105 target and hashes", () => {
    const bundle = loadAndValidateExternalSchemaMigrationBundle(migrationsDir);
    assert.equal(bundle.pre.length, 104);
    assert.equal(bundle.post.length, 105);
    assert.deepEqual(bundle.pre.at(-1), EXTERNAL_SCHEMA_MIGRATIONS.predecessor);
    assert.deepEqual(bundle.post.at(-1), EXTERNAL_SCHEMA_MIGRATIONS.target);
  });

  it("rejects excluded 0100, duplicate journal identity and SQL hash drift", () => {
    const original = realBundleInput();
    expectCode("MIGRATION_0100_PRESENT", () =>
      validateExternalSchemaMigrationBundle({
        ...original,
        migrationSqlFileNames: [
          ...original.migrationSqlFileNames,
          "0100_forbidden.sql",
        ],
      }),
    );

    const duplicate = original.journalEntries.map((entry) => ({ ...entry }));
    duplicate[1] = { ...duplicate[1]!, when: duplicate[0]!.when };
    expectCode("JOURNAL_DUPLICATE", () =>
      validateExternalSchemaMigrationBundle({
        ...original,
        journalEntries: duplicate,
      }),
    );

    const changedSql = new Map(original.sqlByTag);
    changedSql.set(
      EXTERNAL_SCHEMA_MIGRATIONS.target.tag,
      `${changedSql.get(EXTERNAL_SCHEMA_MIGRATIONS.target.tag)}\n-- drift`,
    );
    expectCode("MIGRATION_HASH_MISMATCH", () =>
      validateExternalSchemaMigrationBundle({
        ...original,
        sqlByTag: changedSql,
      }),
    );
  });
});

describe("bound staging backup evidence", () => {
  const checkedAt = new Date("2026-08-05T12:00:00.000Z");

  function validBackup(): StagingBackupEvidenceRow {
    return {
      id: 42,
      status: "success",
      object_path: "/objects/backups/private-value.enc",
      size_bytes: "1024",
      sha256: "a".repeat(64),
      encryption_format: "mve1",
      encryption_key_id: "staging-backup-key",
      created_at: new Date("2026-08-05T08:00:00.000Z"),
      restore_status: "ok",
      restore_tested_at: new Date("2026-08-05T11:00:00.000Z"),
      checked_at: checkedAt,
    };
  }

  const expected = { backupEvidenceId: 42, backupRestoreMaxAgeHours: 24 };

  it("binds the newest encrypted successful row and exposes only id/freshness", () => {
    assert.deepEqual(validateStagingBackupEvidence(validBackup(), expected), {
      id: 42,
      restoreAgeHours: 1,
    });
  });

  it("rejects another backup id, incomplete metadata and stale restore evidence", () => {
    expectCode("BACKUP_EVIDENCE_ID_MISMATCH", () =>
      validateStagingBackupEvidence({ ...validBackup(), id: 41 }, expected),
    );
    expectCode("BACKUP_EVIDENCE_INVALID", () =>
      validateStagingBackupEvidence(
        { ...validBackup(), encryption_format: null },
        expected,
      ),
    );
    expectCode("BACKUP_RESTORE_EVIDENCE_STALE", () =>
      validateStagingBackupEvidence(
        {
          ...validBackup(),
          created_at: new Date("2026-08-03T08:00:00.000Z"),
          restore_tested_at: new Date("2026-08-04T11:59:59.000Z"),
        },
        expected,
      ),
    );
  });

  it("requires a bounded 1-168 hour restore evidence window", () => {
    expectCode("BACKUP_RESTORE_MAX_AGE_INVALID", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "0",
      }),
    );
    expectCode("BACKUP_RESTORE_MAX_AGE_INVALID", () =>
      readExternalSchemaPreflightEnvironment({
        ...validEnv(),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "169",
      }),
    );
  });
});

describe("exact live migration set", () => {
  it("accepts only the exact 104-row pre set or 105-row post set", () => {
    const bundle = loadAndValidateExternalSchemaMigrationBundle(migrationsDir);
    const preRows = bundle.pre.map((migration) => ({
      created_at: migration.when,
      hash: migration.hash,
    }));
    const postRows = bundle.post.map((migration) => ({
      created_at: migration.when,
      hash: migration.hash,
    }));
    validateExactAppliedMigrationSet("pre", preRows, bundle);
    validateExactAppliedMigrationSet("post", postRows, bundle);

    expectCode("APPLIED_COUNT_MISMATCH", () =>
      validateExactAppliedMigrationSet("pre", postRows, bundle),
    );
    expectCode("APPLIED_DUPLICATE", () =>
      validateExactAppliedMigrationSet(
        "pre",
        preRows.map((row, index) =>
          index === 1 ? { ...row, created_at: preRows[0]!.created_at } : row,
        ),
        bundle,
      ),
    );
    expectCode("APPLIED_SET_MISMATCH", () =>
      validateExactAppliedMigrationSet(
        "pre",
        preRows.map((row, index) =>
          index === 0 ? { ...row, hash: "0".repeat(64) } : row,
        ),
        bundle,
      ),
    );
  });
});

describe("external schema database state", () => {
  it("requires complete absence before migration", () => {
    validateExternalSchemaDatabaseState(
      "pre",
      emptyPreState(),
      stagingIdentity,
    );
    expectCode("PRE_SCHEMA_DRIFT", () =>
      validateExternalSchemaDatabaseState(
        "pre",
        { ...emptyPreState(), hasAccountTypeColumn: true },
        stagingIdentity,
      ),
    );
  });

  it("requires complete, enabled, validated and unused schema after migration", () => {
    validateExternalSchemaDatabaseState(
      "post",
      emptyPostState(),
      stagingIdentity,
    );

    const disabledTrigger = emptyPostState();
    const disabledTriggerMap = new Map(disabledTrigger.triggers);
    disabledTriggerMap.set(EXTERNAL_SCHEMA_EXPECTED_OBJECTS.triggers[0]!, "D");
    disabledTrigger.triggers = disabledTriggerMap;
    expectCode("POST_TRIGGER_DISABLED", () =>
      validateExternalSchemaDatabaseState(
        "post",
        disabledTrigger,
        stagingIdentity,
      ),
    );

    const invalidConstraint = emptyPostState();
    const invalidConstraintMap = new Map(invalidConstraint.constraints);
    invalidConstraintMap.set(
      EXTERNAL_SCHEMA_EXPECTED_OBJECTS.constraints[0]!,
      false,
    );
    invalidConstraint.constraints = invalidConstraintMap;
    expectCode("POST_CONSTRAINT_INVALID", () =>
      validateExternalSchemaDatabaseState(
        "post",
        invalidConstraint,
        stagingIdentity,
      ),
    );

    expectCode("POST_EXTERNAL_STATE_NOT_EMPTY", () =>
      validateExternalSchemaDatabaseState(
        "post",
        { ...emptyPostState(), externalAccounts: 1 },
        stagingIdentity,
      ),
    );
  });

  it("pins the shared advisory lock used by the normal migrator", () => {
    assert.equal(EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY, 911072468);
    const source = readFileSync(
      path.resolve(import.meta.dirname, "external-schema-preflight.ts"),
      "utf8",
    );
    assert.match(source, /SELECT pg_advisory_lock\(\$1\)/);
    assert.match(source, /SELECT pg_advisory_unlock\(\$1\)/);
  });
});
