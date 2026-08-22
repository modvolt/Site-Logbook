import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createProductionMigrationRole0108Authority } from "../../lib/db/src/production-migration-role-0108-authority.ts";
import { buildProductionRolePlan } from "../../lib/db/src/production-role-separation-contract.ts";
import {
  createPgProductionInvoice0108Database,
  loadProductionInvoice0108Catalog,
  parseProductionInvoice0108InventoryRows,
} from "../production-evidence/production-invoice-0108-pg-adapter.mjs";
import {
  PRODUCTION_INVOICE_0108_CONFIRMATION,
  PRODUCTION_INVOICE_0108_PRE_STATE,
  PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
} from "../production-evidence/production-invoice-0108-contract.mjs";
import { createProductionInvoice0108Executable } from "../production-evidence/production-invoice-0108-runner.mjs";
import {
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  createProductionMigrationArtifact,
} from "../production-evidence/production-migration-contract.mjs";

const requireFromDb = createRequire(
  new URL("../../lib/db/package.json", import.meta.url),
);
const { Client, Pool } = requireFromDb("pg");

const connectionUrl = process.env.PRODUCTION_INVOICE_0108_PG_URL;
const disposableConfirmation =
  process.env.PRODUCTION_INVOICE_0108_PG_DISPOSABLE_CONFIRM;
const DISPOSABLE_CONFIRMATION =
  "I_CONFIRM_THIS_IS_A_DISPOSABLE_LOOPBACK_INVOICE_0108_DATABASE";
const databaseName = "site_logbook_invoice_0108_fixture";
const migratorRole = "site_logbook_invoice_0108_migrator";
const runtimeRole = "site_logbook_invoice_0108_runtime";
const sourceSha = "32fb8ec737e513421ec359da63cc870c8e078c7f";
const migrationsDirectory = path.resolve("lib/db/migrations");

function assertDisposableUrl(raw, confirmation) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("PRODUCTION_INVOICE_0108_DISPOSABLE_DATABASE_REQUIRED");
  }
  const port = Number(url.port);
  if (
    confirmation !== DISPOSABLE_CONFIRMATION ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 49_152 ||
    port > 65_535 ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PRODUCTION_INVOICE_0108_DISPOSABLE_DATABASE_REQUIRED");
  }
  return url;
}

function databaseUrl(base, user = base.username) {
  const value = new URL(base);
  value.username = user;
  value.pathname = `/${databaseName}`;
  return value.href;
}

function memoryArtifactStore() {
  const values = new Map();
  return {
    values,
    async persistExclusive(storageId, canonical) {
      if (values.has(storageId)) throw new Error("exclusive artifact exists");
      values.set(storageId, canonical);
    },
    async readCanonical(storageId) {
      const value = values.get(storageId);
      if (value === undefined) throw new Error("artifact missing");
      return value;
    },
    async readOptionalCanonical(storageId) {
      return values.get(storageId) ?? null;
    },
  };
}

function backupReference(at, receiptSuffix) {
  return createProductionMigrationArtifact({
    schemaVersion:
      "site-logbook.production-exact-0107-backup-restore-reference/v1",
    kind: "site-logbook-production-exact-0107-backup-restore-reference",
    receiptStorageId: `invoice-0108-fixture-backup-${receiptSuffix}.json`,
    receiptSha256: `sha256:${receiptSuffix.repeat(64).slice(0, 64)}`,
    sourceSha,
    sourceInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    backupCompletedAt: new Date(at - 20_000).toISOString(),
    restoreVerifiedAt: new Date(at - 10_000).toISOString(),
    decision: "PASS",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
}

async function applyReviewedPrefix(client, catalog) {
  await client.query(`CREATE SCHEMA drizzle AUTHORIZATION "${migratorRole}"`);
  await client.query(`CREATE TABLE drizzle.__drizzle_migrations (
    id serial PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint NOT NULL
  )`);
  for (const entry of catalog.expected.slice(0, 107)) {
    const sql = await readFile(
      path.join(migrationsDirectory, `${entry.tag}.sql`),
      "utf8",
    );
    await client.query(sql.replace(/\r\n?/gu, "\n"));
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [entry.hash, entry.when],
    );
  }
  for (const opaque of PRODUCTION_OPAQUE_LEGACY_ROWS) {
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [opaque.hash, opaque.createdAt],
    );
  }
}

async function runForward(executable, artifacts, clock, suffix) {
  const reference = backupReference(clock, suffix);
  const prepared = await executable.prepare({
    intentId: suffix.repeat(64).slice(0, 64),
    operator: "disposable-pg-invoice-0108",
    approvedAt: new Date(clock).toISOString(),
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
    backupRestoreReferenceCanonical: reference.canonical,
  });
  const applied = await executable.apply({
    planStorageId: prepared.planStorageId,
    intentStorageId: prepared.intentStorageId,
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
  });
  const role = await executable.applyRoleDelta({
    planStorageId: prepared.planStorageId,
    intentStorageId: prepared.intentStorageId,
    migrationReceiptStorageId: applied.receiptStorageId,
    confirmation: PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
  });
  const recovery = await executable.inspect({
    planStorageId: prepared.planStorageId,
    intentStorageId: prepared.intentStorageId,
    migrationReceiptStorageId: applied.receiptStorageId,
    roleReceiptStorageId: role.roleReceiptStorageId,
  });
  assert.equal(recovery.decision, "EXACT_0108_AND_ROLE_DELTA_RECEIPT_BACKED");
  assert.equal(artifacts.values.has(role.roleReceiptStorageId), true);
}

test("0108 PG guard rejects production-like or unconfirmed endpoints", () => {
  assert.throws(
    () =>
      assertDisposableUrl(
        "postgres://postgres@production-postgres:5432/postgres",
        DISPOSABLE_CONFIRMATION,
      ),
    /DISPOSABLE_DATABASE_REQUIRED/u,
  );
  assert.throws(
    () => assertDisposableUrl("postgres://postgres@127.0.0.1:55432/postgres"),
    /DISPOSABLE_DATABASE_REQUIRED/u,
  );
});

test("0108 PostgreSQL catalog classifies only the exact 0107 and 0108 inventories", async () => {
  const catalog = await loadProductionInvoice0108Catalog({
    migrationsDirectory,
  });
  assert.equal(catalog.expected.length, 108);
  assert.equal(
    catalog.expected.at(-1).tag,
    "0108_invoice_source_allocations_and_advances",
  );
  const rows = [
    ...catalog.expected.slice(0, 107).map((entry) => ({
      created_at: String(entry.when),
      hash: entry.hash,
    })),
    ...PRODUCTION_OPAQUE_LEGACY_ROWS.map((row) => ({
      created_at: String(row.createdAt),
      hash: row.hash,
    })),
  ];
  const before = parseProductionInvoice0108InventoryRows(rows, catalog);
  assert.equal(before.knownAppliedMigrations, 107);
  assert.deepEqual(before.missingKnownMigrationTags, [
    "0108_invoice_source_allocations_and_advances",
  ]);
  const after = parseProductionInvoice0108InventoryRows(
    [
      ...rows,
      {
        created_at: String(catalog.expected.at(-1).when),
        hash: catalog.expected.at(-1).hash,
      },
    ],
    catalog,
  );
  assert.equal(after.knownAppliedMigrations, 108);
  assert.deepEqual(after.missingKnownMigrationTags, []);
  assert.throws(
    () =>
      parseProductionInvoice0108InventoryRows(
        [...rows, { created_at: "1", hash: "f".repeat(64) }],
        catalog,
      ),
    /OPAQUE_DRIFT|INVENTORY/u,
  );
});

test(
  "disposable PostgreSQL runs exact 0107→0108, least privilege, DOWN and forward again",
  {
    skip: connectionUrl === undefined && disposableConfirmation === undefined,
    timeout: 240_000,
  },
  async () => {
    const base = assertDisposableUrl(connectionUrl, disposableConfirmation);
    const admin = new Client({ connectionString: base.href });
    await admin.connect();
    try {
      const version = await admin.query("SHOW server_version_num");
      assert.equal(Number(version.rows[0].server_version_num) >= 160000, true);
      await admin.query(`CREATE ROLE "${migratorRole}" NOLOGIN`);
      await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN`);
      await admin.query(
        `CREATE DATABASE "${databaseName}" OWNER "${migratorRole}"`,
      );
    } finally {
      await admin.end();
    }

    const fixtureAdmin = new Client({ connectionString: databaseUrl(base) });
    await fixtureAdmin.connect();
    const catalog = await loadProductionInvoice0108Catalog({
      migrationsDirectory,
    });
    try {
      await fixtureAdmin.query(`SET ROLE "${migratorRole}"`);
      await applyReviewedPrefix(fixtureAdmin, catalog);
      await fixtureAdmin.query("RESET ROLE");
      const baseRolePlan = buildProductionRolePlan({
        databaseName,
        migratorRole,
        runtimeRole,
      });
      for (const statement of baseRolePlan.statements) {
        await fixtureAdmin.query(statement);
      }
    } finally {
      await fixtureAdmin.end();
    }

    const pool = new Pool({ connectionString: databaseUrl(base), max: 4 });
    let clock = Date.parse("2026-08-23T10:00:00.000Z");
    const database = createPgProductionInvoice0108Database({
      connect: () => pool.connect(),
      catalog,
      sourceSha,
      databaseName,
      sessionUser: base.username,
      migratorRole,
    });
    const roleAuthority = createProductionMigrationRole0108Authority({
      connect: () => pool.connect(),
      databaseName,
      sessionUser: base.username,
      migratorRole,
      runtimeRole,
      now: () => new Date(clock++),
    });
    const artifacts = memoryArtifactStore();
    const executable = createProductionInvoice0108Executable({
      sourceSha,
      readMigrationSql: () =>
        readFile(
          path.join(
            migrationsDirectory,
            "0108_invoice_source_allocations_and_advances.sql",
          ),
          "utf8",
        ),
      database,
      artifacts,
      backupAuthority: {
        assertFreshExact0107BackupRestoreReceipt() {},
      },
      roleAuthority,
      now: () => new Date(clock++),
    });

    try {
      await runForward(executable, artifacts, clock, "a");

      const runtime = new Client({
        connectionString: databaseUrl(base, runtimeRole),
      });
      await runtime.connect();
      try {
        const inserted =
          await runtime.query(`INSERT INTO invoice_source_allocations (
          invoice_id_snapshot, source_type, source_id, source_description,
          original_quantity, allocated_quantity, source_amount_without_vat,
          legacy_incomplete
        ) VALUES (1, 'material', 9001, 'PG privilege proof', 1, 1, 10, true)
        RETURNING id`);
        assert.equal(Number.isSafeInteger(inserted.rows[0].id), true);
        const id = inserted.rows[0].id;
        assert.equal(
          (
            await runtime.query(
              "SELECT source_description FROM invoice_source_allocations WHERE id = $1",
              [id],
            )
          ).rows[0].source_description,
          "PG privilege proof",
        );
        await runtime.query(
          "UPDATE invoice_source_allocations SET source_description = 'updated' WHERE id = $1",
          [id],
        );
        for (const statement of [
          "DELETE FROM invoice_source_allocations WHERE id = 1",
          "CREATE TABLE invoice_0108_runtime_forbidden(id integer)",
          "ALTER TABLE invoice_source_allocations ADD COLUMN forbidden integer",
          "INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('forbidden', 1)",
        ]) {
          await assert.rejects(
            runtime.query(statement),
            (error) => error?.code === "42501",
          );
        }
      } finally {
        await runtime.end();
      }

      const rollback = new Client({ connectionString: databaseUrl(base) });
      await rollback.connect();
      try {
        await rollback.query(
          "DELETE FROM invoice_source_allocations WHERE source_id = 9001",
        );
        await rollback.query(`SET ROLE "${migratorRole}"`);
        const preflight = await rollback.query(
          await readFile(
            path.resolve(
              "lib/db/rollbacks/preflight_0108_invoice_source_allocations.sql",
            ),
            "utf8",
          ),
        );
        assert.equal(
          preflight.rows.every((row) => Number(row.row_count) === 0),
          true,
        );
        await rollback.query(
          await readFile(
            path.resolve(
              "lib/db/rollbacks/0108_invoice_source_allocations_and_advances.down.sql",
            ),
            "utf8",
          ),
        );
      } finally {
        await rollback.end();
      }
      assert.equal(
        (await database.readInventoryReadOnly()).knownAppliedMigrations,
        107,
      );
      clock += 60_000;
      await runForward(executable, artifacts, clock, "b");
      assert.equal(
        (await database.readInventoryReadOnly()).knownAppliedMigrations,
        108,
      );
    } finally {
      await pool.end();
      const cleanup = new Client({ connectionString: base.href });
      await cleanup.connect();
      try {
        await cleanup.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await cleanup.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
        await cleanup.query(`DROP ROLE IF EXISTS "${migratorRole}"`);
      } finally {
        await cleanup.end();
      }
    }
  },
);
