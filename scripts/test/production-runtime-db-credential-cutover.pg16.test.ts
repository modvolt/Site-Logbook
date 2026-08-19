import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import {
  createPostgres16RuntimeCredentialAlterStatement,
  createPostgres16ScramSha256Verifier,
} from "../../artifacts/api-server/src/lib/production-runtime-db-credential-cutover.js";

const connectionUrl = process.env.PRODUCTION_RUNTIME_DB_CREDENTIAL_PG16_URL;
const disposableConfirmation =
  process.env.PRODUCTION_RUNTIME_DB_CREDENTIAL_PG16_DISPOSABLE_CONFIRM;
const DISPOSABLE_CONFIRMATION =
  "I_CONFIRM_THIS_IS_A_DISPOSABLE_LOCAL_PG16_RUNTIME_CREDENTIAL_FIXTURE";
const fixtureDatabase = "runtime_credential_pg16_fixture";
const fixtureAdmin = "runtime_credential_pg16_fixture_admin";
const runtimeRole = "site_logbook_runtime";
const runtimePassword = "R".repeat(48);
const wrongPassword = "W".repeat(48);

export function assertDisposablePg16RuntimeCredentialFixture(
  raw: unknown,
  confirmation: unknown,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error("RUNTIME_CREDENTIAL_PG16_DISPOSABLE_FIXTURE_REQUIRED");
  }
  const port = Number(parsed.port);
  if (
    confirmation !== DISPOSABLE_CONFIRMATION ||
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 49_152 ||
    port > 65_535 ||
    parsed.username !== fixtureAdmin ||
    parsed.password.length === 0 ||
    parsed.pathname !== `/${fixtureDatabase}` ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PG16_DISPOSABLE_FIXTURE_REQUIRED");
  }
  return parsed;
}

function runtimeUrl(password: string): string {
  const parsed = assertDisposablePg16RuntimeCredentialFixture(
    connectionUrl,
    disposableConfirmation,
  );
  parsed.search = "";
  parsed.hash = "";
  parsed.username = runtimeRole;
  parsed.password = password;
  return parsed.href;
}

test("PG16 credential proof rejects production-like or unconfirmed URLs before connection", () => {
  for (const [url, confirmation] of [
    [
      "postgres://admin:fixture@production-postgres:5432/site_logbook",
      DISPOSABLE_CONFIRMATION,
    ],
    [
      "postgres://runtime_credential_pg16_fixture_admin:fixture@127.0.0.1:5432/runtime_credential_pg16_fixture",
      DISPOSABLE_CONFIRMATION,
    ],
    [
      "postgres://runtime_credential_pg16_fixture_admin:fixture@127.0.0.1:61495/admin",
      DISPOSABLE_CONFIRMATION,
    ],
    [
      "postgres://runtime_credential_pg16_fixture_admin:fixture@127.0.0.1:61495/runtime_credential_pg16_fixture",
      undefined,
    ],
  ] as const) {
    assert.throws(
      () => assertDisposablePg16RuntimeCredentialFixture(url, confirmation),
      /RUNTIME_CREDENTIAL_PG16_DISPOSABLE_FIXTURE_REQUIRED/,
    );
  }
});

async function expectPasswordRejected(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  try {
    await assert.rejects(
      client.connect(),
      (error: unknown) =>
        Boolean(error) &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "28P01",
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

test(
  "PostgreSQL 16 stores the exact derived verifier, accepts the new password, and rejects a wrong password under host SCRAM auth",
  {
    skip: connectionUrl === undefined && disposableConfirmation === undefined,
    timeout: 60_000,
  },
  async () => {
    const guardedUrl = assertDisposablePg16RuntimeCredentialFixture(
      connectionUrl,
      disposableConfirmation,
    );
    const admin = new Client({ connectionString: guardedUrl.href });
    await admin.connect();
    let createdByThisTest = false;
    try {
      const fixtureIdentity = await admin.query(
        "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user",
      );
      assert.deepEqual(fixtureIdentity.rows, [
        {
          database_name: fixtureDatabase,
          session_user: fixtureAdmin,
          current_user: fixtureAdmin,
        },
      ]);
      const version = await admin.query("SHOW server_version_num");
      assert.equal(
        Math.floor(Number(version.rows[0].server_version_num) / 10_000),
        16,
      );
      const hba = await admin.query(`SELECT auth_method, error
        FROM pg_catalog.pg_hba_file_rules
        WHERE type = 'host'
        ORDER BY line_number`);
      assert.equal(
        hba.rows.some(
          (row) => row.auth_method === "scram-sha-256" && row.error === null,
        ),
        true,
      );
      assert.equal(
        hba.rows.some((row) => row.auth_method === "trust"),
        false,
      );

      const preexisting = await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text) AS present",
        [runtimeRole],
      );
      assert.equal(preexisting.rows[0].present, false);
      await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN`);
      createdByThisTest = true;
      const verifier = createPostgres16ScramSha256Verifier(
        runtimePassword,
        Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      );
      const statement =
        createPostgres16RuntimeCredentialAlterStatement(verifier);
      assert.equal(statement.includes(runtimePassword), false);

      await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await admin.query(statement);
      const stored = await admin.query(
        "SELECT rolpassword::text AS verifier FROM pg_catalog.pg_authid WHERE rolname = $1::text",
        [runtimeRole],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].verifier, verifier);
      await admin.query("COMMIT");

      const correct = new Client({
        connectionString: runtimeUrl(runtimePassword),
      });
      await correct.connect();
      try {
        const identity = await correct.query(
          "SELECT session_user::text AS session_user, current_user::text AS current_user",
        );
        assert.deepEqual(identity.rows[0], {
          session_user: runtimeRole,
          current_user: runtimeRole,
        });
      } finally {
        await correct.end();
      }
      await expectPasswordRejected(runtimeUrl(wrongPassword));
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      if (createdByThisTest) {
        await admin.query(`DROP ROLE "${runtimeRole}"`).catch(() => undefined);
      }
      await admin.end();
    }
  },
);
