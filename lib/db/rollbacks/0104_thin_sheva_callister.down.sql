-- Application rollback is preferred. Once R16-B ownership or evidence data is
-- written, reverse migration would destroy security provenance and is blocked.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public_access_tokens
    WHERE ppe_evidence_version_id IS NOT NULL
       OR owner_kind IS NOT NULL
       OR owner_user_id IS NOT NULL
       OR owner_assigned_at IS NOT NULL
       OR owner_assignment_source IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM ppe_public_evidence_versions
  ) OR EXISTS (
    SELECT 1 FROM ppe_public_evidence_events
  ) OR EXISTS (
    SELECT 1
    FROM switchboards
    WHERE qr_owner_kind IS NOT NULL
       OR qr_owner_user_id IS NOT NULL
       OR qr_owner_assigned_at IS NOT NULL
       OR qr_owner_assignment_source IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '0104 rollback blocked: external grant ownership or immutable PPE evidence exists; use roll-forward recovery';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS ppe_public_evidence_events_immutable
  ON ppe_public_evidence_events;
DROP TRIGGER IF EXISTS ppe_public_evidence_events_binding
  ON ppe_public_evidence_events;
DROP TRIGGER IF EXISTS ppe_public_evidence_versions_immutable
  ON ppe_public_evidence_versions;
DROP FUNCTION IF EXISTS validate_ppe_public_evidence_event_binding();

ALTER TABLE public_access_tokens
  DROP CONSTRAINT IF EXISTS public_access_tokens_consume_action_chk;
ALTER TABLE public_access_tokens
  DROP CONSTRAINT IF EXISTS public_access_tokens_artifact_binding_chk;
ALTER TABLE public_access_tokens
  DROP CONSTRAINT IF EXISTS public_access_tokens_owner_assignment_chk;
ALTER TABLE switchboards
  DROP CONSTRAINT IF EXISTS switchboards_qr_owner_assignment_chk;

DROP INDEX IF EXISTS switchboards_qr_enabled_owner_idx;
DROP INDEX IF EXISTS public_access_tokens_ppe_evidence_version_idx;
DROP INDEX IF EXISTS public_access_tokens_active_owner_idx;

ALTER TABLE public_access_tokens
  DROP CONSTRAINT IF EXISTS public_access_tokens_ppe_evidence_version_id_ppe_public_evidence_versions_id_fk;
ALTER TABLE public_access_tokens
  DROP CONSTRAINT IF EXISTS public_access_tokens_owner_user_id_users_id_fk;
ALTER TABLE switchboards
  DROP CONSTRAINT IF EXISTS switchboards_qr_owner_user_id_users_id_fk;

ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS ppe_evidence_version_id;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS owner_assignment_source;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS owner_assigned_at;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS owner_user_id;
ALTER TABLE public_access_tokens DROP COLUMN IF EXISTS owner_kind;

ALTER TABLE switchboards DROP COLUMN IF EXISTS qr_owner_assignment_source;
ALTER TABLE switchboards DROP COLUMN IF EXISTS qr_owner_assigned_at;
ALTER TABLE switchboards DROP COLUMN IF EXISTS qr_owner_user_id;
ALTER TABLE switchboards DROP COLUMN IF EXISTS qr_owner_kind;

DROP TABLE IF EXISTS ppe_public_evidence_events;
DROP TABLE IF EXISTS ppe_public_evidence_versions;

ALTER TABLE public_access_tokens
  ADD CONSTRAINT public_access_tokens_artifact_binding_chk CHECK (
    (
      purpose IN ('ppe_signature', 'ppe_confirmation') AND
      artifact_binding_status = 'not_applicable' AND
      job_document_version_id IS NULL AND quote_version_id IS NULL
    ) OR (
      purpose = 'job_signature' AND (
        (artifact_binding_status = 'bound' AND job_document_version_id IS NOT NULL AND quote_version_id IS NULL) OR
        (artifact_binding_status = 'legacy_unbound' AND job_document_version_id IS NULL AND quote_version_id IS NULL)
      )
    ) OR (
      purpose = 'quote_decision' AND (
        (artifact_binding_status = 'bound' AND quote_version_id IS NOT NULL AND job_document_version_id IS NULL) OR
        (artifact_binding_status = 'legacy_unbound' AND quote_version_id IS NULL AND job_document_version_id IS NULL)
      )
    )
  );

ALTER TABLE public_access_tokens
  ADD CONSTRAINT public_access_tokens_consume_action_chk CHECK (
    (consumed_at IS NULL AND consume_action IS NULL) OR
    (consumed_at IS NOT NULL AND consume_action IN ('signed', 'confirmed', 'accepted', 'rejected'))
  );

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785899402886;

COMMIT;
