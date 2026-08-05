import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const migrationPath = "lib/db/migrations/0104_thin_sheva_callister.sql";
const rollbackPath = "lib/db/rollbacks/0104_thin_sheva_callister.down.sql";
const snapshotPath = "lib/db/migrations/meta/0104_snapshot.json";
const journalPath = "lib/db/migrations/meta/_journal.json";
const migrationWhen = 1785899402886;

describe("R16-B external grant expand migration", () => {
  it("adds nullable ownership metadata without rewriting live grants", () => {
    const migration = read(migrationPath);

    expect(migration).toContain('ADD COLUMN "owner_kind" text');
    expect(migration).toContain('ADD COLUMN "owner_user_id" integer');
    expect(migration).toContain('ADD COLUMN "owner_assigned_at" timestamp');
    expect(migration).toContain('ADD COLUMN "owner_assignment_source" text');
    expect(migration).not.toMatch(/ADD COLUMN "owner_[^"]+"[^;]*NOT NULL/i);
    expect(migration).toContain(
      'FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict',
    );
    expect(migration).toContain(
      'CREATE INDEX "public_access_tokens_active_owner_idx"',
    );
    expect(migration).toContain(
      'WHERE "public_access_tokens"."revoked_at" is null and "public_access_tokens"."consumed_at" is null',
    );
    expect(migration).toContain(
      '"public_access_tokens_owner_assignment_chk"',
    );
    expect(migration).toContain("'resource_organization', 'legacy_organization_assignment'");
    expect(migration).toContain("'manual_user_assignment', 'offboarding_transfer'");
    expect(migration).toContain('ADD COLUMN "qr_owner_kind" text');
    expect(migration).toContain('ADD COLUMN "qr_owner_user_id" integer');
    expect(migration).toContain('CREATE INDEX "switchboards_qr_enabled_owner_idx"');

    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE|INSERT)\s+/gim);
    expect(migration).not.toMatch(/ALTER\s+(?:TABLE|COLUMN)[^;]*(?:token_hash|expires_at|resource_type|resource_id|revoked_at|consumed_at)\s+(?:TYPE|SET|DROP)/i);
  });

  it("adds immutable PPE evidence and purpose-bound terminal actions", () => {
    const migration = read(migrationPath);
    const bindingFunctionAt = migration.indexOf(
      "CREATE OR REPLACE FUNCTION validate_ppe_public_evidence_event_binding()",
    );
    const bindingTriggerAt = migration.indexOf(
      "CREATE TRIGGER ppe_public_evidence_events_binding",
    );

    expect(migration).toContain('CREATE TABLE "ppe_public_evidence_versions"');
    expect(migration).toContain('CREATE TABLE "ppe_public_evidence_events"');
    expect(migration).toContain('ADD COLUMN "ppe_evidence_version_id" integer');
    expect(migration).toContain("ppe_public_evidence_versions_immutable");
    expect(migration).toContain("ppe_public_evidence_events_immutable");
    expect(migration).toContain("deny_immutable_evidence_mutation()");
    expect(bindingFunctionAt).toBeGreaterThan(0);
    expect(bindingTriggerAt).toBeGreaterThan(bindingFunctionAt);
    expect(migration).toContain(
      "NEW.assignment_id IS DISTINCT FROM evidence_assignment_id",
    );
    expect(migration).toContain(
      "NEW.assignment_id IS DISTINCT FROM token_resource_id",
    );
    expect(migration).toContain(
      "NEW.evidence_version_id IS DISTINCT FROM token_evidence_version_id",
    );
    expect(migration).toContain(
      "token_resource_type IS DISTINCT FROM 'ppe_assignment'",
    );
    expect(migration).toContain(
      "token_purpose IS DISTINCT FROM evidence_purpose",
    );
    expect(migration).toContain(
      "token_purpose = 'ppe_signature' AND NEW.action = 'signed'",
    );
    expect(migration).toContain(
      "token_purpose = 'ppe_confirmation' AND NEW.action = 'confirmed'",
    );
    expect(migration).toContain(
      "NEW.snapshot_sha256 IS DISTINCT FROM evidence_snapshot_sha256",
    );
    expect(migration).toContain(
      "NEW.confirmation_text IS DISTINCT FROM evidence_confirmation_text",
    );
    expect(migration).toContain(
      "purpose\" in ('job_signature', 'ppe_signature') and \"public_access_tokens\".\"consume_action\" = 'signed'",
    );
    expect(migration).toContain(
      "purpose\" = 'ppe_confirmation' and \"public_access_tokens\".\"consume_action\" = 'confirmed'",
    );
  });

  it("keeps the snapshot and journal in strict 0104 parity", () => {
    const snapshot = JSON.parse(read(snapshotPath)) as {
      tables: Record<string, {
        columns: Record<string, unknown>;
        indexes: Record<string, unknown>;
        foreignKeys: Record<string, unknown>;
        checkConstraints: Record<string, unknown>;
      }>;
    };
    const journal = JSON.parse(read(journalPath)) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const table = snapshot.tables["public.public_access_tokens"];
    const switchboards = snapshot.tables["public.switchboards"];

    expect(table).toBeDefined();
    expect(Object.keys(table!.columns)).toEqual(
      expect.arrayContaining([
        "owner_user_id",
        "owner_kind",
        "owner_assigned_at",
        "owner_assignment_source",
        "ppe_evidence_version_id",
      ]),
    );
    expect(table!.indexes).toHaveProperty(
      "public_access_tokens_active_owner_idx",
    );
    expect(table!.foreignKeys).toHaveProperty(
      "public_access_tokens_owner_user_id_users_id_fk",
    );
    expect(table!.checkConstraints).toHaveProperty(
      "public_access_tokens_owner_assignment_chk",
    );
    expect(snapshot.tables).toHaveProperty(
      "public.ppe_public_evidence_versions",
    );
    expect(snapshot.tables).toHaveProperty(
      "public.ppe_public_evidence_events",
    );
    expect(switchboards!.columns).toHaveProperty("qr_owner_kind");
    expect(switchboards!.checkConstraints).toHaveProperty(
      "switchboards_qr_owner_assignment_chk",
    );
    expect(journal.entries.find((entry) => entry.idx === 104)).toEqual({
      idx: 104,
      version: "7",
      when: migrationWhen,
      tag: "0104_thin_sheva_callister",
      breakpoints: true,
    });
  });

  it("blocks destructive rollback after any ownership or evidence write", () => {
    const rollback = read(rollbackPath);
    const guardAt = rollback.indexOf("IF EXISTS");
    const firstDropAt = rollback.search(/\b(?:DROP|ALTER\s+TABLE.+DROP)\b/i);

    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("COMMIT;");
    expect(rollback).toContain("0104 rollback blocked");
    expect(rollback).toContain("owner_kind IS NOT NULL");
    expect(rollback).toContain("owner_user_id IS NOT NULL");
    expect(rollback).toContain("owner_assigned_at IS NOT NULL");
    expect(rollback).toContain("owner_assignment_source IS NOT NULL");
    expect(rollback).toContain("ppe_evidence_version_id IS NOT NULL");
    expect(rollback).toContain("SELECT 1 FROM ppe_public_evidence_versions");
    expect(rollback).toContain("SELECT 1 FROM ppe_public_evidence_events");
    expect(rollback).toContain("qr_owner_kind IS NOT NULL");
    expect(rollback).toContain("public_access_tokens_artifact_binding_chk");
    expect(rollback).toContain("public_access_tokens_consume_action_chk");
    expect(rollback).toContain(
      "DROP TRIGGER IF EXISTS ppe_public_evidence_events_binding",
    );
    expect(rollback).toContain(
      "DROP FUNCTION IF EXISTS validate_ppe_public_evidence_event_binding()",
    );
    expect(rollback).toContain(`created_at = ${migrationWhen}`);
    expect(guardAt).toBeGreaterThan(0);
    expect(firstDropAt).toBeGreaterThan(guardAt);
    expect(rollback).not.toMatch(/\bCASCADE\b/i);
  });
});
