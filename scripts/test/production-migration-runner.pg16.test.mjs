import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createPgProductionMigrationDatabase,
  createProductionMigrationRoleBinding,
  createProductionMigrationRuntimeObservation,
  exactProductionOpaqueRowsForAdapterTests,
  loadProductionMigrationCatalog,
} from "../production-evidence/production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  PRODUCTION_MIGRATION_STEPS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
} from "../production-evidence/production-migration-contract.mjs";
import {
  PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
  PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
  PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
  createProductionMigrationExecutable,
} from "../production-evidence/production-migration-runner.mjs";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { fixturePlanInput } from "./production-migration-control-plane-fixtures.mjs";

const requireFromDb = createRequire(
  new URL("../../lib/db/package.json", import.meta.url),
);
const { Client, Pool } = requireFromDb("pg");
const connectionUrl = process.env.PRODUCTION_MIGRATION_RUNNER_PG16_URL;
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
      const canonical = values.get(storageId);
      if (canonical === undefined) throw new Error("artifact missing");
      return canonical;
    },
  };
}

function postCommitRoleEvidence(planCanonical) {
  const plan = JSON.parse(planCanonical);
  const role = JSON.parse(plan.rolePreconditionCanonical);
  const projection = JSON.parse(role.preProjectionCanonical);
  const projectionSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(projection))
    .digest("hex");
  const body = {
    schemaVersion: "site-logbook.production-db-role-separation-receipt/v1",
    planSha256: role.rolePlanSha256,
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    executorId: "pg16-independent-role-executor",
    approvalId: "pg16-role-approval",
    executedAt: "2026-08-12T12:10:00.000Z",
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
    verifierId: "pg16-independent-role-verifier",
    observedAt: "2026-08-12T12:11:00.000Z",
    authorizesDeployment: false,
  });
  return { receipt, postCommit };
}

test(
  "opt-in PostgreSQL 16 wiring runs the attended runner over a disposable baseline",
  { skip: !connectionUrl, timeout: 180_000 },
  async () => {
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory,
    });
    const admin = new Client({ connectionString: connectionUrl });
    await admin.connect();
    try {
      const version = await admin.query("SHOW server_version_num");
      assert.equal(
        Math.floor(Number(version.rows[0].server_version_num) / 10000),
        16,
      );
      await admin.query("CREATE ROLE site_logbook_backup NOLOGIN");
      await admin.query("CREATE ROLE site_logbook_runtime LOGIN");
      await admin.query(
        "CREATE ROLE site_logbook_executor LOGIN PASSWORD 'site-logbook-runner-ci-only'",
      );
      await admin.query("GRANT site_logbook_backup TO site_logbook_executor");
      await admin.query(
        'CREATE DATABASE "site_logbook" OWNER site_logbook_backup',
      );
    } finally {
      await admin.end();
    }

    const executorUrl = new URL(connectionUrl);
    executorUrl.username = "site_logbook_executor";
    executorUrl.password = "site-logbook-runner-ci-only";
    executorUrl.pathname = "/site_logbook";
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

    const planInput = fixturePlanInput();
    const rolePrecondition = JSON.parse(planInput.rolePreconditionCanonical);
    const roleBinding = createProductionMigrationRoleBinding({
      databaseName: "site_logbook",
      sessionUser: "site_logbook_executor",
      migrationRole: "site_logbook_backup",
      runtimeRole: rolePrecondition.runtimeRole,
    });
    const runtimeBinding = JSON.parse(
      planInput.backupPlanCanonical,
    ).runtimeBinding;
    const pool = new Pool({ connectionString: executorUrl.toString(), max: 2 });
    let databaseClock = Date.parse("2026-08-12T11:01:00.000Z");
    const database = createPgProductionMigrationDatabase({
      connect: () => pool.connect(),
      catalog,
      roleBindingCanonical: roleBinding.canonical,
      expectedRuntimeBindingCanonical:
        canonicalProductionExact0096BackupJson(runtimeBinding),
      observeLiveRuntime: async () =>
        createProductionMigrationRuntimeObservation({
          runtimeBinding,
          observedAt: new Date(databaseClock++).toISOString(),
        }).canonical,
      now: () => new Date(databaseClock++),
      createRunId: () => "f".repeat(64),
    });
    const artifacts = memoryArtifactStore();
    let runnerClock = Date.parse("2026-08-12T11:00:30.000Z");
    let postRole;
    const executable = createProductionMigrationExecutable({
      planInput,
      roleBindingCanonical: roleBinding.canonical,
      intentId: "d".repeat(64),
      database,
      artifacts,
      backupAuthority: {
        assertInputSignature() {},
        assertPlanSignature() {},
      },
      roleAuthority: {
        assertPrecondition() {},
        async readPostCommitEvidence() {
          return {
            roleTransactionReceiptCanonical: postRole.receipt.canonical,
            postCommitRoleArtifactCanonical: postRole.postCommit.canonical,
          };
        },
        assertPostCommit() {},
      },
      now: () => new Date(runnerClock++),
    });
    try {
      await executable.prepare({
        operator: "pg16-attended-runner",
        approvedAt: "2026-08-12T11:00:00.000Z",
        intentConfirmation: PRODUCTION_MIGRATION_CONFIRMATION,
        activationConfirmation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
      });
      const planStorageId = [...artifacts.values.keys()].find((id) =>
        id.startsWith("plan-"),
      );
      postRole = postCommitRoleEvidence(artifacts.values.get(planStorageId));
      for (
        let index = 0;
        index < PRODUCTION_MIGRATION_STEPS.length;
        index += 1
      ) {
        const inspection = await executable.inspect({
          receiptCount: index,
          confirmation: PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
        });
        assert.equal(inspection.liveStateIndex, index);
        const resume = await executable.resume({
          receiptCount: index,
          operator: "pg16-attended-runner",
          approvedAt: "2026-08-12T12:00:00.000Z",
          confirmation: PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
        });
        await executable.apply({
          receiptCount: index,
          resumeStorageId: resume.storageId,
          confirmation: PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
        });
      }
      runnerClock = Date.parse("2026-08-12T12:20:00.000Z");
      const chain = await executable.finalize({
        receiptCount: 10,
        confirmation: PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
      });
      assert.equal(
        JSON.parse(artifacts.values.get(chain.storageId)).final
          .totalJournalRows,
        109,
      );
      assert.equal(chain.authorizesApplicationStart, false);
    } finally {
      await pool.end();
    }
  },
);
