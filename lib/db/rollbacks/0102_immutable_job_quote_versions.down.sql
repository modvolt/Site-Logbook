BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_document_versions)
     OR EXISTS (SELECT 1 FROM quote_versions)
     OR EXISTS (SELECT 1 FROM job_signature_events)
     OR EXISTS (SELECT 1 FROM quote_decision_events)
     OR EXISTS (
       SELECT 1 FROM public_access_tokens
       WHERE artifact_binding_status = 'bound'
          OR job_document_version_id IS NOT NULL
          OR quote_version_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION
      '0102 rollback blocked: immutable versions, evidence events, or bound public tokens exist; use roll-forward recovery';
  END IF;
END;
$$;

ALTER TABLE public_access_tokens DROP CONSTRAINT IF EXISTS public_access_tokens_artifact_binding_chk;
DROP INDEX IF EXISTS public_access_tokens_job_version_idx;
DROP INDEX IF EXISTS public_access_tokens_quote_version_idx;
ALTER TABLE public_access_tokens DROP CONSTRAINT IF EXISTS public_access_tokens_job_document_version_id_job_document_versions_id_fk;
ALTER TABLE public_access_tokens DROP CONSTRAINT IF EXISTS public_access_tokens_quote_version_id_quote_versions_id_fk;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS artifact_binding_status;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS job_document_version_id;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS quote_version_id;

DROP TRIGGER IF EXISTS quote_decision_events_immutable_trg ON quote_decision_events;
DROP TRIGGER IF EXISTS quote_versions_immutable_trg ON quote_versions;
DROP TRIGGER IF EXISTS job_signature_events_immutable_trg ON job_signature_events;
DROP TRIGGER IF EXISTS job_document_versions_immutable_trg ON job_document_versions;
DROP FUNCTION IF EXISTS deny_immutable_evidence_mutation();
DROP FUNCTION IF EXISTS guard_job_document_version_transition();

DROP TABLE IF EXISTS quote_decision_events;
DROP TABLE IF EXISTS job_signature_events;
DROP TABLE IF EXISTS quote_versions;
DROP TABLE IF EXISTS job_document_versions;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383364000;

COMMIT;
