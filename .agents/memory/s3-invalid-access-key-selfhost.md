---
name: S3 InvalidAccessKeyId on self-hosted deploy
description: Recurring causes of S3 InvalidAccessKeyId for the Stavba upload flow on Coolify + external S3 (Hetzner)
---

`InvalidAccessKeyId` 500s on POST /api/storage/uploads (self-hosted Coolify +
Hetzner) have had several distinct root causes. Work through them in order:

1. **Wrong commit deployed.** Coolify deploys FROM the GitHub repo
   (modvolt/Site-Logbook, branch main), not the Replit workspace. Always confirm
   the deploy log line `Importing ... (commit sha XXXX)` matches the local HEAD.
   If older, the user must push via the Replit Git pane (shell push fails — no
   token).

2. **Coolify mangles nested compose defaults.** `${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER}}`
   — Coolify's own `${...}` pre-parser corrupts nested `${...}` inside `${...}`,
   so the key sent to the provider is garbage. Flat defaults
   (`${S3_ENDPOINT:-http://minio:9000}`) are fine — that's why the endpoint
   override worked but creds didn't.
   **Fix:** keep S3 creds a SINGLE flat var pair; never nest interpolation
   defaults in docker-compose.

3. **Trailing whitespace in pasted keys.** Deploy UIs append a space/newline
   when pasting. **Fix:** `.trim()` accessKeyId/secret in the S3 client.

4. **Genuine Hetzner key/project mismatch.** If still failing after 1–3, the
   key is wrong or was created in a different Hetzner project than the bucket.
   Diagnose in the api container: `printenv | grep -E 'S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_ACCESS_KEY_ID'`
   and confirm the key matches Hetzner and shares the bucket's project.

**Disambiguation:** the bundled MinIO and Hetzner both return `InvalidAccessKeyId`,
so the error alone doesn't tell you which endpoint the API hit. If the
`createbuckets` service succeeds (`Bucket created successfully`), the unified
creds are valid against MinIO — so a still-failing API means it's pointed at the
external S3 (S3_ENDPOINT set) and the external key is the problem.
