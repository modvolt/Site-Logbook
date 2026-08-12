# Production DB role separation after exact 0107

Status: **contract-only, disabled and not applied**. This slice adds no role,
credential, Compose wiring, migration, production connection or startup hook.
It is bound to `0107_canonical_audit_evidence.sql` LF SHA-256
`c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122`.

The executable contract is
`lib/db/src/production-role-separation-contract.ts`. Its plan always records
`executionDefault: "disabled"`. The DI executor performs no query unless it
receives a separate activation object containing `enabled: true`, the exact
plan SHA-256, a lowercase bounded approval identifier and the exact canonical
approved pre-projection bytes plus their digest. The pre-projection is parsed,
secret-scanned, recursively validated and bound to the plan database/runtime/
migrator before `begin()` can run. Each executor instance can
make only one attempt. A failed post-projection validation rolls the
transaction back and emits no success receipt. A commit error is reported as
`ROLE_SEPARATION_COMMIT_OUTCOME_UNKNOWN`; rollback is never attempted after
commit begins because the server-side outcome could already be committed.

## Exact allowlist

The manifest is checked against every committed migration from 0000 through
0107 by a hermetic test. At this snapshot it contains:

- 117 application tables in `public` plus read-only
  `drizzle.__drizzle_migrations`;
- 94 application sequences, with runtime `USAGE` only where the runtime has
  table `INSERT`; the Drizzle journal sequence and sequences of runtime
  non-insertable tables are owner-controlled with no runtime grant;
- 29 application functions with runtime `EXECUTE`, no `PUBLIC EXECUTE`, and a
  required `SECURITY INVOKER` projection.

Mutable application tables use an explicit compatibility envelope of
`SELECT, INSERT, UPDATE, DELETE`. Append-only evidence tables have only
`SELECT, INSERT`. Heads, transition-controlled records and outboxes have only
`SELECT, INSERT, UPDATE`. No table grants `TRUNCATE`, `REFERENCES` or `TRIGGER`.
This is an exact snapshot allowlist, not a claim that every allowed mutable
table operation is reached by every API endpoint.

The compatibility checks explicitly retain `UPDATE` for
`document_linking_settings` and `warehouse_price_history`, whose runtime
callsites use `INSERT ... ON CONFLICT DO UPDATE`. A table with an empty grant
set is omitted from generated `GRANT` statements, so the plan never emits an
invalid empty privilege list.

Future objects remain default-dark: for objects created by the migrator in
`public` or `drizzle`, default privileges grant neither `PUBLIC` nor the
runtime role anything. Adding a later migration therefore requires an
intentional manifest revision before runtime can use its new objects.

## Fail-closed projection

The read-only projection covers effective database, schema and object ACLs,
database/schema/object ownership, both role attribute sets, membership in both
directions, per-role and per-database settings, every non-system schema,
column ACLs, third-role direct grants, default ACLs and function
`SECURITY DEFINER` plus `proconfig` state. Its host-side input is recursively
exact-shape validated. Validation rejects:

- runtime equal to the migrator/owner or owning any contracted object;
- runtime `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`;
- a login-capable or privileged migrator/owner role;
- any runtime role membership, including membership that permits `SET ROLE`;
- any role that can `SET ROLE` to the runtime or migrator;
- runtime or `PUBLIC` database `CREATE`/`TEMPORARY`, any third-role database
  ACL, or a database owner other than the migrator;
- `PUBLIC CREATE` or runtime `CREATE` on either schema;
- any extra non-system schema, third-role schema/object/default ACL, or column
  ACL;
- a missing table, sequence or function, a missing required grant, any extra
  grant, any `PUBLIC` object grant, or an extra projected object;
- a runtime-executable contracted function changed to `SECURITY DEFINER` or
  without fixed `search_path=pg_catalog, public, pg_temp`;
- runtime role settings other than the same exact database-scoped safe
  `search_path`;
- non-dark default privileges for later tables, sequences or functions.

The plan first removes membership edges and direct ACLs for unexpected roles,
including column ACLs, then recreates the exact allowlist. Runtime and all
contracted functions receive the fixed safe search path. Database privileges
are exactly `CONNECT` for `PUBLIC` and runtime; neither receives database
`CREATE` or `TEMPORARY`.

`PRODUCTION_ROLE_PROJECTION_SQL` is read-only and parameterized by database,
runtime-role and migrator-role names. Its normalized JSON payload still needs
strict host-side assembly into `ProductionRoleProjection`; this slice does not
wire that host adapter or expose the SQL as an application route.

Every canonical role plan, projection, receipt and approval artifact is limited
to 512 KiB. Recursive secret-shaped key/value scanning rejects credentials,
private keys, tokens and credential-bearing URIs. Evidence identifiers and
SHA-256 values must already be canonical lowercase; validators do not normalize
uppercase input.

The transaction receipt is deliberately not an authorization or independent
production proof. It records `authorizesDeployment: false`,
`postCommitVerification: "unavailable"` and a null verifier artifact. Its
SHA-256 detects accidental receipt mutation only. The distinct
`site-logbook.production-db-role-separation-postcommit/v1` parser accepts a
canonical read-only post-commit projection only when it is bound to the exact
plan, transaction receipt, full projection digest, lowercase verifier identity
and later timestamp, passes the full recursive ACL validator, and retains
`authorizesDeployment=false`. It must be captured by an independently
authenticated verifier and retained before any connection-secret or deployment
change.

## Required external ceremony

The following remains deliberately outside this repository slice:

1. Reconcile the two production-only opaque migration journal rows. Any extra
   live object is projected and causes fail-closed validation until reviewed.
2. Choose stable role names. Create a dedicated `NOLOGIN`, non-superuser owner
   role and a separate login runtime role. Store the runtime credential only in
   the approved production secret store, never in Git, an image, evidence or a
   generated plan/receipt.
3. Decide which audited administrator may create the roles and transfer the
   production database ownership. The contract can plan the transfer, but the
   owner role and its custody are still an external privileged ceremony.
4. Capture the read-only pre-projection, review the deterministic plan and its
   SHA-256, then issue a distinct activation approval bound to that hash.
5. Run the one-shot transaction through an audited adapter. The in-transaction
   post-projection is exactly bound to the plan database/runtime/migrator and
   all receipt material is validated before commit. Persist its non-authorizing
   receipt, then capture and hash a separate canonical read-only post-commit
   projection before changing the API connection secret. Treat a commit
   outcome-unknown error as an investigation boundary, never as permission to
   retry blindly.
6. Deploy the API with the runtime credential, verify startup/readiness and
   worker behavior, then retain a separately usable migrator ceremony for later
   migrations. The runtime API must never run migrations.

No step above has been performed by this contract-only change.
