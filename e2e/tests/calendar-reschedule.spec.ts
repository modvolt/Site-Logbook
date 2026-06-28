import { test, expect } from "@playwright/test";

/**
 * E2E tests for calendar week-view drag-and-drop rescheduling.
 *
 * Covers:
 *  1. Dragging a job chip to a different person's row → success toast
 *     "Zakázka přeřazena", the chip appears in the new row, the API confirms
 *     the move, and the calendar stays navigable.
 *  2. Dragging a job chip onto a slot where the target person has an approved
 *     leave → conflict toast "Přeřazení neprovedeno", chip snaps back to the
 *     original row, and the API confirms the job was NOT moved.
 *
 * Design notes:
 *  - TEST_DATE is the Wednesday of the ISO week that contains today, computed
 *    at runtime so the tests stay green on any future date.
 *  - Job chips are rendered in "compact" mode with title truncated to 14 chars.
 *    Locators use the `title` attribute (full job title) rather than text.
 *  - DroppableSlots expose `data-slot="slot-{personId}-{date}"` (added to
 *    calendar.tsx) so tests can reliably locate exact target cells.
 *  - dnd-kit PointerSensor activates after 6 px; the drag helper nudges 8 px
 *    first, then sweeps in 25 steps so collision detection fires correctly.
 *  - `?testMode=1` extends the toast auto-dismiss to 30 s.
 *  - Persons A/B and C/D are created consecutively so their rows are always
 *    adjacent (one row apart). The target slot is centered in the viewport so
 *    both rows are simultaneously on-screen for valid bounding-box reads.
 */

// ─── Dynamic test date ────────────────────────────────────────────────────────

/**
 * Return the Wednesday (ISO 8601 "YYYY-MM-DD") of the ISO week that contains
 * the given date (weeks start on Monday).  This day is always visible in the
 * calendar's week view without any navigation.
 */
function getISOWeekWednesday(date: Date): string {
  const isoDay = date.getDay() === 0 ? 7 : date.getDay(); // 1 Mon … 7 Sun
  const daysToMonday = isoDay - 1;
  const wednesday = new Date(date);
  wednesday.setDate(date.getDate() - daysToMonday + 2); // Mon + 2 = Wed
  return wednesday.toISOString().slice(0, 10);
}

const TEST_DATE = getISOWeekWednesday(new Date());

type PersonResponse = { id: number; name: string };
type JobResponse = { id: number };
type LeaveResponse = { id: number };

// ─── Cleanup helpers ─────────────────────────────────────────────────────────

async function cleanupLeave(
  request: import("@playwright/test").APIRequestContext,
  id: number,
) {
  await request.delete(`/api/leaves/${id}`).catch(() => {});
}

async function cleanupJob(
  request: import("@playwright/test").APIRequestContext,
  id: number,
) {
  await request.delete(`/api/jobs/${id}`).catch(() => {});
}

async function cleanupPerson(
  request: import("@playwright/test").APIRequestContext,
  id: number,
) {
  await request.delete(`/api/people/${id}`).catch(() => {});
}

// ─── Drag helper ─────────────────────────────────────────────────────────────

/**
 * Simulate a dnd-kit pointer-sensor drag from (srcX, srcY) to (dstX, dstY).
 * dnd-kit PointerSensor requires > 6 px of movement before it activates;
 * we nudge 8 px first so the sensor fires before sweeping to the target.
 */
async function dndDrag(
  page: import("@playwright/test").Page,
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
) {
  await page.mouse.move(srcX, srcY);
  await page.mouse.down();
  await page.mouse.move(srcX + 8, srcY, { steps: 5 });
  await page.mouse.move(dstX, dstY, { steps: 25 });
  await page.mouse.up();
}

/**
 * Scroll an element to the center of the viewport using JS so there is room
 * above and below it for adjacent rows to also be on-screen.
 */
async function scrollToCenter(
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator,
) {
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await page.waitForTimeout(200);
}

// ─── Test 1: Successful reschedule ───────────────────────────────────────────

test.describe("Calendar week-view rescheduling", () => {
  let personAId: number;
  let personBId: number;
  let jobId: number;
  const tag = `E2E_CAL_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const pA = await request.post("/api/people", {
      data: { name: `${tag}_A` },
    });
    expect(pA.status(), "create person A").toBe(201);
    personAId = ((await pA.json()) as PersonResponse).id;

    const pB = await request.post("/api/people", {
      data: { name: `${tag}_B` },
    });
    expect(pB.status(), "create person B").toBe(201);
    personBId = ((await pB.json()) as PersonResponse).id;

    const jRes = await request.post("/api/jobs", {
      data: {
        title: `${tag}_Job`,
        date: TEST_DATE,
        type: "other",
        status: "planned",
        assignedPersonId: personAId,
      },
    });
    expect(jRes.status(), "create job").toBe(201);
    jobId = ((await jRes.json()) as JobResponse).id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupJob(request, jobId);
    await cleanupPerson(request, personAId);
    await cleanupPerson(request, personBId);
  });

  test("dragging a job chip to a different person slot succeeds", async ({ page }) => {
    await page.goto("/calendar?testMode=1");

    // Ensure week view
    await expect(page.getByRole("button", { name: /Týden/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /Týden/i }).click();

    await expect(page.getByText(`${tag}_A`, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`${tag}_B`, { exact: true })).toBeVisible();

    // Chip locator — title attr carries the full (untruncated) job title
    const chip = page.locator(`[title="${tag}_Job"]`);
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // Slot locators for person A (source) and person B (target)
    const sourceSlot = page.locator(`[data-slot="slot-${personAId}-${TEST_DATE}"]`);
    const targetSlot = page.locator(`[data-slot="slot-${personBId}-${TEST_DATE}"]`);
    await expect(sourceSlot).toBeAttached({ timeout: 5_000 });
    await expect(targetSlot).toBeAttached({ timeout: 5_000 });

    // Center the target slot so person A's row (one row above) is also visible
    await scrollToCenter(page, targetSlot);

    const targetBox = await targetSlot.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(targetBox, "target slot bounding box").not.toBeNull();
    expect(chipBox, "chip bounding box").not.toBeNull();

    const srcX = chipBox!.x + chipBox!.width / 2;
    const srcY = chipBox!.y + chipBox!.height / 2;
    const dstX = targetBox!.x + targetBox!.width / 2;
    const dstY = targetBox!.y + targetBox!.height / 2;

    await dndDrag(page, srcX, srcY, dstX, dstY);

    // ── Success toast ─────────────────────────────────────────────────────────
    await expect(
      page.getByTestId("toast-title").filter({ hasText: "Zakázka přeřazena" }),
    ).toBeVisible({ timeout: 10_000 });

    // ── UI assertion: chip now visible in person B's slot ─────────────────────
    await expect(
      targetSlot.locator(`[title="${tag}_Job"]`),
    ).toBeVisible({ timeout: 8_000 });

    // ── Navigation guard: calendar view must still be open ────────────────────
    expect(page.url()).toContain("/calendar");

    // ── API assertion: server confirms the move ───────────────────────────────
    await page.waitForTimeout(1_000);
    const jobRes = await page.request.get(`/api/jobs/${jobId}`);
    expect(jobRes.status()).toBe(200);
    const job = (await jobRes.json()) as { assignedPersonId: number; date: string };
    expect(job.assignedPersonId).toBe(personBId);
    expect(job.date).toBe(TEST_DATE);
  });
});

// ─── Test 2: Leave conflict ───────────────────────────────────────────────────

test.describe("Calendar rescheduling blocked by leave", () => {
  let personCId: number;
  let personDId: number;
  let jobId: number;
  let leaveId: number;
  const tag = `E2E_CAL_LV_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const pC = await request.post("/api/people", {
      data: { name: `${tag}_C` },
    });
    expect(pC.status(), "create person C").toBe(201);
    personCId = ((await pC.json()) as PersonResponse).id;

    const pD = await request.post("/api/people", {
      data: { name: `${tag}_D` },
    });
    expect(pD.status(), "create person D").toBe(201);
    personDId = ((await pD.json()) as PersonResponse).id;

    const jRes = await request.post("/api/jobs", {
      data: {
        title: `${tag}_Job`,
        date: TEST_DATE,
        type: "other",
        status: "planned",
        assignedPersonId: personCId,
      },
    });
    expect(jRes.status(), "create job").toBe(201);
    jobId = ((await jRes.json()) as JobResponse).id;

    // Person D has vacation on TEST_DATE — dragging the job there must 409
    const lRes = await request.post("/api/leaves", {
      data: {
        personId: personDId,
        type: "vacation",
        startDate: TEST_DATE,
        endDate: TEST_DATE,
      },
    });
    expect(lRes.status(), "create leave").toBe(201);
    leaveId = ((await lRes.json()) as LeaveResponse).id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupLeave(request, leaveId);
    await cleanupJob(request, jobId);
    await cleanupPerson(request, personCId);
    await cleanupPerson(request, personDId);
  });

  test("dragging onto a leave slot shows conflict toast and reverts chip", async ({ page }) => {
    await page.goto("/calendar?testMode=1");

    // Ensure week view
    await expect(page.getByRole("button", { name: /Týden/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /Týden/i }).click();

    await expect(page.getByText(`${tag}_C`, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`${tag}_D`, { exact: true })).toBeVisible();

    // Chip locator
    const chip = page.locator(`[title="${tag}_Job"]`);
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // Slot locators
    const sourceSlot = page.locator(`[data-slot="slot-${personCId}-${TEST_DATE}"]`);
    const targetSlot = page.locator(`[data-slot="slot-${personDId}-${TEST_DATE}"]`);
    await expect(sourceSlot).toBeAttached({ timeout: 5_000 });
    await expect(targetSlot).toBeAttached({ timeout: 5_000 });

    // Center the target slot so person C's chip (one row above) is also visible
    await scrollToCenter(page, targetSlot);

    const targetBox = await targetSlot.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(targetBox, "target slot bounding box").not.toBeNull();
    expect(chipBox, "chip bounding box").not.toBeNull();

    const srcX = chipBox!.x + chipBox!.width / 2;
    const srcY = chipBox!.y + chipBox!.height / 2;
    const dstX = targetBox!.x + targetBox!.width / 2;
    const dstY = targetBox!.y + targetBox!.height / 2;

    await dndDrag(page, srcX, srcY, dstX, dstY);

    // ── Conflict toast ────────────────────────────────────────────────────────
    await expect(
      page.getByTestId("toast-title").filter({ hasText: "Přeřazení neprovedeno" }),
    ).toBeVisible({ timeout: 10_000 });

    // ── UI assertion: chip snapped back to person C's slot ───────────────────
    // After the 409 the query is invalidated and the chip reverts; wait for it.
    await expect(
      sourceSlot.locator(`[title="${tag}_Job"]`),
    ).toBeVisible({ timeout: 8_000 });

    // ── Navigation guard: calendar view must still be open ────────────────────
    expect(page.url()).toContain("/calendar");

    // ── API assertion: server confirms no change ──────────────────────────────
    await page.waitForTimeout(1_000);
    const jobRes = await page.request.get(`/api/jobs/${jobId}`);
    expect(jobRes.status()).toBe(200);
    const job = (await jobRes.json()) as { assignedPersonId: number; date: string };
    expect(job.assignedPersonId).toBe(personCId);
    expect(job.date).toBe(TEST_DATE);
  });
});
