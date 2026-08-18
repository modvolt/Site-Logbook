import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Client, Pool } from "pg";

import {
  PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION,
  normalizeProductionMigrationRoleBootstrapProjection,
  runProductionMigrationRoleBootstrap,
} from "../production-evidence/production-migration-role-bootstrap.js";
import {
  PRODUCTION_ROLE_PROJECTION_SQL,
  REQUIRED_SEQUENCE_GRANTS,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  validateProductionRoleProjection,
} from "../../lib/db/src/production-role-separation-contract.js";
import { parseProductionMigrationRolePrecondition } from "../../lib/db/src/production-migration-role-authority.js";
import {
  exactProductionOpaqueRowsForAdapterTests,
  loadProductionMigrationCatalog,
} from "../production-evidence/production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_SCHEMA,
  applyProductionMigrationRoleCeremony,
} from "../production-evidence/production-migration-role-authority.js";

const connectionUrl = process.env.PRODUCTION_ROLE_BOOTSTRAP_PG16_URL;
const migrationsDirectory = path.resolve("lib/db/migrations");

test(
  "PostgreSQL 16 bootstraps exact 0096 roles and completes the post-0107 role ceremony",
  { skip: !connectionUrl, timeout: 180_000 },
  async () => {
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory,
    });
    const bootstrapClient = new Client({ connectionString: connectionUrl });
    await bootstrapClient.connect();
    try {
      const identity = await bootstrapClient.query(
        "SELECT current_database() AS name, session_user, current_user",
      );
      assert.equal(identity.rows[0].name, "admin");
      assert.equal(identity.rows[0].session_user, "admin");
      assert.equal(identity.rows[0].current_user, "admin");
      await bootstrapClient.query("CREATE SCHEMA drizzle");
      await bootstrapClient.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint NOT NULL
      )`);
      for (const entry of catalog.expected.slice(0, 97)) {
        const sql = await readFile(
          path.join(migrationsDirectory, `${entry.tag}.sql`),
          "utf8",
        );
        await bootstrapClient.query(
          sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        );
        await bootstrapClient.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [entry.hash, entry.when],
        );
      }
      for (const opaque of exactProductionOpaqueRowsForAdapterTests()) {
        await bootstrapClient.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [opaque.hash, opaque.createdAt],
        );
      }
    } finally {
      await bootstrapClient.end();
    }

    const pool = new Pool({ connectionString: connectionUrl, max: 1 });
    const controller = new AbortController();
    try {
      const result = await runProductionMigrationRoleBootstrap({
        sourceSha: "6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5",
        databaseName: "admin",
        sessionUser: "admin",
        migrationRole: "site_logbook_migrator",
        runtimeRole: "site_logbook_runtime",
        approvalId: "role-bootstrap-pg16-test",
        confirmation: PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION,
        advisoryLockKey: 1_070_107,
        connect: () => pool.connect(),
        signal: controller.signal,
        now: () => new Date(),
      });
      const parsed = parseProductionMigrationRolePrecondition(
        result.preconditionCanonical,
        {
          sourceSha: "6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5",
          database: {
            name: "admin",
            sessionUser: "admin",
            currentUser: "site_logbook_migrator",
          },
        },
      );
      assert.equal(parsed.value.runtimeRole, "site_logbook_runtime");
      assert.equal(parsed.value.migrationRole, "site_logbook_migrator");
      const journal = await pool.query(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
      );
      assert.equal(journal.rows[0].count, 99);
      const roleRows = await pool.query(
        'SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = ANY($1::name[]) ORDER BY rolname COLLATE "C"',
        [["site_logbook_migrator", "site_logbook_runtime"]],
      );
      assert.deepEqual(roleRows.rows, [
        {
          rolname: "site_logbook_migrator",
          rolcanlogin: false,
          rolsuper: false,
        },
        {
          rolname: "site_logbook_runtime",
          rolcanlogin: true,
          rolsuper: false,
        },
      ]);
      const plan = buildProductionRolePlan({
        databaseName: "admin",
        runtimeRole: "site_logbook_runtime",
        migratorRole: "site_logbook_migrator",
      });
      const raw = await pool.query(PRODUCTION_ROLE_PROJECTION_SQL, [
        plan.databaseName,
        plan.runtimeRole,
        plan.migratorRole,
      ]);
      const projection = normalizeProductionMigrationRoleBootstrapProjection(
        raw.rows[0].projection,
        plan,
      );
      const validation = validateProductionRoleProjection(projection);
      assert.equal(validation.ok, false);
      assert.deepEqual(
        [...new Set(validation.errors.map((error) => error.code))].sort(),
        ["OBJECT_CARDINALITY_MISMATCH", "REQUIRED_OBJECT_PROJECTION_MISSING"],
      );
      const delegated = await pool.connect();
      try {
        await delegated.query("BEGIN");
        await delegated.query('SET LOCAL ROLE "site_logbook_migrator"');
        const delegatedIdentity = await delegated.query(
          "SELECT session_user, current_user",
        );
        assert.equal(delegatedIdentity.rows[0].session_user, "admin");
        assert.equal(
          delegatedIdentity.rows[0].current_user,
          "site_logbook_migrator",
        );
        await delegated.query("ROLLBACK");
      } finally {
        delegated.release();
      }
      for (const entry of catalog.expected.slice(97)) {
        const migrationClient = await pool.connect();
        try {
          await migrationClient.query("BEGIN");
          await migrationClient.query('SET LOCAL ROLE "site_logbook_migrator"');
          const sql = await readFile(
            path.join(migrationsDirectory, `${entry.tag}.sql`),
            "utf8",
          );
          await migrationClient.query(
            sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
          );
          await migrationClient.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [entry.hash, entry.when],
          );
          await migrationClient.query("COMMIT");
        } catch (error) {
          await migrationClient.query("ROLLBACK");
          throw error;
        } finally {
          migrationClient.release();
        }
      }
      const liveSequences = await pool.query(String.raw`
        SELECT namespace.nspname || '.' || relation.relname AS name
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'drizzle')
          AND relation.relkind = 'S'
        ORDER BY (namespace.nspname || '.' || relation.relname) COLLATE "C"`);
      assert.deepEqual(
        liveSequences.rows.map((row) => row.name),
        REQUIRED_SEQUENCE_GRANTS.map(
          (entry) => `${entry.schema}.${entry.name}`,
        ).sort(),
      );
      const migrationPlanCanonical = canonicalProductionRoleJson({
        sourceSha: "6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5",
        database: {
          name: "admin",
          sessionUser: "admin",
          currentUser: "site_logbook_migrator",
        },
        rolePreconditionCanonical: result.preconditionCanonical,
        rolePreconditionSha256: result.preconditionSha256,
      });
      const activationCanonical = canonicalProductionRoleJson({
        schemaVersion: PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_SCHEMA,
        kind: "site-logbook-production-migration-role-ceremony-activation",
        enabled: true,
        expectedPlanSha256: parsed.value.rolePlanSha256,
        approvalId: "role-ceremony-pg16-test",
        preProjectionCanonical: parsed.value.preProjectionCanonical,
        expectedPreProjectionSha256: parsed.preProjectionSha256,
        authorizesApplicationStart: false,
      });
      const ceremony = await applyProductionMigrationRoleCeremony({
        planCanonical: migrationPlanCanonical,
        activationCanonical,
        advisoryLockKey: 1_070_107,
        connect: () => pool.connect(),
        signal: controller.signal,
        now: () => new Date(),
      });
      assert.equal(ceremony.authorizesApplicationStart, false);
      const finalJournal = await pool.query(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
      );
      assert.equal(finalJournal.rows[0].count, 109);
      const finalRaw = await pool.query(PRODUCTION_ROLE_PROJECTION_SQL, [
        plan.databaseName,
        plan.runtimeRole,
        plan.migratorRole,
      ]);
      const finalProjection =
        normalizeProductionMigrationRoleBootstrapProjection(
          finalRaw.rows[0].projection,
          plan,
        );
      assert.deepEqual(validateProductionRoleProjection(finalProjection), {
        ok: true,
        errors: [],
      });
    } finally {
      await pool.end();
    }
  },
);
