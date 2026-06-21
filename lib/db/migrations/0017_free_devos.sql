CREATE TABLE "warehouse_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_item_id" integer NOT NULL,
	"direction" text NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"unit_price" numeric(12, 2),
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" integer,
	"billing_document_id" integer,
	"job_id" integer,
	"note" text,
	"created_by_user_id" integer,
	"created_by_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_warehouse_item_id_warehouse_items_id_fk" FOREIGN KEY ("warehouse_item_id") REFERENCES "public"."warehouse_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouse_movements_item_id_idx" ON "warehouse_movements" USING btree ("warehouse_item_id");--> statement-breakpoint
CREATE INDEX "warehouse_movements_source_idx" ON "warehouse_movements" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "warehouse_movements_billing_document_id_idx" ON "warehouse_movements" USING btree ("billing_document_id");--> statement-breakpoint
CREATE INDEX "warehouse_movements_job_id_idx" ON "warehouse_movements" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "warehouse_movements_created_at_idx" ON "warehouse_movements" USING btree ("created_at");