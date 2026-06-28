# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: warehouse-delete.spec.ts >> Warehouse delete guard >> shows error toast and keeps item when deleting item with movements via UI
- Location: tests/warehouse-delete.spec.ts:64:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Nelze smazat', { exact: true })
Expected: visible
Timeout: 8000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 8000ms
  - waiting for getByText('Nelze smazat', { exact: true })

```

```yaml
- alertdialog "Opravdu chcete smazat tuto položku?":
  - heading "Opravdu chcete smazat tuto položku?" [level=2]
  - button "Zrušit"
  - button "Smazat"
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | import { cleanupWarehouseItem } from "./helpers";
  3  | 
  4  | test.describe("Warehouse delete guard", () => {
  5  |   test("returns 409 via API when item has warehouse movements", async ({ request }) => {
  6  |     let itemId: number | undefined;
  7  | 
  8  |     try {
  9  |       const createRes = await request.post("/api/warehouse-items", {
  10 |         data: { name: "E2E_WH_WithMov_Guard" },
  11 |       });
  12 |       expect(createRes.status()).toBe(201);
  13 |       const item = (await createRes.json()) as { id: number };
  14 |       itemId = item.id;
  15 | 
  16 |       const movRes = await request.post(`/api/warehouse-items/${item.id}/movements`, {
  17 |         data: { direction: "in", quantity: 3 },
  18 |       });
  19 |       expect(movRes.status()).toBe(201);
  20 | 
  21 |       const deleteRes = await request.delete(`/api/warehouse-items/${item.id}`);
  22 |       expect(deleteRes.status()).toBe(409);
  23 | 
  24 |       const body = (await deleteRes.json()) as { error: string };
  25 |       expect(body.error.toLowerCase()).toContain("nelze smazat");
  26 |     } finally {
  27 |       if (itemId !== undefined) await cleanupWarehouseItem(request, itemId);
  28 |     }
  29 |   });
  30 | 
  31 |   test("returns 204 via API when item has no movements", async ({ request }) => {
  32 |     const createRes = await request.post("/api/warehouse-items", {
  33 |       data: { name: "E2E_WH_Fresh_Guard" },
  34 |     });
  35 |     expect(createRes.status()).toBe(201);
  36 |     const item = (await createRes.json()) as { id: number };
  37 | 
  38 |     const deleteRes = await request.delete(`/api/warehouse-items/${item.id}`);
  39 |     expect(deleteRes.status()).toBe(204);
  40 |   });
  41 | 
  42 |   test("shows success toast and removes item when deleting a fresh item via UI", async ({
  43 |     page,
  44 |   }) => {
  45 |     const uniqueName = `E2E_Fresh_${Date.now()}`;
  46 |     const createRes = await page.request.post("/api/warehouse-items", {
  47 |       data: { name: uniqueName },
  48 |     });
  49 |     expect(createRes.status()).toBe(201);
  50 | 
  51 |     await page.goto("/sklad");
  52 |     await expect(page.getByRole("heading", { name: "Sklad" })).toBeVisible();
  53 |     const itemText = page.getByText(uniqueName, { exact: true }).first();
  54 |     await expect(itemText).toBeVisible();
  55 | 
  56 |     page.once("dialog", (dialog) => dialog.accept());
  57 |     const card = page.locator(".transition-colors").filter({ has: page.getByText(uniqueName, { exact: true }) });
  58 |     await card.locator("button.text-destructive").click();
  59 | 
  60 |     await expect(page.getByText("Položka smazána", { exact: true })).toBeVisible({ timeout: 8_000 });
  61 |     await expect(page.getByText(uniqueName, { exact: true })).not.toBeVisible();
  62 |   });
  63 | 
  64 |   test("shows error toast and keeps item when deleting item with movements via UI", async ({
  65 |     page,
  66 |   }) => {
  67 |     const uniqueName = `E2E_MovUI_${Date.now()}`;
  68 |     let itemId: number | undefined;
  69 | 
  70 |     try {
  71 |       const createRes = await page.request.post("/api/warehouse-items", {
  72 |         data: { name: uniqueName },
  73 |       });
  74 |       expect(createRes.status()).toBe(201);
  75 |       const item = (await createRes.json()) as { id: number };
  76 |       itemId = item.id;
  77 | 
  78 |       await page.request.post(`/api/warehouse-items/${item.id}/movements`, {
  79 |         data: { direction: "in", quantity: 2 },
  80 |       });
  81 | 
  82 |       await page.goto("/sklad");
  83 |       await expect(page.getByRole("heading", { name: "Sklad" })).toBeVisible();
  84 |       const itemText = page.getByText(uniqueName, { exact: true }).first();
  85 |       await expect(itemText).toBeVisible();
  86 | 
  87 |       page.once("dialog", (dialog) => dialog.accept());
  88 |       const card = page.locator(".transition-colors").filter({ has: page.getByText(uniqueName, { exact: true }) });
  89 |       await card.locator("button.text-destructive").click();
  90 | 
> 91 |       await expect(page.getByText("Nelze smazat", { exact: true })).toBeVisible({ timeout: 8_000 });
     |                                                                     ^ Error: expect(locator).toBeVisible() failed
  92 |       await expect(page.getByText(uniqueName, { exact: true }).first()).toBeVisible();
  93 |     } finally {
  94 |       if (itemId !== undefined) await cleanupWarehouseItem(page.request, itemId);
  95 |     }
  96 |   });
  97 | });
  98 | 
```