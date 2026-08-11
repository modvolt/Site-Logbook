import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  assertAccountingEvidenceMigrationInstalled,
  rollbackAuditEvidence0107ToExact0106,
} from "./accounting-evidence-migration-helper";

const ROLLBACK = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../lib/db/rollbacks/0106_graceful_frog_thor.down.sql",
  ),
  "utf8",
);

describe("R13 accounting evidence empty 0106 rollback", () => {
  it("removes only the unused expand schema and its exact journal row", async () => {
    await expect(pool.query(ROLLBACK)).rejects.toThrow(
      /0106 rollback blocked: a later migration/i,
    );
    await rollbackAuditEvidence0107ToExact0106(pool);
    await assertAccountingEvidenceMigrationInstalled(pool);

    const synthetic = await pool.query<{ id: number }>(`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values ('synthetic-later-application-with-lower-timestamp', 1)
      returning id
    `);
    await expect(pool.query(ROLLBACK)).rejects.toThrow(
      /0106 rollback blocked: a later migration/i,
    );
    await assertAccountingEvidenceMigrationInstalled(pool);
    await pool.query("delete from drizzle.__drizzle_migrations where id = $1", [
      synthetic.rows[0]!.id,
    ]);

    await pool.query(`
      delete from drizzle.__drizzle_migrations
      where created_at = 1786459128910
        and hash = '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd'
    `);
    const reverseRecovery = await pool.query<{ id: number }>(`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values ('synthetic-future-migration-applied-before-recovered-0106', 1786484628859)
      returning id
    `);
    await pool.query(`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (
        '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd',
        1786459128910
      )
    `);
    await expect(pool.query(ROLLBACK)).rejects.toThrow(
      /0106 rollback blocked: a later migration/i,
    );
    await assertAccountingEvidenceMigrationInstalled(pool);
    await pool.query("delete from drizzle.__drizzle_migrations where id = $1", [
      reverseRecovery.rows[0]!.id,
    ]);

    await pool.query(ROLLBACK);
    const result = await pool.query<{
      remaining_tables: number;
      remaining_migrations: number;
    }>(`
      select
        (
          select count(*)::integer
          from pg_tables
          where schemaname = 'public' and tablename like 'accounting_%'
        ) as remaining_tables,
        (
          select count(*)::integer
          from drizzle.__drizzle_migrations
        ) as remaining_migrations
    `);
    expect(result.rows[0]).toEqual({
      remaining_tables: 0,
      remaining_migrations: 105,
    });
  });
});
