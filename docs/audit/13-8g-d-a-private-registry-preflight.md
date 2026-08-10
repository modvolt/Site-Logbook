# Private GHCR staging publisher runbook

Status: candidate publication control plane; no deployment or migration is authorized by this document.

This runbook covers the private caller in `modvolt/site-logbook-registry` and the reusable public workflow `.github/workflows/staging-images.yml` in `modvolt/Site-Logbook`. The publisher is deliberately split into two separately reviewed manual runs. A pull request, merge, Quality gate, or evidence download never deploys an image and never runs a database migration.

## Immutable inputs

Before either run, record and re-read live:

- `SOURCE_SHA`: exact head of public draft PR #15;
- `SOURCE_REF`: `agent/phase16c3-staging-preflight`;
- `SOURCE_PR_NUMBER`: `15`;
- `PRIVATE_MAIN`: exact private `main` commit containing the reviewed one-file caller;
- exact successful public `Quality gate` run and job for `SOURCE_SHA`;
- current private GHCR inventory and active publisher runs.

The public PR must remain open, draft and unmerged. `SOURCE_SHA` must be both the current source branch head and the exact successful pull-request Quality run head. The private workflow must execute from the live private `main` commit under the `modvolt` account.

The metadata credential is the repository secret `SITE_LOGBOOK_GHCR_METADATA_READ_TOKEN`. It is a distinct classic PAT owned by `modvolt` with exactly `read:packages`. The workflow `GITHUB_TOKEN` is used only for GHCR login and the separately approved write step.

## Fixed package order and state

The five state bits are ordered exactly as follows:

1. `site-logbook-staging-preflight`;
2. `site-logbook-staging-mailpit`;
3. `site-logbook-staging-api`;
4. `site-logbook-staging-web`;
5. `site-logbook-staging-alert-receiver`.

Only these transitions are valid:

| Stage            | Initial exact-SHA state | Decision                                  |
| ---------------- | ----------------------- | ----------------------------------------- |
| `preflight-only` | `00000`                 | publish only preflight                    |
| `preflight-only` | `10000`                 | verify existing preflight, no write       |
| `complete`       | `10000`                 | publish the remaining four in fixed order |
| `complete`       | `11111`                 | verify all five, no write                 |

Every other state is a hard stop. In particular, a partial state such as `11000` never triggers automatic recovery or overwrite.

## Required verification

For each present exact tag the reusable workflow must prove:

- one private package linked to `modvolt/site-logbook-registry`;
- a fully paginated active-version inventory whose length equals `version_count`;
- unique version IDs, digests and tags;
- one exact SHA tag, followed by a selected-version refetch with exactly that one tag;
- one OCI index with one `linux/amd64` runnable manifest and one linked attestation manifest;
- exact public source, revision and commit URL in runtime labels;
- the package-specific build SHA environment variable;
- pinned Buildx `v0.34.1` and BuildKit `v0.30.0` image digest;
- BuildKit provenance v0.2 bound to the public VCS revision, Dockerfile, build argument and the package-specific required subset of pinned base-image material digests;
- an SPDX 2.2 or 2.3 SBOM containing packages and a package-bound `CONTAINS` relationship.

The final verifier uses at most 36 attempts separated by five seconds and emits a non-secret diagnostic code. Exhaustion is failure, never implicit success.

## Stage 1: preflight-only

This stage requires a separate dispatch approval. Inputs are:

- `publication_stage`: `preflight-only`;
- `expected_preflight_digest`: empty;
- `confirm_registry_publication`: `true`;
- confirmation phrase: `PUBLISH_SITE_LOGBOOK_STAGING_PREFLIGHT_IMAGE_NO_DEPLOY`.

Only state `00000` may reach the one preflight push. Immediately before the push, the workflow re-reads the active inventory and requires the exact source tag to remain absent.

Download both files from artifact `preflight-publication-<SOURCE_SHA>`:

- `preflight-publication.json`;
- `preflight-publication.sha256`.

The JSON is schema version 2, kind `site-logbook-staging-preflight-publication`, and binds the source, private caller, run, pinned toolchain, immutable digest and rich package evidence. Verify the GNU checksum against the raw JSON bytes and separately approve the recorded preflight digest before stage 2.

## Stage 2: complete

This stage requires another separate dispatch approval. Inputs are:

- `publication_stage`: `complete`;
- `expected_preflight_digest`: exact approved `sha256:<64 hex>` from stage 1;
- `confirm_registry_publication`: `true`;
- confirmation phrase: `PUBLISH_REMAINING_SITE_LOGBOOK_STAGING_IMAGES_NO_DEPLOY`.

Only state `10000` may publish. Mailpit, API, web and alert receiver are processed sequentially. Each image has an immediate absence recheck, write, strict verification and durable partial-publication evidence before the next image can be written.

Download both files from artifact `staging-images-<SOURCE_SHA>`:

- `staging-images.json`;
- `staging-images.sha256`.

The JSON is schema version 2, kind `site-logbook-staging-images`, publication stage `complete`, and contains all five immutable digest references plus package-level inventory, runtime metadata, provenance and SBOM evidence. Validate it with `scripts/verify-staging-image-manifest.mjs` and a separately approved checksum before creating deployment inputs.

## Deleted-version limitation and current dispatch blocker

The exact-scope `read:packages` credential has not been able to read the deleted-version endpoint in the observed private-package recovery path. The workflow therefore does not claim a deleted-version inventory check. Every package evidence object says exactly:

- `deletedInventoryMode: not-queryable-exact-read-scope`;
- `visibleDeletedTagConflictChecked: false`;
- `deletedVersionCount: null`;
- `deletedHistoryScope: external-audit-ledger-only`.

This is an explicit residual limitation, not proof that deleted versions never existed. Before the first candidate write, one separately approved decision is still required: either prove the deleted endpoint through a no-write credential probe, approve a narrowly reviewed metadata-scope change, or explicitly accept the external audit ledger as the remaining control. Do not weaken the workflow silently and do not represent a 403/404 response as an empty deleted inventory.

## Approval boundaries

Each item below is independent and requires its own explicit authorization:

- merging or modifying the private caller;
- each workflow dispatch;
- each possible GHCR write stage;
- changing the metadata credential scope;
- provisioning or modifying Coolify staging;
- deployment;
- database migration, including `0105`; migration `0100` remains excluded.

No step in this runbook touches the existing production Coolify resource, production database, production S3 bucket, production DNS or `modvoltapp.cz`.
