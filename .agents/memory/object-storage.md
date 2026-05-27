---
name: Object storage setup
description: Replit Object Storage is provisioned and wired for attachment uploads; key architectural decisions and sharp edges.
---

## What's set up
- Bucket provisioned; env vars `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` are set.
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
