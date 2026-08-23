import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  createProductionMigrationArtifact,
} from "../production-evidence/production-migration-contract.mjs";
import {
  PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA,
  PRODUCTION_INVOICE_0108_CONFIRMATION,
  PRODUCTION_INVOICE_0108_MIGRATION,
  PRODUCTION_INVOICE_0108_POST_STATE,
  PRODUCTION_INVOICE_0108_PRE_STATE,
  PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
  PRODUCTION_INVOICE_0108_ROLE_RECEIPT_SCHEMA,
  canonicalProductionInvoice0108Sql,
  createProductionInvoice0108Plan,
  validateProductionInvoice0108Inventory,
} from "../production-evidence/production-invoice-0108-contract.mjs";
import { createProductionInvoice0108Executable } from "../production-evidence/production-invoice-0108-runner.mjs";
import { classifyProductionInvoice0108Recovery } from "../production-evidence/production-invoice-0108-verifier.mjs";

const SOURCE_SHA = "6cbf2aa5edd223f4e971e3e423eefc2056a05e36";
const APPROVED_AT = "2026-08-22T10:30:00.000Z";
const SQL_PATH = new URL(
  "../../lib/db/migrations/0108_invoice_source_allocations_and_advances.sql",
  import.meta.url,
);

function inventory(phase) {
  const state =
    phase === "pre"
      ? PRODUCTION_INVOICE_0108_PRE_STATE
      : PRODUCTION_INVOICE_0108_POST_STATE;
  return {
    knownAppliedMigrations: state.knownAppliedMigrations,
    knownAppliedRowsSha256: state.knownAppliedRowsSha256,
    latestKnownAppliedTag: state.latestKnownAppliedTag,
    missingKnownMigrationTags: [...state.missingKnownMigrationTags],
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: structuredClone(PRODUCTION_OPAQUE_LEGACY_ROWS),
    excludedMigration0100Present: false,
    totalJournalRows: state.totalJournalRows,
  };
}

function backupReference({
  backupCompletedAt = "2026-08-22T09:55:00.000Z",
  restoreVerifiedAt = "2026-08-22T10:00:00.000Z",
} = {}) {
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA,
    kind: "site-logbook-production-exact-0107-backup-restore-reference",
    receiptStorageId: "private-exact-0107/backup-restore-receipt.json",
    receiptSha256: `sha256:${"b".repeat(64)}`,
    sourceSha: SOURCE_SHA,
    sourceInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    backupCompletedAt,
    restoreVerifiedAt,
    decision: "PASS",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
}

function memoryStore({
  failMigrationReceipt = false,
  failRoleReceipt = false,
} = {}) {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    async persistExclusive(id, canonical) {
      if (
        (failMigrationReceipt && id.startsWith("invoice-0108-receipt-")) ||
        (failRoleReceipt && id.startsWith("invoice-0108-role-"))
      )
        throw Object.assign(new Error("synthetic persistence failure"), {
          code: "EIO",
        });
      if (values.has(id))
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      values.set(id, canonical);
      writes.push(id);
    },
    async readCanonical(id) {
      if (!values.has(id))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return values.get(id);
    },
    async readOptionalCanonical(id) {
      return values.get(id) ?? null;
    },
  };
}

function fakeDatabase({ unknownCommit = false } = {}) {
  let phase = "pre";
  let lockedReads = 0;
  const queries = [];
  const releases = [];
  const client = {
    async query(text, parameters) {
      queries.push({ text, parameters });
      if (text === "COMMIT") {
        phase = "post";
        if (unknownCommit)
          throw new Error("synthetic connection loss during COMMIT");
      }
      return { rows: [] };
    },
    release(destroy) {
      releases.push(Boolean(destroy));
    },
  };
  return {
    queries,
    releases,
    get phase() {
      return phase;
    },
    async connect() {
      return client;
    },
    async readInventoryReadOnly() {
      return inventory(phase);
    },
    async readInventoryInTransaction() {
      const result = inventory(lockedReads === 0 ? "pre" : "post");
      lockedReads += 1;
      return result;
    },
    async assertMigrationAuthorityInTransaction(_client, binding) {
      assert.equal(binding.sourceSha, SOURCE_SHA);
      assert.deepEqual(binding.migration, PRODUCTION_INVOICE_0108_MIGRATION);
    },
  };
}

function authorities() {
  const calls = { backup: 0, roleContract: 0, roleApply: 0 };
  return {
    calls,
    backupAuthority: {
      async assertFreshExact0107BackupRestoreReceipt(input) {
        calls.backup += 1;
        assert.equal(
          input.expectedInventorySha256,
          PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
        );
      },
    },
    roleAuthority: {
      async assertExact0108Contract(input) {
        calls.roleContract += 1;
        assert.deepEqual(input, {
          migration: PRODUCTION_INVOICE_0108_MIGRATION.tag,
          migrationSha256: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
          requiredPreState: "exact-0107-plus-0108-default-dark",
        });
      },
      async applyExact0108Delta({ migrationReceiptCanonical, confirmation }) {
        calls.roleApply += 1;
        assert.equal(confirmation, PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION);
        const migrationReceipt = createProductionMigrationArtifact(
          JSON.parse(migrationReceiptCanonical),
        );
        return createProductionMigrationArtifact({
          schemaVersion: PRODUCTION_INVOICE_0108_ROLE_RECEIPT_SCHEMA,
          kind: "site-logbook-production-invoice-0108-role-delta-receipt",
          decision: "PASS",
          migration: PRODUCTION_INVOICE_0108_MIGRATION.tag,
          migrationSha256: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
          migrationReceiptSha256: migrationReceipt.sha256,
          base0107PlanSha256: `sha256:${"1".repeat(64)}`,
          deltaPlanSha256: `sha256:${"2".repeat(64)}`,
          preProjectionSha256: `sha256:${"3".repeat(64)}`,
          postProjectionSha256: `sha256:${"4".repeat(64)}`,
          authoritySourceSha256: `sha256:${"5".repeat(64)}`,
          transactionCommitted: true,
          completedAt: "2026-08-22T10:32:00.000Z",
          productionTargetsTouched: true,
          authorizesApplicationStart: false,
        }).canonical;
      },
    },
  };
}

function fixtureExecutable(options = {}) {
  const database = options.database ?? fakeDatabase();
  const artifacts = options.artifacts ?? memoryStore();
  const authority = options.authority ?? authorities();
  let clock = Date.parse("2026-08-22T10:31:00.000Z");
  const executable = createProductionInvoice0108Executable({
    sourceSha: SOURCE_SHA,
    readMigrationSql: () => readFile(SQL_PATH, "utf8"),
    database,
    artifacts,
    backupAuthority: authority.backupAuthority,
    roleAuthority: authority.roleAuthority,
    now: () => new Date(clock++),
  });
  return { executable, database, artifacts, authority };
}

async function prepare(executable) {
  return executable.prepare({
    intentId: "a".repeat(64),
    operator: "production-owner",
    approvedAt: APPROVED_AT,
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
    backupRestoreReferenceCanonical: backupReference().canonical,
  });
}

test("0108 catalog pins canonical-LF SQL, journal identity, snapshots and exact opaque-row states", async () => {
  const raw = await readFile(SQL_PATH, "utf8");
  assert.equal(canonicalProductionInvoice0108Sql(raw).includes("\r"), false);
  assert.throws(() => canonicalProductionInvoice0108Sql(`${raw}\nSELECT 1;`), {
    code: "PRODUCTION_INVOICE_0108_SQL_DRIFT",
  });
  assert.equal(
    validateProductionInvoice0108Inventory(inventory("pre"), "pre").phase,
    "pre",
  );
  assert.equal(
    validateProductionInvoice0108Inventory(inventory("post"), "post").phase,
    "post",
  );
  const drift = inventory("pre");
  drift.opaqueLegacyRows[0].hash = "0".repeat(64);
  assert.throws(() => validateProductionInvoice0108Inventory(drift, "pre"), {
    code: "PRODUCTION_MIGRATION_OPAQUE_DRIFT",
  });
});

test("fresh exact-0107 backup reference is source-bound and stale references fail before any durable intent", async () => {
  const { executable, artifacts } = fixtureExecutable();
  await assert.rejects(
    executable.prepare({
      intentId: "a".repeat(64),
      operator: "production-owner",
      approvedAt: APPROVED_AT,
      confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
      backupRestoreReferenceCanonical: backupReference({
        backupCompletedAt: "2026-08-22T08:00:00.000Z",
        restoreVerifiedAt: "2026-08-22T08:05:00.000Z",
      }).canonical,
    }),
    { code: "PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_STALE" },
  );
  assert.equal(artifacts.writes.length, 0);

  const wrongSource = JSON.parse(backupReference().canonical);
  wrongSource.sourceSha = "f".repeat(40);
  const wrongSourceCanonical =
    createProductionMigrationArtifact(wrongSource).canonical;
  assert.throws(
    () =>
      createProductionInvoice0108Plan({
        sourceSha: SOURCE_SHA,
        backupRestoreReferenceCanonical: wrongSourceCanonical,
        createdAt: APPROVED_AT,
      }),
    { code: "PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_INVALID" },
  );
});

test("runner persists intent first, applies only 0108 in one advisory-locked transaction, then performs the separate role delta", async () => {
  const { executable, database, artifacts, authority } = fixtureExecutable();
  const durable = await prepare(executable);
  assert.deepEqual(artifacts.writes.slice(0, 2), [
    durable.planStorageId,
    durable.intentStorageId,
  ]);
  const ready = await executable.inspect({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
  });
  assert.equal(ready.decision, "READY_EXACT_0107_RECEIPT_ABSENT");
  assert.equal(authority.calls.roleApply, 0);

  const applied = await executable.apply({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
  });
  assert.equal(applied.decision, "MIGRATION_COMMITTED_RECEIPT_DURABLE");
  assert.equal(database.phase, "post");
  assert.equal(
    database.queries.filter(({ text }) => text === "BEGIN").length,
    1,
  );
  assert.equal(
    database.queries.filter(({ text }) => text === "COMMIT").length,
    1,
  );
  assert.equal(
    database.queries.filter(({ text }) =>
      text.startsWith("SELECT pg_advisory_xact_lock"),
    ).length,
    1,
  );
  const journalWrites = database.queries.filter(({ text }) =>
    text.startsWith("INSERT INTO drizzle.__drizzle_migrations"),
  );
  assert.equal(journalWrites.length, 1);
  assert.deepEqual(journalWrites[0].parameters, [
    PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
    PRODUCTION_INVOICE_0108_MIGRATION.when,
  ]);
  assert.equal(
    database.queries.some(({ text }) => /009[7-9]|010[1-7]/.test(text)),
    false,
  );
  assert.equal(authority.calls.roleApply, 0);

  const role = await executable.applyRoleDelta({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
    migrationReceiptStorageId: applied.receiptStorageId,
    confirmation: PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
  });
  assert.equal(role.decision, "ROLE_DELTA_COMMITTED_RECEIPT_DURABLE");
  assert.equal(authority.calls.roleContract, 1);
  assert.equal(authority.calls.roleApply, 1);
  const complete = await executable.inspect({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
    migrationReceiptStorageId: applied.receiptStorageId,
    roleReceiptStorageId: role.roleReceiptStorageId,
  });
  assert.equal(complete.decision, "EXACT_0108_AND_ROLE_DELTA_RECEIPT_BACKED");
  assert.equal(complete.complete, true);
  assert.equal(complete.authorizesApplicationStart, false);
});

test("ambiguous COMMIT is terminal RESTORE_REQUIRED and destroys the connection without a retry receipt", async () => {
  const database = fakeDatabase({ unknownCommit: true });
  const artifacts = memoryStore();
  const { executable } = fixtureExecutable({ database, artifacts });
  const durable = await prepare(executable);
  await assert.rejects(
    executable.apply({
      planStorageId: durable.planStorageId,
      intentStorageId: durable.intentStorageId,
      confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
    }),
    (error) =>
      error.code === "RESTORE_REQUIRED_COMMIT_OUTCOME_UNKNOWN" &&
      error.restoreRequired === true,
  );
  assert.deepEqual(database.releases, [true]);
  assert.equal(
    [...artifacts.values.keys()].some((id) =>
      id.startsWith("invoice-0108-receipt-"),
    ),
    false,
  );
});

test("post-commit no-clobber receipt custody failure is RESTORE_REQUIRED_UNKNOWN_COMMIT", async () => {
  const artifacts = memoryStore({ failMigrationReceipt: true });
  const { executable } = fixtureExecutable({ artifacts });
  const durable = await prepare(executable);
  await assert.rejects(
    executable.apply({
      planStorageId: durable.planStorageId,
      intentStorageId: durable.intentStorageId,
      confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
    }),
    (error) =>
      error.code === "RESTORE_REQUIRED_UNKNOWN_COMMIT" &&
      error.restoreRequired === true,
  );
});

test("verifier refuses post-state without receipt and a durable receipt with pre-state", async () => {
  const { executable, artifacts } = fixtureExecutable();
  const durable = await prepare(executable);
  const planCanonical = await artifacts.readCanonical(durable.planStorageId);
  const intentCanonical = await artifacts.readCanonical(
    durable.intentStorageId,
  );
  assert.throws(
    () =>
      classifyProductionInvoice0108Recovery({
        planCanonical,
        intentCanonical,
        inventory: inventory("post"),
      }),
    (error) => error.code === "RESTORE_REQUIRED_UNKNOWN_COMMIT",
  );

  const applied = await executable.apply({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
  });
  const migrationReceiptCanonical = await artifacts.readCanonical(
    applied.receiptStorageId,
  );
  assert.throws(
    () =>
      classifyProductionInvoice0108Recovery({
        planCanonical,
        intentCanonical,
        migrationReceiptCanonical,
        inventory: inventory("pre"),
      }),
    (error) => error.code === "RESTORE_REQUIRED_RECEIPT_STATE_MISMATCH",
  );
});

test("role delta cannot run before a durable migration receipt and role receipt custody fails closed", async () => {
  const artifacts = memoryStore({ failRoleReceipt: true });
  const { executable, authority } = fixtureExecutable({ artifacts });
  const durable = await prepare(executable);
  await assert.rejects(
    executable.applyRoleDelta({
      planStorageId: durable.planStorageId,
      intentStorageId: durable.intentStorageId,
      migrationReceiptStorageId: "invoice-0108-receipt-missing.json",
      confirmation: PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
    }),
    { code: "ENOENT" },
  );
  assert.equal(authority.calls.roleApply, 0);

  const applied = await executable.apply({
    planStorageId: durable.planStorageId,
    intentStorageId: durable.intentStorageId,
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
  });
  await assert.rejects(
    executable.applyRoleDelta({
      planStorageId: durable.planStorageId,
      intentStorageId: durable.intentStorageId,
      migrationReceiptStorageId: applied.receiptStorageId,
      confirmation: PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
    }),
    (error) =>
      error.code === "RESTORE_REQUIRED_ROLE_RECEIPT_CUSTODY" &&
      error.restoreRequired === true,
  );
});
