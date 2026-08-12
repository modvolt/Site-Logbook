# Production host observation and detached attestation

Status: producer, runtime verifier and pre-import production startup wiring are
implemented. Activation remains fail-closed until separate offline custody
ceremonies pin reviewed public SPKI keys in both production key maps and fresh
signed release-chain artifacts are available.

The executable Windows custody procedure and exact four-role boundary are in
`21-production-signing-key-custody-runbook.md`.

This runner does not deploy, migrate, build, push, or write to Coolify. It
creates a bounded, secret-free observation from read-only inputs. The
pre-import production bootstrap trusts the observation only after verifying a
detached Ed25519 signature with a public key compiled into the reviewed runtime
image; with the intentionally empty key maps, startup remains default-deny.

## Trust boundary

- The signing private key must remain offline or in a hardware-backed signing
  service. It is never passed to the runner, repository, image, or runtime
  environment.
- The key id and public SPKI PEM are source-pinned. Changing or rotating them is
  a reviewed source change and produces a new image/source SHA.
- Host-attestation environment variables transport only the canonical public
  attestation and its detached signature. Replacing both cannot bypass the
  source-pinned public key; separate runtime variables carry the independently
  checksummed release-chain artifacts.
- The signature binds the exact source SHA, target evidence digest, release
  evidence digest, activation approval digest, Coolify resource ids, immutable
  image refs, Docker/PostgreSQL projection, nonce, and short validity window.
- The startup caller passes the already validated API/Postgres images,
  desired/deployed/Compose digests, live Postgres projection, database identity,
  and schema fingerprint into the verifier. The signed observed-state fields
  must equal those values; matching only the four release digests is not
  sufficient.
- A valid attestation expires after at most 15 minutes. A different source,
  target, release, or approval digest requires a new observation and signature.

## Secret-free read-only inputs

The Coolify API/browser session and PostgreSQL connection may require
credentials, so those acquisition steps deliberately stay outside this CLI.
Provide explicit raw JSON exports containing only the following projections.
Never copy environment variables, connection URLs, cookies, headers, or
credentials into these files.

The observation request uses
`site-logbook.production-host-observation-request/v1` and contains:

- expected source SHA;
- expected immutable API image;
- database name/user and canonical audit schema fingerprint;
- Compose project, Postgres service/data destination, and a binary-sorted exact
  network service allow-list.

The Coolify export uses `site-logbook.production-host-coolify-export/v1` and
contains exact project/environment/application ids, environment label,
observation time, pending-change boolean, and desired/deployed projections.
Each configuration projection contains only its SHA-256, resolved Compose
SHA-256, and exact immutable images for `api`, `web`, and `postgres`. Hetzner
Object Storage is external and is bound separately by the reviewed storage
configuration and exact backup evidence; MinIO is not a production service.
Desired and deployed projections must be identical and pending changes must be
false.

The PostgreSQL export uses `site-logbook.production-host-postgres-export/v1`
and contains observation time, exact Docker container id, current database and
user, server version, audit schema fingerprint, and
`readOnlyObservation: true`.

The image-provenance input is a canonical
`site-logbook.production-api-image-provenance/v1` artifact produced and
reviewed with the immutable image publication. Its subject image/digest,
source SHA, production profile, and absence of mutating entrypoints must match
the request and live Coolify/Docker state. The producer hashes the artifact
bytes and verifies its detached Ed25519 signature with a separate source-pinned
publisher public key; it does not accept a self-asserted provenance label.
Like the host trust root, the production publisher key map is initially empty
and activation stays fail-closed until an independently reviewed custody
ceremony pins the public key.

All JSON inputs are bounded and recursively scanned for secret field names and
secret-shaped values. Error output never echoes a rejected value.

## Ceremony

1. Create the request JSON from the reviewed release candidate.
2. On the production Docker host, collect the complete stopped/running
   container projection with read-only Docker verbs only:

   ```text
   node scripts/production-evidence/run-production-host-evidence.mjs collect-docker --request request.json --docker-export-out docker.json
   ```

   The collector uses only `docker container ls -aq`, `docker container
inspect`, `docker volume inspect`, and `docker network inspect`. Each inspect
   uses a fixed daemon-side Go template that returns only the reviewed fields;
   it never requests `Config.Env` or the complete `Config`/label map. The next
   gate rejects any unapproved volume or network peer.

3. Acquire the explicit secret-free Coolify and PostgreSQL read-only exports.
4. Create the canonical target artifact without overwriting an existing file:

   ```text
   node scripts/production-evidence/run-production-host-evidence.mjs observe --request request.json --image-provenance image-provenance.json --image-provenance-signature image-provenance.sig --coolify-export coolify.json --docker-export docker.json --postgres-export postgres.json --target-out target.json
   ```

5. Complete the separately reviewed transition, steady-state, release, and
   activation approval evidence. The activation approval is canonical
   `site-logbook.production-activation-approval/v1`. The release evidence must
   contain its exact SHA-256. The runner accepts and hashes the exact canonical
   target, intent, execution, steady, release, and approval artifacts; every
   release-chain digest plus source/target link must match. It never accepts a
   parallel hand-written binding wrapper or manually copied digest labels. The
   production runtime still performs the full semantic validation of these same
   artifacts before it invokes the host verifier.
6. Reacquire all three observations. The second pass must match every stable
   target field. Prepare a fresh unsigned canonical attestation:

   ```text
   node scripts/production-evidence/run-production-host-evidence.mjs attest --request request.json --image-provenance image-provenance.json --image-provenance-signature image-provenance.sig --coolify-export coolify.json --docker-export docker.json --postgres-export postgres.json --target target.json --intent-evidence intent.json --execution-evidence execution.json --steady-evidence steady.json --release-evidence release.json --activation-approval activation-approval.json --key-id ed25519:production-YYYY-NN --attestation-out host-attestation.json
   ```

7. Review the canonical artifact, then sign it outside this runner. For an
   offline OpenSSL Ed25519 key, the signing operation is equivalent to
   `pkeyutl -sign -rawin` over the exact bytes. Do not place the private-key path
   in shell history on the host.
8. Verify the detached signature with the candidate public key:

   ```text
   node scripts/production-evidence/run-production-host-evidence.mjs verify --attestation host-attestation.json --signature host-attestation.sig --public-key production-host-public.pem --public-key-sha256 sha256:REVIEWED_SPKI_DIGEST --key-id ed25519:production-YYYY-NN --target target.json --intent-evidence intent.json --execution-evidence execution.json --steady-evidence steady.json --release-evidence release.json --activation-approval activation-approval.json
   ```

9. Base64-encode the exact canonical artifact and raw 64-byte signature as
   `PRODUCTION_HOST_ATTESTATION_B64` and
   `PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64`. These are public evidence, not
   secrets. Startup still verifies the source-pinned public key and all exact
   release bindings before importing the application or starting workers.

## Fail-closed conditions

The runner/runtime rejects pending Coolify configuration, desired/deployed
drift, mutable image refs, wrong resource ids, stale or spread observations,
foreign/stopped Docker peers, mismatched database identity/fingerprint,
non-canonical JSON/base64, untrusted or wrong keys, tampering, expired evidence,
and any source/target/release/approval mismatch.

The signature is an operator/reviewer attestation of explicit raw exports;
Coolify and Docker do not natively sign these projections. It does not prove
continuous host state after the short validity window. Separately, the runtime
watchdog continuously rechecks only its approved database identity, migration
journal and schema fingerprint binding; the first failed check permanently
closes readiness, stops background schedulers and terminates the process. The
random nonce makes artifacts unique but is not a one-time challenge or replay
cache: a valid signed artifact remains reusable within its short validity
window.

## Expiry, restart loop, and recovery

The 15-minute maximum lifetime is checked on every process start. The running
API does not renew or self-heal the signed observation. After the window closes,
an automatic container restart therefore fails before app import with
`PRODUCTION_HOST_ATTESTATION_EXPIRED`; a platform restart policy can turn that
correct fail-closed result into a restart loop.

Alert outside the container on repeated restarts, unhealthy state and non-zero
API exits (for example at the Coolify/node monitoring layer). Do not depend on
API email, watchdog, or outbox alerts for this condition: none of those workers
are reachable when the startup guard rejects the evidence. The alert should
identify the application and failure code but must not attach environment
values, evidence base64, signatures, cookies, database URLs, or raw logs that
can contain credentials.

Recovery procedure:

1. Stop or pause the automatic restart loop; keep the API stopped and do not
   weaken its health check.
2. Read-only inspect the exact immutable image, Coolify desired/deployed state,
   pending-change flag, Docker projection, database/user, migration journal and
   schema fingerprint. Treat any mismatch as real drift until proven otherwise.
3. Resolve actual drift only through its separately reviewed deployment or
   migration procedure. Do not manufacture evidence for the state that was
   expected.
4. Reacquire the secret-free projections, generate a new canonical attestation,
   review it, sign its exact bytes offline, and verify the signature and pinned
   SPKI digest before transport.
5. Replace only `PRODUCTION_HOST_ATTESTATION_B64` and
   `PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64`, then restart the same reviewed
   immutable image. Successful recovery must traverse the complete startup
   evidence, signature, target and live database/schema checks again.

Never edit `issuedAt`/`expiresAt`, reuse expired bytes, increase the lifetime,
disable the startup guard, pin an emergency key, use the staging control-plane
image as the API, or add a self-heal path that can reopen a tripped process.
