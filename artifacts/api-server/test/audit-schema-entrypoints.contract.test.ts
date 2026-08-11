import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("audit schema 0107 runtime entrypoints", () => {
  it("exports the DB contract and bundles four dedicated fail-closed entrypoints", () => {
    const packageJson = JSON.parse(read("lib/db/package.json")) as {
      exports: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(packageJson.exports["./audit-schema-preflight"]).toBe(
      "./src/audit-schema-preflight.ts",
    );
    expect(packageJson.scripts["test:audit-schema-preflight"]).toBe(
      "tsx --test ./src/audit-schema-preflight.test.ts",
    );

    const build = read("artifacts/api-server/build.mjs");
    for (const entrypoint of [
      "audit-schema-inventory.ts",
      "audit-schema-gate.ts",
      "audit-schema-steady-state.ts",
      "audit-schema-exact-0106-backup.ts",
    ]) {
      expect(build).toContain(`src/${entrypoint}`);
    }

    expect(
      read("artifacts/api-server/src/audit-schema-inventory.ts"),
    ).toContain("[audit-schema-inventory] PASS");
    expect(
      read("artifacts/api-server/src/audit-schema-steady-state.ts"),
    ).toContain("[audit-schema-steady-state] PASS");
    const gate = read("artifacts/api-server/src/audit-schema-gate.ts");
    expect(gate).toContain("[audit-schema-gate] ${result.mode}");
    expect(gate).toContain("applyAuditSchema0107");
    expect(gate).not.toContain("runMigrations");
    const preflight = read("lib/db/src/audit-schema-preflight.ts");
    expect(preflight).toContain("export async function applyAuditSchema0107");
    expect(preflight).toContain(
      '"INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)"',
    );
    expect(preflight).toContain(
      "const backup = validateStagingBackupEvidenceSnapshot(",
    );
    expect(preflight).not.toContain(
      'classification.decision === "ALREADY_0107"\n        ? null',
    );
    expect(
      read("artifacts/api-server/src/audit-schema-exact-0106-backup.ts"),
    ).toContain("[audit-schema-exact-0106-backup] PASS");
  });
});
