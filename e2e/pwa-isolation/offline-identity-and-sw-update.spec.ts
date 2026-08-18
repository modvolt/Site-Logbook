import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ALICE_SCOPE = "a".repeat(64);
const BOB_SCOPE = "b".repeat(64);
const ALICE_MARKER = "ALICE_ONLY_R14";
const BOB_MARKER = "BOB_ONLY_R14";
const SYNTHETIC_PASSWORD = "R14-local-only";
const LOOPBACK_PORT = Number(process.env.PWA_ISOLATION_PORT ?? 4192);
const EVIDENCE_PATH = path.resolve(
  __dirname,
  "../test-results/pwa-isolation/evidence.json",
);
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "../../docs/audit/evidence/14-a",
);

interface ServerState {
  swVersion: number;
  requests: Array<{ method: string; path: string; identity: string }>;
  mutationAttempts: Array<{
    identity: string;
    suppliedScope: string;
    idempotencyKey: string;
    bodySha256: string;
    fingerprint: string;
  }>;
  ledgerCount: number;
  effectCount: number;
  effects: Array<{ identity: string; idempotencyKey: string; bodySha256: string }>;
  replays: number;
  logoutCompletions: number;
  scopeRejections: Array<{ path: string; code: string }>;
  heldMutation: boolean;
}

interface Diagnostics {
  label: string;
  offline: boolean;
  allowExpectedUnauthorizedConsole: boolean;
  allowExpectedScopeConsole: boolean;
  expectedAuthTransitionAbortPaths: string[];
  consoleProblems: string[];
  pageErrors: string[];
  unexpectedFailures: string[];
  nonLoopbackRequests: string[];
}

const evidence: {
  sourceSha: string;
  browserVersions: string[];
  scenarios: Record<string, unknown>;
  diagnostics: Diagnostics[];
  viewports: Array<{ name: string; width: number; height: number; screenshot: string }>;
  cleanup: { browserOriginCleared: boolean; serverClosed?: boolean };
} = {
  sourceSha: process.env.R14_SOURCE_SHA ?? "local-working-tree",
  browserVersions: [],
  scenarios: {},
  diagnostics: [],
  viewports: [],
  cleanup: { browserOriginCleared: false },
};

function installDiagnostics(page: Page, label: string): Diagnostics {
  const diagnostics: Diagnostics = {
    label,
    offline: false,
    allowExpectedUnauthorizedConsole: false,
    allowExpectedScopeConsole: false,
    expectedAuthTransitionAbortPaths: [],
    consoleProblems: [],
    pageErrors: [],
    unexpectedFailures: [],
    nonLoopbackRequests: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      if (
        diagnostics.allowExpectedUnauthorizedConsole &&
        /Failed to load resource.*401.*Unauthorized/i.test(message.text())
      ) return;
      if (
        diagnostics.allowExpectedScopeConsole &&
        /Failed to load resource.*(?:409|428)/i.test(message.text())
      ) return;
      diagnostics.consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") diagnostics.nonLoopbackRequests.push(request.url());
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const errorText = request.failure()?.errorText ?? "unknown";
    const expectedOfflineFailure =
      diagnostics.offline &&
      url.hostname === "127.0.0.1" &&
      (url.pathname === "/api/events" || url.pathname === "/api/jobs/42") &&
      /INTERNET_DISCONNECTED|FAILED/i.test(errorText);
    const expectedLifecycleAbort =
      url.hostname === "127.0.0.1" &&
      /ABORTED/i.test(errorText) &&
      (url.pathname === "/api/events" ||
        (request.method() === "POST" && url.pathname === "/api/auth/logout"));
    const expectedAuthTransitionAbort =
      diagnostics.expectedAuthTransitionAbortPaths.includes(url.pathname) &&
      request.method() === "GET" &&
      url.hostname === "127.0.0.1" &&
      url.pathname.startsWith("/api/") &&
      /ABORTED/i.test(errorText);
    if (!expectedOfflineFailure && !expectedLifecycleAbort && !expectedAuthTransitionAbort) {
      diagnostics.unexpectedFailures.push(`${request.method()} ${url.pathname}: ${errorText}`);
    }
  });
  evidence.diagnostics.push(diagnostics);
  return diagnostics;
}

async function resetServer(request: APIRequestContext): Promise<void> {
  const response = await request.post("/__test/reset");
  expect(response.ok()).toBe(true);
}

async function serverState(request: APIRequestContext): Promise<ServerState> {
  const response = await request.get("/__test/state");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ServerState;
}

async function setFaults(
  request: APIRequestContext,
  faults: {
    holdFirstMutation?: boolean;
    dropFirstResponseAfterCommit?: boolean;
    delayBobToday?: boolean;
    jobResponseScopeFault?: "none" | "missing" | "mismatch";
  },
): Promise<void> {
  const response = await request.post("/__test/faults", { data: faults });
  expect(response.ok()).toBe(true);
}

async function login(page: Page, username: "alice" | "bob"): Promise<void> {
  await expect(page.getByRole("button", { name: "Přihlásit se" })).toBeVisible();
  await page.getByLabel("Uživatelské jméno").fill(username);
  await page.getByLabel("Heslo").fill(SYNTHETIC_PASSWORD);
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(page.getByText(username === "alice" ? ALICE_MARKER : BOB_MARKER)).toBeVisible();
}

async function waitForServiceWorker(page: Page, expected = "R14_SW_V1"): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            if (!("serviceWorker" in navigator)) return null;
            await navigator.serviceWorker.ready;
            return navigator.serviceWorker.controller?.scriptURL ?? null;
          });
        } catch {
          // The update prompt intentionally reloads the page. A destroyed
          // execution context during that navigation means "not ready yet".
          return null;
        }
      },
      { timeout: 15_000 },
    )
    .toContain("/sw.js");
  await expect.poll(() => serviceWorkerVersion(page), { timeout: 10_000 }).toBe(expected);
}

async function serviceWorkerVersion(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(async () => {
      const controller = navigator.serviceWorker?.controller;
      if (!controller) return null;
      return new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          navigator.serviceWorker.removeEventListener("message", onMessage);
          resolve(null);
        }, 2_000);
        function onMessage(event: MessageEvent<{ type?: string; version?: string }>) {
          if (event.data?.type !== "R14_SW_VERSION") return;
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener("message", onMessage);
          resolve(event.data.version ?? null);
        }
        navigator.serviceWorker.addEventListener("message", onMessage);
        controller.postMessage({ type: "R14_GET_VERSION" });
      });
    });
  } catch {
    return null;
  }
}

async function setOffline(
  context: BrowserContext,
  pages: Array<{ page: Page; diagnostics: Diagnostics }>,
  offline: boolean,
): Promise<void> {
  for (const entry of pages) entry.diagnostics.offline = offline;
  await context.setOffline(offline);
  for (const entry of pages) {
    const banner = entry.page.getByText("Pracujete offline", { exact: true });
    if (offline) await expect(banner).toBeVisible();
    else await expect(banner).not.toBeVisible();
  }
}

async function seedOfflineOperation(
  page: Page,
  input: { id: string; userId: number; scope: string; nextAttemptAt?: number },
): Promise<void> {
  await page.evaluate(async ({ id, userId, scope, nextAttemptAt }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stavba-offline-v1", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("scoped-ops", "readwrite");
        transaction.objectStore("scoped-ops").put({
          storageKey: `${scope}:${id}`,
          id,
          type: "add_material",
          jobId: 42,
          payload: { name: `synthetic-${id}`, quantity: 1, unit: "ks", unitPrice: 10 },
          createdAt: Date.now(),
          attempts: 0,
          status: "pending",
          ownerUserId: userId,
          ownerScope: scope,
          ...(nextAttemptAt == null ? {} : { nextAttemptAt }),
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, input);
}

async function seedOfflineBlob(
  page: Page,
  input: { key: string; userId: number; scope: string; marker: string },
): Promise<void> {
  await page.evaluate(async ({ key, userId, scope, marker }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stavba-offline-v1", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("scoped-blobs", "readwrite");
        transaction.objectStore("scoped-blobs").put({
          storageKey: `${scope}:${key}`,
          key,
          blob: new Blob([marker], { type: "text/plain" }),
          fileName: `${key}.txt`,
          ownerUserId: userId,
          ownerScope: scope,
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, input);
}

async function scopedBlobCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stavba-offline-v1", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const rows = await new Promise<Array<{ ownerScope: string }>>((resolve, reject) => {
        const transaction = db.transaction("scoped-blobs", "readonly");
        const get = transaction.objectStore("scoped-blobs").getAll();
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      return rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.ownerScope] = (counts[row.ownerScope] ?? 0) + 1;
        return counts;
      }, {});
    } finally {
      db.close();
    }
  });
}

async function scopedOperationCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stavba-offline-v1", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const rows = await new Promise<Array<{ ownerScope: string }>>((resolve, reject) => {
        const transaction = db.transaction("scoped-ops", "readonly");
        const get = transaction.objectStore("scoped-ops").getAll();
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      return rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.ownerScope] = (counts[row.ownerScope] ?? 0) + 1;
        return counts;
      }, {});
    } finally {
      db.close();
    }
  });
}

async function makeOfflineOperationDue(page: Page, storageKey: string): Promise<void> {
  await page.evaluate(async ({ storageKey }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("stavba-offline-v1", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("scoped-ops", "readwrite");
        const store = transaction.objectStore("scoped-ops");
        const get = store.get(storageKey);
        get.onsuccess = () => {
          if (!get.result) {
            transaction.abort();
            reject(new Error(`Missing offline operation ${storageKey}`));
            return;
          }
          store.put({ ...get.result, nextAttemptAt: Date.now() - 1 });
        };
        get.onerror = () => reject(get.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { storageKey });
}

async function triggerEveryFlushPath(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: { type: "OFFLINE_FLUSH" },
    }));
  });
}

async function fetchJobMarker(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/jobs/42");
    if (!response.ok) throw new Error(`job marker request failed: ${response.status}`);
    const data = (await response.json()) as { ownerMarker: string };
    return data.ownerMarker;
  });
}

async function managedCacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await caches.keys()).filter((name) => name === "stavba-api" || name.startsWith("stavba-api-v2-")),
  );
}

async function assertDiagnosticsClean(...diagnostics: Diagnostics[]): Promise<void> {
  for (const result of diagnostics) {
    expect(result.consoleProblems, `${result.label} console`).toEqual([]);
    expect(result.pageErrors, `${result.label} page errors`).toEqual([]);
    expect(result.unexpectedFailures, `${result.label} request failures`).toEqual([]);
    expect(result.nonLoopbackRequests, `${result.label} non-loopback`).toEqual([]);
  }
}

async function assertVisibleStatesDoNotOcclude(
  viewport: { name: string; width: number; height: number },
  locators: Locator[],
): Promise<void> {
  const boxes = [];
  for (const locator of locators) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `${viewport.name} missing state bounds`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    boxes.push(box!);
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left];
      const b = boxes[right];
      const overlaps = a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y;
      expect(overlaps, `${viewport.name} state ${left} overlaps state ${right}`).toBe(false);
    }
  }
}

async function cleanupOrigin(page: Page): Promise<void> {
  const cleanup = await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const unregisterResults = await Promise.all(
      (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.unregister()),
    );
    const cacheResults = await Promise.all(
      (await caches.keys()).map((cacheName) => caches.delete(cacheName)),
    );
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase("stavba-offline-v1");
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("offline IndexedDB cleanup blocked"));
    });
    const databaseNames = typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map((database) => database.name)
      : [];
    return {
      unregisterResults,
      cacheResults,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      caches: (await caches.keys()).length,
      offlineDatabasePresent: databaseNames.includes("stavba-offline-v1"),
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length,
    };
  });
  expect(cleanup.unregisterResults.every(Boolean)).toBe(true);
  expect(cleanup.cacheResults.every(Boolean)).toBe(true);
  expect(cleanup).toMatchObject({
    registrations: 0,
    caches: 0,
    offlineDatabasePresent: false,
    localStorage: 0,
    sessionStorage: 0,
  });
}

test.describe.serial("R14-A real-browser PWA identity and offline isolation", () => {
  test.beforeEach(async ({ context }) => {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const allowed = url.protocol === "http:"
        && url.hostname === "127.0.0.1"
        && url.port === String(LOOPBACK_PORT);
      if (allowed) await route.continue();
      else await route.abort("blockedbyclient");
    });
  });

  test.afterEach(async ({ context, page }) => {
    await context.setOffline(false).catch(() => undefined);
    if (!page.isClosed()) await cleanupOrigin(page);
    evidence.cleanup.browserOriginCleared = true;
  });

  test.afterAll(async () => {
    await mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
    await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  });

  test("two tabs elect one replay executor and commit one effect", async ({
    browser,
    context,
    page,
    request,
  }) => {
    await resetServer(request);
    await setFaults(request, { holdFirstMutation: true });
    evidence.browserVersions.push(browser.version());
    const first = installDiagnostics(page, "lease-tab-a");
    await page.goto("/");
    await login(page, "alice");
    await waitForServiceWorker(page);

    const secondPage = await context.newPage();
    const second = installDiagnostics(secondPage, "lease-tab-b");
    await secondPage.goto("/");
    await expect(secondPage.getByText(ALICE_MARKER)).toBeVisible();

    await setOffline(context, [
      { page, diagnostics: first },
      { page: secondPage, diagnostics: second },
    ], true);
    const operationId = "r14-two-tabs-one-effect";
    await seedOfflineOperation(page, { id: operationId, userId: 101, scope: ALICE_SCOPE });

    for (const result of [first, second]) result.offline = false;
    await context.setOffline(false);
    await expect.poll(async () => (await serverState(request)).mutationAttempts.length).toBe(1);
    await expect.poll(async () => (await serverState(request)).heldMutation).toBe(true);
    await triggerEveryFlushPath(page);
    await triggerEveryFlushPath(secondPage);
    await expect.poll(async () => (await serverState(request)).mutationAttempts.length, {
      timeout: 1_500,
      intervals: [100, 250, 500],
    }).toBe(1);

    const release = await request.post("/__test/release-mutation");
    expect(release.ok()).toBe(true);
    await expect.poll(async () => (await serverState(request)).effectCount).toBe(1);
    await expect.poll(async () => (await scopedOperationCounts(page))[ALICE_SCOPE] ?? 0).toBe(0);

    const finalState = await serverState(request);
    expect(finalState.ledgerCount).toBe(1);
    expect(finalState.effectCount).toBe(1);
    expect(finalState.mutationAttempts).toHaveLength(1);
    expect(finalState.mutationAttempts[0]).toMatchObject({
      identity: "alice",
      suppliedScope: ALICE_SCOPE,
      idempotencyKey: operationId,
    });
    evidence.scenarios.twoTabLease = {
      mutationAttempts: finalState.mutationAttempts.length,
      ledgerCount: finalState.ledgerCount,
      effectCount: finalState.effectCount,
      idempotencyKey: operationId,
    };
    await assertDiagnosticsClean(first, second);
  });

  test("post-commit response loss retries with the same key and one durable effect", async ({
    browser,
    context,
    page,
    request,
  }) => {
    await resetServer(request);
    await setFaults(request, { dropFirstResponseAfterCommit: true });
    evidence.browserVersions.push(browser.version());
    const diagnostics = installDiagnostics(page, "post-commit-loss");
    await page.goto("/");
    await login(page, "alice");
    await waitForServiceWorker(page);

    await setOffline(context, [{ page, diagnostics }], true);
    const operationId = "r14-post-commit-loss";
    await seedOfflineOperation(page, { id: operationId, userId: 101, scope: ALICE_SCOPE });
    diagnostics.offline = false;
    await context.setOffline(false);

    await expect.poll(async () => (await serverState(request)).effectCount).toBe(1);
    await expect.poll(async () => (await serverState(request)).mutationAttempts.length, {
      timeout: 20_000,
    }).toBe(2);
    await expect.poll(async () => (await scopedOperationCounts(page))[ALICE_SCOPE] ?? 0, {
      timeout: 20_000,
    }).toBe(0);

    const finalState = await serverState(request);
    expect(finalState.effectCount).toBe(1);
    expect(finalState.ledgerCount).toBe(1);
    expect(finalState.replays).toBe(1);
    expect(finalState.mutationAttempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      operationId,
      operationId,
    ]);
    expect(new Set(finalState.mutationAttempts.map((attempt) => attempt.fingerprint)).size).toBe(1);
    evidence.scenarios.postCommitLoss = {
      mutationAttempts: finalState.mutationAttempts.length,
      replays: finalState.replays,
      ledgerCount: finalState.ledgerCount,
      effectCount: finalState.effectCount,
      stableIdempotencyKey: true,
    };
    await assertDiagnosticsClean(diagnostics);
  });

  test("A to B switch, real service-worker update, and responsive states stay isolated", async ({
    browser,
    context,
    page,
    request,
  }) => {
    await resetServer(request);
    evidence.browserVersions.push(browser.version());
    const first = installDiagnostics(page, "identity-primary");
    await page.goto("/");
    await login(page, "alice");
    await waitForServiceWorker(page);
    expect(await fetchJobMarker(page)).toBe(ALICE_MARKER);
    await expect
      .poll(async () => {
        await fetchJobMarker(page);
        return managedCacheNames(page);
      })
      .toEqual([`stavba-api-v2-${ALICE_SCOPE}`]);

    const stalePage = await context.newPage();
    const stale = installDiagnostics(stalePage, "identity-stale-tab");
    await stalePage.goto("/");
    await expect(stalePage.getByText(ALICE_MARKER)).toBeVisible();

    await setOffline(context, [
      { page, diagnostics: first },
      { page: stalePage, diagnostics: stale },
    ], true);
    expect(await fetchJobMarker(page)).toBe(ALICE_MARKER);
    await seedOfflineOperation(page, {
      id: "r14-alice-locked",
      userId: 101,
      scope: ALICE_SCOPE,
      nextAttemptAt: Date.now() + 60 * 60 * 1000,
    });
    await seedOfflineBlob(page, {
      key: "r14-alice-photo",
      userId: 101,
      scope: ALICE_SCOPE,
      marker: ALICE_MARKER,
    });
    first.offline = false;
    stale.offline = false;
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByText(/1 akce čeká na odeslání/)).toBeVisible();

    const dialogPromise = page.waitForEvent("dialog");
    const logoutClickPromise = page.getByTitle("Odhlásit").click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain("1 neodeslaných offline akcí");
    await dialog.accept();
    await logoutClickPromise;
    await expect(page.getByRole("button", { name: "Přihlásit se" })).toBeVisible();
    await expect(stalePage.getByRole("button", { name: "Přihlásit se" })).toBeVisible();

    await login(page, "bob");
    await expect(stalePage.getByText(BOB_MARKER)).toBeVisible();
    await expect(page.getByText(/2 lokálních položek je bezpečně uzamčeno/)).toBeVisible();
    expect(await fetchJobMarker(page)).toBe(BOB_MARKER);
    await expect
      .poll(async () => {
        await fetchJobMarker(page);
        return managedCacheNames(page);
      })
      .toEqual([`stavba-api-v2-${BOB_SCOPE}`]);
    expect(await scopedOperationCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });
    expect(await scopedBlobCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });
    await makeOfflineOperationDue(page, `${ALICE_SCOPE}:r14-alice-locked`);
    await triggerEveryFlushPath(page);
    await triggerEveryFlushPath(stalePage);
    await expect.poll(async () => (await serverState(request)).mutationAttempts.length, {
      timeout: 2_000,
      intervals: [100, 250, 500, 750],
    }).toBe(0);
    expect(await scopedOperationCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });
    expect(await scopedBlobCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });

    await setOffline(context, [
      { page, diagnostics: first },
      { page: stalePage, diagnostics: stale },
    ], true);
    expect(await fetchJobMarker(page)).toBe(BOB_MARKER);
    expect(await fetchJobMarker(stalePage)).toBe(BOB_MARKER);
    first.offline = false;
    stale.offline = false;
    await context.setOffline(false);

    const versionResponse = await request.post("/__test/sw-version", { data: { version: 2 } });
    expect(versionResponse.ok()).toBe(true);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await expect(page.getByText("Nová verze je k dispozici")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("toast-title").filter({ hasText: "Vítej, bob" }))
      .not.toBeVisible({ timeout: 10_000 });

    await setOffline(context, [
      { page, diagnostics: first },
      { page: stalePage, diagnostics: stale },
    ], true);
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile-portrait", width: 390, height: 844 },
      { name: "mobile-landscape", width: 844, height: 390 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.getByText("Nová verze je k dispozici")).toBeVisible();
      await expect(page.getByText("Pracujete offline", { exact: true })).toBeVisible();
      await expect(page.getByText(/bezpečně uzamčeno/)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(1);
      const updateButton = page.getByRole("button", { name: "Aktualizovat" });
      await assertVisibleStatesDoNotOcclude(viewport, [
        page.getByText("Pracujete offline", { exact: true }),
        page.getByText(/bezpečně uzamčeno/),
        updateButton,
      ]);
      const screenshot = path.join(SCREENSHOT_DIR, `${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
      evidence.viewports.push({ ...viewport, screenshot: path.relative(process.cwd(), screenshot) });
    }

    first.offline = false;
    stale.offline = false;
    await context.setOffline(false);
    const updateButton = page.getByRole("button", { name: "Aktualizovat" });
    await updateButton.click();
    await expect.poll(async () => {
      try {
        return await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.waiting?.state ?? null;
        });
      } catch {
        return "navigation-in-progress";
      }
    }, { timeout: 10_000 }).toBeNull();
    await waitForServiceWorker(page, "R14_SW_V2");
    await expect(page.getByText(BOB_MARKER)).toBeVisible();
    await expect.poll(() => serviceWorkerVersion(stalePage), { timeout: 15_000 }).toBe("R14_SW_V2");

    await context.setOffline(true);
    first.offline = true;
    stale.offline = true;
    await expect(page.getByText("Pracujete offline", { exact: true })).toBeVisible();
    first.offline = false;
    stale.offline = false;
    await context.setOffline(false);
    await triggerEveryFlushPath(page);
    await triggerEveryFlushPath(stalePage);
    await expect.poll(async () => (await serverState(request)).mutationAttempts.length, {
      timeout: 2_000,
      intervals: [100, 250, 500, 750],
    }).toBe(0);

    const finalState = await serverState(request);
    expect(finalState.logoutCompletions).toBe(1);
    expect(finalState.mutationAttempts).toEqual([]);
    expect(finalState.effectCount).toBe(0);
    expect(await scopedOperationCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });
    expect(await scopedBlobCounts(page)).toEqual({ [ALICE_SCOPE]: 1 });
    expect(await managedCacheNames(page)).toEqual([`stavba-api-v2-${BOB_SCOPE}`]);
    evidence.scenarios.identityAndUpdate = {
      initialMarker: "R14_SW_V1",
      updatedMarker: "R14_SW_V2",
      aliceLockedOperations: 1,
      aliceLockedBlobs: 1,
      bobReplayAttemptsForAlice: 0,
      managedCacheScopes: [BOB_SCOPE],
      responsiveViewports: evidence.viewports.map(({ name, width, height }) => ({ name, width, height })),
    };
    await assertDiagnosticsClean(first, stale);
  });

  test("rolling versions and mismatched responses fail closed before body delivery", async ({
    browser,
    context,
    page,
    request,
  }) => {
    await resetServer(request);
    evidence.browserVersions.push(browser.version());
    const diagnostics = installDiagnostics(page, "rolling-compatibility");
    diagnostics.allowExpectedScopeConsole = true;
    diagnostics.expectedAuthTransitionAbortPaths = ["/api/auth/me"];
    await page.goto("/");
    await login(page, "alice");
    await waitForServiceWorker(page);
    expect(await fetchJobMarker(page)).toBe(ALICE_MARKER);
    await expect.poll(async () => {
      await fetchJobMarker(page);
      return managedCacheNames(page);
    }).toEqual([`stavba-api-v2-${ALICE_SCOPE}`]);

    await setFaults(request, { jobResponseScopeFault: "mismatch" });
    const mismatched = await page.evaluate(async () => {
      const response = await fetch("/api/jobs/42");
      return { status: response.status, body: await response.text() };
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body).toContain("offline_scope_mismatch");
    expect(mismatched.body).not.toContain(BOB_MARKER);

    await setFaults(request, { jobResponseScopeFault: "none" });
    await expect(page.getByText(ALICE_MARKER)).toBeVisible();
    await expect.poll(async () => {
      try {
        await fetchJobMarker(page);
        return managedCacheNames(page);
      } catch {
        return [];
      }
    }).toEqual([`stavba-api-v2-${ALICE_SCOPE}`]);

    await setFaults(request, { jobResponseScopeFault: "missing" });
    const missing = await page.evaluate(async () => {
      const response = await fetch("/api/jobs/42");
      return { status: response.status, body: await response.text() };
    });
    expect(missing.status).toBe(428);
    expect(missing.body).toContain("identity_scope_required");
    expect(missing.body).not.toContain(ALICE_MARKER);

    await setFaults(request, { jobResponseScopeFault: "none" });
    const oldClientAgainstNewApi = await context.request.get("/api/jobs/42");
    expect(oldClientAgainstNewApi.status()).toBe(428);
    expect(await oldClientAgainstNewApi.json()).toMatchObject({ code: "identity_scope_required" });
    const finalState = await serverState(request);
    expect(finalState.scopeRejections).toContainEqual({
      path: "/api/jobs/42",
      code: "identity_scope_required",
    });
    evidence.scenarios.rollingCompatibility = {
      mismatchedResponseStatus: mismatched.status,
      mismatchedIdentityBodyDelivered: mismatched.body.includes(BOB_MARKER),
      newServiceWorkerOldApiStatus: missing.status,
      oldClientNewApiStatus: oldClientAgainstNewApi.status(),
    };
    await assertDiagnosticsClean(diagnostics);
  });

  test("automatic session invalidation cannot expose Alice query data after Bob logs in", async ({
    browser,
    page,
    request,
  }) => {
    await resetServer(request);
    evidence.browserVersions.push(browser.version());
    const diagnostics = installDiagnostics(page, "automatic-session-transition");
    await page.goto("/");
    await login(page, "alice");
    await setFaults(request, { delayBobToday: true });
    const revoke = await request.post("/__test/revoke", { data: { username: "alice" } });
    expect(revoke.ok()).toBe(true);

    diagnostics.allowExpectedUnauthorizedConsole = true;
    diagnostics.expectedAuthTransitionAbortPaths = ["/api/auth/me", "/api/dashboard/today"];
    const loginButton = page.getByRole("button", { name: "Přihlásit se" });
    const refreshButton = page.getByRole("button", { name: "Obnovit dnešní práci" });
    if (!(await loginButton.isVisible())) {
      // A background read can observe the revoked session before the manual
      // refresh. In that valid race the refresh control is detached as the app
      // fails closed; the login assertion below remains authoritative.
      await refreshButton.click({ timeout: 2_000 }).catch(() => undefined);
    }
    await expect(loginButton).toBeVisible();
    await page.evaluate((aliceMarker) => {
      const target = window as typeof window & { __r14QueryLeaks?: string[] };
      target.__r14QueryLeaks = [];
      const observer = new MutationObserver(() => {
        if (document.body.textContent?.includes(aliceMarker)) target.__r14QueryLeaks?.push(aliceMarker);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }, ALICE_MARKER);

    await login(page, "bob");
    diagnostics.allowExpectedUnauthorizedConsole = false;
    diagnostics.expectedAuthTransitionAbortPaths = [];
    const leaks = await page.evaluate(() =>
      (window as typeof window & { __r14QueryLeaks?: string[] }).__r14QueryLeaks ?? [],
    );
    expect(leaks).toEqual([]);
    evidence.scenarios.automaticSessionTransition = {
      aliceMarkersObservedAfterBobLoginStarted: leaks.length,
      bobMarkerVisible: true,
    };
    await assertDiagnosticsClean(diagnostics);
  });
});
