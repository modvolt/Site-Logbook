import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AUDIT_SCHEMA_EXPECTED_JOURNAL_COUNT,
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_MIGRATIONS,
  AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS,
  AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION,
  AUDIT_SCHEMA_SNAPSHOTS,
  auditSchemaFingerprintSha256,
  canonicalAuditSchemaCatalogProjection,
  classifyAuditSchemaAppliedMigrations,
  loadAndValidateAuditSchemaMigrationBundle,
  readAuditSchemaPreflightEnvironment,
  raceAuditSchemaApplyOperation,
  validateAuditSchemaDatabaseState,
  validateAuditSchemaBackupIntegrityEvidence,
  validateAuditSchemaMigrationBundle,
  validateExactAuditAppliedMigrationSet,
  verifyAuditSchemaCatalogProjection,
  type AuditSchemaCatalogProjection,
  type AuditSchemaDatabaseState,
  type AuditSchemaMigrationBundleInput,
  type ValidatedAuditSchemaBundle,
} from "./audit-schema-preflight.js";
import {
  ExternalSchemaPreflightError,
  type AppliedMigrationRow,
  type MigrationJournalEntry,
  type StagingBackupEvidenceRow,
} from "./external-schema-preflight.js";

const migrationsDir = path.resolve(import.meta.dirname, "../migrations");
const fullSha = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";
const schemaFingerprint = `sha256:${"a".repeat(64)}`;

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ExternalSchemaPreflightError);
    assert.equal(error.code, code);
    return true;
  });
}

function bundleInput(): AuditSchemaMigrationBundleInput {
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
  const snapshot0106Bytes = readFileSync(
    path.join(migrationsDir, "meta", "0106_snapshot.json"),
    "utf8",
  );
  const snapshot0107Bytes = readFileSync(
    path.join(migrationsDir, "meta", "0107_snapshot.json"),
    "utf8",
  );
  return {
    journalEntries: journal.entries,
    migrationSqlFileNames,
    sqlByTag,
    snapshot0106Bytes,
    snapshot0106: JSON.parse(snapshot0106Bytes),
    snapshot0107Bytes,
    snapshot0107: JSON.parse(snapshot0107Bytes),
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

function restricted(rows: AppliedMigrationRow[]): AppliedMigrationRow[] {
  return [
    ...rows,
    ...AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS.map((row) => ({
      created_at: row.createdAt,
      hash: row.hash,
    })),
  ].sort((left, right) => Number(left.created_at) - Number(right.created_at));
}

function validState(
  bundle: ValidatedAuditSchemaBundle,
  eventRows = 0,
): AuditSchemaDatabaseState {
  const expected = bundle.expectedObjects;
  const ledger = eventRows === 0 ? null : "a".repeat(64);
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
    rowCounts: new Map([
      ["audit_events", eventRows],
      ["audit_export_outbox", eventRows],
      ["audit_chain_heads", 1],
    ]),
    headStreamId: "site-logbook:audit:global:v1",
    headSequence: eventRows,
    headLedgerSha256: ledger,
    maximumEventSequence: eventRows === 0 ? null : eventRows,
    maximumEventLedgerSha256: ledger,
    schemaFingerprintSha256: schemaFingerprint,
  };
}

function validEnv(
  mode: "clean" | "production-copy-restricted" = "clean",
): NodeJS.ProcessEnv {
  return {
    AUDIT_SCHEMA_PREFLIGHT_MODE: "pre",
    AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION,
    AUDIT_SCHEMA_LINEAGE_MODE: mode,
    AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON:
      mode === "clean" ? "[]" : JSON.stringify(AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS),
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
    AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256: schemaFingerprint,
  };
}

function catalogProjection(): AuditSchemaCatalogProjection {
  return canonicalAuditSchemaCatalogProjection({
    schemaVersion: "site-logbook.audit-schema-catalog/v1",
    namespaces: [
      {
        schema_name: "public",
        owner: "site_logbook_staging",
        acl: [
          "site_logbook_staging=UC/site_logbook_staging",
          "=U/site_logbook_staging",
        ],
      },
    ],
    tables: [
      {
        schema_name: "public",
        table_name: "audit_events",
        owner: "site_logbook_staging",
        acl: [],
        row_security: false,
      },
    ],
    columns: [
      {
        schema_name: "public",
        table_name: "audit_events",
        ordinal: 1,
        column_name: "event_id",
        data_type: "uuid",
        nullable: false,
        default_expression: null,
      },
    ],
    functions: [
      {
        schema_name: "public",
        function_name: "guard_audit_event_insert",
        identity_arguments: "",
        definition:
          "CREATE FUNCTION public.guard_audit_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n",
        volatility: "v",
        owner: "site_logbook_staging",
        configuration: ["search_path=pg_catalog"],
        acl: [],
      },
    ],
    constraints: [
      {
        schema_name: "public",
        table_name: "audit_events",
        constraint_name: "audit_events_pkey",
        definition: "PRIMARY KEY (event_id)",
        validated: true,
      },
    ],
    indexes: [
      {
        schema_name: "public",
        table_name: "audit_events",
        index_name: "audit_events_pkey",
        definition:
          "CREATE UNIQUE INDEX audit_events_pkey ON public.audit_events USING btree (event_id)",
        valid: true,
      },
    ],
    triggers: [
      {
        schema_name: "public",
        table_name: "audit_events",
        trigger_name: "audit_events_insert_guard_trg",
        function_identity: "public.guard_audit_event_insert()",
        definition:
          "CREATE TRIGGER audit_events_insert_guard_trg BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION guard_audit_event_insert()",
        enabled: "O",
      },
    ],
  });
}

describe("audit schema 0107 bundle", () => {
  it("pins exact canonical-LF SQL, snapshot chain and target catalog", () => {
    const bundle = loadAndValidateAuditSchemaMigrationBundle(migrationsDir);
    assert.equal(bundle.all.length, AUDIT_SCHEMA_EXPECTED_JOURNAL_COUNT);
    assert.equal(bundle.pre.length, 106);
    assert.equal(bundle.post.length, 107);
    assert.deepEqual(bundle.all.at(-2), AUDIT_SCHEMA_MIGRATIONS.predecessor);
    assert.deepEqual(bundle.all.at(-1), AUDIT_SCHEMA_MIGRATIONS.target);
    assert.equal(
      bundle.snapshot0106Sha256,
      AUDIT_SCHEMA_SNAPSHOTS.predecessor.sha256,
    );
    assert.equal(
      bundle.snapshot0107Sha256,
      AUDIT_SCHEMA_SNAPSHOTS.target.sha256,
    );
    assert.equal(bundle.expectedObjects.tables.length, 3);
    assert.equal(bundle.expectedObjects.functions.length, 16);
    assert.equal(bundle.expectedObjects.triggers.length, 5);
    assert.equal(bundle.expectedObjects.indexes.length, 9);
    assert.equal(bundle.expectedObjects.constraints.length, 32);
  });

  it("rejects excluded 0100, journal/hash/snapshot/file-set drift", () => {
    const original = bundleInput();
    expectCode("JOURNAL_COUNT_MISMATCH", () =>
      validateAuditSchemaMigrationBundle({
        ...original,
        journalEntries: original.journalEntries.slice(0, -1),
      }),
    );
    const forbidden = original.journalEntries.map((entry, index) =>
      index === 99 ? { ...entry, idx: 100, tag: "0100_forbidden" } : entry,
    );
    expectCode("MIGRATION_0100_PRESENT", () =>
      validateAuditSchemaMigrationBundle({
        ...original,
        journalEntries: forbidden,
      }),
    );
    const changedSql = new Map(original.sqlByTag);
    changedSql.set(
      AUDIT_SCHEMA_MIGRATIONS.target.tag,
      `${changedSql.get(AUDIT_SCHEMA_MIGRATIONS.target.tag)}\n-- drift`,
    );
    expectCode("MIGRATION_HASH_MISMATCH", () =>
      validateAuditSchemaMigrationBundle({ ...original, sqlByTag: changedSql }),
    );
    expectCode("SNAPSHOT_CHAIN_MISMATCH", () =>
      validateAuditSchemaMigrationBundle({
        ...original,
        snapshot0107Bytes: `${original.snapshot0107Bytes}\n`,
      }),
    );
    expectCode("MIGRATION_FILE_SET_MISMATCH", () =>
      validateAuditSchemaMigrationBundle({
        ...original,
        migrationSqlFileNames: original.migrationSqlFileNames.slice(0, -1),
      }),
    );
  });
});

describe("canonical audit schema catalog fingerprint", () => {
  it("pins one canonical secret-free projection independent of row/key order", () => {
    const projection = catalogProjection();
    const expected = auditSchemaFingerprintSha256(projection);
    const reordered = {
      ...projection,
      namespaces: projection.namespaces.map((row) => ({
        ...row,
        acl: [...(row.acl as string[])].reverse(),
      })),
      tables: projection.tables.map((row) =>
        Object.fromEntries(Object.entries(row).reverse()),
      ),
    };
    assert.equal(auditSchemaFingerprintSha256(reordered), expected);
    assert.equal(
      verifyAuditSchemaCatalogProjection(reordered, expected)
        .schemaFingerprintSha256,
      expected,
    );
  });

  it("rejects namespace, function, constraint, index and column drift", () => {
    const projection = catalogProjection();
    const expected = auditSchemaFingerprintSha256(projection);
    for (const drift of [
      {
        ...projection,
        functions: projection.functions.map((row) => ({
          ...row,
          definition: String(row.definition).replace(
            "RETURN NEW",
            "RETURN OLD",
          ),
        })),
      },
      {
        ...projection,
        namespaces: projection.namespaces.map((row) => ({
          ...row,
          acl: [...(row.acl as string[]), "=UC/site_logbook_staging"],
        })),
      },
      {
        ...projection,
        namespaces: projection.namespaces.map((row) => ({
          ...row,
          owner: "postgres",
        })),
      },
      {
        ...projection,
        functions: projection.functions.map((row) => ({
          ...row,
          owner: "postgres",
        })),
      },
      {
        ...projection,
        functions: projection.functions.map((row) => ({
          ...row,
          acl: ["PUBLIC=X/postgres"],
        })),
      },
      {
        ...projection,
        functions: projection.functions.map((row) => ({
          ...row,
          configuration: [],
        })),
      },
      {
        ...projection,
        constraints: projection.constraints.map((row) => ({
          ...row,
          definition: "UNIQUE (event_id)",
        })),
      },
      {
        ...projection,
        indexes: projection.indexes.map((row) => ({
          ...row,
          definition: String(row.definition).replace(
            "(event_id)",
            "(event_id DESC)",
          ),
        })),
      },
      {
        ...projection,
        columns: projection.columns.map((row) => ({
          ...row,
          data_type: "text",
        })),
      },
    ] satisfies AuditSchemaCatalogProjection[]) {
      expectCode("AUDIT_SCHEMA_FINGERPRINT_MISMATCH", () =>
        verifyAuditSchemaCatalogProjection(drift, expected),
      );
    }
  });

  it("binds the qualified restore map to one exact immutable audit backup row", () => {
    const row: StagingBackupEvidenceRow = {
      id: 92,
      filename: "staging-0106.pgcustom",
      status: "success",
      trigger: "manual",
      created_by: "staging-exact-0106-audit-backup",
      error: null,
      object_path: "/objects/backups/staging-0106.pgcustom.enc",
      size_bytes: 4096,
      sha256: "b".repeat(64),
      encryption_format: "mve1",
      encryption_key_id: "staging-backup-2026-08",
      created_at: "2026-08-12T12:00:00.000Z",
      restore_status: "ok",
      restore_tested_at: "2026-08-12T12:01:00.000Z",
      checked_at: "2026-08-12T12:02:00.000Z",
      restored_at: null,
      restore_duration_ms: 60_000,
      restore_verified_tables: {
        "drizzle.__drizzle_migrations": 106,
        "public.users": 10,
      },
      restore_error: null,
    };
    const evidence = validateAuditSchemaBackupIntegrityEvidence(row);
    assert.deepEqual(evidence.verifiedTableNames, [
      "drizzle.__drizzle_migrations",
      "public.users",
    ]);
    assert.match(evidence.verifiedTableCountsSha256, /^sha256:[0-9a-f]{64}$/);
    assert.match(evidence.backupRowBindingSha256, /^sha256:[0-9a-f]{64}$/);
    expectCode("AUDIT_BACKUP_ROW_BINDING_INVALID", () =>
      validateAuditSchemaBackupIntegrityEvidence({
        ...row,
        created_by: "mutable-admin-edit",
      }),
    );
  });
});

describe("audit schema clean and production-copy lineage", () => {
  const bundle = loadAndValidateAuditSchemaMigrationBundle(migrationsDir);

  it("classifies exact clean and exact restricted 0106/0107 states", () => {
    for (const [lineageMode, opaque, wrap] of [
      ["clean", [], (rows: AppliedMigrationRow[]) => rows],
      [
        "production-copy-restricted",
        AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS,
        restricted,
      ],
    ] as const) {
      const pre = classifyAuditSchemaAppliedMigrations(
        wrap(applied(bundle.pre)),
        bundle,
        lineageMode,
        opaque,
      );
      const post = classifyAuditSchemaAppliedMigrations(
        wrap(applied(bundle.post)),
        bundle,
        lineageMode,
        opaque,
      );
      assert.equal(pre.decision, "READY_0106");
      assert.equal(post.decision, "ALREADY_0107");
      assert.equal(pre.opaqueLegacyRowCount, lineageMode === "clean" ? 0 : 2);
      assert.equal(
        pre.knownAppliedRowsSha256,
        AUDIT_SCHEMA_KNOWN_ROWS_SHA256.predecessor,
      );
      assert.equal(
        post.knownAppliedRowsSha256,
        AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target,
      );
      assert.match(pre.opaqueLegacyRowsSha256, /^sha256:[0-9a-f]{64}$/);
      validateExactAuditAppliedMigrationSet(
        "pre",
        wrap(applied(bundle.pre)),
        bundle,
        lineageMode,
        opaque,
      );
      validateExactAuditAppliedMigrationSet(
        "steady",
        wrap(applied(bundle.post)),
        bundle,
        lineageMode,
        opaque,
      );
    }
  });

  it("rejects a third row, a wrong opaque identity and any inferred opaque field", () => {
    expectCode("APPLIED_UNKNOWN_ROW", () =>
      classifyAuditSchemaAppliedMigrations(
        [...applied(bundle.pre), { created_at: 123, hash: "f".repeat(64) }],
        bundle,
        "clean",
        [],
      ),
    );
    expectCode("OPAQUE_LEGACY_ROWS_MISMATCH", () =>
      classifyAuditSchemaAppliedMigrations(
        restricted(applied(bundle.pre)),
        bundle,
        "production-copy-restricted",
        [
          AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS[0],
          { ...AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS[1], hash: "0".repeat(64) },
        ],
      ),
    );
    const env = validEnv("production-copy-restricted");
    env.AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON = JSON.stringify([
      { ...AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS[0], tag: "invented" },
      AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS[1],
    ]);
    expectCode("OPAQUE_LEGACY_ROWS_JSON_INVALID", () =>
      readAuditSchemaPreflightEnvironment(env),
    );
  });
});

describe("audit schema exact database state and environment", () => {
  const bundle = loadAndValidateAuditSchemaMigrationBundle(migrationsDir);
  const identity = {
    expectedDatabaseName: "site_logbook_staging",
    expectedDatabaseUser: "site_logbook_staging",
    expectedSchemaFingerprintSha256: schemaFingerprint,
  };

  it("accepts absent pre, exact genesis post and contiguous steady data", () => {
    validateAuditSchemaDatabaseState(
      "pre",
      {
        databaseName: "site_logbook_staging",
        databaseUser: "site_logbook_staging",
        tables: new Set(),
        tableSafety: new Map(),
        functions: new Set(),
        indexes: new Set(),
        constraints: new Map(),
        triggers: new Map(),
        rowCounts: new Map(),
        headStreamId: null,
        headSequence: null,
        headLedgerSha256: null,
        maximumEventSequence: null,
        maximumEventLedgerSha256: null,
        schemaFingerprintSha256: auditSchemaFingerprintSha256({
          schemaVersion: "site-logbook.audit-schema-catalog/v1",
          tables: [],
          columns: [],
          functions: [],
          constraints: [],
          indexes: [],
          triggers: [],
        }),
      },
      identity,
      bundle.expectedObjects,
    );
    validateAuditSchemaDatabaseState(
      "post",
      validState(bundle),
      identity,
      bundle.expectedObjects,
    );
    validateAuditSchemaDatabaseState(
      "steady",
      validState(bundle, 2),
      identity,
      bundle.expectedObjects,
    );
  });

  it("rejects schema extras, non-genesis post and head/outbox drift", () => {
    const extra = validState(bundle);
    (extra.functions as Set<string>).add("audit_unreviewed_helper");
    expectCode("POST_SCHEMA_INCOMPLETE", () =>
      validateAuditSchemaDatabaseState(
        "post",
        extra,
        identity,
        bundle.expectedObjects,
      ),
    );
    expectCode("POST_AUDIT_STATE_NOT_GENESIS", () =>
      validateAuditSchemaDatabaseState(
        "post",
        validState(bundle, 1),
        identity,
        bundle.expectedObjects,
      ),
    );
    const drift = validState(bundle, 2);
    (drift.rowCounts as Map<string, number>).set("audit_export_outbox", 1);
    expectCode("AUDIT_CHAIN_STATE_INVALID", () =>
      validateAuditSchemaDatabaseState(
        "steady",
        drift,
        identity,
        bundle.expectedObjects,
      ),
    );
  });

  it("requires exact confirmation and exact two-row restricted JSON", () => {
    const clean = readAuditSchemaPreflightEnvironment(validEnv());
    assert.equal(clean.lineageMode, "clean");
    assert.deepEqual(clean.opaqueLegacyRows, []);
    const restrictedEnv = readAuditSchemaPreflightEnvironment(
      validEnv("production-copy-restricted"),
    );
    assert.deepEqual(
      restrictedEnv.opaqueLegacyRows,
      AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS,
    );
    const invalid = validEnv();
    invalid.AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION = "wrong";
    expectCode("CONFIRMATION_INVALID", () =>
      readAuditSchemaPreflightEnvironment(invalid),
    );
  });

  it("keeps production startup lock and empty-state probes bounded", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "audit-schema-preflight.ts"),
      "utf8",
    );
    const lockStart = source.indexOf("async function withLockedReadOnly");
    const lockEnd = source.indexOf(
      "export async function applyAuditSchema0107",
      lockStart,
    );
    const lockHelper = source.slice(lockStart, lockEnd);
    assert.match(lockHelper, /pg_try_advisory_lock/);
    assert.doesNotMatch(lockHelper, /SELECT pg_advisory_lock/);
    assert.match(lockHelper, /statement_timeout: 5_000/);
    assert.match(lockHelper, /SET LOCAL lock_timeout = '2000ms'/);
    assert.match(lockHelper, /SET LOCAL search_path = pg_catalog, public/);
    const postStart = source.indexOf('if (mode === "post")');
    const postEnd = source.indexOf('else if (mode === "steady")', postStart);
    const postProbe = source.slice(postStart, postEnd);
    assert.match(postProbe, /EXISTS \(SELECT 1 FROM audit_events LIMIT 1\)/);
    assert.doesNotMatch(postProbe, /count\(\*\)/i);
    const production = source.slice(
      source.indexOf(
        "export async function verifyProductionAuditSchemaReadiness",
      ),
    );
    assert.match(production, /readAuditDatabaseState\(client, "post"\)/);
    assert.match(production, /boundedEmptyCheck: true/);
    assert.doesNotMatch(
      production,
      /readAuditDatabaseState\(client, "steady"\)/,
    );
  });

  it("bounds apply lock acquisition and selects public for frozen unqualified DDL", async () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "audit-schema-preflight.ts"),
      "utf8",
    );
    const apply = source.slice(
      source.indexOf("export async function applyAuditSchema0107"),
      source.indexOf(
        "function externalRows",
        source.indexOf("export async function applyAuditSchema0107"),
      ),
    );
    assert.match(
      apply,
      /connectionTimeoutMillis: AUDIT_SCHEMA_APPLY_CONNECT_TIMEOUT_MS/,
    );
    assert.match(apply, /query_timeout: AUDIT_SCHEMA_APPLY_QUERY_TIMEOUT_MS/);
    assert.match(
      apply,
      /statement_timeout: AUDIT_SCHEMA_APPLY_QUERY_TIMEOUT_MS/,
    );
    assert.match(apply, /SELECT pg_try_advisory_lock/);
    assert.doesNotMatch(apply, /SELECT pg_advisory_lock/);
    assert.ok(apply.indexOf("try {") < apply.indexOf("client.connect()"));
    const searchPathAt = apply.indexOf(
      "SET LOCAL search_path = public, pg_catalog",
    );
    const migrationLoopAt = apply.indexOf(
      'targetSql.split("--> statement-breakpoint")',
    );
    assert.ok(searchPathAt > 0 && searchPathAt < migrationLoopAt);
    assert.doesNotMatch(apply, /SET LOCAL search_path = pg_catalog, public/);
    assert.match(
      apply,
      /SET LOCAL idle_in_transaction_session_timeout = '10000ms'/,
    );

    let timedOut = false;
    const hung = raceAuditSchemaApplyOperation(
      new Promise<void>(() => undefined),
      5,
      () => {
        timedOut = true;
      },
    );
    await assert.rejects(hung, (error: unknown) => {
      assert.ok(error instanceof ExternalSchemaPreflightError);
      assert.equal(error.code, "AUDIT_SCHEMA_APPLY_TIMEOUT");
      return true;
    });
    assert.equal(timedOut, true);
  });
});
