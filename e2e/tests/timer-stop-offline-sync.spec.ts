import { test, expect } from "@playwright/test";

/**
 * Task #669 proved the server-side stop endpoint recomputes hours correctly.
 * This spec guards the client's offline-queue path itself: stopping a timer
 * while offline must enqueue a "stop_timer" op (use-offline-queue.tsx), and
 * that op must actually reach the server once connectivity returns — with a
 * visible error (not a silent drop) if the replay itself fails.
 */
test.describe("Offline-queued timer stop", () => {
  let jobId: number;
  let personId: number;
  let personName: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    personName = `E2E_OfflineStop_Person_${stamp}`;

    const personRes = await request.post("/api/people", {
      data: { name: personName },
    });
    expect(personRes.status()).toBe(201);
    personId = ((await personRes.json()) as { id: number }).id;

    const jobRes = await request.post("/api/jobs", {
      data: {
        title: `E2E_OfflineStop_Job_${stamp}`,
        date: "2026-06-27",
        type: "other",
        status: "planned",
      },
    });
    expect(jobRes.status()).toBe(201);
    jobId = ((await jobRes.json()) as { id: number }).id;
  });

  test.afterAll(async ({ request }) => {
    await request
      .delete(`/api/jobs/${jobId}/time-entries/${personId}`)
      .catch(() => {});
    if (jobId) await request.delete(`/api/jobs/${jobId}`).catch(() => {});
    if (personId) await request.delete(`/api/people/${personId}`).catch(() => {});
  });

  test("replays automatically once back online and updates hours without a manual refresh", async ({
    page,
    request,
    context,
  }) => {
    // Timer started while ONLINE (server holds timerStartedAt) — this is the
    // "fallback" branch in handleStop that must enqueue a real stop_timer op.
    await request.post(`/api/jobs/${jobId}/time-entries`, {
      data: { personId, hours: 0 },
    });
    const startRes = await request.post(
      `/api/jobs/${jobId}/time-entries/${personId}/start`,
    );
    expect(startRes.status()).toBe(200);

    await page.goto(`/jobs/${jobId}?testMode=1`);

    const row = page.locator("li").filter({ hasText: personName });
    await expect(row.getByRole("button", { name: "Stop" })).toBeVisible({
      timeout: 10_000,
    });

    // Go offline and confirm the app actually registered it before acting.
    await context.setOffline(true);
    await expect(page.getByText("Pracujete offline", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await row.getByRole("button", { name: "Stop" }).click();

    await expect(
      page.getByText("Zastavení časovače čeká na obnovení připojení", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Offline – 1 akce čeká na odeslání", { exact: true }),
    ).toBeVisible();

    // The op must persist in the row's UI while offline (Stop stays visible,
    // still "running") since the server side hasn't processed the stop yet.
    await expect(row.getByRole("button", { name: "Stop" })).toBeVisible();

    // Come back online — the queue should auto-flush without any user action.
    await context.setOffline(false);

    await expect(page.getByTestId("toast-title")).toHaveText(
      "Synchronizace dokončena",
      { timeout: 15_000 },
    );

    // UI reflects the stop WITHOUT a manual page reload.
    await expect(row.getByRole("button", { name: "Start" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(row.getByRole("button", { name: "Stop" })).not.toBeVisible();

    // Server-side truth: the queued stop actually reached the server (the
    // timer would still be "running" server-side if the request had been
    // silently dropped instead of replayed).
    const entriesRes = await request.get(`/api/jobs/${jobId}/time-entries`);
    expect(entriesRes.status()).toBe(200);
    const entries = (await entriesRes.json()) as Array<{
      personId: number;
      hours: number;
      timerStartedAt: string | null;
    }>;
    const entry = entries.find((e) => e.personId === personId);
    expect(entry?.timerStartedAt).toBeNull();
    expect(entry?.hours).toBeGreaterThanOrEqual(0);
  });

  test("a replay that fails server-side is surfaced to the user, never silently dropped", async ({
    page,
    request,
    context,
  }) => {
    await request.post(`/api/jobs/${jobId}/time-entries`, {
      data: { personId, hours: 0 },
    });
    const startRes = await request.post(
      `/api/jobs/${jobId}/time-entries/${personId}/start`,
    );
    expect(startRes.status()).toBe(200);

    await page.goto(`/jobs/${jobId}?testMode=1`);

    const row = page.locator("li").filter({ hasText: personName });
    await expect(row.getByRole("button", { name: "Stop" })).toBeVisible({
      timeout: 10_000,
    });

    await context.setOffline(true);
    await expect(page.getByText("Pracujete offline", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await row.getByRole("button", { name: "Stop" }).click();
    await expect(
      page.getByText("Zastavení časovače čeká na obnovení připojení", {
        exact: true,
      }),
    ).toBeVisible();

    // Simulate the entry disappearing server-side before the queued stop can
    // replay (e.g. removed from another device) — via a request context that
    // is independent from the page's (offline) browser context.
    const deleteRes = await request.delete(
      `/api/jobs/${jobId}/time-entries/${personId}`,
    );
    expect(deleteRes.status()).toBe(204);

    // Drive three flush attempts (MAX_ATTEMPTS) by cycling connectivity; each
    // reconnect auto-triggers a flush, and the failing op must produce a
    // visible error on every attempt, then move to the "failed" queue.
    async function readOps(): Promise<Array<{ attempts: number; status: string }>> {
      return page.evaluate(() => {
        return new Promise((resolve) => {
          const idb = (globalThis as any).indexedDB;
          const req = idb.open("stavba-offline-v1", 1);
          req.onsuccess = () => {
            const db = req.result;
            const t = db.transaction("ops", "readonly");
            const s = t.objectStore("ops");
            const g = s.getAll();
            g.onsuccess = () => resolve(g.result);
          };
        });
      }) as any;
    }

    for (let i = 0; i < 3; i++) {
      const before = await readOps();
      await context.setOffline(false);
      await expect
        .poll(async () => {
          const ops = await readOps();
          return ops[0]?.attempts ?? 0;
        }, { timeout: 15_000 })
        .toBeGreaterThan(before[0]?.attempts ?? 0);

      if (i < 2) {
        await context.setOffline(true);
        await page.waitForTimeout(500);
      }
    }

    // After exhausting retries the op must land in the visible "failed" queue
    // — never just vanish.
    await expect(
      page.getByText("1 akce se nepodařila odeslat", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Zobrazit", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Chybné offline akce" }),
    ).toBeVisible();
    await expect(page.getByText("Zastavení časovače")).toBeVisible();
    await expect(page.getByText(/404/)).toBeVisible();

    const discardBtn = page.getByRole("button", { name: "Zahodit" }).first();
    await expect(discardBtn).toBeVisible();
    await discardBtn.click();

    await expect(
      page.getByRole("heading", { name: "Chybné offline akce" }),
    ).not.toBeVisible();
  });
});
