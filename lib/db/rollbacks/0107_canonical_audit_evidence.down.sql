-- Empty-genesis rollback only. ACCESS EXCLUSIVE locks are acquired in the
-- same head-first order as the writer before the guard, closing the guard/removal
-- race. Once canonical evidence exists, recovery must roll forward.
-- The forward REVOKE CREATE ON SCHEMA public FROM PUBLIC is intentionally
-- sticky: the previous ACL is unknowable and rollback must not regrant it.
BEGIN;
SET LOCAL search_path = pg_catalog;

-- Serialize with the forward runner's migration namespace before taking the
-- table locks. This prevents rollback from racing a concurrent migration run.
SELECT pg_catalog.pg_advisory_xact_lock(911072468);

LOCK TABLE public.audit_chain_heads, public.audit_events, public.audit_export_outbox,
  drizzle.__drizzle_migrations
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_events LIMIT 1) OR
     EXISTS (SELECT 1 FROM public.audit_export_outbox LIMIT 1) OR
     (SELECT count(*) FROM public.audit_chain_heads) <> 1 OR
     (
       SELECT count(*) FROM drizzle.__drizzle_migrations
       WHERE created_at = 1786484628859
         AND hash = 'c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122'
     ) <> 1 OR
     EXISTS (
       SELECT 1 FROM drizzle.__drizzle_migrations
       WHERE created_at = 1786484628859
         AND hash <> 'c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122'
     ) OR
     NOT EXISTS (
       SELECT 1 FROM public.audit_chain_heads
       WHERE stream_id = 'site-logbook:audit:global:v1'
         AND sequence = 0
         AND ledger_sha256 IS NULL
     ) THEN
    RAISE EXCEPTION '0107 rollback blocked: canonical audit evidence or a non-genesis head exists; use roll-forward recovery';
  END IF;
END;
$$;

DROP TRIGGER "audit_events_commit_binding_trg" ON public.audit_events;
DROP TRIGGER "audit_export_outbox_guard_trg" ON public.audit_export_outbox;
DROP TRIGGER "audit_chain_heads_guard_trg" ON public.audit_chain_heads;
DROP TRIGGER "audit_events_immutable_trg" ON public.audit_events;
DROP TRIGGER "audit_events_insert_guard_trg" ON public.audit_events;

DROP FUNCTION public.guard_audit_event_commit_binding();
DROP FUNCTION public.guard_audit_export_outbox_transition();
DROP FUNCTION public.guard_audit_chain_head_transition();
DROP FUNCTION public.deny_audit_event_mutation();
DROP FUNCTION public.guard_audit_event_insert();
DROP FUNCTION public.audit_event_core_semantics_are_valid(jsonb);
DROP FUNCTION public.audit_export_intent_json_is_valid(jsonb);
DROP FUNCTION public.audit_ledger_json_is_valid(jsonb);
DROP FUNCTION public.audit_event_json_is_valid(jsonb);
DROP FUNCTION public.audit_state_json_is_valid(jsonb);
DROP FUNCTION public.audit_domain_sha256(text, text);
DROP FUNCTION public.audit_canonical_json(jsonb);
DROP FUNCTION public.audit_json_is_safe_integer(jsonb, numeric, numeric);
DROP FUNCTION public.audit_json_is_string_or_null(jsonb);
DROP FUNCTION public.audit_json_is_sha256(jsonb);
DROP FUNCTION public.audit_json_has_exact_keys(jsonb, text[]);

DROP TABLE public.audit_export_outbox;
DROP TABLE public.audit_chain_heads;
DROP TABLE public.audit_events;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786484628859
  AND hash = 'c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122';

COMMIT;
