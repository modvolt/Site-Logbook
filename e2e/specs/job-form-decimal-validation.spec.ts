import { test, expect } from "@playwright/test";

/**
 * Validates that DecimalInput fields in the "Nová zakázka" (new-job) form
 * correctly reject non-numeric input, show "Neplatné číslo", disable the
 * "Přidat materiál" button, and re-enable it once valid values are provided.
 *
 * Covers: artifacts/stavba/src/pages/job-form.tsx
 *         artifacts/stavba/src/components/decimal-input.tsx
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  const usernameInput = page.locator('input[name="username"], input[placeholder*="uživ"], input[type="text"]').first();
  await usernameInput.fill("admin");
  await page.locator('input[type="password"]').fill("admin");
  await page.locator('button[type="submit"], button:has-text("Přihlásit")').click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10_000 });
}

test.describe("Nová zakázka – validace číselných polí materiálu", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/jobs/new");
    await page.waitForSelector("text=Nová zakázka", { timeout: 15_000 });
  });

  test("neplatný text v poli Množství zobrazí chybu a zakáže tlačítko Přidat materiál", async ({ page }) => {
    const quantityInput = page.getByPlaceholder("Množství");
    const addButton = page.getByRole("button", { name: /Přidat materiál/i });

    await quantityInput.fill("abc");

    await expect(page.getByText("Neplatné číslo").first()).toBeVisible();
    await expect(quantityInput).toHaveAttribute("aria-invalid", "true");
    await expect(addButton).toBeDisabled();
  });

  test("opravení Množství na platné číslo odstraní chybu", async ({ page }) => {
    const quantityInput = page.getByPlaceholder("Množství");

    await quantityInput.fill("abc");
    await expect(page.getByText("Neplatné číslo").first()).toBeVisible();

    await quantityInput.fill("5");
    await expect(page.getByText("Neplatné číslo")).not.toBeVisible();
    await expect(quantityInput).not.toHaveAttribute("aria-invalid", "true");
  });

  test("neplatný text v poli Kč/ks zobrazí chybu a zakáže tlačítko Přidat materiál", async ({ page }) => {
    const priceInput = page.getByPlaceholder("Kč/ks");
    const addButton = page.getByRole("button", { name: /Přidat materiál/i });

    await priceInput.fill("xyz");

    await expect(page.getByText("Neplatné číslo").first()).toBeVisible();
    await expect(priceInput).toHaveAttribute("aria-invalid", "true");
    await expect(addButton).toBeDisabled();
  });

  test("platná čísla v obou polích a vyplněný název povolí tlačítko Přidat materiál", async ({ page }) => {
    const nameInput = page.getByPlaceholder("Název materiálu...");
    const quantityInput = page.getByPlaceholder("Množství");
    const priceInput = page.getByPlaceholder("Kč/ks");
    const addButton = page.getByRole("button", { name: /Přidat materiál/i });

    await quantityInput.fill("abc");
    await expect(addButton).toBeDisabled();

    await quantityInput.fill("10");
    await priceInput.fill("xyz");
    await expect(addButton).toBeDisabled();

    await priceInput.fill("250");
    await expect(addButton).toBeDisabled();

    await nameInput.fill("Beton");
    await expect(addButton).toBeEnabled();
  });
});
