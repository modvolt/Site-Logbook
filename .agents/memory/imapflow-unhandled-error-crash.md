---
name: ImapFlow unhandled error crashes process
description: Why every ImapFlow client must get an 'error' listener at creation
---

# ImapFlow unhandled 'error' event crashes the whole API

`ImapFlow` (imapflow) is an EventEmitter that emits an `error` event on
socket-level failures (e.g. `Socket timeout` / `ETIMEOUT`). This can fire
**asynchronously after `connect()` already resolved** — during idle or while
streaming — so a try/catch around `connect()`/`pollOnce` does NOT catch it. An
EventEmitter `error` with no listener throws and kills the Node process.

**Symptom:** self-hosted deploy crash-loop — API log shows
`node:events:487 throw er; // Unhandled 'error' event` + `Error: Socket timeout`
then repeated startup ("Database migrations applied" / "Server listening").
Looks like (but is NOT) an OOM/RAM problem.

**Rule:** attach a no-throw `client.on("error", …)` listener in the single
client factory (`newClient` in `email-import.ts`) so socket errors are logged at
warn and swallowed; the per-poll try/catch still records operational outcomes.

**Why:** keeping the process alive through a transient mail-server timeout is
strictly better than crashing the whole API for everyone.

**How to apply:** any new long-lived socket/EventEmitter client (IMAP/SMTP/
websocket/SSE upstream) created in this codebase must register an `error`
listener at construction, never rely only on a surrounding try/catch.
