import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const script = readFileSync(
  resolve(
    root,
    "artifacts/api-server/src/scripts/backfill-switchboard-qr-grants.ts",
  ),
  "utf8",
);

describe("switchboard QR grant backfill contract", () => {
  it("is dry-run by default and requires an exact target confirmation", () => {
    expect(script).toContain('args.includes("--execute")');
    expect(script).toContain('mode: "dry-run"');
    expect(script).toContain("--confirm=ASSIGN_SWITCHBOARD_QR_GRANTS");
    expect(script).toContain(
      '"Execution requires --database=<exact DATABASE_URL database name>."',
    );
  });

  it("never invents a perpetual legacy expiry", () => {
    expect(script).toContain("--legacy-expires-at=<ISO date-time>");
    expect(script).toContain("maximumSwitchboardQrExpiry(now)");
    expect(script).toContain("before.activeWithoutExpiry > 0");
    expect(script).toContain("qr_expires_at = ${expiresAt}");
    expect(script).not.toContain("qr_expires_at = null");
  });

  it("assigns resource ownership without exposing or changing bearer values", () => {
    expect(script).toContain("qr_owner_kind = 'resource'");
    expect(script).toContain(
      "qr_owner_assignment_source = 'legacy_resource_assignment'",
    );
    expect(script).not.toMatch(/set[^;]*(?:qr_token_hash|qr_token_ciphertext)\s*=/is);
    expect(script).not.toMatch(/console\.(?:log|error)\([^\n]*(?:qrToken|ciphertext|tokenHash)/);
    expect(script).toContain("after.activeWithoutOwner !== 0");
    expect(script).toContain("after.activeWithoutExpiry !== 0");
  });
});
