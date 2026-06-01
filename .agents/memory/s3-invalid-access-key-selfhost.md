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

5. **AWS SDK v3 default checksum trailer (THE actual root cause here).** This is
   the one that finally explained it: keys were correct, in the right project &
   location (Falkenstein/fsn1), env clean in the container — yet uploads still
   got `InvalidAccessKeyId`. **Tell-tale sign: ONLY PutObject (upload) fails;
   GET/HEAD/DELETE succeed.** AWS SDK v3 >= 3.729 defaults to attaching a CRC32
   checksum to uploads via `aws-chunked` content-encoding + a streaming trailer.
   Hetzner Object Storage (and other non-AWS S3 stores) don't implement trailing
   checksums and reject the request with a misleading `InvalidAccessKeyId`.
   **Fix:** set `requestChecksumCalculation: "WHEN_REQUIRED"` and
   `responseChecksumValidation: "WHEN_REQUIRED"` on the S3Client. MinIO is
   unaffected (it supports trailers), which is why bundled MinIO worked while
   Hetzner didn't.
   **Order note:** check #5 FIRST when only uploads fail but reads/deletes work —
   that pattern rules out creds/commit/whitespace and points straight here.

**Disambiguation:** the bundled MinIO and Hetzner both return `InvalidAccessKeyId`,
so the error alone doesn't tell you which endpoint the API hit. If the
`createbuckets` service succeeds (`Bucket created successfully`), the unified
creds are valid against MinIO — so a still-failing API means it's pointed at the
external S3 (S3_ENDPOINT set) and the external key is the problem.

## RESOLVED (Hetzner): path-style addressing, not credentials
Diagnose probe on Hetzner Object Storage (fsn1) showed: ListBuckets ok +
bucket LISTED, yet HeadBucket/PutObject on that same bucket → 403
InvalidAccessKeyId. That combination (service-level call works, bucket-scoped
calls 403) means the KEY IS FINE and the bucket EXISTS — the failure is the
addressing style. Hetzner expects **virtual-hosted-style**
(`<bucket>.fsn1.your-objectstorage.com`), not path-style
(`fsn1.your-objectstorage.com/<bucket>`). Fix: set
`S3_FORCE_PATH_STYLE=false` (env-only, no rebuild). path-style (true) is for
MinIO-style gateways, NOT Hetzner.
**Tell:** if ListBuckets+bucketListed succeed but HeadBucket/PutObject 403,
stop suspecting creds — flip the addressing style first.
