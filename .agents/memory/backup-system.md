---
name: Database backup system
description: How Stavba's pg_dump-to-object-storage backups work and the access-control rule that backups must never be served via the generic storage route.
---

# Stavba database backups

Backups are `pg_dump -Fc` (Postgres custom format) uploaded to the **same
object-storage bucket as uploads**, under the `backups/` prefix. Only the object
path is stored in `backup_log`, never the dump bytes. Works on both S3 and the
Replit/GCS object store via `putPrivateObject`.

- Scheduler runs on an interval (`BACKUP_INTERVAL_HOURS`, default 24), gated on
  storage being configured **and** `BACKUP_ENABLED !== "false"`. Retention
  (`BACKUP_RETENTION`, default 14) prunes old objects + log rows.
- Manual create/list/download via admin-only `/api/backups` routes; UI in
  Settings (gated by `can("manageUsers")`).
- Requires `pg_dump` on the container — the API Dockerfile installs
  `postgresql-client-16`.

**Critical access-control rule:** backups contain the entire DB, so they must
NOT be reachable through the generic `GET /api/storage/objects/*` route. That
route is gated only by `requireAuth` and the write-gate lets *guests* do GETs,
so without an explicit block a guest who guesses a backup filename
(`stavba-<timestamp>.pgcustom`) could exfiltrate the whole database. The storage
route explicitly 404s any path under `backups/`. Downloads go only through the
role-gated `GET /api/backups/:id/download`, which streams the object directly
(not via the storage route), so the block does not affect it.

**Why:** restore needs the exact dump; see `DEPLOYMENT.md` "Database backups &
restore" for the `pg_restore --clean --if-exists --no-owner --no-acl` procedure.
