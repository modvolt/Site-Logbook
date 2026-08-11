import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const source = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

describe("production steady-0107 startup boundary", () => {
  it("never invokes the migrator from either production startup path", () => {
    const dockerfile = source("artifacts/api-server/Dockerfile");
    const startup = source("scripts/start-api-production.sh");

    expect(dockerfile).toContain(
      'CMD ["sh", "/app/scripts/start-api-production.sh"]',
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /repo/scripts/check-audit-0107-release-evidence.mjs",
    );
    expect(dockerfile).not.toContain("node dist/migrate.mjs");
    expect(startup).toContain("check-audit-0107-release-evidence.mjs");
    expect(startup).toContain("--emit-runtime-lineage-b64");
    expect(startup).toContain("autoMigrate=false");
    expect(startup).not.toContain("migrate.mjs");
  });

  it("requires exact build and all separately checksummed raw artifacts", () => {
    const compose = source("docker-compose.yml");
    expect(compose).toContain(
      "BUILD_SHA: ${BUILD_SHA:?set the exact 40-character release commit SHA}",
    );
    for (const key of [
      "AUDIT_0107_RELEASE_EVIDENCE_B64",
      "AUDIT_0107_RELEASE_EVIDENCE_SHA256",
      "AUDIT_0107_EXECUTION_EVIDENCE_B64",
      "AUDIT_0107_EXECUTION_EVIDENCE_SHA256",
      "AUDIT_0107_INTENT_EVIDENCE_B64",
      "AUDIT_0107_INTENT_EVIDENCE_SHA256",
      "AUDIT_0107_STEADY_STATE_EVIDENCE_B64",
      "AUDIT_0107_STEADY_STATE_EVIDENCE_SHA256",
      "AUDIT_0107_RESOLVED_COMPOSE_SHA256",
      "AUDIT_0107_DEPLOYMENT_CONFIG_SHA256",
      "AUDIT_0107_LIVE_POSTGRES_TARGET_SHA256",
    ]) {
      expect(compose).toContain(`${key}: \${${key}:?`);
    }
  });

  it("keeps schema-v4 exact-0105 evidence separate from the v5 approval", () => {
    const v4Checker = source("scripts/check-staging-release-evidence.mjs");
    const v4Template = JSON.parse(
      source("docs/audit/13-staging-evidence.template.json"),
    );
    const v5Template = JSON.parse(
      source(
        "docs/audit/13-staging-audit-0107-release-evidence-v5.template.json",
      ),
    );

    expect(v4Checker).toContain(
      'requireValue(root.schemaVersion, 4, "schemaVersion")',
    );
    expect(v4Checker).toContain('"0105_smooth_nitro"');
    expect(v4Template.schemaVersion).toBe(4);
    expect(v4Template.deployment.expectedMigrations).toBe(105);
    expect(v5Template.schemaVersion).toBe(5);
    expect(v5Template.predecessorReleaseEvidence.schemaVersion).toBe(4);
  });

  it("classifies the health journal by timestamp plus SQL hash", () => {
    const health = source("artifacts/api-server/src/routes/health.ts");
    expect(health).toContain(
      "SELECT created_at, hash FROM drizzle.__drizzle_migrations",
    );
    expect(health).toContain("classifyMigrationInventory");
    expect(health).toContain("migrationReleaseBindingMatches");
    expect(health).toContain("knownAppliedMigrations");
    expect(health).toContain("opaqueAppliedMigrations");
    expect(health).toContain("opaqueMigrationRowsSha256");
  });
});
