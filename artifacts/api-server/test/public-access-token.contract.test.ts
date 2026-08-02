import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("public access token migration contract", () => {
  it("adds a hash-only lifecycle and backfills every legacy credential purpose", () => {
    const migration = read(
      "lib/db/migrations/0101_public_access_token_lifecycle.sql",
    );

    expect(migration).toContain('CREATE TABLE "public_access_tokens"');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).not.toMatch(/"(?:raw_)?token" text/i);
    expect(migration).toContain("'job_signature'");
    expect(migration).toContain("'ppe_signature'");
    expect(migration).toContain("'ppe_confirmation'");
    expect(migration).toContain("'quote_decision'");
    expect(migration).toContain("sha256(convert_to");
    expect(migration).not.toMatch(/UPDATE\s+"(?:jobs|ppe_assignments|quotes)"/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"(?:jobs|ppe_assignments|quotes)"/i);
  });

  it("permits only named terminal actions and blocks unsafe rollback", () => {
    const migration = read(
      "lib/db/migrations/0101_public_access_token_lifecycle.sql",
    );
    const rollback = read(
      "lib/db/rollbacks/0101_public_access_token_lifecycle.down.sql",
    );

    expect(migration).toContain(
      "consume_action\" in ('signed', 'confirmed', 'accepted', 'rejected')",
    );
    expect(rollback).toContain("0101 rollback blocked");
    expect(rollback).toContain("legacy_imported_at IS NULL");
    expect(rollback).toContain("created_at = 1785636000000");
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("COMMIT;");
  });

  it("keeps plaintext cleanup behind an explicit measured confirmation", () => {
    const cleanup = read(
      "artifacts/api-server/src/scripts/backfill-public-access-tokens.ts",
    );

    expect(cleanup).toContain("CLEAR_PUBLIC_TOKEN_PLAINTEXT");
    expect(cleanup).toContain("--database=");
    expect(cleanup).toContain("unmatched");
    expect(cleanup).not.toMatch(/console\.(?:log|error)\([^\n]*(?:rawToken|signatureToken|confirmToken|shareToken)/);
  });

  it("binds job and quote tokens to immutable versions without inventing legacy history", () => {
    const migration = read(
      "lib/db/migrations/0102_immutable_job_quote_versions.sql",
    );
    const rollback = read(
      "lib/db/rollbacks/0102_immutable_job_quote_versions.down.sql",
    );

    expect(migration).toContain('CREATE TABLE "job_document_versions"');
    expect(migration).toContain('CREATE TABLE "quote_versions"');
    expect(migration).toContain('CREATE TABLE "job_signature_events"');
    expect(migration).toContain('CREATE TABLE "quote_decision_events"');
    expect(migration).toContain('"artifact_binding_status"');
    expect(migration).toContain("'legacy_unbound'");
    expect(migration).toContain("deny_immutable_evidence_mutation");
    expect(migration).toContain("guard_job_document_version_transition");
    expect(migration).not.toMatch(/INSERT INTO\s+"(?:job_document_versions|quote_versions)"/i);
    expect(rollback).toContain("0102 rollback blocked");
    expect(rollback).toContain("artifact_binding_status = 'bound'");
    expect(rollback).toContain("created_at = 1785639600000");
  });
});
