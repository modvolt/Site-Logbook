import { test, expect } from "@playwright/test";

test.describe("Activity delete – visit-count guard", () => {
  /**
   * Pure API test: verifies the backend 409 guard and the force-delete path.
   */
  test("returns 409 with visitCount when activity has visits, 204 when forced", async ({
    request,
  }) => {
    const actRes = await request.post("/api/activities", {
      data: { name: `E2E_ActGuard_${Date.now()}` },
    });
    expect(actRes.status()).toBe(201);
    const { id } = (await actRes.json()) as { id: number };

    const visitRes = await request.post(`/api/activities/${id}/visits`, {
      data: { date: "2026-06-28", status: "planned" },
    });
    expect(visitRes.status()).toBe(201);

    // Without ?force=true → 409 with visitCount
    const delRes = await request.delete(`/api/activities/${id}`);
    expect(delRes.status()).toBe(409);
    const body = (await delRes.json()) as { visitCount?: number; error?: string };
    expect(body.visitCount).toBe(1);
    expect(body.error).toMatch(/výjezd/);

    // With ?force=true → 204 (activity + visits deleted)
    const forceRes = await request.delete(`/api/activities/${id}?force=true`);
    expect(forceRes.status()).toBe(204);

    // Confirm it's gone
    const getRes = await request.get(`/api/activities/${id}`);
    expect(getRes.status()).toBe(404);
  });

  /**
   * UI test: the two-step guard dialog flow.
   *
   * Step 1 – First confirm dialog (generic "Smazat akci …?")
   *   Confirming this triggers DELETE without ?force.
   *
   * Step 2 – Server returns 409; the frontend opens a second dialog
   *   that shows the visit count and a "Smazat vše" button.
   *
   * Step 3 – Clicking "Smazat vše" issues DELETE?force=true.
   *   The activity (and its visits) are deleted; the UI navigates to /activities.
   *
   * To guarantee the visits React-Query cache is empty when the user clicks
   * "delete" (so the first call goes without ?force), we delay the visits
   * endpoint response via page.route() until after the dialogs have closed.
   */
  test("shows visit count in second dialog and deletes on Smazat vše", async ({ page }) => {
    const uniqueName = `E2E_ActDelUI_${Date.now()}`;

    // Create activity
    const actRes = await page.request.post("/api/activities", {
      data: { name: uniqueName },
    });
    expect(actRes.status()).toBe(201);
    const { id } = (await actRes.json()) as { id: number };

    // Create one visit
    const visitRes = await page.request.post(`/api/activities/${id}/visits`, {
      data: { date: "2026-06-28", status: "planned" },
    });
    expect(visitRes.status()).toBe(201);

    // Delay the visits list so the RQ cache is still empty when we click delete
    let visitRouteFulfilled = false;
    await page.route(`**/api/activities/${id}/visits`, async (route) => {
      if (!visitRouteFulfilled) {
        visitRouteFulfilled = true;
        // Hold the response until after both dialogs have been handled
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      }
      await route.continue();
    });

    await page.goto(`/activities/${id}`);

    // Wait for the activity header to render (main data loaded, delete button visible)
    const trashBtn = page.locator("button.text-rose-500").first();
    await expect(trashBtn).toBeVisible({ timeout: 10_000 });

    // Click delete — cache is empty so doDeleteActivity is called WITHOUT force
    await trashBtn.click();

    // ── First dialog: generic activity-delete confirmation ─────────────────
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Smazat akci/)).toBeVisible();

    // Click "Smazat" → triggers DELETE /api/activities/:id (no force)
    // The server returns 409; the frontend opens the guard dialog.
    await dialog.getByRole("button", { name: "Smazat" }).click();

    // ── Second dialog: visit-count guard ───────────────────────────────────
    // The dialog re-opens with visit-count info and the "Smazat vše" button.
    await expect(dialog.getByText(/Smazat včetně výjezdů/)).toBeVisible({ timeout: 6_000 });
    await expect(dialog.getByText(/1 výjezd/)).toBeVisible();
    const deleteAllBtn = dialog.getByRole("button", { name: "Smazat vše" });
    await expect(deleteAllBtn).toBeVisible();

    // Confirm force delete
    await deleteAllBtn.click();

    // ── After deletion: redirect to /activities ───────────────────────────
    await expect(page).toHaveURL(/\/activities$/, { timeout: 10_000 });
    await expect(page.getByTestId("toast-title").filter({ hasText: "Akce smazána" })).toBeVisible({ timeout: 5_000 });
    // The deleted activity must not appear in the list
    await expect(page.getByText(uniqueName)).not.toBeVisible();
  });
});
