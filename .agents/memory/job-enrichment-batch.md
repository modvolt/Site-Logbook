---
name: Batch job enrichment
description: Job list endpoints must use the batch enrichJobs() — per-job enrichment was the N+1 that made the zakázky menu lag.
---

Job list endpoints (`GET /api/jobs`, `GET /api/dashboard/today`) enrich rows via a single batch `enrichJobs(jobs[])` (exported from the jobs router) that runs a fixed set of grouped queries (`groupBy jobId + inArray`; customers/people via `inArray` of distinct ids). The single-job `enrichJob` is just batch-of-one.

**Why:** The old per-job `enrichJob` fired ~6 sequential queries per job — hundreds of jobs → thousands of queries, making the zakázky menu lag in prod. A duplicate copy in the dashboard router also leaked `signatureToken` via a raw row spread.

**How to apply:**
- Any new endpoint returning multiple enriched jobs must call `enrichJobs(jobs)`, never `Promise.all(jobs.map(enrichJob))`.
- New per-job derived fields go into `enrichJobs` as another grouped query, keyed by jobId in a Map.
- `enrichJobs` is the single place that strips `signatureToken`; never spread a raw job row in a response elsewhere.
- Supporting FK indexes (tasks/attachments/materials `job_id`) exist — keep new per-job aggregate tables indexed on `job_id` too.
