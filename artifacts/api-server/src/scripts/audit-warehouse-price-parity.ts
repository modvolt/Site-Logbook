import pg, { type QueryResultRow } from "pg";
import {
  canonicalAccountingWarehousePriceParityReportJson,
  createAccountingWarehousePriceParityReport,
  type AccountingWarehousePriceParityItemInputV1,
} from "../lib/accounting-warehouse-price-parity";
import { verifyCanonicalAccountingWarehousePriceStreamEntryJsonBytes } from "../lib/accounting-warehouse-price-stream-contract";
import { verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes } from "../lib/accounting-warehouse-price-projection-head";
import {
  databaseNameFromParityPostgresUrl,
  parseWarehousePriceParityAuditOptions,
  WAREHOUSE_PRICE_PARITY_BEGIN_SQL,
  WAREHOUSE_PRICE_PARITY_CONTEXT_SQL,
  WAREHOUSE_PRICE_PARITY_ITEMS_SQL,
  WAREHOUSE_PRICE_PARITY_LEGACY_SQL,
  WAREHOUSE_PRICE_PARITY_OBSERVATIONS_SQL,
} from "./warehouse-price-parity-audit-policy";

const { Client } = pg;
type UnknownRow = QueryResultRow & Record<string, unknown>;

function requiredString(row: UnknownRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Warehouse-price parity query returned invalid ${key}.`);
  }
  return value;
}

function nullableString(row: UnknownRow, key: string): string | null {
  return row[key] == null ? null : requiredString(row, key);
}

function count(row: UnknownRow, key: string): number {
  const raw = requiredString(row, key);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`Warehouse-price parity query returned invalid ${key}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Warehouse-price parity ${key} exceeds safe bounds.`);
  }
  return value;
}

function oneRow(rows: UnknownRow[], label: string): UnknownRow {
  if (rows.length !== 1) {
    throw new Error(
      `Warehouse-price parity ${label} returned ${rows.length} rows.`,
    );
  }
  return rows[0];
}

function requireWithin(name: string, value: number, maximum: number): void {
  if (value > maximum) {
    throw new Error(`${name} ${value} exceeds approved limit ${maximum}.`);
  }
}

async function main(): Promise<void> {
  const options = parseWarehousePriceParityAuditOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (
    databaseNameFromParityPostgresUrl(connectionString) !== options.database
  ) {
    throw new Error(
      "--database must exactly match the database named by DATABASE_URL.",
    );
  }
  const client = new Client({
    connectionString,
    application_name: "site-logbook-warehouse-price-parity-read-only-audit",
    connectionTimeoutMillis: 10_000,
    query_timeout: 300_000,
    statement_timeout: 300_000,
  });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query(WAREHOUSE_PRICE_PARITY_BEGIN_SQL);
    transactionOpen = true;
    const context = oneRow(
      (await client.query<UnknownRow>(WAREHOUSE_PRICE_PARITY_CONTEXT_SQL)).rows,
      "context query",
    );
    if (requiredString(context, "database") !== options.database) {
      throw new Error(
        "--database must exactly match PostgreSQL current_database().",
      );
    }
    if (
      requiredString(context, "transaction_read_only") !== "on" ||
      requiredString(context, "transaction_isolation") !== "repeatable read"
    ) {
      throw new Error(
        "PostgreSQL did not enter the required REPEATABLE READ READ ONLY boundary.",
      );
    }
    const itemCount = count(context, "item_count");
    const observationCount = count(context, "observation_count");
    const projectionHeadCount = count(context, "projection_head_count");
    const legacyRowCount = count(context, "legacy_row_count");
    requireWithin("Warehouse item count", itemCount, options.maxItems);
    requireWithin(
      "Warehouse observation count",
      observationCount,
      options.maxObservations,
    );
    requireWithin(
      "Legacy warehouse-price row count",
      legacyRowCount,
      options.maxLegacyRows,
    );
    if (projectionHeadCount > itemCount) {
      throw new Error(
        "Warehouse-price projection-head count exceeds warehouse item count.",
      );
    }

    // A single pg.Client owns this fixed snapshot. Keep its queries explicitly
    // sequential: concurrent client.query() calls are deprecated and obscure
    // the exact inventory order without adding database-side parallelism.
    const itemResult = await client.query<UnknownRow>(
      WAREHOUSE_PRICE_PARITY_ITEMS_SQL,
    );
    const observationResult = await client.query<UnknownRow>(
      WAREHOUSE_PRICE_PARITY_OBSERVATIONS_SQL,
    );
    const legacyResult = await client.query<UnknownRow>(
      WAREHOUSE_PRICE_PARITY_LEGACY_SQL,
    );
    if (
      itemResult.rows.length !== itemCount ||
      observationResult.rows.length !== observationCount ||
      legacyResult.rows.length !== legacyRowCount
    ) {
      throw new Error(
        "Warehouse-price parity snapshot counts changed inside the read-only transaction.",
      );
    }
    if (
      itemResult.rows.filter((row) => row.projection_canonical_json !== null)
        .length !== projectionHeadCount
    ) {
      throw new Error(
        "Warehouse-price projection-head count changed inside the read-only transaction.",
      );
    }
    await client.query("COMMIT");
    transactionOpen = false;

    const items = new Map<string, AccountingWarehousePriceParityItemInputV1>();
    for (const row of itemResult.rows) {
      const warehouseItemId = requiredString(row, "warehouse_item_id");
      if (items.has(warehouseItemId)) {
        throw new Error("Warehouse-price parity returned a duplicate item.");
      }
      items.set(warehouseItemId, {
        warehouseItemId,
        storedPurchasePrice: nullableString(row, "stored_purchase_price"),
        observations: [],
        projectionHead:
          row.projection_canonical_json == null
            ? null
            : verifyCanonicalAccountingWarehousePriceProjectionHeadJsonBytes(
                requiredString(row, "projection_canonical_json"),
              ),
        legacyRows: [],
      });
    }
    for (const row of observationResult.rows) {
      const warehouseItemId = requiredString(row, "warehouse_item_id");
      const item = items.get(warehouseItemId);
      if (!item) {
        throw new Error(
          "Warehouse-price observation references a missing item.",
        );
      }
      item.observations.push(
        verifyCanonicalAccountingWarehousePriceStreamEntryJsonBytes(
          requiredString(row, "canonical_json"),
        ),
      );
    }
    for (const row of legacyResult.rows) {
      const warehouseItemId = requiredString(row, "warehouse_item_id");
      const item = items.get(warehouseItemId);
      if (!item) {
        throw new Error(
          "Legacy warehouse-price row references a missing item.",
        );
      }
      item.legacyRows.push({
        legacyRowId: requiredString(row, "legacy_row_id"),
        warehouseItemId,
        billingDocumentId: nullableString(row, "billing_document_id"),
        billingDocumentLineId: nullableString(row, "billing_document_line_id"),
        purchasePrice: requiredString(row, "purchase_price"),
        currency: requiredString(row, "currency"),
        recordedAt: requiredString(row, "recorded_at"),
      });
    }
    const report = createAccountingWarehousePriceParityReport({
      targetFingerprint: options.targetFingerprint,
      observedAt: requiredString(context, "observed_at"),
      limits: {
        maxItems: options.maxItems,
        maxObservations: options.maxObservations,
        maxLegacyRows: options.maxLegacyRows,
      },
      items: [...items.values()],
    });
    process.stdout.write(
      canonicalAccountingWarehousePriceParityReportJson(report),
    );
    if (report.summary.decision === "REVIEW") process.exitCode = 2;
    if (report.summary.decision === "BLOCK") process.exitCode = 3;
  } finally {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the primary audit failure; the connection is closed below.
      }
    }
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Warehouse-price parity audit failed."}\n`,
  );
  process.exitCode = 1;
});
