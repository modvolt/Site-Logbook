import { createHash } from "node:crypto";

import {
  PRODUCTION_ROLE_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_PROJECTION_SQL,
  REQUIRED_FUNCTION_GRANTS,
  REQUIRED_SEQUENCE_GRANTS,
  REQUIRED_TABLE_GRANTS,
  ROLE_CONTRACT_MIGRATION,
  ROLE_CONTRACT_MIGRATION_SHA256,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  validateProductionRoleProjection,
  type ProductionRolePlan,
  type ProductionRoleProjection,
} from "../../lib/db/src/production-role-separation-contract.js";
import { parseProductionMigrationRolePrecondition } from "../../lib/db/src/production-migration-role-authority.js";

export const PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION =
  "BOOTSTRAP_EXACT_0096_PRODUCTION_DB_ROLES_BEFORE_MIGRATION";
export const PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_RECEIPT_SCHEMA =
  "site-logbook.production-migration-role-bootstrap-receipt/v1";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const APPROVAL_ID = /^[a-z0-9][a-z0-9._:-]{7,127}$/;
const ALLOWED_PRE_0107_PROJECTION_ERRORS = new Set([
  "OBJECT_CARDINALITY_MISMATCH",
  "REQUIRED_OBJECT_PROJECTION_MISSING",
]);

type QueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
  rowCount?: number | null;
}>;

type BootstrapClient = Readonly<{
  query(statement: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}>;

export type ProductionMigrationRoleBootstrapInput = Readonly<{
  sourceSha: string;
  databaseName: string;
  sessionUser: string;
  migrationRole: string;
  runtimeRole: string;
  approvalId: string;
  confirmation: typeof PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION;
  advisoryLockKey: number;
  connect: () => Promise<BootstrapClient>;
  signal: AbortSignal;
  now?: () => Date;
}>;

export class ProductionMigrationRoleBootstrapError extends Error {
  readonly code: string;
  readonly restoreRequired: boolean;
  readonly manualReviewRequired: boolean;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & {
      restoreRequired?: boolean;
      manualReviewRequired?: boolean;
    },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationRoleBootstrapError";
    this.code = code;
    this.restoreRequired = options?.restoreRequired === true;
    this.manualReviewRequired = options?.manualReviewRequired === true;
  }
}

function fail(
  code: string,
  message: string,
  options?: ErrorOptions & {
    restoreRequired?: boolean;
    manualReviewRequired?: boolean;
  },
): never {
  throw new ProductionMigrationRoleBootstrapError(code, message, options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_ABORTED",
      "Role bootstrap was aborted and failed closed.",
      { cause: signal.reason },
    );
  }
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_INPUT_INVALID",
      `${field} is not one canonical PostgreSQL identifier.`,
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  if (value.includes("\0")) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CATALOG_INVALID",
      "PostgreSQL returned an invalid identifier.",
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function sha256Canonical(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function exactTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CLOCK_INVALID",
      "Role bootstrap clock is invalid.",
    );
  }
  return value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactRecordArray(
  value: unknown,
  field: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      `${field} is not an exact object array.`,
    );
  }
  return value.map((entry) => ({ ...entry }));
}

function exactStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      `${field} is not an exact string array.`,
    );
  }
  return [...value];
}

function roleByName(
  raw: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const matches = exactRecordArray(raw.roles, "projection.roles").filter(
    (role) => role.name === name,
  );
  if (matches.length !== 1) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      "Projection must contain each reviewed role exactly once.",
    );
  }
  return matches[0];
}

export function normalizeProductionMigrationRoleBootstrapProjection(
  raw: unknown,
  plan: ProductionRolePlan,
): ProductionRoleProjection {
  if (!isRecord(raw) || !isRecord(raw.database)) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      "Projection query did not return its exact object boundary.",
    );
  }
  const database = raw.database;
  const relations = exactRecordArray(raw.relations, "projection.relations");
  const functions =
    raw.functions === null
      ? []
      : exactRecordArray(raw.functions, "projection.functions");
  const objects = [...relations, ...functions].sort((left, right) => {
    const a = `${left.kind}:${left.schema}:${left.name}:${left.identityArguments}`;
    const b = `${right.kind}:${right.schema}:${right.name}:${right.identityArguments}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze({
    schemaVersion: PRODUCTION_ROLE_CONTRACT_SCHEMA,
    migration: ROLE_CONTRACT_MIGRATION,
    migrationSha256: ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: database.name,
    databaseOwner: database.owner,
    databasePublicPrivileges: exactStringArray(
      database.publicPrivileges,
      "projection.database.publicPrivileges",
    ),
    databaseRuntimePrivileges: exactStringArray(
      database.runtimePrivileges,
      "projection.database.runtimePrivileges",
    ),
    databaseOtherGrants: exactRecordArray(
      database.otherGrants,
      "projection.database.otherGrants",
    ),
    runtimeRole: roleByName(raw, plan.runtimeRole),
    migratorRole: roleByName(raw, plan.migratorRole),
    runtimeMemberOf: exactStringArray(
      raw.runtimeMemberOf,
      "projection.runtimeMemberOf",
    ),
    migratorMemberOf: exactStringArray(
      raw.migratorMemberOf,
      "projection.migratorMemberOf",
    ),
    runtimeRoleMembers: exactStringArray(
      raw.runtimeRoleMembers,
      "projection.runtimeRoleMembers",
    ),
    migratorRoleMembers: exactStringArray(
      raw.migratorRoleMembers,
      "projection.migratorRoleMembers",
    ),
    runtimeGlobalSettings: exactStringArray(
      raw.runtimeGlobalSettings,
      "projection.runtimeGlobalSettings",
    ),
    runtimeDatabaseSettings: exactStringArray(
      raw.runtimeDatabaseSettings,
      "projection.runtimeDatabaseSettings",
    ),
    schemas: exactRecordArray(raw.schemas, "projection.schemas"),
    defaultPrivileges: exactRecordArray(
      raw.defaultPrivileges,
      "projection.defaultPrivileges",
    ),
    objects,
  } as unknown as ProductionRoleProjection);
}

function assertPre0107Projection(projection: ProductionRoleProjection): void {
  const validation = validateProductionRoleProjection(projection);
  const blockers = validation.errors.filter(
    (error) => !ALLOWED_PRE_0107_PROJECTION_ERRORS.has(error.code),
  );
  if (blockers.length > 0) {
    const context = blockers[0].path.startsWith("defaultPrivileges.")
      ? projection.defaultPrivileges.find(
          (entry) =>
            `defaultPrivileges.${entry.schema}:${entry.kind}` ===
            blockers[0].path,
        )
      : undefined;
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      `Role projection has a blocking error: ${blockers[0].code} at ${blockers[0].path} (${blockers[0].detail})${context ? ` ${JSON.stringify(context)}` : ""}.`,
    );
  }
}

function objectKey(object: Record<string, unknown>): string {
  return `${object.kind}:${object.schema}.${object.name}(${object.identityArguments})`;
}

function expectedObjectPrivileges(): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const entry of REQUIRED_TABLE_GRANTS) {
    map.set(`table:${entry.schema}.${entry.name}()`, entry.privileges);
  }
  for (const entry of REQUIRED_SEQUENCE_GRANTS) {
    map.set(`sequence:${entry.schema}.${entry.name}()`, entry.privileges);
  }
  for (const entry of REQUIRED_FUNCTION_GRANTS) {
    map.set(
      `function:${entry.schema}.${entry.name}(${entry.identityArguments})`,
      entry.privileges,
    );
  }
  return map;
}

async function readRawProjection(
  client: BootstrapClient,
  plan: ProductionRolePlan,
): Promise<Record<string, unknown>> {
  const result = await client.query(PRODUCTION_ROLE_PROJECTION_SQL, [
    plan.databaseName,
    plan.runtimeRole,
    plan.migratorRole,
  ]);
  if (result.rows.length !== 1 || !isRecord(result.rows[0].projection)) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_PROJECTION_INVALID",
      "Projection query must return exactly one object.",
    );
  }
  return result.rows[0].projection;
}

async function assertExactBaselineCatalog(
  client: BootstrapClient,
): Promise<readonly Record<string, unknown>[]> {
  const schemaResult = await client.query(String.raw`
    SELECT nspname AS name
    FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    ORDER BY nspname COLLATE "C"`);
  const schemaNames = schemaResult.rows.map((row) => row.name);
  if (
    schemaNames.length !== 2 ||
    schemaNames[0] !== "drizzle" ||
    schemaNames[1] !== "public"
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CATALOG_INVALID",
      "Only the exact public and drizzle schemas may exist.",
    );
  }
  const catalog = await client.query(String.raw`
    SELECT * FROM (
      SELECT CASE relation.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
        namespace.nspname AS schema, relation.relname AS name, ''::text AS "identityArguments"
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'drizzle')
        AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      UNION ALL
      SELECT 'function', namespace.nspname, procedure.proname,
        pg_catalog.oidvectortypes(procedure.proargtypes)
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
    ) catalog
    ORDER BY kind COLLATE "C", schema COLLATE "C", name COLLATE "C",
      "identityArguments" COLLATE "C"`);
  const expected = expectedObjectPrivileges();
  const seen = new Set<string>();
  for (const object of catalog.rows) {
    const key = objectKey(object);
    if (!expected.has(key) || seen.has(key)) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CATALOG_INVALID",
        "Live catalog contains an unknown or duplicate public/drizzle object.",
      );
    }
    seen.add(key);
  }
  return catalog.rows;
}

async function applyBaseRoleBoundary(
  client: BootstrapClient,
  input: ProductionMigrationRoleBootstrapInput,
  objects: readonly Record<string, unknown>[],
): Promise<number> {
  const database = quoteIdentifier(input.databaseName);
  const session = quoteIdentifier(input.sessionUser);
  const migrator = quoteIdentifier(input.migrationRole);
  const runtime = quoteIdentifier(input.runtimeRole);
  const statements: string[] = [
    `CREATE ROLE ${migrator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `CREATE ROLE ${runtime} LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `ALTER ROLE ${runtime} RESET ALL`,
    `ALTER ROLE ${runtime} IN DATABASE ${database} RESET ALL`,
    `ALTER ROLE ${runtime} IN DATABASE ${database} SET search_path TO pg_catalog, public, pg_temp`,
    `ALTER DATABASE ${database} OWNER TO ${migrator}`,
    `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM PUBLIC, ${runtime}, ${session}`,
    `GRANT CONNECT ON DATABASE ${database} TO PUBLIC, ${runtime}`,
    `ALTER SCHEMA "public" OWNER TO ${migrator}`,
    `ALTER SCHEMA "drizzle" OWNER TO ${migrator}`,
    `REVOKE ALL PRIVILEGES ON SCHEMA "public", "drizzle" FROM PUBLIC, ${runtime}, ${session}`,
    `GRANT USAGE ON SCHEMA "public" TO PUBLIC`,
    `GRANT USAGE ON SCHEMA "public", "drizzle" TO ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${runtime}, ${session}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${runtime}, ${session}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, ${runtime}, ${session}`,
  ];
  for (const schema of ["public", "drizzle"]) {
    for (const [singular, plural] of [
      ["TABLE", "TABLES"],
      ["SEQUENCE", "SEQUENCES"],
      ["FUNCTION", "FUNCTIONS"],
    ] as const) {
      void singular;
      statements.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${quoteIdentifier(schema)} REVOKE ALL PRIVILEGES ON ${plural} FROM PUBLIC, ${runtime}, ${session}`,
      );
    }
  }
  const expected = expectedObjectPrivileges();
  const orderedObjects = [...objects].sort((left, right) => {
    const ranks: Record<string, number> = {
      table: 0,
      sequence: 1,
      function: 2,
    };
    const rank = (value: Record<string, unknown>) =>
      ranks[String(value.kind)] ?? 99;
    return rank(left) - rank(right);
  });
  for (const object of orderedObjects) {
    const kind = String(object.kind);
    const schema = String(object.schema);
    const name = String(object.name);
    const args = String(object.identityArguments);
    const target =
      kind === "function"
        ? `${qualified(schema, name)}(${args})`
        : qualified(schema, name);
    const keyword = kind === "function" ? "FUNCTION" : kind.toUpperCase();
    if (kind === "sequence" && name !== "job_number_seq") {
      const tableName = name.replace(/_id_seq$/, "");
      const tableTarget = qualified(schema, tableName);
      statements.push(`ALTER SEQUENCE ${target} OWNED BY NONE`);
      statements.push(`ALTER SEQUENCE ${target} OWNER TO ${migrator}`);
      statements.push(`ALTER SEQUENCE ${target} OWNED BY ${tableTarget}."id"`);
    } else {
      statements.push(`ALTER ${keyword} ${target} OWNER TO ${migrator}`);
    }
    statements.push(
      `REVOKE ALL PRIVILEGES ON ${keyword} ${target} FROM PUBLIC, ${runtime}, ${session}`,
    );
    if (kind === "function") {
      statements.push(`ALTER FUNCTION ${target} RESET ALL`);
      statements.push(
        `ALTER FUNCTION ${target} SET search_path TO pg_catalog, public, pg_temp`,
      );
    }
    const privileges = expected.get(objectKey(object));
    if (privileges && privileges.length > 0) {
      statements.push(
        `GRANT ${privileges.join(", ")} ON ${keyword} ${target} TO ${runtime}`,
      );
    }
  }
  for (const statement of statements) {
    throwIfAborted(input.signal);
    await client.query(statement);
  }
  return statements.length;
}

async function removeProjectedThirdPartyAcls(
  client: BootstrapClient,
  raw: Record<string, unknown>,
  plan: ProductionRolePlan,
): Promise<number> {
  const database = quoteIdentifier(plan.databaseName);
  const migrator = quoteIdentifier(plan.migratorRole);
  const statements: string[] = [];
  const databaseRow = raw.database as Record<string, unknown>;
  for (const grant of exactRecordArray(
    databaseRow.otherGrants,
    "projection.database.otherGrants",
  )) {
    statements.push(
      `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${quoteIdentifier(String(grant.grantee))}`,
    );
  }
  for (const schema of exactRecordArray(raw.schemas, "projection.schemas")) {
    for (const grant of exactRecordArray(
      schema.otherGrants,
      `projection.schemas.${String(schema.name)}.otherGrants`,
    )) {
      statements.push(
        `REVOKE ALL PRIVILEGES ON SCHEMA ${quoteIdentifier(String(schema.name))} FROM ${quoteIdentifier(String(grant.grantee))}`,
      );
    }
  }
  for (const entry of exactRecordArray(
    raw.defaultPrivileges,
    "projection.defaultPrivileges",
  )) {
    const plural =
      entry.kind === "table"
        ? "TABLES"
        : entry.kind === "sequence"
          ? "SEQUENCES"
          : "FUNCTIONS";
    for (const grant of exactRecordArray(
      entry.otherGrants,
      "projection.defaultPrivileges.otherGrants",
    )) {
      statements.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${quoteIdentifier(String(entry.schema))} REVOKE ALL PRIVILEGES ON ${plural} FROM ${quoteIdentifier(String(grant.grantee))}`,
      );
    }
  }
  for (const object of [
    ...exactRecordArray(raw.relations, "projection.relations"),
    ...(raw.functions === null
      ? []
      : exactRecordArray(raw.functions, "projection.functions")),
  ]) {
    const keyword =
      object.kind === "function"
        ? "FUNCTION"
        : String(object.kind).toUpperCase();
    const target =
      object.kind === "function"
        ? `${qualified(String(object.schema), String(object.name))}(${String(object.identityArguments)})`
        : qualified(String(object.schema), String(object.name));
    for (const grant of exactRecordArray(
      object.otherGrants,
      `projection.objects.${objectKey(object)}.otherGrants`,
    )) {
      statements.push(
        `REVOKE ALL PRIVILEGES ON ${keyword} ${target} FROM ${quoteIdentifier(String(grant.grantee))}`,
      );
    }
    for (const grant of exactRecordArray(
      object.columnGrants,
      `projection.objects.${objectKey(object)}.columnGrants`,
    )) {
      statements.push(
        `REVOKE ALL PRIVILEGES (${quoteIdentifier(String(grant.column))}) ON TABLE ${target} FROM ${quoteIdentifier(String(grant.grantee))}`,
      );
    }
  }
  for (const statement of [...new Set(statements)]) {
    await client.query(statement);
  }
  return new Set(statements).size;
}

function validateInput(
  input: ProductionMigrationRoleBootstrapInput,
): ProductionMigrationRoleBootstrapInput {
  if (
    !input ||
    typeof input !== "object" ||
    !SOURCE_SHA.test(input.sourceSha) ||
    !APPROVAL_ID.test(input.approvalId) ||
    input.confirmation !== PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION ||
    !Number.isSafeInteger(input.advisoryLockKey) ||
    typeof input.connect !== "function" ||
    !(input.signal instanceof AbortSignal) ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_INPUT_INVALID",
      "Role bootstrap input is malformed or not explicitly confirmed.",
    );
  }
  exactIdentifier(input.databaseName, "databaseName");
  exactIdentifier(input.sessionUser, "sessionUser");
  exactIdentifier(input.migrationRole, "migrationRole");
  exactIdentifier(input.runtimeRole, "runtimeRole");
  if (
    input.sessionUser === input.migrationRole ||
    input.sessionUser === input.runtimeRole ||
    input.migrationRole === input.runtimeRole
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_INPUT_INVALID",
      "Session, migration and runtime roles must be distinct.",
    );
  }
  return input;
}

export async function runProductionMigrationRoleBootstrap(
  rawInput: ProductionMigrationRoleBootstrapInput,
) {
  const input = validateInput(rawInput);
  const now = input.now ?? (() => new Date());
  throwIfAborted(input.signal);
  let client: BootstrapClient | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  let commitConfirmed = false;
  let destroyClient = false;
  let statementCount = 0;
  try {
    client = await input.connect();
    throwIfAborted(input.signal);
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE",
    );
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10min'");
    await client.query("SELECT pg_advisory_xact_lock($1::integer)", [
      input.advisoryLockKey,
    ]);
    const identity = await client.query(String.raw`
      SELECT current_database() AS name, session_user AS "sessionUser",
        current_user AS "currentUser",
        current_setting('server_version_num')::integer AS "serverVersionNum"`);
    const identityRow = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      identityRow.name !== input.databaseName ||
      identityRow.sessionUser !== input.sessionUser ||
      identityRow.currentUser !== input.sessionUser ||
      Math.floor(Number(identityRow.serverVersionNum) / 10_000) !== 16
    ) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_DATABASE_INVALID",
        "Database, session role or PostgreSQL major is not the exact reviewed baseline.",
      );
    }
    const roles = await client.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::name[]) ORDER BY rolname COLLATE "C"',
      [[input.migrationRole, input.runtimeRole]],
    );
    if (roles.rows.length !== 0) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_ALREADY_EXISTS",
        "Reviewed migration/runtime roles must both be absent before bootstrap.",
      );
    }
    const objects = await assertExactBaselineCatalog(client);
    const plan = buildProductionRolePlan({
      databaseName: input.databaseName,
      runtimeRole: input.runtimeRole,
      migratorRole: input.migrationRole,
    });
    statementCount += await applyBaseRoleBoundary(client, input, objects);
    const rawBeforeCleanup = await readRawProjection(client, plan);
    statementCount += await removeProjectedThirdPartyAcls(
      client,
      rawBeforeCleanup,
      plan,
    );
    await client.query(
      `SET LOCAL ROLE ${quoteIdentifier(input.migrationRole)}`,
    );
    const delegatedIdentity = await client.query(
      'SELECT session_user AS "sessionUser", current_user AS "currentUser"',
    );
    if (
      delegatedIdentity.rows.length !== 1 ||
      delegatedIdentity.rows[0].sessionUser !== input.sessionUser ||
      delegatedIdentity.rows[0].currentUser !== input.migrationRole
    ) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_DELEGATION_INVALID",
        "Session user cannot assume the exact NOLOGIN migration role.",
      );
    }
    const rawProjection = await readRawProjection(client, plan);
    const projection = normalizeProductionMigrationRoleBootstrapProjection(
      rawProjection,
      plan,
    );
    assertPre0107Projection(projection);
    const capturedAt = exactTimestamp(now);
    const rolePlanCanonical = canonicalProductionRoleJson(plan);
    const preProjectionCanonical = canonicalProductionRoleJson(projection);
    const preProjectionSha256 = sha256Canonical(preProjectionCanonical);
    const database = Object.freeze({
      name: input.databaseName,
      sessionUser: input.sessionUser,
      currentUser: input.migrationRole,
    });
    const preconditionCanonical = canonicalProductionRoleJson({
      schemaVersion: "site-logbook.production-migration-role-precondition/v1",
      kind: "site-logbook-production-migration-role-precondition",
      sourceSha: input.sourceSha,
      database,
      migrationRole: input.migrationRole,
      runtimeRole: input.runtimeRole,
      rolePlanCanonical,
      rolePlanSha256: plan.planSha256,
      preProjectionCanonical,
      preProjectionSha256,
      capturedAt,
      migrationRoleCanApplyMigrations: true,
      runtimeRoleCanApplyMigrations: false,
      authorizesApplicationStart: false,
    });
    const parsedPrecondition = parseProductionMigrationRolePrecondition(
      preconditionCanonical,
      { sourceSha: input.sourceSha, database },
    );
    commitStarted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    commitConfirmed = true;
    const rawPostCommit = await readRawProjection(client, plan);
    const postCommitProjection =
      normalizeProductionMigrationRoleBootstrapProjection(rawPostCommit, plan);
    assertPre0107Projection(postCommitProjection);
    const postCommitProjectionCanonical =
      canonicalProductionRoleJson(postCommitProjection);
    if (postCommitProjectionCanonical !== preProjectionCanonical) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_POST_COMMIT_DRIFT",
        "Post-commit role projection differs from the committed precondition.",
        { restoreRequired: true, manualReviewRequired: true },
      );
    }
    const committedAt = exactTimestamp(now);
    const receiptCanonical = canonicalProductionRoleJson({
      schemaVersion: PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_RECEIPT_SCHEMA,
      kind: "site-logbook-production-migration-role-bootstrap-receipt",
      sourceSha: input.sourceSha,
      database,
      migrationRole: input.migrationRole,
      runtimeRole: input.runtimeRole,
      approvalId: input.approvalId,
      rolePlanSha256: plan.planSha256,
      preProjectionSha256,
      preconditionSha256: parsedPrecondition.sha256,
      statementCount,
      transactionCommitted: true,
      capturedAt,
      committedAt,
      postCommitProjectionSha256: sha256Canonical(
        postCommitProjectionCanonical,
      ),
      authorizesApplicationStart: false,
      authorizesDeployment: false,
    });
    return Object.freeze({
      preconditionCanonical,
      preconditionSha256: parsedPrecondition.sha256,
      receiptCanonical,
      receiptSha256: `sha256:${sha256Canonical(receiptCanonical)}`,
      rolePlanCanonical,
      preProjectionCanonical,
      postCommitProjectionCanonical,
    });
  } catch (error) {
    if (commitStarted && !commitConfirmed) {
      destroyClient = true;
      fail(
        "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_COMMIT_UNKNOWN",
        "Role bootstrap commit outcome is unknown; restore and manual review are required.",
        {
          cause: error,
          restoreRequired: true,
          manualReviewRequired: true,
        },
      );
    }
    if (transactionOpen && client) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError) {
        destroyClient = true;
        fail(
          "PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_ROLLBACK_UNKNOWN",
          "Role bootstrap rollback outcome is unknown; restore and manual review are required.",
          {
            cause: rollbackError,
            restoreRequired: true,
            manualReviewRequired: true,
          },
        );
      }
    }
    throw error;
  } finally {
    client?.release(destroyClient);
  }
}
