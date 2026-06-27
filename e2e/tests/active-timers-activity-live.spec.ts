import { test, expect } from "@playwright/test";

/**
 * Guards the live active-timers overview on the Team page (/people) for the
 * ACTIVITY path specifically.
 *
 * The overview supports timers started on both jobs and activities
 * (`kind: "job" | "activity"`). Activity timer mutations flow through a separate
 * SSE branch (`p.startsWith("/activities")` in
 * `artifacts/api-server/src/lib/live-updates.ts`) than the job branch, so a
 * regression there would slip past the job-only guard
 * (`active-timers-live.spec.ts`). This mirrors that test for activities and also
 * asserts the row renders the activity icon (Clock), not the job icon.
 */
test.describe("Live active-timers overview (activity path)", () => {
  let activityId: number;
  let personId: number;
  let personName: string;
  let activityName: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    personName = `E2E_ActTimer_Person_${stamp}`;
    activityName = `E2E_ActTimer_Activity_${stamp}`;

    const personRes = await request.post("/api/people", {
      data: { name: personName },
    });
    expect(personRes.status()).toBe(201);
    personId = ((await personRes.json()) as { id: number }).id;

    const activityRes = await request.post("/api/activities", {
      data: { name: activityName },
    });
    expect(activityRes.status()).toBe(201);
    activityId = ((await activityRes.json()) as { id: number }).id;

    // Ensure a time-entry row exists for the person on the activity.
    const entryRes = await request.post(`/api/activities/${activityId}/time-entries`, {
      data: { personId, hours: 0 },
    });
    expect(entryRes.status()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    // Stop any lingering timer and clean up the activity (cascades the time entry).
    await request
      .post(`/api/activities/${activityId}/time-entries/${personId}/stop`)
      .catch(() => {});
    await request.delete(`/api/activities/${activityId}`).catch(() => {});
    await request.delete(`/api/people/${personId}`).catch(() => {});
  });

  test("activity row appears when its timer starts and disappears when it stops", async ({
    page,
    request,
  }) => {
    // Open the Team page (establishes the SSE connection) before mutating, so the
    // overview must update live — not just on initial load.
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "Tým" })).toBeVisible();

    const panel = page.locator(".border-amber-300\\/60").first();
    await expect(panel.getByRole("heading", { name: "Aktivní časovače" })).toBeVisible();

    const timerRow = panel.getByText(personName, { exact: true });

    // No timer running yet for our freshly created person.
    await expect(timerRow).toHaveCount(0);

    // Start the activity timer via the API; the server broadcasts the `people`
    // domain over SSE (via the activity branch) and the open page should refetch
    // and show the row within ~2s.
    const startRes = await request.post(
      `/api/activities/${activityId}/time-entries/${personId}/start`,
    );
    expect(startRes.status()).toBe(200);

    await expect(timerRow).toBeVisible({ timeout: 5_000 });
    // The row also shows the activity it is tracking.
    await expect(panel.getByText(activityName, { exact: true })).toBeVisible();

    // The row must render the activity icon (Clock), not the job icon (Briefcase).
    const row = panel.locator("li").filter({ hasText: personName });
    await expect(row.locator("svg.lucide-clock")).toBeVisible();
    await expect(row.locator("svg.lucide-briefcase")).toHaveCount(0);

    // Stop the timer; the row should vanish live, again via the SSE broadcast.
    const stopRes = await request.post(
      `/api/activities/${activityId}/time-entries/${personId}/stop`,
    );
    expect(stopRes.status()).toBe(200);

    await expect(timerRow).toHaveCount(0, { timeout: 5_000 });
  });
});
