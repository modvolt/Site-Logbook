# Standard production migration lane

Use `production:migration:plan` / `production:migration:apply` for future
committed migrations. The old `production:migration` is legacy: do not use it
for 0109+. Its evidence runner remains temporarily until Phase 7C.
This change does not create 0109, authorize a production operation or deploy an image.

## Scope and prerequisites

- Review the committed SQL and application compatibility first.
- Require green Quality gate, Database and assurance, and image validation.
- Use the exact API image digest built from the reviewed 40-character source SHA.
- Run exact-image smoke before the production operation.
- Normally apply exactly one migration per production step. The bundled journal
  must contain exactly one pending entry, immediately after the expected current tag.
- Destructive changes, long table rewrites, downtime and multi-step expand/contract
  changes require a separate explicit operational plan; this CLI does not plan them.

Sequence: review SQL → CI → exact API image → exact-image smoke → verified backup
→ dedicated credential → plan → guarded single apply → verify → API deploy
→ API health → web deploy → login.

## Backup and credentials

Create and verify a real backup before apply. `--backup-reference` names that
already verified backup; it does not create, inspect or cryptographically certify it.
Backup is not application readiness, API startup or a historical signed activation
artifact. A failed backup must not stop the running application; do not proceed to apply.

Prefer `PRODUCTION_MIGRATION_DATABASE_URL_FILE`. Use a dedicated migration DB role
and pass its exact name as `--expected-role`. Both session_user and current_user must
match. The tool never grants roles or rotates credentials. Existing role permissions
remain an operator prerequisite; selecting a role name does not grant privileges.

Prepare a single UTF-8 connection-URL line in a secret file outside the repository,
shell history and journal. On POSIX, group/other permission bits must be zero
(normally 0600). Arrange ownership so only the authorized host operator and container
UID can read it; use an authorized privileged host operator to prepare the bind mount.
Remove it after the operation or store it securely under the operational secret policy.
Never place credentials in an HTTP Coolify terminal, chat, GitHub Actions logs or Git.
Never use the API's runtime `DATABASE_URL`, `BACKUP_DATABASE_URL` or `TEST_DATABASE_URL`.
The running API container must receive neither of the two migration credential variables.

Exactly one of `PRODUCTION_MIGRATION_DATABASE_URL` and
`PRODUCTION_MIGRATION_DATABASE_URL_FILE` must be set. There is no fallback.
File contents, connection URLs, passwords and raw database errors are not logged.

## Exact-image commands

The placeholders below must be replaced; keep shell quotes around arguments.
Use the production network and an image already pulled/verified by its digest.
These are operator examples, not commands to execute as part of this implementation.

Plan (read-only, including on a DB without the Drizzle tracking table):

```sh
docker run --rm --pull never \
  --network '<production-network>' \
  --mount 'type=bind,src=<secure-migration-url-file>,dst=/run/secrets/migration-url,readonly' \
  -e PRODUCTION_MIGRATION_DATABASE_URL_FILE=/run/secrets/migration-url \
  'ghcr.io/modvolt/site-logbook-production-api@sha256:<candidate-digest>' \
  node /app/dist/standard-production-migration.mjs plan \
  --expected-source-sha '<candidate-source-sha>' \
  --expected-current '<current-full-tag>' \
  --expected-target '<target-full-tag>' \
  --expected-role '<migration-role>'
```

Apply, after separately authorizing the production operation and verifying the backup:

```sh
docker run --rm --pull never \
  --network '<production-network>' \
  --mount 'type=bind,src=<secure-migration-url-file>,dst=/run/secrets/migration-url,readonly' \
  -e PRODUCTION_MIGRATION_DATABASE_URL_FILE=/run/secrets/migration-url \
  'ghcr.io/modvolt/site-logbook-production-api@sha256:<candidate-digest>' \
  node /app/dist/standard-production-migration.mjs apply \
  --expected-source-sha '<candidate-source-sha>' \
  --expected-current '<current-full-tag>' \
  --expected-target '<target-full-tag>' \
  --expected-role '<migration-role>' \
  --backup-reference '<verified-backup-reference>' \
  --confirm 'APPLY:<current-full-tag>-><target-full-tag>'
```

The confirmation is exact and dynamic. Generic YES/APPLY is rejected.
Apply rejects dev builds and requires the exact lowercase embedded SHA.
Only source/dev plan tests can use `BUILD_SHA=dev` with `--expected-source-sha dev`.
For local development the root `:plan` / `:apply` scripts run the source via tsx;
production uses only the immutable bundled entrypoint above.

## Results and failure handling

Success is one JSON object, schemaVersion
`site-logbook.standard-production-migration/v1`, with mode, status, sourceSha,
databaseName, sessionUser, currentUser, currentTag, targetTag, pendingTags and pendingCount.
Plan returns READY without writing, creating tracking, taking the migration advisory
lock, signing evidence, creating a backup or writing receipts.
Apply returns APPLIED only after exactly one application and a fresh read-only
verification that target is current, no migration is pending and history is valid.

Apply repeats current/target/history/role validation on the same connection under
the existing executor's advisory lock before any DDL. It reuses Drizzle and historical
out-of-order recovery, followed by parity verification. A stale plan is not authority.
An occupied lock returns MIGRATION_LOCK_BUSY immediately; do not kill its owner.
An already-applied target returns ALREADY_APPLIED, not another successful apply.
Other refusals include CURRENT_MISMATCH, TARGET_NOT_NEXT, TRANSITION_NOT_READY,
UNKNOWN_APPLIED_MARKERS, NON_CONTIGUOUS_HISTORY, DATABASE_AHEAD, ROLE_MISMATCH,
SOURCE_SHA_INVALID, SOURCE_SHA_MISMATCH, CONFIRMATION_REQUIRED and BACKUP_REFERENCE_REQUIRED.
Errors exit non-zero; unexpected DB errors are safely reported as MIGRATION_FAILED.

There is no automatic schema rollback. On failure:

1. Stop the release; do not deploy the candidate API or web.
2. Retain the previous running application image if it remains compatible.
3. Evaluate the database transaction state and actual schema with authorized tooling.
4. If required, use the verified restore procedure. Never improvise manual DELETEs
   from the migration tracking table or repeat apply blindly.

This one-shot CLI does not run at API startup or in the healthcheck; the default
application CMD is unchanged. It does not require activation bundles, historical
release timelines, signed receipts or control-plane execution.
