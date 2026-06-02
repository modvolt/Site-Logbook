---
name: Database restore from backup
description: How Stavba restores a pg_dump backup, and the safety constraints around it
---

Restore applies a `pg_dump -Fc` (custom-format) backup with
`pg_restore --clean --if-exists --no-owner --no-acl --single-transaction -d $DATABASE_URL <file>`.

**Why these flags:**
- `--single-transaction` makes the whole restore atomic — any failure rolls the
  DB back to its prior state, so a failed restore never leaves a half-restored DB.
- `--clean --if-exists` drops & recreates every object in the dump (destructive,
  intended), `--no-owner --no-acl` matches how the dumps are created.

**Constraints / gotchas:**
- It is destructive: overwrites ALL current data, including the session table, so
  the user is logged out after a successful restore. The UI must warn about this.
- Guarded by an in-process `restoreInProgress` flag in lib/backup.ts — never run
  two restores concurrently (two admins / double-click), or they corrupt each other.
- Restore route lives in the `/backups` router which is already path-scoped to
  `requireRole("master","admin")`; do NOT add a separate pathless gate.
- Reading the dump uses `ObjectStorageService.getPrivateObjectBuffer()` (works for
  both S3 and GCS/Replit backends) → temp file → pg_restore. Buffers the whole
  dump in RAM; fine at this app's DB scale, revisit (stream to file) only if dumps
  grow large.
