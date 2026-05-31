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
- Client lib: `lib/object-storage-web` (composite tsconfig, Uppy v5 + `useUpload` hook).
- Routes mounted at `/api/storage/...` (no `/api` prefix in the route file itself — Express mounts at `/api` via the outer router).

## url column convention
- New attachments: `url` = `/objects/uploads/<uuid>` — serve via `GET /api/storage${url}`
- Legacy attachments: `url` = `data:image/...` base64 — display directly
- Helper `getAttachmentUrl(url)` in `job-detail.tsx` handles both cases.

## Sharp edges
- The objectStorage.ts template had a TypeScript error: `response.json()` returns `unknown`; fixed with `as { signed_url: string }` cast.
- Uppy v5 requires `react@>=19` — the catalog already pins React 19, so no pnpm overrides needed. Do NOT add `$react` overrides to root `package.json` (the `$react` syntax requires react as a direct root dependency).
- `object-storage-web` tsconfig must be `composite: true` to be referenced by other packages.

**Why:** Photos stored as base64 in the DB balloon row sizes fast (5 MB photo → ~6.7 MB of text). GCS presigned URL flow keeps DB lean and images fast.

## Server-proxied uploads (CORS workaround)
- Uploads now go browser → `POST /api/storage/uploads` (same origin) → server `putPrivateObject`, NOT direct browser→bucket presigned PUT. This removes the bucket-CORS / browser-reachable-endpoint requirement that broke self-hosted (Hetzner/Coolify) deploys.
- **Cross-config coupling:** because file bytes now flow through nginx, `client_max_body_size` in `artifacts/stavba/nginx.conf` MUST be ≥ the API's `MAX_UPLOAD_BYTES` (30 MB). If nginx is smaller, large photos get an **HTML** 413 from nginx (not JSON) before reaching the API — the client can't parse it cleanly.
- Client uses XHR (not fetch) for real upload progress; error messages must stay precise (HTTP code + server `{error}` detail, de-HTML'd proxy bodies, connectivity vs HTTP distinction) so on-site users see the exact cause.
- Server 500 on upload appends the underlying storage error message (capped) so prod misconfig (Access Denied / missing bucket / ENOTFOUND endpoint) is diagnosable from the UI.
