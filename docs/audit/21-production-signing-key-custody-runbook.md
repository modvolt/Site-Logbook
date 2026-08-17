# Production signing and encryption key custody

Status: the attended Windows current-user custody ceremony completed on
2026-08-17. For each of the four independent roles, the separately stored
mnemonic and passphrase were entered in a local interactive masked-TTY session;
the recovery material was derived and its expected fingerprint was independently
verified as `verified=true`. This verification did not reconstruct a complete
recovery card or perform a vault/backup restore drill. The two public Ed25519
trust roots are now pinned in the source maps; no private or symmetric key
material is present in source or evidence.

The public, secret-free receipt is
`docs/audit/evidence/21-production-signing-custody-ceremony-receipt.json`. It is
bound to the exact public-manifest SHA-256
`sha256:407ebba2d8661fe9fd7aa660056827608bd1199a12b214de3757419ed711abc7`.
The operator confirmed separate offline storage, but did not provide physical
storage-location labels; the receipt therefore records an empty label list
instead of inventing custody metadata.

This is a preparation and operator ceremony, not deployment approval. No
Coolify secret transfer has been performed. It does not change GitHub, Hetzner,
PostgreSQL, an object, a migration or a running container.

## Four independent key roles

One ceremony creates four independent values:

1. an Ed25519 publisher-provenance root, used only to sign canonical immutable
   API-image provenance;
2. a different Ed25519 host/evidence root, used for short-lived host
   attestations and the separate exact-0096 backup-receipt signature domain;
3. a 32-byte application secret-envelope key for
   `SECRET_ENCRYPTION_KEYRING` / `SECRET_ENCRYPTION_ACTIVE_KEY_ID`;
4. a different 32-byte MVE1 backup key for `BACKUP_ENCRYPTION_KEYRING` /
   `BACKUP_ENCRYPTION_ACTIVE_KEY_ID`.

`BACKUP_ACTIVE_KEY_ID` is not an application setting. The canonical name in
the implementation, examples, recovery ceremony and staging contracts is
`BACKUP_ENCRYPTION_ACTIVE_KEY_ID`.

Every key is derived from its own random 24-word BIP-39 mnemonic and independent
eight-word passphrase through the existing `modvolt-recovery-mnemonic/v1`
contract. The four derived 32-byte values are therefore independently
recoverable. The Ed25519 values are used as seeds for canonical PKCS#8 private
keys; the symmetric values are used directly. Private values and recovery cards
are encrypted with Windows DPAPI `CurrentUser`, with role-specific additional
entropy, and stored under a directory whose inherited ACL is removed and whose
allow-list is limited to the current user and Local System.

DPAPI is local at-rest protection, not disaster recovery. The ceremony is not
complete until every recovery card has been recorded and independently verified
in separately controlled offline storage. Copying only the `.dpapi` files is not
a portable recovery copy.

## Exact preflight

Use a trusted local Windows terminal with screen sharing, terminal recording,
shell transcription, cloud clipboard history and unrelated applications
disabled. Confirm the proposed vault does not exist and is outside every Git or
OneDrive workspace. The reviewed default is:

```text
%LOCALAPPDATA%\MODVOLT\Site-Logbook\production-signing-v1
```

Do not use a repository path, `.env`, Coolify environment, chat, issue, PR,
email, ordinary notes file or unencrypted removable media. `init` refuses an
existing vault and never overwrites a protected key.

Run once with reviewed lowercase identifiers:

```text
node scripts/production-evidence/production-signing-custody.mjs init --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-v1" --publisher-key-id ed25519:production-publisher-2026-08 --host-key-id ed25519:production-host-evidence-2026-08 --secret-key-id production-secret-2026-08 --backup-key-id production-backup-2026-08 --confirm INITIALIZE_NEW_PRODUCTION_KEY_VAULT
```

The command prints only the public manifest path and a `privateMaterialPrinted`
status. Then run:

```text
node scripts/production-evidence/production-signing-custody.mjs status --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-v1"
```

`status` verifies the protected ACL, bounded DPAPI records, two distinct key
IDs, two distinct public SPKI pins and four protected recovery cards. It prints
key IDs and public pins only.

The path boundary is also fail-closed. Before creating a vault, the helper
walks every existing path component and rejects a symlink, junction or other
Windows reparse point. It repeats that walk after creating the directory,
before every DPAPI file operation and during `status`. The restricted ACL must
be owned by the current Windows SID, must not inherit permissions and may grant
allow access only to that SID and Local System. A path that changes identity or
ownership is rejected rather than repaired by `status`.

## Offline recovery copies

For each of `publisher-provenance`, `host-evidence`, `secret-envelope` and
`backup-encryption`, explicitly copy one recovery card to the Windows clipboard
for the shortest practical interval:

```text
node scripts/production-evidence/production-signing-custody.mjs export-recovery-clipboard --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-v1" --role ROLE --clipboard-seconds 120 --confirm COPY_RECOVERY_CARD_TO_CLIPBOARD
```

The helper never writes the card to stdout or a plaintext file. It clears the
clipboard after the interval only if the clipboard still contains the same
card. Split the mnemonic and passphrase into two separately controlled offline
locations. Do not photograph either share. Clear clipboard history explicitly
after each card.

On a second offline machine or a separate offline session, run the existing
masked-TTY verification using the card's `recoveryPurpose`, `recoveryKeyId` and
`recoveryFingerprint`:

```text
pnpm recovery:ceremony -- verify --purpose PURPOSE --key-id RECOVERY_KEY_ID --expected-fingerprint sha256:REVIEWED --acknowledge-offline --acknowledge-separate-storage
```

Do not pin public keys or copy symmetric settings until all four independent
verifications succeed. Record only key IDs, fingerprints, SPKI pins, custody
owners, verification time and storage-location labels in the secret-free
ceremony receipt. Never record mnemonic words, passphrases or derived keys in
that receipt. If a physical storage-location label was not supplied, record no
label and state that it was not provided; never infer a label from instructions
or an assumed storage medium.

For the completed 2026-08-17 ceremony, the operator confirmed all four results
as `verified=true` after independent recovery-material derivation and fingerprint
comparison, and confirmed separate offline storage. The public manifest audit
also returned `ready=true`, `recoveryCardsProtected=true` and
`recoveryBindingsVerified=true`; `privateMaterialPrinted=false`. The original
vault files were restored after a backup copy. The receipt intentionally does
not claim full-card reconstruction, a portable recovery test, a restore drill or
any physical custody location.

## Attended disaster-recovery restore

Restore always targets a new absolute path outside the repository and OneDrive.
It never overwrites or repairs an existing vault. Start from the original
public `public-trust-roots.json`; it contains no secret, but its reviewed bytes
bind the four key IDs, recovery fingerprints and both SPKI pins.

In a trusted local interactive Windows terminal with ambient provider secrets,
screen/terminal recording and clipboard history disabled, run:

```text
node scripts/production-evidence/production-signing-custody.mjs restore --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-restored-v1" --public-manifest "D:\REVIEWED\public-trust-roots.json" --confirm RESTORE_NEW_PRODUCTION_KEY_VAULT
```

The command refuses CI, production mode, redirected stdin/stdout and a terminal
without raw masked input. It prompts for exactly four complete canonical cards
in fixed order: publisher provenance, host evidence, application secret and
backup encryption. Nothing is echoed except mask characters. For every card it
requires exact schema/role/key-ID/purpose/fingerprint equality with the public
manifest, re-derives the existing BIP-39/HKDF value and verifies the exact
Ed25519 SPKI pin or 32-byte symmetric value. It also rejects equal application
and backup keys. Only after all four cards pass does it create a new protected
DPAPI vault using exclusive file creation.

Immediately run `status` on the restored path and require both `ready=true` and
`recoveryBindingsVerified=true`. Compare the restored public manifest bytes to
the reviewed original. Perform one independently reviewed public-artifact
signature/verification drill for each Ed25519 role and a non-production
encrypt/decrypt drill for each symmetric role before accepting the restored
vault. Never restore directly into a production host or Coolify environment;
transfer and activation remain separate approval boundaries.

## Public source pins

After the recovery verification, copy only the public fields from
`public-trust-roots.json` into these reviewed source maps:

- publisher `keyId`, canonical SPKI PEM and SPKI SHA-256:
  `artifacts/api-server/src/lib/production-publisher-provenance-pinned-keys.mjs`;
- host/evidence `keyId`, canonical SPKI PEM and SPKI SHA-256:
  `artifacts/api-server/src/lib/production-host-evidence-pinned-keys.mjs`.

The imported contract allows exactly one Ed25519 key per map, rejects a pin
without a key, multiple keys, non-canonical PEM, private PEM and every SPKI/pin
mismatch. Migration-backup verification aliases the exact host/evidence map and
cannot introduce a third signing root. Run at minimum:

The reviewed 2026-08-17 public bindings are:

- publisher `ed25519:production-publisher-2026-08` ->
  `sha256:5ad804df40f489ed1273796c393b51bf63b5497d06929f7e6726be9dbd54f4a6`;
- host/evidence `ed25519:production-host-evidence-2026-08` ->
  `sha256:caba1ae8a341ed7703769c06cde1e48a632d4d59f12b957fa2983a3319388af0`.

The public manifest has schema
`site-logbook.production-signing-custody/v1`, kind
`site-logbook-production-signing-public-trust-roots`, creation timestamp
`2026-08-12T22:38:25.189Z` and exact SHA-256 shown above. These public bindings
do not activate a signer or authorize any production action.

```text
pnpm test:production-signing-custody
pnpm test:production-host-evidence
pnpm test:production-exact-0096-backup-contract
pnpm run typecheck
```

Pinning is a reviewed source change and creates a new source SHA/image. It does
not authorize a merge, image publication, deployment, migration or application
start.

## One-shot Coolify transfer

Only after the source-pin review and a separately approved Coolify ceremony,
copy the four exact symmetric settings to the Windows clipboard:

```text
node scripts/production-evidence/production-signing-custody.mjs export-coolify-clipboard --vault "C:\Users\OPERATOR\AppData\Local\MODVOLT\Site-Logbook\production-signing-v1" --clipboard-seconds 120 --confirm COPY_COOLIFY_SECRETS_TO_CLIPBOARD
```

This command requires exact acknowledgement, emits no secret to stdout or disk,
and clears an unchanged clipboard at the deadline. Paste directly into the
approved Coolify secret editor. Never place either Ed25519 private key in
Coolify. Before saving, reject duplicate or legacy variable names and verify
that application and backup keyring values differ. Saving or redeploying is a
separate approval boundary and is not part of this runbook step.

## Signing operations

`sign` reads a bounded public canonical artifact, unwraps the selected key only
in memory, re-derives and checks its public SPKI pin, signs, self-verifies, clears
the private buffer and exclusively creates a raw 64-byte detached signature
outside the repository. Its fixed purpose/role matrix is:

- `publisher-provenance` -> publisher root, exact artifact bytes;
- `host-attestation` -> host/evidence root, exact artifact bytes;
- `backup-receipt` -> host/evidence root, reviewed backup-signature domain plus
  NUL plus exact envelope bytes.

There is no generic decrypt, private-key export, private environment variable or
private CLI argument.

The current host-attestation and publisher-provenance `v1` contracts sign their
exact canonical artifact bytes; changing them to add a new domain prefix would
invalidate existing signatures and requires an explicit schema/version
transition. The exact-backup receipt already uses its own reviewed `v1` domain
prefix plus NUL. This custody hardening therefore does not silently change the
two frozen signature formats. A future `v2` may add explicit, distinct domain
prefixes only with dual-version verification, migration evidence and a separate
activation review.

## Rotation and loss

Rotation always creates four new independent recovery materials and a reviewed
new source SHA. Retain an old symmetric key in its keyring while any supported
ciphertext or backup uses it. Retain the old public signing root while retained
evidence must verify; do not silently add a second active root to the single-key
production maps. A lost DPAPI vault is restored only through the independently
verified offline recovery shares. If any share or custody location is uncertain,
stop activation and rotate; never substitute an emergency key or weaken a pin.
