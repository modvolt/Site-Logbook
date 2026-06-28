# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/oopp-combined-person-date-filter.spec.ts >> OOPP – combined person + date filter >> person filter alone shows only that person's records
- Location: e2e/tests/oopp-combined-person-date-filter.spec.ts:72:7

# Error details

```
TypeError: apiRequestContext.post: Invalid URL
```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | import { cleanupPpeAssignment, cleanupPpeItem, cleanupPerson } from "./helpers";
  3   | 
  4   | /**
  5   |  * E2E coverage for using the person-select and date-range filters together
  6   |  * on the OOPP assignments view (/stroje/oopp).
  7   |  *
  8   |  * Covers:
  9   |  *   - Filtering by person alone hides the other person's records
  10  |  *   - Filtering by date range alone hides out-of-range records
  11  |  *   - Combining person + date filters shows only records that satisfy BOTH
  12  |  *   - Switching person while date filter is active re-filters correctly
  13  |  *   - "Zrušit filtry" resets both the person filter and the date filter in
  14  |  *     one click, making all records visible again
  15  |  */
  16  | 
  17  | test.describe("OOPP – combined person + date filter", () => {
  18  |   const ts = Date.now();
  19  | 
  20  |   let itemId = 0;
  21  |   let personAId = 0;
  22  |   let personBId = 0;
  23  |   let assignmentAId = 0;
  24  |   let assignmentBId = 0;
  25  | 
  26  |   const itemName = `E2E_OOPP_CombinedFilter_Item_${ts}`;
  27  |   const personAName = `E2E_OOPP_PersonA_${ts}`;
  28  |   const personBName = `E2E_OOPP_PersonB_${ts}`;
  29  | 
  30  |   test.beforeAll(async ({ request }) => {
> 31  |     const itemRes = await request.post("/api/ppe/items", {
      |                                   ^ TypeError: apiRequestContext.post: Invalid URL
  32  |       data: { name: itemName, category: "ostatni" },
  33  |     });
  34  |     expect(itemRes.status()).toBe(201);
  35  |     itemId = ((await itemRes.json()) as { id: number }).id;
  36  | 
  37  |     const personARes = await request.post("/api/people", {
  38  |       data: { name: personAName },
  39  |     });
  40  |     expect(personARes.status()).toBe(201);
  41  |     personAId = ((await personARes.json()) as { id: number }).id;
  42  | 
  43  |     const personBRes = await request.post("/api/people", {
  44  |       data: { name: personBName },
  45  |     });
  46  |     expect(personBRes.status()).toBe(201);
  47  |     personBId = ((await personBRes.json()) as { id: number }).id;
  48  | 
  49  |     // Person A → issued in January
  50  |     const assignARes = await request.post("/api/ppe/assignments", {
  51  |       data: { ppeItemId: itemId, personId: personAId, quantity: 1, issuedAt: "2026-01-10" },
  52  |     });
  53  |     expect(assignARes.status()).toBe(201);
  54  |     assignmentAId = ((await assignARes.json()) as { id: number }).id;
  55  | 
  56  |     // Person B → issued in February
  57  |     const assignBRes = await request.post("/api/ppe/assignments", {
  58  |       data: { ppeItemId: itemId, personId: personBId, quantity: 1, issuedAt: "2026-02-15" },
  59  |     });
  60  |     expect(assignBRes.status()).toBe(201);
  61  |     assignmentBId = ((await assignBRes.json()) as { id: number }).id;
  62  |   });
  63  | 
  64  |   test.afterAll(async ({ request }) => {
  65  |     if (assignmentAId) await cleanupPpeAssignment(request, assignmentAId);
  66  |     if (assignmentBId) await cleanupPpeAssignment(request, assignmentBId);
  67  |     if (itemId) await cleanupPpeItem(request, itemId);
  68  |     if (personAId) await cleanupPerson(request, personAId);
  69  |     if (personBId) await cleanupPerson(request, personBId);
  70  |   });
  71  | 
  72  |   test("person filter alone shows only that person's records", async ({ page }) => {
  73  |     await page.goto("/stroje/oopp");
  74  |     await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });
  75  | 
  76  |     // Both records visible initially (search by item name to narrow noise)
  77  |     await page.getByPlaceholder("Hledat...").fill(itemName);
  78  |     const cardA = page.getByText(personAName);
  79  |     const cardB = page.getByText(personBName);
  80  |     await expect(cardA).toBeVisible({ timeout: 10_000 });
  81  |     await expect(cardB).toBeVisible({ timeout: 10_000 });
  82  | 
  83  |     // Select person A
  84  |     await page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }).click();
  85  |     await page.getByRole("option", { name: personAName }).click();
  86  | 
  87  |     await expect(cardA).toBeVisible({ timeout: 5_000 });
  88  |     await expect(cardB).not.toBeVisible({ timeout: 5_000 });
  89  |   });
  90  | 
  91  |   test("date filter alone hides out-of-range records", async ({ page }) => {
  92  |     await page.goto("/stroje/oopp");
  93  |     await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });
  94  | 
  95  |     await page.getByPlaceholder("Hledat...").fill(itemName);
  96  |     const cardA = page.getByText(personAName);
  97  |     const cardB = page.getByText(personBName);
  98  |     await expect(cardA).toBeVisible({ timeout: 10_000 });
  99  |     await expect(cardB).toBeVisible();
  100 | 
  101 |     // Restrict to January — covers person A (Jan 10), excludes person B (Feb 15)
  102 |     await page.locator('input[type="date"]').first().fill("2026-01-01");
  103 |     await page.locator('input[type="date"]').nth(1).fill("2026-01-31");
  104 | 
  105 |     await expect(cardA).toBeVisible({ timeout: 5_000 });
  106 |     await expect(cardB).not.toBeVisible({ timeout: 5_000 });
  107 |   });
  108 | 
  109 |   test("person + date filters combined — only the intersection is shown", async ({ page }) => {
  110 |     await page.goto("/stroje/oopp");
  111 |     await expect(page.getByRole("heading", { name: "OOPP" })).toBeVisible({ timeout: 15_000 });
  112 | 
  113 |     await page.getByPlaceholder("Hledat...").fill(itemName);
  114 |     const cardA = page.getByText(personAName);
  115 |     const cardB = page.getByText(personBName);
  116 |     await expect(cardA).toBeVisible({ timeout: 10_000 });
  117 |     await expect(cardB).toBeVisible();
  118 | 
  119 |     // ── Scenario 1: person A + Jan date range → shows person A only ──────────
  120 |     await page.getByRole("combobox").filter({ hasText: /Zaměstnanec/ }).click();
  121 |     await page.getByRole("option", { name: personAName }).click();
  122 | 
  123 |     await page.locator('input[type="date"]').first().fill("2026-01-01");
  124 |     await page.locator('input[type="date"]').nth(1).fill("2026-01-31");
  125 | 
  126 |     await expect(cardA).toBeVisible({ timeout: 5_000 });
  127 |     await expect(cardB).not.toBeVisible({ timeout: 5_000 });
  128 | 
  129 |     // ── Scenario 2: switch to person B (date range still Jan) → nothing shown ─
  130 |     // Person B's assignment is Feb 15, outside the Jan date range
  131 |     await page.getByRole("combobox").filter({ hasText: personAName }).click();
```