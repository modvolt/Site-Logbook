---
name: Upload & request size limits
description: The three distinct size caps in Stavba (which gate what) and why the AI cap can't go arbitrarily high.
---

There are **three separate** size limits and they gate different paths — don't
conflate them:

1. **`MAX_REQUEST_BODY_MB`** (env, default 50) → `express.json`/`urlencoded` body
   limit in `app.ts`. Gates **CSV bulk imports** and **base64 JSON uploads** (e.g.
   bank-statement import). NOT binary file uploads.
2. **`MAX_UPLOAD_BYTES`** (100 MB, in `storage.ts` + `billing-documents.ts`) →
   `express.raw` limit for **binary photo/document uploads**. Independent of #1.
3. **nginx `client_max_body_size`** (`100m`, `artifacts/stavba/nginx.conf`) → outer
   proxy gate in production. Must stay ≥ the API limits or large requests 413 at
   the proxy before reaching the API.

**AI extraction cap (`OPENAI_MAX_FILE_MB`, default 32):**
`openai-extraction.ts` sends the document **inline as base64** in a Chat
Completions request (PDF as `type:"file"` data URI, images as `image_url` data
URI). So **OpenAI's own caps are the real ceiling** — roughly **32 MB per PDF**
and **~20 MB per image**.

**Why:** raising `OPENAI_MAX_FILE_MB` above ~32 is pointless — OpenAI rejects the
oversized input; the worker treats it as a retryable failure and the document
falls back to manual review (no data lost, but wasted retries/API calls). An image
between 20–32 MB passes our local check but can still be rejected by OpenAI.

**How to apply:** when asked to "raise the import/AI limits", bump
`MAX_REQUEST_BODY_MB` for bulk imports and `OPENAI_MAX_FILE_MB` (capped near 32)
for AI; the 100 MB binary upload + nginx caps are separate and already high.
