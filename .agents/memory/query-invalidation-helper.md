---
name: Shared query-invalidation helper
description: One documented place for cross-screen auto-refresh in stavba — domain→URL-prefix map + invalidateData()
---

`artifacts/stavba/src/lib/query-invalidation.ts` is the single source of truth
for cross-screen cache invalidation. Call `invalidateData(queryClient, ...domains)`
in mutation `onSuccess` handlers instead of hand-listing generated query keys.

**Why a path-PREFIX predicate, not exact keys:** generated React Query keys are
`[urlPath, ...params]` (e.g. `["/api/jobs"]`, `["/api/jobs/5"]`,
`["/api/jobs/5/materials"]`). React Query compares keys element-wise, so
invalidating `["/api/jobs"]` does NOT hit `/api/jobs/5/materials`. The helper
instead invalidates any query whose `queryKey[0]` equals a prefix or starts with
`prefix + "/"`, so one domain hit refreshes list + detail + every sub-list.

**Why domains over raw keys:** ad-hoc per-page invalidations were incomplete
(e.g. job edits left the dashboard "today" cards and stats stale) and some used
WRONG paths (`["/activities"]` instead of `/api/activities` — a no-op). Centralizing
the domain→prefix map and the cross-domain cascades fixes both.

**How to apply:**
- Pick domains from the `InvalidationDomain` union. If none fit, add a new domain +
  its URL prefixes IN THIS FILE — keep it the only place query relationships live.
- Cross-domain effects belong in `DOMAIN_RELATED` cascades (e.g. `bankImport →
  billingInvoices`, `emailImport`/`reviewQueue → billingDocuments`).
- Material mutations touch the warehouse ledger, so job/activity material writes
  pass both domains: `invalidateData(qc, "jobs", "warehouse")`.
- Approving a cost document propagates into job materials + warehouse, so
  document/queue approve handlers add `"jobs", "warehouse"`.
- Issuing/storno an invoice changes which jobs are billed, so invoice-detail
  `invalidateAll` adds `"jobs"`; draft create/edit/delete do NOT (no billing yet).

**Leave page-LOCAL invalidations alone:** job-detail tasks/attachments, activity
sub-lists, admin/settings singletons (users, backups, email/SMTP, security
questions, audit log), and the dashboard pull-to-refresh blanket
`invalidateQueries()` are intentionally targeted/local — routing them through a
domain would over-refetch dashboard/stats on every checkbox.

**Global config (App.tsx QueryClient):** `refetchOnWindowFocus: true`,
`refetchOnReconnect: true`, `staleTime: 30s`, NO polling. Refocus/reconnect give
free passive refresh; `invalidateData` is the active push after a mutation.
