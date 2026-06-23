---
name: IMAP multi-folder import
description: How the IMAP cost-document importer handles multiple folders/labels and its dedupe edge case
---

The IMAP importer's `folder` setting (DB singleton `email_import_settings.folder`,
or `IMAP_FOLDER` env) is a **comma-separated list** of mailbox folders / Gmail
labels — NOT a single folder. `parseFolders()` splits/trims/dedupes; empty → `["INBOX"]`.
One IMAP connection is opened, then each folder is polled under its own
`getMailboxLock` (logout in the outer finally).

**Why comma-separated, not a new column:** hard product constraint is additive-only,
prod-safe DB changes. Reusing the existing `folder` text column needs no migration.

**Dedupe edge case (known, accepted):** dedupe is by `email_import_log.messageId`.
Real emails carry a Message-ID, so the same mail tagged with several Gmail labels
imports once. But messages lacking a Message-ID header fall back to a synthetic
`uid:<uid>@<folder>` token — which differs per folder — so such a message present
in multiple folders CAN be imported more than once. More likely in multi-folder mode.

**How to apply:** if asked to add per-folder behavior, keep the single-connection +
per-folder-lock pattern. If true cross-label dedupe for header-less mail is needed,
switch the fallback key off `<folder>` (e.g. hash the body) — but that changes the
log key and must stay backward-compatible.

**Error UX (important):** a mistyped/nonexistent Gmail label makes ImapFlow throw a
bare `Command failed` — users then wrongly conclude comma-splitting is broken. Both
the test (`testImapConnection`) and the poll (`pollOnce`) must open each folder in
its own try/catch and surface a CZ error **naming the offending folder**. The poll
must NOT let one bad label abort the others — catch per folder, keep going, and only
throw (named) when *every* folder failed (safe because `parseFolders` guarantees ≥1).

**Test button caveat:** the Settings "Otestovat připojení"/"Načíst nyní" actions hit
the backend which reads the **saved** DB config — they do NOT use unsaved form values.
UI must tell the user to save first (no body is sent from the form).
