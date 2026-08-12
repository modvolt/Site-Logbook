# Production 0096 → 0107 control-plane contract

Status: contract, planner, verifier and a dependency-injected production adapter
are implemented. The adapter remains default-dark: there is no package script,
image/Compose wiring, committed production signer trust root, deployment or
application-start authorization. Its concrete database, authoritative live
runtime observer, durable artifact custody and post-role evidence readers must
be explicitly supplied and reviewed before use.

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

The planner accepts only the exact baseline. It embeds and re-parses the exact
canonical production target, live identity, exact-0096 backup plan, executor
trace, `PASS` receipt, signature envelope and detached Ed25519 signature bytes.
Those artifacts must agree on source SHA, immutable application/PostgreSQL
images, runtime binding, database, exact 97+2 baseline and chronology. A bare
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
