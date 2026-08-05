import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("R16-C2 authenticated external account surface", () => {
  it("keeps management internal, step-up protected, strict and idempotent", () => {
    const route = read("artifacts/api-server/src/routes/external-accounts.ts");
    const policy = read(
      "artifacts/api-server/src/lib/api-route-access-policy.ts",
    );

    expect(policy).toContain('prefixes: ["/external-accounts"]');
    expect(route).toContain('requirePermission("users.manage")');
    expect(route.match(/requireVaultStepUp/g)?.length).toBeGreaterThanOrEqual(
      6,
    );
    expect(route).toContain('req.get("Idempotency-Key")');
    expect(route).not.toContain("crypto.randomUUID");
    expect(route).toContain("z.strictObject");
    expect(route).toContain("bcrypt.hash(body.data.password, 12)");
    expect(route).not.toContain("password: body.data.password");
  });

  it("scopes portal data in SQL and exposes only a redacted network-only DTO", () => {
    const service = read(
      "artifacts/api-server/src/lib/external-portal-service.ts",
    );
    const route = read("artifacts/api-server/src/routes/external-portal.ts");

    expect(service).toContain("a.user_id = ${externalUserId}");
    expect(service).toContain("a.status = 'active'");
    expect(service).toContain("a.access_expires_at > now()");
    expect(service).toContain("s.revoked_at is null");
    expect(service).toContain("s.starts_at <= now()");
    expect(service).toContain("s.expires_at > now()");
    expect(service).toContain("s.id = ${scopeId ?? null}");
    expect(service).not.toMatch(/price|notes|token|object_path|billing/i);
    expect(route).toContain('cacheMode: "network-only"');
    expect(route).toContain('req.auth?.accountType === "external"');
  });

  it("isolates the external frontend from internal layout, SSE and offline queue", () => {
    const app = read("artifacts/stavba/src/App.tsx");
    const auth = read("artifacts/stavba/src/hooks/use-auth.tsx");
    const identity = read("artifacts/stavba/src/lib/identity-fetch.ts");
    const portal = read("artifacts/stavba/src/pages/external-portal.tsx");

    expect(app).toContain('user?.accountType === "external"');
    expect(app.indexOf('user?.accountType === "external"')).toBeGreaterThan(
      app.indexOf("if (!isAuthenticated)"),
    );
    expect(portal).not.toContain("useLiveUpdates");
    expect(portal).not.toContain("OfflineQueueProvider");
    expect(portal).not.toContain("<Layout");
    expect(portal).toContain("Pouze online");
    expect(auth).toContain('data.cacheMode === "network-only"');
    expect(identity).toContain("networkOnlyIdentity");
    expect(identity).toContain("if (activeScope)");
  });

  it("keeps auth-aware PWA controls inside AuthProvider", () => {
    const app = read("artifacts/stavba/src/App.tsx");
    const providerStart = app.indexOf("<AuthProvider>");
    const prompt = app.indexOf("<PublicAwarePwaUpdatePrompt />", providerStart);
    const providerEnd = app.indexOf("</AuthProvider>", providerStart);

    expect(providerStart).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(providerStart);
    expect(providerEnd).toBeGreaterThan(prompt);
  });

  it("ships dark defaults, registered routes and an OpenAPI contract", () => {
    const env = read(".env.example");
    const stagingEnv = read(".env.staging.example");
    const compose = read("docker-compose.yml");
    const stagingCompose = read("docker-compose.staging.yml");
    const manifest = read(
      "artifacts/api-server/src/generated/api-route-manifest.ts",
    );
    const openapi = read("lib/api-spec/openapi.yaml");

    expect(env).toContain("EXTERNAL_ACCOUNTS_ENABLED=false");
    expect(stagingEnv).toContain("STAGING_EXTERNAL_ACCOUNTS_ENABLED=false");
    expect(compose).toContain("${EXTERNAL_ACCOUNTS_ENABLED:-false}");
    expect(stagingCompose).toContain(
      "${STAGING_EXTERNAL_ACCOUNTS_ENABLED:?set false for the external account dark rollout}",
    );
    expect(manifest).toContain('template: "/external-accounts"');
    expect(manifest).toContain('template: "/portal/resources"');
    expect(openapi).toContain("/external-accounts/{id}/activate:");
    expect(openapi).toContain("/portal/resources/{scopeId}:");
    expect(openapi).toContain("ExternalPortalResourceList:");
  });
});
