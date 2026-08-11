-- Empty-schema rollback only. Once any R13 accounting evidence exists, recovery
-- must roll forward so an immutable history cannot be erased by DDL rollback.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_document_versions LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_lifecycle_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_reason_artifacts LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_warehouse_price_observations LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_warehouse_price_projection_heads LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_payment_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_version_relations LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_export_outbox LIMIT 1) OR
     EXISTS (SELECT 1 FROM accounting_aggregate_heads LIMIT 1) THEN
    RAISE EXCEPTION '0106 rollback blocked: accounting evidence exists; use roll-forward recovery';
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
WHERE created_at = 1786459128910;

COMMIT;
