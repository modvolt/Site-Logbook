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
- Known gaps that were patched: `jobs.short_name` (TEXT), `warehouse_movements.idempotency_key` (TEXT).
- **How to apply:** any test that creates/queries a record and gets a 500 (not 401) = check for missing columns first, not an auth issue.

## Toast locator strict mode
- Shadcn/ui toasts render both a visible div AND an aria-live `<span role="status">` announcement. Both contain the toast text, so `getByText("...")` (without `exact: true`) hits a strict-mode violation (2 elements).
- Fix title: `page.getByText("Toast title", { exact: true })` — the aria-live span contains extra prefix ("Notification …") so exact match picks only the div.
- Fix description: if the description text also appears in the span, use `page.locator('[data-component-name="ToastDescription"]').filter({ hasText: "…" })` instead.

## Warehouse card delete button locator
- The sklad.tsx Card contains both the item name and the delete button.
- `page.locator("div").filter({ has: text }).last()` returns the *innermost* matching div (the name-only div), which does NOT contain the button.
- Fix: `page.locator(".transition-colors").filter({ has: page.getByText(name, { exact: true }) })` targets the Card-level div (which has `transition-colors` class and contains both name and button).
