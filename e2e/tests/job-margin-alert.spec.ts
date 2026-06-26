import { test, expect } from "@playwright/test";

type Settings = { marginAlertThresholdPercent: number | string };

test.describe("Job low-margin alert on the job-detail page", () => {
  let jobId: number;
  let warehouseItemId: number;
  let materialId: number;
  let originalThreshold = "0";
  const itemName = `E2E_MARGIN_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    // Remember the operator's current threshold so we can restore it afterwards.
    const settingsRes = await request.get("/api/billing/settings");
    expect(settingsRes.status()).toBe(200);
    const settings = (await settingsRes.json()) as Settings;
    originalThreshold = String(settings.marginAlertThresholdPercent ?? 0);

    const jobRes = await request.post("/api/jobs", {
      data: {
        title: `E2E_MARGIN_Job_${Date.now()}`,
        date: "2026-01-15",
        type: "other",
        status: "planned",
      },
    });
    expect(jobRes.status()).toBe(201);
    jobId = ((await jobRes.json()) as { id: number }).id;

    // Cost (purchase) price 100 — drives cost_price_at_time on the OUT movement.
    const itemRes = await request.post("/api/warehouse-items", {
      data: { name: itemName, quantity: 10, purchasePrice: 100 },
    });
    expect(itemRes.status()).toBe(201);
    warehouseItemId = ((await itemRes.json()) as { id: number }).id;

    // Sale price 50 (< cost 100) → cumulative margin = (50-100)/50 = -100%.
    const matRes = await request.post(`/api/jobs/${jobId}/materials`, {
      data: { name: itemName, quantity: 1, pricePerUnit: 50, warehouseItemId },
    });
    expect(matRes.status()).toBe(201);
    materialId = ((await matRes.json()) as { id: number }).id;

    // Sanity-check the endpoint reports the expected negative cumulative margin.
    const trendRes = await request.get(
      `/api/warehouse-movements/job-margin-trend?jobId=${jobId}`,
    );
    expect(trendRes.status()).toBe(200);
    const trend = (await trendRes.json()) as {
      points: Array<{ cumulativeMarginPct: number | null }>;
    };
    const last = trend.points[trend.points.length - 1];
    expect(last?.cumulativeMarginPct).toBeLessThan(0);
  });

  test.afterAll(async ({ request }) => {
    await request
      .put("/api/billing/settings", {
        data: { marginAlertThresholdPercent: Number(originalThreshold) },
      })
      .catch(() => {});
    if (materialId) {
      await request
        .delete(`/api/jobs/${jobId}/materials/${materialId}`)
        .catch(() => {});
    }
    if (warehouseItemId) {
      await request
        .delete(`/api/warehouse-items/${warehouseItemId}`)
        .catch(() => {});
    }
    if (jobId) {
      await request.delete(`/api/jobs/${jobId}`).catch(() => {});
    }
  });

  async function setThreshold(request: any, value: number) {
    const res = await request.put("/api/billing/settings", {
      data: { marginAlertThresholdPercent: value },
    });
    expect(res.status()).toBe(200);
  }

  test("alert is shown when the margin is below the threshold", async ({
    page,
    request,
  }) => {
    // Threshold 0: a -100% margin is below it → the warning must appear.
    await setThreshold(request, 0);

    await page.goto(`/jobs/${jobId}`);

    const alert = page.getByTestId("job-margin-alert");
    await expect(alert).toBeVisible();
    // Wording explains the current margin vs. the configured threshold.
    await expect(alert).toContainText("Nízká marže zakázky");
    await expect(alert).toContainText("kumulativní marže skladu je");
    await expect(alert).toContainText("nastavenou hranicí");
  });

  test("alert is hidden when the threshold is lowered below the margin", async ({
    page,
    request,
  }) => {
    // Threshold -1000: a -100% margin is above it → the warning must disappear.
    await setThreshold(request, -1000);

    await page.goto(`/jobs/${jobId}`);

    // Materials section header is present so the page is fully rendered.
    await expect(page.getByText("Materiál", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("job-margin-alert")).toHaveCount(0);
  });
});
