import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

if (process.env.AUTH_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run external account DB tests outside the isolated DB runner.",
  );
}

const runId = `${Date.now()}-${process.pid}`;
const dayMs = 24 * 60 * 60 * 1_000;

let client: PoolClient | undefined;
let savepointSequence = 0;
let custodianUserId = 0;
let externalUserId = 0;
let externalAccountExpiresAt: Date;
let jobId = 0;
let quoteId = 0;
let scopeId = 0;

function connection(): PoolClient {
  if (!client) throw new Error("External account DB test transaction is unavailable.");
  return client;
}

async function insertUser(input: {
  label: string;
  role?: "guest" | "master" | "admin";
  accountType?: "internal" | "external";
  isActive?: boolean;
}): Promise<number> {
  const result = await connection().query<{ id: number }>(
    `INSERT INTO users
       (username, password_hash, name, role, account_type, is_active)
     VALUES ($1, 'external-account-db-test-hash', $2, $3, $4, $5)
     RETURNING id`,
    [
      `r16c-${input.label}-${runId}`,
      `R16-C ${input.label}`,
      input.role ?? "guest",
      input.accountType ?? "internal",
      input.isActive ?? true,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Failed to create test user ${input.label}.`);
  return id;
}

async function expectSqlFailure(
  statement: string,
  values: readonly unknown[] = [],
  message?: RegExp,
): Promise<void> {
  const db = connection();
  const savepoint = `expected_failure_${++savepointSequence}`;
  await db.query(`SAVEPOINT ${savepoint}`);

  let failure: unknown;
  try {
    await db.query(statement, [...values]);
  } catch (error) {
    failure = error;
  }

  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await db.query(`RELEASE SAVEPOINT ${savepoint}`);
  expect(failure).toBeDefined();
  if (message) expect(String(failure)).toMatch(message);
}

async function insertDraftExternalAccount(input: {
  userId: number;
  custodianId: number;
  expiresAt: Date;
}): Promise<void> {
  const reviewedAt = new Date(Date.now() - 60_000);
  await connection().query(
    `INSERT INTO external_accounts
       (user_id, status, custodian_user_id, access_reviewed_at,
        access_expires_at, version, created_by_user_id, updated_by_user_id)
     VALUES ($1, 'draft', $2, $3, $4, 1, $2, $2)`,
    [input.userId, input.custodianId, reviewedAt, input.expiresAt],
  );
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
});

afterAll(async () => {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await pool.end();
});

describe.sequential("migration 0105 authenticated external account invariants", () => {
  it("keeps existing internal accounts backward compatible", async () => {
    const internalUserId = await insertUser({
      label: "internal-backcompat",
      role: "master",
    });
    const user = await connection().query<{
      account_type: string;
      role: string;
      is_active: boolean;
    }>(
      "SELECT account_type, role, is_active FROM users WHERE id = $1",
      [internalUserId],
    );
    expect(user.rows[0]).toEqual({
      account_type: "internal",
      role: "master",
      is_active: true,
    });

    await connection().query(
      `INSERT INTO user_permission_overrides
         (user_id, permission, effect, updated_by_user_id)
       VALUES ($1, 'jobs.view', 'allow', $1)`,
      [internalUserId],
    );
    const overrides = await connection().query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM user_permission_overrides
        WHERE user_id = $1`,
      [internalUserId],
    );
    expect(overrides.rows[0]?.count).toBe(1);
  });

  it("requires an external identity and an active internal custodian", async () => {
    custodianUserId = await insertUser({
      label: "custodian",
      role: "admin",
    });
    const inactiveCustodianId = await insertUser({
      label: "inactive-custodian",
      role: "admin",
      isActive: false,
    });
    const internalTargetId = await insertUser({
      label: "internal-profile-target",
    });
    externalUserId = await insertUser({
      label: "external-target",
      accountType: "external",
      isActive: false,
    });
    externalAccountExpiresAt = new Date(Date.now() + 30 * dayMs);

    await expectSqlFailure(
      `INSERT INTO external_accounts
         (user_id, status, custodian_user_id, access_reviewed_at,
          access_expires_at, version, created_by_user_id, updated_by_user_id)
       VALUES ($1, 'draft', $2, now(), $3, 1, $2, $2)`,
      [internalTargetId, custodianUserId, externalAccountExpiresAt],
      /external account requires an external guest identity/i,
    );
    await expectSqlFailure(
      `INSERT INTO external_accounts
         (user_id, status, custodian_user_id, access_reviewed_at,
          access_expires_at, version, created_by_user_id, updated_by_user_id)
       VALUES ($1, 'draft', $2, now(), $3, 1, $2, $2)`,
      [externalUserId, inactiveCustodianId, externalAccountExpiresAt],
      /custodian must be an active internal user/i,
    );

    await insertDraftExternalAccount({
      userId: externalUserId,
      custodianId: custodianUserId,
      expiresAt: externalAccountExpiresAt,
    });
    const profile = await connection().query<{
      status: string;
      custodian_user_id: number;
      version: number;
    }>(
      `SELECT status, custodian_user_id, version
         FROM external_accounts
        WHERE user_id = $1`,
      [externalUserId],
    );
    expect(profile.rows[0]).toEqual({
      status: "draft",
      custodian_user_id: custodianUserId,
      version: 1,
    });
  });

  it("requires exactly one typed scope and prevents it from outliving the account", async () => {
    const job = await connection().query<{ id: number }>(
      `INSERT INTO jobs (title, date, status)
       VALUES ($1, '2026-08-05', 'planned')
       RETURNING id`,
      [`R16-C scoped job ${runId}`],
    );
    jobId = job.rows[0]?.id ?? 0;
    const quote = await connection().query<{ id: number }>(
      "INSERT INTO quotes (title) VALUES ($1) RETURNING id",
      [`R16-C scoped quote ${runId}`],
    );
    quoteId = quote.rows[0]?.id ?? 0;
    if (!jobId || !quoteId) throw new Error("Failed to create scoped resources.");

    const startsAt = new Date(Date.now() - 60_000);
    const validExpiry = new Date(externalAccountExpiresAt.getTime() - dayMs);
    await expectSqlFailure(
      `INSERT INTO external_account_scopes
         (external_user_id, capability, starts_at, expires_at, created_by_user_id)
       VALUES ($1, 'read', $2, $3, $4)`,
      [externalUserId, startsAt, validExpiry, custodianUserId],
      /external_account_scopes_resource_chk/i,
    );
    await expectSqlFailure(
      `INSERT INTO external_account_scopes
         (external_user_id, job_id, quote_id, capability, starts_at,
          expires_at, created_by_user_id)
       VALUES ($1, $2, $3, 'read', $4, $5, $6)`,
      [
        externalUserId,
        jobId,
        quoteId,
        startsAt,
        validExpiry,
        custodianUserId,
      ],
      /external_account_scopes_resource_chk/i,
    );
    await expectSqlFailure(
      `INSERT INTO external_account_scopes
         (external_user_id, job_id, capability, starts_at,
          expires_at, created_by_user_id)
       VALUES ($1, $2, 'read', $3, $4, $5)`,
      [
        externalUserId,
        jobId,
        startsAt,
        new Date(externalAccountExpiresAt.getTime() + dayMs),
        custodianUserId,
      ],
      /scope may not outlive its external account/i,
    );

    const validScope = await connection().query<{ id: number }>(
      `INSERT INTO external_account_scopes
         (external_user_id, job_id, capability, starts_at,
          expires_at, created_by_user_id)
       VALUES ($1, $2, 'read', $3, $4, $5)
       RETURNING id`,
      [externalUserId, jobId, startsAt, validExpiry, custodianUserId],
    );
    scopeId = validScope.rows[0]?.id ?? 0;
    expect(scopeId).toBeGreaterThan(0);
  });

  it("allows activation only after a current scope exists", async () => {
    const unscopedExternalId = await insertUser({
      label: "unscoped-external",
      accountType: "external",
      isActive: false,
    });
    await insertDraftExternalAccount({
      userId: unscopedExternalId,
      custodianId: custodianUserId,
      expiresAt: new Date(Date.now() + 14 * dayMs),
    });
    await expectSqlFailure(
      `UPDATE external_accounts
          SET status = 'active', version = 2,
              updated_by_user_id = $2, updated_at = now()
        WHERE user_id = $1`,
      [unscopedExternalId, custodianUserId],
      /active external account requires future expiry and at least one current scope/i,
    );

    await connection().query(
      `UPDATE external_accounts
          SET status = 'active', version = 2,
              updated_by_user_id = $2, updated_at = now()
        WHERE user_id = $1`,
      [externalUserId, custodianUserId],
    );
    await connection().query(
      "UPDATE users SET is_active = true WHERE id = $1",
      [externalUserId],
    );
    const activated = await connection().query<{
      status: string;
      version: number;
      is_active: boolean;
    }>(
      `SELECT account.status, account.version, identity.is_active
         FROM external_accounts account
         JOIN users identity ON identity.id = account.user_id
        WHERE account.user_id = $1`,
      [externalUserId],
    );
    expect(activated.rows[0]).toEqual({
      status: "active",
      version: 2,
      is_active: true,
    });
  });

  it("rejects internal permission overrides for external identities", async () => {
    await expectSqlFailure(
      `INSERT INTO user_permission_overrides
         (user_id, permission, effect, updated_by_user_id)
       VALUES ($1, 'jobs.view', 'allow', $2)`,
      [externalUserId, custodianUserId],
      /external accounts cannot have internal permission overrides/i,
    );
  });

  it("keeps external events immutable and scope rows append-only", async () => {
    const event = await connection().query<{ id: number }>(
      `INSERT INTO external_account_events
         (external_user_id, scope_id, actor_user_id, event_type, details)
       VALUES ($1, $2, $3, 'scope_granted', $4::jsonb)
       RETURNING id`,
      [
        externalUserId,
        scopeId,
        custodianUserId,
        JSON.stringify({ resourceType: "job", resourceId: jobId }),
      ],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("Failed to create external access event.");

    await expectSqlFailure(
      "UPDATE external_account_events SET details = '{}'::jsonb WHERE id = $1",
      [eventId],
      /append-only/i,
    );
    await expectSqlFailure(
      "DELETE FROM external_account_events WHERE id = $1",
      [eventId],
      /append-only/i,
    );
    await expectSqlFailure(
      "DELETE FROM external_account_scopes WHERE id = $1",
      [scopeId],
      /append-only/i,
    );
  });

  it("executes the 0105 rollback-after-use guard without running destructive rollback", async () => {
    const rollbackSql = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../lib/db/rollbacks/0105_smooth_nitro.down.sql",
      ),
      "utf8",
    );
    const guard = rollbackSql.match(/DO \$\$[\s\S]*?\$\$;/)?.[0];
    expect(guard).toBeDefined();
    await expectSqlFailure(
      guard ?? "SELECT 1",
      [],
      /0105 rollback blocked: authenticated external account state exists/i,
    );
  });
});
