-- Manual full rollback for migration 0091_document_page_merges.
--
-- Prefer rolling back API + frontend and leaving the additive schema in place.
-- This destructive rollback is allowed only while the feature is completely
-- unused. It never deletes document files or attempts to rewrite history.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_document_merges) THEN
    RAISE EXCEPTION
      'Rollback 0091 blocked: document merge history exists. Revert active merges in the application and keep the additive audit tables.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM attachments
    WHERE billing_document_id IS NOT NULL OR page_index IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0091 blocked: job attachments already use logical document/page links.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM billing_documents
    WHERE doc_type = 'unknown'
       OR status = 'merged'
       OR declared_doc_type IS NOT NULL
       OR detected_doc_type IS NOT NULL
       OR detected_doc_type_confidence IS NOT NULL
       OR doc_type_source <> 'unknown'
       OR doc_type_confirmed_by_user_id IS NOT NULL
       OR doc_type_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0091 blocked: document type provenance or merged state is already in use.';
  END IF;
END $$;

DROP TABLE billing_document_merge_members;
DROP TABLE billing_document_merges;

ALTER TABLE attachments
  DROP COLUMN billing_document_id,
  DROP COLUMN page_index;

ALTER TABLE billing_documents
  DROP COLUMN declared_doc_type,
  DROP COLUMN detected_doc_type,
  DROP COLUMN detected_doc_type_confidence,
  DROP COLUMN doc_type_source,
  DROP COLUMN doc_type_confirmed_by_user_id,
  DROP COLUMN doc_type_confirmed_at;

ALTER TABLE billing_documents ALTER COLUMN doc_type SET DEFAULT 'invoice';

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1784233777267;

COMMIT;
