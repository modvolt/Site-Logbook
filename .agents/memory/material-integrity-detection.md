---
name: Material integrity (stale price / duplicate) detection
description: Where the stale-priced / duplicate job-material detection rules live and how they're covered by tests.
---

# Material integrity detection (stale price / duplicate materials)

The detection rules for stale-priced and duplicate job materials (caused by the
pre-fix pricing bug around invoice-line edits / bulk-confirm / "Aktualizovat
ceny" skipping re-propagation) live in
`artifacts/api-server/src/lib/material-integrity.ts`
(`detectStaleAndDuplicateMaterials()`), NOT inline in the CLI script anymore.

`scripts/cleanup-duplicate-materials.ts` is now a thin CLI wrapper: it calls
the detector for the report, then (only under `--apply`) re-runs the real
`revertInvoicePricePropagation -> propagateInvoicePricesToJobMaterials ->
syncJobMaterialsForDocument` pipeline for affected approved documents.

**Why:** the detection logic was previously only exercised manually with
hand-inserted synthetic rows that were deleted afterward — no test caught a
regression in the propagation pipeline reintroducing stale prices/duplicates.
It is now covered by `test/material-integrity.test.ts` (DB-backed), which also
asserts the real pipeline resolves a seeded stale case.

**How to apply:** if you touch the propagation/sync pipeline in
`cost-document-service.ts` or `warehouse-service.ts`, run
`test/material-integrity.test.ts` — it will catch if a stale/duplicate case
stops being detected or starts appearing where it shouldn't. When adding a new
stale-material failure mode, extend the detector module (not the script) so
both the CLI and future tests stay in sync.
