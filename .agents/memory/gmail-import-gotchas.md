---
name: Gmail import gotchas
description: Two non-obvious correctness/security rules for the optional Gmail cost-document import (gmail-import.ts).
---

# Gmail import gotchas

## Label filter: resolve by ID first, then name — and never silently scan the whole mailbox
The admin UI selects/stores Gmail label **IDs** (`label.id`, e.g. `Label_12`, `INBOX`),
but the `GMAIL_LABEL` env default is naturally a **name** (e.g. `Faktury`). So
label resolution must accept both: match a token by exact label id first, then
case-insensitively by name. Matching by name only (the original bug) breaks every
user label, because a user label's id (`Label_12`) never equals its name.

**Why:** a mismatch here is silent and dangerous — `messages.list?labelIds=` ANDs
multiple labels, so the code lists per-label and UNIONs; if a configured label
fails to resolve it gets dropped, and if ALL configured labels drop the query
falls back to a whole-mailbox scan that ingests unintended e-mails.

**How to apply:** when labels are configured but none resolve, throw (409) before
listing — do NOT fall back to the account-wide `{}` query. The empty-selection
case (no labels configured) is the only legitimate whole-mailbox path.

## Sanitize Gaxios / Google OAuth errors before logging — they carry tokens
Never `logger.warn({ err }, ...)` a raw Gaxios/google-auth-library error. Those
errors carry the full request `config`, including `config.headers.authorization`
(bearer access token) and, for `revokeToken`, the refresh token in `config.data`.
Logging the raw object leaks them even through pino.

**Why:** scrubbers don't cover nested gaxios `config`; the token is in the request
config, not in `err.message` (which only has "Request failed with status code N").

**How to apply:** pass everything through a `sanitizeErr(err)` helper that returns
only `{ message, code?, status? }` (status from `err.response?.status ?? err.status`).
Apply to every catch that logs a Google/Gmail call.
