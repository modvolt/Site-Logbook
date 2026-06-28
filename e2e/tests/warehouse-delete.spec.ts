import { test, expect } from "@playwright/test";
import { cleanupWarehouseItem } from "./helpers";

test.describe("Warehouse delete guard", () => {
  test("returns 409 via API when item has warehouse movements", async ({ request }) => {
    let itemId: number | undefined;

    try {
      const createRes = await request.post("/api/warehouse-items", {
        data: { name: "E2E_WH_WithMov_Guard" },
      });
      expect(createRes.status()).toBe(201);
      const item = (await createRes.json()) as { id: number };
      itemId = item.id;

      const movRes = await request.post(`/api/warehouse-items/${item.id}/movements`, {
        data: { direction: "in", quantity: 3 },
      });
      expect(movRes.status()).toBe(201);

      const deleteRes = await request.delete(`/api/warehouse-items/${item.id}`);
      expect(deleteRes.status()).toBe(409);

      const body = (await deleteRes.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain("nelze smazat");
    } finally {
      if (itemId !== undefined) await cleanupWarehouseItem(request, itemId);
    }
  });

  test("returns 204 via API when item has no movements", async ({ request }) => {
    const createRes = await request.post("/api/warehouse-items", {
      data: { name: "E2E_WH_Fresh_Guard" },
    });
    expect(createRes.status()).toBe(201);
    const item = (await createRes.json()) as { id: number };

    const deleteRes = await request.delete(`/api/warehouse-items/${item.id}`);
    expect(deleteRes.status()).toBe(204);
  });

  test("shows success toast and removes item when deleting a fresh item via UI", async ({
    page,
  }) => {
    const uniqueName = `E2E_Fresh_${Date.now()}`;
    const createRes = await page.request.post("/api/warehouse-items", {
      data: { name: uniqueName },
    });
    expect(createRes.status()).toBe(201);

    await page.goto("/sklad");
    await expect(page.getByRole("heading", { name: "Sklad" })).toBeVisible();
    const itemText = page.getByText(uniqueName, { exact: true }).first();
    await expect(itemText).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    const card = page.locator(".transition-colors").filter({ has: page.getByText(uniqueName, { exact: true }) });
    await card.locator("button.text-destructive").click();

    await expect(page.getByText("Položka smazána", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(uniqueName, { exact: true })).not.toBeVisible();
  });

  test("shows error toast and keeps item when deleting item with movements via UI", async ({
    page,
  }) => {
    const uniqueName = `E2E_MovUI_${Date.now()}`;
    let itemId: number | undefined;

    try {
      const createRes = await page.request.post("/api/warehouse-items", {
        data: { name: uniqueName },
      });
      expect(createRes.status()).toBe(201);
      const item = (await createRes.json()) as { id: number };
      itemId = item.id;

      await page.request.post(`/api/warehouse-items/${item.id}/movements`, {
        data: { direction: "in", quantity: 2 },
      });

      await page.goto("/sklad");
      await expect(page.getByRole("heading", { name: "Sklad" })).toBeVisible();
      const itemText = page.getByText(uniqueName, { exact: true }).first();
      await expect(itemText).toBeVisible();

      page.once("dialog", (dialog) => dialog.accept());
      const card = page.locator(".transition-colors").filter({ has: page.getByText(uniqueName, { exact: true }) });
      await card.locator("button.text-destructive").click();

      await expect(page.getByText("Nelze smazat", { exact: true })).toBeVisible({ timeout: 8_000 });
      await expect(page.getByText(uniqueName, { exact: true }).first()).toBeVisible();
    } finally {
      if (itemId !== undefined) await cleanupWarehouseItem(page.request, itemId);
    }
  });
});
