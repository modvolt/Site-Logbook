import pg, { type ClientConfig } from "pg";

import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_DATABASE_USER,
} from "./production-runtime-database";

const { Client } = pg;

const DEFAULT_TIMEOUT_MS = 5_000;

const REQUIRED_COLUMNS = Object.freeze({
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

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface RuntimePreflightClient {
  connect(): Promise<unknown>;
  query<Row extends object = Record<string, unknown>>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
  end(): Promise<void>;
}

export type RuntimePreflightClientFactory = (
  config: ClientConfig,
) => RuntimePreflightClient;

export type ProductionRuntimePreflightState =
  | "uninstalled"
  | "ready"
  | "failed";

export interface ProductionRuntimePreflightSnapshot {
  readonly state: "ready" | "failed";
  readonly buildSha: string;
  readonly database: "ok" | "error";
  readonly schema: "0108" | "incompatible";
  readonly runtimeRole: "ok" | "error";
  readonly databaseName: string | null;
  readonly databaseUser: string | null;
  readonly checkedAt: string;
  readonly errorCode?: string;
}

export interface ProductionRuntimeHealthProjection {
  readonly httpStatus: 200 | 503;
  readonly status: "ok" | "degraded";
  readonly buildSha: string;
  readonly database: "ok" | "error";
  readonly schema: "0108" | "incompatible";
  readonly runtimeRole: "ok" | "error";
  readonly activationEvidence: "ignored-for-runtime";
  readonly backup: Readonly<{
    status: "ok" | "warning" | "unknown";
    blocking: false;
  }>;
}

type PreflightFailureComponent = "database" | "schema" | "runtimeRole";

export class ProductionRuntimePreflightError extends Error {
  constructor(
    public readonly code: string,
    public readonly component: PreflightFailureComponent,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionRuntimePreflightError";
  }
}

interface RunOptions {
  clientFactory?: RuntimePreflightClientFactory;
  timeoutMs?: number;
}

interface DatabaseIdentity {
  databaseName: string;
  databaseUser: string;
  databaseUrl: string;
}

let state: ProductionRuntimePreflightState = "uninstalled";
let snapshot: ProductionRuntimePreflightSnapshot | null = null;
let refresh: (() => Promise<ProductionRuntimePreflightSnapshot>) | null = null;

function fail(
  code: string,
  component: PreflightFailureComponent,
  message: string,
  cause?: unknown,
): never {
  throw new ProductionRuntimePreflightError(code, component, message, {
    cause,
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_ENV_MISSING",
      key === "DATABASE_URL" ? "database" : "runtimeRole",
      `${key} is required.`,
    );
  }
  return value;
}

function resolveDatabaseIdentity(env: NodeJS.ProcessEnv): DatabaseIdentity {
  const databaseUrl = required(env, "DATABASE_URL");
  const expectedDatabaseUser = required(
    env,
    "PRODUCTION_EXPECTED_DATABASE_USER",
  );
  if (expectedDatabaseUser !== PRODUCTION_RUNTIME_DATABASE_USER) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_ROLE_CONFIG_INVALID",
      "runtimeRole",
      "The configured production database user is not the runtime role.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_URL_INVALID",
      "database",
      "DATABASE_URL is malformed.",
      error,
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_URL_INVALID",
      "database",
      "DATABASE_URL must use PostgreSQL.",
    );
  }

  let databaseUser: string;
  let databaseName: string;
  try {
    databaseUser = decodeURIComponent(parsed.username);
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_URL_INVALID",
      "database",
      "DATABASE_URL identity is not canonically encoded.",
      error,
    );
  }
  if (
    databaseUser !== expectedDatabaseUser ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(databaseName) ||
    parsed.pathname.split("/").filter(Boolean).length !== 1
  ) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_IDENTITY_INVALID",
      databaseUser === expectedDatabaseUser ? "database" : "runtimeRole",
      "DATABASE_URL does not select the configured runtime database identity.",
    );
  }
  return { databaseName, databaseUser, databaseUrl };
}

function timeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("Production runtime preflight timeout must be positive.");
  }
  return resolved;
}

function failedSnapshot(
  buildSha: string,
  error: ProductionRuntimePreflightError,
): ProductionRuntimePreflightSnapshot {
  return Object.freeze({
    state: "failed" as const,
    buildSha,
    database:
      error.component === "database" ? ("error" as const) : ("ok" as const),
    schema:
      error.component === "schema"
        ? ("incompatible" as const)
        : ("0108" as const),
    runtimeRole:
      error.component === "runtimeRole" ? ("error" as const) : ("ok" as const),
    databaseName: null,
    databaseUser: null,
    checkedAt: new Date().toISOString(),
    errorCode: error.code,
  });
}

export async function verifyProductionRuntimePreflight(
  env: NodeJS.ProcessEnv,
  buildSha: string,
  options: RunOptions = {},
): Promise<ProductionRuntimePreflightSnapshot> {
  if (env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT !== "production") {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_ENVIRONMENT_INVALID",
      "database",
      "The production runtime preflight is production-only.",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(buildSha)) {
    fail(
      "PRODUCTION_RUNTIME_PREFLIGHT_BUILD_SHA_INVALID",
      "database",
      "The embedded build SHA must be exact.",
    );
  }

  const identity = resolveDatabaseIdentity(env);
  const timeoutMs = timeout(options.timeoutMs);
  const clientFactory =
    options.clientFactory ??
    ((config: ClientConfig) =>
      new Client(config) as unknown as RuntimePreflightClient);
  const client = clientFactory({
    connectionString: identity.databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: "site-logbook-production-runtime-preflight",
  });
  let transactionStarted = false;

  try {
    try {
      await client.connect();
      await client.query("BEGIN TRANSACTION READ ONLY");
      transactionStarted = true;
      await client.query("SELECT 1 AS readiness");
    } catch (error) {
      fail(
        "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_UNAVAILABLE",
        "database",
        "The production database did not answer the read-only readiness query.",
        error,
      );
    }

    const identityResult = await client.query<{
      database_name: string;
      current_user_name: string;
      session_user_name: string;
      is_superuser: boolean;
      can_create_role: boolean;
      can_create_database: boolean;
      can_replicate: boolean;
      bypasses_rls: boolean;
      member_of_migrator: boolean;
    }>(
      `SELECT current_database() AS database_name,
              current_user AS current_user_name,
              session_user AS session_user_name,
              role.rolsuper AS is_superuser,
              role.rolcreaterole AS can_create_role,
              role.rolcreatedb AS can_create_database,
              role.rolreplication AS can_replicate,
              role.rolbypassrls AS bypasses_rls,
              pg_has_role(current_user, $1, 'MEMBER') AS member_of_migrator
         FROM pg_roles role
        WHERE role.rolname = current_user`,
      [PRODUCTION_MIGRATOR_DATABASE_USER],
    );
    const liveIdentity = identityResult.rows[0];
    if (!liveIdentity || liveIdentity.database_name !== identity.databaseName) {
      fail(
        "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_IDENTITY_INVALID",
        "database",
        "The live connection selected a different database.",
      );
    }
    if (
      liveIdentity.current_user_name !== identity.databaseUser ||
      liveIdentity.session_user_name !== identity.databaseUser ||
      liveIdentity.current_user_name === PRODUCTION_MIGRATOR_DATABASE_USER ||
      liveIdentity.is_superuser ||
      liveIdentity.can_create_role ||
      liveIdentity.can_create_database ||
      liveIdentity.can_replicate ||
      liveIdentity.bypasses_rls ||
      liveIdentity.member_of_migrator
    ) {
      fail(
        "PRODUCTION_RUNTIME_PREFLIGHT_ROLE_INVALID",
        "runtimeRole",
        "The live connection is not the least-privilege runtime role.",
      );
    }

    const objects = await client.query<{
      allocation_table: string | null;
      allocation_sequence: string | null;
    }>(`SELECT to_regclass('public.invoice_source_allocations')::text AS allocation_table,
              to_regclass('public.invoice_source_allocations_id_seq')::text AS allocation_sequence`);
    if (
      !objects.rows[0]?.allocation_table ||
      !objects.rows[0]?.allocation_sequence
    ) {
      fail(
        "PRODUCTION_RUNTIME_PREFLIGHT_SCHEMA_INCOMPATIBLE",
        "schema",
        "Required invoice 0108 objects are absent.",
      );
    }

    const columns = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [Object.keys(REQUIRED_COLUMNS)],
    );
    const observedColumns = new Set(
      columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const [table, names] of Object.entries(REQUIRED_COLUMNS)) {
      for (const name of names) {
        if (!observedColumns.has(`${table}.${name}`)) {
          fail(
            "PRODUCTION_RUNTIME_PREFLIGHT_SCHEMA_INCOMPATIBLE",
            "schema",
            `Required invoice 0108 column ${table}.${name} is absent.`,
          );
        }
      }
    }

    const privileges = await client.query<{
      allocation_select: boolean;
      allocation_insert: boolean;
      allocation_update: boolean;
      allocation_sequence_usage: boolean;
      settings_select: boolean;
      settings_update: boolean;
      invoice_lines_select: boolean;
      invoice_lines_insert: boolean;
      invoice_lines_update: boolean;
      invoices_select: boolean;
      invoices_insert: boolean;
      invoices_update: boolean;
    }>(`SELECT
      has_table_privilege(current_user, 'public.invoice_source_allocations', 'SELECT') AS allocation_select,
      has_table_privilege(current_user, 'public.invoice_source_allocations', 'INSERT') AS allocation_insert,
      has_table_privilege(current_user, 'public.invoice_source_allocations', 'UPDATE') AS allocation_update,
      has_sequence_privilege(current_user, 'public.invoice_source_allocations_id_seq', 'USAGE') AS allocation_sequence_usage,
      has_table_privilege(current_user, 'public.billing_settings', 'SELECT') AS settings_select,
      has_table_privilege(current_user, 'public.billing_settings', 'UPDATE') AS settings_update,
      has_table_privilege(current_user, 'public.invoice_lines', 'SELECT') AS invoice_lines_select,
      has_table_privilege(current_user, 'public.invoice_lines', 'INSERT') AS invoice_lines_insert,
      has_table_privilege(current_user, 'public.invoice_lines', 'UPDATE') AS invoice_lines_update,
      has_table_privilege(current_user, 'public.invoices', 'SELECT') AS invoices_select,
      has_table_privilege(current_user, 'public.invoices', 'INSERT') AS invoices_insert,
      has_table_privilege(current_user, 'public.invoices', 'UPDATE') AS invoices_update`);
    const grant = privileges.rows[0];
    if (!grant || Object.values(grant).some((value) => value !== true)) {
      fail(
        "PRODUCTION_RUNTIME_PREFLIGHT_ROLE_PRIVILEGES_INSUFFICIENT",
        "runtimeRole",
        "The runtime role lacks permissions required for invoice 0108 operation.",
      );
    }

    return Object.freeze({
      state: "ready" as const,
      buildSha,
      database: "ok" as const,
      schema: "0108" as const,
      runtimeRole: "ok" as const,
      databaseName: liveIdentity.database_name,
      databaseUser: liveIdentity.current_user_name,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof ProductionRuntimePreflightError) throw error;
    throw new ProductionRuntimePreflightError(
      "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_UNAVAILABLE",
      "database",
      "The live read-only production preflight failed.",
      { cause: error },
    );
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export async function runAfterProductionRuntimePreflight<T>(
  env: NodeJS.ProcessEnv,
  buildSha: string,
  startRuntime: () => T | Promise<T>,
  options: RunOptions = {},
): Promise<T> {
  if (state !== "uninstalled") {
    throw new Error(
      "PRODUCTION_RUNTIME_PREFLIGHT_ALREADY_INSTALLED: the runtime preflight may only be installed once.",
    );
  }
  const readySnapshot = await verifyProductionRuntimePreflight(
    env,
    buildSha,
    options,
  );
  snapshot = readySnapshot;
  state = "ready";
  refresh = () => verifyProductionRuntimePreflight(env, buildSha, options);
  return startRuntime();
}

export function readProductionRuntimePreflightState(): ProductionRuntimePreflightState {
  return state;
}

export function readProductionRuntimePreflightSnapshot(): ProductionRuntimePreflightSnapshot | null {
  return snapshot;
}

export async function refreshProductionRuntimePreflight(): Promise<boolean> {
  if (state !== "ready" || !refresh) return false;
  try {
    snapshot = await refresh();
    return true;
  } catch (error) {
    const failure =
      error instanceof ProductionRuntimePreflightError
        ? error
        : new ProductionRuntimePreflightError(
            "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_UNAVAILABLE",
            "database",
            "The live read-only production preflight failed.",
            { cause: error },
          );
    snapshot = failedSnapshot(snapshot?.buildSha ?? "unknown", failure);
    state = "failed";
    return false;
  }
}

export function failProductionRuntimePreflight(): boolean {
  if (state !== "ready") return false;
  state = "failed";
  return true;
}

export function projectProductionRuntimeHealth(
  current: ProductionRuntimePreflightSnapshot | null,
  backupStatus: "ok" | "warning" | "unknown" = "unknown",
): ProductionRuntimeHealthProjection {
  const ready =
    current?.state === "ready" &&
    current.database === "ok" &&
    current.schema === "0108" &&
    current.runtimeRole === "ok";
  return Object.freeze({
    httpStatus: ready ? (200 as const) : (503 as const),
    status: ready ? ("ok" as const) : ("degraded" as const),
    buildSha: current?.buildSha ?? "unknown",
    database: current?.database ?? "error",
    schema: current?.schema ?? "incompatible",
    runtimeRole: current?.runtimeRole ?? "error",
    activationEvidence: "ignored-for-runtime" as const,
    backup: Object.freeze({ status: backupStatus, blocking: false as const }),
  });
}

/** Test-only reset; production code never calls this. */
export function resetProductionRuntimePreflightForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Production runtime preflight reset is test-only.");
  }
  state = "uninstalled";
  snapshot = null;
  refresh = null;
}
