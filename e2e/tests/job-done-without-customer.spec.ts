import { test, expect } from "@playwright/test";

test.describe("Job detail – done without customer", () => {
  test("shows error and does not change status when done is selected without a customer", async ({
    page,
  }) => {
    const today = new Date().toISOString().split("T")[0];
    const createRes = await page.request.post("/api/jobs", {
      data: { title: "E2E_Test_DoneNoCustomer", type: "other", date: today, status: "planned" },
    });
    expect(createRes.status()).toBe(201);
    const job = (await createRes.json()) as { id: number };

    await page.goto(`/jobs/${job.id}`);
    await expect(page.getByText("E2E_Test_DoneNoCustomer")).toBeVisible();

    const statusTrigger = page.getByRole("button", { name: "Naplánováno" });
    await statusTrigger.click();
    await page.getByRole("button", { name: "Hotovo" }).click();

    await expect(page.getByText("Přiřaďte zákazníka", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-component-name="ToastDescription"]').filter({ hasText: "musí mít zákazníka" })
    ).toBeVisible();

    await expect(statusTrigger).toBeVisible();

    await page.request.delete(`/api/jobs/${job.id}`);
  });
});
