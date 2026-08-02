import { expect, test } from "@playwright/test";

test("authenticated app shell and service worker start without a production fallback", async ({
  page,
}) => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.locator("#root")).toBeVisible();
  await expect(page).toHaveTitle(/Modvolt Site Logbook/i);

  const authentication = await page.evaluate(async () => {
    const result = await fetch("/api/auth/me", { credentials: "same-origin" });
    return result.ok ? result.json() : { authenticated: false };
  });
  expect(authentication.authenticated).toBe(true);

  const serviceWorkerActive = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const timeout = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), 10_000),
    );
    const ready = navigator.serviceWorker.ready.then((registration) =>
      Boolean(registration.active),
    );
    return Promise.race([ready, timeout]);
  });
  expect(serviceWorkerActive).toBe(true);
});
