import { expect, test, type Page, type Route } from "@playwright/test";

type Profile = "read-only" | "field" | "manager" | "no-jobs";

const permissionsByProfile: Record<Profile, string[]> = {
  "read-only": ["jobs.view"],
  field: ["jobs.view", "jobs.work"],
  manager: [
    "jobs.view",
    "jobs.work",
    "jobs.manage",
    "people.view",
    "customers.view",
  ],
  "no-jobs": [],
};

const job = {
  id: 40,
  jobNumber: 40,
  title: "E2E Permission Boundary",
  shortName: "E2E-40",
  type: "planned_work",
  clientSite: "Testovací stavba",
  address: "Testovací 1, Praha",
  date: "2026-07-14",
  startTime: "08:00",
  endTime: "16:00",
  status: "planned",
  assignedPersonId: 7,
  assignedPersonName: "Testovací pracovník",
  assigneeIds: [7],
  assigneeNames: ["Testovací pracovník"],
  customerId: 3,
  groupId: null,
  customerCompanyName: "E2E zákazník",
  customerPhone: null,
  customerEmail: "e2e@example.invalid",
  notes: "Izolovaná testovací zakázka",
  hoursSpent: 1.5,
  hoursFromPlan: false,
  hoursBeforePlan: null,
  hoursVasek: null,
  hoursJonas: null,
  price: null,
  transportKm: null,
  transportCost: null,
  fines: null,
  parking: null,
  recurrenceIntervalDays: null,
  timerStartedAt: null,
  sortOrder: 0,
  taskCount: 1,
  taskDoneCount: 0,
  attachmentCount: 0,
  materialCount: 0,
  consumedMaterialCount: 0,
  plannedMaterialCount: 0,
  materialTotalCost: null,
  billingLinked: false,
  pricingMode: "time_material",
  contractPrice: null,
  createdAt: "2026-07-14T08:00:00.000Z",
  archivedAt: null,
  archivedByUserId: null,
  statusBeforeArchive: null,
  signatureRequestedAt: null,
  signatureTokenExpiresAt: null,
  signedAt: null,
  signatureObjectPath: null,
};

const taskItem = {
  id: 501,
  jobId: 40,
  title: "Zapojit testovací rozvaděč",
  done: false,
  isChangeRequest: false,
  priority: "normal",
  estimatedHours: null,
  spentHours: null,
  photoPath: null,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z",
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function installMockApi(page: Page, profile: Profile) {
  const requests: string[] = [];
  const mutations: string[] = [];
  const unknownRequests: string[] = [];
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    requests.push(key);
    if (request.method() !== "GET") mutations.push(key);

    if (url.pathname === "/api/auth/me") {
      return json(route, {
        authenticated: true,
        needsSetup: false,
        user: {
          id: 99,
          username: `e2e-${profile}`,
          name: `E2E ${profile}`,
          personId: profile === "field" ? 7 : null,
          email: null,
          role: profile === "manager" ? "admin" : "guest",
          isActive: true,
          createdAt: "2026-07-14T08:00:00.000Z",
          permissions: permissionsByProfile[profile],
          permissionOverrides: [],
        },
      });
    }
    if (url.pathname === "/api/events") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/jobs/40") return json(route, job);
    if (url.pathname === "/api/jobs/40/tasks") return json(route, [taskItem]);
    if (url.pathname === "/api/jobs/40/completion-readiness") {
      return json(route, {
        canComplete: true,
        blockers: [],
        warnings: [],
        activeSessions: [],
        hoursSpent: 1.5,
        unfinishedTaskCount: 0,
        plannedMaterialCount: 0,
      });
    }
    if (url.pathname === "/api/jobs/40/work-summary") {
      return json(route, {
        totalHours: 1.5,
        laborCost: null,
        laborSale: null,
        materialCost: 0,
        materialSale: 0,
      });
    }
    if (url.pathname === "/api/me/active-work-session") return json(route, null);
    if (url.pathname === "/api/jobs/40/documents/upload" && request.method() === "POST") {
      const pageIndex = Number(url.searchParams.get("pageIndex") ?? 0);
      return json(route, {
        documentId: 900,
        status: "needs_review",
        docType: "unknown",
        pageIndex,
        pageCount: Number(url.searchParams.get("pageCount") ?? 1),
        groupComplete: url.searchParams.get("groupComplete") === "true",
        attachment: { id: 9000 + pageIndex, fileName: url.searchParams.get("name"), url: `/objects/e2e-${pageIndex}` },
      }, 201);
    }

    const listPaths = [
      "/api/jobs/40/attachments",
      "/api/jobs/40/documents",
      "/api/jobs/40/materials",
      "/api/jobs/40/time-entries",
      "/api/jobs/40/visits",
      "/api/people",
      "/api/customers",
      "/api/leaves",
      "/api/switchboards",
      "/api/warehouse/items",
    ];
    if (listPaths.includes(url.pathname)) return json(route, []);

    unknownRequests.push(key);
    return json(route, { error: `Unexpected mock API request: ${key}` }, 501);
  });

  return { requests, mutations, unknownRequests, pageErrors };
}

async function openJob(page: Page, profile: Profile) {
  const observed = await installMockApi(page, profile);
  await page.goto("/jobs/40");
  await expect(page.getByRole("heading", { name: job.title })).toBeVisible();
  return observed;
}

test.describe("job permission boundaries with isolated API mocks", () => {
  test("read-only user sees data but no management or work controls", async ({ page }) => {
    const observed = await openJob(page, "read-only");

    await expect(page.getByTitle("Archivovat zakázku")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Spustit čas/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Zakázkový list/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Odeslat k podpisu/i })).toHaveCount(0);

    await page.getByRole("heading", { name: "Úkoly a checklist" }).click();
    const taskCheckbox = page.getByRole("checkbox").first();
    await expect(taskCheckbox).toBeVisible();
    await expect(taskCheckbox).toBeDisabled();
    await expect(page.getByPlaceholder(/Nový úkol/i)).toHaveCount(0);

    expect(observed.requests).not.toContain("GET /api/jobs/40/completion-readiness");
    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("field user can work but cannot manage the job", async ({ page }) => {
    const observed = await openJob(page, "field");

    await expect(page.getByTitle("Archivovat zakázku")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Zakázkový list/i })).toHaveCount(0);
    await expect(page.getByText(taskItem.title, { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox").first()).toBeEnabled();
    await expect(page.getByPlaceholder(/Nový úkol/i)).toBeVisible();

    expect(observed.requests).not.toContain("GET /api/jobs/40/completion-readiness");
    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("job document picker keeps the current scroll position", async ({ page }) => {
    const observed = await openJob(page, "manager");

    await page.getByRole("heading", { name: "Doklady", exact: true }).click();
    const uploadButton = page.getByRole("button", {
      name: "Přidat doklad",
      exact: true,
    });
    await expect(uploadButton).toBeVisible();
    await uploadButton.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await uploadButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const captureButton = page.getByRole("button", { name: "Vyfotit stránku", exact: true });

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      captureButton.click(),
    ]);
    await fileChooser.setFiles([]);
    await page.waitForTimeout(350);

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2);
    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("field worker uploads and reorders three pages as one document", async ({ page }) => {
    const observed = await openJob(page, "field");
    await page.getByRole("heading", { name: "Doklady", exact: true }).click();
    await page.getByRole("button", { name: "Přidat doklad", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "Přidat soubor", exact: true }).click(),
    ]);
    await fileChooser.setFiles([
      { name: "strana-1.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 page 1") },
      { name: "strana-2.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 page 2") },
      { name: "strana-3.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 page 3") },
    ]);
    await expect(dialog.getByText("strana-3.pdf", { exact: true })).toBeVisible();

    const thirdHandle = dialog.getByRole("button", { name: "Přesunout stránku 3", exact: true });
    await thirdHandle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Space");
    const fileNames = await dialog.getByText(/^strana-\d\.pdf$/).allTextContents();
    expect(fileNames).not.toEqual(["strana-1.pdf", "strana-2.pdf", "strana-3.pdf"]);
    expect(new Set(fileNames)).toEqual(new Set(["strana-1.pdf", "strana-2.pdf", "strana-3.pdf"]));

    await dialog.getByRole("button", { name: "Dokončit (3)", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => observed.mutations.filter((entry) => entry === "POST /api/jobs/40/documents/upload").length).toBe(3);
    expect(observed.requests.some((entry) => entry.includes("/api/billing"))).toBe(false);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("manager sees management controls and loads readiness only on demand", async ({ page }) => {
    const observed = await openJob(page, "manager");

    await expect(page.getByTitle("Archivovat zakázku")).toBeVisible();
    await expect(page.getByRole("button", { name: /Spustit čas/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Zakázkový list/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Odeslat k podpisu/i })).toBeVisible();
    expect(observed.requests).not.toContain("GET /api/jobs/40/completion-readiness");

    await page.getByRole("button", { name: "Naplánováno", exact: true }).click();
    await page.getByRole("button", { name: "Hotovo", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Dokončit zakázku/i })).toBeVisible();
    await expect.poll(() => observed.requests).toContain(
      "GET /api/jobs/40/completion-readiness",
    );

    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("direct management URL is denied before the form mounts", async ({ page }) => {
    const observed = await installMockApi(page, "read-only");
    await page.goto("/jobs/new");

    await expect(page.getByText("Přístup odepřen", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Nová zakázka/i })).toHaveCount(0);
    expect(observed.requests).not.toContain("GET /api/people");
    expect(observed.requests).not.toContain("GET /api/customers");
    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("user without jobs.view cannot fetch a job through a direct URL", async ({ page }) => {
    const observed = await installMockApi(page, "no-jobs");
    await page.goto("/jobs/40");

    await expect(page.getByText("Přístup odepřen", { exact: true })).toBeVisible();
    expect(observed.requests).not.toContain("GET /api/jobs/40");
    expect(observed.mutations).toEqual([]);
    expect(observed.unknownRequests).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });
});
