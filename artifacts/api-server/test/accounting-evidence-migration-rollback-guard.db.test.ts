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

beforeAll(async () => {
  await rollbackAuditEvidence0107ToExact0106(pool);
  await assertAccountingEvidenceMigrationInstalled(pool);
});

describe("R13 accounting evidence used 0106 rollback", () => {
  it("fails closed once an accounting aggregate root exists", async () => {
    // This suite intentionally freezes the database at exact 0106. Use the
    // historical SQL shape rather than today's Drizzle model, whose 0108-only
    // invoice columns must not be projected into a predecessor fixture.
    const invoice = await pool.query<{ id: number }>(
      "insert into invoices (status) values ('draft') returning id",
    );
    expect(invoice.rows[0]).toBeDefined();
    await pool.query(
      "insert into accounting_aggregate_heads (invoice_id) values ($1)",
      [invoice.rows[0]!.id],
    );

    await expect(pool.query(ROLLBACK)).rejects.toThrow(
      /0106 rollback blocked: a later migration or accounting evidence exists/i,
    );
    await assertAccountingEvidenceMigrationInstalled(pool);
    const journal = await pool.query<{ count: number }>(`
      select count(*)::integer as count
      from drizzle.__drizzle_migrations
    `);
    expect(journal.rows[0]?.count).toBe(106);
  });
});
