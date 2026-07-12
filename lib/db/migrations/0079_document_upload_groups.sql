ALTER TABLE billing_documents
  ADD COLUMN IF NOT EXISTS upload_group_token text,
  ADD COLUMN IF NOT EXISTS upload_completed_at timestamp;

ALTER TABLE billing_document_files
  ADD COLUMN IF NOT EXISTS page_index integer;

CREATE UNIQUE INDEX IF NOT EXISTS billing_documents_upload_group_token_unique_idx
  ON billing_documents (upload_group_token)
  WHERE upload_group_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS billing_document_files_document_page_unique_idx
  ON billing_document_files (document_id, page_index)
  WHERE page_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_documents_upload_incomplete_idx
  ON billing_documents (created_at)
  WHERE upload_group_token IS NOT NULL AND upload_completed_at IS NULL;
