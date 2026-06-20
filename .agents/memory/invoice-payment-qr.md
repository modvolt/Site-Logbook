---
name: Invoice payment QR (Czech QR Platba / SPAYD)
description: How the invoice PDF payment QR works and the esbuild verification gotcha that bit twice.
---

# Invoice payment QR — durable notes

The invoice PDF can embed a Czech "QR Platba" (SPAYD) payment code. No DB/OpenAPI
change was needed — `billing_settings` already carried `iban`/`bankAccount`/`bic`
and the invoice carries `variableSymbol`/`totalWithVat`/`dueDate`.

## Durable decisions
- **Amount = `totalWithVat`.** That is what the customer actually pays, correct for
  standard / PDP (reverse-charge) / mixed invoices alike.
- **IBAN resolution:** prefer the explicit `settings.iban`; otherwise derive a CZ
  IBAN from the domestic `[prefix-]number/bankcode` via ISO 13616 mod-97. Published
  check vector: `19-2000145399/0800` → `CZ6508000000192000145399`.
- **QR is best-effort:** generation returns null on any failure and is skipped for
  cash/card payment methods, missing IBAN, or non-positive total — issuing an
  invoice must never fail because of the QR.
- **Why a page-break guard exists** before the totals/QR block: on long invoices the
  line table can finish near the page bottom; without `addPage()` the QR (left col)
  and totals (right col) clip off the page.

## Gotcha — verifying api-server code in an ad-hoc esbuild bundle
`qrcode` is a CJS package whose server entry does `require("fs")`. The real
api-server build (`build.mjs`) is **ESM** but injects a `createRequire` banner
(`globalThis.require = createRequire(import.meta.url)`), which is why CJS deps like
express AND qrcode work at runtime. If you hand-roll a verification bundle with
plain `esbuild --format=esm` and omit that banner, it dies at runtime with
`Dynamic require of "fs" is not supported`. **Fix:** pass the same
`--banner:js=...createRequire...` (or just trust typecheck + unit tests). Do not
mistake this harness artifact for a production bug — the shipped build is fine.
