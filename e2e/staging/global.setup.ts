import { request } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { safeStagingReleaseSummary } from "../../scripts/staging-release-guard.cjs";
import {
  asRecord,
  stagingAuthFile,
  stagingBootstrapSummaryFile,
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

    await context.storageState({ path: stagingAuthFile });
    fs.writeFileSync(
      stagingBootstrapSummaryFile,
      `${JSON.stringify(
        {
          ...safeStagingReleaseSummary(stagingEnvironment),
          capturedAt: new Date().toISOString(),
          readiness: {
            status: health.status,
            dbStatus: health.dbStatus,
            migrationParity: health.migrationParity,
            version: health.version,
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
