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

Each stage also requires a newly reviewed private-main caller commit. That commit must hard-code the exact canonical `registry_ledger_json` and the exact `registry_history_acceptance` value `ACCEPT_EXTERNAL_LEDGER_RESIDUAL_WITHOUT_DELETED_HISTORY_PROOF_NO_DEPLOY`. The reusable workflow refuses retries (`run_attempt` must be `1`) and refuses a second _visible_ dispatch for the same caller commit after reading the current workflow history. It fails closed at GitHub's 1,000-run API cap instead of claiming complete pagination. A failed or partial run therefore needs a new reviewed caller commit; rerunning the old run is not a recovery mechanism.

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
- `registry_history_acceptance`: the exact reviewed residual-acceptance phrase above;
- `registry_ledger_json`: canonical, whitespace-free JSON committed in the private caller, with stage `preflight-only`, state `00000`, all five exact package names and a null `previousEntry`;
- confirmation phrase: `PUBLISH_SITE_LOGBOOK_STAGING_PREFLIGHT_IMAGE_NO_DEPLOY`.

Only state `00000` may reach the one preflight push. Immediately before the push, the workflow re-reads the active inventory and requires the exact source tag to remain absent.

Download all three flat files from artifact `preflight-publication-<SOURCE_SHA>`:

- `preflight-publication.json`;
- `preflight-publication.sha256`;
- `staging-registry-ledger-entry.json`.

The publication JSON is schema version 3, kind `site-logbook-staging-preflight-publication`, and embeds the reviewed canonical ledger. It binds the source, private caller, first attempt, current visible-run uniqueness check, exact ledger checksum, pinned toolchain, immutable digest and rich package evidence. Verify the GNU checksum against the raw JSON bytes, verify the embedded ledger checksum and the separately uploaded canonical ledger bytes, then separately approve the recorded preflight digest before stage 2.

## Stage 2: complete

This stage requires another separate dispatch approval. Inputs are:

- `publication_stage`: `complete`;
- `expected_preflight_digest`: exact approved `sha256:<64 hex>` from stage 1;
- `confirm_registry_publication`: `true`;
- `registry_history_acceptance`: the exact reviewed residual-acceptance phrase above;
- `registry_ledger_json`: a new canonical entry committed in a new private-main caller commit, with stage `complete`, state `10000`, the stage-1 ledger checksum and the exact approved preflight digest in `previousEntry`;
- confirmation phrase: `PUBLISH_REMAINING_SITE_LOGBOOK_STAGING_IMAGES_NO_DEPLOY`.

Only state `10000` may publish. Mailpit, API, web and alert receiver are processed sequentially. Each image has an immediate absence recheck, write, strict verification and durable partial-publication evidence before the next image can be written.

Download all three flat files from artifact `staging-images-<SOURCE_SHA>`:

- `staging-images.json`;
- `staging-images.sha256`;
- `staging-registry-ledger-entry.json`.

The publication JSON is schema version 3, kind `site-logbook-staging-images`, publication stage `complete`, and contains all five immutable digest references plus the embedded reviewed visible-history ledger control, package-level inventory, runtime metadata, provenance and SBOM evidence. Validate it with `scripts/verify-staging-image-manifest.mjs`, a separately approved checksum and `--expected-caller-workflow-sha <PRIVATE_MAIN>` before creating deployment inputs.

## Deleted-version limitation and deny-by-default dispatch blocker

The exact-scope `read:packages` credential has not been able to read the deleted-version endpoint in the observed private-package recovery path. The workflow therefore does not claim a deleted-version inventory check. Every package evidence object says exactly:

- `deletedInventoryMode: not-queryable-exact-read-scope`;
- `visibleDeletedTagConflictChecked: false`;
- `deletedVersionCount: null`;
- `deletedHistoryScope: external-audit-ledger-only`.

This is an explicit residual limitation, not proof that deleted versions never existed and not protection against an owner publishing outside this workflow. GitHub Actions runs can also be deleted, so the visible-run uniqueness check is a point-in-time control, not an append-only run ledger. The schema-v3 reviewed caller ledger is deny-by-default infrastructure: it makes the accepted decision, exact stage, expected live state, prior ledger checksum, preflight digest, caller commit and current visible run auditable, but it does not turn either residual limitation into historical proof.

Before the first candidate write, the user must still separately and explicitly accept this residual trust model. Until that decision and a fresh public push/Quality gate exist, dispatch remains `NO-GO`. Private draft PR #8 predates the new caller interface and must not be merged or dispatched as-is; it needs a separately reviewed one-file update after the final public workflow commit is reachable.

That private caller update must grant the calling job exactly `actions: read`, `contents: read` and `packages: write`. Reusable workflows can only preserve or reduce caller token permissions, so the public called job cannot add the Actions-history permission if the private caller omitted it. The same one-file update must hard-code both new ledger inputs; it must not add another secret or deployment permission.

Do not weaken the workflow silently, widen the metadata credential, or represent a 403/404 response, deleted Actions history, or the reviewed ledger as an empty deleted inventory.

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
