import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { asRecord, r14BrowserEvidenceFile, r14Environment } from "./runtime";

const evidence: Record<string, unknown> = {
  sourceSha: r14Environment.sourceSha,
  scenarios: {},
  diagnostics: { consoleProblems: [], pageErrors: [], nonLoopbackRequests: [] },
};

function recordScenario(
  name: string,
  value: Record<string, unknown> = { passed: true },
) {
  (evidence.scenarios as Record<string, unknown>)[name] = value;
}

async function offlineScope(context: APIRequestContext): Promise<string> {
  const response = await context.get("/api/auth/me");
  expect(response.status()).toBe(200);
  const me = asRecord(await response.json(), "Authenticated identity");
  expect(me.authenticated).toBe(true);
  expect(me.offlineScope).toMatch(/^[0-9a-f]{64}$/);
  return String(me.offlineScope);
}

async function scopedHeaders(
  context: APIRequestContext,
  mutation = false,
  contentSha256?: string,
): Promise<Record<string, string>> {
  return {
    "X-Stavba-Offline-Scope": await offlineScope(context),
    ...(mutation ? { "Idempotency-Key": `r14:${randomUUID()}` } : {}),
    ...(contentSha256 ? { "X-Stavba-Content-Sha256": contentSha256 } : {}),
  };
}

test.afterAll(() => {
  fs.mkdirSync(path.dirname(r14BrowserEvidenceFile), { recursive: true });
  fs.writeFileSync(
    r14BrowserEvidenceFile,
    `${JSON.stringify({ ...evidence, capturedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
});

test.describe.serial("R14 isolated full-stack acceptance", () => {
  let markerJobId = 0;
  let objectPath = "";

  test("exact-SHA readiness and deep diagnostics are healthy", async ({
    request,
  }) => {
    const readiness = await request.get("/api/healthz");
    expect(readiness.status()).toBe(200);
    const health = asRecord(await readiness.json(), "Public readiness");
    expect(health).toMatchObject({
      status: "ok",
      dbStatus: "ok",
      migrationParity: true,
      version: r14Environment.sourceSha,
    });

    const diagnostics = await request.get("/api/admin/health", {
      headers: await scopedHeaders(request),
    });
    expect(diagnostics.status()).toBe(200);
    const deep = asRecord(await diagnostics.json(), "Admin diagnostics");
    expect(deep.apiVersion).toBe(r14Environment.sourceSha);
    expect(deep.migrationParity).toBe(true);
    expect(deep.appliedMigrations).toBe(deep.expectedMigrations);
    expect(deep.missingMigrationTags).toEqual([]);
    expect(deep.dbStatus).toBe("ok");
    expect(deep.storageStatus).toBe("ok");
    expect(deep.storageIsDevFallback).toBe(false);
    expect(deep.smtpStatus).toBe("configured");
    expect(deep.imapStatus).toBe("configured");
    expect(deep.aiStatus).toBe("ready");
    recordScenario("exactShaAndDeepHealth", {
      passed: true,
      migrations: deep.appliedMigrations,
    });
  });

  test("SMTP, IMAP, and AI integrations use deterministic in-network providers", async ({
    request,
  }) => {
    const smtp = await request.post("/api/email-settings/test", {
      headers: await scopedHeaders(request, true),
      data: { to: "r14-recipient@site-logbook.invalid" },
    });
    expect(smtp.status()).toBe(200);
    expect(await smtp.json()).toMatchObject({ sent: true });

    const imap = await request.post("/api/email-import-settings/test", {
      headers: await scopedHeaders(request, true),
    });
    expect(imap.status()).toBe(200);
    expect(await imap.json()).toMatchObject({
      ok: true,
      folder: "INBOX",
      messages: 0,
    });

    const ai = await request.post("/api/billing/ai-extraction/test", {
      headers: await scopedHeaders(request, true),
    });
    expect(ai.status()).toBe(200);
    expect(await ai.json()).toMatchObject({ ok: true });

    recordScenario("providerHealthyPaths", {
      passed: true,
      smtp: true,
      imap: true,
      ai: true,
    });
  });

  test("job and linked private object survive the real API, PostgreSQL, and S3 path", async ({
    request,
  }) => {
    const markerTitle = `R14 full-stack marker ${r14Environment.sourceSha.slice(0, 12)}`;
    const jobResponse = await request.post("/api/jobs", {
      headers: await scopedHeaders(request, true),
      data: {
        title: markerTitle,
        type: "planned_work",
        date: "2042-01-14",
        status: "planned",
      },
    });
    expect(jobResponse.status()).toBe(201);
    const job = asRecord(await jobResponse.json(), "Created marker job");
    markerJobId = Number(job.id);
    expect(markerJobId).toBeGreaterThan(0);

    const payload = Buffer.from(
      `R14 object ${r14Environment.sourceSha}\n`,
      "utf8",
    );
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const upload = await request.post(
      "/api/storage/uploads?name=r14-marker.txt&contentType=text%2Fplain",
      {
        headers: {
          ...(await scopedHeaders(request, true, sha256)),
          "Content-Type": "text/plain",
        },
        data: payload,
      },
    );
    expect(upload.status()).toBe(200);
    objectPath = String(asRecord(await upload.json(), "R14 upload").objectPath);
    expect(objectPath).toMatch(/^\/objects\/uploads\/v2\/[0-9a-f-]+$/);

    const attachment = await request.post(
      `/api/jobs/${markerJobId}/attachments`,
      {
        headers: await scopedHeaders(request, true),
        data: {
          type: "manual_item",
          fileName: "r14-marker.txt",
          url: objectPath,
          description: "R14 synthetic recovery marker",
        },
      },
    );
    expect(attachment.status()).toBe(201);

    const download = await request.get(`/api/storage${objectPath}`, {
      headers: await scopedHeaders(request),
    });
    expect(download.status()).toBe(200);
    expect(Buffer.compare(await download.body(), payload)).toBe(0);
    recordScenario("postgresAndS3DataPath", {
      passed: true,
      markerJobId,
      objectSha256: sha256,
    });
  });

  test("guest authorization is denied by the server and in a real browser session", async ({
    request,
    browser,
  }) => {
    const createGuest = await request.post("/api/users", {
      headers: await scopedHeaders(request, true),
      data: {
        username: r14Environment.guestUsername,
        password: r14Environment.guestPassword,
        name: "R14 Guest",
        role: "guest",
        isActive: true,
      },
    });
    expect(createGuest.status()).toBe(201);

    const guestApi = await playwrightRequest.newContext({
      baseURL: r14Environment.baseURL,
    });
    try {
      const login = await guestApi.post("/api/auth/login", {
        data: {
          username: r14Environment.guestUsername,
          password: r14Environment.guestPassword,
        },
      });
      expect(login.status()).toBe(200);
      const guestScope = await offlineScope(guestApi);
      const deniedHealth = await guestApi.get("/api/admin/health", {
        headers: { "X-Stavba-Offline-Scope": guestScope },
      });
      expect(deniedHealth.status()).toBe(403);
      const deniedCreate = await guestApi.post("/api/jobs", {
        headers: {
          "X-Stavba-Offline-Scope": guestScope,
          "Idempotency-Key": `r14:${randomUUID()}`,
        },
        data: {
          title: "must not exist",
          type: "planned_work",
          date: "2042-01-15",
          status: "planned",
        },
      });
      expect(deniedCreate.status()).toBe(403);

      const guestState = await guestApi.storageState();
      const guestBrowser = await browser.newContext({
        storageState: guestState,
      });
      try {
        const page = await guestBrowser.newPage();
        const response = await page.goto("/admin/health", {
          waitUntil: "domcontentloaded",
        });
        expect(response?.status()).toBe(200);
        const browserDenied = await page.evaluate(async () => {
          const me = await fetch("/api/auth/me", {
            credentials: "same-origin",
          }).then((r) => r.json());
          return fetch("/api/admin/health", {
            credentials: "same-origin",
            headers: { "X-Stavba-Offline-Scope": me.offlineScope },
          }).then((r) => r.status);
        });
        expect(browserDenied).toBe(403);
      } finally {
        await guestBrowser.close();
      }
    } finally {
      await guestApi.dispose();
    }
    recordScenario("guestServerAuthorization", { passed: true });
  });

  test("admin PWA registers its service worker without browser or egress errors", async ({
    page,
  }) => {
    const diagnostics = evidence.diagnostics as Record<string, unknown[]>;
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.consoleProblems.push(message.text());
    });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)
      ) {
        diagnostics.nonLoopbackRequests.push(
          `${request.method()} ${url.origin}${url.pathname}`,
        );
      }
    });

    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("#root")).toBeVisible();
    await expect(page).toHaveTitle(/Stavba.*Evidence zakázek/i);
    const authenticated = await page.evaluate(async () =>
      fetch("/api/auth/me", { credentials: "same-origin" }).then((r) =>
        r.json(),
      ),
    );
    expect(authenticated.authenticated).toBe(true);
    const serviceWorkerActive = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const ready = navigator.serviceWorker.ready.then((registration) =>
        Boolean(registration.active),
      );
      return Promise.race([
        ready,
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 10_000),
        ),
      ]);
    });
    expect(serviceWorkerActive).toBe(true);
    expect(diagnostics.consoleProblems).toEqual([]);
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.nonLoopbackRequests).toEqual([]);
    recordScenario("pwaBrowser", { passed: true, serviceWorkerActive: true });
  });
});
