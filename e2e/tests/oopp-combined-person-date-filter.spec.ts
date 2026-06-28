import { test, expect } from "@playwright/test";
import { cleanupPpeAssignment, cleanupPpeItem, cleanupPerson } from "./helpers";

/**
 * E2E coverage for using the person-select and date-range filters together
 * on the OOPP assignments view (/stroje/oopp).
 *
 * Covers:
 *   - Filtering by person alone hides the other person's records
 *   - Filtering by date range alone hides out-of-range records
 *   - Combining person + date filters shows only records that satisfy BOTH
 *   - Switching person while date filter is active re-filters correctly
 *   - "Zrušit filtry" resets both the person filter and the date filter in
 *     one click, making all records visible again
 *
 * NOTE: Cards are identified by their "Vydáno:" date text (e.g. "Vydáno: 10. 1. 2026")
 * rather than by person name, because the person name also appears in the person-filter
 * Select trigger when that person is selected — causing strict-mode violations.
 */

test.describe("OOPP – combined person + date filter", () => {
  const ts = Date.now();

  let itemId = 0;
  let personAId = 0;
  let personBId = 0;
  let assignmentAId = 0;
  let assignmentBId = 0;

  const itemName = `E2E_OOPP_CF_${ts}`;
  const personAName = `E2E_CF_PersonA_${ts}`;
  const personBName = `E2E_CF_PersonB_${ts}`;

  // Person A → issued 2026-01-10 → card text "Vydáno: 10. 1. 2026"
  // Person B → issued 2026-02-15 → card text "Vydáno: 15. 2. 2026"
  const cardAText = "Vydáno: 10. 1. 2026";
  const cardBText = "Vydáno: 15. 2. 2026";

  test.beforeAll(async ({ request }) => {
    const itemRes = await request.post("/api/ppe/items", {
      data: { name: itemName, category: "ostatni" },
    });
    expect(itemRes.status()).toBe(201);
    itemId = ((await itemRes.json()) as { id: number }).id;

    const personARes = await request.post("/api/people", {
      data: { name: personAName },
    });
    expect(personARes.status()).toBe(201);
    personAId = ((await personARes.json()) as { id: number }).id;

    const personBRes = await request.post("/api/people", {
      data: { name: personBName },
    });
    expect(personBRes.status()).toBe(201);
    personBId = ((await personBRes.json()) as { id: number }).id;

    // Person A → issued in January
    const assignARes = await request.post("/api/ppe/assignments", {
      data: { ppeItemId: itemId, personId: personAId, quantity: 1, issuedAt: "2026-01-10" },
    });
    expect(assignARes.status()).toBe(201);
    assignmentAId = ((await assignARes.json()) as { id: number }).id;

    // Person B → issued in February
    const assignBRes = await request.post("/api/ppe/assignments", {
      data: { ppeItemId: itemId, personId: personBId, quantity: 1, issuedAt: "2026-02-15" },
    });
    expect(assignBRes.status()).toBe(201);
    assignmentBId = ((await assignBRes.json()) as { id: number }).id;
  });

  test.afterAll(async ({ request }) => {
    if (assignmentAId) await cleanupPpeAssignment(request, assignmentAId);
    if (assignmentBId) await cleanupPpeAssignment(request, assignmentBId);
    if (itemId) await cleanupPpeItem(request, itemId);
    if (personAId) await cleanupPerson(request, personAId);
    if (personBId) await cleanupPerson(request, personBId);
  });

  test("person filter alone shows only that person's records", async ({ page }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });

    // Narrow the list to only our test items so other data doesn't interfere
    await page.getByPlaceholder("Hledat...").fill(itemName);

    // Both cards visible before any filter
    const cardA = page.getByText(cardAText);
    const cardB = page.getByText(cardBText);
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible({ timeout: 10_000 });

    // Select person A
    await page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }).click();
    await page.getByRole("option", { name: personAName }).click();

    // Person A's card visible; person B's hidden
    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await expect(cardB).not.toBeVisible({ timeout: 5_000 });
  });

  test("date filter alone hides out-of-range records", async ({ page }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder("Hledat...").fill(itemName);
    const cardA = page.getByText(cardAText);
    const cardB = page.getByText(cardBText);
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible();

    // Restrict to January — covers person A (Jan 10), excludes person B (Feb 15)
    await page.locator('input[type="date"]').first().fill("2026-01-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-01-31");

    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await expect(cardB).not.toBeVisible({ timeout: 5_000 });
  });

  test("person + date filters combined — only the intersection is shown", async ({ page }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder("Hledat...").fill(itemName);
    const cardA = page.getByText(cardAText);
    const cardB = page.getByText(cardBText);
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible();

    // ── Scenario 1: person A + Jan date range → only person A's card visible ─
    await page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }).click();
    await page.getByRole("option", { name: personAName }).click();

    await page.locator('input[type="date"]').first().fill("2026-01-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-01-31");

    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await expect(cardB).not.toBeVisible({ timeout: 5_000 });

    // ── Scenario 2: switch to person B (date still Jan) → nothing shown ──────
    // Person B's record is Feb 15, outside the Jan date range
    await page.getByRole("combobox").filter({ hasText: personAName }).click();
    await page.getByRole("option", { name: personBName }).click();

    await expect(cardA).not.toBeVisible({ timeout: 5_000 });
    await expect(cardB).not.toBeVisible();

    // Empty-state message should appear (filters active but no matches)
    await expect(page.getByText("Žádný výdej nevyhovuje filtrům.")).toBeVisible({ timeout: 5_000 });

    // ── Scenario 3: change date range to Feb → person B's card appears ────────
    await page.locator('input[type="date"]').first().fill("2026-02-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-02-28");

    await expect(cardB).toBeVisible({ timeout: 5_000 });
    await expect(cardA).not.toBeVisible();
  });

  test("Zrušit filtry clears both person and date filters at once", async ({ page }) => {
    await page.goto("/stroje/oopp");
    await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder("Hledat...").fill(itemName);
    const cardA = page.getByText(cardAText);
    const cardB = page.getByText(cardBText);
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible();

    // Apply person A filter + January date range
    await page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }).click();
    await page.getByRole("option", { name: personAName }).click();

    await page.locator('input[type="date"]').first().fill("2026-01-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-01-31");

    // Person B hidden while both filters active
    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await expect(cardB).not.toBeVisible({ timeout: 5_000 });

    // Click "Zrušit filtry" — must reset both filters simultaneously
    await page.getByRole("button", { name: "Zrušit filtry" }).first().click();

    // Both cards must reappear
    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await expect(cardB).toBeVisible({ timeout: 5_000 });

    // Person filter combobox reverted to show "Vše"
    await expect(
      page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }),
    ).toBeVisible({ timeout: 3_000 });

    // Date inputs cleared → "Zahrnout bez data vydání" checkbox is hidden
    await expect(page.getByLabel("Zahrnout bez data vydání")).not.toBeVisible({ timeout: 3_000 });
  });
});
