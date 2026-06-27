---
name: Vitest issueInvoice .ttf font loader
description: Why DB tests that call issueInvoice need a vitest .ttf base64 plugin, and how the invoice PDF embeds fonts.
---

# Testing issueInvoice under vitest needs a `.ttf` base64 loader

The invoice PDF (`invoice-pdf.ts`) embeds Roboto by importing
`../assets/fonts/Roboto-*.ttf` directly. In production this works because
`build.mjs` configures esbuild with `loader: { ".ttf": "base64" }` — the import
resolves to a base64 string that jsPDF's `addFileToVFS` accepts.

**Why:** vitest does NOT use that esbuild loader. Without a matching transform,
`.ttf` imports resolve to undefined/path, font registration silently no-ops, and
the first `setFont("Roboto")` during issuing crashes with
`Cannot read properties of undefined (reading 'widths')` deep inside jsPDF.

**How to apply:** `artifacts/api-server/vitest.config.ts` has a `ttfBase64`
plugin (a `transform` that returns `export default "<base64>"` for `*.ttf`).
Any DB-backed test that exercises the full `issueInvoice` path (it always
generates + uploads the PDF) depends on this plugin. Keep it in sync with the
esbuild loader if either changes.
