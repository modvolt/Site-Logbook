---
name: Cost-document ZIP / multi-file import
description: How received cost-documents support multi-file + ZIP upload, and the .isdocx-vs-.zip trap.
---

# Cost-document multi-file + ZIP import

Received cost-documents (Fakturace → Přijaté doklady) accept multiple files at
once and a `.zip` archive. ZIPs are expanded **client-side** (fflate, in the web
app) and each contained supported file is uploaded through the normal single-file
upload endpoint.

**Why client-side, per-file:** reuses the existing per-file content-hash dedup and
the OpenAI extraction queue unchanged — no server-side unzip, no new content-type
or zip-bomb handling on the API.

## The trap: `.isdocx` is ALSO a zip container
`.isdocx` is a zip-based Czech e-invoice but is a SINGLE document. It must NEVER be
expanded as an archive — only true `.zip` files are. Any archive-detection check
must exempt `.isdocx` first (upload it as one document).

**How to apply:** if you touch the upload accept-list or archive logic, keep the
`.isdocx` exemption, and keep ZIP expansion confined to the supported doc
extensions (pdf/jpg/jpeg/png/webp/xml/isdoc/isdocx); skip dirs, `__MACOSX/`,
dotfiles, empty + unsupported entries. Corrupt/unopenable archives must be counted
and surfaced in the summary, not silently dropped.

## Extraction is automatic
Both manual upload and Gmail import funnel through the shared ingest, which
enqueues an OpenAI extraction job (runs only when AI is configured+enabled+ready;
never auto-approves). The manual "extract" button only re-runs extraction.
