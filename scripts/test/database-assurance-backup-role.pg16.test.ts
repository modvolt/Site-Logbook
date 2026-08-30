import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

const connectionUrl = process.env.DATABASE_ASSURANCE_BACKUP_PG16_URL;
const disposableConfirmation =
  process.env.DATABASE_ASSURANCE_BACKUP_PG16_DISPOSABLE_CONFIRM;
const DISPOSABLE_CONFIRMATION =
  "I_CONFIRM_THIS_IS_A_DISPOSABLE_LOCAL_PG16_BACKUP_ROLE_FIXTURE";
const BACKUP_ROLE = "site_logbook_backup";
const MIGRATOR_ROLE = "site_logbook_migrator";
const RUNTIME_ROLE = "site_logbook_runtime";
const BACKUP_PASSWORD = "database-assurance-ci-only";

export function assertDatabaseAssuranceBackupPg16DisposableTarget(
  rawUrl: unknown,
  confirmation: unknown,
): string {
  if (
    typeof rawUrl !== "string" ||
    confirmation !== DISPOSABLE_CONFIRMATION
  ) {
    throw new Error("DATABASE_ASSURANCE_BACKUP_DISPOSABLE_CONFIRMATION_REQUIRED");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_ASSURANCE_BACKUP_DISPOSABLE_TARGET_INVALID");
  }

  const port = Number(parsed.port);
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 49_152 ||
    port > 65_535 ||
    parsed.username !== "admin" ||
    parsed.pathname !== "/admin" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("DATABASE_ASSURANCE_BACKUP_DISPOSABLE_TARGET_INVALID");
  }

  return rawUrl;
}

test("database assurance backup gate rejects non-disposable targets", () => {
  assert.throws(
    () =>
      assertDatabaseAssuranceBackupPg16DisposableTarget(
        "postgresql://admin:test@production-db:5432/admin",
        DISPOSABLE_CONFIRMATION,
      ),
    /DATABASE_ASSURANCE_BACKUP_DISPOSABLE_TARGET_INVALID/,
  );
  assert.throws(
    () =>
      assertDatabaseAssuranceBackupPg16DisposableTarget(
        "postgresql://admin:test@127.0.0.1:61494/admin?sslmode=require",
        DISPOSABLE_CONFIRMATION,
      ),
    /DATABASE_ASSURANCE_BACKUP_DISPOSABLE_TARGET_INVALID/,
  );
  assert.throws(
    () =>
      assertDatabaseAssuranceBackupPg16DisposableTarget(
        "postgresql://admin:test@127.0.0.1:61494/admin",
        "wrong",
      ),
    /DATABASE_ASSURANCE_BACKUP_DISPOSABLE_CONFIRMATION_REQUIRED/,
  );
});

test(
  "PostgreSQL 16 backup role is SELECT-only and receives migrator defaults",
  { skip: !connectionUrl, timeout: 180_000 },
  async () => {
    const exactConnectionUrl =
      assertDatabaseAssuranceBackupPg16DisposableTarget(
        connectionUrl,
        disposableConfirmation,
      );
    const admin = new Client({ connectionString: exactConnectionUrl });
    await admin.connect();

    const fixtureSuffix = `${process.pid}_${Date.now()}`;
    const fixtureName = `database_assurance_fixture_${fixtureSuffix}`;
    const qualifiedObjects = [
      `public.${fixtureName}_table`,
      `public.${fixtureName}_sequence`,
      `drizzle.${fixtureName}_table`,
      `drizzle.${fixtureName}_sequence`,
    ];

    try {
      const identity = await admin.query(
        "SELECT current_database() AS database, session_user, current_user, current_setting('server_version_num')::integer AS server_version_num",
      );
      assert.deepEqual(
        {
          database: identity.rows[0].database,
          sessionUser: identity.rows[0].session_user,
          currentUser: identity.rows[0].current_user,
          majorVersion: Math.floor(identity.rows[0].server_version_num / 10_000),
        },
        {
          database: "admin",
          sessionUser: "admin",
          currentUser: "admin",
          majorVersion: 16,
        },
      );

      const prerequisiteRoles = await admin.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::name[]) ORDER BY rolname COLLATE \"C\"",
        [[MIGRATOR_ROLE, RUNTIME_ROLE]],
      );
      assert.deepEqual(
        prerequisiteRoles.rows.map((row) => row.rolname),
        [MIGRATOR_ROLE, RUNTIME_ROLE],
      );

      const runtimeBefore = await admin.query(
        `SELECT to_jsonb(role_row) AS role
           FROM (
             SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                    rolcanlogin, rolreplication, rolbypassrls
               FROM pg_catalog.pg_roles
              WHERE rolname = $1
           ) AS role_row`,
        [RUNTIME_ROLE],
      );
      const runtimeMembershipsBefore = await admin.query(
        `SELECT role_role.rolname AS role_name, member_role.rolname AS member_name
           FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles role_role ON role_role.oid = membership.roleid
          JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
          WHERE role_role.rolname = $1 OR member_role.rolname = $1
          ORDER BY role_role.rolname COLLATE "C", member_role.rolname COLLATE "C"`,
        [RUNTIME_ROLE],
      );

      await admin.query(`CREATE ROLE ${BACKUP_ROLE}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD '${BACKUP_PASSWORD}'`);
      await admin.query(`GRANT CONNECT ON DATABASE admin TO ${BACKUP_ROLE}`);
      await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await admin.query(
        `GRANT USAGE ON SCHEMA public, drizzle TO ${BACKUP_ROLE}`,
      );
      await admin.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO ${BACKUP_ROLE}`,
      );
      await admin.query(
        `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO ${BACKUP_ROLE}`,
      );
      for (const schema of ["public", "drizzle"]) {
        await admin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA ${schema}
             GRANT SELECT ON TABLES TO ${BACKUP_ROLE}`,
        );
        await admin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA ${schema}
             GRANT SELECT ON SEQUENCES TO ${BACKUP_ROLE}`,
        );
      }

      const backupAttributes = await admin.query(
        `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls
           FROM pg_catalog.pg_roles
          WHERE rolname = $1`,
        [BACKUP_ROLE],
      );
      assert.deepEqual(backupAttributes.rows, [
        {
          rolcanlogin: true,
          rolinherit: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ]);

      const backupMemberships = await admin.query(
        `SELECT role_role.rolname AS role_name, member_role.rolname AS member_name
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles role_role ON role_role.oid = membership.roleid
           JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
          WHERE role_role.rolname = $1 OR member_role.rolname = $1`,
        [BACKUP_ROLE],
      );
      assert.deepEqual(backupMemberships.rows, []);

      const databaseAndSchemaPrivileges = await admin.query(
        `SELECT
           has_database_privilege($1, 'admin', 'CONNECT') AS database_connect,
           has_database_privilege($1, 'admin', 'CREATE') AS database_create,
           has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
           has_schema_privilege($1, 'public', 'CREATE') AS public_create,
           has_schema_privilege($1, 'drizzle', 'USAGE') AS drizzle_usage,
           has_schema_privilege($1, 'drizzle', 'CREATE') AS drizzle_create`,
        [BACKUP_ROLE],
      );
      assert.deepEqual(databaseAndSchemaPrivileges.rows, [
        {
          database_connect: true,
          database_create: false,
          public_usage: true,
          public_create: false,
          drizzle_usage: true,
          drizzle_create: false,
        },
      ]);

      const relationPrivileges = await admin.query(
        `SELECT namespace.nspname AS schema_name, relation.relname,
                has_table_privilege($1, relation.oid, 'SELECT') AS can_select,
                has_table_privilege($1, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('public', 'drizzle')
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"`,
        [BACKUP_ROLE],
      );
      assert.ok(relationPrivileges.rows.length > 0);
      assert.equal(
        relationPrivileges.rows.every((row) => row.can_select === true),
        true,
      );
      assert.equal(
        relationPrivileges.rows.every((row) => row.can_write === false),
        true,
      );

      const sequencePrivileges = await admin.query(
        `SELECT namespace.nspname AS schema_name, relation.relname,
                has_sequence_privilege($1, relation.oid, 'SELECT') AS can_select,
                has_sequence_privilege($1, relation.oid, 'USAGE,UPDATE') AS can_write
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('public', 'drizzle')
            AND relation.relkind = 'S'
          ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"`,
        [BACKUP_ROLE],
      );
      assert.ok(sequencePrivileges.rows.length > 0);
      assert.equal(
        sequencePrivileges.rows.every((row) => row.can_select === true),
        true,
      );
      assert.equal(
        sequencePrivileges.rows.every((row) => row.can_write === false),
        true,
      );

      const ownedObjects = await admin.query(
        `SELECT count(*)::integer AS count
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
          WHERE namespace.nspname IN ('public', 'drizzle')
            AND owner_role.rolname = $1`,
        [BACKUP_ROLE],
      );
      assert.equal(ownedObjects.rows[0].count, 0);

      const switchboardPrivileges = await admin.query(
        `SELECT
           has_table_privilege($1, 'public.switchboard_service_records', 'SELECT') AS runtime_select,
           has_table_privilege($2, 'public.switchboard_service_records', 'SELECT') AS backup_select`,
        [RUNTIME_ROLE, BACKUP_ROLE],
      );
      assert.deepEqual(switchboardPrivileges.rows, [
        { runtime_select: false, backup_select: true },
      ]);

      const rlsRelations = await admin.query(
        `SELECT namespace.nspname AS schema_name, relation.relname
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('public', 'drizzle')
            AND relation.relkind IN ('r', 'p')
            AND (relation.relrowsecurity OR relation.relforcerowsecurity)`,
      );
      assert.deepEqual(rlsRelations.rows, []);

      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${MIGRATOR_ROLE}`);
        for (const schema of ["public", "drizzle"]) {
          await admin.query(
            `CREATE TABLE ${schema}.${fixtureName}_table (id integer PRIMARY KEY)`,
          );
          await admin.query(`CREATE SEQUENCE ${schema}.${fixtureName}_sequence`);
        }
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      for (const objectName of qualifiedObjects) {
        const isSequence = objectName.endsWith("_sequence");
        const result = await admin.query(
          isSequence
            ? "SELECT has_sequence_privilege($1, $2, 'SELECT') AS can_select, has_sequence_privilege($1, $2, 'USAGE,UPDATE') AS can_write"
            : "SELECT has_table_privilege($1, $2, 'SELECT') AS can_select, has_table_privilege($1, $2, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write",
          [BACKUP_ROLE, objectName],
        );
        assert.deepEqual(result.rows, [{ can_select: true, can_write: false }]);
      }

      const runtimeAfter = await admin.query(
        `SELECT to_jsonb(role_row) AS role
           FROM (
             SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                    rolcanlogin, rolreplication, rolbypassrls
               FROM pg_catalog.pg_roles
              WHERE rolname = $1
           ) AS role_row`,
        [RUNTIME_ROLE],
      );
      const runtimeMembershipsAfter = await admin.query(
        `SELECT role_role.rolname AS role_name, member_role.rolname AS member_name
           FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles role_role ON role_role.oid = membership.roleid
          JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
          WHERE role_role.rolname = $1 OR member_role.rolname = $1
          ORDER BY role_role.rolname COLLATE "C", member_role.rolname COLLATE "C"`,
        [RUNTIME_ROLE],
      );
      assert.deepEqual(runtimeAfter.rows, runtimeBefore.rows);
      assert.deepEqual(
        runtimeMembershipsAfter.rows,
        runtimeMembershipsBefore.rows,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("BEGIN").catch(() => undefined);
      await admin.query(`SET LOCAL ROLE ${MIGRATOR_ROLE}`).catch(() => undefined);
      for (const schema of ["public", "drizzle"]) {
        await admin
          .query(`DROP TABLE IF EXISTS ${schema}.${fixtureName}_table`)
          .catch(() => undefined);
        await admin
          .query(`DROP SEQUENCE IF EXISTS ${schema}.${fixtureName}_sequence`)
          .catch(() => undefined);
      }
      await admin.query("COMMIT").catch(() => undefined);
      await admin.end();
    }
  },
);
