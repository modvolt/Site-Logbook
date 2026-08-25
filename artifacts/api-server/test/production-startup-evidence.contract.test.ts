import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const source = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

describe("production steady-0107 startup boundary", () => {
  it("makes the implicit/final production image non-mutating", () => {
    const dockerfile = source("artifacts/api-server/Dockerfile");
    const runtime = dockerfile.slice(
      dockerfile.indexOf(" AS runtime"),
      dockerfile.indexOf(" AS control-plane"),
    );
    expect(runtime).toContain("dist/index.mjs ./dist/index.mjs");
    expect(runtime).toContain(
      "dist/production-api-entrypoint.mjs ./dist/production-api-entrypoint.mjs",
    );
    expect(runtime).toContain(
      'CMD ["node", "--enable-source-maps", "/app/dist/production-api-entrypoint.mjs"]',
    );
    expect(runtime).not.toContain("migrate.mjs");
    expect(runtime).not.toContain("schema-gate.mjs");
    expect(runtime).not.toContain("check-audit-0107-release-evidence.mjs");
    expect(dockerfile).toContain("FROM runtime AS control-plane");
    expect(dockerfile).toContain('RUN test "$(id -u node)" = "1000"');
    expect(dockerfile).toContain('test "$(id -g node)" = "1000"');
    expect(dockerfile).toContain(
      "RUN touch /app/.site-logbook-control-plane-image",
    );
    expect(dockerfile).toContain(
      'LABEL io.modvolt.site-logbook.image-profile="control-plane"',
    );
    expect(dockerfile.trimEnd()).toMatch(
      /FROM runtime AS production\r?\nLABEL io\.modvolt\.site-logbook\.image-profile="production"$/,
    );
  });

  it("uses only separately approved immutable images in root production Compose", () => {
    const compose = source("docker-compose.yml");
    const environmentExample = source(".env.example");
    expect(compose).not.toMatch(/^\s+build:/m);
    for (const key of [
      "PRODUCTION_POSTGRES_IMAGE",
      "PRODUCTION_API_IMAGE",
      "PRODUCTION_WEB_IMAGE",
    ]) {
      expect(compose).toContain(`image: \${${key}:?`);
    }
    expect(compose).toContain(
      "PRODUCTION_API_IMAGE: ${PRODUCTION_API_IMAGE:?set immutable API repository@sha256 digest}",
    );
    expect(compose).not.toContain("postgres:16-alpine");
    expect(compose).not.toContain("minio/minio:latest");
    expect(compose).not.toContain("minio/mc:latest");
    expect(compose).not.toMatch(/^\s{2}(?:minio|createbuckets):/m);
    expect(compose).not.toContain("PRODUCTION_MINIO_IMAGE");
    expect(compose).not.toContain("PRODUCTION_MINIO_MC_IMAGE");
    expect(compose).toContain(
      "S3_ENDPOINT: ${S3_ENDPOINT:?set the canonical Hetzner Object Storage HTTPS endpoint}",
    );
    expect(compose).toContain(
      "S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-false}",
    );
    expect(
      source("artifacts/api-server/src/lib/production-startup.ts"),
    ).toContain("requireProductionHetznerObjectStorageConfiguration(env)");
    expect(compose).toContain("SITE_LOGBOOK_RUNTIME_ENVIRONMENT: production");
    expect(compose).toContain('EXTERNAL_ACCOUNTS_ENABLED: "false"');
    for (const key of [
      "PRODUCTION_ACTIVATION_PUBLISHER_PUBLIC_KEY_SHA256",
      "PRODUCTION_ACTIVATION_HOST_PUBLIC_KEY_SHA256",
    ]) {
      expect(compose).toContain(`${key}: \${${key}:?`);
    }
    for (const key of [
      "PRODUCTION_EXPECTED_DESIRED_CONFIG_SHA256",
      "PRODUCTION_EXPECTED_DEPLOYED_CONFIG_SHA256",
      "PRODUCTION_EXPECTED_RESOLVED_COMPOSE_SHA256",
    ]) {
      expect(compose).not.toContain(key);
      expect(environmentExample).not.toContain(key);
    }
    expect(compose).not.toMatch(/PRODUCTION_[A-Z0-9_]*EVIDENCE_B64/);
    expect(compose).not.toContain("PRODUCTION_HOST_ATTESTATION_B64");
    expect(compose).toContain(
      "/var/lib/modvolt/site-logbook-production-evidence:/run/site-logbook-production-evidence:ro",
    );
    expect(compose).not.toContain(
      "/var/lib/modvolt/site-logbook-production-evidence:/run/site-logbook-production-evidence:rw",
    );
  });

  it("proves the runtime credential against a self-owned disposable PostgreSQL 16 fixture", () => {
    const workflow = source(".github/workflows/quality-gate.yml");
    expect(workflow).toContain(
      "RUNTIME_CREDENTIAL_PG16_CONTAINER: site-logbook-runtime-credential-pg16-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain("-p 127.0.0.1:61495:5432");
    expect(workflow).toContain("POSTGRES_DB=runtime_credential_pg16_fixture");
    expect(workflow).toContain(
      "POSTGRES_USER=runtime_credential_pg16_fixture_admin",
    );
    expect(workflow).toContain(
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
    );
    expect(workflow).toContain(
      "pnpm test:production-runtime-db-credential:pg16",
    );
    expect(workflow).toContain(
      "I_CONFIRM_THIS_IS_A_DISPOSABLE_LOCAL_PG16_RUNTIME_CREDENTIAL_FIXTURE",
    );
    expect(workflow).toContain(
      "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = 'site_logbook_runtime'",
    );
    expect(workflow).toContain(
      'docker rm --force "$RUNTIME_CREDENTIAL_PG16_CONTAINER"',
    );
    expect(workflow).toContain(
      "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
    );
    expect(workflow).not.toContain(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_PG16_URL: postgresql://site_logbook_ci:",
    );
  });

  it("ships only a visibly blocked, non-authorizing production template", () => {
    const template = JSON.parse(
      source("docs/audit/13-production-audit-0107-evidence.template.json"),
    ) as {
      _templateStatus: string;
      target: {
        build: { provenanceEvidenceSha256: string };
      };
      activationApproval: {
        schemaVersion: string;
        confirmation: string;
      };
      intent: {
        productionTargetsTouched: boolean;
        authorizesApplicationStart: boolean;
      };
      execution: {
        productionTargetsTouched: boolean;
        authorizesApplicationStart: boolean;
      };
      steady: {
        productionTargetsTouched: boolean;
        authorizesApplicationStart: boolean;
      };
      release: {
        productionTargetsTouched: boolean;
        authorizesApplicationStart: boolean;
      };
    };
    expect(template._templateStatus).toContain("ACTIVATION BLOCKED");
    expect(template.target.build.provenanceEvidenceSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(template.activationApproval).toMatchObject({
      schemaVersion: "site-logbook.production-activation-approval/v1",
      confirmation: "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    });
    for (const artifact of [
      template.intent,
      template.execution,
      template.steady,
      template.release,
    ]) {
      expect(artifact.productionTargetsTouched).toBe(false);
      expect(artifact.authorizesApplicationStart).toBe(false);
    }
  });

  it("fails production direct-index startup before importing app or workers", () => {
    const index = source("artifacts/api-server/src/index.ts");
    const preflight = index.indexOf("runProductionActivationRuntimePreflight");
    const appImport = index.indexOf('import("./app")');
    const listen = index.indexOf("app.listen");
    const worker = index.indexOf('import("./lib/extraction-worker")');
    expect(preflight).toBeGreaterThan(0);
    expect(appImport).toBeGreaterThan(preflight);
    expect(worker).toBeGreaterThan(preflight);
    expect(listen).toBeGreaterThan(appImport);
    expect(index).not.toContain('import app from "./app"');
    expect(index).toContain("requireEmbeddedProductionBuildSha");
    expect(index).toContain("requiresReleaseStartupGuard");
    expect(index).not.toContain('if (process.env.NODE_ENV === "production")');
    expect(index).toContain("startProductionApplicationRuntime");
    expect(index).toContain("PRODUCTION_RUNTIME_ACTIVATION_AUTHORITY_REQUIRED");
    expect(index).not.toContain("requireObservedProductionHostRunner");
    expect(index).not.toContain("runProductionStartupPreflight");
    expect(index).toContain("pathToFileURL(path.resolve(process.argv[1]))");
    expect(index).toContain("verifyLiveProductionAuditReadiness");
    expect(index).toContain("STAGING_CONTROL_PLANE_IMAGE_REQUIRED");
    expect(index).toContain("startProductionRuntimeFailStop");
    const entrypoint = source(
      "artifacts/api-server/src/production-api-entrypoint.ts",
    );
    expect(entrypoint).not.toContain(
      "PRODUCTION_EXPECTED_DESIRED_CONFIG_SHA256",
    );
    expect(entrypoint).not.toContain(
      "PRODUCTION_EXPECTED_DEPLOYED_CONFIG_SHA256",
    );
    expect(entrypoint).not.toContain(
      "PRODUCTION_EXPECTED_RESOLVED_COMPOSE_SHA256",
    );
    expect(entrypoint).toContain("startProductionApplicationRuntime(release)");
    expect(index.indexOf("startProductionRuntimeFailStop({")).toBeLessThan(
      index.indexOf("startWorker(backup.startBackupScheduler)"),
    );
    expect(index.indexOf("stopWorkers();")).toBeLessThan(
      index.indexOf("server.close("),
    );
    expect(index).toContain("shutdownExitCode = Math.max");
    expect(index).toContain("requestShutdown(1, reason)");
    expect(index).toContain("stopAndWaitForVerdict");
    expect(index).toContain("PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_MS");
    expect(index).toContain(
      'if (runtimeState === "tripped") shutdownExitCode = 1',
    );
    expect(index).toContain("process.exit(shutdownExitCode)");
  });

  it("binds raw predecessor v4 bytes to a separately trusted digest", () => {
    const checker = source("scripts/check-audit-0107-release-evidence.mjs");
    expect(checker).toContain("decodeRawJsonArtifact");
    expect(checker).toContain("AUDIT_0107_PREDECESSOR_V4_EVIDENCE_B64");
    expect(checker).toContain("AUDIT_0107_PREDECESSOR_V4_EVIDENCE_SHA256");
    expect(checker).toContain(
      "AUDIT_0107_EXPECTED_PREDECESSOR_V4_EVIDENCE_SHA256",
    );
    expect(checker).toContain("predecessorArtifact.value.schemaVersion");
  });

  it("refreshes live database/schema identity and exposes secret-free parity", () => {
    const health = source("artifacts/api-server/src/routes/health.ts");
    const adapter = source(
      "artifacts/api-server/src/lib/production-audit-readiness.ts",
    );
    expect(adapter).toContain("verifyProductionAuditSchemaReadiness");
    expect(health).toContain("readProductionRuntimeReadinessState");
    expect(health).toContain("productionRuntimeLatchAllowsReadiness");
    expect(health).toContain("unavailableProductionControlParity");
    expect(health).toContain("process.env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT");
    const healthz = health.indexOf('router.get("/healthz"');
    const latch = health.indexOf(
      "if (!productionRuntimeLatchAllowsReadiness())",
      healthz,
    );
    const dbProbe = health.indexOf("await checkDbLatency()", healthz);
    expect(latch).toBeGreaterThan(healthz);
    expect(latch).toBeLessThan(dbProbe);
    expect(health.slice(latch, dbProbe)).toContain("res.status(503)");
    const finalLatch = health.indexOf(
      "productionRuntimeLatchAllowsReadiness();",
      dbProbe,
    );
    const finalResponse = health.indexOf(
      "res.status(ready ? 200 : 503)",
      dbProbe,
    );
    expect(finalLatch).toBeGreaterThan(dbProbe);
    expect(finalLatch).toBeLessThan(finalResponse);
    expect(health).toContain("productionRuntimeBindingMatches");
    expect(health).toContain("readProductionRuntimeHealthProjection");
    expect(health).toContain(
      "SELECT created_at, hash FROM drizzle.__drizzle_migrations",
    );
  });

  it("keeps the staging control-plane publisher explicit", () => {
    const workflow = source(".github/workflows/staging-images.yml");
    expect(workflow.match(/target: control-plane/g)).toHaveLength(2);
    const staging = source("docker-compose.staging.yml");
    expect(staging).toContain("SITE_LOGBOOK_RUNTIME_ENVIRONMENT: staging");
  });
});
