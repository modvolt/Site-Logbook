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
  classifyExternalSchemaAppliedMigrations,
  loadAndValidateExternalSchemaMigrationBundle,
  readExternalSchemaInventoryEnvironment,
  readExternalSchemaPreflightEnvironment,
  readExternalSchemaRuntimeEnvironment,
  validateExactAppliedMigrationSet,
  validateExternalSchemaDatabaseState,
  validateExternalSchemaMigrationBundle,
  validateStagingBackupEvidence,
  type ExternalSchemaDatabaseState,
  type MigrationBundleInput,
  type StagingBackupEvidenceRow,
} from "./external-schema-preflight.js";
import {
  STAGING_BASELINE_0104_CONFIRMATION,
  STAGING_BASELINE_0104_SOURCE_SHA,
  STAGING_BASELINE_0104_SOURCE_TREE,
  StagingBaseline0104Error,
  evaluateStagingBaseline0104Decision,
  readStagingBaseline0104Environment,
} from "./staging-baseline-0104.js";
import { createHash } from "node:crypto";

const migrationsDir = path.resolve(import.meta.dirname, "../migrations");
const fullSha = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ExternalSchemaPreflightError);
    assert.equal(error.code, code);
    return true;
  });
}

function expectBaselineCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof StagingBaseline0104Error);
    assert.equal(error.code, code);
    return true;
  });
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [
            key,
            canonical((entry as Record<string, unknown>)[key]),
          ]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(canonical(value))}\n`;
}

function baselineEnv(): NodeJS.ProcessEnv {
  const candidateImage = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"a".repeat(64)}`;
  const predecessorImage = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"b".repeat(64)}`;
  const predecessorManifest = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      kind: "site-logbook-staging-predecessor-api",
      sourceSha: STAGING_BASELINE_0104_SOURCE_SHA,
      sourceTree: STAGING_BASELINE_0104_SOURCE_TREE,
      image: predecessorImage,
    })}\n`,
    "utf8",
  );
  const predecessorManifestSha256 = createHash("sha256")
    .update(predecessorManifest)
    .digest("hex");
  const inputs = {
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104",
    action: "apply-0104-baseline",
    productionTargetsTouched: false,
    environmentId: "site-logbook-staging",
    composeProjectName: "site-logbook-staging",
    database: {
      host: "postgres",
      name: "site_logbook_staging",
      user: "site_logbook_staging",
    },
    externalAccountsEnabled: false,
    candidate: {
      sourceSha: fullSha,
      imageManifestSha256: "c".repeat(64),
      provisioningManifestSha256: "d".repeat(64),
      inspectInputsSha256: "e".repeat(64),
      apiImage: candidateImage,
    },
    predecessor: {
      sourceSha: STAGING_BASELINE_0104_SOURCE_SHA,
      sourceTree: STAGING_BASELINE_0104_SOURCE_TREE,
      imageManifestSha256: predecessorManifestSha256,
      apiImage: predecessorImage,
      publisherRun: { id: "123", attempt: "1" },
    },
    backup: { evidenceId: 42, restoreMaxAgeHours: 24 },
    target: {
      migrationCount: 104,
      latestTag: "0104_thin_sheva_callister",
      excluded0100: true,
      excluded0105: true,
    },
    nextGate: "fresh-exact-0104-backup-and-restore-required",
    authorizes0105: false,
  };
  const inputBytes = Buffer.from(canonicalJson(inputs), "utf8");
  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  return {
    STAGING_BASELINE_0104_ACTION: "apply-0104-baseline",
    STAGING_BASELINE_0104_CONFIRMATION,
    STAGING_BASELINE_0104_PHASE: "pre",
    STAGING_BASELINE_0104_INPUTS_B64: inputBytes.toString("base64"),
    STAGING_BASELINE_0104_INPUTS_SHA256: inputSha256,
    STAGING_PREDECESSOR_0104_MANIFEST_B64:
      predecessorManifest.toString("base64"),
    STAGING_PREDECESSOR_0104_MANIFEST_SHA256: predecessorManifestSha256,
    STAGING_PREDECESSOR_0104_API_IMAGE: predecessorImage,
    STAGING_PREDECESSOR_0104_SOURCE_SHA: STAGING_BASELINE_0104_SOURCE_SHA,
    STAGING_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_ENVIRONMENT_ID: "site-logbook-staging",
    STAGING_COMPOSE_PROJECT_NAME: "site-logbook-staging",
    BUILD_SHA: fullSha,
    STAGING_BUILD_SHA: fullSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: fullSha,
    STAGING_IMAGE_MANIFEST_SHA256: "c".repeat(64),
    STAGING_PROVISIONING_MANIFEST_SHA256: "d".repeat(64),
    STAGING_DEPLOYMENT_INPUTS_SHA256: "e".repeat(64),
    STAGING_API_IMAGE: candidateImage,
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    STAGING_BACKUP_EVIDENCE_ID: "42",
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "24",
  };
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

  it("keeps inventory and steady-state reads independent of mutation confirmation", () => {
    const withoutConfirmation = { ...validEnv() };
    delete withoutConfirmation.EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION;
    assert.equal(
      readExternalSchemaInventoryEnvironment(withoutConfirmation)
        .backupEvidenceId,
      42,
    );

    delete withoutConfirmation.STAGING_BACKUP_EVIDENCE_ID;
    delete withoutConfirmation.STAGING_BACKUP_RESTORE_MAX_AGE_HOURS;
    const runtime = readExternalSchemaRuntimeEnvironment(withoutConfirmation);
    assert.equal(runtime.environmentId, "site-logbook-staging");
    assert.equal(runtime.buildSha, fullSha);
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

describe("fixed staging predecessor baseline contract", () => {
  it("binds candidate, predecessor, backup and isolated target bytes", () => {
    const pre = readStagingBaseline0104Environment(baselineEnv());
    assert.equal(pre.phase, "pre");
    assert.equal(pre.candidateSourceSha, fullSha);
    assert.equal(pre.predecessorSourceSha, STAGING_BASELINE_0104_SOURCE_SHA);
    assert.equal(pre.backupEvidenceId, 42);

    const post = readStagingBaseline0104Environment({
      ...baselineEnv(),
      STAGING_BASELINE_0104_PHASE: "post",
    });
    assert.equal(post.phase, "post");
  });

  it("rejects widened authorization, mutable primary gate and runtime drift", () => {
    for (const [key, value, code] of [
      ["STAGING_BASELINE_0104_CONFIRMATION", "approve", "BASELINE_CONFIRMATION_INVALID"],
      ["STAGING_BASELINE_0104_ACTION", "apply-latest", "BASELINE_ACTION_INVALID"],
      ["STAGING_BASELINE_0104_PHASE", "both", "BASELINE_PHASE_INVALID"],
      ["STAGING_SCHEMA_ACTION", "apply-0105", "BASELINE_PRIMARY_GATE_UNSAFE"],
      ["STAGING_EXTERNAL_ACCOUNTS_ENABLED", "true", "BASELINE_FEATURE_FLAG_UNSAFE"],
      ["STAGING_BUILD_SHA", "f".repeat(40), "BASELINE_RUNTIME_BINDING_MISMATCH"],
      ["STAGING_PREDECESSOR_0104_API_IMAGE", `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"f".repeat(64)}`, "BASELINE_RUNTIME_BINDING_MISMATCH"],
      ["STAGING_BACKUP_EVIDENCE_ID", "43", "BASELINE_RUNTIME_BINDING_MISMATCH"],
    ] as const) {
      expectBaselineCode(code, () =>
        readStagingBaseline0104Environment({ ...baselineEnv(), [key]: value }),
      );
    }
  });

  it("rejects changed canonical inputs and predecessor bytes", () => {
    const env = baselineEnv();
    expectBaselineCode("BASELINE_INPUT_HASH_MISMATCH", () =>
      readStagingBaseline0104Environment({
        ...env,
        STAGING_BASELINE_0104_INPUTS_B64: Buffer.from("{}\n").toString(
          "base64",
        ),
      }),
    );
    expectBaselineCode("BASELINE_PREDECESSOR_MANIFEST_MISMATCH", () =>
      readStagingBaseline0104Environment({
        ...env,
        STAGING_PREDECESSOR_0104_MANIFEST_B64: Buffer.from("{}\n").toString(
          "base64",
        ),
      }),
    );

    const decoded = Buffer.from(env.STAGING_BASELINE_0104_INPUTS_B64!, "base64");
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    const widened = Buffer.from(
      canonicalJson({ ...parsed, authorizes0105: true }),
      "utf8",
    );
    expectBaselineCode("BASELINE_INPUT_BOUNDARY_INVALID", () =>
      readStagingBaseline0104Environment({
        ...env,
        STAGING_BASELINE_0104_INPUTS_B64: widened.toString("base64"),
        STAGING_BASELINE_0104_INPUTS_SHA256: createHash("sha256")
          .update(widened)
          .digest("hex"),
      }),
    );
  });

  it("allows only migrate or verified-noop precheck and exact-0104 postcheck", () => {
    assert.deepEqual(
      evaluateStagingBaseline0104Decision("pre", {
        decision: "BASELINE_0104_REQUIRED",
        appliedMigrations: 103,
        predecessorMigrations: 104,
        latestAppliedTag: "0103_previous",
        missingToPredecessor: 1,
      }),
      {
        phase: "pre",
        operation: "migrate",
        decision: "BASELINE_0104_REQUIRED",
      },
    );
    assert.equal(
      evaluateStagingBaseline0104Decision("pre", {
        decision: "READY_0104",
        appliedMigrations: 104,
        predecessorMigrations: 104,
        latestAppliedTag: "0104_thin_sheva_callister",
        missingToPredecessor: 0,
      }).operation,
      "verified-noop",
    );
    assert.equal(
      evaluateStagingBaseline0104Decision("post", {
        decision: "READY_0104",
        appliedMigrations: 104,
        predecessorMigrations: 104,
        latestAppliedTag: "0104_thin_sheva_callister",
        missingToPredecessor: 0,
      }).operation,
      "ready",
    );
    expectBaselineCode("BASELINE_STATE_INVALID", () =>
      evaluateStagingBaseline0104Decision("post", {
        decision: "BASELINE_0104_REQUIRED",
        appliedMigrations: 103,
        predecessorMigrations: 104,
        latestAppliedTag: "0103_previous",
        missingToPredecessor: 1,
      }),
    );
    expectBaselineCode("BASELINE_STATE_INVALID", () =>
      evaluateStagingBaseline0104Decision("pre", {
        decision: "ALREADY_0105",
        appliedMigrations: 105,
        predecessorMigrations: 104,
        latestAppliedTag: "0105_smooth_nitro",
        missingToPredecessor: 0,
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

  it("classifies only an exact prefix as baseline, 0104-ready or 0105-ready", () => {
    const bundle = loadAndValidateExternalSchemaMigrationBundle(migrationsDir);
    const rows = bundle.post.map((migration) => ({
      created_at: migration.when,
      hash: migration.hash,
    }));

    assert.deepEqual(
      classifyExternalSchemaAppliedMigrations(rows.slice(0, 103), bundle),
      {
        decision: "BASELINE_0104_REQUIRED",
        appliedMigrations: 103,
        predecessorMigrations: 104,
        latestAppliedTag: bundle.post[102]!.tag,
        missingToPredecessor: 1,
      },
    );
    assert.equal(
      classifyExternalSchemaAppliedMigrations(rows.slice(0, 104), bundle)
        .decision,
      "READY_0104",
    );
    assert.equal(
      classifyExternalSchemaAppliedMigrations(rows, bundle).decision,
      "ALREADY_0105",
    );

    expectCode("APPLIED_PREFIX_MISMATCH", () =>
      classifyExternalSchemaAppliedMigrations(
        rows
          .slice(0, 104)
          .map((row, index) => (index === 50 ? { ...rows[104]! } : row)),
        bundle,
      ),
    );
    expectCode("APPLIED_COUNT_EXCEEDS_BUNDLE", () =>
      classifyExternalSchemaAppliedMigrations(
        [...rows, { created_at: 9999999999999, hash: "f".repeat(64) }],
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
