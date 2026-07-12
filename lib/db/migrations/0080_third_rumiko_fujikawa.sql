CREATE TABLE "switchboard_assignees" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"is_responsible" boolean DEFAULT false NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_checklist_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"template_version_id" integer NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_phase" text DEFAULT 'assembly' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"completed_by_user_id" integer,
	"override_reason" text,
	"override_by_user_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_checklist_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"phase_key" text NOT NULL,
	"item_key" text NOT NULL,
	"result" text,
	"value" text,
	"unit" text,
	"passed" boolean,
	"note" text,
	"justification" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"performed_by_user_id" integer,
	"performed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_checklist_template_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_checklist_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"board_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_defects" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"checklist_response_id" integer,
	"title" text NOT NULL,
	"description" text,
	"severity" text DEFAULT 'medium' NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"responsible_person_id" integer,
	"due_date" date,
	"repair_description" text,
	"found_by_user_id" integer,
	"found_at" timestamp DEFAULT now() NOT NULL,
	"closed_by_user_id" integer,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "switchboard_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"version" integer NOT NULL,
	"storage_path" text NOT NULL,
	"original_file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"processing_error_code" text,
	"processing_error_message" text,
	"uploaded_by_user_id" integer,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" integer,
	"actor_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_extracted_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"field_key" text NOT NULL,
	"found_label" text NOT NULL,
	"matched_alias" text,
	"raw_value" text,
	"normalized_value" text,
	"confidence" numeric(4, 3) NOT NULL,
	"page_number" integer NOT NULL,
	"block_id" text,
	"extraction_method" text NOT NULL,
	"relative_relation" text NOT NULL,
	"validation_status" text NOT NULL,
	"validation_message" text,
	"parser_version" text NOT NULL,
	"manually_corrected" boolean DEFAULT false NOT NULL,
	"corrected_value" text,
	"corrected_by_user_id" integer,
	"corrected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_field_registry" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_key" text NOT NULL,
	"canonical_name_cs" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"data_type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"minimum_confidence" numeric(4, 3) DEFAULT '0.850' NOT NULL,
	"normalization_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_relations" text[] DEFAULT '{}' NOT NULL,
	"label_order" integer DEFAULT 0 NOT NULL,
	"protocol_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "switchboard_field_registry_field_key_unique" UNIQUE("field_key")
);
--> statement-breakpoint
CREATE TABLE "switchboard_label_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"version" integer NOT NULL,
	"source_document_id" integer,
	"input_snapshot" jsonb NOT NULL,
	"pdf_storage_path" text,
	"png_storage_path" text,
	"qr_target" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"generator_version" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "switchboard_measurements" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"checklist_response_id" integer,
	"measurement_type" text NOT NULL,
	"subject_label" text,
	"value" numeric(14, 4),
	"value_text" text,
	"unit" text NOT NULL,
	"result" text NOT NULL,
	"instrument" text,
	"note" text,
	"measured_by_user_id" integer,
	"measured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"category" text NOT NULL,
	"related_type" text,
	"related_id" integer,
	"storage_path" text NOT NULL,
	"original_file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"description" text,
	"uploaded_by_user_id" integer,
	"taken_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_processing_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"job_type" text DEFAULT 'extract_dbo_label' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"parser_version" text NOT NULL,
	"locked_at" timestamp,
	"locked_by" text,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_protocol_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"version" integer NOT NULL,
	"protocol_number" text NOT NULL,
	"data_snapshot" jsonb NOT NULL,
	"pdf_storage_path" text NOT NULL,
	"generator_version" text NOT NULL,
	"status" text DEFAULT 'final' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_service_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer NOT NULL,
	"service_type" text NOT NULL,
	"description" text NOT NULL,
	"performed_by_user_id" integer,
	"performed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"internal_name" text NOT NULL,
	"designation" text NOT NULL,
	"installation_location" text,
	"serial_number" text,
	"production_date" date,
	"type_designation" text,
	"manufacturer" text DEFAULT 'Modvolt s.r.o.' NOT NULL,
	"network_system" text,
	"rated_voltage" text,
	"rated_frequency" text,
	"rated_current" text,
	"ip_rating" text,
	"ik_rating" text,
	"dimensions" text,
	"weight" text,
	"standards" text[] DEFAULT '{}' NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"status" text DEFAULT 'created' NOT NULL,
	"processing_status" text DEFAULT 'idle' NOT NULL,
	"assembly_status" text DEFAULT 'not_started' NOT NULL,
	"inspection_status" text DEFAULT 'not_started' NOT NULL,
	"measurement_status" text DEFAULT 'not_started' NOT NULL,
	"qr_token_hash" text,
	"qr_token_prefix" text,
	"qr_enabled" boolean DEFAULT false NOT NULL,
	"qr_expires_at" timestamp,
	"archived_at" timestamp,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "switchboard_assignees" ADD CONSTRAINT "switchboard_assignees_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_assignees" ADD CONSTRAINT "switchboard_assignees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_instances" ADD CONSTRAINT "switchboard_checklist_instances_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_instances" ADD CONSTRAINT "switchboard_checklist_instances_template_version_id_switchboard_checklist_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."switchboard_checklist_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_instances" ADD CONSTRAINT "switchboard_checklist_instances_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_instances" ADD CONSTRAINT "switchboard_checklist_instances_override_by_user_id_users_id_fk" FOREIGN KEY ("override_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_responses" ADD CONSTRAINT "switchboard_checklist_responses_instance_id_switchboard_checklist_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."switchboard_checklist_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_responses" ADD CONSTRAINT "switchboard_checklist_responses_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_template_versions" ADD CONSTRAINT "switchboard_checklist_template_versions_template_id_switchboard_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."switchboard_checklist_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_template_versions" ADD CONSTRAINT "switchboard_checklist_template_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_checklist_templates" ADD CONSTRAINT "switchboard_checklist_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_defects" ADD CONSTRAINT "switchboard_defects_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_defects" ADD CONSTRAINT "switchboard_defects_checklist_response_id_switchboard_checklist_responses_id_fk" FOREIGN KEY ("checklist_response_id") REFERENCES "public"."switchboard_checklist_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_defects" ADD CONSTRAINT "switchboard_defects_responsible_person_id_people_id_fk" FOREIGN KEY ("responsible_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_defects" ADD CONSTRAINT "switchboard_defects_found_by_user_id_users_id_fk" FOREIGN KEY ("found_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_defects" ADD CONSTRAINT "switchboard_defects_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_documents" ADD CONSTRAINT "switchboard_documents_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_documents" ADD CONSTRAINT "switchboard_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_events" ADD CONSTRAINT "switchboard_events_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_events" ADD CONSTRAINT "switchboard_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_extracted_fields" ADD CONSTRAINT "switchboard_extracted_fields_document_id_switchboard_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."switchboard_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_extracted_fields" ADD CONSTRAINT "switchboard_extracted_fields_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_field_registry" ADD CONSTRAINT "switchboard_field_registry_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_label_versions" ADD CONSTRAINT "switchboard_label_versions_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_label_versions" ADD CONSTRAINT "switchboard_label_versions_source_document_id_switchboard_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."switchboard_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_label_versions" ADD CONSTRAINT "switchboard_label_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_label_versions" ADD CONSTRAINT "switchboard_label_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_measurements" ADD CONSTRAINT "switchboard_measurements_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_measurements" ADD CONSTRAINT "switchboard_measurements_checklist_response_id_switchboard_checklist_responses_id_fk" FOREIGN KEY ("checklist_response_id") REFERENCES "public"."switchboard_checklist_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_measurements" ADD CONSTRAINT "switchboard_measurements_measured_by_user_id_users_id_fk" FOREIGN KEY ("measured_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_photos" ADD CONSTRAINT "switchboard_photos_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_photos" ADD CONSTRAINT "switchboard_photos_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_processing_jobs" ADD CONSTRAINT "switchboard_processing_jobs_document_id_switchboard_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."switchboard_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_protocol_versions" ADD CONSTRAINT "switchboard_protocol_versions_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_protocol_versions" ADD CONSTRAINT "switchboard_protocol_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_service_records" ADD CONSTRAINT "switchboard_service_records_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_service_records" ADD CONSTRAINT "switchboard_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboards" ADD CONSTRAINT "switchboards_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboards" ADD CONSTRAINT "switchboards_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_assignees_unique_idx" ON "switchboard_assignees" USING btree ("switchboard_id","person_id");--> statement-breakpoint
CREATE INDEX "switchboard_checklist_instances_board_idx" ON "switchboard_checklist_instances" USING btree ("switchboard_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_checklist_responses_unique_idx" ON "switchboard_checklist_responses" USING btree ("instance_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_checklist_template_versions_unique_idx" ON "switchboard_checklist_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_documents_version_unique_idx" ON "switchboard_documents" USING btree ("switchboard_id","document_type","version");--> statement-breakpoint
CREATE INDEX "switchboard_documents_hash_idx" ON "switchboard_documents" USING btree ("switchboard_id","sha256");--> statement-breakpoint
CREATE INDEX "switchboard_events_board_idx" ON "switchboard_events" USING btree ("switchboard_id","created_at");--> statement-breakpoint
CREATE INDEX "switchboard_extracted_fields_document_idx" ON "switchboard_extracted_fields" USING btree ("document_id","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_label_versions_unique_idx" ON "switchboard_label_versions" USING btree ("switchboard_id","version");--> statement-breakpoint
CREATE INDEX "switchboard_photos_board_idx" ON "switchboard_photos" USING btree ("switchboard_id","category");--> statement-breakpoint
CREATE INDEX "switchboard_processing_jobs_queue_idx" ON "switchboard_processing_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboard_protocol_versions_unique_idx" ON "switchboard_protocol_versions" USING btree ("switchboard_id","version");--> statement-breakpoint
CREATE INDEX "switchboards_job_id_idx" ON "switchboards" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "switchboards_status_idx" ON "switchboards" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboards_serial_number_unique_idx" ON "switchboards" USING btree ("serial_number");--> statement-breakpoint
INSERT INTO "switchboard_field_registry"
  ("field_key", "canonical_name_cs", "aliases", "data_type", "required", "minimum_confidence", "allowed_relations", "label_order", "protocol_order")
VALUES
  ('serialNumber', 'Výrobní číslo', ARRAY['Výrobní č.', 'Výr. číslo'], 'text', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 1, 1),
  ('productionDate', 'Datum výroby', ARRAY['Datum výr.'], 'date', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 2, 2),
  ('typeDesignation', 'Typ', ARRAY['Typ rozvaděče', 'Typové označení'], 'text', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 3, 3),
  ('dimensions', 'Rozměry', ARRAY['Rozměr'], 'dimensions', false, 0.850, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 9, 9),
  ('ratedCurrent', 'InA', ARRAY['InA=', 'IₙA', 'Jmenovitý proud'], 'current', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 7, 7),
  ('ipRating', 'IP', ARRAY['Stupeň krytí', 'Stupeň krytí IP'], 'ip_rating', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 10, 10),
  ('ikRating', 'IK', ARRAY['Mechanická odolnost', 'Mechanická odolnost IK'], 'ik_rating', false, 0.850, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 11, 11),
  ('networkSystem', 'Soustava', ARRAY['Síť', 'Síťová soustava'], 'network_system', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 4, 4),
  ('ratedVoltage', 'Napětí', ARRAY['Un', 'Jmenovité napětí'], 'voltage', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 5, 5),
  ('ratedFrequency', 'Frekvence', ARRAY['Jmenovitá frekvence'], 'frequency', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 6, 6),
  ('weight', 'Hmotnost', ARRAY['Váha'], 'weight', false, 0.850, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 12, 12),
  ('standard', 'Norma', ARRAY['Normy', 'Použité normy'], 'standards', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order', 'until_next_label'], 8, 8),
  ('boardDesignation', 'Označení rozvaděče', ARRAY['Název rozvaděče', 'Označení'], 'text', true, 0.900, ARRAY['same_line', 'below', 'adjacent_cell', 'reading_order'], 0, 0)
ON CONFLICT ("field_key") DO NOTHING;
