import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

export const EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY = 911072468;
export const EXTERNAL_SCHEMA_EXPECTED_JOURNAL_COUNT = 105;
export const EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION =
  "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING";

export const EXTERNAL_SCHEMA_MIGRATIONS = Object.freeze({
  predecessor: Object.freeze({
    idx: 104,
    when: 1785899402886,
    tag: "0104_thin_sheva_callister",
    hash: "f35f5d418a7961ed34b5dc23bd563b83bf03cb911c74a0d0dca254f5bfef7e7a",
  }),
  target: Object.freeze({
    idx: 105,
    when: 1785912730511,
    tag: "0105_smooth_nitro",
    hash: "a7ecbfc67e2d91885ac554e958d66922246ddc32383271cfc336d075acc31a71",
  }),
});

export type ExternalSchemaPreflightMode = "pre" | "post";

export class ExternalSchemaPreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExternalSchemaPreflightError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(code, message);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) fail("ENV_MISSING", `${key} must be set.`);
  return value;
}

function requiredRaw(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("ENV_MISSING", `${key} must be set.`);
  }
  return value;
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const STAGING_ID_PATTERN = /(^|[-_.])staging([-_.]|$)/i;

export interface ExternalSchemaRuntimeEnvironment {
  databaseUrl: string;
  migrationsDir: string;
  environmentId: string;
  expectedDatabaseHost: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: string;
  buildSha: string;
}

export interface ExternalSchemaEnvironment extends ExternalSchemaRuntimeEnvironment {
  backupEvidenceId: number;
  backupRestoreMaxAgeHours: number;
}

export interface ExternalSchemaPreflightEnvironment extends ExternalSchemaEnvironment {
  mode: ExternalSchemaPreflightMode;
}

export type ExternalSchemaInventoryEnvironment = ExternalSchemaEnvironment;

export function readExternalSchemaRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ExternalSchemaRuntimeEnvironment {
  const environmentId = requiredRaw(env, "STAGING_ENVIRONMENT_ID");
  if (environmentId !== "site-logbook-staging") {
    fail(
      "ENVIRONMENT_ID_INVALID",
      "STAGING_ENVIRONMENT_ID must be exactly site-logbook-staging.",
    );
  }

  if (requiredRaw(env, "EXTERNAL_ACCOUNTS_ENABLED") !== "false") {
    fail(
      "FEATURE_FLAG_NOT_DARK",
      "EXTERNAL_ACCOUNTS_ENABLED must be exactly false during schema rollout.",
    );
  }

  const buildSha = requiredRaw(env, "BUILD_SHA");
  const stagingBuildSha = requiredRaw(env, "STAGING_BUILD_SHA");
  const manifestSourceSha = requiredRaw(
    env,
    "STAGING_IMAGE_MANIFEST_SOURCE_SHA",
  );
  for (const [key, value] of [
    ["BUILD_SHA", buildSha],
    ["STAGING_BUILD_SHA", stagingBuildSha],
    ["STAGING_IMAGE_MANIFEST_SOURCE_SHA", manifestSourceSha],
  ] as const) {
    if (!FULL_SHA_PATTERN.test(value)) {
      fail("BUILD_SHA_INVALID", `${key} must be a full lowercase Git SHA.`);
    }
  }
  if (buildSha !== stagingBuildSha || buildSha !== manifestSourceSha) {
    fail(
      "BUILD_SHA_MISMATCH",
      "BUILD_SHA, STAGING_BUILD_SHA and manifest source SHA must match exactly.",
    );
  }

  const expectedDatabaseHost = required(
    env,
    "STAGING_DATABASE_HOST",
  ).toLowerCase();
  const expectedDatabaseName = required(env, "STAGING_DATABASE_NAME");
  const expectedDatabaseUser = required(env, "STAGING_DATABASE_USER");
  if (
    !STAGING_ID_PATTERN.test(expectedDatabaseName) ||
    !STAGING_ID_PATTERN.test(expectedDatabaseUser)
  ) {
    fail(
      "DATABASE_IDENTITY_UNSAFE",
      "The expected database name and user must contain a distinct staging segment.",
    );
  }

  const databaseUrl = required(env, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail(
      "DATABASE_URL_INVALID",
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    fail(
      "DATABASE_URL_INVALID",
      "DATABASE_URL must use postgres or postgresql.",
    );
  }
  const urlDatabaseName = decodeURIComponent(
    parsed.pathname.replace(/^\//, ""),
  );
  const urlDatabaseUser = decodeURIComponent(parsed.username);
  if (
    parsed.hostname.toLowerCase() !== expectedDatabaseHost ||
    urlDatabaseName !== expectedDatabaseName ||
    urlDatabaseUser !== expectedDatabaseUser
  ) {
    fail(
      "DATABASE_URL_IDENTITY_MISMATCH",
      "DATABASE_URL host, database and user must match the explicit staging identity.",
    );
  }

  const migrationsDir = path.resolve(required(env, "MIGRATIONS_DIR"));
  return {
    databaseUrl,
    migrationsDir,
    environmentId,
    expectedDatabaseHost,
    expectedDatabaseName,
    expectedDatabaseUser,
    buildSha,
  };
}

function readExternalSchemaEnvironment(
  env: NodeJS.ProcessEnv,
): ExternalSchemaEnvironment {
  const runtime = readExternalSchemaRuntimeEnvironment(env);
  const backupEvidenceId = Number(required(env, "STAGING_BACKUP_EVIDENCE_ID"));
  if (!Number.isSafeInteger(backupEvidenceId) || backupEvidenceId <= 0) {
    fail(
      "BACKUP_EVIDENCE_ID_INVALID",
      "STAGING_BACKUP_EVIDENCE_ID must be a positive integer.",
    );
  }
  const backupRestoreMaxAgeHours = Number(
    required(env, "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS"),
  );
  if (
    !Number.isInteger(backupRestoreMaxAgeHours) ||
    backupRestoreMaxAgeHours < 1 ||
    backupRestoreMaxAgeHours > 168
  ) {
    fail(
      "BACKUP_RESTORE_MAX_AGE_INVALID",
      "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS must be an integer from 1 through 168.",
    );
  }
  return {
    ...runtime,
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  };
}

/**
 * Validate the explicit, secret-free deployment identity before opening a DB
 * connection. The returned URL is for the runner only and must never be logged.
 */
export function readExternalSchemaPreflightEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ExternalSchemaPreflightEnvironment {
  const mode = requiredRaw(env, "EXTERNAL_SCHEMA_PREFLIGHT_MODE");
  if (mode !== "pre" && mode !== "post") {
    fail("MODE_INVALID", "EXTERNAL_SCHEMA_PREFLIGHT_MODE must be pre or post.");
  }

  if (
    requiredRaw(env, "EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION") !==
    EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_INVALID",
      "The exact isolated-staging confirmation phrase is required.",
    );
  }

  const common = readExternalSchemaEnvironment(env);
  return {
    mode,
    ...common,
  };
}

/**
 * Read-only inventory validates the same staging identity, image provenance,
 * dark feature flag and backup binding as rollout preflight, but deliberately
 * does not accept or require the 0105 mutation confirmation.
 */
export function readExternalSchemaInventoryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ExternalSchemaInventoryEnvironment {
  return readExternalSchemaEnvironment(env);
}

export interface MigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
  version?: string;
  breakpoints?: boolean;
}

export interface MigrationBundleInput {
  journalEntries: readonly MigrationJournalEntry[];
  sqlByTag: ReadonlyMap<string, string>;
  migrationSqlFileNames: readonly string[];
  snapshot0104: { id?: unknown };
  snapshot0105: { prevId?: unknown };
}

export interface ExpectedAppliedMigration {
  idx: number;
  when: number;
  tag: string;
  hash: string;
}

export interface ValidatedExternalSchemaBundle {
  all: readonly ExpectedAppliedMigration[];
  pre: readonly ExpectedAppliedMigration[];
  post: readonly ExpectedAppliedMigration[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Pure bundle validation; tests can exercise every stop condition without DB. */
export function validateExternalSchemaMigrationBundle(
  input: MigrationBundleInput,
): ValidatedExternalSchemaBundle {
  const entries = [...input.journalEntries];
  if (entries.length !== EXTERNAL_SCHEMA_EXPECTED_JOURNAL_COUNT) {
    fail(
      "JOURNAL_COUNT_MISMATCH",
      `Expected exactly ${EXTERNAL_SCHEMA_EXPECTED_JOURNAL_COUNT} journal entries.`,
    );
  }

  const seenIdx = new Set<number>();
  const seenWhen = new Set<number>();
  const seenTag = new Set<string>();
  for (const entry of entries) {
    if (
      !Number.isInteger(entry.idx) ||
      !Number.isSafeInteger(entry.when) ||
      !entry.tag
    ) {
      fail(
        "JOURNAL_ENTRY_INVALID",
        "Every journal entry must have valid idx, when and tag.",
      );
    }
    if (
      seenIdx.has(entry.idx) ||
      seenWhen.has(entry.when) ||
      seenTag.has(entry.tag)
    ) {
      fail(
        "JOURNAL_DUPLICATE",
        "Journal idx, when and tag values must be unique.",
      );
    }
    seenIdx.add(entry.idx);
    seenWhen.add(entry.when);
    seenTag.add(entry.tag);
  }

  if (
    entries.some(
      (entry) => entry.idx === 100 || /^0100(?:_|$)/i.test(entry.tag),
    ) ||
    input.migrationSqlFileNames.some((file) => /^0100(?:_|\.)/i.test(file))
  ) {
    fail(
      "MIGRATION_0100_PRESENT",
      "Excluded migration 0100 must not be bundled.",
    );
  }

  const predecessor = entries.at(-2);
  const target = entries.at(-1);
  for (const [actual, expected, label] of [
    [predecessor, EXTERNAL_SCHEMA_MIGRATIONS.predecessor, "predecessor"],
    [target, EXTERNAL_SCHEMA_MIGRATIONS.target, "target"],
  ] as const) {
    if (
      actual?.idx !== expected.idx ||
      actual.when !== expected.when ||
      actual.tag !== expected.tag
    ) {
      fail(
        "JOURNAL_TAIL_MISMATCH",
        `The external schema ${label} must be exactly ${expected.tag}.`,
      );
    }
  }

  if (
    typeof input.snapshot0104.id !== "string" ||
    typeof input.snapshot0105.prevId !== "string" ||
    input.snapshot0105.prevId !== input.snapshot0104.id
  ) {
    fail("SNAPSHOT_CHAIN_MISMATCH", "0105 snapshot must directly follow 0104.");
  }

  const sqlNames = new Set(input.migrationSqlFileNames);
  const expectedSqlNames = new Set(entries.map((entry) => `${entry.tag}.sql`));
  if (
    sqlNames.size !== expectedSqlNames.size ||
    [...sqlNames].some((name) => !expectedSqlNames.has(name))
  ) {
    fail(
      "MIGRATION_FILE_SET_MISMATCH",
      "Migration SQL files must match the exact journal tag set.",
    );
  }

  const all = entries.map((entry): ExpectedAppliedMigration => {
    const sql = input.sqlByTag.get(entry.tag);
    if (sql === undefined) {
      fail(
        "MIGRATION_FILE_MISSING",
        `Missing SQL for journal tag ${entry.tag}.`,
      );
    }
    return {
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
      hash: sha256(sql),
    };
  });

  for (const expected of Object.values(EXTERNAL_SCHEMA_MIGRATIONS)) {
    const actual = all.find((migration) => migration.tag === expected.tag);
    if (actual?.hash !== expected.hash) {
      fail(
        "MIGRATION_HASH_MISMATCH",
        `Pinned hash mismatch for ${expected.tag}.`,
      );
    }
  }

  return Object.freeze({
    all: Object.freeze(all),
    pre: Object.freeze(all.slice(0, -1)),
    post: Object.freeze(all),
  });
}

function readJson(pathname: string): unknown {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    fail(
      "BUNDLE_FILE_INVALID",
      `Cannot read or parse ${path.basename(pathname)}.`,
    );
  }
}

export function loadAndValidateExternalSchemaMigrationBundle(
  migrationsDir: string,
): ValidatedExternalSchemaBundle {
  const journal = readJson(
    path.join(migrationsDir, "meta", "_journal.json"),
  ) as {
    entries?: unknown;
  };
  if (!Array.isArray(journal.entries)) {
    fail("JOURNAL_INVALID", "Migration journal entries must be an array.");
  }
  const migrationSqlFileNames = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/i.test(name))
    .sort();
  const sqlByTag = new Map<string, string>();
  for (const file of migrationSqlFileNames) {
    sqlByTag.set(
      file.slice(0, -4),
      readFileSync(path.join(migrationsDir, file), "utf8"),
    );
  }
  return validateExternalSchemaMigrationBundle({
    journalEntries: journal.entries as MigrationJournalEntry[],
    sqlByTag,
    migrationSqlFileNames,
    snapshot0104: readJson(
      path.join(migrationsDir, "meta", "0104_snapshot.json"),
    ) as {
      id?: unknown;
    },
    snapshot0105: readJson(
      path.join(migrationsDir, "meta", "0105_snapshot.json"),
    ) as {
      prevId?: unknown;
    },
  });
}

export interface AppliedMigrationRow {
  created_at: string | number | null;
  hash: string | null;
}

/** Pure exact-set validation; rejects extras, duplicates, missing rows and hash drift. */
export function validateExactAppliedMigrationSet(
  mode: ExternalSchemaPreflightMode,
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedExternalSchemaBundle,
): void {
  const expected = mode === "pre" ? bundle.pre : bundle.post;
  if (rows.length !== expected.length) {
    fail(
      "APPLIED_COUNT_MISMATCH",
      `Database must contain exactly ${expected.length} migration rows in ${mode} mode.`,
    );
  }

  const actualByWhen = new Map<number, string>();
  for (const row of rows) {
    const when = Number(row.created_at);
    if (!Number.isSafeInteger(when) || typeof row.hash !== "string") {
      fail(
        "APPLIED_ROW_INVALID",
        "Applied migration rows must have finite timestamps and hashes.",
      );
    }
    if (actualByWhen.has(when)) {
      fail(
        "APPLIED_DUPLICATE",
        "Applied migration created_at values must be unique.",
      );
    }
    actualByWhen.set(when, row.hash.toLowerCase());
  }

  for (const migration of expected) {
    if (actualByWhen.get(migration.when) !== migration.hash) {
      fail(
        "APPLIED_SET_MISMATCH",
        `Database migration set/hash mismatch at ${migration.tag}.`,
      );
    }
  }
}

export type ExternalSchemaInventoryDecision =
  | "BASELINE_0104_REQUIRED"
  | "READY_0104"
  | "ALREADY_0105";

export interface ExternalSchemaInventoryClassification {
  decision: ExternalSchemaInventoryDecision;
  appliedMigrations: number;
  predecessorMigrations: number;
  latestAppliedTag: string | null;
  missingToPredecessor: number;
}

/**
 * Classify only an exact journal prefix. Missing middle entries, unknown rows,
 * duplicate timestamps, hash drift and rows beyond 0105 are all hard stops.
 */
export function classifyExternalSchemaAppliedMigrations(
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedExternalSchemaBundle,
): ExternalSchemaInventoryClassification {
  if (rows.length > bundle.post.length) {
    fail(
      "APPLIED_COUNT_EXCEEDS_BUNDLE",
      "Database migration journal contains rows beyond the approved 0105 bundle.",
    );
  }

  const actualByWhen = new Map<number, string>();
  for (const row of rows) {
    const when = Number(row.created_at);
    if (!Number.isSafeInteger(when) || typeof row.hash !== "string") {
      fail(
        "APPLIED_ROW_INVALID",
        "Applied migration rows must have finite timestamps and hashes.",
      );
    }
    if (actualByWhen.has(when)) {
      fail(
        "APPLIED_DUPLICATE",
        "Applied migration created_at values must be unique.",
      );
    }
    actualByWhen.set(when, row.hash.toLowerCase());
  }

  const expectedPrefix = bundle.post.slice(0, rows.length);
  for (const migration of expectedPrefix) {
    if (actualByWhen.get(migration.when) !== migration.hash) {
      fail(
        "APPLIED_PREFIX_MISMATCH",
        `Database migration prefix/hash mismatch at ${migration.tag}.`,
      );
    }
  }

  const appliedMigrations = rows.length;
  const predecessorMigrations = bundle.pre.length;
  const latestAppliedTag = expectedPrefix.at(-1)?.tag ?? null;
  if (appliedMigrations === bundle.post.length) {
    return {
      decision: "ALREADY_0105",
      appliedMigrations,
      predecessorMigrations,
      latestAppliedTag,
      missingToPredecessor: 0,
    };
  }
  if (appliedMigrations === predecessorMigrations) {
    return {
      decision: "READY_0104",
      appliedMigrations,
      predecessorMigrations,
      latestAppliedTag,
      missingToPredecessor: 0,
    };
  }
  return {
    decision: "BASELINE_0104_REQUIRED",
    appliedMigrations,
    predecessorMigrations,
    latestAppliedTag,
    missingToPredecessor: predecessorMigrations - appliedMigrations,
  };
}

const EXPECTED_TABLES = Object.freeze([
  "external_accounts",
  "external_account_scopes",
  "external_account_events",
]);
const EXPECTED_FUNCTIONS = Object.freeze([
  "validate_external_account_row",
  "validate_external_account_scope_row",
  "guard_external_identity_row",
  "reject_external_permission_override",
  "deny_external_ledger_delete",
]);
const EXPECTED_TRIGGERS = Object.freeze([
  "external_accounts_validate_trg",
  "external_account_scopes_validate_trg",
  "users_external_identity_guard_trg",
  "user_permission_overrides_external_guard_trg",
  "external_account_events_immutable_trg",
  "external_account_scopes_no_delete_trg",
  "external_accounts_no_delete_trg",
]);
const EXPECTED_INDEXES = Object.freeze([
  "external_account_events_user_idx",
  "external_account_scopes_lookup_idx",
  "external_account_scopes_active_job_uq",
  "external_account_scopes_active_quote_uq",
  "external_account_scopes_active_switchboard_uq",
  "external_accounts_custodian_idx",
  "external_accounts_expiry_idx",
]);
const EXPECTED_CONSTRAINTS = Object.freeze([
  "external_account_events_pkey",
  "external_account_events_type_chk",
  "external_account_scopes_pkey",
  "external_account_scopes_resource_chk",
  "external_account_scopes_capability_chk",
  "external_account_scopes_expiry_chk",
  "external_account_scopes_revocation_chk",
  "external_accounts_pkey",
  "external_accounts_status_chk",
  "external_accounts_version_chk",
  "external_accounts_custodian_chk",
  "external_accounts_review_window_chk",
  "external_accounts_revocation_chk",
  "users_account_type_chk",
  "users_external_identity_shape_chk",
  "external_account_events_external_user_id_external_accounts_user_id_fk",
  "external_account_events_scope_id_external_account_scopes_id_fk",
  "external_account_events_actor_user_id_users_id_fk",
  "external_account_scopes_external_user_id_external_accounts_user_id_fk",
  "external_account_scopes_job_id_jobs_id_fk",
  "external_account_scopes_quote_id_quotes_id_fk",
  "external_account_scopes_switchboard_id_switchboards_id_fk",
  "external_account_scopes_created_by_user_id_users_id_fk",
  "external_account_scopes_revoked_by_user_id_users_id_fk",
  "external_accounts_user_id_users_id_fk",
  "external_accounts_custodian_user_id_users_id_fk",
  "external_accounts_created_by_user_id_users_id_fk",
  "external_accounts_updated_by_user_id_users_id_fk",
  "external_accounts_revoked_by_user_id_users_id_fk",
]);

export const EXTERNAL_SCHEMA_EXPECTED_OBJECTS = Object.freeze({
  tables: EXPECTED_TABLES,
  functions: EXPECTED_FUNCTIONS,
  triggers: EXPECTED_TRIGGERS,
  indexes: EXPECTED_INDEXES,
  constraints: EXPECTED_CONSTRAINTS,
});

export interface ExternalSchemaDatabaseState {
  databaseName: string;
  databaseUser: string;
  tables: ReadonlySet<string>;
  hasAccountTypeColumn: boolean;
  functions: ReadonlySet<string>;
  indexes: ReadonlySet<string>;
  constraints: ReadonlyMap<string, boolean>;
  triggers: ReadonlyMap<string, string>;
  externalUsers: number;
  nonInternalUsers: number;
  externalAccounts: number;
  externalScopes: number;
  externalEvents: number;
}

function assertExactNames(
  actual: ReadonlySet<string>,
  expected: readonly string[],
  code: string,
  label: string,
): void {
  const missing = expected.filter((name) => !actual.has(name));
  if (missing.length > 0)
    fail(code, `Missing ${label}: ${missing.join(", ")}.`);
}

/** Pure schema-state validator for DB-free unit tests. */
export function validateExternalSchemaDatabaseState(
  mode: ExternalSchemaPreflightMode,
  state: ExternalSchemaDatabaseState,
  expectedIdentity: Pick<
    ExternalSchemaPreflightEnvironment,
    "expectedDatabaseName" | "expectedDatabaseUser"
  >,
): void {
  if (
    state.databaseName !== expectedIdentity.expectedDatabaseName ||
    state.databaseUser !== expectedIdentity.expectedDatabaseUser
  ) {
    fail(
      "LIVE_DATABASE_IDENTITY_MISMATCH",
      "Live database identity is not the approved staging target.",
    );
  }

  const expectedNames = [
    ...EXPECTED_TABLES,
    ...EXPECTED_FUNCTIONS,
    ...EXPECTED_INDEXES,
    ...EXPECTED_CONSTRAINTS,
    ...EXPECTED_TRIGGERS,
  ];
  if (mode === "pre") {
    if (
      state.hasAccountTypeColumn ||
      expectedNames.some(
        (name) =>
          state.tables.has(name) ||
          state.functions.has(name) ||
          state.indexes.has(name) ||
          state.constraints.has(name) ||
          state.triggers.has(name),
      )
    ) {
      fail(
        "PRE_SCHEMA_DRIFT",
        "0105 schema objects must be absent before migration.",
      );
    }
    return;
  }

  if (!state.hasAccountTypeColumn) {
    fail(
      "POST_SCHEMA_INCOMPLETE",
      "users.account_type is missing after migration.",
    );
  }
  assertExactNames(
    state.tables,
    EXPECTED_TABLES,
    "POST_SCHEMA_INCOMPLETE",
    "tables",
  );
  assertExactNames(
    state.functions,
    EXPECTED_FUNCTIONS,
    "POST_SCHEMA_INCOMPLETE",
    "functions",
  );
  assertExactNames(
    state.indexes,
    EXPECTED_INDEXES,
    "POST_SCHEMA_INCOMPLETE",
    "indexes",
  );
  assertExactNames(
    new Set(state.constraints.keys()),
    EXPECTED_CONSTRAINTS,
    "POST_SCHEMA_INCOMPLETE",
    "constraints",
  );
  assertExactNames(
    new Set(state.triggers.keys()),
    EXPECTED_TRIGGERS,
    "POST_SCHEMA_INCOMPLETE",
    "triggers",
  );
  if (
    EXPECTED_CONSTRAINTS.some((name) => state.constraints.get(name) !== true)
  ) {
    fail("POST_CONSTRAINT_INVALID", "All 0105 constraints must be validated.");
  }
  if (EXPECTED_TRIGGERS.some((name) => state.triggers.get(name) !== "O")) {
    fail(
      "POST_TRIGGER_DISABLED",
      "All 0105 triggers must be enabled in origin mode.",
    );
  }
  if (
    state.externalUsers !== 0 ||
    state.nonInternalUsers !== 0 ||
    state.externalAccounts !== 0 ||
    state.externalScopes !== 0 ||
    state.externalEvents !== 0
  ) {
    fail(
      "POST_EXTERNAL_STATE_NOT_EMPTY",
      "External account state must be empty after schema rollout.",
    );
  }
}

type Queryable = Pick<pg.Client, "query">;

export interface StagingBackupEvidenceRow {
  id: string | number;
  status: string | null;
  object_path: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  encryption_format: string | null;
  encryption_key_id: string | null;
  created_at: Date | string | null;
  restore_status: string | null;
  restore_tested_at: Date | string | null;
  checked_at: Date | string | null;
  restored_at?: Date | string | null;
  restore_duration_ms?: string | number | null;
  restore_verified_tables?: Record<string, unknown> | null;
}

export interface ValidatedStagingBackupEvidence {
  id: number;
  restoreAgeHours: number;
}

export interface Exact0104RecoveryBackupEvidence {
  id: number;
  sizeBytes: number;
  encryptedBackupSha256: string;
  encryptionFormat: "mve1";
  encryptionKeyIdFingerprint: string;
  objectPathFingerprint: string;
  createdAt: string;
  restoreTestedAt: string;
  checkedAt: string;
  restoreAgeHours: number;
  restoreDurationMs: number;
  verifiedTableCount: number;
  verifiedTablesSha256: string;
  destructiveRestorePerformed: false;
}

function timestamp(value: Date | string | null, label: string): number {
  const millis =
    value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  if (!Number.isFinite(millis)) {
    fail("BACKUP_EVIDENCE_INVALID", `${label} must be a valid timestamp.`);
  }
  return millis;
}

/** Pure validation for the newest backup row selected by the caller/query. */
export function validateStagingBackupEvidence(
  row: StagingBackupEvidenceRow | undefined,
  expected: Pick<
    ExternalSchemaPreflightEnvironment,
    "backupEvidenceId" | "backupRestoreMaxAgeHours"
  >,
): ValidatedStagingBackupEvidence {
  if (!row)
    fail(
      "BACKUP_EVIDENCE_MISSING",
      "The staging database has no backup evidence row.",
    );
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id !== expected.backupEvidenceId) {
    fail(
      "BACKUP_EVIDENCE_ID_MISMATCH",
      "The newest backup row must match STAGING_BACKUP_EVIDENCE_ID.",
    );
  }
  const sizeBytes = Number(row.size_bytes);
  if (
    row.status !== "success" ||
    !row.object_path?.trim() ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    !/^[0-9a-f]{64}$/i.test(row.sha256 ?? "") ||
    row.encryption_format !== "mve1" ||
    !row.encryption_key_id?.trim() ||
    row.restore_status !== "ok"
  ) {
    fail(
      "BACKUP_EVIDENCE_INVALID",
      "The newest backup must be successful, nonempty, hashed, mve1-encrypted and restore-verified.",
    );
  }

  const createdAt = timestamp(row.created_at, "backup created_at");
  const restoreTestedAt = timestamp(
    row.restore_tested_at,
    "backup restore_tested_at",
  );
  const checkedAt = timestamp(row.checked_at, "database checked_at");
  if (restoreTestedAt < createdAt || restoreTestedAt > checkedAt) {
    fail(
      "BACKUP_EVIDENCE_TIME_INVALID",
      "Backup restore verification timestamps are not chronological.",
    );
  }
  const restoreAgeHours = (checkedAt - restoreTestedAt) / (60 * 60 * 1000);
  if (restoreAgeHours > expected.backupRestoreMaxAgeHours) {
    fail(
      "BACKUP_RESTORE_EVIDENCE_STALE",
      "The bound backup restore verification is older than the approved maximum age.",
    );
  }
  return { id, restoreAgeHours };
}

function canonicalTableCounts(
  value: Record<string, unknown> | null | undefined,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "BACKUP_RECOVERY_TABLES_INVALID",
      "Restore evidence must contain verified table counts.",
    );
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (
    entries.length === 0 ||
    entries.some(
      ([name, count]) =>
        !/^[a-z][a-z0-9_]*$/.test(name) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0,
    )
  ) {
    fail(
      "BACKUP_RECOVERY_TABLES_INVALID",
      "Restore evidence table names and counts must be nonempty and bounded.",
    );
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * Tightens the ordinary freshness check for the new backup that is created
 * after the exact-0104 baseline. It deliberately emits fingerprints rather
 * than object paths or key ids.
 */
export function validateExact0104RecoveryBackupEvidence(
  row: StagingBackupEvidenceRow | undefined,
  expected: Pick<
    ExternalSchemaPreflightEnvironment,
    "backupEvidenceId" | "backupRestoreMaxAgeHours"
  >,
  baselineCompletedAt: Date,
): Exact0104RecoveryBackupEvidence {
  const ordinary = validateStagingBackupEvidence(row, expected);
  if (!row) {
    fail("BACKUP_EVIDENCE_MISSING", "The staging backup row is required.");
  }
  const baselineCompleted = baselineCompletedAt.getTime();
  if (!Number.isFinite(baselineCompleted)) {
    fail(
      "BASELINE_COMPLETION_TIME_INVALID",
      "Baseline completion must be a valid timestamp.",
    );
  }
  const createdAt = timestamp(row.created_at, "backup created_at");
  const restoreTestedAt = timestamp(
    row.restore_tested_at,
    "backup restore_tested_at",
  );
  const checkedAt = timestamp(row.checked_at, "database checked_at");
  if (createdAt <= baselineCompleted) {
    fail(
      "BACKUP_NOT_AFTER_BASELINE",
      "The exact-0104 backup must be created after baseline completion.",
    );
  }
  if (row.restored_at !== null) {
    fail(
      "BACKUP_DESTRUCTIVE_RESTORE_PRESENT",
      "Recovery evidence must come from a restore test, not a destructive restore.",
    );
  }
  const restoreDurationMs = Number(row.restore_duration_ms);
  if (!Number.isSafeInteger(restoreDurationMs) || restoreDurationMs <= 0) {
    fail(
      "BACKUP_RECOVERY_DURATION_INVALID",
      "Restore-test duration must be a positive integer.",
    );
  }
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    fail(
      "BACKUP_RECOVERY_SIZE_INVALID",
      "Encrypted backup size must be a positive integer.",
    );
  }
  const verifiedTables = canonicalTableCounts(row.restore_verified_tables);
  const objectPath = row.object_path?.trim() ?? "";
  const encryptionKeyId = row.encryption_key_id?.trim() ?? "";
  const fingerprint = (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const verifiedTablesSha256 = `sha256:${createHash("sha256")
    .update(JSON.stringify(verifiedTables))
    .digest("hex")}`;
  return {
    id: ordinary.id,
    sizeBytes,
    encryptedBackupSha256: `sha256:${row.sha256?.toLowerCase()}`,
    encryptionFormat: "mve1",
    encryptionKeyIdFingerprint: fingerprint(encryptionKeyId),
    objectPathFingerprint: fingerprint(objectPath),
    createdAt: new Date(createdAt).toISOString(),
    restoreTestedAt: new Date(restoreTestedAt).toISOString(),
    checkedAt: new Date(checkedAt).toISOString(),
    restoreAgeHours: Math.round(ordinary.restoreAgeHours * 1000) / 1000,
    restoreDurationMs,
    verifiedTableCount: Object.keys(verifiedTables).length,
    verifiedTablesSha256,
    destructiveRestorePerformed: false,
  };
}

async function readLatestBackupEvidence(
  client: Queryable,
): Promise<StagingBackupEvidenceRow | undefined> {
  const result = await client.query<StagingBackupEvidenceRow>(`SELECT
      id, status, object_path, size_bytes, sha256, encryption_format,
      encryption_key_id, created_at, restore_status, restore_tested_at,
      restored_at, restore_duration_ms, restore_verified_tables,
      CURRENT_TIMESTAMP AS checked_at
    FROM backup_log
    ORDER BY created_at DESC, id DESC
    LIMIT 1`);
  return result.rows[0];
}

async function readDatabaseState(
  client: Queryable,
  mode: ExternalSchemaPreflightMode,
): Promise<ExternalSchemaDatabaseState> {
  const identity = await client.query<{
    database_name: string;
    database_user: string;
  }>(
    "SELECT current_database() AS database_name, current_user AS database_user",
  );
  const schema = await client.query<{
    object_kind: string;
    object_name: string;
    object_valid: boolean | null;
    object_enabled: string | null;
  }>(`WITH wanted_tables(name) AS (
      VALUES ('external_accounts'), ('external_account_scopes'), ('external_account_events')
    ), wanted_functions(name) AS (
      VALUES ('validate_external_account_row'), ('validate_external_account_scope_row'),
             ('guard_external_identity_row'), ('reject_external_permission_override'),
             ('deny_external_ledger_delete')
    ), rels AS (
      SELECT c.oid, c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
    )
    SELECT 'table' AS object_kind, wt.name AS object_name,
           NULL::boolean AS object_valid, NULL::text AS object_enabled
      FROM wanted_tables wt JOIN rels r ON r.relname = wt.name
    UNION ALL
    SELECT 'function', wf.name, NULL::boolean, NULL::text
      FROM wanted_functions wf
     WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = wf.name)
    UNION ALL
    SELECT 'index', i.indexname, NULL::boolean, NULL::text
      FROM pg_indexes i WHERE i.schemaname = 'public'
    UNION ALL
    SELECT 'constraint', con.conname, con.convalidated, NULL::text
      FROM pg_constraint con JOIN rels r ON r.oid = con.conrelid
    UNION ALL
    SELECT 'trigger', t.tgname, NULL::boolean, t.tgenabled::text
      FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal`);
  const accountType = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'account_type'
    ) AS present`);

  const tables = new Set<string>();
  const functions = new Set<string>();
  const indexes = new Set<string>();
  const constraints = new Map<string, boolean>();
  const triggers = new Map<string, string>();
  for (const row of schema.rows) {
    if (row.object_kind === "table") tables.add(row.object_name);
    else if (row.object_kind === "function") functions.add(row.object_name);
    else if (row.object_kind === "index") indexes.add(row.object_name);
    else if (row.object_kind === "constraint") {
      constraints.set(row.object_name, row.object_valid === true);
    } else if (row.object_kind === "trigger") {
      triggers.set(row.object_name, row.object_enabled ?? "");
    }
  }

  let counts = {
    external_users: 0,
    non_internal_users: 0,
    external_accounts: 0,
    external_scopes: 0,
    external_events: 0,
  };
  if (mode === "post") {
    const result = await client.query<typeof counts>(`SELECT
      (SELECT count(*)::int FROM users WHERE account_type = 'external') AS external_users,
      (SELECT count(*)::int FROM users WHERE account_type <> 'internal') AS non_internal_users,
      (SELECT count(*)::int FROM external_accounts) AS external_accounts,
      (SELECT count(*)::int FROM external_account_scopes) AS external_scopes,
      (SELECT count(*)::int FROM external_account_events) AS external_events`);
    counts = result.rows[0] ?? counts;
  }

  return {
    databaseName: identity.rows[0]?.database_name ?? "",
    databaseUser: identity.rows[0]?.database_user ?? "",
    tables,
    hasAccountTypeColumn: accountType.rows[0]?.present === true,
    functions,
    indexes,
    constraints,
    triggers,
    externalUsers: counts.external_users,
    nonInternalUsers: counts.non_internal_users,
    externalAccounts: counts.external_accounts,
    externalScopes: counts.external_scopes,
    externalEvents: counts.external_events,
  };
}

export interface ExternalSchemaPreflightSummary {
  mode: ExternalSchemaPreflightMode;
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  expectedMigrations: number;
  latestExpectedTag: string;
  externalStateRows: number;
  backupEvidenceId: number;
  backupRestoreAgeHours: number;
}

export interface ExternalSchemaInventorySummary extends ExternalSchemaInventoryClassification {
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  backupEvidenceId: number | null;
  backupRestoreAgeHours: number | null;
}

export interface ExternalSchemaSteadyStateSummary {
  decision: "ALREADY_0105";
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  expectedMigrations: number;
  latestExpectedTag: string;
  externalStateRows: number;
}

export interface ExternalSchemaExact0104RecoveryEnvironment extends ExternalSchemaEnvironment {
  baselineCompletedAt: Date;
}

export interface ExternalSchemaExact0104RecoverySummary {
  decision: "READY_0104_RECOVERY";
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  expectedMigrations: 104;
  latestExpectedTag: "0104_thin_sheva_callister";
  excludedMigration0100Present: false;
  excludedMigration0105Present: false;
  externalStateRows: 0;
  baselineCompletedAt: string;
  backup: Exact0104RecoveryBackupEvidence;
  authorizes0105: false;
}

/**
 * Read-only post-baseline gate. It proves that the newest backup was created
 * after the exact-0104 baseline, was restore-tested, and still describes the
 * same isolated dark database. It never applies 0105.
 */
export async function runExternalSchemaExact0104Recovery(
  config: ExternalSchemaExact0104RecoveryEnvironment,
): Promise<ExternalSchemaExact0104RecoverySummary> {
  const bundle = loadAndValidateExternalSchemaMigrationBundle(
    config.migrationsDir,
  );
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
    ]);
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      const applied = await client.query<AppliedMigrationRow>(
        "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      );
      validateExactAppliedMigrationSet("pre", applied.rows, bundle);
      const state = await readDatabaseState(client, "pre");
      validateExternalSchemaDatabaseState("pre", state, config);
      const backup = validateExact0104RecoveryBackupEvidence(
        await readLatestBackupEvidence(client),
        config,
        config.baselineCompletedAt,
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        decision: "READY_0104_RECOVERY",
        environmentId: config.environmentId,
        databaseName: state.databaseName,
        databaseUser: state.databaseUser,
        buildSha: config.buildSha,
        expectedMigrations: 104,
        latestExpectedTag: "0104_thin_sheva_callister",
        excludedMigration0100Present: false,
        excludedMigration0105Present: false,
        externalStateRows: 0,
        baselineCompletedAt: config.baselineCompletedAt.toISOString(),
        backup,
        authorizes0105: false,
      };
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [
          EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/**
 * Read-only restored-database inventory for R16-C3B. A valid prefix behind
 * 0104 is reported as a separate baseline requirement; drift is never
 * reinterpreted as a baseline candidate.
 */
export async function runExternalSchemaInventory(
  config: ExternalSchemaInventoryEnvironment,
): Promise<ExternalSchemaInventorySummary> {
  const bundle = loadAndValidateExternalSchemaMigrationBundle(
    config.migrationsDir,
  );
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
    ]);
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      const applied = await client.query<AppliedMigrationRow>(
        "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      );
      const classification = classifyExternalSchemaAppliedMigrations(
        applied.rows,
        bundle,
      );
      const stateMode =
        classification.decision === "ALREADY_0105" ? "post" : "pre";
      const state = await readDatabaseState(client, stateMode);
      validateExternalSchemaDatabaseState(stateMode, state, config);

      let backup: ValidatedStagingBackupEvidence | null = null;
      if (classification.decision !== "ALREADY_0105") {
        backup = validateStagingBackupEvidence(
          await readLatestBackupEvidence(client),
          config,
        );
      }

      await client.query("COMMIT");
      transactionOpen = false;
      return {
        ...classification,
        environmentId: config.environmentId,
        databaseName: state.databaseName,
        databaseUser: state.databaseUser,
        buildSha: config.buildSha,
        backupEvidenceId: backup?.id ?? null,
        backupRestoreAgeHours:
          backup === null
            ? null
            : Math.round(backup.restoreAgeHours * 1000) / 1000,
      };
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [
          EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/**
 * Steady-state restart gate. It proves exact 0105, schema completeness, dark
 * runtime and zero external rows without coupling routine restarts to the
 * historical transition backup ID or its freshness window.
 */
export async function runExternalSchemaSteadyState(
  config: ExternalSchemaRuntimeEnvironment,
): Promise<ExternalSchemaSteadyStateSummary> {
  const bundle = loadAndValidateExternalSchemaMigrationBundle(
    config.migrationsDir,
  );
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
    ]);
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      const applied = await client.query<AppliedMigrationRow>(
        "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      );
      validateExactAppliedMigrationSet("post", applied.rows, bundle);
      const state = await readDatabaseState(client, "post");
      validateExternalSchemaDatabaseState("post", state, config);
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        decision: "ALREADY_0105",
        environmentId: config.environmentId,
        databaseName: state.databaseName,
        databaseUser: state.databaseUser,
        buildSha: config.buildSha,
        expectedMigrations: bundle.post.length,
        latestExpectedTag: bundle.post.at(-1)?.tag ?? "",
        externalStateRows:
          state.externalUsers +
          state.externalAccounts +
          state.externalScopes +
          state.externalEvents,
      };
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [
          EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

export async function runExternalSchemaPreflight(
  config: ExternalSchemaPreflightEnvironment,
): Promise<ExternalSchemaPreflightSummary> {
  const bundle = loadAndValidateExternalSchemaMigrationBundle(
    config.migrationsDir,
  );
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
    ]);
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      const applied = await client.query<AppliedMigrationRow>(
        "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      );
      validateExactAppliedMigrationSet(config.mode, applied.rows, bundle);
      const backup = validateStagingBackupEvidence(
        await readLatestBackupEvidence(client),
        config,
      );
      const state = await readDatabaseState(client, config.mode);
      validateExternalSchemaDatabaseState(config.mode, state, config);
      await client.query("COMMIT");
      transactionOpen = false;
      const expected = config.mode === "pre" ? bundle.pre : bundle.post;
      return {
        mode: config.mode,
        environmentId: config.environmentId,
        databaseName: state.databaseName,
        databaseUser: state.databaseUser,
        buildSha: config.buildSha,
        expectedMigrations: expected.length,
        latestExpectedTag: expected.at(-1)?.tag ?? "",
        externalStateRows:
          state.externalUsers +
          state.externalAccounts +
          state.externalScopes +
          state.externalEvents,
        backupEvidenceId: backup.id,
        backupRestoreAgeHours: Math.round(backup.restoreAgeHours * 1000) / 1000,
      };
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [
          EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}
