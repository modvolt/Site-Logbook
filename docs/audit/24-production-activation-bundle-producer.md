# Production activation bundle v2 producer

Status: source capability only. This command does not approve a deployment,
migration, activation, or production change.

`run-production-activation-bundle.mjs` closes the Windows producer-side gap
between a live HOLD challenge and one signed, canonical staging artifact.
It assembles the exact outer v2 objects, invokes the attended custody boundary
for both required signatures, runs the same transport and semantic verifiers as
the production API, and only then publishes one canonical Windows file atomically.
It does not itself transfer to or publish the Linux runtime path.

## Inputs

All paths are absolute. Every input is read as one bounded, stable, regular,
non-symlink, single-link file.

- `--challenge` is the canonical JSON object emitted by the currently running
  HOLD container. It contains only the immutable source/image binding plus that
  restart's container identity and random nonce. The identity is exactly the
  12-hex Docker hostname prefix or a full 64-hex ID; runtime verification binds
  the short form only to the authoritative full Docker Inspect ID. Configuration
  digests are excluded because Coolify would hash those environment values into
  the values they are meant to predict.
- `--evidence` is canonical JSON containing exactly the
  `activation.evidence` object: exact-0096 backup artifacts, the complete
  0096-to-0107 migration chain with ten receipts, runtime credential request
  and PASS receipt, final Coolify/Docker/PostgreSQL observations, the separate
  activation approval, and `apiImageProvenance` with exactly `canonical` and
  `signatureB64`. `canonical` is the unchanged canonical LF v2 API-image
  provenance artifact; `signatureB64` is its canonical padded-base64 64-byte
  Ed25519 detached signature.
  The producer takes desired/deployed/resolved configuration digests from that
  canonical approval, requires desired and deployed equality before signing,
  verifies API-image provenance through the sealed source-pinned verifier,
  cross-binds its source SHA and immutable API image to the live challenge, and
  then runs the runtime's authoritative observer cross-binding before it
  publishes any bundle. The verified provenance supplies the publication
  receipt, reviewed image set, runnable manifest and OCI provenance digests;
  these values are never reconstructed from an unsigned request or approval.
- `--publisher-public-key` and `--host-public-key` are the distinct canonical
  LF Ed25519 public PEM files already mounted into the HOLD container. Their
  canonical SPKI-DER SHA-256 fingerprints become the signature key identifiers
  and must equal the pinned custody manifest/Coolify values.
- `--vault` is the existing current-user DPAPI custody directory. It is a path,
  not private material.
- `--output` must end in `activation-bundle-v2.json`, its parent directory must
  already exist, and the file must be absent.

The evidence input remains public, canonical evidence. It must never contain a
password, private key, database URL, SCRAM verifier, bearer credential, GitHub
token, mnemonic, passphrase, access key, or other private material, even under a
neutral field name.

## Attended command

Run from the exact reviewed checkout while the matching HOLD challenge and
final observations are still fresh:

```powershell
pnpm production:activation-bundle -- publish `
  --challenge "D:\reviewed\activation-challenge-v2.json" `
  --evidence "D:\reviewed\activation-evidence-v2.json" `
  --publisher-public-key "D:\site-logbook-production-evidence\activation-publisher-ed25519-public.pem" `
  --host-public-key "D:\site-logbook-production-evidence\activation-host-ed25519-public.pem" `
  --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-v1" `
  --output "D:\site-logbook-production-evidence\activation-bundle-v2.json" `
  --confirm PUBLISH_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_BUNDLE_V2
```

The command hard-wires these two existing custody operations:

1. `publisher-provenance` signs the canonical activation object;
2. `host-attestation` signs the canonical host-attestation object.

The private keys stay DPAPI-protected in the custody vault. No private key,
passphrase, password, signature input bytes, or secret value is accepted on
argv, read from stdin, placed in a new environment variable, or printed. The
only stdout fields are public path/digest/challenge/time metadata and boolean
verification results.

## Fail-closed publication

Before either custody key is used, the command refuses an existing output. It
derives the host observation time from the newest of the three exact final
observations, binds both signed objects to the live source/image/config,
container ID and nonce, and limits the bundle to five minutes.

After both raw 64-byte signatures are returned, the producer verifies them
against the exact public PEMs. It then invokes
`validateProductionActivationBundleTransport` and
`verifyProductionActivationContractV2` directly from the runtime source. A
transport, schema, digest, cross-binding, chronology, producer-parser, or
semantic failure leaves the final path absent.

Publication uses a synced temporary file in the output directory followed by
an exclusive hard-link publication and temporary-link removal. The final name
therefore appears with complete bytes, an existing file is never overwritten,
and the producer performs a stable byte-for-byte readback. A successful stdout
receipt still does not authorize deployment; it reports only that the exact
staging bundle was produced for the already running matching HOLD instance.

The API runtime receives the verified configuration digests only in the
in-memory release summary returned by the semantic verifier. There is no
`PRODUCTION_EXPECTED_DESIRED_CONFIG_SHA256`,
`PRODUCTION_EXPECTED_DEPLOYED_CONFIG_SHA256`, or
`PRODUCTION_EXPECTED_RESOLVED_COMPOSE_SHA256` environment fallback.

## Separate Linux publication phase

The canonical bundle bytes and the printed `bundleSha256` are public
evidence. Transfer only that bundle to a new staging filename on the production
host; never transfer the DPAPI vault, recovery material, mnemonic, passphrase,
private keys, or temporary signing files. The expected digest must arrive from
the reviewed ceremony record or a separate operator channel and must not be
recomputed as the sole authority from the destination copy.

Final publication into the runtime evidence mount is performed only by the
exact-SHA, immutable `host-operator` image's default-dark
`publish-activation-bundle` subcommand. It rechecks the byte bound, stable
regular single-link identity, canonical LF/sorted JSON, v2 source binding,
Ed25519 descriptors, recursive private-material scan and independently supplied
SHA-256. It then commits only the fixed `activation-bundle-v2.json` basename via
no-clobber hard link, file/directory fsync and exact single-link readback. The
Docker socket is not mounted for this phase. See
[18-production-host-attestation-runbook.md](18-production-host-attestation-runbook.md#windows-custody-to-linux-hold-publication)
for the contained command and failure procedure.

## Hermetic verification

```text
pnpm test:production-activation-bundle
```

The suite covers exact runtime-transport compatibility, distinct custody
purposes, signature verification, canonical bytes, one-link atomic publication,
no-clobber before signing, neutral-field secret rejection without echo, unsafe
hard-link and noncanonical input rejection, missing/tampered/wrong-key/replayed
API-image provenance before custody signing, wrong custody-key failure, and the
production wiring to the custody CLI and runtime semantic verifier.
