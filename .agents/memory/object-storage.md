---
name: Object storage setup
description: Replit Object Storage is provisioned and wired for attachment uploads; key architectural decisions and sharp edges.
---

## Dual backend (S3 + GCS)
- `objectStorage.ts` picks a backend at runtime: **S3-compatible** when `S3_BUCKET`+`S3_ACCESS_KEY_ID`+`S3_SECRET_ACCESS_KEY` are set (self-hosted/Docker/Hetzner/MinIO prod), else falls back to **Replit App Storage (GCS via sidecar `http://127.0.0.1:1106`)** used in Replit dev.
- **Why:** the Docker self-host task rewrote storage to S3-only; Replit dev has no S3 vars (only GCS App Storage), so every upload threw 500. Keep BOTH paths — never make storage S3-only again or dev uploads break.
- Both backends keep the same 4-method interface and backend-agnostic objectPath `/objects/uploads/<uuid>`; missing objects must throw `ObjectNotFoundError` so routes return 404.
- Requires `@google-cloud/storage` + `google-auth-library` in `api-server/package.json` (a merge once removed these — re-add if uploads 500 in dev).

## What's set up
- Bucket provisioned; env vars `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` are set (GCS dev path).
- Server files: `artifacts/api-server/src/lib/objectStorage.ts`, `objectAcl.ts`, `routes/storage.ts`.
- Client lib: `lib/object-storage-web` (composite tsconfig, `useUpload` hook). The old Uppy `ObjectUploader` widget + `@uppy/*` deps and `@aws-sdk/s3-request-presigner` were dead leftovers from the presigned-PUT flow and were removed; don't reintroduce Uppy/presigner.
- Routes mounted at `/api/storage/...` (no `/api` prefix in the route file itself — Express mounts at `/api` via the outer router).

## url column convention
- New attachments: `url` = `/objects/uploads/<uuid>` — serve via `GET /api/storage${url}`
- Legacy attachments: `url` = `data:image/...` base64 — display directly
- Helper `getAttachmentUrl(url)` in `job-detail.tsx` handles both cases.

## Sharp edges
- `object-storage-web` tsconfig must be `composite: true` to be referenced by other packages.

**Why:** Photos stored as base64 in the DB balloon row sizes fast (5 MB photo → ~6.7 MB of text). Storing only the object path (server-proxied upload → bucket) keeps DB lean and images fast.

## Server-proxied uploads (CORS workaround)
- Uploads now go browser → `POST /api/storage/uploads` (same origin) → server `putPrivateObject`, NOT direct browser→bucket presigned PUT. This removes the bucket-CORS / browser-reachable-endpoint requirement that broke self-hosted (Hetzner/Coolify) deploys.
- **Cross-config coupling:** because file bytes now flow through nginx, `client_max_body_size` in `artifacts/stavba/nginx.conf` MUST be ≥ the API's `MAX_UPLOAD_BYTES` (currently 50 MB). If nginx is smaller, large photos get an **HTML** 413 from nginx (not JSON) before reaching the API — the client can't parse it cleanly. Body is buffered in RAM per concurrent upload.
- Client uses XHR (not fetch) for real upload progress; error messages must stay precise (HTTP code + server `{error}` detail, de-HTML'd proxy bodies, connectivity vs HTTP distinction) so on-site users see the exact cause.
- Server 500 on upload appends the underlying storage error message (capped) so prod misconfig (Access Denied / missing bucket / ENOTFOUND endpoint) is diagnosable from the UI.
- **`S3_PUBLIC_ENDPOINT` + bucket CORS are dead since the server-proxied switch** — the code never reads `S3_PUBLIC_ENDPOINT`; only `S3_ENDPOINT` (server→bucket) matters. Don't reinstate browser→bucket presigned uploads or CORS requirements in deployment docs (docker-compose/.env.example/DEPLOYMENT.md/README/PRODUCTION_READINESS). A self-hosted prod still failing uploads is almost always running the OLD presigned build → **redeploy**; old-flow CORS failures show only in the browser console, no app-level error text.
