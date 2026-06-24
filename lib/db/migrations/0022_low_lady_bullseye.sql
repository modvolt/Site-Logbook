CREATE TABLE "document_linking_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"auto_link_enabled" boolean DEFAULT true NOT NULL,
	"auto_confirm_enabled" boolean DEFAULT false NOT NULL,
	"auto_link_min_score" real,
	"auto_confirm_min_score" real,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
