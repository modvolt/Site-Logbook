---
name: E2E test setup (Playwright)
description: Lessons from setting up Playwright E2E tests in the Stavba monorepo — auth, rate limiting, dev DB drift, and toast locators.
---

# E2E Playwright setup

## Auth / global setup
- `e2e/global.setup.ts` logs in once via `request.newContext()` + `POST /api/auth/login`, saves cookies to `e2e/.auth/admin.json` (storageState).
- All tests reference `storageState: ".auth/admin.json"` in `playwright.config.ts`; login tests override with `test.use({ storageState: { cookies: [], origins: [] } })`.
- `page.request` shares browser-context cookies from storageState and IS authenticated for all API calls.
- `request` fixture is also authenticated when `storageState` is set in the project config.

## Rate limiter
- Auth endpoint is rate-limited (20 req / 15 min by IP). Add a `skip` for localhost so test runs (which connect directly) are never blocked.
- In production the proxy sets `X-Forwarded-For` and `req.ip` is the real client IP, so the skip never fires there.
- **Why:** repeated test debugging exhausts the 20-req window; the skip makes tests unconditionally reliable.

## Dev DB schema drift
- Dev DB is provisioned via `drizzle push` and may lag behind new migrations. Columns added by recent migrations won't exist.
- Before running DB-backed E2E tests, verify with `psql $DATABASE_URL -c "\d table_name"` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` for any missing columns.
- Known gaps that were patched: `jobs.short_name` (TEXT), `warehouse_movements.idempotency_key` (TEXT) + `warehouse_movements.cost_price_at_time` (numeric(10,2)), `billing_settings.margin_alert_threshold_percent` (numeric(6,2) NOT NULL DEFAULT '0').
- **How to apply:** any test that creates/queries a record and gets a 500 (not 401) = check for missing columns first, not an auth issue.

## Running the suite (cwd matters)
- `storageState`/`globalSetup` paths are resolved relative to **cwd**, and global setup writes the auth file under `e2e/.auth/`. Run from inside `e2e/` (`cd e2e && pnpm test <filter>`), NOT the root `pnpm run test:e2e` — the root script runs from repo root so every storageState test fails with `ENOENT .auth/admin.json`.
- `pnpm test <substring>` filters by spec filename; the `-- <file>` form does not filter.

## API field types when seeding via request
- `POST /api/warehouse-items` wants `purchasePrice`/`salePrice`/`quantity` as **numbers**, not strings (Zod `invalid_type` 400). `POST /api/jobs/:id/materials` `pricePerUnit` is also a number.
- A job material linked to a warehouse item creates the OUT movement: `unitPrice` = material `pricePerUnit` (sale), `costPriceAtTime` = item `purchasePrice` (cost). So purchasePrice 100 + pricePerUnit 50 → cumulative margin -100%.

## Toast locator strict mode
- Shadcn/ui toasts render both a visible div AND an aria-live `<span role="status">` announcement. Both contain the toast text, so `getByText("...")` (without `exact: true`) hits a strict-mode violation (2 elements).
- Fix title: `page.getByText("Toast title", { exact: true })` — the aria-live span contains extra prefix ("Notification …") so exact match picks only the div.
- Fix description: if the description text also appears in the span, use `page.locator('[data-component-name="ToastDescription"]').filter({ hasText: "…" })` instead.

## Toast timing — data-testid + testMode flag
- Toasts auto-dismiss in ~5 s (Radix default). The assertion can race the dismissal.
- `ToastTitle` now has `data-testid="toast-title"` and `ToastDescription` has `data-testid="toast-description"` — use `page.getByTestId("toast-title")` for reliable, fast locating.
- For more time: append `?testMode=1` to the URL — `ToastProvider` receives `duration=30000` ms instead of the default, giving 30 s before auto-dismiss.
- Pattern: navigate with `?testMode=1` when a test plan needs to assert a toast; otherwise use default duration for normal UX.
- **Why:** toasts that dismissed before Playwright reached the assertion caused false negatives even when the underlying behavior was correct.

## Stale toast false-positives in retry loops
- `TOAST_LIMIT = 1` (use-toast.ts): each new toast() call replaces the previous one in place, so a loop asserting `toast-title` text on each retry iteration can pass even when NO new toast fired — it's just re-reading the toast left over from an earlier iteration (worsened by `?testMode=1`'s 30s duration).
- Don't infer "an attempt happened" from toast text in a multi-iteration retry loop. Assert on the actual state driving the retry instead (e.g. poll an IndexedDB/queue record's attempt counter via `page.evaluate` + `expect.poll`) and only use the toast for a final one-shot check.
- **Why:** a test cycling online/offline to drive N retry attempts silently degenerated into "toast asserted 3x, but only 1 real flush ran" — every iteration after the first was a no-op that the toast assertion couldn't detect.

## Warehouse card delete button locator
- The sklad.tsx Card contains both the item name and the delete button.
- `page.locator("div").filter({ has: text }).last()` returns the *innermost* matching div (the name-only div), which does NOT contain the button.
- Fix: `page.locator(".transition-colors").filter({ has: page.getByText(name, { exact: true }) })` targets the Card-level div (which has `transition-colors` class and contains both name and button).
