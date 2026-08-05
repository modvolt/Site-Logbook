import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migrationPath = "lib/db/migrations/0105_smooth_nitro.sql";
const rollbackPath = "lib/db/rollbacks/0105_smooth_nitro.down.sql";
const snapshotPath = "lib/db/migrations/meta/0105_snapshot.json";
const migrationWhen = 1785912730511;

describe("R16-C2 authenticated external account expand migration", () => {
  it("adds orthogonal identity, direct typed read scopes and an append-only ledger", () => {
    const migration = read(migrationPath);

    expect(migration).toContain('ADD COLUMN "account_type" text DEFAULT \'internal\' NOT NULL');
    expect(migration).toContain('CREATE TABLE "external_accounts"');
    expect(migration).toContain('CREATE TABLE "external_account_scopes"');
    expect(migration).toContain('CREATE TABLE "external_account_events"');
    expect(migration).toContain("num_nonnulls");
    expect(migration).toContain("capability\" = 'read'");
    expect(migration).toContain("external_account_scopes_active_job_uq");
    expect(migration).toContain("external_account_scopes_active_quote_uq");
    expect(migration).toContain("external_account_scopes_active_switchboard_uq");
    expect(migration).toContain("user_permission_overrides_external_guard_trg");
    expect(migration).toContain("users_external_identity_guard_trg");
    expect(migration).toContain("external_account_events_immutable_trg");
    expect(migration).toContain("external_account_scopes_no_delete_trg");
    expect(migration).toContain("active external identity requires an active, unexpired profile");
    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE|INSERT)\s+/gim);
  });

  it("keeps journal and snapshot parity without reintroducing excluded 0100", () => {
    const snapshot = JSON.parse(read(snapshotPath)) as {
      prevId: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    const previous = JSON.parse(read("lib/db/migrations/meta/0104_snapshot.json")) as {
      id: string;
    };
    const journal = JSON.parse(read("lib/db/migrations/meta/_journal.json")) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };

    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.tables["public.users"]?.columns).toHaveProperty("account_type");
    expect(snapshot.tables).toHaveProperty("public.external_accounts");
    expect(snapshot.tables).toHaveProperty("public.external_account_scopes");
    expect(snapshot.tables).toHaveProperty("public.external_account_events");
    expect(journal.entries.find((entry) => entry.idx === 105)).toEqual({
      idx: 105,
      version: "7",
      when: migrationWhen,
      tag: "0105_smooth_nitro",
      breakpoints: true,
    });
    expect(journal.entries.some((entry) => entry.idx === 100)).toBe(false);
  });

  it("permits reverse migration only while the expansion is completely unused", () => {
    const rollback = read(rollbackPath);
    const guardAt = rollback.indexOf("IF EXISTS");
    const firstDropAt = rollback.search(/\b(?:DROP|ALTER\s+TABLE.+DROP)\b/i);

    expect(rollback).toContain("0105 rollback blocked");
    expect(rollback).toContain("SELECT 1 FROM external_accounts");
    expect(rollback).toContain("SELECT 1 FROM external_account_scopes");
    expect(rollback).toContain("SELECT 1 FROM external_account_events");
    expect(rollback).toContain("account_type = 'external'");
    expect(rollback).toContain(`created_at = ${migrationWhen}`);
    expect(guardAt).toBeGreaterThan(0);
    expect(firstDropAt).toBeGreaterThan(guardAt);
    expect(rollback).not.toMatch(/\bCASCADE\b/i);
  });
});
