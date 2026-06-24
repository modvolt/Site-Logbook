---
name: IMAP fetch/download interleave drops socket
description: Why ImapFlow per-message import must drain fetch() before download()
---

# ImapFlow: never download() while a fetch() stream is open

**Symptom:** per-message email import fails with ImapFlow error
`Connection not available` (surfaced in the app's import history as `Chyba`),
while the connection itself was fine moments earlier.

**Rule:** in a poll loop, fully drain the streaming `client.fetch(...)` async
iterator into an array of `FetchMessageObject` FIRST, then run the
download/ingest/flag work in a second plain loop. Do **not** call
`client.download()` / `client.messageFlagsAdd()` (or any other IMAP command)
inside the open `for await (... of client.fetch())` iterator.

**Why:** ImapFlow keeps the single connection busy for the whole duration of a
streaming `fetch`. Issuing a second command mid-stream interleaves on that busy
connection and drops the socket. It trips reliably here because the per-message
body does slow work (S3 putObject + a DB transaction in `ingestFile`), holding
the stream open long enough.

**How to apply:** any IMAP poll that downloads bodies/attachments per message
must buffer the lightweight metadata (envelope/bodyStructure/internalDate) from
the fetch first, then download. Buffering metadata is cheap (no bodies). The
mailbox lock stays held across the second loop, so uids remain valid. Separate
from the `on('error')` listener rule (see imapflow-unhandled-error-crash.md) —
that prevents process crashes; this prevents per-message failures.
