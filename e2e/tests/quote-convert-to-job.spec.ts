import { test, expect } from "@playwright/test";
import { cleanupJob, cleanupQuote } from "./helpers";

/**
 * E2E test: quote-to-job conversion browser flow.
 *
 * Seeds an accepted quote via the API (create → accept), navigates to its
 * detail page in the browser, clicks "Převést na zakázku", and asserts that
 * the app redirects to the new job's detail page.
 */

test.describe("Quote → Job conversion", () => {
  let quoteId: number;
  let jobId: number | null = null;

  test.beforeAll(async ({ request }) => {
    const quoteRes = await request.post("/api/quotes", {
      data: {
        title: `E2E_Quote_Convert_${Date.now()}`,
        items: [
          {
            description: "Testovací položka",
            quantity: 1,
            unit: "ks",
            unitPrice: 1000,
            vatRate: 21,
            position: 0,
          },
        ],
      },
    });
    expect(quoteRes.status()).toBe(201);
    const quote = (await quoteRes.json()) as { id: number };
    quoteId = quote.id;

    const acceptRes = await request.post(`/api/quotes/${quoteId}/accept`);
    expect(acceptRes.status()).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    if (jobId != null) await cleanupJob(request, jobId);
    await cleanupQuote(request, quoteId);
  });

  test("clicking 'Převést na zakázku' redirects to the new job", async ({
    page,
  }) => {
    await page.goto(`/quotes/${quoteId}?testMode=1`);

    await expect(page.getByRole("button", { name: /Převést na zakázku/ })).toBeVisible({
      timeout: 8_000,
    });

    await page.getByRole("button", { name: /Převést na zakázku/ }).click();

    await expect(page).toHaveURL(/\/jobs\/\d+/, { timeout: 10_000 });

    const match = page.url().match(/\/jobs\/(\d+)/);
    expect(match).not.toBeNull();
    jobId = parseInt(match![1], 10);
    expect(jobId).toBeGreaterThan(0);

    await expect(
      page.getByTestId("toast-title").filter({ hasText: "Zakázka vytvořena" }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("converted quote shows link to the job", async ({ page }) => {
    test.skip(jobId == null, "Conversion test did not run or failed");

    await page.goto(`/quotes/${quoteId}?testMode=1`);

    await expect(
      page.getByText(`zakázku #${jobId}`),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("convert endpoint is idempotent: second call returns 409", async ({
    request,
  }) => {
    test.skip(jobId == null, "Conversion test did not run or failed");

    const res = await request.post(`/api/quotes/${quoteId}/convert-to-job`);
    expect(res.status()).toBe(409);
  });
});
