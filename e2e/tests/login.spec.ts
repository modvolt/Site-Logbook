import { test, expect } from "@playwright/test";

test.describe("Login page", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Přihlásit se" })).toBeVisible();
  });

  test("shows inline field errors when form is submitted empty", async ({ page }) => {
    await page.getByRole("button", { name: "Přihlásit se" }).click();

    await expect(page.getByText("Zadejte uživatelské jméno.")).toBeVisible();
    await expect(page.getByText("Zadejte heslo.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows inline error when wrong credentials are entered", async ({ page }) => {
    await page.locator('input[autocomplete="username"]').fill("notauser");
    await page.locator('input[autocomplete="current-password"]').fill("wrongpassword");
    await page.getByRole("button", { name: "Přihlásit se" }).click();

    await expect(
      page.getByText("Špatné uživatelské jméno nebo heslo."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("redirects to dashboard on correct credentials", async ({ page }) => {
    const loginResponse = page.waitForResponse(
      (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
    );

    await page.locator('input[autocomplete="username"]').fill("admin");
    await page.locator('input[autocomplete="current-password"]').fill("admin");
    await page.getByRole("button", { name: "Přihlásit se" }).click();

    const resp = await loginResponse;
    expect(resp.status()).toBe(200);

    await expect(
      page.locator("nav").filter({ hasText: "Zakázky" }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page).not.toHaveURL(/\/login$/);
  });
});
