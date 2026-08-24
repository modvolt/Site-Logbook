# Attended exact-0107 production restore

This entrypoint is an emergency recovery boundary for an ambiguous 0108
migration or role-delta commit. It is not a normal rollback tool and never
authorizes application start or a migration retry.

The source-pinned control-plane image runs:

```text
node --enable-source-maps /app/dist/production-exact-0107-restore-runner.mjs
```

It accepts no command-line arguments and reads database and object-storage
secrets only from the environment.

## Non-mutating inspection

```text
PRODUCTION_EXACT_0107_RESTORE_ACTION=VERIFY_EXACT_0107_MVE1_RESTORE_INPUTS_NO_MUTATION
PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION=VERIFY_EXACT_0107_MVE1_RESTORE_INPUTS_NO_MUTATION
```

Inspection validates the immutable source, database identity, stopped runtime
writers, backup receipt/reference, backup-log row and exact journal state. It
does not persist evidence and does not call `pg_restore`. A live exact-0107
state returns `RESTORE_NOT_REQUIRED_EXACT_0107_OBSERVED`; a receipt-less exact
0108 state returns `RESTORE_REQUIRED_EXACT_0108_OBSERVED`.

## Attended restore

Only after inspection reports that restore is required:

```text
PRODUCTION_EXACT_0107_RESTORE_ACTION=RESTORE_EXACT_0107_MVE1_BACKUP_AFTER_AMBIGUOUS_0108_OUTCOME
PRODUCTION_EXACT_0107_RESTORE_CONFIRMATION=ATTENDED_RESTORE_EXACT_0107_MVE1_BACKUP_NO_APPLICATION_START
PRODUCTION_EXACT_0107_RESTORE_APPROVED_AT=<current canonical UTC timestamp>
```

`PRODUCTION_EXACT_0107_RESTORE_REASON` must be exactly one of:

- `RESTORE_REQUIRED_0108_MIGRATION_COMMIT_OUTCOME_UNKNOWN`
- `RESTORE_REQUIRED_0108_MIGRATION_RECEIPT_CUSTODY`
- `RESTORE_REQUIRED_0108_ROLE_COMMIT_OUTCOME_UNKNOWN`
- `RESTORE_REQUIRED_0108_ROLE_RECEIPT_CUSTODY`

The approval timestamp expires after 15 minutes. Before mutation the runner
persists `exact-0107-attended-production-restore-intent.json` with exclusive
create semantics. The evidence directory must be a stable mode-0700 directory;
files are mode 0600 and both file data and parent directory entries are
fsynced. Existing intent or receipt files stop a repeated restore.

Required non-secret bindings:

```text
BUILD_SHA=<exact source SHA>
MIGRATIONS_DIR=/app/migrations
PRODUCTION_EXACT_0107_RESTORE_EVIDENCE_DIRECTORY=/evidence/restore
PRODUCTION_EXACT_0107_BACKUP_RECEIPT_FILE=/evidence/backup/exact-0107-backup-restore-receipt.json
PRODUCTION_EXACT_0107_BACKUP_REFERENCE_FILE=/evidence/backup/exact-0107-backup-restore-reference.json
PRODUCTION_EXACT_0107_RESTORE_ROLE_PRECONDITION_FILE=/evidence/migration/role-precondition.json
PRODUCTION_EXACT_0107_RESTORE_STOPPED_WRITERS_PROOF_FILE=/evidence/maintenance/stopped-writers-proof.json
PRODUCTION_EXACT_0107_RESTORE_BACKUP_ID=<positive backup_log id>
PRODUCTION_INVOICE_0108_DATABASE_NAME=admin
PRODUCTION_INVOICE_0108_SESSION_USER=admin
PRODUCTION_INVOICE_0108_MIGRATOR_ROLE=site_logbook_migrator
PRODUCTION_INVOICE_0108_RUNTIME_ROLE=site_logbook_runtime
```

Secret environment values are `DATABASE_URL`, the S3 configuration and the
backup MVE1 keyring already used by the exact-0107 backup producer. Do not put
them in argv, logs, descriptor JSON or evidence.

The API and every writer container must remain stopped, as proven by a fresh
canonical stopped-writers proof v2. The runner additionally rejects every
unexpected PostgreSQL client session and holds the exact invoice-0108 advisory
lock (`91070108`) throughout inspection or restore. PostgreSQL and object
storage remain available.

After durable intent, the production path uses pinned PostgreSQL binaries to
render the authenticated custom dump offline. It temporarily changes
`site_logbook_runtime` to `NOLOGIN`, rechecks that no runtime session exists,
then executes removal of only `public.invoice_source_allocations` (without
`CASCADE`) and the complete generated restore SQL together in one psql
single-transaction boundary under `site_logbook_migrator`. Any dependency drift
therefore rolls the entire cleanup and restore back. The role returns to LOGIN
only after that transaction succeeds. It then verifies:

- database/session/current-role identity and non-replica status;
- exact-0107 journal identity, both frozen opaque rows and absent 0100;
- the SHA-256 of counts for every persistent application table against the
  backup receipt;
- the full exact-0107 least-privilege owner/grant projection;
- zero runtime and uninspectable client sessions after restore.

Success exclusively persists
`exact-0107-attended-production-restore-receipt.json`. The receipt records the
input custody digests, pre/post inventories, all-table count digest, role
projection digest and chronology. It has
`authorizesMigrationRetry: false` and `authorizesApplicationStart: false`.

Any failure after durable intent requires manual state review. Never repeat the
restore blindly. After a PASS receipt, build a fresh release/activation
predecessor and obtain a separate attended decision before any migration retry
or application start.
