---
name: AI cost-document extraction (OpenAI)
description: How optional OpenAI prefill of received cost documents is gated, stored, and surfaced; why it never auto-approves.
---

Optional OpenAI extraction prefills received cost-document header + lines from
PDFs/photos. It is a **fully modular** feature: the app must work end-to-end when
OpenAI is unconfigured (documents then route to manual `needs_review`).

## Three-state gating (configured / enabled / ready)
The status resolver reports three distinct booleans, and the UI/worker must keep
them distinct:
- `configured` = an API key is present (saved in the DB singleton **or** `OPENAI_API_KEY`).
- `enabled` = the `openai_settings` row's toggle when a row exists, else `OPENAI_DOCUMENT_EXTRACTION_ENABLED === "true"`.
- `ready` = configured && enabled. **Only `ready` triggers a real OpenAI call.**
- `source` = where the active key comes from: `db` (saved in UI), `env`, or `none`.

**Why:** an operator can install the key but keep extraction off, or flip it off
without removing the key. Collapsing these into one flag loses that control and
makes the settings UI lie about state.

## Never auto-approve
AI output is saved as a `needs_review` suggestion only — never approved/billed
automatically. Persisted fields: `ai_raw_json`, `ai_confidence` (numeric(3,2)),
`ai_model`, `ai_extracted_at`. Confidence below the review threshold (0.7) is
surfaced as a warning. **Why:** wrong extractions on a cost document feed billing;
a human must confirm before it can affect money.

## Self-hosted key handling
Off-Replit (Hetzner) there is no Replit AI proxy — the operator supplies their
**own** OpenAI key. The key + model + on/off toggle are editable in the admin UI
and stored in the `openai_settings` DB singleton (id=1), with the `OPENAI_*` env
vars as a per-field fallback (a saved DB value wins). `resolveOpenAiConfig()` is
async and reads the row inside try/catch → env-only if the table is missing
(pre-migration), so env-based deploys keep working. The key is **write-only**
(never returned by the API) and never logged. `/billing/settings` (admin-only)
shows status + a "test configuration" action that sends **no** real document
(just verifies the key / connection) and returns a graceful Czech message when
unconfigured.

## Worker trigger conditions
Extraction runs in the queue worker only when: `ready` && doc type is pdf/image
&& the document has no lines yet. Otherwise it falls back to the existing
manual-review path.
