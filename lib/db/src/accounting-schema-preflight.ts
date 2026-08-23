import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
  ExternalSchemaPreflightError,
  readExternalSchemaDatabaseState,
  readExternalSchemaRuntimeEnvironment,
  validateExternalSchemaDatabaseState,
  validateStagingBackupEvidenceSnapshot,
  type AppliedMigrationRow,
  type Exact0104RecoveryBackupEvidence,
  type ExternalSchemaEnvironment,
  type ExternalSchemaRuntimeEnvironment,
  type ExpectedAppliedMigration,
  type MigrationJournalEntry,
  type StagingBackupEvidenceRow,
} from "./external-schema-preflight.js";

const { Client } = pg;

export const ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT = 106;
export const ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION =
  "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING";

export const ACCOUNTING_SCHEMA_MIGRATIONS = Object.freeze({
  predecessor: Object.freeze({
    idx: 105,
    when: 1786383367000,
    tag: "0105_smooth_nitro",
    hash: "a7ecbfc67e2d91885ac554e958d66922246ddc32383271cfc336d075acc31a71",
  }),
  target: Object.freeze({
    idx: 106,
    when: 1786459128910,
    tag: "0106_graceful_frog_thor",
    hash: "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
  }),
});

const SNAPSHOTS = Object.freeze({
  predecessor: Object.freeze({
    id: "f51bb127-7c9e-4351-a1b5-5500f72424f9",
    sha256: "e64a0d3dc29f4d89f21d68afd6b539c952d5ed1af06406f06415bc229e953188",
  }),
  target: Object.freeze({
    id: "18841ec6-0ec2-4ae8-8ac7-8ee8c1eb34cd",
    sha256: "32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24",
  }),
});

const EXPECTED_TABLES = Object.freeze([
  "accounting_aggregate_heads",
  "accounting_document_versions",
  "accounting_export_outbox",
  "accounting_lifecycle_events",
  "accounting_payment_events",
  "accounting_reason_artifacts",
  "accounting_version_relations",
  "accounting_warehouse_price_observations",
  "accounting_warehouse_price_projection_heads",
]);

const EXPECTED_FUNCTIONS = Object.freeze([
  "deny_accounting_evidence_mutation",
  "guard_accounting_aggregate_head_transition",
  "guard_accounting_evidence_insert_binding",
  "guard_accounting_outbox_transition",
  "guard_accounting_warehouse_price_projection_head",
]);

const EXPECTED_TRIGGERS = Object.freeze([
  "accounting_aggregate_heads_guard_trg",
  "accounting_document_versions_immutable_trg",
  "accounting_export_outbox_guard_trg",
  "accounting_lifecycle_events_binding_trg",
  "accounting_lifecycle_events_immutable_trg",
  "accounting_payment_events_binding_trg",
  "accounting_payment_events_immutable_trg",
  "accounting_reason_artifacts_binding_trg",
  "accounting_reason_artifacts_immutable_trg",
  "accounting_version_relations_immutable_trg",
  "accounting_warehouse_price_observations_binding_trg",
  "accounting_warehouse_price_observations_immutable_trg",
  "accounting_warehouse_price_projection_heads_guard_trg",
]);

export type AccountingSchemaPreflightMode = "pre" | "post";
export type AccountingSchemaDatabaseMode =
  | AccountingSchemaPreflightMode
  | "steady";

export interface AccountingSchemaEnvironment extends ExternalSchemaEnvironment {}

export interface AccountingSchemaPreflightEnvironment extends AccountingSchemaEnvironment {
  mode: AccountingSchemaPreflightMode;
}

export interface AccountingSchemaExpectedObjects {
  tables: readonly string[];
  functions: readonly string[];
  triggers: readonly string[];
  indexes: readonly string[];
  constraints: readonly string[];
}

export interface AccountingSchemaMigrationBundleInput {
  journalEntries: readonly MigrationJournalEntry[];
  sqlByTag: ReadonlyMap<string, string>;
  migrationSqlFileNames: readonly string[];
  snapshot0105Bytes: string;
  snapshot0105: unknown;
  snapshot0106Bytes: string;
  snapshot0106: unknown;
}

export interface ValidatedAccountingSchemaBundle {
  /** Exact historical 0106 contract used by the one-step transition. */
  all: readonly ExpectedAppliedMigration[];
  pre: readonly ExpectedAppliedMigration[];
  post: readonly ExpectedAppliedMigration[];
  /** Full validated journal bundled in the current image for steady state. */
  known: readonly ExpectedAppliedMigration[];
  expectedObjects: AccountingSchemaExpectedObjects;
  snapshot0105Sha256: string;
  snapshot0106Sha256: string;
}

export interface AccountingSchemaDatabaseState {
  databaseName: string;
  databaseUser: string;
  tables: ReadonlySet<string>;
  tableSafety: ReadonlyMap<
    string,
    Readonly<{ kind: string; persistence: string; rowSecurity: boolean }>
  >;
  functions: ReadonlySet<string>;
  indexes: ReadonlySet<string>;
  constraints: ReadonlyMap<string, boolean>;
  triggers: ReadonlyMap<string, string>;
  rowCounts: ReadonlyMap<string, number>;
}

export type AccountingSchemaInventoryDecision =
  | "BASELINE_0105_REQUIRED"
  | "READY_0105"
  | "ALREADY_0106";

export interface AccountingSchemaInventoryClassification {
  decision: AccountingSchemaInventoryDecision;
  appliedMigrations: number;
  predecessorMigrations: number;
  latestAppliedTag: string | null;
  missingToPredecessor: number;
}

export interface AccountingSchemaInventorySummary extends AccountingSchemaInventoryClassification {
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  backupEvidenceId: number | null;
  backupRestoreAgeHours: number | null;
  externalStateRows: number;
}

export interface AccountingSchemaPreflightSummary {
  decision: "READY_0105" | "ALREADY_0106";
  mode: AccountingSchemaPreflightMode;
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  expectedMigrations: 106;
  latestExpectedTag: "0106_graceful_frog_thor";
  accountingEvidenceRows: number;
  externalStateRows: number;
  backupEvidenceId: number;
  backupRestoreAgeHours: number;
  backupEvidence: Exact0104RecoveryBackupEvidence;
}

export interface AccountingSchemaSteadyStateSummary {
  decision: "ALREADY_0106";
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  expectedMigrations: 106;
  latestExpectedTag: "0106_graceful_frog_thor";
  accountingEvidenceRows: number;
  externalStateRows: number;
}

type SnapshotTable = {
  name?: unknown;
  columns?: unknown;
  indexes?: unknown;
  foreignKeys?: unknown;
  compositePrimaryKeys?: unknown;
  uniqueConstraints?: unknown;
  checkConstraints?: unknown;
};

type Snapshot = {
  id?: unknown;
  prevId?: unknown;
  tables?: unknown;
};

type Queryable = Pick<pg.Client, "query">;

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(code, message);
}

function canonicalLf(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(canonicalLf(value)).digest("hex");
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) fail("ENV_MISSING", `${key} must be set.`);
  return value;
}

function sortedUnique(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (
    values.some((value) => !value) ||
    new Set(values).size !== values.length
  ) {
    fail(
      "SNAPSHOT_OBJECT_INVALID",
      `${label} names must be nonempty and unique.`,
    );
  }
  return Object.freeze([...values].sort());
}

function postgresIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    fail(
      "SNAPSHOT_OBJECT_INVALID",
      "Accounting database object names must use lowercase ASCII identifiers.",
    );
  }
  // PostgreSQL 16 uses NAMEDATALEN=64 and therefore stores at most 63 bytes.
  // All generated identifiers above are ASCII, so byte and character slicing
  // are equivalent. sortedUnique() then rejects any truncation collision.
  return value.length <= 63 ? value : value.slice(0, 63);
}

function exactSet(
  actual: ReadonlySet<string>,
  expected: readonly string[],
  code: string,
  label: string,
): void {
  const missing = expected.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      code,
      `${label} mismatch; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}.`,
    );
  }
}

function objectKeys(value: unknown, field: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SNAPSHOT_OBJECT_INVALID", `${field} must be an object.`);
  }
  return Object.keys(value);
}

function snapshotExpectedObjects(
  snapshot: Snapshot,
): AccountingSchemaExpectedObjects {
  if (
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    Array.isArray(snapshot.tables)
  ) {
    fail("SNAPSHOT_OBJECT_INVALID", "0106 snapshot tables must be an object.");
  }

  const accountingTables = Object.entries(
    snapshot.tables as Record<string, SnapshotTable>,
  )
    .filter(([name]) => name.startsWith("public.accounting_"))
    .map(([, table]) => table);
  const tables = accountingTables.map((table) => {
    if (typeof table.name !== "string") {
      fail(
        "SNAPSHOT_OBJECT_INVALID",
        "Accounting snapshot table names must be strings.",
      );
    }
    return postgresIdentifier(table.name);
  });
  if (
    JSON.stringify([...tables].sort()) !==
    JSON.stringify([...EXPECTED_TABLES].sort())
  ) {
    fail(
      "SNAPSHOT_TABLE_SET_MISMATCH",
      "0106 snapshot has the wrong accounting table set.",
    );
  }

  const indexes: string[] = [];
  const constraints: string[] = [];
  for (const table of accountingTables) {
    const tableName = table.name as string;
    indexes.push(
      ...objectKeys(table.indexes ?? {}, `${tableName}.indexes`).map(
        postgresIdentifier,
      ),
    );
    constraints.push(
      ...objectKeys(table.foreignKeys ?? {}, `${tableName}.foreignKeys`).map(
        postgresIdentifier,
      ),
    );
    constraints.push(
      ...objectKeys(
        table.compositePrimaryKeys ?? {},
        `${tableName}.compositePrimaryKeys`,
      ).map(postgresIdentifier),
    );
    const uniqueConstraints = objectKeys(
      table.uniqueConstraints ?? {},
      `${tableName}.uniqueConstraints`,
    );
    constraints.push(...uniqueConstraints.map(postgresIdentifier));
    indexes.push(...uniqueConstraints.map(postgresIdentifier));
    constraints.push(
      ...objectKeys(
        table.checkConstraints ?? {},
        `${tableName}.checkConstraints`,
      ).map(postgresIdentifier),
    );

    if (
      !table.columns ||
      typeof table.columns !== "object" ||
      Array.isArray(table.columns)
    ) {
      fail(
        "SNAPSHOT_OBJECT_INVALID",
        `${tableName}.columns must be an object.`,
      );
    }
    const primaryColumns = Object.values(
      table.columns as Record<string, { primaryKey?: unknown }>,
    ).filter((column) => column.primaryKey === true);
    if (primaryColumns.length !== 1) {
      fail(
        "SNAPSHOT_PRIMARY_KEY_INVALID",
        `${tableName} must have one simple primary key.`,
      );
    }
    const primaryKey = postgresIdentifier(`${tableName}_pkey`);
    constraints.push(primaryKey);
    indexes.push(primaryKey);
  }

  const expectedObjects = Object.freeze({
    tables: sortedUnique(tables, "tables"),
    functions: sortedUnique(
      EXPECTED_FUNCTIONS.map(postgresIdentifier),
      "functions",
    ),
    triggers: sortedUnique(
      EXPECTED_TRIGGERS.map(postgresIdentifier),
      "triggers",
    ),
    indexes: sortedUnique(indexes, "indexes"),
    constraints: sortedUnique(constraints, "constraints"),
  });
  if (
    expectedObjects.indexes.length !== 31 ||
    expectedObjects.constraints.length !== 116
  ) {
    fail(
      "SNAPSHOT_OBJECT_COUNT_MISMATCH",
      "0106 snapshot must describe exactly 31 accounting indexes and 116 accounting constraints.",
    );
  }
  return expectedObjects;
}

export function validateAccountingSchemaMigrationBundle(
  input: AccountingSchemaMigrationBundleInput,
): ValidatedAccountingSchemaBundle {
  const entries = [...input.journalEntries];
  if (entries.length < ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT) {
    fail(
      "JOURNAL_COUNT_MISMATCH",
      `Expected at least ${ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT} journal entries.`,
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

  for (const [actual, expected, label] of [
    [
      entries[ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT - 2],
      ACCOUNTING_SCHEMA_MIGRATIONS.predecessor,
      "predecessor",
    ],
    [
      entries[ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT - 1],
      ACCOUNTING_SCHEMA_MIGRATIONS.target,
      "target",
    ],
  ] as const) {
    if (
      actual?.idx !== expected.idx ||
      actual.when !== expected.when ||
      actual.tag !== expected.tag
    ) {
      fail(
        "JOURNAL_TAIL_MISMATCH",
        `Accounting schema ${label} must be ${expected.tag}.`,
      );
    }
  }

  const sqlNames = new Set(input.migrationSqlFileNames);
  const expectedSqlNames = new Set(entries.map((entry) => `${entry.tag}.sql`));
  if (
    sqlNames.size !== expectedSqlNames.size ||
    [...sqlNames].some((name) => !expectedSqlNames.has(name))
  ) {
    fail(
      "MIGRATION_FILE_SET_MISMATCH",
      "SQL files must match the exact journal tag set.",
    );
  }

  const known = entries.map((entry): ExpectedAppliedMigration => {
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
  for (const expected of Object.values(ACCOUNTING_SCHEMA_MIGRATIONS)) {
    const actual = known.find((migration) => migration.tag === expected.tag);
    if (actual?.hash !== expected.hash) {
      fail(
        "MIGRATION_HASH_MISMATCH",
        `Pinned hash mismatch for ${expected.tag}.`,
      );
    }
  }

  const predecessor = input.snapshot0105 as Snapshot;
  const target = input.snapshot0106 as Snapshot;
  const snapshot0105Sha256 = sha256(input.snapshot0105Bytes);
  const snapshot0106Sha256 = sha256(input.snapshot0106Bytes);
  if (
    predecessor.id !== SNAPSHOTS.predecessor.id ||
    target.id !== SNAPSHOTS.target.id ||
    target.prevId !== predecessor.id ||
    snapshot0105Sha256 !== SNAPSHOTS.predecessor.sha256 ||
    snapshot0106Sha256 !== SNAPSHOTS.target.sha256
  ) {
    fail(
      "SNAPSHOT_CHAIN_MISMATCH",
      "Pinned 0106 snapshot must directly follow the pinned 0105 snapshot.",
    );
  }

  const all = known.slice(0, ACCOUNTING_SCHEMA_EXPECTED_JOURNAL_COUNT);
  return Object.freeze({
    all: Object.freeze(all),
    pre: Object.freeze(all.slice(0, -1)),
    post: Object.freeze(all),
    known: Object.freeze(known),
    expectedObjects: snapshotExpectedObjects(target),
    snapshot0105Sha256,
    snapshot0106Sha256,
  });
}

function readJsonWithBytes(pathname: string): {
  bytes: string;
  value: unknown;
} {
  try {
    const bytes = readFileSync(pathname, "utf8");
    return { bytes, value: JSON.parse(bytes) };
  } catch {
    fail(
      "BUNDLE_FILE_INVALID",
      `Cannot read or parse ${path.basename(pathname)}.`,
    );
  }
}

export function loadAndValidateAccountingSchemaMigrationBundle(
  migrationsDir: string,
): ValidatedAccountingSchemaBundle {
  const journal = readJsonWithBytes(
    path.join(migrationsDir, "meta", "_journal.json"),
  ).value as {
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
  const snapshot0105 = readJsonWithBytes(
    path.join(migrationsDir, "meta", "0105_snapshot.json"),
  );
  const snapshot0106 = readJsonWithBytes(
    path.join(migrationsDir, "meta", "0106_snapshot.json"),
  );
  return validateAccountingSchemaMigrationBundle({
    journalEntries: journal.entries as MigrationJournalEntry[],
    sqlByTag,
    migrationSqlFileNames,
    snapshot0105Bytes: snapshot0105.bytes,
    snapshot0105: snapshot0105.value,
    snapshot0106Bytes: snapshot0106.bytes,
    snapshot0106: snapshot0106.value,
  });
}

function appliedMap(rows: readonly AppliedMigrationRow[]): Map<number, string> {
  const actual = new Map<number, string>();
  for (const row of rows) {
    const when = Number(row.created_at);
    if (!Number.isSafeInteger(when) || typeof row.hash !== "string") {
      fail(
        "APPLIED_ROW_INVALID",
        "Applied rows must have finite timestamps and hashes.",
      );
    }
    if (actual.has(when)) {
      fail("APPLIED_DUPLICATE", "Applied migration timestamps must be unique.");
    }
    actual.set(when, row.hash.toLowerCase());
  }
  return actual;
}

function validateAppliedPrefix(
  rows: readonly AppliedMigrationRow[],
  expected: readonly ExpectedAppliedMigration[],
): void {
  const actual = appliedMap(rows);
  for (const migration of expected) {
    if (actual.get(migration.when) !== migration.hash) {
      fail(
        "APPLIED_SET_MISMATCH",
        `Applied migration mismatch at ${migration.tag}.`,
      );
    }
  }
}

export function validateExactAccountingAppliedMigrationSet(
  mode: AccountingSchemaPreflightMode | "steady",
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedAccountingSchemaBundle,
): void {
  const expected =
    mode === "pre" ? bundle.pre : mode === "post" ? bundle.post : bundle.known;
  if (rows.length !== expected.length) {
    fail(
      "APPLIED_COUNT_MISMATCH",
      `Database must contain exactly ${expected.length} rows.`,
    );
  }
  validateAppliedPrefix(rows, expected);
}

export function classifyAccountingSchemaAppliedMigrations(
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedAccountingSchemaBundle,
): AccountingSchemaInventoryClassification {
  if (rows.length > bundle.post.length) {
    fail(
      "APPLIED_COUNT_EXCEEDS_BUNDLE",
      "Database contains rows beyond approved 0106.",
    );
  }
  validateAppliedPrefix(rows, bundle.post.slice(0, rows.length));
  const appliedMigrations = rows.length;
  const predecessorMigrations = bundle.pre.length;
  const latestAppliedTag =
    bundle.post.slice(0, rows.length).at(-1)?.tag ?? null;
  if (appliedMigrations === bundle.post.length) {
    return {
      decision: "ALREADY_0106",
      appliedMigrations,
      predecessorMigrations,
      latestAppliedTag,
      missingToPredecessor: 0,
    };
  }
  if (appliedMigrations === predecessorMigrations) {
    return {
      decision: "READY_0105",
      appliedMigrations,
      predecessorMigrations,
      latestAppliedTag,
      missingToPredecessor: 0,
    };
  }
  return {
    decision: "BASELINE_0105_REQUIRED",
    appliedMigrations,
    predecessorMigrations,
    latestAppliedTag,
    missingToPredecessor: predecessorMigrations - appliedMigrations,
  };
}

export function validateAccountingSchemaDatabaseState(
  mode: AccountingSchemaDatabaseMode,
  state: AccountingSchemaDatabaseState,
  expectedIdentity: Pick<
    ExternalSchemaRuntimeEnvironment,
    "expectedDatabaseName" | "expectedDatabaseUser"
  >,
  expectedObjects: AccountingSchemaExpectedObjects,
): void {
  if (
    state.databaseName !== expectedIdentity.expectedDatabaseName ||
    state.databaseUser !== expectedIdentity.expectedDatabaseUser
  ) {
    fail(
      "LIVE_DATABASE_IDENTITY_MISMATCH",
      "Live database is not the approved staging target.",
    );
  }

  if (mode === "pre") {
    if (
      state.tables.size !== 0 ||
      state.functions.size !== 0 ||
      state.indexes.size !== 0 ||
      state.constraints.size !== 0 ||
      state.triggers.size !== 0 ||
      state.rowCounts.size !== 0
    ) {
      fail(
        "PRE_SCHEMA_DRIFT",
        "0106 accounting objects must be absent before migration.",
      );
    }
    return;
  }

  exactSet(
    state.tables,
    expectedObjects.tables,
    "POST_SCHEMA_INCOMPLETE",
    "tables",
  );
  exactSet(
    state.functions,
    expectedObjects.functions,
    "POST_SCHEMA_INCOMPLETE",
    "functions",
  );
  exactSet(
    state.indexes,
    expectedObjects.indexes,
    "POST_SCHEMA_INCOMPLETE",
    "indexes",
  );
  exactSet(
    new Set(state.constraints.keys()),
    expectedObjects.constraints,
    "POST_SCHEMA_INCOMPLETE",
    "constraints",
  );
  exactSet(
    new Set(state.triggers.keys()),
    expectedObjects.triggers,
    "POST_SCHEMA_INCOMPLETE",
    "triggers",
  );
  exactSet(
    new Set(state.tableSafety.keys()),
    expectedObjects.tables,
    "POST_SCHEMA_INCOMPLETE",
    "table safety",
  );
  exactSet(
    new Set(state.rowCounts.keys()),
    expectedObjects.tables,
    "POST_SCHEMA_INCOMPLETE",
    "row counts",
  );
  if (
    [...state.tableSafety.values()].some(
      (table) =>
        table.kind !== "r" || table.persistence !== "p" || table.rowSecurity,
    )
  ) {
    fail(
      "POST_TABLE_SAFETY_INVALID",
      "Accounting tables must be persistent regular non-RLS tables.",
    );
  }
  if ([...state.constraints.values()].some((valid) => !valid)) {
    fail(
      "POST_CONSTRAINT_INVALID",
      "All accounting constraints must be validated.",
    );
  }
  if ([...state.triggers.values()].some((enabled) => enabled !== "O")) {
    fail(
      "POST_TRIGGER_DISABLED",
      "All accounting triggers must be enabled in origin mode.",
    );
  }
  if (
    [...state.rowCounts.values()].some(
      (count) =>
        !Number.isSafeInteger(count) ||
        count < 0 ||
        (mode === "post" && count !== 0),
    )
  ) {
    fail(
      mode === "post"
        ? "POST_ACCOUNTING_STATE_NOT_EMPTY"
        : "ACCOUNTING_ROW_COUNT_INVALID",
      mode === "post"
        ? "Accounting evidence tables must be empty at transition completion."
        : "Accounting row counts must be nonnegative safe integers.",
    );
  }
}

function accountingRows(state: AccountingSchemaDatabaseState): number {
  return [...state.rowCounts.values()].reduce((sum, count) => sum + count, 0);
}

function externalRows(
  state: Awaited<ReturnType<typeof readExternalSchemaDatabaseState>>,
): number {
  return (
    state.externalUsers +
    state.externalAccounts +
    state.externalScopes +
    state.externalEvents
  );
}

function readAccountingSchemaEnvironment(
  env: NodeJS.ProcessEnv,
): AccountingSchemaEnvironment {
  const runtime = readExternalSchemaRuntimeEnvironment(env);
  const backupEvidenceId = Number(required(env, "STAGING_BACKUP_EVIDENCE_ID"));
  const backupRestoreMaxAgeHours = Number(
    required(env, "STAGING_BACKUP_RESTORE_MAX_AGE_HOURS"),
  );
  if (!Number.isSafeInteger(backupEvidenceId) || backupEvidenceId <= 0) {
    fail(
      "BACKUP_EVIDENCE_ID_INVALID",
      "STAGING_BACKUP_EVIDENCE_ID must be positive.",
    );
  }
  if (
    !Number.isInteger(backupRestoreMaxAgeHours) ||
    backupRestoreMaxAgeHours < 1 ||
    backupRestoreMaxAgeHours > 168
  ) {
    fail(
      "BACKUP_RESTORE_MAX_AGE_INVALID",
      "Backup max age must be 1 through 168 hours.",
    );
  }
  return { ...runtime, backupEvidenceId, backupRestoreMaxAgeHours };
}

export function readAccountingSchemaInventoryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AccountingSchemaEnvironment {
  return readAccountingSchemaEnvironment(env);
}

export function readAccountingSchemaPreflightEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AccountingSchemaPreflightEnvironment {
  const mode = required(env, "ACCOUNTING_SCHEMA_PREFLIGHT_MODE");
  if (mode !== "pre" && mode !== "post") {
    fail(
      "MODE_INVALID",
      "ACCOUNTING_SCHEMA_PREFLIGHT_MODE must be pre or post.",
    );
  }
  if (
    required(env, "ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION") !==
    ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_INVALID",
      "The exact isolated 0106 confirmation phrase is required.",
    );
  }
  return { mode, ...readAccountingSchemaEnvironment(env) };
}

async function readAppliedMigrations(
  client: Queryable,
): Promise<AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(
    "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
  );
  return result.rows;
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

async function readAccountingDatabaseState(
  client: Queryable,
  mode: AccountingSchemaDatabaseMode,
): Promise<AccountingSchemaDatabaseState> {
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
    table_kind: string | null;
    table_persistence: string | null;
    row_security: boolean | null;
  }>(`WITH accounting_rels AS (
      SELECT c.oid, c.relname, c.relkind::text, c.relpersistence::text, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname LIKE 'accounting\\_%' ESCAPE '\\'
    )
    SELECT 'table' AS object_kind, r.relname AS object_name,
           NULL::boolean AS object_valid, NULL::text AS object_enabled,
           r.relkind AS table_kind, r.relpersistence AS table_persistence,
           r.relrowsecurity AS row_security
      FROM accounting_rels r WHERE r.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'function', p.proname, NULL::boolean, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'deny_accounting\\_%' ESCAPE '\\'
         OR p.proname LIKE 'guard_accounting\\_%' ESCAPE '\\')
    UNION ALL
    SELECT 'index', i.indexname, NULL::boolean, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_indexes i WHERE i.schemaname = 'public'
       AND i.tablename LIKE 'accounting\\_%' ESCAPE '\\'
    UNION ALL
    SELECT 'constraint', con.conname, con.convalidated, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_constraint con JOIN accounting_rels r ON r.oid = con.conrelid
     WHERE con.contype <> 'n'
    UNION ALL
    SELECT 'trigger', t.tgname, NULL::boolean, t.tgenabled::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_trigger t JOIN accounting_rels r ON r.oid = t.tgrelid
     WHERE NOT t.tgisinternal`);

  const tables = new Set<string>();
  const tableSafety = new Map<
    string,
    Readonly<{ kind: string; persistence: string; rowSecurity: boolean }>
  >();
  const functions = new Set<string>();
  const indexes = new Set<string>();
  const constraints = new Map<string, boolean>();
  const triggers = new Map<string, string>();
  for (const row of schema.rows) {
    if (row.object_kind === "table") {
      tables.add(row.object_name);
      tableSafety.set(row.object_name, {
        kind: row.table_kind ?? "",
        persistence: row.table_persistence ?? "",
        rowSecurity: row.row_security === true,
      });
    } else if (row.object_kind === "function") functions.add(row.object_name);
    else if (row.object_kind === "index") indexes.add(row.object_name);
    else if (row.object_kind === "constraint") {
      constraints.set(row.object_name, row.object_valid === true);
    } else if (row.object_kind === "trigger") {
      triggers.set(row.object_name, row.object_enabled ?? "");
    }
  }

  const rowCounts = new Map<string, number>();
  if (mode !== "pre") {
    const result = await client.query<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM accounting_aggregate_heads) AS accounting_aggregate_heads,
      (SELECT count(*)::int FROM accounting_document_versions) AS accounting_document_versions,
      (SELECT count(*)::int FROM accounting_export_outbox) AS accounting_export_outbox,
      (SELECT count(*)::int FROM accounting_lifecycle_events) AS accounting_lifecycle_events,
      (SELECT count(*)::int FROM accounting_payment_events) AS accounting_payment_events,
      (SELECT count(*)::int FROM accounting_reason_artifacts) AS accounting_reason_artifacts,
      (SELECT count(*)::int FROM accounting_version_relations) AS accounting_version_relations,
      (SELECT count(*)::int FROM accounting_warehouse_price_observations) AS accounting_warehouse_price_observations,
      (SELECT count(*)::int FROM accounting_warehouse_price_projection_heads) AS accounting_warehouse_price_projection_heads`);
    const counts = result.rows[0] ?? {};
    for (const table of EXPECTED_TABLES)
      rowCounts.set(table, Number(counts[table]));
  }

  return {
    databaseName: identity.rows[0]?.database_name ?? "",
    databaseUser: identity.rows[0]?.database_user ?? "",
    tables,
    tableSafety,
    functions,
    indexes,
    constraints,
    triggers,
    rowCounts,
  };
}

async function withLockedReadOnly<T>(
  databaseUrl: string,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
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
      const result = await operation(client);
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
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

export async function runAccountingSchemaInventory(
  config: AccountingSchemaEnvironment,
): Promise<AccountingSchemaInventorySummary> {
  const bundle = loadAndValidateAccountingSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const classification = classifyAccountingSchemaAppliedMigrations(
      await readAppliedMigrations(client),
      bundle,
    );
    const mode = classification.decision === "ALREADY_0106" ? "steady" : "pre";
    const state = await readAccountingDatabaseState(client, mode);
    validateAccountingSchemaDatabaseState(
      mode,
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    const backup =
      classification.decision === "ALREADY_0106"
        ? null
        : validateStagingBackupEvidenceSnapshot(
            await readLatestBackupEvidence(client),
            config,
          );
    return {
      ...classification,
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      backupEvidenceId: backup?.id ?? null,
      backupRestoreAgeHours: backup?.restoreAgeHours ?? null,
      externalStateRows: externalRows(externalState),
    };
  });
}

export async function runAccountingSchemaPreflight(
  config: AccountingSchemaPreflightEnvironment,
): Promise<AccountingSchemaPreflightSummary> {
  const bundle = loadAndValidateAccountingSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const applied = await readAppliedMigrations(client);
    validateExactAccountingAppliedMigrationSet(config.mode, applied, bundle);
    const state = await readAccountingDatabaseState(client, config.mode);
    validateAccountingSchemaDatabaseState(
      config.mode,
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    const backup = validateStagingBackupEvidenceSnapshot(
      await readLatestBackupEvidence(client),
      config,
    );
    return {
      decision: config.mode === "pre" ? "READY_0105" : "ALREADY_0106",
      mode: config.mode,
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      expectedMigrations: 106,
      latestExpectedTag: "0106_graceful_frog_thor",
      accountingEvidenceRows: accountingRows(state),
      externalStateRows: externalRows(externalState),
      backupEvidenceId: backup.id,
      backupRestoreAgeHours: backup.restoreAgeHours,
      backupEvidence: backup,
    };
  });
}

export async function runAccountingSchemaSteadyState(
  config: ExternalSchemaRuntimeEnvironment,
): Promise<AccountingSchemaSteadyStateSummary> {
  const bundle = loadAndValidateAccountingSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const applied = await readAppliedMigrations(client);
    validateExactAccountingAppliedMigrationSet("steady", applied, bundle);
    const state = await readAccountingDatabaseState(client, "steady");
    validateAccountingSchemaDatabaseState(
      "steady",
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    return {
      decision: "ALREADY_0106",
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      expectedMigrations: 106,
      latestExpectedTag: "0106_graceful_frog_thor",
      accountingEvidenceRows: accountingRows(state),
      externalStateRows: externalRows(externalState),
    };
  });
}
