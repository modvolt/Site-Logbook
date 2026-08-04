import { request } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  asRecord,
  r14AuthFile,
  r14BootstrapFile,
  r14Environment,
} from "./runtime";

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(r14AuthFile), { recursive: true });
  const context = await request.newContext({ baseURL: r14Environment.baseURL });
  try {
    const healthResponse = await context.get("/api/healthz");
    if (healthResponse.status() !== 200) {
      throw new Error(
        `R14 readiness failed with HTTP ${healthResponse.status()}.`,
      );
    }
    const health = asRecord(await healthResponse.json(), "R14 readiness");
    if (
      health.status !== "ok" ||
      health.dbStatus !== "ok" ||
      health.migrationParity !== true ||
      health.version !== r14Environment.sourceSha
    ) {
      throw new Error("R14 readiness does not match the exact-SHA contract.");
    }

    const before = asRecord(
      await (await context.get("/api/auth/me")).json(),
      "R14 pre-setup identity",
    );
    if (before.authenticated !== false || before.needsSetup !== true) {
      throw new Error(
        "R14 database is not a fresh disposable first-run database.",
      );
    }

    const setup = await context.post("/api/auth/setup", {
      data: {
        username: r14Environment.adminUsername,
        password: r14Environment.adminPassword,
        name: "R14 Hermetic Administrator",
        email: "r14-admin@site-logbook.invalid",
      },
    });
    if (setup.status() !== 201) {
      throw new Error(
        `R14 first-admin setup failed with HTTP ${setup.status()}.`,
      );
    }

    const meResponse = await context.get("/api/auth/me");
    const me = asRecord(await meResponse.json(), "R14 admin identity");
    if (
      meResponse.status() !== 200 ||
      me.authenticated !== true ||
      typeof me.offlineScope !== "string" ||
      !/^[0-9a-f]{64}$/.test(me.offlineScope)
    ) {
      throw new Error(
        "R14 admin identity lacks the server-issued offline scope.",
      );
    }

    await context.storageState({ path: r14AuthFile });
    fs.writeFileSync(
      r14BootstrapFile,
      `${JSON.stringify(
        {
          sourceSha: r14Environment.sourceSha,
          capturedAt: new Date().toISOString(),
          readiness: health,
          admin: { authenticated: true, offlineScopeSha256: me.offlineScope },
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
