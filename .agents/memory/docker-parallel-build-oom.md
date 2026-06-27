---
name: Parallel docker compose build OOM on small hosts
description: Why a self-hosted (Coolify) deploy hangs/dies mid-build on a small box even though each build alone is light.
---

`docker compose up --build` builds the api + web images IN PARALLEL. Node (24)
auto-sizes its V8 old-space heap to the host's *total* RAM, so on a small box
(e.g. 2 vCPU / 4 GB) BOTH builds size their heaps to the whole machine at once
→ combined usage blows past RAM → kernel OOM-killer kills a build. Symptom: the
deploy "hangs" or dies mid-build, NOT a code error. Each build in isolation is
cheap (web vite/rollup build needs only ~1 GB, ~27 s).

**Why:** the trap is that the individual builds look fine when run one at a time;
the failure only appears under the parallel compose build on a memory-constrained
host.

**How to apply (host-side — the real fix, none of these live in the repo):**
- Give the build box enough RAM (an 8 GB host fits both parallel builds + the two
  pnpm installs comfortably — this is what the Stavba operator ultimately did).
- Or add swap (build spike is brief).
- Or serialize the builds with `COMPOSE_BAKE=false` + `COMPOSE_PARALLEL_LIMIT=1`
  (bake ignores PARALLEL_LIMIT; disabling bake restores the classic sequential
  builder).
- A Dockerfile `NODE_OPTIONS=--max-old-space-size` cap per build also bounds it,
  but was reverted here once the host had enough RAM (kept the Dockerfiles clean).
- Runtime memory is NOT the issue — both containers are small at rest.
