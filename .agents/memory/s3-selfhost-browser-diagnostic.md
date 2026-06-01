---
name: Diagnosing self-host S3 from the browser, not logs
description: Why deploy-log paste fails for S3 creds debugging and the admin browser-probe pattern that replaces it
---

When debugging a self-hosted S3 backend (Hetzner Object Storage etc.) the
obvious move — have the user paste the api/deploy logs — repeatedly FAILS:
deploy-log viewers / attachment scrubbers REDACT the span around anything that
looks like an access key, so the very field you need (the access key id the
provider echoes back, region hints) gets `<REDACTED>` and often merges/truncates
adjacent lines. You burn deploy cycles and never see the value.

**Pattern that works:** add an admin-gated `GET /api/storage/diagnose` endpoint
that runs live probes against the configured S3 and returns a plain,
secret-free verdict the user reads straight in the browser:
- ListBuckets — pure credential check, independent of bucket/region.
- HeadBucket — bucket existence + correct region (301 / x-amz-bucket-region
  header reveals a wrong-location bucket).
- a throwaway PutObject (deleted after) — the exact op uploads use.
Return only **last-4 chars** of the configured key AND of any key the provider
echoes back (compare them), plus code/httpStatus/region hints. Never the full
key, never the secret — masked tails don't trip the scrubber.

**Reading the verdict:**
- ListBuckets fails InvalidAccessKeyId → key genuinely unknown at this endpoint:
  either Coolify key/secret ≠ a valid Hetzner key, OR bucket is in a different
  location than S3_REGION/S3_ENDPOINT. Regenerate creds in the SAME Hetzner
  project as the bucket and verify the bucket's location.
- ListBuckets ok but HeadBucket 301/region-hint → right key, wrong region:
  fix S3_REGION + S3_ENDPOINT to the bucket's location.
- All probes ok but real upload still fails → signature/checksum incompat or
  write permission, not credentials.

**Why:** the SDK-v3 aws-chunked checksum-trailer theory (set
requestChecksumCalculation WHEN_REQUIRED) was DISPROVEN here — the fix was
confirmed live via a startup marker yet uploads still got InvalidAccessKeyId,
and ListBuckets/HeadBucket had never even been exercised. Probe each layer
separately instead of assuming "only uploads fail."
