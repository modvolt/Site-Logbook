import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { assertAccountingEvidenceMigrationInstalled } from "./accounting-evidence-migration-helper";

const ROLLBACK = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../lib/db/rollbacks/0106_graceful_frog_thor.down.sql",
  ),
  "utf8",
);

beforeAll(async () => {
  await assertAccountingEvidenceMigrationInstalled(pool);
});

describe("R13 accounting evidence empty 0106 rollback", () => {
  it("removes only the unused expand schema and its exact journal row", async () => {
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
