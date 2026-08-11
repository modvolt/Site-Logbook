import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accountingAggregateHeadsTable,
  db,
  invoicesTable,
  pool,
} from "@workspace/db";
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

describe("R13 accounting evidence used 0106 rollback", () => {
  it("fails closed once an accounting aggregate root exists", async () => {
    const [invoice] = await db
      .insert(invoicesTable)
      .values({ status: "draft" })
      .returning({ id: invoicesTable.id });
    expect(invoice).toBeDefined();
    await db
      .insert(accountingAggregateHeadsTable)
      .values({ invoiceId: invoice!.id });

    await expect(pool.query(ROLLBACK)).rejects.toThrow(
      /0106 rollback blocked: accounting evidence exists/i,
    );
    await assertAccountingEvidenceMigrationInstalled(pool);
    const journal = await pool.query<{ count: number }>(`
      select count(*)::integer as count
      from drizzle.__drizzle_migrations
    `);
    expect(journal.rows[0]?.count).toBe(106);
  });
});
