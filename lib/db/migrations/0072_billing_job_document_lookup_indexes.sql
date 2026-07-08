CREATE INDEX IF NOT EXISTS "attachments_job_id_idx" ON "attachments" USING btree ("job_id");
CREATE INDEX IF NOT EXISTS "attachments_file_name_idx" ON "attachments" USING btree ("file_name");
CREATE INDEX IF NOT EXISTS "billing_documents_file_name_idx" ON "billing_documents" USING btree ("file_name");
CREATE INDEX IF NOT EXISTS "materials_job_id_idx" ON "materials" USING btree ("job_id");
CREATE INDEX IF NOT EXISTS "materials_source_id_idx" ON "materials" USING btree ("source_id");
