---
name: Email import (IMAP) design
description: Why supplier-invoice auto-import uses generic IMAP, not the Replit Gmail connector, and the dedupe/visibility contract.
---

# Auto-import supplier invoices from a mailbox

**Decision: use a generic IMAP poller (imapflow), NOT the Replit Gmail connector.**
**Why:** Stavba is self-hosted (Docker/Coolify). The Replit Gmail connector depends
on Replit infra that won't run in production, so it would work in dev and silently
fail in prod. IMAP (Gmail app-password or any provider) is production-viable and
reuses the proven outgoing-SMTP settings pattern (DB singleton id=1 + env fallback,
here `IMAP_*`).

**How to apply:** Any "connect a mailbox / read email" feature for a self-hosted
artifact must avoid Replit connectors and use a self-contained protocol client.

## Dedupe + visibility contract (non-obvious)
- Re-poll dedupe is authoritative via `email_import_log.messageId` (unique), NOT the
  IMAP \Seen flag. \Seen only narrows the working set (search `seen:false`). A message
  lacking a Message-ID header gets a synthesized `uid:<n>@<folder>` token.
- Every processed message writes a log row (status imported|no_attachments|skipped|
  failed) so a supplier invoice is never silently dropped. On per-message failure we
  do NOT mark \Seen (so a fixed config can retry) but we DO log it (dedupe still holds).
- Attachments reuse the manual-upload path through `ingestFile()` in
  cost-document-service.ts (same sha256 dedup, object storage, extraction queue).
  `Actor.userId` was made nullable so the importer can act with no human user
  (created_by / audit actor FKs are nullable).
- imapflow is parsed directly: walk `bodyStructure` for attachment leaf parts
  (disposition=attachment OR has filename), `download(uid, part)` streams bytes.
  No mailparser. octet-stream attachments get content-type inferred from extension.

## imapflow specifics
- Must be in build.mjs esbuild `external` (native deps; prod Docker ships node_modules).
- `msg.internalDate` can be string|Date — coerce with `new Date(...)` before inserting
  into a drizzle timestamp column or typecheck fails.
