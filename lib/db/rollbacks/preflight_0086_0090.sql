-- Read-only preflight for the workflow rollback chain 0086-0090.
--
-- Run while the application is in maintenance mode. A non-zero blocker_count
-- means the related destructive DOWN migration must not be executed. This
-- script never changes production data or the Drizzle journal.

SELECT check_name, blocker_count, blocks_rollback
FROM (
  SELECT
    'migration_journal_missing'::text AS check_name,
    (
      SELECT count(*)::bigint
      FROM (
        VALUES
          (1783979822106::bigint),
          (1783981467968::bigint),
          (1783984064694::bigint),
          (1783986815471::bigint),
          (1783988026596::bigint)
      ) AS expected(created_at)
      LEFT JOIN drizzle.__drizzle_migrations AS applied
        ON applied.created_at = expected.created_at
      WHERE applied.created_at IS NULL
    ) AS blocker_count,
    'All five journal rows must exist before starting a full reverse rollback.'::text
      AS blocks_rollback

  UNION ALL

  SELECT
    '0090_quote_invoice_history',
    (SELECT count(*)::bigint FROM quote_invoice_links),
    'Blocks 0090 DOWN. Keep the additive table when any billing history exists.'

  UNION ALL

  SELECT
    '0089_quote_group_links',
    (
      SELECT count(*)::bigint
      FROM quotes
      WHERE converted_to_job_group_id IS NOT NULL
    ),
    'Blocks 0089 DOWN. Existing quote-to-action lineage must not be erased.'

  UNION ALL

  SELECT
    '0088_visit_specific_times',
    (
      SELECT count(*)::bigint
      FROM job_visits
      WHERE start_time IS NOT NULL OR end_time IS NOT NULL
    ),
    'Blocks 0088 DOWN. Application rollback may keep these additive columns.'

  UNION ALL

  SELECT
    '0087_planned_materials',
    (
      SELECT count(*)::bigint
      FROM materials
      WHERE done = false
    ),
    'Blocks rollback to pre-0087 behavior; old code would treat these rows as consumed.'

  UNION ALL

  SELECT
    '0087_nonlegacy_consumption_audit',
    (
      SELECT count(*)::bigint
      FROM materials
      WHERE consumed_by_user_id IS NOT NULL
         OR (
           consumed_at IS NOT NULL
           AND consumed_at IS DISTINCT FROM created_at
         )
    ),
    'Blocks 0087 DOWN. Actual consumption actor or time cannot be reconstructed after dropping the audit columns.'

  UNION ALL

  SELECT
    '0086_archived_jobs',
    (
      SELECT count(*)::bigint
      FROM jobs
      WHERE archived_at IS NOT NULL
         OR archived_by_user_id IS NOT NULL
         OR status_before_archive IS NOT NULL
    ),
    'Blocks 0086 DOWN. Restore through the application before removing archive metadata.'
) AS checks
ORDER BY check_name;
