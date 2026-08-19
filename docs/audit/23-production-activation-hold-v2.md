# Production activation HOLD v2

Status: implemented transport, lifecycle and authoritative semantic chain;
**not deployed and not an activation or deployment approval**.

The immutable production API image now starts `production-api-entrypoint.mjs`.
It serves a process-healthy HOLD from the same container and does not import the
application, workers, database readiness code, or object-storage clients. The
database and S3 secrets may already be present in the fixed Compose environment,
but HOLD does not read or use them.

## Fixed host boundary

Before the container is created, the operator prepares one host directory and
places only the two distinct pinned public keys in it:

- `activation-publisher-ed25519-public.pem` — canonical LF publisher Ed25519
  public PEM;
- `activation-host-ed25519-public.pem` — canonical LF host-attestation Ed25519
  public PEM; it must not equal the publisher key;
- `activation-bundle-v2.json` — absent at container creation, later published
  atomically by the separately approved host ceremony.

Compose binds that directory read-only at
`/run/site-logbook-production-evidence`, with `create_host_path: false`. The
mount exists in desired and deployed configuration before HOLD starts. Adding
one new bundle at the previously absent fixed filename therefore does not change
desired, deployed, or resolved Compose bytes. The producer never overwrites or
replaces an existing bundle. Canonical evidence is never transported as Base64
environment variables.

The bundle is accepted at the transport boundary only when all of these checks
pass:

- one regular, non-symlink, single-link file;
- stable identity, size, timestamps and link count across an `O_NOFOLLOW`,
  bounded read;
- at most 512 KiB, valid UTF-8, sorted-key canonical JSON and exactly one final
  LF;
- bounded UTC issue/expiry window;
- exact runtime nonce, embedded source SHA and immutable API image digest from
  the live HOLD challenge; `/etc/hostname` must be exactly 12 or 64 lowercase
  hex, with a 12-hex value required to prefix the authoritative 64-hex Docker
  Inspect ID and a 64-hex value required to match it exactly;
- desired/deployed configuration equality and the resolved Compose digest from
  the signed approval plus the authoritative final Coolify/Docker/PostgreSQL
  observations; these values are not accepted from startup environment
  variables or unsigned discovery;
- separately pinned publisher and host Ed25519 DER-SPKI fingerprints plus valid
  independent signatures over the activation object and host attestation;
- no private-key, credential, password, bearer-token, database-URL, mnemonic,
  passphrase, access-key, Bearer credential, or SCRAM verifier material,
  including when hidden under a neutral field name;
- actual artifact envelopes and canonical payload digests for the signed
  exact-0096 backup plan/trace/PASS receipt/signature, migration
  plan/intent/persistence/exact ten receipts/final-live/role/postcommit/
  transition-PASS, runtime DB credential-cutover request/PASS receipt, final
  Coolify/Docker/PostgreSQL observations, and separate activation approval.

A bundle from an earlier process start cannot pass because the random challenge
nonce changes; container recreation also changes the full Docker ID (bound by
the exact 12-hex runtime prefix or exact 64-hex value), while a
restart of the same container may retain that ID. Invalid, stale, replayed,
mismatched, or semantically blocked evidence leaves the listener in HOLD.

The challenge deliberately omits desired/deployed/resolved configuration
digests. Coolify includes application environment values in its deployment
configuration hash and interpolates them into resolved Compose bytes, so an
expected-digest environment variable would require an infeasible cryptographic
fixed point. The runtime accepts those three bindings only after both bundle
signatures and the complete semantic observer chain pass; the resulting
in-memory release summary supplies them directly to the database/startup
preflight.

For a new ceremony, first stop the old application process and preserve its
bundle under a separate audit filename outside the fixed live path. Start the
same reviewed immutable image in HOLD with `activation-bundle-v2.json` absent,
capture that process's new challenge, and use the no-clobber producer to publish
the fresh file. Never delete an unreviewed bundle merely to make a retry pass,
and never edit its nonce, timestamps or signatures.

## Health and shutdown

Every external route, including `/api/healthz`, returns 503 in HOLD. Docker may
distinguish a healthy HOLD process through the loopback-only
`/.well-known/site-logbook-container-health` endpoint. The image healthcheck
accepts either this loopback HOLD response or the application's normal health
response after activation.

After a fully valid semantic verdict, the lifecycle guard closes the HOLD
listener with a bounded timeout and imports `index.mjs` exactly once. Parallel
polls share one activation promise. SIGTERM/SIGINT close HOLD within five
seconds, with a bounded hard-stop fallback.

## Complete authoritative semantic chain

`verifyProductionActivationContractV2` now directly calls the existing
authoritative exact-0096 plan, executor-trace and PASS-receipt parsers, verifies
the detached backup signature against the source-pinned host/evidence key, and
then calls the authoritative complete migration transition-chain verifier. That
second verifier reconstructs the plan, durable intent/persistence, all ten
transaction-backed receipts, exact final live inventory, role transaction and
postcommit artifact. The activation contract also requires those exact backup
bytes to equal the backup bytes embedded in the migration plan.

The former credential gap is closed by the producer-owned
`ProductionRuntimeDbCredentialReceiptParser`. The direct activation adapter is
source-wired to that parser. It reconstructs the receipt from its exact
canonical request, cross-binds it to the already verified backup and complete
migration transition, and requires the distinct old live-source/new executor
identities, the authoritative migration-plan database name, role
plan/transaction/post-commit/final-live digests, committed SCRAM transition,
exact readback, fresh runtime login, timestamp ordering, bounded freshness and
non-authorizing flags. Even a coordinated request/receipt/request-digest change
to another database therefore fails closed.

`apiImageProvenance` is likewise not trusted as a transport assertion. It
contains the unchanged canonical v2 provenance bytes and their canonical
padded-base64 64-byte Ed25519 detached signature. The activation producer
verifies them before either custody signature, and the runtime semantic
contract independently invokes the sealed one-argument, source-pinned verifier
again. Its verdict must match the signed activation source SHA and immutable API
image. Only that verdict supplies `publicationReceiptSha256`,
`reviewedImageSetSha256`, `apiRunnableManifestDigest` and
`apiOciProvenanceSha256` to the in-memory runtime binding; approval/request
fields cannot self-assert them. Missing bytes, canonical-byte tampering, a wrong
signature or a correctly signed replay from another source remain in HOLD.

`activationApproval` and the three final-observation envelopes are not trusted
as transport assertions. The activation producer parses one exact approval-v2
schema and requires its explicit `APPROVE` decision and fixed confirmation. A
narrow exported verifier in the host-attestation producer reuses its existing
exact Coolify, Docker and PostgreSQL parsers and their cross-bindings; no
observer owns a second, weaker schema parser. The resulting verdict is bound to
the signed activation source SHA, immutable API image, restart nonce, API
container ID, desired/deployed/resolved config digests, authoritative database
name and runtime user, PostgreSQL fingerprint, migration transition and final
live identity, credential request and receipt, and the canonical digests of all
three observations. The exact chronology must be migration completion,
credential mutation and fresh login, all three observations, explicit approval,
then activation issuance. Swapped, denied, stale, replayed, missing or tampered
approval/observation evidence remains in HOLD.

The production export `verifyProductionActivationContractV2` accepts exactly
one signed bundle and always uses the source-wired direct adapters. Runtime code
cannot pass an adapter override. An explicitly confirmed adapter seam is
available only inside a Vitest/test process so focused contract tests can prove
fail-closed missing-producer cases without weakening the production call path.

Consequently, a transport-valid but semantically invalid bundle remains in
HOLD, while one exact, signed, fresh bundle whose backup, migration, credential
and observation chain all pass can close HOLD and load the application once.
This is only a source capability. No real production evidence was created or
consumed by this implementation, and no container was activated.

No `PASS` string, signed envelope, host attestation, target/intent JSON, or any
other artifact authorizes deployment or activation by itself. Only the complete
signed, producer-parsed and cross-bound chain can authorize application start;
it still does not authorize a deployment. Until a real canonical production
bundle passes that complete chain, the production image remains in HOLD.

## Hermetic gate

Run:

```text
pnpm test:production-activation-hold
```

The suite covers canonical signed transport, expiry and binding failures,
restart replay, hard-link/symlink policy, external-versus-Docker health,
no-start before evidence, exactly-once activation, unchanged config bytes, the
direct authoritative credential and observation adapters, non-injectable
production verification, signed API-image provenance re-verification, and
negative provenance/receipt/approval/observation cases for missing/tampered/
wrong-signature/replay/swap/alias/denial/missing key/uppercase/private material/
reversed time/stale replay.
