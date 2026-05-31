---
name: Image/file upload failures (presigned PUT)
description: Why uploads "work in dev but fail on the deployed PWA", and how the client now surfaces the real reason
---

# Presigned-URL upload failures

The two-step upload (POST /api/storage/uploads/request-url → presigned PUT
direct to object storage) splits responsibility: the API only signs the URL;
the actual bytes go browser→storage and are **never seen by the API**, so a
failing upload leaves **no server log**. "request-url 200 but upload fails" is
the signature of a client/storage-reachability problem, not an API bug.

**Confirmed real cause (Stavba prod, Hetzner Object Storage):** the S3 endpoint
env var was a bare host `fsn1.your-objectstorage.com` **without a scheme**. The
AWS SDK runs `new URL(endpoint)` and throws `ERR_INVALID_URL "Invalid URL"`, so
`request-url` returned **500** — upload died at step 1, before any browser PUT.
Code now normalizes a scheme-less endpoint to `https://` (objectStorage.ts
`normalizeEndpoint`); to force plain HTTP write `http://...` explicitly.

**Other deployed-only causes (once request-url succeeds):**
- `S3_PUBLIC_ENDPOINT` wrong/unset → presigned URL points at an internal host
  (e.g. `http://minio:9000`) the browser can't reach → PUT rejected at network
  level.
- Bucket missing a CORS rule allowing cross-origin `PUT`/`GET` from the app
  origin → browser blocks the PUT.
Both surface in-browser as a *rejected fetch* (TypeError), not an HTTP status.

**Client contract:** `useUpload().uploadFile` re-throws (does not return null);
callers must `try/catch` and show `err.message`. The PUT step distinguishes a
rejected fetch (network/CORS) from a non-2xx (HTTP status) with distinct Czech
messages. `prepareImageFile` resize is best-effort: on canvas/decode failure
(memory-constrained iOS standalone PWA) it falls back to the source file, but
only if its MIME is in the server allowlist — otherwise it throws a clear
"formát není podporován" rather than letting the server 415.

**Why:** before this, every distinct failure collapsed into a generic "Nahrání
selhalo" toast, and job-detail handlers had no try/catch at all (silent
unhandled rejection). The real reason was invisible, making deployed upload
bugs undebuggable from user reports.
