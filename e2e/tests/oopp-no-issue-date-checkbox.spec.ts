import { test, expect } from "@playwright/test";
import { cleanupPpeAssignment, cleanupPpeItem, cleanupPerson } from "./helpers";

/**
 * E2E coverage for the "Zahrnout bez data vydání" (include no-issue-date) checkbox
 * on the OOPP assignments view (/stroje/oopp).
 *
 * Covers:
 *   - Checkbox is hidden when no date filter is active
 *   - Checkbox appears (checked by default) when "Vydáno od" or "do" is filled
 *   - Unchecking hides null-date records; rechecking restores them
 *     (tested via page.route() mocking – issuedAt is NOT NULL in the DB schema
 *     so null-date assignments cannot be created through the API)
 *   - Checkbox can be toggled; dated records are unaffected regardless of state
 *   - "Zrušit filtry" clears the date filter, hides the checkbox, and resets
 *     filterIncludeNoDate to true (verified by re-activating the filter)
 *   - Checkbox hidden when both date fields are manually cleared back to empty
 */

/** Minimal shape matching what the API returns for a PPE assignment. */
type AssignmentShape = {
  id: number;
  ppeItemId: number;
  personId: number;
  ppeNameSnapshot: string;
  personNameSnapshot: string;
  quantity: number;
  size: string | null;
  serialNumber: string | null;
  issuedAt: string | null;
  replaceBy: string | null;
  nextInspectionAt: string | null;
  returnedAt: string | null;
  status: string;
  employeeConfirmedAt: string | null;
  hasConfirmLink: boolean;
  isOverdue: boolean;
  createdAt: string;
};

const NULL_DATE_SERIAL = "E2E_NULL_DATE_SN";

test.describe("OOPP – 'no issue date' checkbox filter", () => {
  let itemId = 0;
  let personId = 0;
  let assignmentId = 0;
  let ppeItemName = "";

  test.beforeAll(async ({ request }) => {
    ppeItemName = `E2E_OOPP_DateCB_${Date.now()}`;

    const itemRes = await request.post("/api/ppe/items", {
      data: { name: ppeItemName, category: "ostatni" },
    });
    expect(itemRes.status()).toBe(201);
    itemId = ((await itemRes.json()) as { id: number }).id;

    const personRes = await request.post("/api/people", {
      data: { name: `E2E_OOPP_Person_${Date.now()}` },
    });
    expect(personRes.status()).toBe(201);
    personId = ((await personRes.json()) as { id: number }).id;

    const assignRes = await request.post("/api/ppe/assignments", {
      data: {
        ppeItemId: itemId,
        personId,
        quantity: 1,
        issuedAt: "2026-01-15",
      },
    });
    expect(assignRes.status()).toBe(201);
    assignmentId = ((await assignRes.json()) as { id: number }).id;
  });

  test.afterAll(async ({ request }) => {
    if (assignmentId) await cleanupPpeAssignment(request, assignmentId);
    if (itemId) await cleanupPpeItem(request, itemId);
    if (personId) await cleanupPerson(request, personId);
  });

  test("checkbox hidden with no date filter, visible+checked when date filter set", async ({
    page,
  }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByPlaceholder("Hledat...").fill(ppeItemName);
    await expect(page.getByText(ppeItemName)).toBeVisible({ timeout: 10_000 });

    const checkbox = page.getByLabel("Zahrnout bez data vydání");
    await expect(checkbox).not.toBeVisible();

    const issuedFromInput = page.locator('input[type="date"]').first();
    await issuedFromInput.fill("2026-01-01");

    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    await expect(checkbox).toBeChecked();

    await expect(page.getByText(ppeItemName)).toBeVisible();
  });

  test("unchecking hides null-date records; rechecking restores them", async ({
    page,
  }) => {
    /**
     * issuedAt is NOT NULL in the DB schema, so we inject a synthetic
     * null-date assignment via page.route() to exercise the filter predicate.
     * The fake record uses a distinctive serialNumber (E2E_NULL_DATE_SN) so we
     * can locate its card in the DOM via "SN: E2E_NULL_DATE_SN".
     */
    const nullDateRecord: AssignmentShape = {
      id: -1,
      ppeItemId: itemId,
      personId,
      ppeNameSnapshot: ppeItemName,
      personNameSnapshot: "E2E Null-Date Person",
      quantity: 1,
      size: null,
      serialNumber: NULL_DATE_SERIAL,
      issuedAt: null,
      replaceBy: null,
      nextInspectionAt: null,
      returnedAt: null,
      status: "issued",
      employeeConfirmedAt: null,
      hasConfirmLink: false,
      isOverdue: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await page.route("/api/ppe/assignments", async (route) => {
      const response = await route.fetch();
      const real = (await response.json()) as AssignmentShape[];
      await route.fulfill({
        response,
        json: [...real, nullDateRecord],
      });
    });

    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByPlaceholder("Hledat...").fill(ppeItemName);

    const checkbox = page.getByLabel("Zahrnout bez data vydání");
    const nullDateCard = page.getByText(`SN: ${NULL_DATE_SERIAL}`);
    const datedCard = page.getByText("Vydáno: 15. 1. 2026");

    // ── Before any date filter: both records visible, checkbox hidden ────────
    await expect(nullDateCard).toBeVisible({ timeout: 10_000 });
    await expect(datedCard).toBeVisible();
    await expect(checkbox).not.toBeVisible();

    // ── Activate date filter: checkbox appears checked ────────────────────────
    await page.locator('input[type="date"]').first().fill("2026-01-01");
    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    await expect(checkbox).toBeChecked();

    // Both records still visible: dated record is in-range; null-date record
    // is included because filterIncludeNoDate is true.
    await expect(datedCard).toBeVisible();
    await expect(nullDateCard).toBeVisible();

    // ── Uncheck the box → null-date record must disappear ────────────────────
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expect(nullDateCard).not.toBeVisible({ timeout: 5_000 });
    await expect(datedCard).toBeVisible();

    // ── Re-check → null-date record must come back ───────────────────────────
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await expect(nullDateCard).toBeVisible({ timeout: 5_000 });
    await expect(datedCard).toBeVisible();
  });

  test("Zrušit filtry resets the checkbox to checked and hides it", async ({
    page,
  }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByPlaceholder("Hledat...").fill(ppeItemName);
    await page.locator('input[type="date"]').first().fill("2026-01-01");

    const checkbox = page.getByLabel("Zahrnout bez data vydání");
    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    await page.getByRole("button", { name: "Zrušit filtry" }).click();

    await expect(checkbox).not.toBeVisible({ timeout: 5_000 });

    // Re-activate the date filter: checkbox must reappear as CHECKED,
    // confirming that "Zrušit filtry" reset filterIncludeNoDate to true.
    await page.locator('input[type="date"]').first().fill("2026-01-01");
    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    await expect(checkbox).toBeChecked();
  });

  test("checkbox hidden when both date fields are cleared back to empty", async ({
    page,
  }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByPlaceholder("Hledat...").fill(ppeItemName);

    const issuedFromInput = page.locator('input[type="date"]').first();
    const issuedToInput = page.locator('input[type="date"]').nth(1);
    const checkbox = page.getByLabel("Zahrnout bez data vydání");

    // "Vydáno do" alone triggers the checkbox.
    await issuedToInput.fill("2026-12-31");
    await expect(checkbox).toBeVisible({ timeout: 5_000 });

    await issuedFromInput.fill("2026-01-01");
    await expect(checkbox).toBeVisible();

    // Clear both → hasDateFilter = false → checkbox must hide.
    await issuedFromInput.fill("");
    await issuedToInput.fill("");
    await expect(checkbox).not.toBeVisible({ timeout: 5_000 });
  });
});
