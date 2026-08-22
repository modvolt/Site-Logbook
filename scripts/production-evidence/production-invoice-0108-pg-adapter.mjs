import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  productionMigrationSha256,
} from "./production-migration-contract.mjs";
import { loadProductionMigrationCatalog } from "./production-migration-adapter.mjs";
import {
  PRODUCTION_INVOICE_0108_MIGRATION,
  canonicalProductionInvoice0108Sql,
  validateProductionInvoice0108Inventory,
} from "./production-invoice-0108-contract.mjs";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const JOURNAL_SQL = `SELECT created_at::text AS created_at, hash::text AS hash
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at ASC, hash COLLATE "C" ASC`;
const IDENTITY_SQL =
  "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user";

export class ProductionInvoice0108PgAdapterError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionInvoice0108PgAdapterError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductionInvoice0108PgAdapterError(code, message, options);
}

function exactIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(
      "PRODUCTION_INVOICE_0108_PG_CONFIGURATION_INVALID",
      `${field} is invalid.`,
    );
  }
  return value;
}

function binaryCompare(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadProductionInvoice0108Catalog({
  migrationsDirectory,
  readUtf8 = (file) => readFile(file, "utf8"),
}) {
  const directory = path.resolve(migrationsDirectory);
  const prefix = await loadProductionMigrationCatalog({
    migrationsDirectory: directory,
    readUtf8,
  });
  let journal;
  try {
    journal = JSON.parse(
      await readUtf8(path.join(directory, "meta", "_journal.json")),
    );
  } catch (error) {
    fail(
      "PRODUCTION_INVOICE_0108_CATALOG_INVALID",
      "The exact 0108 migration journal is unavailable.",
      { cause: error },
    );
  }
  const entries = journal?.entries;
  const last = Array.isArray(entries) ? entries.at(-1) : null;
  if (
    !Array.isArray(entries) ||
    entries.length !== 108 ||
    last?.idx !== PRODUCTION_INVOICE_0108_MIGRATION.idx ||
    last?.when !== PRODUCTION_INVOICE_0108_MIGRATION.when ||
    last?.tag !== PRODUCTION_INVOICE_0108_MIGRATION.tag ||
    entries.some(
      (entry) =>
        entry?.idx === 100 || /^0100(?:_|$)/u.test(String(entry?.tag ?? "")),
    )
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CATALOG_INVALID",
      "The journal is not the exact reviewed 0000 through 0108 lineage.",
    );
  }
  let sql;
  try {
    sql = canonicalProductionInvoice0108Sql(
      await readUtf8(
        path.join(directory, `${PRODUCTION_INVOICE_0108_MIGRATION.tag}.sql`),
      ),
    );
  } catch (error) {
    fail(
      "PRODUCTION_INVOICE_0108_CATALOG_INVALID",
      "The pinned 0108 SQL bytes are unavailable or drifted.",
      { cause: error },
    );
  }
  const entry = Object.freeze({
    idx: PRODUCTION_INVOICE_0108_MIGRATION.idx,
    when: PRODUCTION_INVOICE_0108_MIGRATION.when,
    tag: PRODUCTION_INVOICE_0108_MIGRATION.tag,
    hash: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
  });
  const expected = Object.freeze([...prefix.expected, entry]);
  return Object.freeze({
    expected,
    sql,
    migration: PRODUCTION_INVOICE_0108_MIGRATION,
  });
}

export function parseProductionInvoice0108InventoryRows(rows, catalog) {
  if (
    !Array.isArray(rows) ||
    rows.length > 2048 ||
    catalog?.expected?.length !== 108
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_INVENTORY_INVALID",
      "Journal rows or the reviewed 0108 catalog are invalid.",
    );
  }
  const expectedByWhen = new Map(
    catalog.expected.map((entry, index) => [entry.when, { entry, index }]),
  );
  const satisfied = new Map();
  const opaque = [];
  for (const raw of rows) {
    const createdAt = Number(raw?.created_at);
    const hash = raw?.hash;
    if (
      !Number.isSafeInteger(createdAt) ||
      !/^[0-9a-f]{64}$/u.test(String(hash))
    ) {
      fail(
        "PRODUCTION_INVOICE_0108_INVENTORY_INVALID",
        "Journal rows must contain exact bigint timestamps and lowercase hashes.",
      );
    }
    const known = expectedByWhen.get(createdAt);
    if (known && known.entry.hash === hash && !satisfied.has(known.index)) {
      satisfied.set(known.index, { createdAt, hash });
    } else {
      opaque.push({ createdAt, hash });
    }
  }
  const knownRows = [...satisfied.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        binaryCompare(left.hash, right.hash),
    );
  const opaqueLegacyRows = opaque.sort(
    (left, right) =>
      left.createdAt - right.createdAt || binaryCompare(left.hash, right.hash),
  );
  const latestKnownIndex = Math.max(-1, ...satisfied.keys());
  const inventory = Object.freeze({
    knownAppliedMigrations: knownRows.length,
    knownAppliedRowsSha256: productionMigrationSha256(
      JSON.stringify(knownRows),
    ),
    latestKnownAppliedTag:
      latestKnownIndex < 0 ? null : catalog.expected[latestKnownIndex].tag,
    missingKnownMigrationTags: catalog.expected
      .filter((_, index) => !satisfied.has(index))
      .map((entry) => entry.tag),
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows,
    excludedMigration0100Present: false,
    totalJournalRows: rows.length,
  });
  validateProductionInvoice0108Inventory(inventory);
  if (!same(opaqueLegacyRows, PRODUCTION_OPAQUE_LEGACY_ROWS)) {
    fail(
      "PRODUCTION_INVOICE_0108_OPAQUE_ROWS_INVALID",
      "The two frozen production-copy opaque rows are not exact.",
    );
  }
  return inventory;
}

export function createPgProductionInvoice0108Database({
  connect,
  catalog,
  sourceSha,
  databaseName,
  sessionUser,
  migratorRole,
}) {
  if (
    typeof connect !== "function" ||
    !catalog ||
    typeof sourceSha !== "string" ||
    !SOURCE_SHA.test(sourceSha)
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_PG_CONFIGURATION_INVALID",
      "A source-pinned PostgreSQL connection and exact catalog are required.",
    );
  }
  const exactDatabaseName = exactIdentifier(databaseName, "databaseName");
  const exactSessionUser = exactIdentifier(sessionUser, "sessionUser");
  const exactMigratorRole = exactIdentifier(migratorRole, "migratorRole");

  async function assertIdentity(client) {
    const result = await client.query(IDENTITY_SQL);
    const row = result.rows?.[0];
    if (
      result.rows?.length !== 1 ||
      row?.database_name !== exactDatabaseName ||
      row?.session_user !== exactSessionUser ||
      row?.current_user !== exactMigratorRole
    ) {
      fail(
        "PRODUCTION_INVOICE_0108_PG_IDENTITY_INVALID",
        "Connected PostgreSQL identity does not equal the reviewed migration binding.",
      );
    }
  }

  async function readInventory(client) {
    await assertIdentity(client);
    const result = await client.query(JOURNAL_SQL);
    return parseProductionInvoice0108InventoryRows(result.rows, catalog);
  }

  async function readInventoryReadOnly() {
    const client = await connect();
    let transactionOpen = false;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      await client.query(`SET LOCAL ROLE "${exactMigratorRole}"`);
      const inventory = await readInventory(client);
      await client.query("COMMIT");
      transactionOpen = false;
      return inventory;
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  return Object.freeze({
    connect,
    readInventoryReadOnly,
    async readInventoryInTransaction(client) {
      return readInventory(client);
    },
    async assertMigrationAuthorityInTransaction(client, binding) {
      if (
        binding?.sourceSha !== sourceSha ||
        binding?.migration?.idx !== PRODUCTION_INVOICE_0108_MIGRATION.idx ||
        binding?.migration?.when !== PRODUCTION_INVOICE_0108_MIGRATION.when ||
        binding?.migration?.tag !== PRODUCTION_INVOICE_0108_MIGRATION.tag ||
        binding?.migration?.sqlSha256 !==
          PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256
      ) {
        fail(
          "PRODUCTION_INVOICE_0108_PG_AUTHORITY_INVALID",
          "The runner requested a migration outside the exact source-pinned 0108 authority.",
        );
      }
      await client.query(`SET LOCAL ROLE "${exactMigratorRole}"`);
      await assertIdentity(client);
    },
  });
}
