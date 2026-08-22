import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

const expectedTail = [
  [96, 1786383352759, "0096_far_smiling_tiger"],
  [97, 1786383360000, "0097_session_and_api_idempotency"],
  [98, 1786383361000, "0098_object-upload-ledger"],
  [99, 1786383362000, "0099_secret_envelope_encryption"],
  [101, 1786383363000, "0101_public_access_token_lifecycle"],
  [102, 1786383364000, "0102_immutable_job_quote_versions"],
  [103, 1786383365000, "0103_durable_operational_incident_outbox"],
  [104, 1786383366000, "0104_thin_sheva_callister"],
  [105, 1786383367000, "0105_smooth_nitro"],
  [106, 1786459128910, "0106_graceful_frog_thor"],
  [107, 1786484628859, "0107_canonical_audit_evidence"],
  [108, 1786986729921, "0108_invoice_source_allocations_and_advances"],
] as const;

describe("integrated production-forward migration lineage", () => {
  it("preserves the production 0096 and a unique monotonic tail without 0100", () => {
    const journal = JSON.parse(
      read("lib/db/migrations/meta/_journal.json"),
    ) as {
      entries: Array<{
        idx: number;
        when: number;
        tag: string;
        version: string;
        breakpoints: boolean;
      }>;
    };
    const tail = journal.entries
      .filter((entry) => entry.idx >= 96)
      .map((entry) => [entry.idx, entry.when, entry.tag]);

    expect(journal.entries).toHaveLength(108);
    expect(tail).toEqual(expectedTail);
    expect(new Set(journal.entries.map((entry) => entry.when)).size).toBe(
      journal.entries.length,
    );
    expect(new Set(journal.entries.map((entry) => entry.tag)).size).toBe(
      journal.entries.length,
    );
    expect(journal.entries.some((entry) => entry.idx === 100)).toBe(false);
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]![1]).toBeGreaterThan(tail[index - 1]![1]);
    }
  });

  it("combines only the two unapplied security migrations after the live quote migration", () => {
    const quoteMigration = read("lib/db/migrations/0096_far_smiling_tiger.sql");
    const securityMigration = read(
      "lib/db/migrations/0097_session_and_api_idempotency.sql",
    );

    expect(quoteMigration).toContain(
      'ALTER TABLE "quote_items" ADD COLUMN "row_type"',
    );
    expect(quoteMigration).toContain(
      'ALTER TABLE "quote_items" ADD COLUMN "purchase_unit_price"',
    );
    expect(
      existsSync(
        resolve(root, "lib/db/migrations/0096_daffy_puppet_master.sql"),
      ),
    ).toBe(false);
    expect(
      securityMigration.indexOf('ALTER TABLE "users"'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      securityMigration.indexOf('CREATE TABLE "api_idempotency_records"'),
    ).toBeGreaterThan(securityMigration.indexOf('ALTER TABLE "users"'));
  });

  it("chains every regenerated snapshot from the production 0096 and retains both schema planes", () => {
    const tags = expectedTail.map(([, , tag]) => tag.slice(0, 4));
    const snapshots = tags.map((tag) =>
      JSON.parse(read(`lib/db/migrations/meta/${tag}_snapshot.json`)),
    );

    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]!.prevId).toBe(snapshots[index - 1]!.id);
    }
    for (const snapshot of snapshots) {
      const quoteItems = snapshot.tables["public.quote_items"];
      expect(quoteItems.columns.row_type).toBeDefined();
      expect(quoteItems.columns.purchase_unit_price).toBeDefined();
      expect(
        quoteItems.checkConstraints.quote_items_row_type_check,
      ).toBeDefined();
      expect(
        quoteItems.checkConstraints.quote_items_purchase_unit_price_check,
      ).toBeDefined();
    }

    const securitySnapshot = snapshots[1]!;
    expect(
      securitySnapshot.tables["public.users"].columns.session_generation,
    ).toBeDefined();
    expect(
      securitySnapshot.tables["public.api_idempotency_records"],
    ).toBeDefined();
  });

  it("binds every available destructive rollback to the rebuilt journal identity", () => {
    for (const [idx, when, tag] of expectedTail) {
      if (idx === 103) continue;
      const rollbackPath = resolve(root, `lib/db/rollbacks/${tag}.down.sql`);
      expect(existsSync(rollbackPath), tag).toBe(true);
      expect(readFileSync(rollbackPath, "utf8"), tag).toContain(
        `created_at = ${when}`,
      );
    }
  });
});
