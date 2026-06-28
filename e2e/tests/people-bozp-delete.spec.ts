import { test, expect } from "@playwright/test";

test.describe("People – BOZP delete guard", () => {
  test("returns 409 with BOZP message via API when person has PPE assignments", async ({
    request,
  }) => {
    const personRes = await request.post("/api/people", {
      data: { name: `E2E_BOZP_API_${Date.now()}` },
    });
    expect(personRes.status()).toBe(201);
    const person = (await personRes.json()) as { id: number };

    const itemRes = await request.post("/api/ppe/items", {
      data: { name: `E2E_PPE_Item_${Date.now()}`, category: "ostatni" },
    });
    expect(itemRes.status()).toBe(201);
    const item = (await itemRes.json()) as { id: number };

    const assignRes = await request.post("/api/ppe/assignments", {
      data: {
        ppeItemId: item.id,
        personId: person.id,
        quantity: 1,
        issuedAt: "2026-01-01",
      },
    });
    expect(assignRes.status()).toBe(201);

    const deleteRes = await request.delete(`/api/people/${person.id}`);
    expect(deleteRes.status()).toBe(409);

    const body = (await deleteRes.json()) as { error: string };
    expect(body.error).toMatch(/BOZP/);
    expect(body.error).toMatch(/nelze jej smazat/);
  });

  test("returns 204 via API when person has no PPE assignments", async ({ request }) => {
    const personRes = await request.post("/api/people", {
      data: { name: `E2E_BOZP_Clean_${Date.now()}` },
    });
    expect(personRes.status()).toBe(201);
    const person = (await personRes.json()) as { id: number };

    const deleteRes = await request.delete(`/api/people/${person.id}`);
    expect(deleteRes.status()).toBe(204);
  });

  test("shows BOZP blocking message in toast when deleting a worker with PPE records", async ({
    page,
  }) => {
    const uniqueName = `E2E_BOZP_UI_${Date.now()}`;

    const personRes = await page.request.post("/api/people", {
      data: { name: uniqueName },
    });
    expect(personRes.status()).toBe(201);
    const person = (await personRes.json()) as { id: number };

    const itemRes = await page.request.post("/api/ppe/items", {
      data: { name: `E2E_PPE_UI_${Date.now()}`, category: "ostatni" },
    });
    expect(itemRes.status()).toBe(201);
    const item = (await itemRes.json()) as { id: number };

    await page.request.post("/api/ppe/assignments", {
      data: {
        ppeItemId: item.id,
        personId: person.id,
        quantity: 1,
        issuedAt: "2026-01-01",
      },
    });

    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "Tým" })).toBeVisible();

    const card = page
      .locator("div.rounded-xl, div.rounded-lg, [class*='Card'], [class*='card']")
      .filter({ has: page.getByText(uniqueName, { exact: true }) })
      .first();
    await expect(card).toBeVisible();

    const deleteBtn = card.getByTitle("Odebrat pracovníka");
    await deleteBtn.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/odebrat tohoto pracovníka/i)).toBeVisible();

    await dialog.getByRole("button", { name: "Smazat" }).click();

    await expect(
      page.getByTestId("toast-title").filter({ hasText: "Nelze odebrat pracovníka" }),
    ).toBeVisible({ timeout: 8_000 });

    await expect(
      page.getByTestId("toast-description").filter({ hasText: /BOZP/ }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText(uniqueName, { exact: true })).toBeVisible();
  });
});
