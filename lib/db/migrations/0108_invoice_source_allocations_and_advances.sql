CREATE TABLE "invoice_source_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer,
	"invoice_id_snapshot" integer NOT NULL,
	"invoice_line_id" integer,
	"source_type" text NOT NULL,
	"source_id" integer NOT NULL,
	"job_id" integer,
	"activity_id" integer,
	"source_description" text NOT NULL,
	"source_unit" text,
	"original_quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"allocated_quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"source_amount_without_vat" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"settlement_method" text DEFAULT 'direct' NOT NULL,
	"legacy_incomplete" boolean DEFAULT false NOT NULL,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp,
	"released_at" timestamp,
	"reversed_at" timestamp,
	CONSTRAINT "invoice_source_allocations_status_check" CHECK ("invoice_source_allocations"."status" IN ('reserved', 'billed', 'included_in_lump_sum', 'not_charged', 'deferred', 'released', 'reversed')),
	CONSTRAINT "invoice_source_allocations_method_check" CHECK ("invoice_source_allocations"."settlement_method" IN ('direct', 'included_in_lump_sum', 'not_charged', 'deferred')),
	CONSTRAINT "invoice_source_allocations_quantity_check" CHECK ("invoice_source_allocations"."original_quantity" >= 0 AND "invoice_source_allocations"."allocated_quantity" >= 0 AND "invoice_source_allocations"."allocated_quantity" <= "invoice_source_allocations"."original_quantity")
);
--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "advance_number_prefix" text DEFAULT 'ZAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "advance_number_format" text DEFAULT '{PREFIX}{YYYY}{SEQ4}' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "advance_number_year" integer;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "advance_number_next_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "row_type" text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "document_type" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_delivery_address" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "iban" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bic" text;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill only source identities that already exist explicitly. The migration
-- never invents a relation between an aggregated line and raw operational data.
-- Ambiguous sources linked to more than one live historical invoice are kept as
-- released/incomplete evidence and therefore do not block a future, reviewed
-- allocation.
WITH line_sources AS (
	SELECT
		il.invoice_id,
		MIN(il.id) AS invoice_line_id,
		il.source_type,
		il.source_id,
		MAX(il.job_id) AS job_id,
		MAX(il.activity_id) AS activity_id,
		MIN(il.description) AS source_description,
		MIN(il.unit) AS source_unit,
		SUM(il.quantity) AS original_quantity,
		SUM(il.total_without_vat) AS source_amount_without_vat
	FROM invoice_lines il
	WHERE il.source_id IS NOT NULL
	  AND il.source_type <> 'manual'
	GROUP BY il.invoice_id, il.source_type, il.source_id
), classified AS (
	SELECT
		ls.*,
		i.status AS invoice_status,
		COUNT(*) FILTER (WHERE i.status <> 'cancelled') OVER (
			PARTITION BY ls.source_type, ls.source_id
		) AS live_uses
	FROM line_sources ls
	JOIN invoices i ON i.id = ls.invoice_id
)
INSERT INTO invoice_source_allocations (
	invoice_id,
	invoice_id_snapshot,
	invoice_line_id,
	source_type,
	source_id,
	job_id,
	activity_id,
	source_description,
	source_unit,
	original_quantity,
	allocated_quantity,
	source_amount_without_vat,
	status,
	settlement_method,
	legacy_incomplete
)
SELECT
	invoice_id,
	invoice_id,
	invoice_line_id,
	source_type,
	source_id,
	job_id,
	activity_id,
	source_description,
	source_unit,
	GREATEST(original_quantity, 0),
	GREATEST(original_quantity, 0),
	source_amount_without_vat,
	CASE
		WHEN live_uses > 1 THEN 'released'
		WHEN invoice_status = 'draft' THEN 'reserved'
		WHEN invoice_status = 'cancelled' THEN 'reversed'
		ELSE 'billed'
	END,
	'direct',
	true
FROM classified;--> statement-breakpoint
-- Work-session links carry a reliable 1:1 raw identity even though their
-- commercial invoice line is aggregated and has source_id = NULL.
INSERT INTO invoice_source_allocations (
	invoice_id,
	invoice_id_snapshot,
	source_type,
	source_id,
	job_id,
	activity_id,
	source_description,
	source_unit,
	original_quantity,
	allocated_quantity,
	source_amount_without_vat,
	status,
	settlement_method,
	legacy_incomplete,
	created_by_user_id,
	created_at,
	settled_at,
	released_at
)
SELECT
	wbl.invoice_id,
	wbl.invoice_id_snapshot,
	'work_session',
	wbl.session_id,
	ws.job_id,
	ws.activity_id,
	'Odpracovaný čas (historická vazba)',
	'h',
	ABS(wbl.duration_seconds_snapshot)::numeric / 3600,
	ABS(wbl.duration_seconds_snapshot)::numeric / 3600,
	wbl.amount_without_vat_snapshot,
	CASE wbl.status
		WHEN 'reserved' THEN 'reserved'
		WHEN 'billed' THEN 'billed'
		ELSE 'released'
	END,
	'direct',
	false,
	wbl.created_by_user_id,
	wbl.created_at,
	wbl.billed_at,
	wbl.released_at
FROM work_session_billing_links wbl
JOIN work_sessions ws ON ws.id = wbl.session_id
WHERE NOT EXISTS (
	SELECT 1
	FROM invoice_source_allocations isa
	WHERE isa.source_type = 'work_session'
	  AND isa.source_id = wbl.session_id
);--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_source_allocations_active_source_uq" ON "invoice_source_allocations" USING btree ("source_type","source_id") WHERE "invoice_source_allocations"."status" IN ('reserved', 'billed', 'included_in_lump_sum', 'not_charged');--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_invoice_idx" ON "invoice_source_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_invoice_snapshot_idx" ON "invoice_source_allocations" USING btree ("invoice_id_snapshot");--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_job_idx" ON "invoice_source_allocations" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_activity_idx" ON "invoice_source_allocations" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_line_idx" ON "invoice_source_allocations" USING btree ("invoice_line_id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_row_type_check" CHECK ("invoice_lines"."row_type" IN ('item', 'section'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_type_check" CHECK ("invoices"."document_type" IN ('standard', 'advance'));
