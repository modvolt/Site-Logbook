import { test, expect } from "@playwright/test";

/**
 * Guards the live active-timers overview on the Team page (/people).
 *
 * Starting a timer broadcasts the `people` domain over SSE; the client
 * invalidates the `/api/people` prefix (which covers `/api/people/active-timers`)
 * so the open Team page refreshes the overview without a manual reload. Stopping
 * the timer removes the row the same way. This cross-cutting behavior relies on
 * the SSE broadcast + invalidation prefix staying in lockstep, which is easy to
 * break silently — hence this end-to-end guard.
 */
test.describe("Live active-timers overview", () => {
  let jobId: number;
  let personId: number;
  let personName: string;
  let jobTitle: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    personName = `E2E_Timer_Person_${stamp}`;
    jobTitle = `E2E_Timer_Job_${stamp}`;

    const personRes = await request.post("/api/people", {
      data: { name: personName },
    });
    expect(personRes.status()).toBe(201);
    personId = ((await personRes.json()) as { id: number }).id;

    const jobRes = await request.post("/api/jobs", {
      data: { title: jobTitle, date: "2026-06-27", type: "other", status: "planned" },
    });
    expect(jobRes.status()).toBe(201);
    jobId = ((await jobRes.json()) as { id: number }).id;

    // Ensure a time-entry row exists for the person on the job.
    const entryRes = await request.post(`/api/jobs/${jobId}/time-entries`, {
      data: { personId, hours: 0 },
    });
    expect(entryRes.status()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    // Stop any lingering timer and clean up the job (cascades the time entry).
    await request.post(`/api/jobs/${jobId}/time-entries/${personId}/stop`).catch(() => {});
    await request.delete(`/api/jobs/${jobId}`).catch(() => {});
    await request.delete(`/api/people/${personId}`).catch(() => {});
  });

  test("row appears when a timer starts and disappears when it stops", async ({ page, request }) => {
    // Open the Team page (establishes the SSE connection) before mutating, so the
    // overview must update live — not just on initial load.
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "Tým" })).toBeVisible();

    const panel = page.locator(".border-amber-300\\/60").first();
    await expect(panel.getByRole("heading", { name: "Aktivní časovače" })).toBeVisible();

    const timerRow = panel.getByText(personName, { exact: true });

    // No timer running yet for our freshly created person.
    await expect(timerRow).toHaveCount(0);

    // Start the timer via the API; the server broadcasts the `people` domain over
    // SSE and the open page should refetch and show the row within ~2s.
    const startRes = await request.post(`/api/jobs/${jobId}/time-entries/${personId}/start`);
    expect(startRes.status()).toBe(200);

    await expect(timerRow).toBeVisible({ timeout: 5_000 });
    // The row also shows the job it is tracking.
    await expect(panel.getByText(jobTitle, { exact: true })).toBeVisible();

    // Stop the timer; the row should vanish live, again via the SSE broadcast.
    const stopRes = await request.post(`/api/jobs/${jobId}/time-entries/${personId}/stop`);
    expect(stopRes.status()).toBe(200);

    await expect(timerRow).toHaveCount(0, { timeout: 5_000 });
  });

  test("shows the empty state when no timers are running", async ({ page, request }) => {
    // This assertion is only meaningful when the dev DB has no other running
    // timers (the normal/fresh case). Skip gracefully if some pre-exist so the
    // shared DB never makes the suite flaky.
    const activeRes = await request.get("/api/people/active-timers");
    expect(activeRes.status()).toBe(200);
    const active = (await activeRes.json()) as unknown[];
    test.skip(active.length > 0, "Other active timers exist in the shared dev DB");

    await page.goto("/people");
    const panel = page.locator(".border-amber-300\\/60").first();
    await expect(panel.getByText("Žádné aktivní časovače.")).toBeVisible();
  });
});
