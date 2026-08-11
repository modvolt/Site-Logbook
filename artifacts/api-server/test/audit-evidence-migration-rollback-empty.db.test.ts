import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const rollbackSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../lib/db/rollbacks/0107_canonical_audit_evidence.down.sql",
  ),
  "utf8",
);

describe("R09 unused 0107 rollback", () => {
  it("returns only the exact untouched genesis schema to 0106", async () => {
    await pool.query(rollbackSql);
    const objects = await pool.query<{
      events: string | null;
      heads: string | null;
      outbox: string | null;
    }>(`select
      to_regclass('public.audit_events')::text as events,
      to_regclass('public.audit_chain_heads')::text as heads,
      to_regclass('public.audit_export_outbox')::text as outbox`);
    expect(objects.rows[0]).toEqual({
      events: null,
      heads: null,
      outbox: null,
    });
    const journal = await pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(journal.rows[0]?.count).toBe("106");
  });
});
