import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID,
  PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256,
} from "../../lib/db/src/production-migration-role-0108-authority.ts";
import {
  PRODUCTION_INVOICE_0108_RUNNER_DESCRIPTOR_SCHEMA,
  executeProductionInvoice0108Cli,
} from "../production-evidence/run-production-invoice-0108.mjs";
import { canonicalProductionMigrationJson } from "../production-evidence/production-migration-contract.mjs";

const SOURCE_SHA = "1".repeat(40);

function descriptor() {
  return {
    schemaVersion: PRODUCTION_INVOICE_0108_RUNNER_DESCRIPTOR_SCHEMA,
    kind: "site-logbook-production-invoice-0108-runner",
    executionDefault: "disabled",
    sourceSha: SOURCE_SHA,
    migrationsDirectory: "migrations",
    artifactDirectory: "artifacts",
    backupReceiptDirectory: "backup",
    backupRestoreReferenceFile: "backup/reference.json",
    connection: {
      environmentVariable: "PRODUCTION_INVOICE_0108_DATABASE_URL",
      databaseName: "site_logbook",
      sessionUser: "site_logbook_migration_session",
      migratorRole: "site_logbook_migrator",
      runtimeRole: "site_logbook_runtime",
    },
    authorities: {
      role0108: {
        id: PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID,
        sourceSha256: PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256,
      },
    },
    authorizesApplicationStart: false,
  };
}

test("fails closed on BUILD_SHA drift before opening PostgreSQL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "invoice-0108-cli-test-"));
  const descriptorFile = path.join(root, "descriptor.json");
  let poolCalls = 0;
  try {
    await writeFile(
      descriptorFile,
      canonicalProductionMigrationJson(descriptor()),
      { flag: "wx", mode: 0o600 },
    );
    await assert.rejects(
      executeProductionInvoice0108Cli(
        [
          "inspect",
          "--descriptor",
          descriptorFile,
          "--plan-storage-id",
          "invoice-0108-plan-a.json",
          "--intent-storage-id",
          "invoice-0108-intent-a.json",
          "--migration-receipt-storage-id",
          "none",
          "--role-receipt-storage-id",
          "none",
        ],
        {
          environment: { BUILD_SHA: "2".repeat(40) },
          createPool() {
            poolCalls += 1;
          },
        },
      ),
      {
        code: "PRODUCTION_INVOICE_0108_CLI_SOURCE_MISMATCH",
      },
    );
    assert.equal(poolCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects prepare without the exact attended confirmation before filesystem or DB access", async () => {
  await assert.rejects(
    executeProductionInvoice0108Cli([
      "prepare",
      "--descriptor",
      "missing.json",
      "--intent-id",
      "3".repeat(64),
      "--operator",
      "modvolt-release-owner",
      "--approved-at",
      "2026-08-23T12:00:00.000Z",
      "--confirmation",
      "NO",
    ]),
    { code: "PRODUCTION_INVOICE_0108_CLI_CONFIRMATION_REQUIRED" },
  );
});

test("production CLI is source-pinned, default-dark and does not accept connection secrets in argv", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      path.resolve(
        "scripts/production-evidence/run-production-invoice-0108.mjs",
      ),
      "utf8",
    ),
  );
  assert.match(source, /executionDefault/);
  assert.match(source, /BUILD_SHA/);
  assert.match(source, /createProductionInvoice0108BackupAuthority/);
  assert.match(source, /createProductionMigrationRole0108Authority/);
  assert.doesNotMatch(source, /--database-url|--password|--secret/);
});
