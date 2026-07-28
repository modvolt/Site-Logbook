ALTER TABLE "billing_documents" ADD COLUMN "delivery_note_resolution" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "delivery_note_resolution_reason" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "delivery_note_resolution_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "delivery_note_resolution_at" timestamp;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_delivery_note_resolution_by_user_id_users_id_fk" FOREIGN KEY ("delivery_note_resolution_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_documents_delivery_note_resolution_idx" ON "billing_documents" USING btree ("delivery_note_resolution");--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_delivery_note_resolution_check" CHECK ("billing_documents"."delivery_note_resolution" in ('unknown', 'required', 'not_required', 'waived'));--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_delivery_note_resolution_reason_check" CHECK ((
        ("billing_documents"."delivery_note_resolution" in ('unknown', 'required') and "billing_documents"."delivery_note_resolution_reason" is null)
        or
        ("billing_documents"."delivery_note_resolution" in ('not_required', 'waived') and length(btrim("billing_documents"."delivery_note_resolution_reason")) >= 3)
      ));