# Production 0096 → 0107 control-plane contract

Status: contract, planner, verifier, dependency-injected production adapter,
source-pinned runtime/role authorities, exact-0096 role bootstrap and an
attended host operator are implemented. The operator bundle is emitted only in
the explicit control-plane build and remains default-dark: no production
descriptor, role activation, connection material, Compose command, deployment
or application-start authorization is committed.

## Attended executable

`pnpm production:migration -- <command> ...` exposes only `prepare`, `inspect`,
`resume`, `apply`, `apply-role-ceremony` and `finalize`. There is deliberately
no all-in-one command.
Every invocation re-loads the same strict descriptor and validates the exact
signed v3 backup plan and `PASS` restore receipt, its executor trace, current
signature envelope and one raw 64-byte detached Ed25519 signature against the source-pinned
host/evidence key before it can load a durable run. A missing real pin therefore
keeps execution disabled.

The descriptor is strict JSON with schema
`site-logbook.production-migration-runner-descriptor/v2`,
`executionDefault="disabled"` and `authorizesApplicationStart=false`. All paths
in it are relative to the real descriptor directory and may not escape it or
resolve through a symlink. It names:

- the reviewed migrations directory and an already-created durable artifact
  directory;
- the target, baseline live identity, backup plan/trace/receipt/signature
  envelope, raw detached signature, role-precondition and exact role-bootstrap
  receipt files;
- three distinct pre-provisioned roles: audited session principal, `NOLOGIN`
  migration owner reached only through `SET LOCAL ROLE`, and runtime role;
- exact source-pinned runtime and role authority id/lowercase-SHA-256 pairs;
- strict descriptor-relative role-ceremony paths for the pre-created
  `activation` and initially absent `transactionReceipt` and
  `postCommitProjection` files;
- PostgreSQL connection custody as either `{source:"environment",reference:...}`
  or `{source:"file",reference:...}`. The file form must be a real single-link
  file with mode `0600`; connection material has no CLI flag and is never
  included in stdout or durable canonical artifacts.

The CLI validates the complete command-specific flag set, canonical timestamp,
receipt count, sequence-bound storage id and every exact attended confirmation
before it reads the descriptor, dynamically imports an authority module or
looks up an environment/file connection secret. A rejected or incomplete
command therefore has no authority-module or secret-reading side effect. An
invocation has a fixed 36-minute overall deadline (the internal test seam may
only lower it or raise it to at most 40 minutes). Its `AbortSignal` is passed to
runtime and role authority calls and to the PostgreSQL connect/query boundary;
an aborted query destroys its checked-out client, late connects are destroyed,
and pool cleanup has a separate five-second ceiling.

On Linux, durable evidence uses the adapter's pinned-directory,
descriptor-relative `/proc/self/fd` path, `O_NOFOLLOW`, `O_EXCL`, mode `0600`,
file and directory `fsync`, and exact descriptor-held read-back. Other platforms
fail closed unless a separately reviewed storage adapter is injected outside
this CLI.

The attended sequence is:

1. `prepare` requires both exact confirmations
   `APPLY_0096_TO_0107_EXACT_MODVOLT_PRODUCTION` and
   `ENABLE_REVIEWED_0096_TO_0107_PRODUCTION_MIGRATION_ADAPTER`. It first obtains
   fresh authoritative read-only live evidence, then durably persists the exact
   plan, intent, intent read-back receipt, activation and immutable run manifest.
2. Before every step, `inspect --receipt-count N` requires
   `INSPECT_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_READ_ONLY`. It performs no
   artifact or database write and never returns a next-step authorization.
3. `resume --receipt-count N` requires
   `RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP`,
   obtains another authoritative live observation, and exclusively persists a
   sequence/head-bound resume command.
4. `apply --receipt-count N --resume-storage-id ...` requires
   `APPLY_NEXT_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_STEP`.
   The adapter observes live identity again, applies exactly one migration in
   one advisory-locked `SET LOCAL ROLE` transaction, re-observes runtime before
   and after SQL and after commit, and durably stores exactly one step receipt.
5. After ten receipts, separately confirmed `apply-role-ceremony` consumes the
   stable activation, verifies the fresh complete receipt-backed target, and
   runs the embedded source role plan once under the same overall abort and
   advisory-lock boundary. Its receipt and external post-commit projection are
   persisted with exclusive mode-0600 file and directory fsync custody. An
   unknown commit or incomplete post-commit custody requires manual restore
   review and may never be retried blind.
6. After the role ceremony, `finalize` requires
   `FINALIZE_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_CHAIN`, the
   authoritative final live identity, the independent role transaction receipt,
   external post-commit role projection, and one final runtime observation. The
   resulting chain still has `authorizesApplicationStart=false`.

The command surface is intentionally verbose so that the terminal history
records public approvals but never connection material:

```text
pnpm production:migration -- prepare --descriptor <relative-or-absolute-descriptor-path> --operator <public-operator-id> --approved-at <canonical-UTC> --intent-confirmation APPLY_0096_TO_0107_EXACT_MODVOLT_PRODUCTION --activation-confirmation ENABLE_REVIEWED_0096_TO_0107_PRODUCTION_MIGRATION_ADAPTER
pnpm production:migration -- inspect --descriptor <descriptor-path> --receipt-count 0 --confirmation INSPECT_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_READ_ONLY
pnpm production:migration -- resume --descriptor <descriptor-path> --receipt-count 0 --operator <public-operator-id> --approved-at <canonical-UTC> --confirmation RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP
pnpm production:migration -- apply --descriptor <descriptor-path> --receipt-count 0 --resume-storage-id <id-from-resume-stdout> --confirmation APPLY_NEXT_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_STEP
pnpm production:migration -- apply-role-ceremony --descriptor <descriptor-path> --receipt-count 10 --confirmation APPLY_RECEIPT_BACKED_0107_PRODUCTION_ROLE_CEREMONY
pnpm production:migration -- finalize --descriptor <descriptor-path> --receipt-count 10 --confirmation FINALIZE_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_CHAIN
```

Repeat `inspect`, `resume` and `apply` with the explicitly reviewed receipt
count from 0 through 9. A failed or ambiguous apply is never advanced by merely
incrementing that count; preserve the durable directory and follow the emitted
restore-required classification.

`pnpm test:production-migration-runner` runs the hermetic full ten-step fake.
`PRODUCTION_MIGRATION_RUNNER_PG16_URL` is accepted only by the separate opt-in
`pnpm test:production-migration-runner:pg16` disposable PostgreSQL 16 wiring
test; it is not read by the production CLI and the test is skipped when absent.

## Production host operator and role bootstrap

`artifacts/api-server/src/production-migration-host-operator.ts` is a
control-plane-only entry point. The ordinary runtime and final production image
do not contain it. It statically bundles the exact source-pinned authorities and
provides three preparation commands before delegating the six receipt-backed
migration commands above:

1. `role-bootstrap` consumes canonical schema
   `site-logbook.production-migration-role-bootstrap-request/v1` and exact
   confirmation `BOOTSTRAP_EXACT_0096_PRODUCTION_DB_ROLES_BEFORE_MIGRATION`. In one
   serializable advisory-locked transaction it creates a distinct `NOLOGIN`
   migrator and passwordless runtime role, transfers only the exact reviewed
   0096 database/schema/object ownership, applies exact ACL/default-ACL/search
   path boundaries, proves `SET LOCAL ROLE`, and persists the precondition and
   non-authorizing receipt with exclusive mode-0600 custody. It never creates a
   runtime password or changes an application deployment.
2. `observe-baseline` consumes canonical schema
   `site-logbook.production-migration-baseline-observation-request/v1` and exact
   confirmation
   `OBSERVE_EXACT_0096_PRODUCTION_MIGRATION_BASELINE_READ_ONLY`. It reuses the
   signed backup plan, source-pinned Docker observer and read-only PostgreSQL
   inventory to persist exact target and live-identity artifacts after role
   bootstrap.
3. `assemble-runner` consumes canonical schema
   `site-logbook.production-migration-runner-assembly-request/v2` and exact
   confirmation `ASSEMBLE_EXACT_0096_PRODUCTION_MIGRATION_ARTIFACTS`. It
   verifies the raw detached backup signature and every plan input, binds the
   role precondition to the exact committed bootstrap receipt and its approval,
   and binds the fresh live identity to the audited session and migrator. The
   accepted chronology is exactly backup `PASS` completion, role-precondition
   capture, role-bootstrap commit, then baseline observation, with the whole
   backup-to-baseline interval bounded to 15 minutes. It creates the disabled
   descriptor and exact role-ceremony activation, and creates an empty
   mode-0700 migration artifact directory. Activation still requires the later
   separate `apply-role-ceremony` confirmation and never authorizes app start.

The connection string is available only through
`PRODUCTION_MIGRATION_DATABASE_URL`; it is never accepted in argv, request JSON,
stdout or durable evidence. The control-plane bundle may be extracted with its
matching glibc Node binary to a protected host tools directory so the fixed-argv
runtime authority can use the host Docker CLI without exposing
`/var/run/docker.sock` to a container. This extraction is an operational build
step, not a deployment of the application.

`pnpm test:production-migration-role-bootstrap:pg16` is the opt-in real
PostgreSQL 16 regression. With `PRODUCTION_ROLE_BOOTSTRAP_PG16_URL` pointing to
an isolated empty database it creates exact 0096 plus the two opaque rows,
performs the real bootstrap, applies the exact ten migrations through the
migrator and executes the real post-0107 role ceremony. It is never part of a
production command and skips when the variable is absent.

## Exact authority and role-custody activation boundary

Arbitrary operator-supplied module paths are no longer accepted. The CLI
allowlists the repository path and exact source digest for both authorities and
rejects every other id/digest pair before reading connection custody.

- `scripts/production-evidence/production-exact-0096-backup-contract.mjs`
  exports `validateProductionImmutableRuntimeBinding()` and
  `scripts/production-evidence/production-migration-adapter.mjs` exports
  `createProductionMigrationRuntimeObservation()`. The existing
  `docker-readonly-observer.mjs` returns a broader host-export schema and does
  not by itself prove every field of the exact immutable migration binding.
- `@workspace/db/production-migration-role-authority` is the explicit referenced
  project boundary for the real precondition/post-commit validators, the shared
  projection normalizer and the role ceremony. Its post-commit validator requires
  the exact role transaction receipt and projection bytes. The ceremony binds
  those validators to `createOneShotProductionRoleExecutor()`, read-only
  `PRODUCTION_ROLE_PROJECTION_SQL`, the advisory-lock transaction and exclusive
  receipt custody used by the host operator. The legacy
  `scripts/production-evidence/production-migration-role-authority.ts` path is a
  compatibility re-export only. The CLI pins the ceremony entrypoint plus its
  validator/normalizer and role-contract transitive sources before import.

The implemented reviewed slice is:

1. Arbitrary descriptor module paths are replaced with two source-pinned authority
   ids whose repository paths and lowercase SHA-256 digests are allowlisted by
   the CLI. A descriptor may select only an allowlisted id/digest pair.
2. The runtime authority accepts exactly
   `{expectedRuntimeBindingCanonical, signal}`, performs only fixed-argument
   bounded Docker `inspect` operations, re-observes container/network/volume
   state for drift, validates all expected binding fields, and returns only
   `site-logbook.production-migration-runtime-observation/v1` canonical bytes.
3. The strict `roleCeremony` descriptor object has descriptor-relative paths
   for `activation`, `transactionReceipt` and `postCommitProjection`. The first
   is required and stably read before the one-shot role ceremony; the latter
   two must not exist before it and are stably read only by `finalize`.
4. The attended, separately confirmed `apply-role-ceremony` command runs after
   receipt 10 and before `finalize`. It uses the already-audited session
   principal, `createOneShotProductionRoleExecutor()`, the exact embedded role
   plan, `PRODUCTION_ROLE_PROJECTION_SQL`, the same advisory/overall abort
   boundary and exclusive mode-0600/fsync receipt persistence. Ambiguous commit
   outcome remains restore/manual-review required; it is never retried blind.
5. The source-pinned role authority delegates precondition validation and
   post-commit receipt/projection validation to
   `productionMigrationRoleAuthority`; no descriptor module reads a connection
   secret or invents role evidence.

Hermetic tests cover fixed Docker argv, drift, abort, default-dark ceremony
confirmation, descriptor assembly and full ten-receipt ordering. The opt-in
PostgreSQL 16 regression covers the actual bootstrap, all ten SQL migrations and
the actual post-commit role projection. Real execution still requires an exact
attended production request, fresh observation and separate operational
approval. This is not a deployment, merge or application-start authorization.

## Frozen lineage

- Baseline is exactly 97 known migrations through
  `0096_far_smiling_tiger`, plus the two frozen opaque production identities.
  This is 99 physical journal rows.
- The only accepted forward suffix is `0097`, `0098`, `0099`, `0101` through
  `0107`; `0100` remains excluded.
- Target is exactly 107 known migrations through
  `0107_canonical_audit_evidence`, plus the same two opaque rows. This is 109
  physical journal rows.
- Opaque rows are compared by exact `(createdAt, hash)` identity and canonical
  digest. They are never named, inferred, deleted or rewritten.

## Evidence and recovery boundary

The planner emits `site-logbook.production-migration-plan/v2` and accepts only
the exact baseline. It embeds and re-parses the exact
canonical production target, live identity, exact-0096 backup plan, executor
trace, `PASS` receipt, signature envelope, raw detached Ed25519 signature bytes,
role precondition and its exact committed bootstrap receipt.
Those artifacts must agree on source SHA, immutable application/PostgreSQL
images, runtime binding, database, exact 97+2 baseline and chronology. The
migration `sourceSha` is exactly the backup v3 `plan.liveSource.sha`; its
application image is exactly `plan.liveSource.imageRef`. The distinct
`plan.executor` build/image must equal the executor trace producer and the v2
signature-envelope executor fields, but it is never treated as the migration
target identity. Swapping or aliasing the live-source and executor identities
fails closed. A bare
caller-supplied backup digest or synthetic backup summary is not accepted. The
host adapter must verify the detached signature against its source-pinned key
map before invoking the planner. The intent uses the exact production
confirmation. Before any
receipt or resume can be verified, an exclusive durable persistence receipt must
embed byte-for-byte read-back of that intent and bind its storage identity and
timestamp.

Each future executor transaction must first produce bounded canonical,
secret-free transaction evidence. Its exact schema binds the plan, durable
intent receipt, exact migration, before/after inventory, complete live identity,
fixed advisory-lock namespace, executor run and committed timestamps. Live
identity includes exact source SHA, database name, audited `session_user`,
effective `current_user`, immutable image references and runtime-binding digest.
The migration owner is a `NOLOGIN` role reached with audited `SET ROLE`; it is
never conflated with the session principal. The control plane computes
the evidence digest internally; the receipt embeds the canonical evidence bytes
and cannot substitute a caller-supplied digest. Receipts also bind the preceding
receipt and frozen opaque digest. A complete transition chain requires all ten
receipts plus the exact final read-only
live identity. The completed transition additionally requires a canonical
exact non-authorizing role transaction receipt and an external post-commit
role projection bound to that receipt and the pre-approved canonical role plan.
Intent, receipts, recovery classifications and transition chain all
retain `authorizesApplicationStart=false`.

Recovery is fail closed:

- read-only `inspect` never authorizes a write and returns no next step;
- exact live source/database/runtime identity and prefix equal to the receipt
  count may authorize only the next step
  when accompanied by a distinct bounded canonical resume command. That command
  binds the plan, intent persistence receipt, exact receipt head/count, operator,
  approval time, exact confirmation and next migration;
- live prefix ahead of receipts is an unknown commit and requires restore;
- receipts ahead of the live prefix require restore;
- `0100`, non-prefix state, unexpected known tags or opaque drift are rejected;
- a caller asking for a blind `retry` is rejected. It must first obtain a fresh
  read-only classification and request an explicit resume.

## Default-dark writer adapter interface

The implemented adapter requires explicit capabilities for:

1. `persistIntentExclusive(intentCanonical)`;
2. `readPersistedIntentCanonical(storageId)`;
3. `persistIntentReceiptExclusive(receiptCanonical)`;
4. `readInventoryReadOnly()` plus an authoritative canonical raw runtime
   observation at every inventory boundary and after the role ceremony;
5. `applyExactStepTransaction(step, expectedBeforeState, advisoryLockKey)`;
6. `persistReceiptExclusive(receiptCanonical)`.

The plan requires a canonical role precondition artifact before an intent can
exist. It embeds the exact disabled role plan and binds an externally captured
full pre-projection, their raw lowercase SHA-256 digests,
audited session principal, `NOLOGIN` migration owner and distinct runtime role;
the host adapter remains responsible for running the authoritative recursive ACL
validator. The adapter uses that separate migration role, one advisory-locked
transaction per step, no generic migrator fallback, no journal rewrites, no
opaque-row writes and no application-start action. Activation still requires
separate review of the exact-production backup/restore producer and pinned
public key, resource/database-role binding, platform artifact-custody primitive,
host observer, crash recovery evidence and quiescence checks.

All migration and role canonical artifacts are limited to 512 KiB, individual free-text values are
bounded, hashes and source/opaque identities are exact lowercase values, and
secret-shaped keys or values fail closed without being echoed. The target,
live identity, backup, intent-persistence, role and transaction evidence producers remain external
DI responsibilities; this slice adds no writer, command, image, package,
workflow, Compose service or deployment authorization.
