import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS,
  verifyProductionAuditSchemaReadinessWithKnownSuffix,
  type AuditSchemaCatalogQueryable,
  type ProductionAuditSchemaReadinessInput,
} from "./audit-schema-preflight.js";
import {
  ExternalSchemaPreflightError,
  type ExpectedAppliedMigration,
} from "./external-schema-preflight.js";

export const INVOICE_0108_MIGRATION = Object.freeze({
  idx: 108,
  when: 1786986729921,
  tag: "0108_invoice_source_allocations_and_advances",
  hash: "220a556f61fc9aed8c215965cd25e69b5e47d7fe171f57ecd6626fe2fd4f7814",
});
export const INVOICE_0108_SNAPSHOT = Object.freeze({
  id: "e9f2f052-b760-4025-aed2-4df306642b0f",
  prevId: "b20520fc-59f2-4d34-9e2f-9d7ed565288a",
  sha256: "77fc34f255f96c9af49e821e65af57c56f9b51baba85b4b10670276a9d070097",
});
export const INVOICE_0108_KNOWN_ROWS_SHA256 =
  "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281" as const;

const DELTA_COLUMNS = Object.freeze({
  billing_settings: Object.freeze([
    "advance_number_prefix",
    "advance_number_format",
    "advance_number_year",
    "advance_number_next_seq",
  ]),
  invoice_lines: Object.freeze(["row_type"]),
  invoices: Object.freeze([
    "document_type",
    "customer_delivery_address",
    "bank_account",
    "iban",
    "bic",
  ]),
});
const ALLOCATION_TABLE = "invoice_source_allocations";
const ALLOCATION_SEQUENCE = "invoice_source_allocations_id_seq";
const EXPECTED_RUNTIME_ROLE = "site_logbook_runtime";
const EXPECTED_MIGRATOR_ROLE = "site_logbook_migrator";

type SnapshotColumn = {
  name?: unknown;
  type?: unknown;
  primaryKey?: unknown;
  notNull?: unknown;
  default?: unknown;
};
type SnapshotTable = {
  name?: unknown;
  columns?: unknown;
  indexes?: unknown;
  foreignKeys?: unknown;
  checkConstraints?: unknown;
};
type Snapshot = { id?: unknown; prevId?: unknown; tables?: unknown };

export interface Invoice0108ColumnExpectation {
  table: string;
  column: string;
  dataType: string;
  notNull: boolean;
  defaultKind: string;
}

export interface Invoice0108SchemaProjection {
  schemaVersion: "site-logbook.invoice-0108-schema-projection/v1";
  columns: readonly Invoice0108ColumnExpectation[];
  constraintNames: readonly string[];
  indexNames: readonly string[];
  sequenceNames: readonly string[];
}

export interface ValidatedInvoice0108Bundle {
  migration: ExpectedAppliedMigration;
  snapshotSha256: string;
  projection: Invoice0108SchemaProjection;
  projectionSha256: string;
}

export interface Invoice0108SchemaObservation {
  columns: readonly Invoice0108ColumnExpectation[];
  constraintNames: readonly string[];
  indexNames: readonly string[];
  sequenceNames: readonly string[];
  allocationTableOwner: string;
  allocationSequenceOwner: string;
  runtimeRole: string;
  runtimeTableSelect: boolean;
  runtimeTableInsert: boolean;
  runtimeTableUpdate: boolean;
  runtimeTableDelete: boolean;
  runtimeSequenceUsage: boolean;
  publicTablePrivileges: boolean;
  publicSequencePrivileges: boolean;
}

export interface ProductionInvoice0108Readiness {
  schemaVersion: "site-logbook.production-invoice-0108-readiness/v1";
  kind: "production-invoice-0108-readiness";
  decision: "ALREADY_0108";
  environmentId: "site-logbook-production";
  databaseName: string;
  databaseUser: string;
  buildSha: string;
  schemaFingerprintSha256: string;
  invoiceSchemaProjectionSha256: string;
  latestKnownAppliedTag: typeof INVOICE_0108_MIGRATION.tag;
  knownExpectedMigrations: 108;
  knownAppliedMigrations: 108;
  knownAppliedRowsSha256: typeof INVOICE_0108_KNOWN_ROWS_SHA256;
  opaqueLegacyRowCount: 2;
  opaqueLegacyRowsSha256: string;
  excludedMigration0100Present: false;
  roleDeltaReady: true;
  auditSchemaReady: true;
  integrityValid: true;
  postMigrationIntegrityValid: true;
  trustedAuditGenesis: true;
  externalAuditRowCount: 0;
  authorizesApplicationStart: true;
}

function fail(code: string, message: string): never {
  throw new ExternalSchemaPreflightError(`INVOICE_0108_${code}`, message);
}

function canonicalLf(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.includes("\0")) fail("SOURCE_INVALID", "Source contains NUL bytes.");
  return normalized;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SOURCE_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function snapshotDefaultKind(column: SnapshotColumn): string {
  if (column.type === "serial") return "sequence";
  if (!("default" in column)) return "none";
  if (column.default === false) return "false";
  if (
    typeof column.default === "number" &&
    Number.isFinite(column.default)
  ) {
    return `literal:${column.default}`;
  }
  if (column.default === "now()") return "now";
  if (
    typeof column.default === "string" &&
    column.default.startsWith("'") &&
    column.default.endsWith("'")
  ) {
    return `literal:${column.default.slice(1, -1)}`;
  }
  fail("SOURCE_INVALID", `Unsupported snapshot default for ${String(column.name)}.`);
}

function snapshotDataType(value: unknown): string {
  if (value === "serial") return "integer";
  if (value === "timestamp") return "timestamp without time zone";
  if (typeof value !== "string" || !value) {
    fail("SOURCE_INVALID", "Snapshot column type is invalid.");
  }
  return value.replace(/,\s+/g, ",");
}

function expectedColumn(
  table: string,
  raw: unknown,
): Invoice0108ColumnExpectation {
  const column = object(raw, `${table}.column`) as SnapshotColumn;
  if (
    typeof column.name !== "string" ||
    typeof column.notNull !== "boolean"
  ) {
    fail("SOURCE_INVALID", `${table} snapshot column is invalid.`);
  }
  return Object.freeze({
    table,
    column: column.name,
    dataType: snapshotDataType(column.type),
    notNull: column.notNull,
    defaultKind: snapshotDefaultKind(column),
  });
}

function sortedUnique(values: readonly string[], field: string): string[] {
  const sorted = [...values].sort();
  if (
    sorted.length === 0 ||
    new Set(sorted).size !== sorted.length ||
    sorted.some((value) => !/^[a-z_][a-z0-9_]*$/.test(value))
  ) {
    fail("SOURCE_INVALID", `${field} is invalid.`);
  }
  return sorted;
}

function projectionFromSnapshot(snapshot: Snapshot): Invoice0108SchemaProjection {
  const tables = object(snapshot.tables, "snapshot.tables");
  const allocations = object(
    tables[`public.${ALLOCATION_TABLE}`],
    `snapshot.tables.public.${ALLOCATION_TABLE}`,
  ) as SnapshotTable;
  const allocationColumns = object(
    allocations.columns,
    `${ALLOCATION_TABLE}.columns`,
  );
  const columns = Object.values(allocationColumns).map((column) =>
    expectedColumn(ALLOCATION_TABLE, column),
  );
  for (const [tableName, names] of Object.entries(DELTA_COLUMNS)) {
    const table = object(
      tables[`public.${tableName}`],
      `snapshot.tables.public.${tableName}`,
    ) as SnapshotTable;
    const tableColumns = object(table.columns, `${tableName}.columns`);
    for (const name of names) {
      const column = tableColumns[name];
      if (!column) fail("SOURCE_INVALID", `Snapshot is missing ${tableName}.${name}.`);
      columns.push(expectedColumn(tableName, column));
    }
  }
  columns.sort((left, right) =>
    `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`, "en"),
  );
  if (Object.keys(allocationColumns).length !== 23 || columns.length !== 33) {
    fail("SOURCE_INVALID", "0108 snapshot must contain exactly 23 allocation and 10 altered columns.");
  }

  const allocationIndexes = object(allocations.indexes, `${ALLOCATION_TABLE}.indexes`);
  const allocationForeignKeys = object(
    allocations.foreignKeys,
    `${ALLOCATION_TABLE}.foreignKeys`,
  );
  const allocationChecks = object(
    allocations.checkConstraints,
    `${ALLOCATION_TABLE}.checkConstraints`,
  );
  const invoiceLineChecks = object(
    (object(tables["public.invoice_lines"], "invoice_lines") as SnapshotTable)
      .checkConstraints,
    "invoice_lines.checkConstraints",
  );
  const invoiceChecks = object(
    (object(tables["public.invoices"], "invoices") as SnapshotTable)
      .checkConstraints,
    "invoices.checkConstraints",
  );
  const constraintNames = sortedUnique(
    [
      `${ALLOCATION_TABLE}_pkey`,
      ...Object.keys(allocationForeignKeys),
      ...Object.keys(allocationChecks),
      "invoice_lines_row_type_check",
      "invoices_document_type_check",
    ],
    "constraintNames",
  );
  if (
    Object.keys(allocationForeignKeys).length !== 6 ||
    Object.keys(allocationChecks).length !== 3 ||
    !("invoice_lines_row_type_check" in invoiceLineChecks) ||
    !("invoices_document_type_check" in invoiceChecks) ||
    constraintNames.length !== 12
  ) {
    fail("SOURCE_INVALID", "0108 snapshot constraint set is incomplete.");
  }
  const indexNames = sortedUnique(
    [`${ALLOCATION_TABLE}_pkey`, ...Object.keys(allocationIndexes)],
    "indexNames",
  );
  if (Object.keys(allocationIndexes).length !== 6 || indexNames.length !== 7) {
    fail("SOURCE_INVALID", "0108 snapshot index set is incomplete.");
  }
  return Object.freeze({
    schemaVersion: "site-logbook.invoice-0108-schema-projection/v1" as const,
    columns: Object.freeze(columns),
    constraintNames: Object.freeze(constraintNames),
    indexNames: Object.freeze(indexNames),
    sequenceNames: Object.freeze([ALLOCATION_SEQUENCE]),
  });
}

export function loadAndValidateInvoice0108MigrationBundle(
  migrationsDir: string,
): ValidatedInvoice0108Bundle {
  let journal: { entries?: unknown };
  let sql: string;
  let snapshotBytes: string;
  let snapshot: Snapshot;
  try {
    journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries?: unknown };
    sql = readFileSync(
      path.join(migrationsDir, `${INVOICE_0108_MIGRATION.tag}.sql`),
      "utf8",
    );
    snapshotBytes = readFileSync(
      path.join(migrationsDir, "meta", "0108_snapshot.json"),
      "utf8",
    );
    snapshot = JSON.parse(snapshotBytes) as Snapshot;
  } catch {
    fail("SOURCE_INVALID", "Cannot read the exact 0108 source bundle.");
  }
  if (!Array.isArray(journal.entries) || journal.entries.length !== 108) {
    fail("JOURNAL_INVALID", "Invoice 0108 runtime image requires exactly 108 journal entries.");
  }
  const last = object(journal.entries.at(-1), "journal.entries[107]");
  if (
    last.idx !== INVOICE_0108_MIGRATION.idx ||
    last.when !== INVOICE_0108_MIGRATION.when ||
    last.tag !== INVOICE_0108_MIGRATION.tag ||
    journal.entries.some((entry) => {
      const value = object(entry, "journal.entry");
      return value.idx === 100 || /^0100(?:_|$)/i.test(String(value.tag));
    })
  ) {
    fail("JOURNAL_INVALID", "0108 journal identity or excluded-0100 invariant is invalid.");
  }
  const sqlHash = sha256(canonicalLf(sql)).slice(7);
  const snapshotHash = sha256(canonicalLf(snapshotBytes)).slice(7);
  if (
    sqlHash !== INVOICE_0108_MIGRATION.hash ||
    snapshotHash !== INVOICE_0108_SNAPSHOT.sha256 ||
    snapshot.id !== INVOICE_0108_SNAPSHOT.id ||
    snapshot.prevId !== INVOICE_0108_SNAPSHOT.prevId
  ) {
    fail("SOURCE_DRIFT", "0108 SQL, snapshot digest or snapshot chain changed.");
  }
  const projection = projectionFromSnapshot(snapshot);
  return Object.freeze({
    migration: INVOICE_0108_MIGRATION,
    snapshotSha256: `sha256:${snapshotHash}`,
    projection,
    projectionSha256: sha256(canonicalJson(projection)),
  });
}

export function classifyObservedInvoice0108DefaultKind(
  table: string,
  column: string,
  expression: unknown,
): string {
  if (expression === null || expression === undefined) return "none";
  const value = String(expression);
  if (
    table === ALLOCATION_TABLE &&
    column === "id" &&
    /^nextval\('invoice_source_allocations_id_seq'::regclass\)$/.test(value)
  ) {
    return "sequence";
  }
  if (value === "false") return "false";
  if (value === "now()") return "now";
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return `literal:${value}`;
  }
  const literal = /^'([^']*)'(?:::[a-z ]+)?$/.exec(value)?.[1];
  return literal === undefined ? `unsupported:${value}` : `literal:${literal}`;
}

async function readInvoice0108SchemaObservation(
  client: AuditSchemaCatalogQueryable,
  bundle: ValidatedInvoice0108Bundle,
): Promise<Invoice0108SchemaObservation> {
  const tableNames = [ALLOCATION_TABLE, ...Object.keys(DELTA_COLUMNS)];
  const columnRows = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
  }>(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid, true) AS default_expression
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [tableNames],
  );
  const expectedKeys = new Set(
    bundle.projection.columns.map((column) => `${column.table}.${column.column}`),
  );
  const columns = columnRows.rows
    .filter((row) => expectedKeys.has(`${row.table_name}.${row.column_name}`))
    .map((row) => ({
      table: row.table_name,
      column: row.column_name,
      dataType: row.data_type.replace(/,\s+/g, ","),
      notNull: row.not_null,
      defaultKind: classifyObservedInvoice0108DefaultKind(
        row.table_name,
        row.column_name,
        row.default_expression,
      ),
    }))
    .sort((left, right) =>
      `${left.table}.${left.column}`.localeCompare(`${right.table}.${right.column}`, "en"),
    );
  const allocationObservedCount = columnRows.rows.filter(
    (row) => row.table_name === ALLOCATION_TABLE,
  ).length;
  if (allocationObservedCount !== 23) {
    fail("SCHEMA_DRIFT", "invoice_source_allocations contains an unexpected column set.");
  }

  const constraints = await client.query<{ constraint_name: string; validated: boolean }>(
    `SELECT con.conname AS constraint_name, con.convalidated AS validated
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND (c.relname = $1 OR con.conname = ANY($2::text[]))
      ORDER BY con.conname`,
    [ALLOCATION_TABLE, bundle.projection.constraintNames],
  );
  if (constraints.rows.some((row) => row.validated !== true)) {
    fail("SCHEMA_DRIFT", "0108 constraints must all be validated.");
  }
  const indexes = await client.query<{
    index_name: string;
    valid: boolean;
    ready: boolean;
  }>(
    `SELECT i.relname AS index_name, x.indisvalid AS valid, x.indisready AS ready
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
      ORDER BY i.relname`,
    [ALLOCATION_TABLE],
  );
  if (indexes.rows.some((row) => !row.valid || !row.ready)) {
    fail("SCHEMA_DRIFT", "0108 indexes must be valid and ready.");
  }
  const role = await client.query<{
    runtime_role: string;
    table_owner: string;
    sequence_owner: string;
    table_select: boolean;
    table_insert: boolean;
    table_update: boolean;
    table_delete: boolean;
    sequence_usage: boolean;
    public_table: boolean;
    public_sequence: boolean;
  }>(
    `SELECT current_user AS runtime_role,
            pg_get_userbyid(t.relowner) AS table_owner,
            pg_get_userbyid(s.relowner) AS sequence_owner,
            has_table_privilege(current_user, 'public.invoice_source_allocations', 'SELECT') AS table_select,
            has_table_privilege(current_user, 'public.invoice_source_allocations', 'INSERT') AS table_insert,
            has_table_privilege(current_user, 'public.invoice_source_allocations', 'UPDATE') AS table_update,
            has_table_privilege(current_user, 'public.invoice_source_allocations', 'DELETE') AS table_delete,
            has_sequence_privilege(current_user, 'public.invoice_source_allocations_id_seq', 'USAGE') AS sequence_usage,
            COALESCE((SELECT bool_or(grantee = 0) FROM aclexplode(t.relacl)), false) AS public_table,
            COALESCE((SELECT bool_or(grantee = 0) FROM aclexplode(s.relacl)), false) AS public_sequence
       FROM pg_class t
       JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = 'public'
       JOIN pg_class s ON s.relname = $2
       JOIN pg_namespace sn ON sn.oid = s.relnamespace AND sn.nspname = 'public'
      WHERE t.relname = $1 AND t.relkind = 'r' AND s.relkind = 'S'`,
    [ALLOCATION_TABLE, ALLOCATION_SEQUENCE],
  );
  if (role.rows.length !== 1) fail("SCHEMA_DRIFT", "0108 table or sequence is absent.");
  const grant = role.rows[0];
  return Object.freeze({
    columns: Object.freeze(columns),
    constraintNames: Object.freeze(constraints.rows.map((row) => row.constraint_name).sort()),
    indexNames: Object.freeze(indexes.rows.map((row) => row.index_name).sort()),
    sequenceNames: Object.freeze([ALLOCATION_SEQUENCE]),
    allocationTableOwner: grant.table_owner,
    allocationSequenceOwner: grant.sequence_owner,
    runtimeRole: grant.runtime_role,
    runtimeTableSelect: grant.table_select,
    runtimeTableInsert: grant.table_insert,
    runtimeTableUpdate: grant.table_update,
    runtimeTableDelete: grant.table_delete,
    runtimeSequenceUsage: grant.sequence_usage,
    publicTablePrivileges: grant.public_table,
    publicSequencePrivileges: grant.public_sequence,
  });
}

export function validateInvoice0108SchemaObservation(
  observation: Invoice0108SchemaObservation,
  bundle: ValidatedInvoice0108Bundle,
): Readonly<{ projectionSha256: string; roleDeltaReady: true }> {
  const structural: Invoice0108SchemaProjection = {
    schemaVersion: "site-logbook.invoice-0108-schema-projection/v1",
    columns: observation.columns,
    constraintNames: observation.constraintNames,
    indexNames: observation.indexNames,
    sequenceNames: observation.sequenceNames,
  };
  if (canonicalJson(structural) !== canonicalJson(bundle.projection)) {
    fail("SCHEMA_DRIFT", "Live 0108 schema projection differs from the pinned snapshot.");
  }
  if (
    observation.allocationTableOwner !== EXPECTED_MIGRATOR_ROLE ||
    observation.allocationSequenceOwner !== EXPECTED_MIGRATOR_ROLE ||
    observation.runtimeRole !== EXPECTED_RUNTIME_ROLE ||
    !observation.runtimeTableSelect ||
    !observation.runtimeTableInsert ||
    !observation.runtimeTableUpdate ||
    observation.runtimeTableDelete ||
    !observation.runtimeSequenceUsage ||
    observation.publicTablePrivileges ||
    observation.publicSequencePrivileges
  ) {
    fail("ROLE_DRIFT", "Live 0108 objects do not have the exact least-privilege role delta.");
  }
  return Object.freeze({
    projectionSha256: bundle.projectionSha256,
    roleDeltaReady: true as const,
  });
}

export async function verifyProductionInvoice0108SchemaReadiness(
  input: ProductionAuditSchemaReadinessInput,
): Promise<ProductionInvoice0108Readiness> {
  const bundle = loadAndValidateInvoice0108MigrationBundle(input.migrationsDir);
  const extended = await verifyProductionAuditSchemaReadinessWithKnownSuffix(
    input,
    {
      knownSuffix: [bundle.migration],
      verifyAdditionalState: async (client) =>
        validateInvoice0108SchemaObservation(
          await readInvoice0108SchemaObservation(client, bundle),
          bundle,
        ),
    },
  );
  return Object.freeze({
    schemaVersion: "site-logbook.production-invoice-0108-readiness/v1" as const,
    kind: "production-invoice-0108-readiness" as const,
    decision: "ALREADY_0108" as const,
    environmentId: "site-logbook-production" as const,
    databaseName: extended.databaseName,
    databaseUser: extended.databaseUser,
    buildSha: extended.buildSha,
    schemaFingerprintSha256: extended.schema.schemaFingerprintSha256,
    invoiceSchemaProjectionSha256: extended.additionalState.projectionSha256,
    latestKnownAppliedTag: INVOICE_0108_MIGRATION.tag,
    knownExpectedMigrations: 108 as const,
    knownAppliedMigrations: 108 as const,
    knownAppliedRowsSha256: INVOICE_0108_KNOWN_ROWS_SHA256,
    opaqueLegacyRowCount: 2 as const,
    opaqueLegacyRowsSha256: extended.lineage.opaqueLegacyRowsSha256,
    excludedMigration0100Present: false as const,
    roleDeltaReady: true as const,
    auditSchemaReady: true as const,
    integrityValid: true as const,
    postMigrationIntegrityValid: true as const,
    trustedAuditGenesis: true as const,
    externalAuditRowCount: 0 as const,
    authorizesApplicationStart: true as const,
  });
}

export function productionInvoice0108OpaqueLegacyRows(): typeof AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS {
  return AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS;
}
