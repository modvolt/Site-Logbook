---
name: Job mutation cache invalidation
description: Which React Query keys to invalidate after any job mutation so the UI auto-refreshes
---

Any mutation that changes a job must refresh the jobs list, calendar, dashboard
"today" cards, dashboard summary AND stats — not just the job's own detail cache,
or the UI shows stale data.

**Use the shared helper now:** call `invalidateData(queryClient, "jobs")` (from
`@/lib/query-invalidation`) — the `"jobs"` domain prefix-invalidates `/api/jobs`,
`/api/dashboard`, `/api/me/stats`, `/api/me/jobs`, `/api/stats/overview` in one
shot. See `query-invalidation-helper.md` for the full domain map. Do NOT hand-list
`getListJobsQueryKey()` / `getGetTodayJobsQueryKey()` / `getGetDashboardSummaryQueryKey()`
anymore — that pattern repeatedly missed the today-jobs key.

**Why:** `App.tsx` sets a global `staleTime` and detail handlers used
`setQueryData(getGetJobQueryKey(id), data)` which only updates the single detail
view, so lists/dashboard stayed stale (delete left the row visible, status/timer
showed old values).

**How to apply:** job-detail.tsx still exposes `invalidateJobLists(queryClient)`,
now a thin wrapper over `invalidateData(qc, "jobs")`. Call it in `onSuccess` of
every job mutation. Material writes also touch the warehouse, so use
`invalidateData(qc, "jobs", "warehouse")` there.
