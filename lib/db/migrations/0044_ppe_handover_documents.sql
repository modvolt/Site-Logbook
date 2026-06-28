ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_category_snapshot" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_standard_snapshot" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_protection_class_snapshot" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_risk_description_snapshot" text;
--> statement-breakpoint
CREATE TABLE "ppe_handover_documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "assignment_id" integer NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "document_number" text NOT NULL,
  "signatory_name" text NOT NULL,
  "signed_at" timestamp NOT NULL,
  "confirmation_text" text NOT NULL,
  "png_object_path" text NOT NULL,
  "png_sha256" text NOT NULL,
  "pdf_object_path" text NOT NULL,
  "pdf_sha256" text NOT NULL,
  "issuer_snapshot" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ppe_handover_documents_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "ppe_handover_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "assignment_id" integer NOT NULL,
  "handover_document_id" integer,
  "event_type" text NOT NULL,
  "actor_user_id" integer,
  "actor_name" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ppe_handover_events_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "ppe_handover_events_handover_document_id_fk" FOREIGN KEY ("handover_document_id") REFERENCES "public"."ppe_handover_documents"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "ppe_handover_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ppe_handover_documents_assignment_version_uniq" ON "ppe_handover_documents" ("assignment_id","version");
--> statement-breakpoint
CREATE INDEX "ppe_handover_documents_assignment_id_idx" ON "ppe_handover_documents" ("assignment_id");
--> statement-breakpoint
CREATE INDEX "ppe_handover_events_assignment_id_idx" ON "ppe_handover_events" ("assignment_id");
