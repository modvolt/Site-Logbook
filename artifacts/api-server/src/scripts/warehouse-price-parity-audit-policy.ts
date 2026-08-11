export const WAREHOUSE_PRICE_PARITY_MAX_ITEMS = 20_000;
export const WAREHOUSE_PRICE_PARITY_MAX_OBSERVATIONS = 100_000;
export const WAREHOUSE_PRICE_PARITY_MAX_LEGACY_ROWS = 100_000;
export const WAREHOUSE_PRICE_PARITY_BEGIN_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";

export interface WarehousePriceParityAuditOptions {
  database: string;
  targetFingerprint: string;
  maxItems: number;
  maxObservations: number;
  maxLegacyRows: number;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_MUTATION_PREFIXES = [
  "--apply",
  "--execute",
  "--backfill",
  "--update",
  "--delete",
] as const;

function exactArgument(args: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const matches = args.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Audit requires exactly one ${name}=<value> argument.`);
  }
  const value = matches[0].slice(prefix.length);
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${name} must contain one exact non-empty value.`);
  }
  return value;
}

function boundedInteger(
  args: readonly string[],
  name: string,
  maximum: number,
): number {
  const raw = exactArgument(args, name);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} exceeds the hard maximum ${maximum}.`);
  }
  return value;
}

export function parseWarehousePriceParityAuditOptions(
  args: readonly string[],
): WarehousePriceParityAuditOptions {
  for (const argument of args) {
    if (
      FORBIDDEN_MUTATION_PREFIXES.some(
        (prefix) => argument === prefix || argument.startsWith(`${prefix}=`),
      )
    ) {
      throw new Error(
        `${argument.split("=")[0]} is forbidden: this audit has no mutation mode.`,
      );
    }
  }
  const database = exactArgument(args, "--database");
  const targetFingerprint = exactArgument(args, "--target-fingerprint");
  if (!SHA256_PATTERN.test(targetFingerprint)) {
    throw new Error("--target-fingerprint must be a lowercase SHA-256 digest.");
  }
  const maxItems = boundedInteger(
    args,
    "--max-items",
    WAREHOUSE_PRICE_PARITY_MAX_ITEMS,
  );
  const maxObservations = boundedInteger(
    args,
    "--max-observations",
    WAREHOUSE_PRICE_PARITY_MAX_OBSERVATIONS,
  );
  const maxLegacyRows = boundedInteger(
    args,
    "--max-legacy-rows",
    WAREHOUSE_PRICE_PARITY_MAX_LEGACY_ROWS,
  );
  const knownPrefixes = new Set([
    "--database=",
    "--target-fingerprint=",
    "--max-items=",
    "--max-observations=",
    "--max-legacy-rows=",
  ]);
  const unknown = args.find(
    (argument) =>
      ![...knownPrefixes].some((prefix) => argument.startsWith(prefix)),
  );
  if (unknown) {
    throw new Error(`Unsupported audit argument ${JSON.stringify(unknown)}.`);
  }
  return Object.freeze({
    database,
    targetFingerprint,
    maxItems,
    maxObservations,
    maxLegacyRows,
  });
}

export function databaseNameFromParityPostgresUrl(
  raw: string | undefined,
): string {
  if (!raw) throw new Error("DATABASE_URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name a database.");
  return database;
}

export const WAREHOUSE_PRICE_PARITY_CONTEXT_SQL = `
select
  current_database() as database,
  current_setting('transaction_read_only') as transaction_read_only,
  current_setting('transaction_isolation') as transaction_isolation,
  to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at,
  (select count(*)::text from warehouse_items) as item_count,
  (select count(*)::text from accounting_warehouse_price_observations) as observation_count,
  (select count(*)::text from accounting_warehouse_price_projection_heads) as projection_head_count,
  (select count(*)::text from warehouse_price_history) as legacy_row_count
`;

export const WAREHOUSE_PRICE_PARITY_ITEMS_SQL = `
select
  item.id::text as warehouse_item_id,
  item.purchase_price::text as stored_purchase_price,
  projection.canonical_json as projection_canonical_json
from warehouse_items item
left join accounting_warehouse_price_projection_heads projection
  on projection.warehouse_item_id = item.id
order by item.id
`;

export const WAREHOUSE_PRICE_PARITY_OBSERVATIONS_SQL = `
select
  warehouse_item_id::text as warehouse_item_id,
  canonical_json
from accounting_warehouse_price_observations
order by warehouse_item_id, sequence
`;

export const WAREHOUSE_PRICE_PARITY_LEGACY_SQL = `
select
  id::text as legacy_row_id,
  warehouse_item_id::text as warehouse_item_id,
  billing_document_id::text as billing_document_id,
  billing_document_line_id::text as billing_document_line_id,
  purchase_price::text as purchase_price,
  currency,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at
from warehouse_price_history
order by warehouse_item_id, id
`;
