---
name: Security hardening defaults
description: Safe-by-default security posture for the Stavba API (CORS, upload content validation, session, CSRF) given its same-origin proxy topology.
---

# Security hardening (Stavba API)

The web app (artifacts/stavba) and API (artifacts/api-server) are served from the
**same origin** — nginx serves the SPA and reverse-proxies `/api`. Auth is a
cookie session (`stavba.sid`, `sameSite: "lax"`, `secure: "auto"`).

## CORS
- A wildcard `cors()` is unnecessary and was removed. Default is `origin: false`
  (no `Access-Control-Allow-Origin` emitted) — same-origin traffic is unaffected.
- `CORS_ORIGINS` (comma-separated env) opens an explicit allowlist **only if the
  frontend ever moves off-origin**. Set it before any such rollout.

## Upload content validation
- The upload route validates the **declared** contentType against an allowlist
  AND now sniffs **magic bytes** (`lib/fileSignature.ts`) so disguised active
  content (HTML labelled image/png) is rejected with 415 before storage.
- `text/plain` / `text/csv` are intentionally pass-through (no stable signature).
- HEIC/HEIF check is permissive (`ftyp` box at offset 4, any brand) and OOXML
  (docx/xlsx) accepts a generic ZIP header — chosen to avoid false-rejecting
  valid files. Tradeoff is permissiveness, not breakage.

## CSRF
**Why:** `sameSite: "lax"` already stops cross-site state-changing requests
(cookie not sent on cross-site POST/PUT/DELETE). Full token-based CSRF was
deliberately NOT added — the Coolify→Traefik→nginx→API proxy chain makes
Origin/Host enforcement fragile and risks locking users out (see proxy-secure-cookie).
**How to apply:** only add token/Origin CSRF if a concrete cross-site vector
appears; test the proxy Host/Origin headers first.

## Session lifetime
- `maxAge` is 14 days with `rolling: true` → "14 days of inactivity"; active
  users are never logged out.
