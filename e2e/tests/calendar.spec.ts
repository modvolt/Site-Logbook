import { test, expect } from "@playwright/test";
import { cleanupJob } from "./helpers";

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * 1st of a month N months from now (YYYY-MM-DD).
 * Returns both the date and how many month-view "Vpřed" clicks are needed.
 */
function futureMonthFirst(monthsAhead: number): { date: string; monthsAhead: number } {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + monthsAhead, 1);
  return { date: target.toISOString().split("T")[0], monthsAhead };
}

/** YYYY-MM-DD for next calendar week's Monday / Sunday (Mon-start). */
function nextWeekRange(): { monday: string; sunday: string } {
  const d = new Date();
  const isoDay = d.getDay() === 0 ? 7 : d.getDay();
  const daysToNextMonday = 8 - isoDay;
  const monday = new Date(d);
  monday.setDate(d.getDate() + daysToNextMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    monday: monday.toISOString().split("T")[0],
    sunday: sunday.toISOString().split("T")[0],
  };
}

test.describe("Calendar page", () => {
  const today = todayStr();

  // ── 1. Week view ─────────────────────────────────────────────────────────────

  test("week view renders a grid with person rows", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.getByText("Nepřiřazeno")).toBeVisible({ timeout: 10_000 });
    // All three view-toggle buttons — exact to avoid /Den/i matching "Týden".
    await expect(page.getByRole("button", { name: "Týden", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Měsíc", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Den", exact: true })).toBeVisible();
  });

  // ── 2. Month view chip ────────────────────────────────────────────────────────

  test("month view renders day cells and job chips for a future month", async ({
    page,
  }) => {
    // Use month +2: guaranteed empty of stale test data.
    const { date: chipDate, monthsAhead } = futureMonthFirst(2);
    const jobTitle = `E2E_${Math.random().toString(36).slice(2, 9)}`;
    const createRes = await page.request.post("/api/jobs", {
      data: { title: jobTitle, date: chipDate, type: "other", status: "planned" },
    });
    expect(createRes.status()).toBe(201);
    const { id: jobId } = (await createRes.json()) as { id: number };

    try {
      await page.goto("/calendar");
      await expect(page.getByText("Nepřiřazeno")).toBeVisible({ timeout: 10_000 });

      await page.getByRole("button", { name: "Měsíc", exact: true }).click();
      await expect(page.getByText("Po").first()).toBeVisible({ timeout: 8_000 });

      // Navigate forward to the target month.
      for (let i = 0; i < monthsAhead; i++) {
        const resp = page.waitForResponse(
          (r) => r.url().includes("/api/jobs/calendar") && r.status() === 200,
        );
        await page.locator('button[title="Vpřed"]').click();
        await resp;
      }

      // Chip title ≤ 14 chars → shown untruncated in compact mode.
      // Only our job is on chipDate so no 3-chip truncation affects it.
      const chip = page
        .getByRole("button")
        .filter({ hasText: jobTitle })
        .first();
      await expect(chip).toBeVisible({ timeout: 8_000 });
    } finally {
      await cleanupJob(page.request, jobId);
    }
  });

  // ── 3. Day view ───────────────────────────────────────────────────────────────

  test("day view shows timeline with add-job button", async ({ page }) => {
    await page.goto("/calendar");
    await page.getByRole("button", { name: "Den", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Přidat zakázku na tento den/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  // ── 4. Empty slot click ───────────────────────────────────────────────────────

  test("clicking an empty slot in week view opens job form with date prefilled", async ({
    page,
  }) => {
    await page.goto("/calendar");
    await page.waitForResponse(
      (r) => r.url().includes("/api/jobs/calendar") && r.status() === 200,
    );
    await expect(page.getByText("Nepřiřazeno")).toBeVisible({ timeout: 10_000 });

    // Navigate forward one week — those slots are free of test jobs.
    const nextWeekResp = page.waitForResponse(
      (r) => r.url().includes("/api/jobs/calendar") && r.status() === 200,
    );
    await page.locator('button[title="Vpřed"]').click();
    await nextWeekResp;

    // Click the first slot (Monday) in the "Nepřiřazeno" row.
    const unassignedRow = page
      .locator(".grid")
      .filter({ hasText: "Nepřiřazeno" })
      .last();
    const firstSlot = unassignedRow.locator('[role="button"]').first();
    await expect(firstSlot).toBeVisible({ timeout: 5_000 });
    await firstSlot.click();

    await expect(page).toHaveURL(/\/jobs\/new\?.*date=\d{4}-\d{2}-\d{2}/, { timeout: 8_000 });

    const url = new URL(page.url());
    const dateParam = url.searchParams.get("date");
    expect(dateParam).toBeTruthy();
    expect(dateParam).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { monday, sunday } = nextWeekRange();
    expect(dateParam! >= monday).toBe(true);
    expect(dateParam! <= sunday).toBe(true);
  });

  // ── 5. Job-chip click ─────────────────────────────────────────────────────────

  test("clicking a job chip navigates to the job detail page", async ({
    page,
  }) => {
    // Use month +3 — isolated from the test-2 date (month +2).
    const { date: chipDate, monthsAhead } = futureMonthFirst(3);
    const jobTitle = `E2E_${Math.random().toString(36).slice(2, 9)}`;
    const createRes = await page.request.post("/api/jobs", {
      data: { title: jobTitle, date: chipDate, type: "other", status: "planned" },
    });
    expect(createRes.status()).toBe(201);
    const { id: jobId } = (await createRes.json()) as { id: number };

    try {
      await page.goto("/calendar");
      await expect(page.getByText("Nepřiřazeno")).toBeVisible({ timeout: 10_000 });

      await page.getByRole("button", { name: "Měsíc", exact: true }).click();
      await expect(page.getByText("Po").first()).toBeVisible({ timeout: 8_000 });

      for (let i = 0; i < monthsAhead; i++) {
        const resp = page.waitForResponse(
          (r) => r.url().includes("/api/jobs/calendar") && r.status() === 200,
        );
        await page.locator('button[title="Vpřed"]').click();
        await resp;
      }

      const chip = page
        .getByRole("button")
        .filter({ hasText: jobTitle })
        .first();
      await expect(chip).toBeVisible({ timeout: 8_000 });
      await chip.click();

      await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`), { timeout: 8_000 });
    } finally {
      await cleanupJob(page.request, jobId);
    }
  });
});
