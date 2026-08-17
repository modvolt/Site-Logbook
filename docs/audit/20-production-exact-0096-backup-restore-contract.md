# Production exact-0096 encrypted backup and restore contract

## Status and boundary

This slice implements the canonical plan, producer-native executor-trace verifier,
receipt derivation, exact dependency-injection boundary, and reusable producer
primitives. The primitives measure deterministic per-relation content from the
same exported read-only snapshot used by a streaming PostgreSQL 16 custom dump,
write an authenticated MVE1 envelope without buffering the full dump or encrypted
payload in memory, stage authenticated restore plaintext before exposing it to
`pg_restore`, and bind a Hetzner Object Storage version through an independent
exact-version HEAD/GET. The host dependency adapter is default-dark and uses only
fixed `docker exec` argv, bounded canonical outputs and an AbortSignal.

This is still **not an activated production backup**. The build emits the narrow
producer and host-worker CLIs only into the explicitly selected, marker-baked
`control-plane` image target; the default/final production API target excludes
both bundles. Without the exact producer activation environment value the shipped
session still returns `PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED`. With that
value it constructs every and only the five process-owned operations from the
source-pinned 91-relation exact-0096 manifest, inherited `DATABASE_URL`, inherited
backup keyring and inherited Hetzner S3 environment. Partial activation is
rejected.

No production Compose service is present. The default-dark host executable
`scripts/production-evidence/run-production-exact-0096-backup.mjs` now supplies
the activation boundary. It starts one interactive
`docker exec node ... --session` producer
for the whole executor run. Its process-owned registry can retain the exporting
`REPEATABLE READ READ ONLY` transaction across relation measurement and
`pg_dump`; requests remain canonical exclusive regular files and stdin carries
only operation/path envelopes. Any malformed request or handler failure is
terminal and session shutdown closes process-owned state.

Putting all eleven executor handlers inside that single process is intentionally
rejected. Five operations are producer-owned and must share the process:
`openExportedReadOnlySnapshot`, `readFrozenRelationManifestMeasurements`,
`createBoundedPgDumpCustom`, `encryptAndPersistVersionedPayload`, and
`headExactVersionedPayloadReadOnly`. The other six are host-owned:
`observeExecutorIdentity`, `observeImmutableProductionSourceReadOnly`,
`proveProductionWritersStopped`, `restoreIntoNewDisposablePostgres16`,
`observeRestoredJournalSchemaAndContentReadOnly`, and
`reobserveProductionSourceReadOnly`. They require Docker daemon observation or
resource ownership which the control-plane container must not obtain. Mounting a
Docker socket into that process would violate the reviewed trust boundary.

The host executable constructs the exact composite registry from a synchronous
six-handler factory bound to the adapter's internal `AbortSignal` plus the one
already-running five-operation producer session. It creates and independently
inspects a digest-addressed control-plane container, gives it no Docker socket,
persists only mode-0600 request files, and transfers secrets only through one
mode-0600 Docker env file. Secrets, database URLs, encryption keys and S3
credentials never appear in argv, stdout or evidence. The host owns bounded
source/container observation, two complete 60-second writer-free DB windows,
the disposable PostgreSQL 16 lifecycle, exact restore observation, exclusive
trace/receipt persistence and unconditional restore/control-plane cleanup.

The host worker downloads only the evidence-bound Hetzner object version,
authenticates and stages the complete MVE1 plaintext before feeding fixed-argv
`pg_restore`, then measures all 91 restored relations. The `pg_restore` child
receives only `PATH`, `PGHOST`, `PGDATABASE`, and `PGUSER`; production database,
S3, and envelope-key environment variables are not inherited across that child
process boundary. The control-plane process
temporarily joins the new internal restore network; the restore PostgreSQL
container never joins the production network or mounts the production volume.
No backup plaintext or secret is transported through stdout.

The runner has three exact commands. `prepare` requires
`PREPARE_EXACT_0096_PRODUCTION_BACKUP_PLAN_READ_ONLY_NO_BACKUP`, one exact
secret-free immutable preparation intent, and an exclusive output path. It
verifies the reviewed executor/source/runtime identities, starts only the narrow
temporary host-worker container, reads database identity, the exact journal, and
the authoritative schema fingerprint, then measures a complete 60-second
writer-free window. Only those observed values are passed to the canonical plan
creator. Database identity, journal inventory, schema fingerprint, timestamps,
and stopped-writer proof are forbidden in the intent and cannot be self-authored
by the caller. `prepare` calls no producer, object storage, restore, or migration
operation. It removes the temporary container before persisting the canonical
plan via no-clobber mode-0600 create, file sync, exact readback, and parent
directory sync.

`preflight` requires
`READ_ONLY_EXACT_0096_PRODUCTION_BACKUP_PREFLIGHT_NO_CHANGES` and uses only
Docker image/container/network/volume `inspect`; it creates no container, object
or evidence. `execute` additionally requires
`RUN_EXACT_0096_PRODUCTION_BACKUP_AND_DISPOSABLE_RESTORE_NO_MIGRATION`, one
canonical plan and one canonical host request. Missing or altered confirmation,
mutable images, a non-0600 secret file, unexpected env names, running network
peers, active DB sessions/write locks, journal drift, image/source drift or an
unbounded timeout fail before the corresponding mutation.
The exact Hetzner env-file contract requires `S3_FORCE_PATH_STYLE=false`;
missing, true, or differently encoded values fail before any Docker operation.
It also source-pins `S3_BUCKET=modvoltdata`,
`S3_ENDPOINT=https://fsn1.your-objectstorage.com`, and `S3_REGION=fsn1`.
Another syntactically valid Hetzner region, endpoint, or bucket fails before
Docker in host prepare/preflight/execute and before provider I/O in the exact
object-storage primitive.

Implementation and hermetic synthetic coverage do not assert that production,
Docker or Hetzner ran. A real backup remains a separately attended operation
requiring stopped production writers and then a separately reviewed detached
receipt signature. Its PASS receipt still authorizes no migration.

The host-owned disposable PostgreSQL 16 lifecycle now creates one labeled
internal network, one labeled volume and one container from an immutable image,
with no published ports, a read-only root, all capabilities dropped except the
five PostgreSQL-init requirements (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`,
`SETUID`), and no production source volume/network attachment. It independently
inspects both the running
executor container/image and PostgreSQL image before asserting their bindings,
streams only authenticated plaintext to fixed-argv `pg_restore --exit-on-error`,
and removes the container, volume and network in bounded cleanup. Hermetic tests
prove the lifecycle argv, identity checks and cleanup contract; they do not prove
that Docker, PostgreSQL, Hetzner S3 or production ran.

The local Node rehearsal was run on 2026-08-13 against immutable local image ID
`sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.
It passed a 1,645-byte PostgreSQL 16 custom dump through a local authenticated
MVE1 AES-256-GCM envelope (1,735 bytes), authenticated/decrypted it before
`pg_restore`, reproduced `exact-0096`, observed an internal network with no
published ports and the 1 CPU / 1,536 MiB / 256 PID caps, then verified exact
container, volume and network cleanup. It used no external network, S3 or
production resource.

On 2026-08-12 the live Site Logbook API container independently confirmed the
exact production storage identity `https://fsn1.your-objectstorage.com`, region
`fsn1`, bucket `modvoltdata`, and private prefix `private`. Bucket versioning was
changed from `Disabled` to `Enabled` under explicit operator approval and then
re-read as `Enabled`; object counts under `private/` and `private/backups/`
remained unchanged. This closes only the provider-versioning prerequisite. No
backup object, restore receipt, producer lifecycle, migration authorization, or
application-start authorization was created by that operation.

A caller can no longer construct `PASS` from selected JavaScript objects or even
from an independently supplied valid trace string. The async DI orchestrator reads
one canonical bounded artifact from each exact dependency, supplies the byte
ceiling and overflow controls itself, constructs and validates the ordered trace,
and requires an exact exclusive-persistence acknowledgement. The acknowledgement
binds the evidence-store identity, reports that no target existed, and repeats the
canonical readback byte length and digest. The trace and receipt must use the same
store identity. Only that in-process
executor-issued trace artifact receives the module-private capability needed to
derive a receipt. The runner then requires a second exact exclusive-persistence
acknowledgement before returning either artifact. Changing the trace changes
`executorTraceSha256` and invalidates the receipt.

Each no-clobber evidence write syncs the file before close, verifies exact
readback, and on the Linux production host syncs the parent directory before it
acknowledges persistence. Thus an acknowledged receipt is not based only on page
cache or an unsynced new directory entry.

The plan, receipt and detached-signature envelope permanently set
`authorizesProductionMigration=false`. The signature uses a separate domain string
but the same source-pinned offline host/evidence Ed25519 key ID and public-key pin;
it introduces no third private-key ceremony. Uppercase input is rejected rather
than normalized. A
`PASS` receipt is backup and restore-drill evidence only. It cannot authorize 0097,
0107, application start, deployment, migration, or a production restore.

## Frozen production source and writer boundaries

The plan accepts only `site-logbook-production` and separately binds the immutable
live source SHA/image and immutable executor build SHA/image. This permits a new
reviewed control-plane image to back up an older deployed application without
misstating either identity. It also binds all of these values:

- an exact 40-character source commit;
- digest-addressed application and PostgreSQL images; mutable tags are rejected;
- exact source container, Docker network, and PostgreSQL volume identifiers;
- volume creation time and canonical labels digest;
- resolved and deployed configuration digests;
- PostgreSQL 16 database name and role, neither containing a staging identity;
- exact 0096 journal: 97 known migrations, latest
  `0096_far_smiling_tiger`, 99 total rows, no `0100`, no unexpected known row,
  and the two frozen opaque production rows without inferred meaning;
- a reviewed non-zero schema fingerprint.
- the exact storage binding: bucket `modvoltdata`, canonical fsn1 HTTPS endpoint
  and endpoint-origin digest, region `fsn1`, path-style disabled, and object
  prefix `private/production/exact-0096/`.

The fingerprint is not copied from the plan into runtime evidence. The host
worker opens a read-only repeatable-read transaction and feeds the live database
through the authoritative `readAuditSchemaCatalogProjection()` and
`auditSchemaFingerprintSha256()` helpers. Source-before, disposable restore, and
source-after outputs carry that independently measured value, and each must equal
the reviewed plan fingerprint. Any source or restore schema drift fails before a
receipt can be created.

The stopped-writers proof is bound to the source SHA, canonical runtime-binding
digest, canonical database-identity digest, and maintenance-window ID. It admits
no writer container, application session, active write transaction, or observed
database write. It must cover at least 60 seconds and be at most five minutes old
when the plan is created.

The plan proof is a pre-execution authorization/precondition and is never reused
as observed execution evidence. The runner first observes the live source, then
measures a new complete writer-free window and emits a new proof ID under the same
maintenance window with the same source/runtime/database bindings. Receipt
validation requires `plan.createdAt <= source observedAt <= proof.quiescentSince
<= proof.observedAt <= exported-snapshot observedAt`; the source-to-proof interval
is bounded to five minutes. After the disposable restore it obtains another
different proof ID, re-binds the same source/runtime/database, and requires its
observation at or after restore completion and no more than five minutes before
trace completion. Reusing the plan proof, swapping IDs, or violating either
temporal boundary makes a `PASS` receipt impossible.

## Exact catalog and deterministic content snapshot

The contract freezes 91 persistent relations: the exact 90 tables from
`lib/db/migrations/meta/0096_snapshot.json` with snapshot ID
`1c804503-6c96-4453-8bae-5f20d854810c`, plus
`drizzle.__drizzle_migrations`. It pins the normalized source-file digest and the
ordered relation-name digest. The live catalog must reproduce every and only those
relations; an omission, addition, duplicate, reorder, or unsupported relation fails
closed.

Every source, restore, and source-after snapshot records for each frozen relation:

- an exact non-negative row count; and
- a SHA-256 digest of the deterministic canonical row stream.

The frozen algorithm is
`sha256-canonical-jsonl-column-order-pk-or-all-column-sort-v1`: encode every row as
canonical JSON with columns in catalog ordinal order and one trailing LF, order
rows by the complete primary key when present and otherwise by all encoded column
values using the encoded values' PostgreSQL `C` byte collation, concatenate without
database-default or host-locale transforms, then hash. The map has a
canonical digest, and that digest plus the frozen relation-manifest digest produces
`dataSnapshotSha256`. The journal relation must contain exactly 99 rows.

Before row reads, the producer enumerates the live non-system catalog and requires
exact equality with the 91-relation manifest. Added, missing, unlogged,
partitioned, materialized or foreign relations fail closed. Canonical rows are
limited to 8 MiB, fetched pages to 16 MiB and each relation stream to 1 GiB.

All measurements and the PostgreSQL custom dump use one `REPEATABLE READ READ ONLY`
exported snapshot. Evidence retains only the non-zero snapshot-token digest, never
the ephemeral token. The dump must bind that token digest and
`dataSnapshotSha256`, exit zero under PostgreSQL 16, and carry its exact plaintext
size and digest.

## Streaming encryption and exact object binding

Both the dump and encrypted payload are limited to 256 MiB. The executor DI call
passes the ceiling into the encryption/persistence operation with
`streaming-before-write` enforcement, producer termination, write abort, and
partial-object deletion enabled. A successful trace binds the exact byte count to
the persisted payload. An overflow trace is valid only when it records exactly
`ceiling + 1` bytes observed, producer terminated, write aborted, partial object
deleted, no object created, and no payload. That terminal result can never yield a
receipt.

A successful payload requires PostgreSQL 16 custom format and AES-256-GCM envelope
encryption. Its exact dump digest and data-snapshot digest are retained. The
current exact-version primitive supports only the source-pinned
`https://fsn1.your-objectstorage.com` endpoint, `fsn1` region, `modvoltdata`
bucket, and `private/production/exact-0096/` prefix. It requires a read-only
`GetBucketVersioning` result of `Enabled` before PUT and rejects other valid
Hetzner locations/buckets as well as GCS, MinIO, AWS or arbitrary S3-compatible
endpoints. The
payload is already encrypted client-side with the independently versioned MVE1
envelope. Provider evidence says `encryptionBoundary=client-envelope-only`, so
no unsupported AWS SSE-KMS claim is made and no additional SSE-C secret is
introduced. Hetzner documents SSE-C as its only supported server-side encryption
mode in its [supported-actions matrix](https://docs.hetzner.com/storage/object-storage/supported-actions/).
A read-only HEAD of the
exact stored version must bind:

- strict production bucket and user-owned
  `private/production/exact-0096/...` object key;
- durable non-placeholder object version ID;
- exact content length, ETag, and encrypted-payload SHA-256 metadata;
- exact `mve1` client-side-encryption metadata;
- the canonical Hetzner provider kind, location, HTTPS transport, endpoint-origin
  fingerprint and enabled-versioning state.

If PUT ever omits `VersionId`, only a non-placeholder exact-key version whose ETag
equals that PUT may be deleted; the operation then fails terminally. The MVE1
`envelopeKeyVersionId` remains the sole payload-encryption key version. Hetzner
does not provide AWS SSE-KMS; the contract does not infer or fabricate a
server-side KMS key identity. MinIO remains useful only in isolated CI recovery
drills and is not accepted by the production backup primitive.

The restore repeats the complete bucket/key/version/HEAD/provider identity, not
only a free-standing version string. Missing or changed object identity, size,
digest, ETag, MVE1 metadata, endpoint binding, location or versioning state fails
closed.

## Non-destructive restore and unchanged source

The trace accepts a restore only under
`site-logbook-production-backup-restore-drill`. It requires a new PostgreSQL 16
database and distinct container, network, and volume identifiers, all using
immutable image references. The production source cannot be attached or written.
The exact object version must restore with exit code zero.

The restored journal, schema fingerprint, relation manifest, per-table counts,
per-table content digests, overall data-snapshot digest, dump digest, and encrypted
payload digest must match the source. No destructive restore or retention prune is
admitted.

After restore verification, the executor re-snapshots production from a new
read-only exported snapshot. Its complete count/content map and overall digest must
equal the original source snapshot, while the runtime, journal, schema, and second
writer-free boundary remain exact. Thus equal counts with changed row contents do
not pass, and the source-after claim is not reduced to runtime metadata.

## Producer-native trace and dependency interface

The trace pins the exact source build and immutable executor image. Seven ordered
steps bind their canonical artifact digest, timestamp, zero exit code, and sequence:

1. source observation;
2. first stopped-writers proof;
3. exported source snapshot;
4. bounded custom dump;
5. bounded encryption, exact-version persist, and HEAD;
6. disposable restore and read-only observation;
7. source re-snapshot and second stopped-writers proof.

The DI validator requires every reviewed operation to be a function and rejects
missing or extra methods. `runProductionExact0096BackupEvidenceExecutor()` invokes
them in the reviewed order and accepts only canonical bounded raw outputs. The
boundary covers immutable executor identity, source observation, both writer
proofs, exported snapshot creation, frozen relation measurements, bounded dump,
streaming encryption/persist, an independent exact-version HEAD, disposable
restore, restored parity observation, source re-observation, exclusive canonical
trace emission, and exclusive receipt persistence. An overflow returns before
HEAD, restore, trace emission, or receipt derivation.

No evidence artifact accepts a database URL, password, credential, access token,
private key, raw snapshot token, or suspicious credential-bearing URI. Recursive
secret scanning applies to creators and parsers. Strict canonical keys apply at
every object layer. Both creation and parsing enforce the same 512 KiB canonical
artifact ceiling.

Restore verifies the complete encrypted-object byte count and digest, decrypts
into a mode-0600 exclusive bounded temp file, and streams that file to the consumer
only after AES-GCM `final()` authenticates the tag. A bad tag exposes zero plaintext
bytes to the restore consumer.

## Artifacts

- `production-exact-0096-backup-contract.mjs`: frozen lineage and relation
  manifests, strict canonical schemas, content snapshot validation, identifier and
  secret policies;
- `production-exact-0096-backup-planner.mjs`: exact non-migrating plan and validated
  executor DI boundary;
- `production-exact-0096-backup-receipt.mjs`: producer trace, streaming/object,
  restore/source parity verifier, and trace-only receipt derivation;
- `production-exact-0096-backup-signature.mjs`: exact plan/trace/receipt detached
  signature envelope in the existing host/evidence trust domain;
- `production-exact-0096-backup-host-adapter.mjs`: default-dark fixed-argv host
  dependency adapter, one-process session and exclusive canonical artifact
  persistence;
- `production-exact-0096-disposable-restore-lifecycle.mjs`: host-owned isolated
  PostgreSQL 16 network/volume/container creation, streamed restore and cleanup;
- `production-exact-0096-disposable-restore-rehearsal.mjs`: exact-confirmation,
  local-only Node binary-stream `pg_dump` to `pg_restore` rehearsal with capped
  synthetic containers and verified exact cleanup;
- `production-exact-0096-backup-producer.ts`: exported-snapshot relation hashing,
  streaming dump/MVE1 encryption and exact object transfer primitives;
- `src/production-exact-0096-backup-producer.ts`: fixed-argv, request-file-only,
  default-dark control-plane CLI boundary;
- `production-exact-0096-backup-contract-fixtures.mjs`: deterministic hermetic raw
  producer artifacts;
- `production-exact-0096-backup-contract.test.mjs`: positive and adversarial
  contract tests without Docker, PostgreSQL, network, or production access.
- `production-exact-0096-host-runner.test.mjs`: default-dark preflight tests plus
  an end-to-end host-handler path through the real receipt executor, including a
  PASS receipt and source/restore schema-drift fail-closed cases, with all
  Docker/worker/provider calls hermetically substituted and no external I/O.
