---
name: Job mutation cache invalidation
description: Which React Query keys to invalidate after any job mutation so the UI auto-refreshes
---

Any mutation that changes a job must invalidate THREE collection keys, not just
the job's own detail cache, or the UI shows stale data until the global
staleTime expires.

The keys:
- `getListJobsQueryKey()` — jobs list + calendar (calendar reuses the jobs list query)
- `getGetTodayJobsQueryKey()` — dashboard "today" job cards (separate endpoint, easy to forget)
- `getGetDashboardSummaryQueryKey()` — dashboard summary counters

**Why:** `App.tsx` sets a global `staleTime: 5 min` and `refetchOnWindowFocus: false`,
so navigating back to a list does NOT refetch. Job-detail handlers used
`setQueryData(getGetJobQueryKey(id), data)` which only updates the single detail
view — lists/dashboard stayed stale (delete left the row visible, status/timer
showed old values) for up to 5 minutes.

**How to apply:** job-detail.tsx has a module-level helper
`invalidateJobLists(queryClient)` covering all three keys. Call it in the
`onSuccess` of every job mutation (delete, status, timer start/stop,
preset/revert hours, and the inline field edits in InfoSection / CustomerSection /
WorkSummarySection / CostsSection). The dashboard-today key is the one most
likely to be missed.
