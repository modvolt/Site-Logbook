WITH ranked_active AS (
  SELECT id,
         row_number() OVER (PARTITION BY document_id ORDER BY id DESC) AS active_rank
  FROM extraction_jobs
  WHERE status IN ('queued', 'running')
)
UPDATE extraction_jobs AS jobs
SET status = 'skipped',
    last_error = 'Nahrazeno novější aktivní úlohou při stabilizaci fronty.',
    finished_at = now(),
    updated_at = now()
FROM ranked_active
WHERE jobs.id = ranked_active.id
  AND ranked_active.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS extraction_jobs_one_active_per_document_idx
  ON extraction_jobs (document_id)
  WHERE status IN ('queued', 'running');
