# Production API runtime database credential cutover

Status: **source contract and control-plane CLI only; not executed, not a
deployment approval**. The production API login is fixed to
`site_logbook_runtime`. PostgreSQL bootstrap/admin credentials remain confined
to the `postgres` service, and `site_logbook_migrator` remains a separate
`NOLOGIN` owner. The API does not receive either privileged identity.

## Two source identities must not be aliased

Every canonical request binds all of the following independently:

- `liveSourceSha`: source SHA carried by the already completed migration and
  role-separation evidence for the currently observed database;
- `executorSourceSha`: SHA embedded by esbuild into the credential
  control-plane bundle;
- `executorImage`: externally inspected immutable control-plane
  `repository@sha256:<digest>` reference.

The CLI rejects a request if the embedded executor SHA or explicit immutable
executor image differs. The existing migration authority independently rejects
a different live-source SHA, database, role plan, transaction receipt or
post-commit projection. Never copy the executor SHA into `liveSourceSha` merely
to satisfy a check.

## Secret boundary and PostgreSQL 16

PostgreSQL 16 does **not** accept a bind parameter in `ALTER ROLE ... PASSWORD`:
the PG16 grammar requires a string constant. Consequently the control plane
does not use the invalid or misleading `PASSWORD $1` form. It mirrors the
documented PG16 `psql \\password` mechanism instead:

1. the cleartext secret is received only through
   `PRODUCTION_RUNTIME_DATABASE_PASSWORD`;
2. a fresh 16-byte salt is generated in memory and a PostgreSQL-compatible
   SCRAM-SHA-256 verifier is derived client-side with 4096 iterations;
3. only the strictly shaped verifier is placed in the `ALTER ROLE` SQL text;
4. the cleartext secret is absent from SQL text, query parameters, argv,
   stdout, stderr and canonical evidence;
5. a fresh connection as `site_logbook_runtime` proves the new secret after a
   confirmed commit.

The transaction also reads `pg_authid.rolpassword` back through the attended
administrator and requires byte-for-byte equality with the derived verifier;
non-null alone is not accepted. The opt-in disposable PostgreSQL 16 gate
`pnpm test:production-runtime-db-credential:pg16` must run against a fresh
host-TCP fixture initialized with `--auth-host=scram-sha-256`. Its guard
requires numeric loopback `127.0.0.1`, an ephemeral port in `49152-65535`,
database `runtime_credential_pg16_fixture`, administrator
`runtime_credential_pg16_fixture_admin`, no URL parameters, and the separate
exact environment confirmation
`PRODUCTION_RUNTIME_DB_CREDENTIAL_PG16_DISPOSABLE_CONFIRM=I_CONFIRM_THIS_IS_A_DISPOSABLE_LOCAL_PG16_RUNTIME_CREDENTIAL_FIXTURE`.
The test never drops the runtime role unless this invocation successfully
created it. It proves the exact stored verifier, a successful new-password
login, and SQLSTATE `28P01` for a wrong password. A `trust`, production-like or
unconfirmed fixture is rejected and is not valid evidence.

The password must be a unique 32-256 character value from
`[A-Za-z0-9._~-]`. Generate it directly in the approved password manager; do
not print it, paste it into a shell command, store it in Git, or put it in the
request/evidence directory.

## Required canonical inputs

The request schema is
`site-logbook.production-runtime-db-credential-cutover-request/v1`. It contains
only the three source identities above, exact database and role names, SHA-256
bindings for the migration plan/role transaction receipt/independent
post-commit role projection, a bounded approval ID, a positive advisory lock
key fixed to the shared migration/role value `911072468`,
`authorizesDeployment:false`, and the exact confirmation:

`SET_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_AFTER_ROLE_SEPARATION`

All JSON inputs must be key-sorted canonical UTF-8 with one trailing LF. Input
files must be bounded regular files, not symlinks, with one hard link and
stable identity across the read.

## Attended invocation

Use the exact immutable control-plane image whose digest is in the request.
Create a mode-0600 operator env file **outside the repository** and outside the
evidence directory. Transfer values directly from approved custody; do not
echo the file:

```text
PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL=postgres://<admin>:<admin-secret>@postgres:5432/<database>
PRODUCTION_RUNTIME_DATABASE_PASSWORD=<new-runtime-secret>
PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE=ghcr.io/modvolt/site-logbook-control-plane@sha256:<digest>
```

The image is source-pinned to run as non-root uid/gid `1000:1000`. Existing
root-owned `0700`/`0600` evidence must not be made world-readable and will not
be readable inside that container. As root on the host, create one **new**
dedicated custody directory for this approval, copy (never move) only the four
secret-free canonical inputs into it, and give only those copies to the fixed
container identity:

```sh
umask 077
mkdir /root/site-logbook-runtime-credential-<approval-id>
chown 1000:1000 /root/site-logbook-runtime-credential-<approval-id>
chmod 0700 /root/site-logbook-runtime-credential-<approval-id>
install -m 0600 -o 1000 -g 1000 /root/site-logbook-evidence/runtime-db-credential-request.json /root/site-logbook-runtime-credential-<approval-id>/runtime-db-credential-request.json
install -m 0600 -o 1000 -g 1000 /root/site-logbook-evidence/production-migration-plan.json /root/site-logbook-runtime-credential-<approval-id>/production-migration-plan.json
install -m 0600 -o 1000 -g 1000 /root/site-logbook-evidence/production-migration-role-transaction-receipt.json /root/site-logbook-runtime-credential-<approval-id>/production-migration-role-transaction-receipt.json
install -m 0600 -o 1000 -g 1000 /root/site-logbook-evidence/production-migration-role-postcommit-projection.json /root/site-logbook-runtime-credential-<approval-id>/production-migration-role-postcommit-projection.json
test ! -e /root/site-logbook-runtime-credential-<approval-id>/production-runtime-db-credential-cutover-receipt.json
```

Recompute the four copied files' SHA-256 digests and compare them to the
approved source custody record before continuing. The canonical request also
rechecks the three downstream evidence bindings. The env file is read by the
host Docker process; it is deliberately not bind-mounted into the container.

Invoke the one-shot bundle without any secret in argv. Keep the explicit
`--user 1000:1000`; do not solve a permission error by running the ceremony as
container root or weakening directory/file modes:

```sh
docker run --rm --network <exact-production-network> \
  --user 1000:1000 \
  --env-file /root/site-logbook-private/runtime-db-credential.env \
  --mount type=bind,src=/root/site-logbook-runtime-credential-<approval-id>,dst=/evidence \
  ghcr.io/modvolt/site-logbook-control-plane@sha256:<digest> \
  node /app/dist/production-runtime-db-credential-cutover.mjs \
  --request-file /evidence/runtime-db-credential-request.json \
  --migration-plan-file /evidence/production-migration-plan.json \
  --role-transaction-receipt-file /evidence/production-migration-role-transaction-receipt.json \
  --role-postcommit-file /evidence/production-migration-role-postcommit-projection.json \
  --receipt-out /evidence/production-runtime-db-credential-cutover-receipt.json \
  --confirm SET_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_AFTER_ROLE_SEPARATION
```

Before the first database connection the output path is exclusively reserved
as a mode-0600 file, file-fsynced and directory-fsynced. The PASS receipt is
written to that same inode and verified by exact stat, readback and SHA-256.
An empty or partial reserved file is an incomplete-attempt marker: preserve it
and stop for manual review; never delete it and retry blindly. Stdout contains
only the PASS decision and receipt digest. Preserve the dedicated custody
directory and env file until the later explicit Coolify transfer is confirmed,
then handle the transfer copy under the approved custody procedure; the
password manager remains the recovery source.

## Transaction and stop conditions

The attended administrator must be the session/current user, a superuser, and
different from both production roles. Inside one `SERIALIZABLE` transaction
the CLI takes the exact shared advisory transaction lock `911072468` and
verifies:

- the exact database;
- an existing, unprivileged, login-capable `site_logbook_runtime` with no
  credential yet;
- an existing `NOLOGIN` `site_logbook_migrator`;
- the full independent signed role-separation authority before any DB
  connection;
- under the same live transaction lock, an exact fresh projection of role
  memberships, database/schema/object/column/default ACLs, owners, settings and
  role flags equal to the approved post-commit projection, before `ALTER ROLE`.

Any known pre-commit failure rolls back. A rollback failure or ambiguous
`COMMIT` is a hard manual-review boundary: do not retry, rotate, transfer a
Coolify secret, or deploy. If commit succeeds but the fresh runtime login or
receipt persistence fails, the credential may already be active; preserve all
artifacts and perform an attended read-only investigation before any new
request. An existing receipt path is never overwritten.

## Explicit Coolify transfer and later deployment

Only after a canonical PASS receipt:

1. create/update the Coolify variable
   `PRODUCTION_RUNTIME_DATABASE_PASSWORD` with the same retained value;
   explicitly mark it **secret** in Coolify and never use a plain variable;
2. keep `POSTGRES_USER` and `POSTGRES_PASSWORD` only for PostgreSQL
   bootstrap/admin; never copy either value into the runtime secret;
3. verify the committed Compose source structurally uses literal
   `site_logbook_runtime`, the separate secret placeholder and literal
   `PRODUCTION_EXPECTED_DATABASE_USER=site_logbook_runtime`; do **not** run or
   capture ordinary resolved `docker compose config`, `docker inspect`, or any
   command that emits `DATABASE_URL`, because interpolation would disclose the
   credential. Prove the effective identity later through the secret-free
   startup/live database identity evidence instead;
4. regenerate target/steady/release/startup evidence with
   `databaseUser=site_logbook_runtime`; old admin-user evidence is
   intentionally rejected;
5. request the separate merge/deployment approval and then verify application
   readiness and worker behavior.

The credential receipt has `authorizesApplicationStart:false` and
`authorizesDeployment:false`. This procedure performs no S3 operation and
does not delete or overwrite any existing backup object.
