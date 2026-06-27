import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Guards the per-person "Časovač běží" badge and the header count badge
 * ("X aktivní časovač(e)") on the Team page (/people).
 *
 * Unlike the active-timers *panel* (driven by `/api/people/active-timers`),
 * these two badges are driven by `GET /api/people/stats` (`hasActiveTimer`).
 * Both surfaces refresh via the same SSE `people` domain, but a stats-specific
 * regression (the stats query, or the header count/plural logic) would slip
 * past the panel-only test — hence this dedicated guard. It also verifies the
 * header count increments/decrements and switches singular↔plural as timers
 * start and stop.
 */
test.describe("Live timer badges (stats)", () => {
  let jobId: number;
  let person1Id: number;
  let person2Id: number;
  let person1Name: string;
  let person2Name: string;

  const createPerson = async (
    request: Page["request"],
    name: string,
  ): Promise<number> => {
    const res = await request.post("/api/people", { data: { name } });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { id: number }).id;
  };

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    person1Name = `E2E_Badge_Person1_${stamp}`;
    person2Name = `E2E_Badge_Person2_${stamp}`;

    person1Id = await createPerson(request, person1Name);
    person2Id = await createPerson(request, person2Name);

    const jobRes = await request.post("/api/jobs", {
      data: { title: `E2E_Badge_Job_${stamp}`, date: "2026-06-27", type: "other", status: "planned" },
    });
    expect(jobRes.status()).toBe(201);
    jobId = ((await jobRes.json()) as { id: number }).id;

    // Ensure a time-entry row exists for each person on the job.
    for (const personId of [person1Id, person2Id]) {
      const entryRes = await request.post(`/api/jobs/${jobId}/time-entries`, {
        data: { personId, hours: 0 },
      });
      expect(entryRes.status()).toBe(201);
    }
  });

  test.afterAll(async ({ request }) => {
    // Stop any lingering timers, then clean up (job delete cascades time entries).
    for (const personId of [person1Id, person2Id]) {
      await request.post(`/api/jobs/${jobId}/time-entries/${personId}/stop`).catch(() => {});
    }
    await request.delete(`/api/jobs/${jobId}`).catch(() => {});
    await request.delete(`/api/people/${person1Id}`).catch(() => {});
    await request.delete(`/api/people/${person2Id}`).catch(() => {});
  });

  test("per-person badge + header count update live as timers start/stop", async ({ page, request }) => {
    // The exact header-count assertions ("1 aktivní časovač") require a clean
    // baseline. Skip gracefully if the shared dev DB already has timers running.
    const activeRes = await request.get("/api/people/active-timers");
    expect(activeRes.status()).toBe(200);
    const active = (await activeRes.json()) as unknown[];
    test.skip(active.length > 0, "Other active timers exist in the shared dev DB");

    // The header count badge: "{n} aktivní časovač" (1) / "{n} aktivní časovače" (2+).
    const headerCount = (n: number): Locator =>
      page.getByText(`${n} ${n === 1 ? "aktivní časovač" : "aktivní časovače"}`, { exact: true });

    // Per-person "Časovač běží" badge, scoped to that person's card. The card
    // root has the unique `hover:bg-muted/30` class; the active-timers panel
    // also shows the person name, so we must scope to the card to avoid it.
    const cardBadge = (name: string): Locator =>
      page
        .locator(".hover\\:bg-muted\\/30")
        .filter({ has: page.getByText(name, { exact: true }) })
        .getByText("Časovač běží");

    // Open the Team page (establishes the SSE connection) before mutating, so
    // the badges must update live — not just on initial load.
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "Tým" })).toBeVisible();
    await expect(page.locator(".hover\\:bg-muted\\/30").filter({ has: page.getByText(person1Name, { exact: true }) })).toBeVisible();

    // Baseline: no header badge, no per-person badges.
    await expect(headerCount(1)).toHaveCount(0);
    await expect(cardBadge(person1Name)).toHaveCount(0);
    await expect(cardBadge(person2Name)).toHaveCount(0);

    // Start a timer for person 1 → their card badge appears and the header
    // count shows "1 aktivní časovač" (singular).
    const start1 = await request.post(`/api/jobs/${jobId}/time-entries/${person1Id}/start`);
    expect(start1.status()).toBe(200);

    await expect(cardBadge(person1Name)).toBeVisible({ timeout: 5_000 });
    await expect(headerCount(1)).toBeVisible({ timeout: 5_000 });
    await expect(cardBadge(person2Name)).toHaveCount(0);

    // Start a timer for person 2 → their badge appears and the header count
    // increments to "2 aktivní časovače" (plural).
    const start2 = await request.post(`/api/jobs/${jobId}/time-entries/${person2Id}/start`);
    expect(start2.status()).toBe(200);

    await expect(cardBadge(person2Name)).toBeVisible({ timeout: 5_000 });
    await expect(headerCount(2)).toBeVisible({ timeout: 5_000 });
    await expect(headerCount(1)).toHaveCount(0);

    // Stop person 2's timer → their badge vanishes and the count decrements
    // back to the singular "1 aktivní časovač".
    const stop2 = await request.post(`/api/jobs/${jobId}/time-entries/${person2Id}/stop`);
    expect(stop2.status()).toBe(200);

    await expect(cardBadge(person2Name)).toHaveCount(0, { timeout: 5_000 });
    await expect(headerCount(1)).toBeVisible({ timeout: 5_000 });
    await expect(cardBadge(person1Name)).toBeVisible();

    // Stop person 1's timer → the last badge vanishes and the header count
    // badge disappears entirely.
    const stop1 = await request.post(`/api/jobs/${jobId}/time-entries/${person1Id}/stop`);
    expect(stop1.status()).toBe(200);

    await expect(cardBadge(person1Name)).toHaveCount(0, { timeout: 5_000 });
    await expect(headerCount(1)).toHaveCount(0, { timeout: 5_000 });
  });
});
