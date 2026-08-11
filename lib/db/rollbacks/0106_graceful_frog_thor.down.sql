-- Empty-schema rollback only. Once any R13 accounting evidence exists, recovery
-- must roll forward so an immutable history cannot be erased by DDL rollback.
BEGIN;

-- Serialize with the forward runner and block concurrent evidence writers before
-- checking the empty-schema precondition. The exact 0106 row must also remain
-- the migration tail; rolling 0106 back from underneath 0107 would corrupt the
-- journal and schema lineage.
SELECT pg_advisory_xact_lock(911072468);

LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE;

LOCK TABLE accounting_aggregate_heads,
  accounting_warehouse_price_projection_heads,
  accounting_reason_artifacts,
  accounting_warehouse_price_observations,
  accounting_version_relations,
  accounting_payment_events,
  accounting_lifecycle_events,
  accounting_export_outbox,
  accounting_document_versions
IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  exact_migration_id integer;
BEGIN
  IF (
    SELECT count(*)
    FROM drizzle.__drizzle_migrations
    WHERE created_at = 1786459128910
      AND hash = '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd'
  ) <> 1 THEN
    RAISE EXCEPTION '0106 rollback blocked: a later migration or accounting evidence exists; use roll-forward recovery';
  END IF;

  SELECT id
  INTO STRICT exact_migration_id
  FROM drizzle.__drizzle_migrations
  WHERE created_at = 1786459128910
    AND hash = '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd';

  IF EXISTS (
       SELECT 1
       FROM drizzle.__drizzle_migrations later
       WHERE later.id > exact_migration_id
     ) OR
     EXISTS (
       SELECT 1
       FROM drizzle.__drizzle_migrations later
       WHERE later.created_at >= 1786459128910
         AND NOT (
           later.id = exact_migration_id
           AND later.created_at = 1786459128910
           AND later.hash = '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd'
         )
     ) OR
     EXISTS (SELECT 1 FROM accounting_document_versions LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_lifecycle_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_reason_artifacts LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_warehouse_price_observations LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_warehouse_price_projection_heads LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_payment_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_version_relations LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_export_outbox LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_aggregate_heads LIMIT 1) THEN
    RAISE EXCEPTION '0106 rollback blocked: a later migration or accounting evidence exists; use roll-forward recovery';
  END IF;
END;
$$;

DROP TABLE accounting_aggregate_heads;
DROP TABLE accounting_warehouse_price_projection_heads;
DROP TABLE accounting_reason_artifacts;
DROP TABLE accounting_warehouse_price_observations;
DROP TABLE accounting_version_relations;
DROP TABLE accounting_payment_events;
DROP TABLE accounting_lifecycle_events;
DROP TABLE accounting_export_outbox;
DROP TABLE accounting_document_versions;

DROP FUNCTION guard_accounting_aggregate_head_transition();
DROP FUNCTION guard_accounting_warehouse_price_projection_head();
DROP FUNCTION guard_accounting_outbox_transition();
DROP FUNCTION guard_accounting_evidence_insert_binding();
DROP FUNCTION deny_accounting_evidence_mutation();

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786459128910
  AND hash = '697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd';

COMMIT;
