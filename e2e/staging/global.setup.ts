import { request } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { safeStagingReleaseSummary } from "../../scripts/staging-release-guard.cjs";
import {
  asRecord,
  stagingAuthFile,
  stagingBootstrapSummaryFile,
  stagingEvidenceBindings,
  stagingEnvironment,
} from "./runtime";

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(stagingAuthFile), { recursive: true });
  fs.mkdirSync(path.dirname(stagingBootstrapSummaryFile), { recursive: true });

  const context = await request.newContext({
    baseURL: stagingEnvironment.baseURL,
    ignoreHTTPSErrors: false,
  });

  try {
    const healthResponse = await context.get("/api/healthz");
    if (healthResponse.status() !== 200) {
      throw new Error(
        `Staging bootstrap: readiness failed with HTTP ${healthResponse.status()}.`,
      );
    }
    const health = asRecord(await healthResponse.json(), "Staging readiness");
    if (
      health.status !== "ok" ||
      health.dbStatus !== "ok" ||
      health.migrationParity !== true ||
      health.version !== stagingEnvironment.expectedBuildSha
    ) {
      throw new Error(
        "Staging bootstrap: readiness or deployed commit does not match the release contract.",
      );
    }

    const loginResponse = await context.post("/api/auth/login", {
      data: {
        username: stagingEnvironment.adminUsername,
        password: stagingEnvironment.adminPassword,
      },
    });
    if (loginResponse.status() !== 200) {
      throw new Error(
        `Staging bootstrap: login failed with HTTP ${loginResponse.status()}.`,
      );
    }

    const meResponse = await context.get("/api/auth/me");
    if (meResponse.status() !== 200) {
      throw new Error(
        `Staging bootstrap: authenticated identity check failed with HTTP ${meResponse.status()}.`,
      );
    }
    const me = asRecord(await meResponse.json(), "Staging identity check");
    if (me.authenticated !== true) {
      throw new Error(
        "Staging bootstrap: the isolated admin session is not authenticated.",
      );
    }

    const adminHealthResponse = await context.get("/api/admin/health");
    if (adminHealthResponse.status() !== 200) {
      throw new Error(
        `Staging bootstrap: admin diagnostics failed with HTTP ${adminHealthResponse.status()}.`,
      );
    }
    const adminHealth = asRecord(
      await adminHealthResponse.json(),
      "Staging admin diagnostics",
    );
    if (
      adminHealth.latestExpectedTag !== "0105_smooth_nitro" ||
      adminHealth.expectedMigrations !== 105 ||
      adminHealth.appliedMigrations !== 105 ||
      adminHealth.migrationParity !== true ||
      !Array.isArray(adminHealth.missingMigrationTags) ||
      adminHealth.missingMigrationTags.length !== 0
    ) {
      throw new Error(
        "Staging bootstrap: migration 0105 is not the exact applied dark-rollout schema.",
      );
    }

    const externalAccountsResponse = await context.get(
      "/api/external-accounts?status=all&limit=1",
    );
    if (externalAccountsResponse.status() !== 200) {
      throw new Error(
        `Staging bootstrap: external account inventory failed with HTTP ${externalAccountsResponse.status()}.`,
      );
    }
    const externalAccounts = asRecord(
      await externalAccountsResponse.json(),
      "Staging external account inventory",
    );
    if (
      externalAccounts.runtimeEnabled !== false ||
      !Array.isArray(externalAccounts.items) ||
      externalAccounts.items.length !== 0
    ) {
      throw new Error(
        "Staging bootstrap: external accounts must remain disabled and empty during dark rollout.",
      );
    }

    await context.storageState({ path: stagingAuthFile });
    fs.writeFileSync(
      stagingBootstrapSummaryFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceSha: stagingEnvironment.expectedBuildSha,
          workflowRun: {
            id: stagingEvidenceBindings.runId,
            attempt: stagingEvidenceBindings.runAttempt,
          },
          bindings: {
            imageManifestSha256: stagingEvidenceBindings.imageManifestSha256,
            provisioningManifestSha256:
              stagingEvidenceBindings.provisioningManifestSha256,
            deploymentInputsSha256:
              stagingEvidenceBindings.deploymentInputsSha256,
          },
          ...safeStagingReleaseSummary(stagingEnvironment),
          capturedAt: new Date().toISOString(),
          readiness: {
            status: health.status,
            dbStatus: health.dbStatus,
            migrationParity: health.migrationParity,
            version: health.version,
            latestExpectedTag: adminHealth.latestExpectedTag,
            expectedMigrations: adminHealth.expectedMigrations,
            appliedMigrations: adminHealth.appliedMigrations,
            missingMigrationTags: [],
            excludedMigration0100Present: false,
            schemaAction: "steady-0105",
          },
          darkRollout: {
            externalAccountsEnabled: false,
            externalAccountCount: 0,
          },
          authenticated: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    await context.dispose();
  }
}
