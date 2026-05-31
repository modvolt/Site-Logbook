---
name: Orval binary request bodies
description: Why binary upload endpoints can't use the generated React Query client and must be excluded.
---

# Orval cannot generate raw-binary request bodies (fetch client)

Orval's fetch client (v8.x) only emits a raw `body: <param>` for `multipart/form-data`,
`application/x-www-form-urlencoded`, or `text/plain`. **Every other content type —
including `application/octet-stream` — gets `body: JSON.stringify(<param>)`.** For a
`Blob`/`File` that serializes to `"{}"`, silently corrupting the upload.

**Why:** see the fetch generator's `fetchBodyOption` branch in
`@orval/fetch/.../index.mjs` (`generateRequestFunction`). There is no spec-level toggle
to make a single octet-stream body raw.

**How to apply:** For any binary upload endpoint sent as a raw body:
- Implement the client with a hand-rolled `fetch` (the `useUpload` hook in
  `lib/object-storage-web/src/use-upload.ts` POSTs raw bytes; filename + content type go
  as query params).
- Keep the operation in the OpenAPI spec **only** so the **zod** target still generates the
  response schema (server uses `UploadObjectResponse` from `@workspace/api-zod`).
- Exclude the operation from the **react-query** client so it doesn't ship a broken hook:
  give the op a dedicated tag (e.g. `StorageUpload`) and add
  `filters: { mode: "exclude", tags: ["StorageUpload"] }` to the `api-client-react` input
  in `lib/api-spec/orval.config.ts`. Tag-level is the only filter granularity (no
  operationId filtering), so a dedicated single-op tag is the surgical way to exclude one op.
- Binary *responses* (object serving) are fine — only binary *request bodies* are broken.
