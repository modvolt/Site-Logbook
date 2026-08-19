import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createPgProductionMigrationDatabase,
  createProductionMigrationAdapter,
  createProductionMigrationAdapterActivation,
  createProductionMigrationRoleBinding,
  createProductionMigrationRuntimeObservation,
  exactProductionOpaqueRowsForAdapterTests,
  loadProductionMigrationCatalog,
} from "../production-evidence/production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_STEPS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
} from "../production-evidence/production-migration-contract.mjs";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import {
  createProductionMigrationIntent,
  createProductionMigrationPlan,
} from "../production-evidence/production-migration-planner.mjs";
import { createProductionMigrationResumeCommand } from "../production-evidence/production-migration-verifier.mjs";
import {
  fixtureIntentInput,
  fixturePlanInput,
} from "./production-migration-control-plane-fixtures.mjs";

const requireFromDb = createRequire(
  new URL("../../lib/db/package.json", import.meta.url),
);
const { Client, Pool } = requireFromDb("pg");
const connectionUrl = process.env.PRODUCTION_MIGRATION_PG16_URL;
const migrationsDirectory = path.resolve("lib/db/migrations");

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
  };
}

function roleEvidence(plan) {
  const role = JSON.parse(plan.value.rolePreconditionCanonical);
  const projection = JSON.parse(role.preProjectionCanonical);
  const projectionSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(projection))
    .digest("hex");
  const body = {
    schemaVersion: "site-logbook.production-db-role-separation-receipt/v1",
    planSha256: role.rolePlanSha256,
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    executorId: "pg16-role-executor",
    approvalId: "pg16-role-approval",
    executedAt: "2026-08-12T11:11:10.000Z",
    statementCount: 1,
    postProjectionSha256: projectionSha256,
    postValidation: "passed",
    authorizesDeployment: false,
    postCommitVerification: "unavailable",
    postCommitVerifierArtifact: null,
  };
  const receipt = createProductionMigrationArtifact({
    ...body,
    receiptSha256: createHash("sha256")
      .update(canonicalProductionMigrationJson(body))
      .digest("hex"),
  });
  const postCommit = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-db-role-separation-postcommit/v1",
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: role.rolePlanSha256,
    transactionReceiptSha256: receipt.value.receiptSha256,
    projection,
    projectionSha256,
    verifierId: "pg16-role-verifier",
    observedAt: "2026-08-12T11:11:30.000Z",
    authorizesDeployment: false,
  });
  return { receipt, postCommit };
}

test(
  "disposable PostgreSQL 16 applies exact 97+2 through 107+2 and emits final chain",
  { skip: !connectionUrl, timeout: 120_000 },
  async () => {
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory,
    });
    const admin = new Client({ connectionString: connectionUrl });
    await admin.connect();
    const databaseName = "site_logbook";
    try {
      const version = await admin.query("SHOW server_version_num");
      assert.equal(
        Math.floor(Number(version.rows[0].server_version_num) / 10000),
        16,
      );
      await admin.query("CREATE ROLE site_logbook_backup NOLOGIN");
      await admin.query("CREATE ROLE site_logbook_runtime LOGIN");
      await admin.query("CREATE ROLE site_logbook_executor LOGIN");
      await admin.query("GRANT site_logbook_backup TO site_logbook_executor");
      await admin.query(
        `CREATE DATABASE "${databaseName}" OWNER site_logbook_backup`,
      );
    } finally {
      await admin.end();
    }

    const executorUrl = new URL(connectionUrl);
    executorUrl.username = "site_logbook_executor";
    executorUrl.pathname = `/${databaseName}`;
    const bootstrap = new Client({ connectionString: executorUrl.toString() });
    await bootstrap.connect();
    try {
      await bootstrap.query('SET ROLE "site_logbook_backup"');
      await bootstrap.query("CREATE SCHEMA drizzle");
      await bootstrap.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint NOT NULL
      )`);
      for (const entry of catalog.expected.slice(0, 97)) {
        const sql = await readFile(
          path.join(migrationsDirectory, `${entry.tag}.sql`),
          "utf8",
        );
        await bootstrap.query(sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        await bootstrap.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [entry.hash, entry.when],
        );
      }
      for (const opaque of exactProductionOpaqueRowsForAdapterTests()) {
        await bootstrap.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [opaque.hash, opaque.createdAt],
        );
      }
    } finally {
      await bootstrap.end();
    }

    const input = fixturePlanInput();
    const plan = createProductionMigrationPlan(input);
    const intent = createProductionMigrationIntent(
      fixtureIntentInput(plan.canonical),
    );
    const roleBinding = createProductionMigrationRoleBinding({
      databaseName,
      sessionUser: "site_logbook_executor",
      migrationRole: "site_logbook_backup",
      runtimeRole: "site_logbook_runtime",
    });
    const activation = createProductionMigrationAdapterActivation({
      planCanonical: plan.canonical,
      roleBindingCanonical: roleBinding.canonical,
      approvedAt: "2026-08-12T10:00:10.000Z",
      operator: "pg16-integration",
      confirmation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
    });
    const runtimeBinding = JSON.parse(input.backupPlanCanonical).runtimeBinding;
    const pool = new Pool({ connectionString: executorUrl.toString(), max: 3 });
    let clock = Date.parse("2026-08-12T11:01:00.000Z");
    const database = createPgProductionMigrationDatabase({
      connect: () => pool.connect(),
      catalog,
      roleBindingCanonical: roleBinding.canonical,
      expectedRuntimeBindingCanonical:
        canonicalProductionExact0096BackupJson(runtimeBinding),
      observeLiveRuntime: async () =>
        createProductionMigrationRuntimeObservation({
          runtimeBinding,
          observedAt: new Date(clock++).toISOString(),
        }).canonical,
      now: () => new Date(clock++),
      createRunId: () => "a".repeat(64),
    });
    const artifacts = memoryArtifactStore();
    const postRole = roleEvidence(plan);
    let adapterNow = Date.parse("2026-08-12T11:00:30.000Z");
    const adapter = createProductionMigrationAdapter({
      database,
      artifacts,
      backupAuthority: { assertPlanSignature() {} },
      roleAuthority: {
        assertPrecondition() {},
        assertPostCommit({
          planCanonical,
          roleTransactionReceiptCanonical,
          postCommitRoleArtifactCanonical,
        }) {
          assert.equal(planCanonical, plan.canonical);
          assert.equal(
            roleTransactionReceiptCanonical,
            postRole.receipt.canonical,
          );
          assert.equal(
            postCommitRoleArtifactCanonical,
            postRole.postCommit.canonical,
          );
        },
        async readPostCommitEvidence() {
          return {
            roleTransactionReceiptCanonical: postRole.receipt.canonical,
            postCommitRoleArtifactCanonical: postRole.postCommit.canonical,
          };
        },
      },
      now: () => new Date(adapterNow),
    });
    try {
      const durable = await adapter.prepareDurableRun({
        activationCanonical: activation.canonical,
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
      });
      const receiptStorageIds = [];
      const receiptCanonicals = [];
      for (const _step of PRODUCTION_MIGRATION_STEPS) {
        const resume = createProductionMigrationResumeCommand({
          planCanonical: durable.planCanonical,
          intentCanonical: durable.intentCanonical,
          intentPersistenceReceiptCanonical:
            durable.intentPersistenceReceiptCanonical,
          receiptCanonicals,
          operator: "pg16-integration",
          approvedAt: "2026-08-12T11:10:00.000Z",
          confirmation:
            "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
        });
        const applied = await adapter.executeNext({
          activationCanonical: activation.canonical,
          durableRun: durable,
          receiptStorageIds,
          resumeCommandCanonical: resume.canonical,
        });
        receiptStorageIds.push(applied.receiptStorageId);
        receiptCanonicals.push(applied.receiptCanonical);
      }
      adapterNow = Date.parse("2026-08-12T11:12:00.000Z");
      const chain = await adapter.finalize({
        activationCanonical: activation.canonical,
        durableRun: durable,
        receiptStorageIds,
      });
      const value = JSON.parse(chain.canonical);
      assert.equal(value.final.knownAppliedMigrations, 107);
      assert.equal(value.final.totalJournalRows, 109);
      assert.equal(value.excludedMigration0100Present, false);
      assert.equal(value.authorizesApplicationStart, false);
    } finally {
      await pool.end();
    }
  },
);
