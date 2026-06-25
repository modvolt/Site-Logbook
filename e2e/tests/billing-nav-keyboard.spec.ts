import { test, expect } from "@playwright/test";

test.describe("Billing nav cards – keyboard navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: "Fakturace" })).toBeVisible();
  });

  test("Tab + Enter on Nevyfakturovane zakazky navigates to /billing/unbilled", async ({
    page,
  }) => {
    const card = page.getByRole("button", { name: /Nevyfakturované zakázky/ });
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/billing/unbilled");
  });

  test("Tab + Enter on Faktury navigates to /billing/invoices", async ({
    page,
  }) => {
    const card = page.getByRole("button", { name: /^Faktury/ });
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/billing/invoices");
  });

  test("Tab + Enter on Nastaveni fakturace navigates to /billing/settings", async ({
    page,
  }) => {
    const card = page.getByRole("button", { name: /Nastavení fakturace/ });
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/billing/settings");
  });
});
