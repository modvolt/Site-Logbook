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
