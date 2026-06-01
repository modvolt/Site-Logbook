---
name: Coolify stale Docker build cache
description: Coolify can deploy a stale image (all layers CACHED) so source/code fixes never actually run, even when the commit sha is correct
---

Symptom: a code fix is committed, GitHub has it, Coolify's deploy log shows the
correct commit sha being imported — yet the bug persists unchanged after redeploy.

Tell-tale sign in the Coolify/BuildKit deploy log: the **entire image build
finishes in ~1 second with every step marked `CACHED`**, including
`COPY artifacts ./artifacts` and `RUN pnpm ... build`. No `pnpm install` / build
output, no compile time. That means BuildKit reused a previous image and the new
source was never compiled into `dist`, so the running container is old code.

Even though `.dockerignore` does NOT exclude source (so `COPY` *should* bust the
cache on any file change), Coolify's persistent BuildKit cache can still serve a
stale layer.

**Fixes / how to apply:**
- Easiest: in Coolify trigger **Redeploy with "Force rebuild" / no-cache** so
  layers are rebuilt from scratch.
- To verify which code is actually live, log a secret-free startup diagnostic
  (e.g. `describeObjectStorageConfig()` logged on boot) that includes a marker
  string tied to the new build; if the marker is missing from the api logs after
  deploy, the image is stale.
- Never trust "commit sha matches" alone — confirm the build actually recompiled
  (non-cached `RUN build` with real output) or that the startup marker is present.
