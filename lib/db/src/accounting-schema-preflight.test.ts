import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT,
  ACCOUNTING_SCHEMA_MIGRATIONS,
  ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION,
  classifyAccountingSchemaAppliedMigrations,
  loadAndValidateAccountingSchemaMigrationBundle,
  readAccountingSchemaPreflightEnvironment,
  validateAccountingSchemaDatabaseState,
  validateAccountingSchemaMigrationBundle,
  validateExactAccountingAppliedMigrationSet,
  type AccountingSchemaDatabaseState,
  type AccountingSchemaMigrationBundleInput,
  type ValidatedAccountingSchemaBundle,
} from "./accounting-schema-preflight.js";
import {
  ExternalSchemaPreflightError,
  type AppliedMigrationRow,
  type MigrationJournalEntry,
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

function bundleInput(): AccountingSchemaMigrationBundleInput {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: MigrationJournalEntry[] };
  const migrationSqlFileNames = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/i.test(name))
    .sort();
  const sqlByTag = new Map(
    migrationSqlFileNames.map((file) => [
      file.slice(0, -4),
      readFileSync(path.join(migrationsDir, file), "utf8"),
    ]),
  );
  const snapshot0105Bytes = readFileSync(
    path.join(migrationsDir, "meta", "0105_snapshot.json"),
    "utf8",
  );
  const snapshot0106Bytes = readFileSync(
    path.join(migrationsDir, "meta", "0106_snapshot.json"),
    "utf8",
  );
  return {
    journalEntries: journal.entries,
    migrationSqlFileNames,
    sqlByTag,
    snapshot0105Bytes,
    snapshot0105: JSON.parse(snapshot0105Bytes),
    snapshot0106Bytes,
    snapshot0106: JSON.parse(snapshot0106Bytes),
  };
}

function applied(
  migrations: readonly { when: number; hash: string }[],
): AppliedMigrationRow[] {
  return migrations.map((migration) => ({
    created_at: migration.when,
    hash: migration.hash,
  }));
}

function validState(
  bundle: ValidatedAccountingSchemaBundle,
  rowCount = 0,
): AccountingSchemaDatabaseState {
  const expected = bundle.expectedObjects;
  return {
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    tables: new Set(expected.tables),
    tableSafety: new Map(
      expected.tables.map((table) => [
        table,
        { kind: "r", persistence: "p", rowSecurity: false },
      ]),
    ),
    functions: new Set(expected.functions),
    indexes: new Set(expected.indexes),
    constraints: new Map(
      expected.constraints.map((constraint) => [constraint, true]),
    ),
    triggers: new Map(expected.triggers.map((trigger) => [trigger, "O"])),
    rowCounts: new Map(expected.tables.map((table) => [table, rowCount])),
  };
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    ACCOUNTING_SCHEMA_PREFLIGHT_MODE: "pre",
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION,
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

describe("accounting schema 0106 bundle", () => {
  it("pins the exact 0105 to 0106 journal, SQL, snapshots and object inventory", () => {
    const bundle =
      loadAndValidateAccountingSchemaMigrationBundle(migrationsDir);
    assert.equal(bundle.all.length, ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT);
    assert.equal(bundle.pre.length, 105);
    assert.equal(bundle.post.length, 106);
    assert.deepEqual(
      bundle.all.at(-2),
      ACCOUNTING_SCHEMA_MIGRATIONS.predecessor,
    );
    assert.deepEqual(bundle.all.at(-1), ACCOUNTING_SCHEMA_MIGRATIONS.target);
    assert.equal(bundle.expectedObjects.tables.length, 9);
    assert.equal(bundle.expectedObjects.functions.length, 5);
    assert.equal(bundle.expectedObjects.triggers.length, 13);
    assert.equal(bundle.expectedObjects.indexes.length, 31);
    assert.equal(bundle.expectedObjects.constraints.length, 116);
  });

  it("rejects count, tail, excluded 0100, SQL hash and snapshot drift", () => {
    const original = bundleInput();
    expectCode("JOURNAL_COUNT_MISMATCH", () =>
      validateAccountingSchemaMigrationBundle({
        ...original,
        journalEntries: original.journalEntries.slice(0, -1),
      }),
    );

    const wrongTail = original.journalEntries.map((entry, index) =>
      index === original.journalEntries.length - 1
        ? { ...entry, tag: "0106_wrong" }
        : entry,
    );
    expectCode("JOURNAL_TAIL_MISMATCH", () =>
      validateAccountingSchemaMigrationBundle({
        ...original,
        journalEntries: wrongTail,
      }),
    );

    const forbidden = original.journalEntries.map((entry, index) =>
      index === 99 ? { ...entry, idx: 100, tag: "0100_forbidden" } : entry,
    );
    expectCode("MIGRATION_0100_PRESENT", () =>
      validateAccountingSchemaMigrationBundle({
        ...original,
        journalEntries: forbidden,
      }),
    );

    const changedSql = new Map(original.sqlByTag);
    changedSql.set(
      ACCOUNTING_SCHEMA_MIGRATIONS.target.tag,
      `${changedSql.get(ACCOUNTING_SCHEMA_MIGRATIONS.target.tag)}\n-- drift`,
    );
    expectCode("MIGRATION_HASH_MISMATCH", () =>
      validateAccountingSchemaMigrationBundle({
        ...original,
        sqlByTag: changedSql,
      }),
    );

    expectCode("SNAPSHOT_CHAIN_MISMATCH", () =>
      validateAccountingSchemaMigrationBundle({
        ...original,
        snapshot0106Bytes: `${original.snapshot0106Bytes}\n`,
      }),
    );
  });
});

describe("accounting schema 0106 applied-set classification", () => {
  const bundle = loadAndValidateAccountingSchemaMigrationBundle(migrationsDir);

  it("accepts only exact 105 predecessor and exact 106 target sets", () => {
    const preRows = applied(bundle.pre);
    const postRows = applied(bundle.post);
    assert.equal(
      classifyAccountingSchemaAppliedMigrations(preRows, bundle).decision,
      "READY_0105",
    );
    assert.equal(
      classifyAccountingSchemaAppliedMigrations(postRows, bundle).decision,
      "ALREADY_0106",
    );
    validateExactAccountingAppliedMigrationSet("pre", preRows, bundle);
    validateExactAccountingAppliedMigrationSet("post", postRows, bundle);
    validateExactAccountingAppliedMigrationSet("steady", postRows, bundle);
  });

  it("rejects missing, extra, duplicate and hash-drifted rows", () => {
    expectCode("APPLIED_COUNT_MISMATCH", () =>
      validateExactAccountingAppliedMigrationSet(
        "pre",
        applied(bundle.pre.slice(0, -1)),
        bundle,
      ),
    );
    expectCode("APPLIED_COUNT_EXCEEDS_BUNDLE", () =>
      classifyAccountingSchemaAppliedMigrations(
        [
          ...applied(bundle.post),
          {
            created_at: ACCOUNTING_SCHEMA_MIGRATIONS.target.when + 1,
            hash: "f".repeat(64),
          },
        ],
        bundle,
      ),
    );
    const duplicated = applied(bundle.pre);
    duplicated[1] = { ...duplicated[1], created_at: duplicated[0]!.created_at };
    expectCode("APPLIED_DUPLICATE", () =>
      classifyAccountingSchemaAppliedMigrations(duplicated, bundle),
    );
    const drifted = applied(bundle.pre);
    drifted.at(-1)!.hash = "0".repeat(64);
    expectCode("APPLIED_SET_MISMATCH", () =>
      classifyAccountingSchemaAppliedMigrations(drifted, bundle),
    );
  });
});

describe("accounting schema 0106 database state", () => {
  const bundle = loadAndValidateAccountingSchemaMigrationBundle(migrationsDir);
  const identity = {
    expectedDatabaseName: "site_logbook_staging",
    expectedDatabaseUser: "site_logbook_staging",
  };

  it("requires complete empty post-transition state and permits later steady rows", () => {
    const pre: AccountingSchemaDatabaseState = {
      databaseName: "site_logbook_staging",
      databaseUser: "site_logbook_staging",
      tables: new Set(),
      tableSafety: new Map(),
      functions: new Set(),
      indexes: new Set(),
      constraints: new Map(),
      triggers: new Map(),
      rowCounts: new Map(),
    };
    validateAccountingSchemaDatabaseState(
      "pre",
      pre,
      identity,
      bundle.expectedObjects,
    );
    validateAccountingSchemaDatabaseState(
      "post",
      validState(bundle),
      identity,
      bundle.expectedObjects,
    );
    validateAccountingSchemaDatabaseState(
      "steady",
      validState(bundle, 2),
      identity,
      bundle.expectedObjects,
    );
  });

  it("rejects identity, missing/extra objects, invalid constraints, disabled triggers and post rows", () => {
    expectCode("LIVE_DATABASE_IDENTITY_MISMATCH", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        validState(bundle),
        { ...identity, expectedDatabaseName: "production" },
        bundle.expectedObjects,
      ),
    );

    const missingTable = validState(bundle);
    (missingTable.tables as Set<string>).delete(
      bundle.expectedObjects.tables[0]!,
    );
    expectCode("POST_SCHEMA_INCOMPLETE", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        missingTable,
        identity,
        bundle.expectedObjects,
      ),
    );

    const extraTrigger = validState(bundle);
    (extraTrigger.triggers as Map<string, string>).set(
      "accounting_unreviewed_trg",
      "O",
    );
    expectCode("POST_SCHEMA_INCOMPLETE", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        extraTrigger,
        identity,
        bundle.expectedObjects,
      ),
    );

    const invalidConstraint = validState(bundle);
    (invalidConstraint.constraints as Map<string, boolean>).set(
      bundle.expectedObjects.constraints[0]!,
      false,
    );
    expectCode("POST_CONSTRAINT_INVALID", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        invalidConstraint,
        identity,
        bundle.expectedObjects,
      ),
    );

    const disabledTrigger = validState(bundle);
    (disabledTrigger.triggers as Map<string, string>).set(
      bundle.expectedObjects.triggers[0]!,
      "D",
    );
    expectCode("POST_TRIGGER_DISABLED", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        disabledTrigger,
        identity,
        bundle.expectedObjects,
      ),
    );

    expectCode("POST_ACCOUNTING_STATE_NOT_EMPTY", () =>
      validateAccountingSchemaDatabaseState(
        "post",
        validState(bundle, 1),
        identity,
        bundle.expectedObjects,
      ),
    );
  });
});

describe("accounting schema 0106 environment", () => {
  it("binds the exact staging identity, source SHA, backup and confirmation", () => {
    const parsed = readAccountingSchemaPreflightEnvironment(validEnv());
    assert.equal(parsed.mode, "pre");
    assert.equal(parsed.environmentId, "site-logbook-staging");
    assert.equal(parsed.buildSha, fullSha);
    assert.equal(parsed.backupEvidenceId, 42);
    assert.equal(parsed.backupRestoreMaxAgeHours, 24);
  });

  it("rejects confirmation, mode, non-dark external accounts and backup drift", () => {
    expectCode("CONFIRMATION_INVALID", () =>
      readAccountingSchemaPreflightEnvironment({
        ...validEnv(),
        ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "wrong",
      }),
    );
    expectCode("MODE_INVALID", () =>
      readAccountingSchemaPreflightEnvironment({
        ...validEnv(),
        ACCOUNTING_SCHEMA_PREFLIGHT_MODE: "steady",
      }),
    );
    expectCode("FEATURE_FLAG_NOT_DARK", () =>
      readAccountingSchemaPreflightEnvironment({
        ...validEnv(),
        EXTERNAL_ACCOUNTS_ENABLED: "true",
      }),
    );
    expectCode("BACKUP_EVIDENCE_ID_INVALID", () =>
      readAccountingSchemaPreflightEnvironment({
        ...validEnv(),
        STAGING_BACKUP_EVIDENCE_ID: "0",
      }),
    );
  });
});
