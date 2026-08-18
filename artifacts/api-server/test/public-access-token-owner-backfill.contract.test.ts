import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const script = readFileSync(
  resolve(
    root,
    "artifacts/api-server/src/scripts/backfill-public-access-token-owners.ts",
  ),
  "utf8",
);

describe("public access token owner backfill contract", () => {
  it("is dry-run by default and requires exact database confirmation", () => {
    expect(script).toContain('args.includes("--execute")');
    expect(script).toContain('mode: "dry-run"');
    expect(script).toContain(
      "--confirm=ASSIGN_PUBLIC_TOKEN_ORGANIZATION_OWNER",
    );
    expect(script).toContain(
      '"Execution requires --database=<exact DATABASE_URL database name>."',
    );
  });

  it("assigns organization ownership without changing grant semantics", () => {
    expect(script).toContain("owner_kind = 'organization'");
    expect(script).toContain("owner_assigned_at = created_at");
    expect(script).toContain(
      "owner_assignment_source = 'legacy_organization_assignment'",
    );
    expect(script).not.toMatch(
      /set[^;]*(?:token_hash|expires_at|resource_type|resource_id|artifact_binding_status|revoked_at|consumed_at)\s*=/is,
    );
    expect(script).not.toContain("created_by_user_id =");
    expect(script).not.toContain("token_prefix =");
  });

  it("fails closed on partial metadata and verifies zero unowned rows", () => {
    expect(script).toContain("before.partial !== 0");
    expect(script).toContain("after.unowned !== 0 || after.partial !== 0");
    expect(script).toContain("lock table public_access_tokens");
  });
});
