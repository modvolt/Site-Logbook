DROP INDEX "ppe_handover_documents_assignment_version_uniq";
--> statement-breakpoint
ALTER TABLE "ppe_handover_documents" ADD CONSTRAINT "ppe_handover_documents_assignment_id_uniq" UNIQUE ("assignment_id");
