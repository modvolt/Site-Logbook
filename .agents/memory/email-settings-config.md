---
name: Email (SMTP) settings — DB singleton with env fallback
description: How Stavba resolves SMTP config so admins can edit it in production without env/redeploy
---

SMTP sending config is editable from the admin-only Settings ("Nastavení") page so it
works in production without env vars or redeploy.

- Stored in a **singleton DB row** `email_settings` (id=1): enabled, host, port,
  secure, username, password (plaintext), from_address, from_name.
- `resolveEmailConfig()` prefers DB config when `enabled && host`; otherwise falls
  back to `SMTP_*` env vars. Transporter is cached by a signature of the resolved
  config, so saving new settings rebuilds it.
- `source` enum returned by the API: `db` (DB config active), `env` (env fallback
  active), `none` (neither). Drives the UI banner.
- Password is **write-only**: GET never returns it (only `passwordSet: bool`); PUT
  treats a string (incl. empty) as set/clear and null/omitted as "keep existing".
- `POST /email-settings/test` sends using the **active resolved config** (DB or env),
  not strictly the saved DB row — UI tells admins to Save first.

**Why plaintext:** accepted for this self-hosted single-tenant app, consistent with the
device-credential vault. Access is gated `requireRole("admin")`.

**How to apply:** Gmail needs an App Password (2FA accounts), port 587 + secure=false
(STARTTLS). The Settings card has a Gmail preset button.
