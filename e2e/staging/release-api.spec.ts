import { expect, test } from "@playwright/test";
import { asRecord, stagingEnvironment } from "./runtime";

test("public readiness is healthy and pinned to the expected commit", async ({
  request,
}) => {
  const response = await request.get("/api/healthz");
  expect(response.status()).toBe(200);
  const health = asRecord(await response.json(), "Public readiness");
  expect(health.status).toBe("ok");
  expect(health.dbStatus).toBe("ok");
  expect(health.migrationParity).toBe(true);
  expect(health.version).toBe(stagingEnvironment.expectedBuildSha);
});

test("isolated admin identity and deep diagnostics pass", async ({
  request,
}) => {
  const meResponse = await request.get("/api/auth/me");
  expect(meResponse.status()).toBe(200);
  const me = asRecord(await meResponse.json(), "Authenticated identity");
  expect(me.authenticated).toBe(true);

  // This endpoint intentionally runs a write/delete object-storage probe. The
  // staging guard requires a separate explicit confirmation before this suite starts.
  const healthResponse = await request.get("/api/admin/health");
  expect(healthResponse.status()).toBe(200);
  const health = asRecord(await healthResponse.json(), "Admin diagnostics");
  expect(health.apiVersion).toBe(stagingEnvironment.expectedBuildSha);
  expect(health.migrationParity).toBe(true);
  expect(health.dbStatus).toBe("ok");
  expect(health.storageStatus).toBe("ok");
  expect(health.storageIsDevFallback).toBe(false);
  expect(health.smtpStatus).toBe("configured");
  expect(health.latestExpectedTag).toBe("0105_smooth_nitro");
  expect(health.expectedMigrations).toBe(105);
  expect(health.appliedMigrations).toBe(105);
  expect(health.missingMigrationTags).toEqual([]);
});

test("external accounts remain disabled and empty during dark rollout", async ({
  request,
}) => {
  const response = await request.get(
    "/api/external-accounts?status=all&limit=1",
  );
  expect(response.status()).toBe(200);
  const inventory = asRecord(
    await response.json(),
    "External account dark-rollout inventory",
  );
  expect(inventory.runtimeEnabled).toBe(false);
  expect(inventory.items).toEqual([]);
});

test("deployed PWA manifest and service worker assets are reachable", async ({
  request,
}) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest",
  );
  const manifest = asRecord(await manifestResponse.json(), "PWA manifest");
  expect(manifest.name).toBe("Modvolt Site Logbook");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");

  const serviceWorkerResponse = await request.get("/sw.js");
  expect(serviceWorkerResponse.status()).toBe(200);
  expect((await serviceWorkerResponse.body()).byteLength).toBeGreaterThan(0);
});
