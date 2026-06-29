import { test, expect } from "@playwright/test";

test.describe("People – error state and retry", () => {
  test("shows error banner (not empty state) on 500, disables submit, reloads data on retry", async ({
    page,
  }) => {
    let requestsBlocked = true;

    await page.route("**/api/people", (route, request) => {
      if (request.method() === "GET" && requestsBlocked) {
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated failure" }) });
      } else {
        route.continue();
      }
    });

    await page.goto("/people");

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText("Nepodařilo se načíst pracovníky", { exact: true }),
    ).toBeVisible();

    await expect(
      page.getByText("Zatím žádní pracovníci.", { exact: true }),
    ).not.toBeVisible();

    const submitBtn = page.getByRole("button", { name: /Přidat/i });
    await expect(submitBtn).toBeDisabled();

    const retryBtn = page.getByRole("button", { name: "Zkusit znovu" });
    await expect(retryBtn).toBeVisible();

    requestsBlocked = false;

    await retryBtn.click();

    await expect(page.getByRole("alert")).not.toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText("Nepodařilo se načíst pracovníky", { exact: true }),
    ).not.toBeVisible();

    await expect(submitBtn).not.toBeDisabled({ timeout: 8_000 });
  });
});
