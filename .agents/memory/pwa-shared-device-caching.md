---
name: PWA service-worker caching on shared, authenticated devices
description: How to cache authenticated API data in the service worker without leaking one user's data to the next on a shared device
---

# PWA SW caching on shared authenticated devices

Stavba is cookie-authenticated and phones are shared between crew members. The
PWA task requires runtime caching of read-only `GET /api/*` so the app works on
flaky/offline construction-site connections.

**Rule:** use `NetworkFirst` (network tried first, short timeout) so online users
always get fresh data and the cache is only an offline fallback. The runtime
cache (`stavba-api`) MUST be purged on logout so a previous user's cached
responses can't be served to the next user while offline. Never cache writes
(POST/PATCH/DELETE).

**Why:** Workbox cache keys are URL-based, not identity-based, so without an
explicit purge the next user on the same device could see the prior user's
cached data offline. A code review rejected the "cache everything" version; an
earlier over-correction that removed API caching entirely was also wrong because
the task spec explicitly requires read caching.

**How to apply:** purge via `caches.keys()` → delete keys containing the cache
name (`src/lib/pwa.ts` `clearApiCache()`), called from every logout handler
right after `queryClient.clear()`. The SW only runs in production builds
(`devOptions.enabled = false`), so verify offline behavior with a prod build.
