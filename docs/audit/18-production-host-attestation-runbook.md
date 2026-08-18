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

The CLI does not accept caller-built Coolify, Docker, or PostgreSQL exports.
It invokes sealed, source-reviewed read-only observers on the production Docker
host and writes their canonical outputs itself. Never copy environment
variables, connection URLs, cookies, headers, credentials, snapshots, Compose
bytes, or Docker logs into an input file.

The observation request uses
`site-logbook.production-host-observation-request/v1` and contains:

- expected source SHA;
- expected immutable API image;
- database name/user and canonical audit schema fingerprint;
- Compose project, Postgres service/data destination, and a binary-sorted exact
  network service allow-list.

The separate `coolify-request.json` contains only an `expected` object (and an
optional timeout): the exact deployment id/revision/deployed-not-before bound,
configuration SHA-256, resolved Compose SHA-256, and immutable `api`, `web`, and
`postgres` images. It contains no endpoint, token, command, container id, or
transport override.

The sealed Coolify observer pins Coolify `4.1.1`, source commit
`5a27427cad54e98c21a691a08077c20f94f84f73`, the reviewed immutable control-plane
image digest, exact container id, and `StartedAt`. Before and after each sample
it inspects only those allow-listed runtime fields. Between the inspections it
runs a fixed-argv PHP bridge over stdin inside the pinned container. The bridge
uses a repeatable-read, read-only database transaction; requires the latest
`FINISHED`, non-preview deployment to have a stored snapshot; compares current,
stored, and recomputed snapshot hashes; invokes Coolify's own pending-diff
calculation; and hashes the mounted deployed Compose file. Snapshot, environment
and Compose contents are never serialized. Two nonce-bound samples must match.

The resulting Coolify export uses
`site-logbook.production-host-coolify-export/v1` and contains exact
project/environment/application ids, environment label, observation time,
pending-change boolean, and desired/deployed projections.
Each configuration projection contains only its SHA-256, resolved Compose
SHA-256, and exact immutable images for `api`, `web`, and `postgres`. Hetzner
Object Storage is external and is bound separately by the reviewed storage
configuration and exact backup evidence; MinIO is not a production service.
Desired and deployed projections must be identical and pending changes must be
false.

The PostgreSQL export uses `site-logbook.production-host-postgres-export/v2`
and contains observation time, exact Docker container id, Docker-export and
backend-proof digests, current database and user, PostgreSQL 16 server version,
audit schema fingerprint, and `readOnlyObservation: true`.

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

All JSON inputs and observer outputs are bounded and recursively scanned for
secret field names and secret-shaped values, including GitHub tokens and
PostgreSQL `SCRAM-SHA-256` verifiers even under neutral field names. Error
output never echoes a rejected value.

## Source-pinned host-operator packaging

Production-host collection must use the dedicated Dockerfile target
`host-operator`, not a source checkout or a `tsx` loader on the server. The
build emits one statically bundled
`production-host-evidence-operator.mjs`; an exact 40-character `BUILD_SHA` is
compiled into it and every observation request, verified predecessor artifact,
and transferred activation bundle must carry that same source SHA.

The target copies only `/usr/local/bin/docker` from the Docker Official Image
`docker:28.5.1-cli`. The reviewed OCI index digest is
`sha256:9190b0613792e658a7783cf14b2d5ace5941bb68ede7276922ea36ee457d76ad`;
the Dockerfile pins its exact `linux/amd64` child manifest
`sha256:a35dae37a79d2b84ccf0100045aec5ab920e4cc8e84f9141d355da602f8af899`.
The default/final `production` target still starts from `runtime`; it does not
inherit the Docker CLI, socket, host operator, or its entrypoint.

Publish the `host-operator` target through the separately approved immutable
image workflow and use only its reviewed `@sha256:` reference. No tag is
production authority. With pre-created UID/GID-1000 input/output directories,
an attended observation has this containment shape (replace only the exact
reviewed image and evidence paths):

```sh
socket_gid="$(stat -c '%g' /var/run/docker.sock)"
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 1 \
  --user 1000:1000 --group-add "$socket_gid" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --mount type=bind,src=/ABSOLUTE/inputs,dst=/inputs,readonly \
  --mount type=bind,src=/ABSOLUTE/evidence,dst=/evidence \
  ghcr.io/modvolt/REVIEWED_HOST_OPERATOR@sha256:REVIEWED_IMAGE_DIGEST \
  observe --request /inputs/request.json \
  --coolify-request /inputs/coolify-request.json --journal /inputs/journal.json \
  --image-provenance /inputs/image-provenance.json \
  --image-provenance-signature /inputs/image-provenance.sig \
  --coolify-export-out /evidence/coolify.json \
  --docker-export-out /evidence/docker.json \
  --postgres-export-out /evidence/postgres.json \
  --target-out /evidence/target.json
```

The `readonly` socket mount prevents replacement of the socket path but cannot
turn the Docker API itself read-only. The security boundary is therefore the
source-pinned, fixed-argv observer plus `--network none`, a non-root identity,
no environment/credential mounts, and the exact input/output allow-list. Do not
add a shell, command override, Docker context, `DOCKER_HOST`, broad host mount,
or privileged capability.

Calling the image with no subcommand is deliberately an error. It has only
`observe`, predecessor `attest`/`verify`, and the bounded transfer publication
described below; it has no deployment, migration, build, pull, login, or
general-purpose Docker passthrough command.

### Windows custody to Linux HOLD publication

DPAPI custody stays on the attended Windows workstation. Its canonical signed
`activation-bundle-v2.json` bytes are public evidence, but the vault, recovery
files, mnemonic, passphrase, private keys and temporary signing files are not
transfer artifacts. Transport is a separate two-phase operation:

1. Record the producer's `activationBundleSha256=sha256:...` result and transfer
   the single canonical bundle file to a new staging filename on the Linux host.
   Transfer the expected digest through the reviewed ceremony record or a
   separate operator channel; do not derive authority from the destination copy.
2. Mount only that staging file read-only and the fixed runtime evidence
   directory read-write. Do not mount the Docker socket for this subcommand.
3. Invoke the exact digest-gated publication. The command requires a bounded,
   stable, regular, non-symlink, single-link input; canonical UTF-8/sorted JSON
   with exactly one LF; the v2 kinds and compiled source SHA; canonical Ed25519
   descriptors; and a recursive private-material scan. It publishes only the
   fixed basename with an exclusive hard-link commit, file and directory fsync,
   then an exact single-link readback. An existing destination is never replaced.

```sh
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 \
  --user 1000:1000 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  --mount type=bind,src=/ABSOLUTE/transfer,dst=/transfer,readonly \
  --mount type=bind,src=/ABSOLUTE/runtime-evidence,dst=/evidence \
  ghcr.io/modvolt/REVIEWED_HOST_OPERATOR@sha256:REVIEWED_IMAGE_DIGEST \
  publish-activation-bundle --input /transfer/staged-activation-v2.json \
  --expected-sha256 sha256:REVIEWED_64_HEX_DIGEST \
  --evidence-dir /evidence \
  --confirm PUBLISH_DIGEST_VERIFIED_SITE_LOGBOOK_ACTIVATION_BUNDLE_V2_ON_HOST
```

If the output already exists or any check/fsync/readback fails, keep HOLD closed,
preserve both artifacts for review, and do not rename, edit, overwrite, or retry
blindly. Transport success alone never authorizes activation; the Linux runtime
still verifies both signatures and the complete semantic contract.

## Ceremony

1. Create `request.json`, `coolify-request.json`, and the reviewed migration
   journal row array from the release candidate. No file contains credentials.
2. On the production Docker host, invoke all three sealed observers and create
   their canonical exports plus the target artifact without overwriting an
   existing file:

   Use the exact immutable `host-operator` image and contained `observe` command
   shown above. The production host must not require this repository, pnpm, npm,
   TypeScript, `tsx`, or a mutable image tag.

   Coolify observation uses only exact container/image inspection and the
   fixed stdin bridge. Docker workload observation uses only `docker container
ls -aq`, fixed-template `container inspect`, `volume inspect`, and `network
inspect`; it never requests `Config.Env` or a complete Config/label map. The
   PostgreSQL observer executes only its reviewed read-only projection in the
   already verified container. Any unapproved peer or runtime race is fatal.

3. Complete the exact backup/restore, migration, role-ceremony, finalization and
   runtime-database-credential artifacts described by the dedicated runbooks.
   Reacquire all three observations through the same sealed collectors and
   create the canonical `site-logbook.production-activation-approval/v2` only
   after those fresh observations. Assemble the exact `activation.evidence`
   input described in
   [24-production-activation-bundle-producer.md](24-production-activation-bundle-producer.md).
   Preserve and verify the predecessor approval-v1 target/intent/execution/
   steady/release chain wherever the signed migration plan references it. Do
   not reconstruct that predecessor chain as the final startup transport and do
   not copy digest labels into a hand-written wrapper.
4. Review the live HOLD challenge and canonical evidence input, then run the
   attended activation-bundle producer. It invokes the two distinct DPAPI
   custody purposes, verifies both Ed25519 signatures, re-runs the runtime's
   complete semantic verifier and creates exactly one canonical staged
   `activation-bundle-v2.json` without overwriting an existing file. Follow the
   exact command and path rules in the bundle-producer runbook; private key
   material is never passed in argv, environment, stdin or stdout.
5. Transfer only those public bundle bytes and independently recorded digest,
   then use the source-pinned `publish-activation-bundle` operation above to
   commit the fixed Linux evidence filename. Do not transfer the DPAPI vault or
   substitute a manual copy/rename as the publication point.
6. The already-running immutable API container reads the fixed host file through
   its read-only mount. It remains in HOLD unless the restart nonce, container,
   image/config, backup, migration, credential, observation, approval and both
   source-pinned signature chains all match. No Base64 evidence environment
   variables are part of HOLD v2.

The older `attest`/`verify` commands remain authoritative for the predecessor
host/release artifact where that artifact is explicitly required by the signed
migration chain. Their approval-v1 and environment/Base64 transport do not
authorize or start the current production image and must not be used as a final
activation fallback.

## Fail-closed conditions

The runner/runtime rejects any Coolify version/source/image/container/start-time
drift, missing deployment snapshot, non-finished or preview deployment,
snapshot-hash mismatch, pending configuration, desired/deployed drift, mutable
image refs, wrong resource ids, stale/replayed/spread observations, foreign or
stopped Docker peers, mismatched database identity/fingerprint, secret-shaped
material, non-canonical JSON/base64, untrusted or wrong keys, tampering, expired
evidence, and any source/target/release/approval mismatch.

The signature is an operator/reviewer attestation of outputs produced by the
sealed observers; Coolify and Docker do not natively sign these projections.
It does not prove continuous host state after the short validity window.
Separately, the runtime
watchdog continuously rechecks only its approved database identity, migration
journal and schema fingerprint binding; the first failed check permanently
closes readiness, stops background schedulers and terminates the process. The
random nonce makes artifacts unique but is not a one-time challenge or replay
cache: a valid signed artifact remains reusable within its short validity
window.

## Expiry, restart loop, and recovery

The activation producer limits a bundle to a short five-minute ceremony window,
and the runtime independently enforces its bounded issue/expiry policy. Every
process start creates a new random challenge nonce, so an old bundle cannot
activate a restarted process even when the immutable container ID is unchanged.
The running API does not renew or self-heal signed evidence. A platform restart
policy can therefore turn the correct fail-closed HOLD result into a restart
loop until a new ceremony is completed.

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
4. Preserve the rejected `activation-bundle-v2.json` as audit evidence outside
   the fixed live filename; never overwrite or silently delete it. Start the
   same reviewed immutable image in HOLD with the fixed public-key mount and an
   absent live bundle filename.
5. Reacquire the secret-free projections for that exact HOLD challenge, build a
   fresh approval-v2 and canonical evidence input, then run the attended
   activation-bundle producer from step 4 above. Successful recovery must
   traverse the complete transport, signature, backup, migration, credential,
   observation, approval and fresh database/schema checks again.

Never edit `issuedAt`/`expiresAt`, reuse expired bytes, increase the lifetime,
disable the startup guard, pin an emergency key, use the staging control-plane
image as the API, or add a self-heal path that can reopen a tripped process.
