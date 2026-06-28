DROP INDEX "ppe_assignments_signature_token_idx";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "contract_price" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "materials" ALTER COLUMN "purchase_price_per_unit" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "ppe_handover_events" ADD CONSTRAINT "ppe_handover_events_handover_document_id_ppe_handover_documents_id_fk" FOREIGN KEY ("handover_document_id") REFERENCES "public"."ppe_handover_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD CONSTRAINT "ppe_assignments_signature_token_unique" UNIQUE("signature_token");
