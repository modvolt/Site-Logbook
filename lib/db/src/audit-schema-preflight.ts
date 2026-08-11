import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
  ExternalSchemaPreflightError,
  readExternalSchemaDatabaseState,
  readExternalSchemaInventoryEnvironment,
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

export const AUDIT_SCHEMA_EXPECTED_JOURNAL_COUNT = 107;
export const AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION =
  "APPLY_0107_AUDIT_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING";
export const AUDIT_SCHEMA_MIGRATIONS = Object.freeze({
  predecessor: Object.freeze({
    idx: 106,
    when: 1786459128910,
    tag: "0106_graceful_frog_thor",
    hash: "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
  }),
  target: Object.freeze({
    idx: 107,
    when: 1786484628859,
    tag: "0107_canonical_audit_evidence",
    hash: "5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339",
  }),
});

export const AUDIT_SCHEMA_SNAPSHOTS = Object.freeze({
  predecessor: Object.freeze({
    id: "18841ec6-0ec2-4ae8-8ac7-8ee8c1eb34cd",
    sha256: "32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24",
  }),
  target: Object.freeze({
    id: "b20520fc-59f2-4d34-9e2f-9d7ed565288a",
    sha256: "4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb",
  }),
});

export const AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS = Object.freeze([
  Object.freeze({
    createdAt: 1783190993468,
    hash: "fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927",
  }),
  Object.freeze({
    createdAt: 1783261969512,
    hash: "3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa",
  }),
] as const);

export const AUDIT_SCHEMA_KNOWN_ROWS_SHA256 = Object.freeze({
  predecessor:
    "sha256:cfbf74de83f99c3ca49fb717a6784265e8ef193e75e894aab9924fb7b80e16ee",
  target:
    "sha256:d34407b4cdb8b0dc8bb9d07cd6cd500be5853d3112e142fe44e0efa5b8cd7cc1",
});

export const AUDIT_SCHEMA_OPAQUE_ROWS_SHA256 = Object.freeze({
  clean:
    "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  productionCopyRestricted:
    "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201",
});

const EXPECTED_TABLES = Object.freeze([
  "audit_chain_heads",
  "audit_events",
  "audit_export_outbox",
]);

const EXPECTED_FUNCTIONS = Object.freeze([
  "audit_canonical_json",
  "audit_domain_sha256",
  "audit_event_core_semantics_are_valid",
  "audit_event_json_is_valid",
  "audit_export_intent_json_is_valid",
  "audit_json_has_exact_keys",
  "audit_json_is_safe_integer",
  "audit_json_is_sha256",
  "audit_json_is_string_or_null",
  "audit_ledger_json_is_valid",
  "audit_state_json_is_valid",
  "deny_audit_event_mutation",
  "guard_audit_chain_head_transition",
  "guard_audit_event_commit_binding",
  "guard_audit_event_insert",
  "guard_audit_export_outbox_transition",
]);

const EXPECTED_TRIGGERS = Object.freeze([
  "audit_chain_heads_guard_trg",
  "audit_events_commit_binding_trg",
  "audit_events_immutable_trg",
  "audit_events_insert_guard_trg",
  "audit_export_outbox_guard_trg",
]);

export type AuditSchemaPreflightMode = "pre" | "post";
export type AuditSchemaDatabaseMode = AuditSchemaPreflightMode | "steady";
export type AuditSchemaLineageMode = "clean" | "production-copy-restricted";

export interface AuditSchemaOpaqueLegacyRow {
  createdAt: number;
  hash: string;
}

export interface AuditSchemaEnvironment extends ExternalSchemaEnvironment {
  lineageMode: AuditSchemaLineageMode;
  opaqueLegacyRows: readonly AuditSchemaOpaqueLegacyRow[];
}

export interface AuditSchemaRuntimeEnvironment extends ExternalSchemaRuntimeEnvironment {
  lineageMode: AuditSchemaLineageMode;
  opaqueLegacyRows: readonly AuditSchemaOpaqueLegacyRow[];
}

export interface AuditSchemaPreflightEnvironment extends AuditSchemaEnvironment {
  mode: AuditSchemaPreflightMode;
}

export interface AuditSchemaExpectedObjects {
  tables: readonly string[];
  functions: readonly string[];
  triggers: readonly string[];
  indexes: readonly string[];
  constraints: readonly string[];
}

export interface AuditSchemaMigrationBundleInput {
  journalEntries: readonly MigrationJournalEntry[];
  sqlByTag: ReadonlyMap<string, string>;
  migrationSqlFileNames: readonly string[];
  snapshot0106Bytes: string;
  snapshot0106: unknown;
  snapshot0107Bytes: string;
  snapshot0107: unknown;
}

export interface ValidatedAuditSchemaBundle {
  all: readonly ExpectedAppliedMigration[];
  pre: readonly ExpectedAppliedMigration[];
  post: readonly ExpectedAppliedMigration[];
  expectedObjects: AuditSchemaExpectedObjects;
  snapshot0106Sha256: string;
  snapshot0107Sha256: string;
}

export interface AuditSchemaDatabaseState {
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
  headStreamId: string | null;
  headSequence: number | null;
  headLedgerSha256: string | null;
  maximumEventSequence: number | null;
  maximumEventLedgerSha256: string | null;
}

export type AuditSchemaInventoryDecision =
  | "BASELINE_0106_REQUIRED"
  | "READY_0106"
  | "ALREADY_0107";

export interface AuditSchemaInventoryClassification {
  decision: AuditSchemaInventoryDecision;
  knownAppliedMigrations: number;
  latestKnownAppliedTag: string | null;
  missingKnownToPredecessor: number;
  knownAppliedRowsSha256: string;
  opaqueLegacyRowCount: 0 | 2;
  opaqueLegacyRowsSha256: string;
}

export interface AuditSchemaLineageSummary extends AuditSchemaInventoryClassification {
  mode: AuditSchemaLineageMode;
  knownExpectedMigrations: 107;
  opaqueLegacyMeaningInferred: false;
  excludedMigration0100Present: false;
}

export interface AuditSchemaStateSummary {
  targetTag: "0107_canonical_audit_evidence";
  targetSqlSha256: string;
  targetSnapshotSha256: string;
  auditEventRows: number;
  auditOutboxRows: number;
  auditHeadRows: number;
}

export interface AuditSchemaInventorySummary {
  schemaVersion: "site-logbook.audit-schema-inventory/v1";
  kind: "audit-schema-inventory";
  decision: AuditSchemaInventoryDecision;
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  lineage: AuditSchemaLineageSummary;
  schema: AuditSchemaStateSummary;
  backupEvidenceId: number;
  backupRestoreAgeHours: number;
  authorizesApplicationStart: false;
}

export interface AuditSchemaPreflightSummary {
  schemaVersion: "site-logbook.audit-schema-preflight/v1";
  kind: "audit-schema-preflight";
  decision: "READY_0106" | "ALREADY_0107";
  mode: AuditSchemaPreflightMode;
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  lineage: AuditSchemaLineageSummary;
  schema: AuditSchemaStateSummary;
  backupEvidenceId: number;
  backupRestoreAgeHours: number;
  backupEvidence: Exact0104RecoveryBackupEvidence;
  authorizesApplicationStart: false;
}

export interface AuditSchemaSteadyStateSummary {
  schemaVersion: "site-logbook.audit-schema-steady-state/v1";
  kind: "audit-schema-steady-state";
  decision: "ALREADY_0107";
  environmentId: string;
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  lineage: AuditSchemaLineageSummary;
  schema: AuditSchemaStateSummary;
  authorizesApplicationStart: true;
}

export interface AuditSchemaApplySummary {
  expectedCount: 107;
  latestExpectedTag: "0107_canonical_audit_evidence";
  newlyApplied: 0 | 1;
  knownAppliedBefore: 106 | 107;
  knownAppliedAfter: 107;
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

type Snapshot = { id?: unknown; prevId?: unknown; tables?: unknown };
type Queryable = Pick<pg.Client, "query">;

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(code, message);
}

function canonicalLf(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) {
    fail(
      "BUNDLE_LINE_ENDING_INVALID",
      "Bundle text contains a lone carriage return.",
    );
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(canonicalLf(value)).digest("hex");
}

function canonicalRowsSha256(
  rows: readonly AuditSchemaOpaqueLegacyRow[],
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) fail("ENV_MISSING", `${key} must be set.`);
  return value;
}

function postgresIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    fail(
      "SNAPSHOT_OBJECT_INVALID",
      "Audit objects must use lowercase ASCII identifiers.",
    );
  }
  return value.length <= 63 ? value : value.slice(0, 63);
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

function objectKeys(value: unknown, field: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SNAPSHOT_OBJECT_INVALID", `${field} must be an object.`);
  }
  return Object.keys(value);
}

function snapshotExpectedObjects(
  snapshot: Snapshot,
): AuditSchemaExpectedObjects {
  if (
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    Array.isArray(snapshot.tables)
  ) {
    fail("SNAPSHOT_OBJECT_INVALID", "0107 snapshot tables must be an object.");
  }
  const tablesByName = snapshot.tables as Record<string, SnapshotTable>;
  const auditTables = EXPECTED_TABLES.map((name) => {
    const table = tablesByName[`public.${name}`];
    if (!table || table.name !== name) {
      fail(
        "SNAPSHOT_TABLE_SET_MISMATCH",
        `0107 snapshot is missing public.${name}.`,
      );
    }
    return table;
  });

  const indexes: string[] = [];
  const constraints: string[] = [];
  for (const table of auditTables) {
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
    const unique = objectKeys(
      table.uniqueConstraints ?? {},
      `${tableName}.uniqueConstraints`,
    );
    constraints.push(...unique.map(postgresIdentifier));
    indexes.push(...unique.map(postgresIdentifier));
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
    const primary = Object.values(
      table.columns as Record<string, { primaryKey?: unknown }>,
    ).filter((column) => column.primaryKey === true);
    if (primary.length !== 1) {
      fail(
        "SNAPSHOT_PRIMARY_KEY_INVALID",
        `${tableName} must have one simple primary key.`,
      );
    }
    const pkey = postgresIdentifier(`${tableName}_pkey`);
    indexes.push(pkey);
    constraints.push(pkey);
  }

  const expected = Object.freeze({
    tables: sortedUnique(EXPECTED_TABLES, "tables"),
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
  if (expected.indexes.length !== 9 || expected.constraints.length !== 32) {
    fail(
      "SNAPSHOT_OBJECT_COUNT_MISMATCH",
      "0107 snapshot must describe 9 indexes and 32 constraints for the canonical audit tables.",
    );
  }
  return expected;
}

export function validateAuditSchemaMigrationBundle(
  input: AuditSchemaMigrationBundleInput,
): ValidatedAuditSchemaBundle {
  const entries = [...input.journalEntries];
  if (entries.length !== AUDIT_SCHEMA_EXPECTED_JOURNAL_COUNT) {
    fail(
      "JOURNAL_COUNT_MISMATCH",
      `Expected exactly ${AUDIT_SCHEMA_EXPECTED_JOURNAL_COUNT} journal entries.`,
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
    [entries.at(-2), AUDIT_SCHEMA_MIGRATIONS.predecessor, "predecessor"],
    [entries.at(-1), AUDIT_SCHEMA_MIGRATIONS.target, "target"],
  ] as const) {
    if (
      actual?.idx !== expected.idx ||
      actual.when !== expected.when ||
      actual.tag !== expected.tag
    ) {
      fail(
        "JOURNAL_TAIL_MISMATCH",
        `Audit schema ${label} must be ${expected.tag}.`,
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
  const all = entries.map((entry): ExpectedAppliedMigration => {
    const sql = input.sqlByTag.get(entry.tag);
    if (sql === undefined)
      fail("MIGRATION_FILE_MISSING", `Missing SQL for ${entry.tag}.`);
    return {
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
      hash: sha256(sql),
    };
  });
  for (const expected of Object.values(AUDIT_SCHEMA_MIGRATIONS)) {
    const actual = all.find((migration) => migration.tag === expected.tag);
    if (actual?.hash !== expected.hash) {
      fail(
        "MIGRATION_HASH_MISMATCH",
        `Pinned hash mismatch for ${expected.tag}.`,
      );
    }
  }
  const predecessor = input.snapshot0106 as Snapshot;
  const target = input.snapshot0107 as Snapshot;
  const snapshot0106Sha256 = sha256(input.snapshot0106Bytes);
  const snapshot0107Sha256 = sha256(input.snapshot0107Bytes);
  if (
    predecessor.id !== AUDIT_SCHEMA_SNAPSHOTS.predecessor.id ||
    target.id !== AUDIT_SCHEMA_SNAPSHOTS.target.id ||
    target.prevId !== predecessor.id ||
    snapshot0106Sha256 !== AUDIT_SCHEMA_SNAPSHOTS.predecessor.sha256 ||
    snapshot0107Sha256 !== AUDIT_SCHEMA_SNAPSHOTS.target.sha256
  ) {
    fail(
      "SNAPSHOT_CHAIN_MISMATCH",
      "Pinned 0107 snapshot must directly follow pinned 0106.",
    );
  }
  return Object.freeze({
    all: Object.freeze(all),
    pre: Object.freeze(all.slice(0, -1)),
    post: Object.freeze(all),
    expectedObjects: snapshotExpectedObjects(target),
    snapshot0106Sha256,
    snapshot0107Sha256,
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

export function loadAndValidateAuditSchemaMigrationBundle(
  migrationsDir: string,
): ValidatedAuditSchemaBundle {
  const journal = readJsonWithBytes(
    path.join(migrationsDir, "meta", "_journal.json"),
  ).value as { entries?: unknown };
  if (!Array.isArray(journal.entries))
    fail("JOURNAL_INVALID", "Migration journal entries must be an array.");
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
  const snapshot0106 = readJsonWithBytes(
    path.join(migrationsDir, "meta", "0106_snapshot.json"),
  );
  const snapshot0107 = readJsonWithBytes(
    path.join(migrationsDir, "meta", "0107_snapshot.json"),
  );
  return validateAuditSchemaMigrationBundle({
    journalEntries: journal.entries as MigrationJournalEntry[],
    sqlByTag,
    migrationSqlFileNames,
    snapshot0106Bytes: snapshot0106.bytes,
    snapshot0106: snapshot0106.value,
    snapshot0107Bytes: snapshot0107.bytes,
    snapshot0107: snapshot0107.value,
  });
}

function normalizeOpaqueRows(
  rows: readonly AuditSchemaOpaqueLegacyRow[],
): readonly AuditSchemaOpaqueLegacyRow[] {
  const normalized = rows.map((row) => ({
    createdAt: Number(row.createdAt),
    hash: String(row.hash).toLowerCase(),
  }));
  if (
    normalized.some(
      (row) =>
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 1 ||
        !/^[0-9a-f]{64}$/.test(row.hash),
    ) ||
    new Set(normalized.map((row) => row.createdAt)).size !==
      normalized.length ||
    new Set(normalized.map((row) => row.hash)).size !== normalized.length
  ) {
    fail(
      "OPAQUE_LEGACY_ROWS_INVALID",
      "Opaque legacy migration identities must be unique safe timestamps with lowercase SHA-256 hashes.",
    );
  }
  return Object.freeze(
    normalized
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.hash.localeCompare(right.hash),
      )
      .map((row): Readonly<AuditSchemaOpaqueLegacyRow> => Object.freeze(row)),
  );
}

function exactOpaqueRows(
  mode: AuditSchemaLineageMode,
  rows: readonly AuditSchemaOpaqueLegacyRow[],
): readonly AuditSchemaOpaqueLegacyRow[] {
  const normalized = normalizeOpaqueRows(rows);
  const expected = mode === "clean" ? [] : AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS;
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    fail(
      "OPAQUE_LEGACY_ROWS_MISMATCH",
      mode === "clean"
        ? "Clean lineage must not supply opaque legacy migration identities."
        : "Production-copy-restricted lineage must supply exactly the two pinned opaque identities without tags or inferred meaning.",
    );
  }
  return normalized;
}

function appliedMap(rows: readonly AppliedMigrationRow[]): Map<number, string> {
  const actual = new Map<number, string>();
  const hashes = new Set<string>();
  for (const row of rows) {
    const when = Number(row.created_at);
    const hash = typeof row.hash === "string" ? row.hash.toLowerCase() : "";
    if (!Number.isSafeInteger(when) || !/^[0-9a-f]{64}$/.test(hash)) {
      fail(
        "APPLIED_ROW_INVALID",
        "Applied rows must have safe timestamps and lowercase SHA-256 hashes.",
      );
    }
    if (actual.has(when) || hashes.has(hash)) {
      fail(
        "APPLIED_DUPLICATE",
        "Applied migration timestamps and hashes must be unique.",
      );
    }
    actual.set(when, hash);
    hashes.add(hash);
  }
  return actual;
}

function splitAppliedRows(
  rows: readonly AppliedMigrationRow[],
  mode: AuditSchemaLineageMode,
  opaqueRows: readonly AuditSchemaOpaqueLegacyRow[],
): readonly AppliedMigrationRow[] {
  const actual = appliedMap(rows);
  const expectedOpaque = exactOpaqueRows(mode, opaqueRows);
  for (const row of expectedOpaque) {
    if (actual.get(row.createdAt) !== row.hash) {
      fail(
        "OPAQUE_LEGACY_ROWS_NOT_APPLIED",
        "Database does not contain the exact supplied opaque legacy migration identities.",
      );
    }
    actual.delete(row.createdAt);
  }
  const known = rows.filter((row) => actual.has(Number(row.created_at)));
  if (known.length !== actual.size) {
    fail(
      "APPLIED_DUPLICATE",
      "Applied migration rows could not be classified uniquely.",
    );
  }
  return known;
}

function knownRowsSha256(rows: readonly AppliedMigrationRow[]): string {
  const canonical = rows
    .map((row) => ({
      createdAt: Number(row.created_at),
      hash: String(row.hash).toLowerCase(),
    }))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.hash.localeCompare(right.hash),
    );
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function validateKnownPrefix(
  rows: readonly AppliedMigrationRow[],
  expected: readonly ExpectedAppliedMigration[],
): void {
  const actual = appliedMap(rows);
  if (actual.size !== rows.length)
    fail("APPLIED_DUPLICATE", "Known migration rows must be unique.");
  for (const migration of expected) {
    if (actual.get(migration.when) !== migration.hash) {
      fail(
        "APPLIED_SET_MISMATCH",
        `Applied migration mismatch at ${migration.tag}.`,
      );
    }
  }
  if (actual.size !== expected.length) {
    fail(
      "APPLIED_UNKNOWN_ROW",
      "Database contains an unapproved migration identity.",
    );
  }
}

export function classifyAuditSchemaAppliedMigrations(
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedAuditSchemaBundle,
  lineageMode: AuditSchemaLineageMode,
  opaqueLegacyRows: readonly AuditSchemaOpaqueLegacyRow[],
): AuditSchemaInventoryClassification {
  const known = splitAppliedRows(rows, lineageMode, opaqueLegacyRows);
  const approved = new Map(
    bundle.post.map((migration) => [migration.when, migration.hash] as const),
  );
  if (
    known.some(
      (row) =>
        approved.get(Number(row.created_at)) !== String(row.hash).toLowerCase(),
    )
  ) {
    fail(
      "APPLIED_UNKNOWN_ROW",
      "Database contains an unapproved migration identity.",
    );
  }
  if (known.length > bundle.post.length) {
    fail(
      "APPLIED_COUNT_EXCEEDS_BUNDLE",
      "Database contains known rows beyond approved 0107.",
    );
  }
  validateKnownPrefix(known, bundle.post.slice(0, known.length));
  const knownAppliedMigrations = known.length;
  const latestKnownAppliedTag =
    bundle.post.slice(0, knownAppliedMigrations).at(-1)?.tag ?? null;
  const shared = {
    knownAppliedMigrations,
    latestKnownAppliedTag,
    knownAppliedRowsSha256: knownRowsSha256(known),
    opaqueLegacyRowCount: (lineageMode === "clean" ? 0 : 2) as 0 | 2,
    opaqueLegacyRowsSha256: canonicalRowsSha256(
      exactOpaqueRows(lineageMode, opaqueLegacyRows),
    ),
  };
  const pinnedKnownRowsSha256 =
    knownAppliedMigrations === bundle.pre.length
      ? AUDIT_SCHEMA_KNOWN_ROWS_SHA256.predecessor
      : knownAppliedMigrations === bundle.post.length
        ? AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target
        : null;
  if (
    pinnedKnownRowsSha256 !== null &&
    shared.knownAppliedRowsSha256 !== pinnedKnownRowsSha256
  ) {
    fail(
      "KNOWN_LINEAGE_DIGEST_MISMATCH",
      "The exact known migration lineage digest does not match the reviewed 0106/0107 bundle.",
    );
  }
  const pinnedOpaqueRowsSha256 =
    lineageMode === "clean"
      ? AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.clean
      : AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.productionCopyRestricted;
  if (shared.opaqueLegacyRowsSha256 !== pinnedOpaqueRowsSha256) {
    fail(
      "OPAQUE_LINEAGE_DIGEST_MISMATCH",
      "The opaque migration lineage digest does not match the reviewed mode.",
    );
  }
  if (knownAppliedMigrations === bundle.post.length) {
    return {
      ...shared,
      decision: "ALREADY_0107",
      missingKnownToPredecessor: 0,
    };
  }
  if (knownAppliedMigrations === bundle.pre.length) {
    return { ...shared, decision: "READY_0106", missingKnownToPredecessor: 0 };
  }
  return {
    ...shared,
    decision: "BASELINE_0106_REQUIRED",
    missingKnownToPredecessor: bundle.pre.length - knownAppliedMigrations,
  };
}

export function validateExactAuditAppliedMigrationSet(
  mode: AuditSchemaDatabaseMode,
  rows: readonly AppliedMigrationRow[],
  bundle: ValidatedAuditSchemaBundle,
  lineageMode: AuditSchemaLineageMode,
  opaqueLegacyRows: readonly AuditSchemaOpaqueLegacyRow[],
): AuditSchemaInventoryClassification {
  const classification = classifyAuditSchemaAppliedMigrations(
    rows,
    bundle,
    lineageMode,
    opaqueLegacyRows,
  );
  const expected = mode === "pre" ? "READY_0106" : "ALREADY_0107";
  if (classification.decision !== expected) {
    fail(
      "APPLIED_COUNT_MISMATCH",
      mode === "pre"
        ? "Database must contain exact known 0106 plus the approved opaque lineage rows."
        : "Database must contain exact known 0107 plus the approved opaque lineage rows.",
    );
  }
  return classification;
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

export function validateAuditSchemaDatabaseState(
  mode: AuditSchemaDatabaseMode,
  state: AuditSchemaDatabaseState,
  expectedIdentity: Pick<
    ExternalSchemaRuntimeEnvironment,
    "expectedDatabaseName" | "expectedDatabaseUser"
  >,
  expectedObjects: AuditSchemaExpectedObjects,
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
      state.rowCounts.size !== 0 ||
      state.headStreamId !== null ||
      state.headSequence !== null ||
      state.headLedgerSha256 !== null ||
      state.maximumEventSequence !== null ||
      state.maximumEventLedgerSha256 !== null
    ) {
      fail(
        "PRE_SCHEMA_DRIFT",
        "Canonical audit 0107 objects must be absent before migration.",
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
      "Canonical audit tables must be persistent regular non-RLS tables.",
    );
  }
  if ([...state.constraints.values()].some((valid) => !valid)) {
    fail(
      "POST_CONSTRAINT_INVALID",
      "All canonical audit constraints must be validated.",
    );
  }
  if ([...state.triggers.values()].some((enabled) => enabled !== "O")) {
    fail(
      "POST_TRIGGER_DISABLED",
      "All canonical audit triggers must be enabled in origin mode.",
    );
  }
  const events = state.rowCounts.get("audit_events");
  const outbox = state.rowCounts.get("audit_export_outbox");
  const heads = state.rowCounts.get("audit_chain_heads");
  if (
    !Number.isSafeInteger(events) ||
    !Number.isSafeInteger(outbox) ||
    !Number.isSafeInteger(heads) ||
    Number(events) < 0 ||
    Number(outbox) < 0 ||
    heads !== 1 ||
    state.headStreamId !== "site-logbook:audit:global:v1" ||
    !Number.isSafeInteger(state.headSequence) ||
    Number(state.headSequence) < 0 ||
    state.maximumEventSequence !== (events === 0 ? null : events) ||
    state.headSequence !== events ||
    outbox !== events ||
    (events === 0
      ? state.headLedgerSha256 !== null ||
        state.maximumEventLedgerSha256 !== null
      : !/^[0-9a-f]{64}$/.test(state.headLedgerSha256 ?? "") ||
        state.maximumEventLedgerSha256 !== state.headLedgerSha256)
  ) {
    fail(
      "AUDIT_CHAIN_STATE_INVALID",
      "Canonical audit head, events and outbox must form one exact contiguous stream.",
    );
  }
  if (
    mode === "post" &&
    (events !== 0 || outbox !== 0 || state.headSequence !== 0)
  ) {
    fail(
      "POST_AUDIT_STATE_NOT_GENESIS",
      "Fresh 0107 post-state must contain only the genesis chain head.",
    );
  }
}

function lineageSummary(
  classification: AuditSchemaInventoryClassification,
  mode: AuditSchemaLineageMode,
): AuditSchemaLineageSummary {
  return {
    ...classification,
    mode,
    knownExpectedMigrations: 107,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  };
}

function schemaSummary(
  state: AuditSchemaDatabaseState,
): AuditSchemaStateSummary {
  return {
    targetTag: "0107_canonical_audit_evidence",
    targetSqlSha256: `sha256:${AUDIT_SCHEMA_MIGRATIONS.target.hash}`,
    targetSnapshotSha256: `sha256:${AUDIT_SCHEMA_SNAPSHOTS.target.sha256}`,
    auditEventRows: state.rowCounts.get("audit_events") ?? 0,
    auditOutboxRows: state.rowCounts.get("audit_export_outbox") ?? 0,
    auditHeadRows: state.rowCounts.get("audit_chain_heads") ?? 0,
  };
}

function readLineageEnvironment(
  env: NodeJS.ProcessEnv,
): Pick<AuditSchemaEnvironment, "lineageMode" | "opaqueLegacyRows"> {
  const lineageMode = required(env, "AUDIT_SCHEMA_LINEAGE_MODE");
  if (lineageMode !== "clean" && lineageMode !== "production-copy-restricted") {
    fail(
      "LINEAGE_MODE_INVALID",
      "AUDIT_SCHEMA_LINEAGE_MODE must be clean or production-copy-restricted.",
    );
  }
  const raw = env.AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON ?? "";
  let parsed: unknown;
  try {
    parsed = raw === "" ? [] : JSON.parse(raw);
  } catch {
    fail(
      "OPAQUE_LEGACY_ROWS_JSON_INVALID",
      "AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON must be valid JSON.",
    );
  }
  if (!Array.isArray(parsed)) {
    fail(
      "OPAQUE_LEGACY_ROWS_JSON_INVALID",
      "AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON must be an array.",
    );
  }
  const rows = parsed.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail(
        "OPAQUE_LEGACY_ROWS_JSON_INVALID",
        "Each opaque row must be an object.",
      );
    }
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["createdAt", "hash"])) {
      fail(
        "OPAQUE_LEGACY_ROWS_JSON_INVALID",
        "Opaque rows may contain only createdAt and hash.",
      );
    }
    const value = row as Record<string, unknown>;
    return { createdAt: Number(value.createdAt), hash: String(value.hash) };
  });
  return { lineageMode, opaqueLegacyRows: exactOpaqueRows(lineageMode, rows) };
}

export function readAuditSchemaInventoryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AuditSchemaEnvironment {
  return {
    ...readExternalSchemaInventoryEnvironment(env),
    ...readLineageEnvironment(env),
  };
}

export function readAuditSchemaRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AuditSchemaRuntimeEnvironment {
  return {
    ...readExternalSchemaRuntimeEnvironment(env),
    ...readLineageEnvironment(env),
  };
}

export function readAuditSchemaPreflightEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AuditSchemaPreflightEnvironment {
  const mode = required(env, "AUDIT_SCHEMA_PREFLIGHT_MODE");
  if (mode !== "pre" && mode !== "post") {
    fail("MODE_INVALID", "AUDIT_SCHEMA_PREFLIGHT_MODE must be pre or post.");
  }
  if (
    required(env, "AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION") !==
    AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION
  ) {
    fail(
      "CONFIRMATION_INVALID",
      "The exact isolated 0107 confirmation phrase is required.",
    );
  }
  return { mode, ...readAuditSchemaInventoryEnvironment(env) };
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

async function readAuditDatabaseState(
  client: Queryable,
  mode: AuditSchemaDatabaseMode,
): Promise<AuditSchemaDatabaseState> {
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
  }>(`WITH audit_rels AS (
      SELECT c.oid, c.relname, c.relkind::text, c.relpersistence::text, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
    )
    SELECT 'table' AS object_kind, r.relname AS object_name,
           NULL::boolean AS object_valid, NULL::text AS object_enabled,
           r.relkind AS table_kind, r.relpersistence AS table_persistence,
           r.relrowsecurity AS row_security
      FROM audit_rels r WHERE r.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'function', p.proname, NULL::boolean, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'audit\\_%' ESCAPE '\\'
         OR p.proname LIKE 'guard_audit\\_%' ESCAPE '\\'
         OR p.proname LIKE 'deny_audit\\_%' ESCAPE '\\')
    UNION ALL
    SELECT 'index', i.indexname, NULL::boolean, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_indexes i
     WHERE i.schemaname = 'public'
       AND i.tablename = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
    UNION ALL
    SELECT 'constraint', con.conname, con.convalidated, NULL::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_constraint con JOIN audit_rels r ON r.oid = con.conrelid
     WHERE con.contype <> 't'
    UNION ALL
    SELECT 'trigger', t.tgname, NULL::boolean, t.tgenabled::text,
           NULL::text, NULL::text, NULL::boolean
      FROM pg_trigger t JOIN audit_rels r ON r.oid = t.tgrelid
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
    else if (row.object_kind === "constraint")
      constraints.set(row.object_name, row.object_valid === true);
    else if (row.object_kind === "trigger")
      triggers.set(row.object_name, row.object_enabled ?? "");
  }

  const rowCounts = new Map<string, number>();
  let headStreamId: string | null = null;
  let headSequence: number | null = null;
  let headLedgerSha256: string | null = null;
  let maximumEventSequence: number | null = null;
  let maximumEventLedgerSha256: string | null = null;
  if (mode !== "pre") {
    const result = await client.query<{
      audit_events: string | number;
      audit_export_outbox: string | number;
      audit_chain_heads: string | number;
      head_stream_id: string | null;
      head_sequence: string | number | null;
      head_ledger_sha256: string | null;
      maximum_event_sequence: string | number | null;
      maximum_event_ledger_sha256: string | null;
    }>(`SELECT
      (SELECT count(*)::bigint FROM audit_events) AS audit_events,
      (SELECT count(*)::bigint FROM audit_export_outbox) AS audit_export_outbox,
      (SELECT count(*)::bigint FROM audit_chain_heads) AS audit_chain_heads,
      (SELECT stream_id FROM audit_chain_heads ORDER BY stream_id LIMIT 1) AS head_stream_id,
      (SELECT sequence FROM audit_chain_heads ORDER BY stream_id LIMIT 1) AS head_sequence,
      (SELECT ledger_sha256 FROM audit_chain_heads ORDER BY stream_id LIMIT 1) AS head_ledger_sha256,
      (SELECT max(sequence) FROM audit_events) AS maximum_event_sequence,
      (SELECT ledger_sha256 FROM audit_events ORDER BY sequence DESC LIMIT 1) AS maximum_event_ledger_sha256`);
    const counts = result.rows[0];
    rowCounts.set("audit_events", Number(counts?.audit_events));
    rowCounts.set("audit_export_outbox", Number(counts?.audit_export_outbox));
    rowCounts.set("audit_chain_heads", Number(counts?.audit_chain_heads));
    headStreamId = counts?.head_stream_id ?? null;
    headSequence =
      counts?.head_sequence === null || counts?.head_sequence === undefined
        ? null
        : Number(counts.head_sequence);
    headLedgerSha256 = counts?.head_ledger_sha256 ?? null;
    maximumEventSequence =
      counts?.maximum_event_sequence === null ||
      counts?.maximum_event_sequence === undefined
        ? null
        : Number(counts.maximum_event_sequence);
    maximumEventLedgerSha256 = counts?.maximum_event_ledger_sha256 ?? null;
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
    headStreamId,
    headSequence,
    headLedgerSha256,
    maximumEventSequence,
    maximumEventLedgerSha256,
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

/**
 * Apply only the reviewed 0107 migration. This intentionally does not call the
 * generic Drizzle runner: committed migration blobs use CRLF while the rollout
 * contract and database identity pin canonical-LF SQL. The specialized gate
 * executes canonical-LF statements and records the reviewed 5523... identity.
 */
export async function applyAuditSchema0107(
  config: AuditSchemaPreflightEnvironment,
): Promise<AuditSchemaApplySummary> {
  if (config.mode !== "pre") {
    fail("MODE_INVALID", "The 0107 apply primitive requires pre mode.");
  }
  const bundle = loadAndValidateAuditSchemaMigrationBundle(
    config.migrationsDir,
  );
  const targetSql = canonicalLf(
    readFileSync(
      path.join(
        config.migrationsDir,
        `${AUDIT_SCHEMA_MIGRATIONS.target.tag}.sql`,
      ),
      "utf8",
    ),
  );
  if (sha256(targetSql) !== AUDIT_SCHEMA_MIGRATIONS.target.hash) {
    fail(
      "MIGRATION_HASH_MISMATCH",
      "The exact 0107 SQL changed after bundle validation.",
    );
  }

  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      EXTERNAL_SCHEMA_MIGRATION_LOCK_KEY,
    ]);
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      transactionOpen = true;
      const before = classifyAuditSchemaAppliedMigrations(
        await readAppliedMigrations(client),
        bundle,
        config.lineageMode,
        config.opaqueLegacyRows,
      );
      if (
        before.decision !== "READY_0106" &&
        before.decision !== "ALREADY_0107"
      ) {
        fail(
          "BASELINE_0106_REQUIRED",
          "The exact 0107 apply primitive accepts only reviewed 0106 or an exact 0107 race winner.",
        );
      }

      const beforeMode = before.decision === "READY_0106" ? "pre" : "post";
      const beforeState = await readAuditDatabaseState(client, beforeMode);
      validateAuditSchemaDatabaseState(
        beforeMode,
        beforeState,
        config,
        bundle.expectedObjects,
      );
      const beforeExternalState = await readExternalSchemaDatabaseState(
        client,
        "post",
      );
      validateExternalSchemaDatabaseState("post", beforeExternalState, config);
      if (externalRows(beforeExternalState) !== 0) {
        fail(
          "EXTERNAL_STATE_NOT_DARK",
          "External-account state must remain empty during the 0107 transaction.",
        );
      }

      if (before.decision === "ALREADY_0107") {
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          expectedCount: 107,
          latestExpectedTag: "0107_canonical_audit_evidence",
          newlyApplied: 0,
          knownAppliedBefore: 107,
          knownAppliedAfter: 107,
        };
      }

      for (const statement of targetSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [
          AUDIT_SCHEMA_MIGRATIONS.target.hash,
          AUDIT_SCHEMA_MIGRATIONS.target.when,
        ],
      );

      const after = validateExactAuditAppliedMigrationSet(
        "post",
        await readAppliedMigrations(client),
        bundle,
        config.lineageMode,
        config.opaqueLegacyRows,
      );
      const afterState = await readAuditDatabaseState(client, "post");
      validateAuditSchemaDatabaseState(
        "post",
        afterState,
        config,
        bundle.expectedObjects,
      );
      if (after.knownAppliedMigrations !== 107) {
        fail(
          "AUDIT_GATE_POSTCHECK_INVALID",
          "0107 transaction did not reach exact target lineage.",
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        expectedCount: 107,
        latestExpectedTag: "0107_canonical_audit_evidence",
        newlyApplied: 1,
        knownAppliedBefore: 106,
        knownAppliedAfter: 107,
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

export async function runAuditSchemaInventory(
  config: AuditSchemaEnvironment,
): Promise<AuditSchemaInventorySummary> {
  const bundle = loadAndValidateAuditSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const classification = classifyAuditSchemaAppliedMigrations(
      await readAppliedMigrations(client),
      bundle,
      config.lineageMode,
      config.opaqueLegacyRows,
    );
    const mode = classification.decision === "ALREADY_0107" ? "steady" : "pre";
    const state = await readAuditDatabaseState(client, mode);
    validateAuditSchemaDatabaseState(
      mode,
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    if (externalRows(externalState) !== 0) {
      fail(
        "EXTERNAL_STATE_NOT_DARK",
        "External-account state must remain empty during audit schema rollout.",
      );
    }
    const backup = validateStagingBackupEvidenceSnapshot(
      await readLatestBackupEvidence(client),
      config,
    );
    return {
      schemaVersion: "site-logbook.audit-schema-inventory/v1",
      kind: "audit-schema-inventory",
      decision: classification.decision,
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      lineage: lineageSummary(classification, config.lineageMode),
      schema: schemaSummary(state),
      backupEvidenceId: backup.id,
      backupRestoreAgeHours: backup.restoreAgeHours,
      authorizesApplicationStart: false,
    };
  });
}

export async function runAuditSchemaPreflight(
  config: AuditSchemaPreflightEnvironment,
): Promise<AuditSchemaPreflightSummary> {
  const bundle = loadAndValidateAuditSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const classification = validateExactAuditAppliedMigrationSet(
      config.mode,
      await readAppliedMigrations(client),
      bundle,
      config.lineageMode,
      config.opaqueLegacyRows,
    );
    const state = await readAuditDatabaseState(client, config.mode);
    validateAuditSchemaDatabaseState(
      config.mode,
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    if (externalRows(externalState) !== 0) {
      fail(
        "EXTERNAL_STATE_NOT_DARK",
        "External-account state must remain empty during audit schema rollout.",
      );
    }
    const backup = validateStagingBackupEvidenceSnapshot(
      await readLatestBackupEvidence(client),
      config,
    );
    return {
      schemaVersion: "site-logbook.audit-schema-preflight/v1",
      kind: "audit-schema-preflight",
      decision: config.mode === "pre" ? "READY_0106" : "ALREADY_0107",
      mode: config.mode,
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      lineage: lineageSummary(classification, config.lineageMode),
      schema: schemaSummary(state),
      backupEvidenceId: backup.id,
      backupRestoreAgeHours: backup.restoreAgeHours,
      backupEvidence: backup,
      authorizesApplicationStart: false,
    };
  });
}

export async function runAuditSchemaSteadyState(
  config: AuditSchemaRuntimeEnvironment,
): Promise<AuditSchemaSteadyStateSummary> {
  const bundle = loadAndValidateAuditSchemaMigrationBundle(
    config.migrationsDir,
  );
  return withLockedReadOnly(config.databaseUrl, async (client) => {
    const classification = validateExactAuditAppliedMigrationSet(
      "steady",
      await readAppliedMigrations(client),
      bundle,
      config.lineageMode,
      config.opaqueLegacyRows,
    );
    const state = await readAuditDatabaseState(client, "steady");
    validateAuditSchemaDatabaseState(
      "steady",
      state,
      config,
      bundle.expectedObjects,
    );
    const externalState = await readExternalSchemaDatabaseState(client, "post");
    validateExternalSchemaDatabaseState("post", externalState, config);
    if (externalRows(externalState) !== 0) {
      fail(
        "EXTERNAL_STATE_NOT_DARK",
        "External-account state must remain empty until separately activated.",
      );
    }
    return {
      schemaVersion: "site-logbook.audit-schema-steady-state/v1",
      kind: "audit-schema-steady-state",
      decision: "ALREADY_0107",
      environmentId: config.environmentId,
      databaseName: state.databaseName,
      databaseUser: state.databaseUser,
      buildSha: config.buildSha,
      lineage: lineageSummary(classification, config.lineageMode),
      schema: schemaSummary(state),
      authorizesApplicationStart: true,
    };
  });
}
