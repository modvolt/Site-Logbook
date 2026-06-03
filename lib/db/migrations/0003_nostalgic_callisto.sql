CREATE TABLE "customer_site_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"type" text DEFAULT 'ostatni' NOT NULL,
	"file_name" text,
	"url" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD CONSTRAINT "customer_site_attachments_site_id_customer_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."customer_sites"("id") ON DELETE cascade ON UPDATE no action;