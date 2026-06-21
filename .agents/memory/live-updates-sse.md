---
name: Real-time cross-device refresh (SSE)
description: How open screens stay live when another device changes data; server pushes domain names, client owns the query-key mapping.
---

# Real-time cross-device refresh (SSE)

Open lists/detail screens refresh within ~1–2s when another device mutates data,
via a Server-Sent Events stream — on top of (not replacing) the existing
refetch-on-focus / refetch-on-reconnect fallback.

## Architecture / contract

- **Server emits domain *names* only**; the client owns the query-key mapping.
  The SSE `invalidate` event payload is `{ domains: string[] }`; the client feeds
  those straight into the existing `invalidateData(qc, ...domains)`
  (`query-invalidation.ts`). The server's domain union MUST stay in lockstep with
  the client `InvalidationDomain` union (two files, no shared import).
- **Broadcast on success only.** A dedicated `broadcastMutations` middleware
  mirrors the audit middleware: acts on mutating methods, publishes in
  `res.on("finish")` only for 2xx/3xx. A failed mutation (e.g. a 500) must not
  broadcast — verified.

**Why two middlewares instead of folding into audit:** the audit middleware
SKIPS `/billing/bank-statements/` and `/billing/email-import/` (they write their
own richer audit rows), but those paths still change data open screens display —
so the broadcast path must NOT skip them. Keep the skip lists independent.

## Gotchas

- **Service worker must not cache the SSE stream.** The PWA NetworkFirst rule
  matches `GET /api/*`; exclude `/api/events` in its `urlPattern` or workbox
  clones/holds the never-ending response and the channel breaks.
- **nginx buffering:** the route sets `X-Accel-Buffering: no` so nginx flushes
  immediately; heartbeat comment every 25s stays under nginx `proxy_read_timeout`
  (120s) so an idle stream isn't reaped. `EventSource` auto-reconnects (server
  sends `retry: 5000`).
- **Single-instance registry.** Connected clients live in an in-process `Set`
  (one API process serves all browsers). If ever scaled to multiple instances,
  swap for Redis pub/sub or Postgres LISTEN/NOTIFY — the publish/subscribe
  surface stays the same.
- No per-user data isolation needed: it's a single-company app, all authed users
  share data, and admin-only domains (device credentials) are simply never in the
  domain map so they're never pushed.
