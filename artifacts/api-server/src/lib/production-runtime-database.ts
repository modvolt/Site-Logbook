export const PRODUCTION_RUNTIME_DATABASE_USER = "site_logbook_runtime" as const;
export const PRODUCTION_MIGRATOR_DATABASE_USER =
  "site_logbook_migrator" as const;
export const PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV =
  "PRODUCTION_RUNTIME_DATABASE_PASSWORD" as const;
export const PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV =
  "PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL" as const;
export const PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV =
  "PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE" as const;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const URL_SAFE_PASSWORD = /^[A-Za-z0-9._~-]{32,256}$/;

export class ProductionRuntimeDatabaseContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionRuntimeDatabaseContractError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductionRuntimeDatabaseContractError(code, message, { cause });
}

export function requireProductionRuntimeDatabaseUser(
  value: unknown,
): typeof PRODUCTION_RUNTIME_DATABASE_USER {
  if (value !== PRODUCTION_RUNTIME_DATABASE_USER) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_USER_INVALID",
      "Production API database identity must be the source-pinned runtime role.",
    );
  }
  return PRODUCTION_RUNTIME_DATABASE_USER;
}

export function requireProductionRuntimeDatabasePassword(
  value: unknown,
): string {
  if (typeof value !== "string" || !URL_SAFE_PASSWORD.test(value)) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_PASSWORD_INVALID",
      "Runtime database credential must be a 32-256 character URL-safe secret.",
    );
  }
  return value;
}

function decodeUrlComponent(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      `${field} is not canonically URL encoded.`,
      error,
    );
  }
}

export interface ProductionRuntimeDatabaseUrlIdentity {
  readonly databaseName: string;
  readonly databaseUser: typeof PRODUCTION_RUNTIME_DATABASE_USER;
  readonly host: string;
  readonly port: string;
}

/**
 * Validates the API connection without returning its password. Runtime startup
 * may therefore bind identity while keeping the credential out of logs and
 * evidence objects.
 */
export function validateProductionRuntimeDatabaseUrl(
  raw: unknown,
  expectedDatabaseName: unknown,
): ProductionRuntimeDatabaseUrlIdentity {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw !== raw.trim() ||
    typeof expectedDatabaseName !== "string" ||
    !IDENTIFIER.test(expectedDatabaseName)
  ) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      "Production runtime database URL or expected database name is invalid.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      "Production runtime database URL is malformed.",
      error,
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.toLowerCase() !== "postgres" ||
    (parsed.port.length > 0 && parsed.port !== "5432") ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0
  ) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      "Production runtime database URL has an unsupported endpoint shape.",
    );
  }
  const databaseUser = decodeUrlComponent(parsed.username, "database user");
  requireProductionRuntimeDatabaseUser(databaseUser);
  const password = decodeUrlComponent(parsed.password, "database password");
  requireProductionRuntimeDatabasePassword(password);
  const pathname = parsed.pathname;
  if (!/^\/[^/]+$/.test(pathname)) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      "Production runtime database URL must select exactly one database.",
    );
  }
  const databaseName = decodeUrlComponent(pathname.slice(1), "database name");
  if (
    parsed.username !== PRODUCTION_RUNTIME_DATABASE_USER ||
    parsed.password !== password ||
    pathname !== `/${expectedDatabaseName}` ||
    databaseName !== expectedDatabaseName
  ) {
    fail(
      "PRODUCTION_RUNTIME_DATABASE_URL_INVALID",
      "Production runtime database URL selects a different database.",
    );
  }
  return Object.freeze({
    databaseName,
    databaseUser: PRODUCTION_RUNTIME_DATABASE_USER,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
  });
}
