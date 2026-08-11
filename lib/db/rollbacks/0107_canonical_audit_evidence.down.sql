-- Empty-genesis rollback only. ACCESS EXCLUSIVE locks are acquired in the
-- same head-first order as the writer before the guard, closing the guard/removal
-- race. Once canonical evidence exists, recovery must roll forward.
BEGIN;

-- Serialize with the forward runner's migration namespace before taking the
-- table locks. This prevents rollback from racing a concurrent migration run.
SELECT pg_advisory_xact_lock(911072468);

LOCK TABLE audit_chain_heads, audit_events, audit_export_outbox
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM audit_export_outbox LIMIT 1) OR
     (SELECT count(*) FROM audit_chain_heads) <> 1 OR
     (
       SELECT count(*) FROM drizzle.__drizzle_migrations
       WHERE created_at = 1786484628859
         AND hash = '5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339'
     ) <> 1 OR
     EXISTS (
       SELECT 1 FROM drizzle.__drizzle_migrations
       WHERE created_at = 1786484628859
         AND hash <> '5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339'
     ) OR
     NOT EXISTS (
       SELECT 1 FROM audit_chain_heads
       WHERE stream_id = 'site-logbook:audit:global:v1'
         AND sequence = 0
         AND ledger_sha256 IS NULL
     ) THEN
    RAISE EXCEPTION '0107 rollback blocked: canonical audit evidence or a non-genesis head exists; use roll-forward recovery';
  END IF;
END;
$$;

DROP TRIGGER "audit_events_commit_binding_trg" ON audit_events;
DROP TRIGGER "audit_export_outbox_guard_trg" ON audit_export_outbox;
DROP TRIGGER "audit_chain_heads_guard_trg" ON audit_chain_heads;
DROP TRIGGER "audit_events_immutable_trg" ON audit_events;
DROP TRIGGER "audit_events_insert_guard_trg" ON audit_events;

DROP FUNCTION guard_audit_event_commit_binding();
DROP FUNCTION guard_audit_export_outbox_transition();
DROP FUNCTION guard_audit_chain_head_transition();
DROP FUNCTION deny_audit_event_mutation();
DROP FUNCTION guard_audit_event_insert();
DROP FUNCTION audit_event_core_semantics_are_valid(jsonb);
DROP FUNCTION audit_export_intent_json_is_valid(jsonb);
DROP FUNCTION audit_ledger_json_is_valid(jsonb);
DROP FUNCTION audit_event_json_is_valid(jsonb);
DROP FUNCTION audit_state_json_is_valid(jsonb);
DROP FUNCTION audit_domain_sha256(text, text);
DROP FUNCTION audit_canonical_json(jsonb);
DROP FUNCTION audit_json_is_safe_integer(jsonb, numeric, numeric);
DROP FUNCTION audit_json_is_string_or_null(jsonb);
DROP FUNCTION audit_json_is_sha256(jsonb);
DROP FUNCTION audit_json_has_exact_keys(jsonb, text[]);

DROP TABLE audit_export_outbox;
DROP TABLE audit_chain_heads;
DROP TABLE audit_events;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786484628859
  AND hash = '5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339';

COMMIT;
